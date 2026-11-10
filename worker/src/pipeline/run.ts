import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { getJob, recordUsedVideo, setVideoOutcome, updateJob } from '../db.ts';
import { fetchTopComments, fetchTrending } from '../youtube.ts';
import { log } from '../lib/log.ts';
import { mapPool } from '../lib/pool.ts';
import {
  CandidateRejected,
  STEP_ORDER,
  type DraftText,
  type JobCandidate,
  type ScoredCandidate,
  type SelectedSegment,
  type SkippedCandidate,
  type SourceVideo,
  type Step,
  type Transcript,
} from '../types.ts';
import { CanceledError, createContext, type Broadcaster, type StepContext } from './context.ts';
import { ffprobe } from './ffmpeg.ts';
import { shiftTranscript } from './ytTranscript.ts';
import { search } from './steps/search.ts';
import { faceCamBias, score } from './steps/score.ts';
import { thumbcheck } from './steps/thumbcheck.ts';
import { download, downloadClip, type DownloadResult } from './steps/download.ts';
import { transcribe, type TranscribeResult } from './steps/transcribe.ts';
import { contentFilter, contentFilterTranscript } from './steps/filter.ts';
import { selectSegment } from './steps/select.ts';
import { halalCheck } from './steps/halalCheck.ts';
import { draftText } from './steps/draftText.ts';
import { reframe } from './steps/reframe.ts';
import { buildCaptions, preciseTranscribeSegments } from './steps/captions.ts';
import { sfxAudio } from './steps/sfxAudio.ts';
import { render, concatClips, type RenderResult } from './steps/render.ts';
import {
  fetchGameplay,
  renderQuestionPost,
  renderStoryPost,
  writeQuestionPost,
  writeStoryPost,
} from './steps/post.ts';
import { writeAndApproveStory } from './steps/story.ts';
import { buildStoryAudio, composeStoryVideo, mapSfxCues, transcribeNarration } from './steps/storyteller.ts';
import { runColorRace } from './steps/colorrace.ts';
import { runMarbleRace } from './steps/marblerace.ts';
import { runEscapeRace } from './steps/escaperace.ts';
import { runLaserNations } from './steps/lasernations.ts';
import { runLaserDuel } from './steps/lasernationsDuel.ts';
import { runColorWar } from './steps/colorwar.ts';
import { runFollowBall } from './steps/followball.ts';
import { runEyeTest } from './steps/eyetest.ts';
import { runQuotes } from './steps/quotes.ts';
import { narrate } from '../tts.ts';
import { pickFootageSlice, populateFootage } from '../footage.ts';

export interface RunOptions {
  jobId: string;
  signal: AbortSignal;
  broadcast?: Broadcaster;
  pinnedUrl?: string;
}

export interface RunOutcome {
  jobId: string;
  candidates: JobCandidate[];
}

const CLIP_CONCURRENCY = 2;
const MAX_CANDIDATE_ATTEMPTS = 16; // the strict guideline rejects a lot — give the loop room
const TOP5_COUNT = 5;
const TOP5_SEG_SEC = 13; // each countdown moment
const LOOP_STEPS: Step[] = ['thumbcheck', 'download', 'transcribe', 'select', 'filter'];

/** Trim a picked segment to at most `maxSec`, keeping its opening (where the hook lands). */
function clampSegment(seg: SelectedSegment, maxSec: number): SelectedSegment {
  const dur = seg.end - seg.start;
  if (dur <= maxSec + 0.5) return seg;
  return { ...seg, end: seg.start + maxSec };
}

function videoIdFromUrl(url: string): string {
  return (
    /[?&]v=([\w-]{6,})/.exec(url)?.[1] ??
    /youtu\.be\/([\w-]{6,})/.exec(url)?.[1] ??
    /\/shorts\/([\w-]{6,})/.exec(url)?.[1] ??
    twitchClipSlug(url) ??
    url
  );
}

/** A Twitch clip URL → its slug, or null if this isn't one. */
function twitchClipSlug(url: string): string | null {
  return (
    /clips\.twitch\.tv\/([\w-]+)/i.exec(url)?.[1] ??
    /twitch\.tv\/\S+?\/clip\/([\w-]+)/i.exec(url)?.[1] ??
    /twitch\.tv\/clip\/([\w-]+)/i.exec(url)?.[1] ??
    null
  );
}

/** The stage currently executing — the queue is single-flight, so a module-level
 *  cursor is safe and lets the top-level catch attribute an unexpected failure. */
let currentStage: Step = 'search';

async function stage<T>(ctx: StepContext, step: Step, fn: () => Promise<T> | T): Promise<T> {
  ctx.throwIfCanceled();
  currentStage = step;
  ctx.setStep(step, 'running');
  const t0 = Date.now();
  try {
    const result = await fn();
    ctx.setStep(step, 'done');
    ctx.log(step, `✓ ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return result;
  } catch (err) {
    if (err instanceof CanceledError || ctx.signal.aborted) {
      ctx.setStep(step, 'failed', { error: 'canceled' });
      throw new CanceledError();
    }
    if (err instanceof CandidateRejected) throw err; // the loop handles it; not a step failure
    const message = err instanceof Error ? err.message : String(err);
    ctx.setStep(step, 'failed', { error: message });
    throw err;
  }
}

/** Wipe one candidate attempt's files so the next attempt starts from a clean work dir. */
function clearCandidateFiles(workDir: string): void {
  for (const name of readdirSync(workDir)) {
    if (
      /^(source\.|audio16k\.wav|transcript\.json|cuts\.json|filter\.json|screen-verdict\.json|music-(sample|verdict)\.|thumb-check-|thumb-verdict-)/.test(name) ||
      name === 'flagged-frames'
    ) {
      rmSync(resolve(workDir, name), { recursive: true, force: true });
    }
  }
}

interface Winner {
  source: SourceVideo;
  dl: DownloadResult;
  transcript: TranscribeResult;
  picks: SelectedSegment[];
  draft: DraftText;
  stripMusic: boolean;
  /** Fraction of the chosen clip's frames showing a face (0..1) — the face-cam signal. */
  faceFrac: number;
}

interface VetContext {
  batchTitles: string[];
  batchComments: string[];
  pinned: boolean;
  /** true for Top-5 — only the single best moment from this video is needed. */
  singlePick?: boolean;
}

/**
 * Take one candidate video all the way from thumbnail to a vetted, segment-picked,
 * hook-written winner — or throw {@link CandidateRejected} so the run tries the next.
 * Everything the content guideline touches happens in here.
 */
async function vetCandidate(ctx: StepContext, video: SourceVideo, vc: VetContext): Promise<Winner> {
  const isTwitch = video.provider === 'twitch';
  const thumbFace = await stage(ctx, 'thumbcheck', () => thumbcheck(ctx, video as ScoredCandidate));

  const dl = await stage(ctx, 'download', () => download(ctx, video));
  recordUsedVideo(dl.source, 'processing');
  updateJob(ctx.jobId, { source: dl.source });

  const transcript = await stage(ctx, 'transcribe', () => transcribe(ctx, dl));
  updateJob(ctx.jobId, { transcriptVia: transcript.via });

  // English only — reject anything Whisper detects as another language
  if (transcript.language && !transcript.language.toLowerCase().startsWith('en')) {
    throw new CandidateRejected(`spoken language is ${transcript.language}, not English`);
  }

  // cheap transcript screen first (keyword + LLM topic scan) — no video needed
  await contentFilterTranscript(ctx, transcript);

  let working = { dl, transcript };

  // ---- pick the segment(s) ----
  // A Twitch clip is already trimmed to the right length by whoever clipped it, so
  // there's nothing to select — use the whole thing. For a YouTube source we screen
  // only the ~60s we actually cut, so select first and screen that window.
  const onePick = vc.singlePick || working.dl.deferred;
  let picks: SelectedSegment[];
  if (isTwitch) {
    const clipEnd = working.dl.source.durationSec || working.transcript.durationSec || 60;
    picks = [
      { start: 0, end: clipEnd, hookTitle: '', reason: 'Twitch clip — already the right length', score: 1, method: 'source-clip' },
    ];
    ctx.setStep('select', 'running', { detail: `whole Twitch clip · ${Math.round(clipEnd)}s` });
  } else {
    picks = await stage(ctx, 'select', async () => {
      const selected = await selectSegment(ctx, {
        transcript: working.transcript,
        dl: working.dl,
        want: onePick ? 1 : undefined,
      });
      return onePick ? selected.picks.slice(0, 1) : selected.picks;
    });
  }

  // ---- media screen, scoped to the chosen clip (music + any woman / forbidden scene) ----
  const f = await stage(ctx, 'filter', async () => {
    // deferred VOD → grab just the chosen window now and rebase times onto it
    if (working.dl.deferred) {
      ctx.setStep('filter', 'running', { detail: 'fetching the clip' });
      const dlSpan = { startSec: Math.min(...picks.map((p) => p.start)), endSec: Math.max(...picks.map((p) => p.end)) };
      const { videoPath, offsetSec } = await downloadClip(ctx, working.dl.source, dlSpan);
      const spanSec = dlSpan.endSec - dlSpan.startSec + 40;
      working = {
        dl: { ...working.dl, videoPath, deferred: false, windowOffsetSec: offsetSec },
        transcript: { ...shiftTranscript(working.transcript, offsetSec, spanSec), via: working.transcript.via, audioPath: null },
      };
      picks = picks.map((p) => ({ ...p, start: Math.max(0, p.start - offsetSec), end: Math.max(0.1, p.end - offsetSec) }));
    }
    // one window per candidate clip — they can be minutes apart in the source
    const windows = picks.map((p) => ({ start: Math.max(0, p.start - 3), end: p.end + 3 }));
    return contentFilter(ctx, { dl: working.dl, transcript: working.transcript, skipTranscript: true, windows });
  });
  const stripMusic = f.stripMusic;
  // face-cam signal — the frame screen is authoritative; fall back to the thumbnail hint
  const faceFrac = f.faceFrac > 0 ? f.faceFrac : thumbFace;
  ctx.writeArtifact('filter.json', { stripMusic, faceFrac });
  updateJob(ctx.jobId, { source: { ...working.dl.source, faceFrac } });

  // ---- strict guideline judgement on the exact chosen clip ----
  const top = picks[0]!;
  const segText = working.transcript.segments
    .filter((s) => s.end > top.start && s.start < top.end)
    .map((s) => s.text)
    .join(' ');
  await stage(ctx, 'select', () => halalCheck(ctx, { segmentText: segText, screenVerdictPath: ctx.file('screen-verdict.json') }));

  // ---- write the hook + caption + hashtags (no approval — fully automatic) ----
  const draft = await stage(ctx, 'select', async () => {
    ctx.progress('select', 0.9, 'writing the hook + caption');
    const src = working.dl.source;
    const d = await draftText(ctx, {
      transcript: working.transcript,
      segment: [top.start, top.end],
      batchTitles: vc.batchTitles,
      batchComments: vc.batchComments,
      sourceTitle: src.title,
      sourceChannel: src.channel,
      provider: src.provider,
      creatorHandle: src.creatorHandle,
      creatorUrl: src.creatorUrl,
    });
    updateJob(ctx.jobId, { draftText: d });
    ctx.setStep('select', 'running', { detail: `${picks.length} clip(s) · "${d.hook}"` });
    return d;
  });

  return {
    source: { ...working.dl.source, faceFrac },
    dl: working.dl,
    transcript: working.transcript,
    picks,
    draft,
    stripMusic,
    faceFrac,
  };
}

/** Mark every step not used by a post format as skipped so the checklist reads cleanly. */
function skipStepsExcept(ctx: StepContext, used: Step[]): void {
  for (const s of STEP_ORDER) {
    if (!used.includes(s)) ctx.setStep(s, 'skipped', { detail: 'not needed for this format' });
  }
}

/** Emit the finished single-candidate result shared by both post formats. */
function finishPost(
  ctx: StepContext,
  jobId: string,
  render: RenderResult,
  opts: { hookTitle: string; reason: string; draft: DraftText },
): RunOutcome {
  const candidates: JobCandidate[] = [
    {
      index: 0,
      segment: [0, render.durationSec],
      hookTitle: opts.hookTitle,
      reason: opts.reason,
      score: 1,
      durationSec: render.durationSec,
      previewUrl: `/jobs/${jobId}/preview/0`,
      thumbUrl: `/jobs/${jobId}/thumb/0`,
      method: 'llm',
      reframeMode: 'crop',
    },
  ];
  updateJob(jobId, {
    status: 'awaiting_review',
    finishedAt: new Date().toISOString(),
    candidates,
    chosenIndex: 0,
    chosenReframeMode: 'crop',
    draftText: opts.draft,
  });
  ctx.emit({ type: 'job:status', status: 'awaiting_review' });
  ctx.emit({ type: 'job:candidates', candidates, source: null, transcriptVia: null, draftText: opts.draft });
  log.ok(`job ${jobId} ready — ${opts.hookTitle}`);
  return { jobId, candidates };
}

/**
 * Storyteller — an original AI story, narrated with Kokoro TTS over background footage.
 * "New take" copies the approved story + narration + audio bed forward, so on a re-take
 * the narration/alignment/audio steps are skipped and only the background footage changes.
 */
async function runStoryteller(ctx: StepContext, jobId: string): Promise<RunOutcome> {
  skipStepsExcept(ctx, ['search', 'select', 'download', 'transcribe', 'captions', 'sfx', 'render']);
  const reused = existsSync(ctx.file('narration.wav')) && existsSync(ctx.file('narration-transcript.json'));

  // 1. write + screen + approve the script (pauses for review, unless already approved)
  const story = await stage(ctx, 'select', () =>
    writeAndApproveStory(ctx, {
      genre: ctx.settings.storyGenre || 'grounded mystery',
      lengthSec: ctx.settings.storyLengthSec,
    }),
  );
  updateJob(jobId, { draftText: { hook: story.title, overlays: [story.openingLine] } });

  // 2. narrate (skipped on a new take — the narration is copied forward)
  const narrationRaw = ctx.file('narration.wav');
  let narrDur = 0;
  if (reused && existsSync(narrationRaw)) {
    narrDur = (await ffprobe(narrationRaw)).durationSec;
    ctx.setStep('download', 'done', { detail: `reusing the ${narrDur.toFixed(0)}s narration` });
  } else {
    const narr = await stage(ctx, 'download', () =>
      narrate(ctx, {
        text: story.script,
        voice: ctx.settings.ttsVoice || 'am_michael',
        outPath: narrationRaw,
        speed: 0.9, // slower, deliberate — reads as a storytime / horror narration
        onProgress: (p, m) => ctx.progress('download', p, m),
      }),
    );
    narrDur = narr.durationSec;
    ctx.setStep('download', 'done', { detail: `${narr.durationSec}s narration · ${narr.voice}` });
  }

  // 3. align (skipped on a new take)
  let transcript: Transcript;
  if (reused) {
    transcript = JSON.parse(readFileSync(ctx.file('narration-transcript.json'), 'utf8')) as Transcript;
    ctx.setStep('transcribe', 'done', { detail: 'reusing the alignment' });
  } else {
    transcript = await stage(ctx, 'transcribe', () => transcribeNarration(ctx, narrationRaw));
  }
  const durationSec = Math.max(narrDur, transcript.segments.at(-1)?.end ?? narrDur) + 0.6;

  // 4. captions
  const captions = await stage(ctx, 'captions', () => {
    if (existsSync(ctx.file('captions.0.ass'))) {
      ctx.setStep('captions', 'done', { detail: 'reusing captions' });
      return { assPath: ctx.file('captions.0.ass'), wordCount: 0 };
    }
    const res = buildCaptions(ctx, {
      transcript,
      segment: { start: 0, end: durationSec, hookTitle: story.title, reason: '', score: 1, method: 'source-clip' },
      slot: 0,
    });
    ctx.setStep('captions', 'done', { detail: `${res.wordCount} words · ${ctx.settings.captionStyle}` });
    return res;
  });

  // 5. background footage — top the library up if it's low, then pick a FRESH slice
  const slice = await stage(ctx, 'search', async () => {
    const { added, have } = await populateFootage(ctx, { queries: ctx.settings.backgroundFootageQueries });
    if (added) ctx.log('search', `added ${added} clip(s) to the footage library (${have} total)`);
    const s = pickFootageSlice(durationSec);
    ctx.setStep('search', 'done', { detail: `${s.clip.sourceChannel ?? 'gameplay'} · ${Math.round(s.startSec)}s in` });
    return s;
  });

  // 6. audio bed (skipped on a new take)
  const audioPath = await stage(ctx, 'sfx', async () => {
    const cached = ctx.file('story_audio.wav');
    if (existsSync(cached)) {
      ctx.setStep('sfx', 'done', { detail: 'reusing the mix' });
      return cached;
    }
    const cueTimes = mapSfxCues(transcript, story.sfxCues);
    const p = await buildStoryAudio(ctx, { narration: narrationRaw, cueTimes, durationSec });
    ctx.setStep('sfx', 'done', {
      detail: `−16 LUFS${cueTimes.length ? ` · ${cueTimes.length} sfx` : ''}${ctx.settings.storyMusic ? ' · music bed' : ''}`,
    });
    return p;
  });

  // 6. compose
  const rendered = await stage(ctx, 'render', () =>
    composeStoryVideo(ctx, {
      jobId,
      footagePath: slice.clip.path,
      footageStartSec: slice.startSec,
      audioPath,
      assPath: captions.assPath,
      durationSec,
    }),
  );

  const draft: DraftText = {
    hook: story.title,
    overlays: [story.openingLine],
    caption: `${story.title}\n\n${story.openingLine}`,
    hashtags: ['storytime', 'story', 'scarystories', 'fyp', 'viral'],
  };
  return finishPost(ctx, jobId, rendered, {
    hookTitle: story.title,
    reason: `Storyteller · ${ctx.settings.storyGenre}`,
    draft,
  });
}

/** 'colorrace' — a procedurally-generated "which colour will win?" Marble Rush race. No source, no LLM. */
async function runColorRacePost(ctx: StepContext, jobId: string): Promise<RunOutcome> {
  skipStepsExcept(ctx, ['render']);
  const { render, race } = await stage(ctx, 'render', () => runColorRace(ctx));
  const [c1, c2] = race.colors;
  const draft: DraftText = {
    hook: 'Which colour wins? 👀 Watch till the end',
    overlays: [race.colors.join('  vs  ')],
    caption:
      `Which marble wins? 👀 Watch till the end.\n\n` +
      `${c1} vs ${c2} — Marble Rush down the ${race.mapName} course. Boost pads, mud traps, ` +
      `spinning blades. First to the finish takes it.\n\n` +
      `Comment your colour before it ends 👇`,
    hashtags: ['marblerace', 'marblerun', 'satisfying', 'watchtillend', 'fyp'],
  };
  return finishPost(ctx, jobId, render, {
    hookTitle: `${race.winner} wins`,
    reason: `${race.mapName} · ${race.colors.join(' vs ')} → ${race.winner} · seed ${race.seed}`,
    draft,
  });
}

/** 'colorwar' — a grid "last colour alive" territory fight. No source, no LLM. */
async function runColorWarPost(ctx: StepContext, jobId: string): Promise<RunOutcome> {
  skipStepsExcept(ctx, ['render']);
  const { render, race } = await stage(ctx, 'render', () => runColorWar(ctx));
  const [c1, c2] = race.colors;
  const season = ctx.settings.colorWarSeasonNumber;
  const episode = ctx.settings.colorWarEpisodeIndex;
  const totalEpisodes = ctx.settings.colorWarTotalEpisodes;

  const draft: DraftText = season && episode
    ? {
        hook: `Season ${season} · Episode ${episode} of ${totalEpisodes} 👀`,
        overlays: [`SEASON ${season} · EPISODE ${episode} OF ${totalEpisodes}`],
        caption:
          `Season ${season} · Episode ${episode} of ${totalEpisodes} 🏆\n\n` +
          `${c1} vs ${c2} — 4 colours fight for the grid.` +
          (race.isComeback ? ` ${race.winner} was almost finished before storming all the way back to win.` : ` ${race.winner} takes it in a nail-biter.`) +
          ` \n\nNext episode tomorrow — comment your pick for Ep. ${episode + 1} 👇`,
        hashtags: ['colorwar', 'colorwarseason', 'satisfying', 'simulation', 'fyp'],
      }
    : {
        hook: 'Which colour wins the war? 👀',
        overlays: [race.colors.join('  vs  ')],
        caption:
          `Which colour wins? 👀 WATCH TILL THE END — the last 1v1 is insane.\n\n` +
          `${c1} vs ${c2} — 4 colours fight for the grid. Every hit paints a stripe, ` +
          `paint bombs blow holes in the map, and whoever gets squeezed out is gone. ` +
          `Down to two, each one gets wiped to almost nothing and storms back — over and over.\n\n` +
          `Comment your colour before it ends 👇`,
        hashtags: ['colorwar', 'satisfying', 'simulation', 'watchtillend', 'fyp'],
      };
  return finishPost(ctx, jobId, render, {
    hookTitle: season && episode ? `S${season}E${episode} · ${race.winner} wins` : `${race.winner} wins`,
    reason: season && episode
      ? `Season ${season} · Episode ${episode}/${totalEpisodes} · ${race.modeName} · ${race.colors.join(' vs ')} → ${race.winner} (${race.winnerPct}%)${race.isComeback ? ' · COMEBACK' : ''} · seed ${race.seed}`
      : `${race.modeName} · ${race.colors.join(' vs ')} → ${race.winner} (${race.winnerPct}%) · seed ${race.seed}`,
    draft,
  });
}

/** 'followball' — a shell-game "call the cup" ability test. No source, no LLM. */
async function runFollowBallPost(ctx: StepContext, jobId: string): Promise<RunOutcome> {
  skipStepsExcept(ctx, ['render']);
  const { render, game } = await stage(ctx, 'render', () => runFollowBall(ctx));
  const modeLine =
    game.mode === 'sprint'
      ? `${game.rounds} rounds, the cups shuffle faster each one`
      : `${game.rounds} rounds of pure focus — ${game.mode === 'insane' ? 'brutal' : 'it ramps hard'}`;
  const draft: DraftText = {
    hook: 'Follow the ball 👀 how many can you get?',
    overlays: [`${game.rounds} rounds`],
    caption:
      `Follow the ball 👀 how many can you get?\n\n` +
      `${modeLine}. Call the cup out loud before it reveals — then check the score card at the end.\n\n` +
      `Comment your score 👇`,
    hashtags: ['followtheball', 'shellgame', 'focustest', 'watchtillend', 'fyp'],
  };
  return finishPost(ctx, jobId, render, {
    hookTitle: `answers ${game.answers.join('-')}`,
    reason: `${game.modeName} · ${game.rounds} rounds · answers ${game.answers.join(' ')} · seed ${game.seed}`,
    draft,
  });
}

/** 'eyetest' — the "Ghost Object Tracker" visual focus test. No source, no LLM. */
async function runEyeTestPost(ctx: StepContext, jobId: string): Promise<RunOutcome> {
  skipStepsExcept(ctx, ['render']);
  const { render, game } = await stage(ctx, 'render', () => runEyeTest(ctx));
  const roundsLine =
    game.rounds > 1
      ? `${game.rounds} rounds — ${game.ballsPerRound.join('/')} balls, ${game.shuffleSec}s of real physics every round`
      : `${game.ballsPerRound[0]} balls, ${game.shuffleSec}s of real physics`;
  const draft: DraftText = {
    hook: 'Dynamic vision test 👀 can you actually track it?',
    overlays: [game.rounds > 1 ? `${game.rounds} rounds` : `ball #${game.answers[0]}`],
    caption:
      `Dynamic vision test 👀 focus on the gold ball, then don't blink.\n\n` +
      `${roundsLine} — every ball bounces off each other for real, the whole arena spins, and then it freezes. ` +
      `Lock in your guess before each reveal.\n\n` +
      `Comment your ${game.rounds > 1 ? 'scores' : 'number'} 👇`,
    hashtags: ['eyetest', 'visiontest', 'canyoutrackit', 'watchtillend', 'fyp'],
  };
  return finishPost(ctx, jobId, render, {
    hookTitle: `answers ${game.answers.join('-')}`,
    reason: `${game.rounds} round(s) (${game.ballsPerRound.join('/')} balls) · answers ${game.answers.join(' ')} · shuffle ${game.shuffleSec}s · seed ${game.seed}`,
    draft,
  });
}

/** 'quotes' — a silent 15s "Reminders" card: a curated line of original advice inspired by
 *  broad Quranic/Hadith themes (not literal ayahs/hadith). No source, no LLM. */
async function runQuotesPost(ctx: StepContext, jobId: string): Promise<RunOutcome> {
  skipStepsExcept(ctx, ['render']);
  const { render, quote } = await stage(ctx, 'render', () => runQuotes(ctx));
  const draft: DraftText = {
    hook: `${quote.tag} — a reminder 🤍`,
    overlays: [quote.setup, quote.punch],
    caption:
      `${quote.setup}\n${quote.punch}\n\n` +
      `Save this for later 🤍\n\n` +
      `Tag someone who needs to see this 👇`,
    hashtags: ['reminder', 'deen', 'advice', 'selfimprovement', 'fyp'],
  };
  return finishPost(ctx, jobId, render, {
    hookTitle: quote.tag,
    reason: `Reminders · ${quote.tag} · "${quote.setup} / ${quote.punch}" · seed ${quote.seed}`,
    draft,
  });
}

/** 'marblerace' — a 3D wooden marble run (Three.js + Rapier). No source, no LLM. */
async function runMarbleRacePost(ctx: StepContext, jobId: string): Promise<RunOutcome> {
  skipStepsExcept(ctx, ['render']);
  const { render, race } = await stage(ctx, 'render', () => runMarbleRace(ctx));
  const rivals = race.colors.map((c) => c.toLowerCase());
  const draft: DraftText = {
    hook: 'Which marble wins?',
    overlays: [race.colors.join('  vs  ')],
    caption: `${rivals.join(' vs ')} 🔴🟢 Marble race! Who will win?\n\nPick your marble before the finish line 👇`,
    hashtags: ['marblerace', 'marbles', 'marblerun', 'satisfying', 'fyp'],
  };
  return finishPost(ctx, jobId, render, {
    hookTitle: `${race.winner} wins`,
    reason: `${race.mapName} · ${race.colors.join(' vs ')} · seed ${race.seed}`,
    draft,
  });
}

/** 'escaperace' — a "which colour escapes first?" ring-escape race. No source, no LLM. */
async function runEscapeRacePost(ctx: StepContext, jobId: string): Promise<RunOutcome> {
  skipStepsExcept(ctx, ['render']);
  const { render, race } = await stage(ctx, 'render', () => runEscapeRace(ctx));
  const [c1, c2] = race.colors;
  const draft: DraftText = {
    hook: 'Which color escapes first?',
    overlays: [race.colors.join('  vs  ')],
    caption: `${c1} vs ${c2} 🌀 ${race.rings} rings, one gap each — which color breaks out first?\n\nComment your color before it escapes 👇`,
    hashtags: ['satisfying', 'physics', 'ballrace', 'asmr', 'fyp'],
  };
  return finishPost(ctx, jobId, render, {
    hookTitle: `${race.winner} escapes first`,
    reason: `${race.mapName} · ${race.colors.join(' vs ')} · seed ${race.seed}`,
    draft,
  });
}

/** 'lasernations' — a neon territory-capture sim (laser trails + trail slicing). No source, no LLM. */
async function runLaserNationsPost(ctx: StepContext, jobId: string): Promise<RunOutcome> {
  skipStepsExcept(ctx, ['render']);
  const { render, race } = await stage(ctx, 'render', () => runLaserNations(ctx));
  const [c1, c2] = race.countries;
  const draft: DraftText = {
    hook: 'Watch till the end 👀 which flag wins?',
    overlays: [race.countries.join('  ·  ')],
    caption:
      `Which flag wins? 👀 Watch till the end.\n\n` +
      `${c1} vs ${c2} — 4 nations carve glowing laser trails and slice each other's` +
      `${race.blackHole ? ', then a black hole opens and drags them all in' : ''}. ` +
      `Highest score when the clock hits zero takes it.\n\n` +
      `Comment your country before it ends 👇`,
    hashtags: ['flagrace', 'countryballs', 'simulation', 'watchtillend', 'fyp'],
  };
  return finishPost(ctx, jobId, render, {
    hookTitle: `${race.winner} wins`,
    reason: `Laser Nations · ${race.countries.join(' · ')} → ${race.winner} ${race.score.toLocaleString()}${race.blackHole ? ' · black-hole' : ''} · seed ${race.seed}`,
    draft,
  });
}

/** 'lasernations' duel mode — a 1v1 fight: two nations, health bars, perks, a
 *  chosen or chance-decided winner. No source, no LLM. */
async function runLaserDuelPost(ctx: StepContext, jobId: string): Promise<RunOutcome> {
  skipStepsExcept(ctx, ['render']);
  const { render, duel } = await stage(ctx, 'render', () => runLaserDuel(ctx));
  const koLine = duel.cause === 'ko'
    ? `${duel.winner} lands the knockout`
    : `${duel.winner} wins on health when the clock runs out`;
  const draft: DraftText = {
    hook: `WATCH TILL THE END 👀 ${duel.nationA} vs ${duel.nationB} — this fight swings back and forth`,
    overlays: [`${duel.nationA} vs ${duel.nationB}`],
    caption:
      `WATCH TILL THE END 👀 ${duel.nationA} vs ${duel.nationB} — this one swings back and forth.\n\n` +
      `Real health bars, direct hits, and power-ups either fighter can steal — heals, shields, ` +
      `rage, speed. Down to almost nothing, either one can still turn it around. ${koLine}.\n\n` +
      `Comment who you had winning 👇`,
    hashtags: ['laserduel', 'countryballs', 'versus', 'watchtillend', 'fyp'],
  };
  return finishPost(ctx, jobId, render, {
    hookTitle: `${duel.winner} wins`,
    reason: `Laser Nations Duel · ${duel.nationA} vs ${duel.nationB} → ${duel.winner} (${duel.cause}, ${duel.hpA}%/${duel.hpB}%) · seed ${duel.seed}`,
    draft,
  });
}

/** 'question' format — a big engagement question on a designed background, no source video. */
async function runQuestionPost(ctx: StepContext, jobId: string): Promise<RunOutcome> {
  skipStepsExcept(ctx, ['select', 'render']);
  const trends = await fetchTrending('US', 40)
    .then((v) => v.map((x) => `${x.title} — ${x.channel}`))
    .catch(() => [] as string[]);
  const q = await stage(ctx, 'select', () => writeQuestionPost(ctx, trends));
  const render = await stage(ctx, 'render', () => renderQuestionPost(ctx, q));
  return finishPost(ctx, jobId, render, {
    hookTitle: q.question,
    reason: q.angle === 'trending' ? 'Trending hot take' : 'Debate bait',
    draft: { hook: q.question, overlays: [q.commentPrompt] },
  });
}

/** 'story' format — a made-up story over muted halal gameplay, top/bottom split. */
async function runStoryPost(ctx: StepContext, jobId: string): Promise<RunOutcome> {
  skipStepsExcept(ctx, ['search', 'download', 'filter', 'select', 'render']);
  const story = await stage(ctx, 'select', () => writeStoryPost(ctx));
  // grab a generous window — renderStoryPost decides the real length from the reading pace
  const gp = await stage(ctx, 'search', () => fetchGameplay(ctx, 100));
  ctx.setStep('download', 'done');
  ctx.setStep('filter', 'done', { detail: `gameplay: ${gp.video.channel}` });
  recordUsedVideo(gp.video, 'processing');
  const render = await stage(ctx, 'render', () => renderStoryPost(ctx, story, gp.videoPath, gp.startSec));
  return finishPost(ctx, jobId, render, {
    hookTitle: story.title,
    reason: `Story over ${gp.video.channel} gameplay`,
    draft: { hook: story.title, overlays: [story.body, story.commentPrompt] },
  });
}

export async function runPipeline(opts: RunOptions): Promise<RunOutcome> {
  const { jobId, signal, broadcast } = opts;
  const job = getJob(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);

  const ctx = createContext({ jobId, settings: job.settings, signal, broadcast });
  updateJob(jobId, { status: 'running', startedAt: new Date().toISOString() });
  ctx.emit({ type: 'job:status', status: 'running' });
  log.info(`job ${jobId} started`);

  try {
    if (job.settings.contentType === 'colorrace') return await runColorRacePost(ctx, jobId);
    if (job.settings.contentType === 'escaperace') return await runEscapeRacePost(ctx, jobId);
    if (job.settings.contentType === 'lasernations' && job.settings.laserNationsMode === 'duel') return await runLaserDuelPost(ctx, jobId);
    if (job.settings.contentType === 'lasernations') return await runLaserNationsPost(ctx, jobId);
    if (job.settings.contentType === 'colorwar') return await runColorWarPost(ctx, jobId);
    if (job.settings.contentType === 'followball') return await runFollowBallPost(ctx, jobId);
    if (job.settings.contentType === 'eyetest') return await runEyeTestPost(ctx, jobId);
    if (job.settings.contentType === 'quotes') return await runQuotesPost(ctx, jobId);
    // ContentType is exactly the 5 above — 'clip'/'storyteller'/'marblerace' were removed as
    // selectable content types 2026-09-04 (their pipeline code is left in this file, unused,
    // rather than deleted outright). This is unreachable for any value Settings can hold.
    throw new Error('unsupported content type');
  } catch (err) {
    const canceled = err instanceof CanceledError || signal.aborted;
    const message = (err as Error).message || 'unknown error';
    const patch: Parameters<typeof updateJob>[1] = {
      status: canceled ? 'canceled' : 'failed',
      finishedAt: new Date().toISOString(),
      pendingInput: null,
    };
    const alreadyRecorded = Boolean(getJob(jobId)?.errorMessage);
    if (!canceled && !alreadyRecorded) {
      patch.errorMessage = message;
      patch.errorStep = currentStage;
    }
    updateJob(jobId, patch);
    ctx.emit({ type: 'job:status', status: canceled ? 'canceled' : 'failed' });
    if (!canceled && !alreadyRecorded) ctx.emit({ type: 'job:error', step: currentStage, message });
    if (canceled) log.warn(`job ${jobId} canceled`);
    else log.error(`job ${jobId} failed:`, message);
    throw err;
  }
}

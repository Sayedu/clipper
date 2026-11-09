import { existsSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { generateJSON } from '../../ollama.ts';
import { QUESTION_POST_SYSTEM, STORY_POST_SYSTEM } from '../../guidelines.ts';
import { paths } from '../../paths.ts';
import { runPython } from '../../lib/python.ts';
import { excludedVideoIds } from '../../db.ts';
import { searchVideos } from '../../youtube.ts';
import { CandidateRejected, type SourceVideo } from '../../types.ts';
import { escapeFilterPath, ffmpegOnce, ffprobe, runFfmpeg } from '../ffmpeg.ts';
import type { StepContext } from '../context.ts';
import { downloadClip } from './download.ts';
import { contentFilter } from './filter.ts';
import type { RenderResult } from './render.ts';

const PLAY_W = 1080;
const PLAY_H = 1920;
const FONT = 'Anton'; // assets/fonts/Anton-Regular.ttf — tall condensed display face
const BODY_FONT = 'Montserrat';

// ---------------------------------------------------------------------------
// text generation
// ---------------------------------------------------------------------------

export interface QuestionPost {
  question: string;
  angle: 'debate' | 'trending';
  commentPrompt: string;
}

const questionSchema = z.object({
  question: z.string().min(6).max(180),
  angle: z.enum(['debate', 'trending']).catch('debate'),
  commentPrompt: z.string().min(2).max(40).catch('Settle this in the comments'),
});

/** Write one engagement-bait question. `trends` biases it toward a topical hook. */
export async function writeQuestionPost(ctx: StepContext, trends: string[]): Promise<QuestionPost> {
  ctx.setStep('select', 'running', { detail: 'writing the question' });
  // ~55% debate, ~45% trending when we have trends to work with
  const wantTrending = trends.length >= 3 && Math.random() < 0.45;
  const prompt = wantTrending
    ? `Lean "trending". Popular this week:\n${trends.slice(0, 20).map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nWrite the question.`
    : `Lean "debate". Write a fresh everyday pick-a-side question that would genuinely split a room. Avoid anything overused (pineapple pizza, water wet, dress colour).`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await generateJSON<unknown>({
        system: QUESTION_POST_SYSTEM,
        prompt,
        temperature: 0.9,
        signal: ctx.signal,
        timeoutMs: 40_000,
      });
      const parsed = questionSchema.safeParse(raw);
      if (parsed.success) {
        const q = parsed.data;
        ctx.log('select', `question: "${q.question}" (${q.angle})`);
        return q;
      }
    } catch (err) {
      ctx.log('select', `question draft failed (${(err as Error).message})`);
    }
  }
  throw new Error('Could not draft a question. Check the LLM connection (npm run doctor).');
}

export interface StoryPost {
  title: string;
  body: string;
  commentPrompt: string;
}

const storySchema = z.object({
  title: z.string().min(3).max(90),
  body: z.string().min(200).max(1400),
  commentPrompt: z.string().min(2).max(40).catch('What would you do?'),
});

/** Write a short "read to the end" story. */
export async function writeStoryPost(ctx: StepContext): Promise<StoryPost> {
  ctx.setStep('select', 'running', { detail: 'writing the story' });
  const seeds = [
    'a mysterious note left in a locker',
    'a stranger who paid for my groceries and vanished',
    'the new kid everyone warned me about',
    'a package that showed up with my name but the wrong address',
    'the neighbour who never turned their lights on',
    'a wallet full of cash on an empty bus',
    'the substitute teacher who knew my grandfather',
    'a phone that kept ringing from an unknown number',
    'the day the whole class got the same weird dream',
    'a locked room in my uncle’s house',
  ];
  const seed = seeds[Math.floor(Math.random() * seeds.length)]!;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await generateJSON<unknown>({
        system: STORY_POST_SYSTEM,
        prompt: `Story seed to riff on (change it freely): ${seed}\n\nWrite it. 90-140 words, hook first line, twist or cliffhanger, final line asks the viewer directly.`,
        temperature: 0.95,
        signal: ctx.signal,
        timeoutMs: 45_000,
      });
      const parsed = storySchema.safeParse(raw);
      if (parsed.success) {
        ctx.log('select', `story: "${parsed.data.title}" (${parsed.data.body.split(/\s+/).length} words)`);
        return parsed.data;
      }
    } catch (err) {
      ctx.log('select', `story draft failed (${(err as Error).message})`);
    }
  }
  throw new Error('Could not draft a story. Check the LLM connection (npm run doctor).');
}

// ---------------------------------------------------------------------------
// gameplay footage (story format)
// ---------------------------------------------------------------------------

// Real games only. "screen recording" / "full screen" / "no cam" biases YouTube away
// from reaction & facecam uploads; fetchGameplay also hard-rejects any clip with a
// person on camera (contentFilter noPeople).
const GAMEPLAY_QUERIES = [
  'minecraft parkour screen recording no commentary',
  'subway surfers full screen gameplay no cam',
  'geometry dash gameplay screen recording',
  'trackmania gameplay no commentary full screen',
  'temple run 2 gameplay screen only',
  'minecraft parkour longplay no cam',
  'roblox obby gameplay screen recording',
  'nitro type gameplay screen recording',
  'hill climb racing gameplay no commentary',
  'crossy road gameplay screen recording',
];

export interface GameplayClip {
  video: SourceVideo;
  videoPath: string;
  startSec: number;
}

/**
 * Find a halal, no-commentary gameplay clip for the story background. Tries a few
 * search hits, downloads a ~2-minute window from a random point, and screens it
 * (no women / no forbidden scenes; music is irrelevant — the audio gets muted).
 */
export async function fetchGameplay(ctx: StepContext, wantSec: number): Promise<GameplayClip> {
  // pull from two different queries so one all-facecam result set doesn't sink the run
  const shuffled = [...GAMEPLAY_QUERIES].sort(() => Math.random() - 0.5).slice(0, 2);
  ctx.setStep('search', 'running', { detail: `gameplay: ${shuffled.map((q) => `"${q}"`).join(' / ')}` });
  const excluded = excludedVideoIds();
  const byId = new Map<string, SourceVideo>();
  for (const query of shuffled) {
    ctx.log('search', `looking for gameplay — "${query}"`);
    const results = await searchVideos({ query, maxResults: 25 }).catch(() => []);
    for (const v of results) {
      if (!byId.has(v.videoId) && !excluded.has(v.videoId) && v.durationSec >= wantSec + 90 && v.viewCount >= 3_000) {
        byId.set(v.videoId, v);
      }
    }
  }
  const pool = [...byId.values()].sort(() => Math.random() - 0.5).slice(0, 16);
  if (!pool.length) throw new Error('No usable gameplay found. Try again.');

  const LEAD_IN = 4; // seconds to skip at the head of the downloaded chunk
  let lastErr = 'none passed the content check';
  for (let i = 0; i < Math.min(pool.length, 7); i++) {
    ctx.throwIfCanceled();
    const video = pool[i]!;
    // grab a window from a random point well inside the video (skip intro / outro)
    const maxStart = Math.max(45, video.durationSec - wantSec - 45);
    const startSec = Math.floor(45 + Math.random() * Math.max(1, maxStart - 45));
    try {
      ctx.setStep('download', 'running', { detail: `${video.channel} — ${Math.round(startSec / 60)} min in` });
      const { videoPath } = await downloadClip(ctx, video, { startSec, endSec: startSec + wantSec + LEAD_IN + 12 });
      await contentFilter(ctx, {
        dl: { source: video, videoPath, infoJsonPath: null, thumbnailPath: null, youtubeSubsPath: null, deferred: false, windowOffsetSec: 0 },
        transcript: { language: 'en', durationSec: wantSec, segments: [] },
        skipTranscript: true,
        skipMusic: true,
        noPeople: true,
        windows: [{ start: LEAD_IN, end: LEAD_IN + wantSec }],
      });
      ctx.log('filter', `gameplay ok — ${video.title.slice(0, 50)}`);
      return { video, videoPath, startSec: LEAD_IN };
    } catch (err) {
      if (err instanceof CandidateRejected) {
        lastErr = err.reason;
        ctx.log('filter', `gameplay "${video.title.slice(0, 40)}" skipped — ${err.reason}`);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Couldn't find clean gameplay (${lastErr}).`);
}

// ---------------------------------------------------------------------------
// ASS layout
// ---------------------------------------------------------------------------

function assEsc(t: string): string {
  return t.replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\r?\n/g, ' ').trim();
}
function assTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${sec}`;
}
/** Wrap into <= maxLines lines near `target` chars, never dropping a word. */
function wrap(text: string, target: number, maxLines: number): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > target && lines.length < maxLines - 1) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines.join('\\N');
}

const HEADER = (extraStyles: string[]): string =>
  [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${PLAY_W}`,
    `PlayResY: ${PLAY_H}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, ' +
      'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, ' +
      'Alignment, MarginL, MarginR, MarginV, Encoding',
    ...extraStyles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

/** Full-screen question card. */
function buildQuestionAss(q: QuestionPost, durationSec: number): string {
  const white = '&H00FFFFFF';
  const accent = '&H0066E0FF'; // warm gold-ish in BGR
  const dark = '&H00101010';
  // scale the question down a notch when it's long so it never kisses the edges
  const words = q.question.split(/\s+/).length;
  const qSize = words >= 13 ? 88 : words >= 10 ? 100 : 112;
  const styles = [
    `Style: Kick,${BODY_FONT},48,${accent},${accent},${dark},&H90000000,-1,0,0,0,100,100,5,0,1,3,2,5,80,80,0,1`,
    `Style: Q,${FONT},${qSize},${white},${white},${dark},&H64000000,0,0,0,0,100,100,1,0,1,7,5,5,80,80,0,1`,
    `Style: CTA,${BODY_FONT},52,${white},${white},${dark},&H90000000,-1,0,0,0,100,100,4,0,1,3,2,5,90,90,0,1`,
  ];
  const wrapped = wrap(assEsc(q.question), 19, 7);
  const kick = q.angle === 'trending' ? 'HOT TAKE' : q.angle === 'debate' ? 'PICK A SIDE' : 'QUESTION';
  const end = assTime(durationSec);
  const events = [
    `Dialogue: 0,${assTime(0)},${end},Kick,,0,0,0,,{\\an5\\pos(${PLAY_W / 2},${Math.round(PLAY_H * 0.17)})\\fad(200,0)}${kick}`,
    `Dialogue: 1,${assTime(0)},${end},Q,,0,0,0,,{\\an5\\pos(${PLAY_W / 2},${Math.round(PLAY_H * 0.45)})\\fad(250,0)\\t(0,240,\\fscx101\\fscy101)}${wrapped}`,
    `Dialogue: 0,${assTime(0.35)},${end},CTA,,0,0,0,,{\\an5\\pos(${PLAY_W / 2},${Math.round(PLAY_H * 0.84)})\\fad(400,0)}${assEsc(q.commentPrompt).toUpperCase()}  \\N\\N{\\fs40}comment your answer`,
  ];
  return `${HEADER(styles)}\n${events.join('\n')}\n`;
}

/** Split the story into short reading beats (<= ~120 chars, sentence-aligned). */
function storyBeats(body: string): string[] {
  const clean = body
    .replace(/\s+/g, ' ')
    .trim()
    // drop the period on common abbreviations so it doesn't read as a sentence end
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|etc|a\.m|p\.m)\./gi, '$1');
  const sentences = clean.match(/[^.!?]+[.!?]+["'”’)\]]*|\S[^.!?]*$/g) ?? [clean];
  const beats: string[] = [];
  let buf = '';
  for (const s of sentences) {
    const t = s.trim();
    if (!t) continue;
    if (buf && (buf + ' ' + t).length > 118) {
      beats.push(buf);
      buf = t;
    } else {
      buf = buf ? `${buf} ${t}` : t;
    }
  }
  if (buf) beats.push(buf);
  return beats;
}

/**
 * Story text on the bottom panel — one beat on screen at a time (replaced, not
 * stacked), the last beat (the question) held to the end. Title pinned above.
 * Returns the total duration it needs so the render matches the reading pace.
 */
function buildStoryAss(story: StoryPost): { ass: string; durationSec: number } {
  const white = '&H00FFFFFF';
  const accent = '&H0066E0FF';
  const dark = '&H00101010';
  const styles = [
    `Style: STitle,${FONT},52,${accent},${accent},${dark},&H90000000,0,0,0,0,100,100,3,0,1,3,2,8,90,90,40,1`,
    `Style: SBody,${BODY_FONT},50,${white},${white},${dark},&H30000000,-1,0,0,0,100,100,0,0,1,3,1,8,110,110,0,1`,
    `Style: SBar,${BODY_FONT},40,${white},${white},${dark},&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
  ];
  // top-anchor the beats just below the title so each one starts in the same place
  const titleY = Math.round(PLAY_H / 2) + 34;
  const bodyTopY = titleY + 116;

  const beats = storyBeats(story.body);
  const startPad = 0.6;
  // each beat: ~1 word per 0.42 s of reading, clamped to a comfortable 2.8–6.5 s
  const holds = beats.map((b) => Math.min(6.5, Math.max(2.8, b.split(/\s+/).length * 0.42 + 0.8)));
  const durationSec = Math.round(startPad + holds.reduce((a, b) => a + b, 0) + 1.6);
  const end = assTime(durationSec);

  const barW = 360;
  const barX = Math.round((PLAY_W - barW) / 2);
  const barY = PLAY_H - 70;
  const rect = (w: number) => `m 0 0 l ${w} 0 l ${w} 7 l 0 7`;

  const events: string[] = [
    `Dialogue: 0,${assTime(0)},${end},STitle,,0,0,0,,{\\an8\\pos(${PLAY_W / 2},${titleY})\\fad(300,0)}${assEsc(story.title).toUpperCase()}`,
    // progress-bar track
    `Dialogue: 1,${assTime(0)},${end},SBar,,0,0,0,,{\\an7\\pos(${barX},${barY})\\p1\\c&H33FFFFFF&\\bord0\\shad0}${rect(barW)}`,
  ];
  let cursor = startPad;
  beats.forEach((b, i) => {
    const isLast = i === beats.length - 1;
    const hold = isLast ? end : assTime(cursor + holds[i]! + 0.4); // small overlap-free gap
    events.push(
      `Dialogue: 2,${assTime(cursor)},${hold},SBody,,0,0,0,,{\\an8\\pos(${PLAY_W / 2},${bodyTopY})\\fad(200,${isLast ? 0 : 160})}${wrap(assEsc(b), 28, 6)}`,
    );
    // progress-bar fill up to the current beat
    const fillW = Math.max(7, Math.round((barW * (i + 1)) / beats.length));
    events.push(
      `Dialogue: 3,${assTime(cursor)},${hold},SBar,,0,0,0,,{\\an7\\pos(${barX},${barY})\\p1\\c&H0066E0FF&\\bord0\\shad0}${rect(fillW)}`,
    );
    cursor += holds[i]!;
  });
  return { ass: `${HEADER(styles)}\n${events.join('\n')}\n`, durationSec };
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

/** Compose the question card: designed background + slow zoom + text, silent. */
export async function renderQuestionPost(ctx: StepContext, q: QuestionPost): Promise<RenderResult> {
  const durationSec = 8;
  const bgPath = ctx.file('bg.png');
  ctx.setStep('render', 'running', { detail: 'painting the background' });
  await runPython('postcard.py', {
    args: ['--out', bgPath, '--w', String(PLAY_W), '--h', String(PLAY_H), '--seed', String(Math.floor(Math.random() * 1e6))],
    signal: ctx.signal,
    onLog: (l) => ctx.log('render', l),
  });
  if (!existsSync(bgPath)) throw new Error('background generation produced no file');

  const assPath = ctx.file('post.ass');
  writeFileSync(assPath, buildQuestionAss(q, durationSec));

  const outPath = ctx.file('final.0.mp4');
  const thumbPath = ctx.file('thumb.0.jpg');
  ctx.setStep('render', 'running', { detail: 'rendering the card' });

  const vf =
    `[0:v]scale=${PLAY_W * 1.08}:-1,zoompan=z='min(zoom+0.0006,1.08)':d=${durationSec * 30}:` +
    `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${PLAY_W}x${PLAY_H}:fps=30,` +
    `ass='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath(paths.fonts)}',format=yuv420p[v]`;

  await runFfmpeg(
    [
      '-y',
      '-loop', '1', '-t', String(durationSec), '-i', bgPath,
      '-f', 'lavfi', '-t', String(durationSec), '-i', 'anullsrc=r=44100:cl=stereo',
      '-filter_complex', vf,
      '-map', '[v]', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-t', String(durationSec),
      outPath,
    ],
    { signal: ctx.signal, totalDurationSec: durationSec, onProgress: (p) => ctx.progress('render', p * 0.9) },
  );

  await ffmpegOnce(['-y', '-ss', '1.5', '-i', outPath, '-frames:v', '1', '-q:v', '3', thumbPath]);
  const probe = await ffprobe(outPath);
  return { videoPath: outPath, thumbPath, durationSec: probe.durationSec, width: probe.width, height: probe.height };
}

/** Compose the story: muted gameplay on top, story text panel on the bottom. */
export async function renderStoryPost(
  ctx: StepContext,
  story: StoryPost,
  gameplayPath: string,
  gameplayStartSec: number,
): Promise<RenderResult> {
  const built = buildStoryAss(story);
  const durationSec = Math.min(85, Math.max(28, built.durationSec));
  const assPath = ctx.file('post.ass');
  writeFileSync(assPath, built.ass);

  const outPath = ctx.file('final.0.mp4');
  const thumbPath = ctx.file('thumb.0.jpg');
  ctx.setStep('render', 'running', { detail: `composing (${durationSec}s)` });

  // top: gameplay filled to 1080x960. bottom: deep panel. stack. burn text. mute.
  const half = PLAY_H / 2;
  const vf =
    `[0:v]scale=${PLAY_W}:${half}:force_original_aspect_ratio=increase,crop=${PLAY_W}:${half},setsar=1[top];` +
    `color=c=0x0B1220:s=${PLAY_W}x${half}:r=30[bot];` +
    `[bot]drawbox=x=0:y=0:w=iw:h=4:color=0x66E0FF@0.9:t=fill[botl];` +
    `[top][botl]vstack=inputs=2,` +
    `ass='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath(paths.fonts)}',format=yuv420p[v]`;

  await runFfmpeg(
    [
      '-y',
      '-ss', String(Math.max(0, gameplayStartSec)), '-t', String(durationSec), '-i', gameplayPath,
      '-f', 'lavfi', '-t', String(durationSec), '-i', 'anullsrc=r=44100:cl=stereo',
      '-filter_complex', vf,
      '-map', '[v]', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-t', String(durationSec), '-shortest',
      outPath,
    ],
    { signal: ctx.signal, totalDurationSec: durationSec, onProgress: (p) => ctx.progress('render', p * 0.9) },
  );

  await ffmpegOnce(['-y', '-ss', String(Math.min(durationSec / 2, 4)), '-i', outPath, '-frames:v', '1', '-q:v', '3', thumbPath]);
  const probe = await ffprobe(outPath);
  return { videoPath: outPath, thumbPath, durationSec: probe.durationSec, width: probe.width, height: probe.height };
}

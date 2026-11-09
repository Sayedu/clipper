import { existsSync } from 'node:fs';
import { z } from 'zod';
import { generateJSON } from '../../ollama.ts';
import { runPython, readVerdict } from '../../lib/python.ts';
import { firstDisallowedTerm } from '../../lib/textmatch.ts';
import { CandidateRejected, type Transcript } from '../../types.ts';
import { FORBIDDEN_TERMS, FORBIDDEN_VISUALS, GUIDELINE_SCAN_SYSTEM } from '../../guidelines.ts';
import { extractAudio, ffprobe } from '../ffmpeg.ts';
import type { StepContext } from '../context.ts';
import type { DownloadResult } from './download.ts';

export interface FilterResult {
  stripMusic: boolean;
  /** Fraction of the chosen clip's sampled frames that show a real face (0..1). A face-cam signal for scoring. */
  faceFrac: number;
}

interface ScreenVerdict {
  frames: Array<{ image: string; faces: Array<{ gender: string; areaFrac: number }>; concepts: Record<string, number> }>;
  women: Array<{ image: string; conf: number; areaFrac?: number; mainSubject: boolean }>;
  conceptHits: Array<{ concept: string; image: string; score: number }>;
}

/** A face counts as "present" for the face-cam signal at ≥3% of frame area. */
const FACE_PRESENT_AREA = 0.03;

function faceFractionOf(verdict: ScreenVerdict): number {
  if (!verdict.frames?.length) return 0;
  const withFace = verdict.frames.filter((f) => f.faces?.some((face) => (face.areaFrac ?? 0) >= FACE_PRESENT_AREA)).length;
  return withFace / verdict.frames.length;
}
interface MusicVerdict {
  likelyMusic: boolean;
  musicRatio: number;
}

/** Internal sentinel: music probe deliberately skipped (muted footage). */
class MusicSkipped extends Error {}

const FORBIDDEN_CONCEPT_SCORE = 0.82; // open_clip hit at/above this drops the video
const MOSTLY_MUSIC_RATIO = 0.62; // above this the segment is basically music — stripping leaves silence, so drop it
const WOMAN_MIN_FRAMES = 3; // a female face must persist this many sampled frames (InsightFace flickers on blips)
const WOMAN_MIN_AREA = 0.01;

/**
 * Transcript screen — no video needed, so it runs early in the candidate loop and
 * a hit just moves on to the next video. Enforces the hard-wired guideline word
 * list plus any extra words the user added, then a lenient LLM topic scan.
 */
export async function contentFilterTranscript(ctx: StepContext, transcript: Transcript): Promise<void> {
  const fullText = transcript.segments.map((seg) => seg.text).join(' ');
  ctx.progress('filter', 0.05, 'screening transcript');

  const terms = [...FORBIDDEN_TERMS, ...ctx.settings.blockedKeywords.map((t) => t.trim()).filter(Boolean)];
  const hit = firstDisallowedTerm(fullText, terms);
  if (hit) throw new CandidateRejected(`transcript says "${hit}"`);

  try {
    const raw = await generateJSON<{ flagged: boolean; reason: string }>({
      system: GUIDELINE_SCAN_SYSTEM,
      prompt: `TRANSCRIPT:\n${fullText.slice(0, 8000)}`,
      temperature: 0,
      signal: ctx.signal,
      timeoutMs: 60_000,
    });
    const parsed = z.object({ flagged: z.boolean(), reason: z.string() }).safeParse(raw);
    if (parsed.success && parsed.data.flagged) {
      throw new CandidateRejected(parsed.data.reason || 'transcript conflicts with the content guideline');
    }
  } catch (err) {
    if (err instanceof CandidateRejected) throw err;
    ctx.log('filter', `LLM topic scan skipped (${(err as Error).message})`);
  }
}

/** Media screen — Demucs music probe + open_clip / InsightFace on sampled frames. A hit drops the video. */
export async function contentFilter(
  ctx: StepContext,
  input: {
    dl: DownloadResult;
    transcript: Transcript;
    skipTranscript?: boolean;
    /** Skip the Demucs music probe — for footage that will be muted anyway. */
    skipMusic?: boolean;
    /** Reject if ANY person is on camera (for the story format's background gameplay). */
    noPeople?: boolean;
    /** Only screen these slices of `dl.videoPath` — the chosen clip(s), not the whole source. */
    windows?: Array<{ start: number; end: number }>;
  },
): Promise<FilterResult> {
  const { dl } = input;
  const windows = (input.windows ?? []).filter((w) => w.end > w.start);
  if (!input.skipTranscript) await contentFilterTranscript(ctx, input.transcript);

  // --- music (Demucs) — skipped for footage that will be muted -----
  let stripMusic = false;
  let incomplete: string | null = null;
  try {
    if (input.skipMusic) throw new MusicSkipped();
    ctx.progress('filter', 0.25, 'checking for music');
    const sampleWav = ctx.file('music-sample.wav');
    const probe = await ffprobe(dl.videoPath);
    // sample 60s from the middle of the first chosen clip (or the source when unscoped)
    const w0 = windows[0];
    const mid = w0 ? (Math.max(0, w0.start) + Math.min(probe.durationSec, w0.end)) / 2 : probe.durationSec / 2;
    const start = Math.max(0, Math.min(mid - 30, probe.durationSec - 60));
    if (!existsSync(sampleWav)) {
      await extractAudio(dl.videoPath, sampleWav, { sampleRate: 44_100, channels: 2, start, end: start + 60, signal: ctx.signal });
    }
    const musicVerdictPath = ctx.file('music-verdict.json');
    const out = await runPython('demucs_split.py', {
      args: ['--audio', sampleWav, '--mode', 'detect', '--out', musicVerdictPath],
      signal: ctx.signal,
      onProgress: (p, m) => ctx.progress('filter', 0.25 + p * 0.25, m),
      onLog: (l) => ctx.log('filter', l),
    });
    const music = readVerdict<MusicVerdict>(musicVerdictPath, out);
    if (music.likelyMusic) {
      if (music.musicRatio >= MOSTLY_MUSIC_RATIO) throw new CandidateRejected('the audio is mostly music');
      ctx.log('filter', `music present (ratio ${music.musicRatio}) — will rebuild audio from the vocal stem`);
      stripMusic = true;
    }
  } catch (err) {
    if (err instanceof CandidateRejected) throw err;
    if (!(err instanceof MusicSkipped)) {
      incomplete = `music check failed (${(err as Error).message})`;
      ctx.log('filter', incomplete);
    }
  }

  // --- visuals: any woman on screen, or a forbidden scene ------
  ctx.progress('filter', 0.55, 'screening frames');
  const verdictPath = ctx.file('screen-verdict.json');
  const framesDir = ctx.file('flagged-frames');
  let faceFrac = 0;
  try {
    const out = await runPython('screen.py', {
      args: [
        '--video', dl.videoPath,
        '--sample-fps', '0.5',
        '--max-frames', String(Math.max(20, windows.length * 14)),
        ...(windows.length
          ? ['--windows', ...windows.map((w) => `${Math.max(0, w.start)}:${w.end}`)]
          : []),
        '--out', verdictPath,
        '--save-frames-dir', framesDir,
        '--concepts', ...FORBIDDEN_VISUALS,
      ],
      signal: ctx.signal,
      onProgress: (p, m) => ctx.progress('filter', 0.55 + p * 0.4, m),
      onLog: (l) => ctx.log('filter', l),
    });
    const verdict = readVerdict<ScreenVerdict>(verdictPath, out);
    faceFrac = faceFractionOf(verdict);

    const strong = verdict.conceptHits.find((h) => h.score >= FORBIDDEN_CONCEPT_SCORE);
    if (strong) throw new CandidateRejected(`on screen: ${strong.concept}`);

    // pure gameplay has no people — reject a facecam / reaction video
    if (input.noPeople) {
      const withFace = verdict.frames.filter((f) => f.faces.some((face) => (face.areaFrac ?? 0) >= 0.02)).length;
      if (withFace >= 2) throw new CandidateRejected(`a person is on camera (${withFace} frames) — not clean gameplay`);
    }

    // a female face that actually persists (not a 1-2 frame InsightFace misread)
    const byFrame = new Map<string, number>();
    for (const w of verdict.women) {
      if ((w.areaFrac ?? 1) >= WOMAN_MIN_AREA) byFrame.set(w.image, (byFrame.get(w.image) ?? 0) + 1);
    }
    if (byFrame.size >= WOMAN_MIN_FRAMES) {
      throw new CandidateRejected(`a woman is on screen (${byFrame.size} frames)`);
    }
  } catch (err) {
    if (err instanceof CandidateRejected) throw err;
    incomplete = `${incomplete ? incomplete + '; ' : ''}visual screen failed (${(err as Error).message})`;
    ctx.log('filter', incomplete);
  }

  ctx.progress('filter', 1);
  const faceNote = faceFrac >= 0.5 ? ' · face-cam' : faceFrac > 0 ? ' · partial face-cam' : '';
  ctx.setStep('filter', 'running', {
    detail: incomplete
      ? `partial — ${incomplete}`
      : `${stripMusic ? 'passed · music will be stripped' : 'passed'}${faceNote}`,
  });
  return { stripMusic, faceFrac };
}

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../../env.ts';
import { paths } from '../../paths.ts';
import { log } from '../../lib/log.ts';
import { runPython } from '../../lib/python.ts';
import { run } from '../../lib/exec.ts';
import type { Transcript } from '../../types.ts';
import { escapeFilterPath, extractAudio, FFMPEG, ffmpegOnce, ffprobe, runFfmpeg } from '../ffmpeg.ts';
import type { StepContext } from '../context.ts';
import type { RenderResult } from './render.ts';

const PLAY_W = 1080;
const PLAY_H = 1920;
const SFX_EXT = /\.(wav|mp3|m4a|aac|ogg|flac)$/i;

/** Whisper the narration WAV for word-level timing (own model load, ~clip length). */
export async function transcribeNarration(ctx: StepContext, wavPath: string): Promise<Transcript> {
  const audio16k = ctx.file('narration16k.wav');
  await extractAudio(wavPath, audio16k, { sampleRate: 16_000, channels: 1, signal: ctx.signal });
  const outPath = ctx.file('narration-transcript.json');
  const model = ctx.settings.whisperModel.includes('turbo') ? ctx.settings.whisperModel : 'large-v3-turbo';
  try {
    await runPython('transcribe.py', {
      args: ['--audio', audio16k, '--out', outPath, '--model', model, '--compute', env.whisper.compute, '--language', 'en'],
      signal: ctx.signal,
      onProgress: (p, m) => ctx.progress('transcribe', p, m),
      onLog: (l) => ctx.log('transcribe', l),
    });
  } catch (err) {
    if (!existsSync(outPath)) throw err; // CTranslate2 can crash at shutdown after writing — tolerate that
    ctx.log('transcribe', 'transcribe.py exited non-zero but a transcript was written — using it');
  }
  const t = JSON.parse(readFileSync(outPath, 'utf8')) as Transcript;
  const words = t.segments.reduce((n, s) => n + s.words.length, 0);
  ctx.setStep('transcribe', 'running', { detail: `${words} words aligned to the narration` });
  return t;
}

/** Two-pass EBU R128 loudness normalise the narration to a consistent −16 LUFS (voice). */
export async function normaliseNarration(ctx: StepContext, inWav: string, outWav: string): Promise<void> {
  const measure = await run(
    FFMPEG,
    ['-hide_banner', '-i', inWav, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'],
    { signal: ctx.signal },
  ).catch(() => null);
  const json = measure?.stderr.match(/\{[\s\S]*?\}/g)?.at(-1);
  let af = 'loudnorm=I=-16:TP=-1.5:LRA=11';
  if (json) {
    try {
      const m = JSON.parse(json) as Record<string, string>;
      af =
        `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:` +
        `measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
    } catch {
      /* keep single-pass */
    }
  }
  await runFfmpeg(
    ['-y', '-i', inWav, '-af', `${af},highpass=f=70,afftdn=nf=-28`, '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', outWav],
    { signal: ctx.signal },
  );
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

/** Map each verbatim SFX-cue phrase to the narration timestamp where it's spoken. */
export function mapSfxCues(transcript: Transcript, cues: string[]): number[] {
  const words = transcript.segments.flatMap((s) => s.words).filter((w) => w.word.trim());
  if (!words.length) return [];
  const toks = words.map((w) => norm(w.word)[0] ?? '');
  const out: number[] = [];
  for (const cue of cues.slice(0, 3)) {
    const q = norm(cue);
    if (q.length < 2) continue;
    let best = { score: 0, at: -1 };
    for (let i = 0; i + q.length <= toks.length; i++) {
      let score = 0;
      for (let k = 0; k < q.length; k++) if (toks[i + k] === q[k]) score++;
      if (score > best.score) best = { score, at: i };
    }
    if (best.at >= 0 && best.score >= Math.max(2, Math.ceil(q.length * 0.5))) {
      const t = words[best.at]!.start;
      if (!out.some((x) => Math.abs(x - t) < 2)) out.push(t);
    }
  }
  return out.sort((a, b) => a - b);
}

function pickSfx(pack: string, prefer: string[]): string | null {
  const dir = resolve(paths.sfx, pack);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => SFX_EXT.test(f));
  for (const name of prefer) {
    const hit = files.find((f) => f.toLowerCase().includes(name));
    if (hit) return resolve(dir, hit);
  }
  return null;
}

/**
 * Build the story's audio bed: loudnorm'd narration + optional SFX hits at the
 * marked beats + optional ambient music ducked hard under the voice. −16 LUFS out.
 */
export async function buildStoryAudio(
  ctx: StepContext,
  input: { narration: string; cueTimes: number[]; durationSec: number },
): Promise<string> {
  const out = ctx.file('story_audio.wav');
  const dur = input.durationSec.toFixed(2);

  const sfxFile = ctx.settings.sfxEnabled
    ? pickSfx(ctx.settings.sfxPack, ['impact', 'boom', 'hit', 'whoosh', 'riser', 'transition'])
    : null;
  const cues = sfxFile ? input.cueTimes.filter((t) => t < input.durationSec - 0.5).slice(0, 3) : [];
  const musicFile = ctx.settings.storyMusic
    ? pickSfx(ctx.settings.sfxPack, ['music', 'ambient', 'bed', 'drone', 'loop', 'underscore'])
    : null;
  if (ctx.settings.storyMusic && !musicFile) {
    ctx.log('sfx', `no ambient music file in sfx pack "${ctx.settings.sfxPack}" — skipping the bed`);
  }

  const inputs = ['-i', input.narration];
  const parts: string[] = [];
  // voice + a short room tail for atmosphere; split when the music also needs it as a key
  const voiceChain = 'aresample=48000,pan=stereo|c0=c0|c1=c0,aecho=0.85:0.9:38:0.16,highpass=f=75';
  parts.push(`[0:a]${voiceChain}${musicFile ? ',asplit=2[voice][vkey]' : '[voice]'}`);
  let mix = '[voice]';

  if (sfxFile && cues.length) {
    inputs.push('-i', sfxFile);
    cues.forEach((t, i) =>
      parts.push(`[1:a]adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)},volume=0.55[sfx${i}]`),
    );
    parts.push(`${mix}${cues.map((_, i) => `[sfx${i}]`).join('')}amix=inputs=${cues.length + 1}:normalize=0[vs]`);
    mix = '[vs]';
    ctx.log('sfx', `sfx at ${cues.map((t) => `${t.toFixed(1)}s`).join(', ')}`);
  }

  if (musicFile) {
    inputs.push('-stream_loop', '-1', '-i', musicFile);
    const mIdx = inputs.filter((a) => a === '-i').length - 1;
    parts.push(`[${mIdx}:a]aresample=48000,volume=0.16,atrim=0:${dur}[mraw]`);
    parts.push(`[mraw][vkey]sidechaincompress=threshold=0.03:ratio=8:attack=5:release=300[mduck]`);
    parts.push(`${mix}[mduck]amix=inputs=2:normalize=0[mixed]`);
    mix = '[mixed]';
    ctx.log('sfx', `ambient music bed (ducked): ${musicFile.split('/').pop()}`);
  }

  parts.push(`${mix}loudnorm=I=-16:TP=-1.5:LRA=11[a]`);
  await runFfmpeg(
    ['-y', ...inputs, '-filter_complex', parts.join(';'), '-map', '[a]', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', '-t', dur, out],
    { signal: ctx.signal },
  );
  return out;
}

/**
 * Compose the finished Storyteller video: a center-cropped 9:16 gameplay slice
 * (no face tracking — there's no speaker to follow) + karaoke captions + the
 * story audio bed. Muted gameplay.
 */
export async function composeStoryVideo(
  ctx: StepContext,
  input: {
    jobId: string;
    footagePath: string;
    footageStartSec: number;
    audioPath: string;
    assPath: string | null;
    durationSec: number;
  },
): Promise<RenderResult> {
  const { durationSec } = input;
  const outPath = ctx.file('final.0.mp4');
  const thumbPath = ctx.file('thumb.0.jpg');

  const probe = await ffprobe(input.footagePath).catch(() => null);
  const ar = probe && probe.height ? probe.width / probe.height : 16 / 9;
  // fill-crop for anything roughly landscape→portrait; letterbox only for the truly wide
  const scaleCrop =
    ar > 2.1
      ? `scale=${PLAY_W}:-2:force_original_aspect_ratio=decrease,pad=${PLAY_W}:${PLAY_H}:(ow-iw)/2:(oh-ih)/2:black`
      : `scale=${PLAY_W}:${PLAY_H}:force_original_aspect_ratio=increase,crop=${PLAY_W}:${PLAY_H}`;

  const assFilter = input.assPath
    ? `,ass='${escapeFilterPath(input.assPath)}':fontsdir='${escapeFilterPath(paths.fonts)}'`
    : '';
  const vf = `[0:v]${scaleCrop},setsar=1${assFilter},format=yuv420p[v]`;

  ctx.setStep('render', 'running', { detail: `compositing (${durationSec.toFixed(0)}s)` });
  await runFfmpeg(
    [
      '-y',
      '-ss', String(Math.max(0, input.footageStartSec)), '-t', String(durationSec), '-i', input.footagePath,
      '-i', input.audioPath,
      '-filter_complex', vf,
      '-map', '[v]', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', String(durationSec), '-shortest',
      outPath,
    ],
    { signal: ctx.signal, totalDurationSec: durationSec, onProgress: (p) => ctx.progress('render', p * 0.95) },
  );

  await ffmpegOnce(['-y', '-ss', String(Math.min(durationSec / 3, 3)), '-i', outPath, '-frames:v', '1', '-q:v', '3', thumbPath]);
  const outProbe = await ffprobe(outPath);
  log.ok(`storyteller video ${input.jobId} — ${outProbe.durationSec.toFixed(1)}s`);
  return { videoPath: outPath, thumbPath, durationSec: outProbe.durationSec, width: outProbe.width, height: outProbe.height };
}

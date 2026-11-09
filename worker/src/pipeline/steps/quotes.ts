import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { paths } from '../../paths.ts';
import { log } from '../../lib/log.ts';
import { stream } from '../../lib/exec.ts';
import { ffmpegOnce, ffprobe, runFfmpeg } from '../ffmpeg.ts';
import type { StepContext } from '../context.ts';
import type { RenderResult } from './render.ts';

export interface QuotesResult {
  seed: number;
  tag: string;
  setup: string;
  punch: string;
  durationSec: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  /** On-disk frame size; ffmpeg lanczos-downscales it to width×height when larger. */
  frameWidth: number;
  frameHeight: number;
  ss: number;
}

/**
 * 'Reminders' — a silent 15s card: a short setup line settles in, a beat of
 * pause, then a punch line lands with a soft flash (the silent stand-in for
 * a hit sound). The line comes from a curated bank of original advice
 * inspired by broad Quranic/Hadith themes (NOT literal ayahs/hadith — see
 * render/quotes/quotes.js), picked deterministically by seed. Rendered
 * headlessly in Chrome like every other synthetic content type; the only
 * audio is a silent track muxed in for platform-playback compatibility.
 */
export async function runQuotes(ctx: StepContext): Promise<{ render: RenderResult; quote: QuotesResult }> {
  const framesDir = ctx.file('qtframes');
  mkdirSync(framesDir, { recursive: true });
  const resultPath = ctx.file('quotes.json');

  // preview studio pins an exact seed so "render this" reproduces what was previewed
  const pinned = ctx.settings.quotesSeed;
  const seed = pinned && pinned > 0 ? Math.floor(pinned) : randomInt(1, 2_000_000_000);
  const fps = 30;
  const ss = 2;
  const outScale = 2; // 1080×1920 × 2 = 2160×3840 (4K), matching every other content type

  ctx.setStep('render', 'running', { detail: 'drawing the card' });
  const renderScript = resolve(paths.repoRoot, 'scripts', 'quotes', 'render.mjs');
  if (!existsSync(renderScript)) throw new Error(`reminders renderer missing: ${renderScript}`);

  await stream(
    process.execPath,
    [
      renderScript,
      '--seed', String(seed),
      '--fps', String(fps),
      '--ss', String(ss),
      '--out-scale', String(outScale),
      '--out-frames', framesDir,
      '--out', resultPath,
      // no --mux: this step composites its own silent track below
    ],
    {
      signal: ctx.signal,
      cwd: paths.repoRoot,
      onStderr: (line) => {
        if (line.startsWith('@progress ')) {
          try {
            const { pct, msg } = JSON.parse(line.slice('@progress '.length)) as { pct: number; msg: string };
            ctx.progress('render', pct * 0.75, msg ?? '');
            return;
          } catch {
            /* fall through */
          }
        }
        ctx.log('render', line);
      },
    },
  );

  if (!existsSync(resultPath)) throw new Error('reminders produced no result');
  const quote = JSON.parse(readFileSync(resultPath, 'utf8')) as QuotesResult;
  ctx.log('render', `"${quote.tag}" — "${quote.setup} / ${quote.punch}" (seed ${quote.seed})`);

  // ---- mux the frame sequence + a silent track → a sharp 4K (2160×3840) 9:16 mp4.
  //      Silent by design (no sound at all) — the track is just for platform
  //      playback compatibility, several apps handle a zero-audio-stream mp4 oddly.
  ctx.progress('render', 0.8, 'compositing 4K');
  const outPath = ctx.file('final.0.mp4');
  const thumbPath = ctx.file('thumb.0.jpg');
  const needsScale = quote.frameWidth !== quote.width || quote.frameHeight !== quote.height;
  const vf = [
    needsScale ? `scale=${quote.width}:${quote.height}:flags=lanczos+accurate_rnd+full_chroma_int` : null,
    'format=yuv420p',
  ].filter(Boolean).join(',');
  await runFfmpeg(
    [
      '-y',
      '-framerate', String(quote.fps),
      '-start_number', '1',
      '-i', resolve(framesDir, 'f_%05d.jpg'),
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-map', '0:v', '-map', '1:a',
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', '-shortest',
      outPath,
    ],
    {
      signal: ctx.signal,
      totalDurationSec: quote.durationSec,
      onProgress: (p) => ctx.progress('render', 0.8 + p * 0.18),
    },
  );

  // the punch always lands by ~3.2s regardless of quote length — grab the
  // thumbnail comfortably after that, while it's still well inside the hold.
  await ffmpegOnce(
    ['-y', '-ss', String(Math.min(4.5, quote.durationSec * 0.6)), '-i', outPath, '-frames:v', '1', '-q:v', '3', thumbPath],
    ctx.signal,
  );
  const probe = await ffprobe(outPath);
  log.ok(`reminders — "${quote.tag}" (${probe.durationSec.toFixed(1)}s, seed ${quote.seed})`);

  try {
    rmSync(framesDir, { recursive: true, force: true });
  } catch {
    /* not fatal */
  }

  return {
    render: {
      videoPath: outPath,
      thumbPath,
      durationSec: probe.durationSec,
      width: probe.width,
      height: probe.height,
    },
    quote,
  };
}

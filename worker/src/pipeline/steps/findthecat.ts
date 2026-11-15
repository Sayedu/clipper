import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { paths } from '../../paths.ts';
import { log } from '../../lib/log.ts';
import { run, stream } from '../../lib/exec.ts';
import { runPython } from '../../lib/python.ts';
import { FFMPEG, ffmpegOnce, ffprobe, runFfmpeg } from '../ffmpeg.ts';
import type { StepContext } from '../context.ts';
import type { RenderResult } from './render.ts';

export interface FindTheCatResult {
  seed: number;
  roundCount: number;
  /** Each round's cup count, in order (easy/medium/hard escalation). */
  cups: number[];
  /** Each round's difficulty, in order. */
  difficulty: string[];
  theme: string;
  /** The winning cup per round, 1-indexed — the answer key. */
  answers: number[];
  durationSec: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  frameWidth: number;
  frameHeight: number;
  ss: number;
}

/**
 * 'Find The Cat' — the "Follow The Ball" alt-variant: the same shell-game
 * mechanic, ported from the design_handoff_find_the_cat handoff, but the
 * ball is a cat-face "ball". A real multi-round game like classic Follow
 * The Ball: the user picks how many rounds (always starting at round 1),
 * and difficulty escalates by round index inside game.js itself (easy,
 * medium, hard, hard, ...). Driven headlessly frame-by-frame in Chrome,
 * same as Follow The Ball classic. Soundtrack is a swoosh per swap, a tick
 * per countdown beat, and a pop + the real cat-laugh-meme-1.wav clip on
 * each round's reveal.
 */
export async function runFindTheCat(ctx: StepContext): Promise<{ render: RenderResult; game: FindTheCatResult }> {
  const framesDir = ctx.file('ftcframes');
  mkdirSync(framesDir, { recursive: true });
  const resultPath = ctx.file('findthecat.json');

  // preview studio pins an exact seed so "render this" reproduces what was previewed
  const pinned = ctx.settings.findTheCatSeed;
  const seed = pinned && pinned > 0 ? Math.floor(pinned) : randomInt(1, 2_000_000_000);
  const fps = 60;
  const rounds = ctx.settings.findTheCatRounds ?? 3;
  const theme = ctx.settings.findTheCatTheme ?? 'candy';

  ctx.setStep('render', 'running', { detail: `${rounds} round(s) · shuffling the cups` });
  const renderScript = resolve(paths.repoRoot, 'scripts', 'findthecat', 'render.mjs');
  if (!existsSync(renderScript)) throw new Error(`find-the-cat renderer missing: ${renderScript}`);

  await stream(
    process.execPath,
    [
      renderScript,
      '--seed', String(seed),
      '--rounds', String(rounds),
      '--theme', theme,
      '--fps', String(fps),
      '--out-frames', framesDir,
      '--out', resultPath,
    ],
    {
      signal: ctx.signal,
      cwd: paths.repoRoot,
      onStderr: (line) => {
        if (line.startsWith('@progress ')) {
          try {
            const { pct, msg } = JSON.parse(line.slice('@progress '.length)) as { pct: number; msg: string };
            ctx.progress('render', pct * 0.7, msg ?? '');
            return;
          } catch {
            /* fall through */
          }
        }
        ctx.log('render', line);
      },
    },
  );

  if (!existsSync(resultPath)) throw new Error('find the cat produced no result');
  const game = JSON.parse(readFileSync(resultPath, 'utf8')) as FindTheCatResult;
  ctx.log('render', `${game.roundCount} round(s) · answers ${game.answers.join(' ')} (seed ${game.seed})`);

  // ---- audio: a swoosh per swap, a tick per countdown beat, a pop + the real
  //      cat-laugh-meme-1.wav clip on reveal (see findthecat_audio.py)
  ctx.progress('render', 0.74, 'scoring the sound');
  const audioRaw = ctx.file('findthecat_audio.wav');
  await runPython('findthecat_audio.py', {
    args: [
      '--events', resolve(framesDir, 'events.json'),
      '--duration', String(game.durationSec),
      '--out', audioRaw,
    ],
    signal: ctx.signal,
    onProgress: (p, m) => ctx.progress('render', 0.74 + p * 0.04, m),
    onLog: (l) => ctx.log('render', l),
  });

  // gentle two-pass loudnorm — present and satisfying, never loud
  ctx.progress('render', 0.8, 'balancing the sound');
  const audio = ctx.file('findthecat_audio_final.wav');
  const comp = 'highpass=f=60,acompressor=threshold=-22dB:ratio=3:attack=8:release=200';
  const measure = await run(
    FFMPEG,
    ['-hide_banner', '-i', audioRaw, '-af', `${comp},loudnorm=I=-20:TP=-2:LRA=9:print_format=json`, '-f', 'null', '-'],
    { signal: ctx.signal },
  ).catch(() => null);
  let ln = 'loudnorm=I=-20:TP=-2:LRA=9';
  const m = measure?.stderr.match(/\{[\s\S]*?\}/g)?.at(-1);
  if (m) {
    try {
      const j = JSON.parse(m) as Record<string, string>;
      ln = `loudnorm=I=-20:TP=-2:LRA=9:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
    } catch {
      /* single-pass */
    }
  }
  await runFfmpeg(
    ['-y', '-i', audioRaw, '-af', `${comp},${ln},alimiter=limit=0.9`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', audio],
    { signal: ctx.signal },
  );

  // ---- mux the frame sequence + audio → a sharp 4K (2160×3840) 9:16 mp4
  ctx.progress('render', 0.86, 'compositing 4K');
  const outPath = ctx.file('final.0.mp4');
  const thumbPath = ctx.file('thumb.0.jpg');
  const needsScale = game.frameWidth !== game.width || game.frameHeight !== game.height;
  const vf = [
    needsScale ? `scale=${game.width}:${game.height}:flags=lanczos+accurate_rnd+full_chroma_int` : null,
    'unsharp=3:3:0.3:3:3:0.0',
    'format=yuv420p',
  ].filter(Boolean).join(',');
  await runFfmpeg(
    [
      '-y',
      '-framerate', String(game.fps),
      '-start_number', '1',
      '-i', resolve(framesDir, 'f_%05d.png'),
      '-i', audio,
      '-map', '0:v', '-map', '1:a',
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '17',
      '-x264-params', 'aq-mode=3:aq-strength=0.8',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-shortest',
      outPath,
    ],
    {
      signal: ctx.signal,
      totalDurationSec: game.durationSec,
      onProgress: (p) => ctx.progress('render', 0.86 + p * 0.12),
    },
  );

  // thumbnail mid-shuffle (not the reveal) — curiosity, not a spoiler
  await ffmpegOnce(
    ['-y', '-ss', String(Math.min(game.durationSec * 0.4, 8)), '-i', outPath, '-frames:v', '1', '-q:v', '3', thumbPath],
    ctx.signal,
  );
  const probe = await ffprobe(outPath);
  log.ok(`find the cat — ${game.roundCount} round(s) — answers ${game.answers.join(' ')} (${probe.durationSec.toFixed(1)}s, seed ${game.seed})`);

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
    game,
  };
}

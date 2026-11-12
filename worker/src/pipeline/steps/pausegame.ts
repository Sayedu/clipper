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

export interface PauseGameResult {
  seed: number;
  /** Win-zone width in degrees (5-30). Smaller = harder. */
  targetDeg: number;
  /** Milliseconds for one full 360deg sweep (600-2500). Smaller = faster. */
  rotationMs: number;
  /** Full rotations before the clip ends — engineered to land exactly back
   *  on frame 0's angle, so the finished mp4 loops seamlessly on TikTok's
   *  native replay. */
  laps: number;
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
 * 'Pause game' — a single neon needle sweeps a dial forever at a fixed
 * speed; a thin green win-margin sits fixed at 12 o'clock. The needle's own
 * color IS the feedback: it glows a seed-picked neon accent everywhere
 * except the instant it's inside the win zone, where it snaps to green.
 * There's no tap/pause logic in the clip itself — the viewer uses TikTok's
 * own native pause control on the posted video, and whichever color the
 * needle is frozen on tells them if they caught it. Zero randomness in the
 * physics (pure time → angle); the seed only picks the accent color, so
 * every post looks like a different video by palette alone. A faithful
 * browser render of that design, driven headlessly frame-by-frame in Chrome
 * (deterministic, seeded), 4K / 60fps. Soundtrack is a soft chime synthesised
 * each time the needle enters the zone. No source video, no LLM.
 */
export async function runPauseGame(ctx: StepContext): Promise<{ render: RenderResult; game: PauseGameResult }> {
  const framesDir = ctx.file('pgframes');
  mkdirSync(framesDir, { recursive: true });
  const resultPath = ctx.file('pausegame.json');

  // preview studio pins an exact seed so "render this" reproduces what was previewed
  const pinned = ctx.settings.pauseGameSeed;
  const seed = pinned && pinned > 0 ? Math.floor(pinned) : randomInt(1, 2_000_000_000);
  const fps = 60;
  const targetDeg = Math.max(5, Math.min(30, Math.round(ctx.settings.pauseGameTargetDeg ?? 9)));
  const rotationMs = Math.max(600, Math.min(2500, Math.round(ctx.settings.pauseGameRotationMs ?? 1100)));
  const laps = Math.max(4, Math.min(20, Math.round(ctx.settings.pauseGameLaps ?? 10)));

  ctx.setStep('render', 'running', { detail: `${targetDeg}° target · ${rotationMs}ms/rotation · ${laps} laps` });
  const renderScript = resolve(paths.repoRoot, 'scripts', 'pausegame', 'render.mjs');
  if (!existsSync(renderScript)) throw new Error(`pause-game renderer missing: ${renderScript}`);

  await stream(
    process.execPath,
    [
      renderScript,
      '--seed', String(seed),
      '--target', String(targetDeg),
      '--rotation', String(rotationMs),
      '--laps', String(laps),
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

  if (!existsSync(resultPath)) throw new Error('pause game produced no result');
  const game = JSON.parse(readFileSync(resultPath, 'utf8')) as PauseGameResult;
  ctx.log('render', `${game.targetDeg}° target · ${game.rotationMs}ms/rotation · ${game.laps} laps (seed ${game.seed})`);

  // ---- audio: a soft chime synthesised each time the needle enters the zone
  ctx.progress('render', 0.74, 'scoring the sound');
  const audioRaw = ctx.file('pausegame_audio.wav');
  await runPython('pausegame_audio.py', {
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
  const audio = ctx.file('pausegame_audio_final.wav');
  const comp = 'highpass=f=80,acompressor=threshold=-22dB:ratio=3:attack=8:release=200';
  const measure = await run(
    FFMPEG,
    ['-hide_banner', '-i', audioRaw, '-af', `${comp},loudnorm=I=-21:TP=-2.5:LRA=8:print_format=json`, '-f', 'null', '-'],
    { signal: ctx.signal },
  ).catch(() => null);
  let ln = 'loudnorm=I=-21:TP=-2.5:LRA=8';
  const m = measure?.stderr.match(/\{[\s\S]*?\}/g)?.at(-1);
  if (m) {
    try {
      const j = JSON.parse(m) as Record<string, string>;
      ln = `loudnorm=I=-21:TP=-2.5:LRA=8:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
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
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
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

  await ffmpegOnce(
    ['-y', '-ss', String(Math.min(game.durationSec * 0.3, 3)), '-i', outPath, '-frames:v', '1', '-q:v', '3', thumbPath],
    ctx.signal,
  );
  const probe = await ffprobe(outPath);
  log.ok(`pause game — ${game.targetDeg}° target, ${game.rotationMs}ms/rotation, ${game.laps} laps (${probe.durationSec.toFixed(1)}s, seed ${game.seed})`);

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

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

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

export interface RaceResult {
  seed: number;
  map: string;
  mapName: string;
  winner: string;
  winnerRgb: [number, number, number];
  colors: string[];
  order: string[];
  winAtSec: number;
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
 * 'Color race' (Marble Rush) — a "which colour wins?" marble race down one of five
 * hand-built neon courses. A faithful browser render of the Marble Rush design,
 * driven headlessly frame-by-frame in Chrome (deterministic, seeded), at 4K / 60fps.
 * A soundtrack is synthesised from the physics event log and muxed to a 9:16 mp4.
 * No source video, no LLM — a brand-new course + winner every run.
 */
export async function runColorRace(ctx: StepContext): Promise<{ render: RenderResult; race: RaceResult }> {
  const framesDir = ctx.file('crframes');
  mkdirSync(framesDir, { recursive: true });
  const resultPath = ctx.file('colorrace.json');

  const seed = randomInt(1, 2_000_000_000);
  const fps = 60;
  const map = ctx.settings.colorRaceMap ?? 'random';
  const balls = clamp(ctx.settings.colorRaceBalls, 3, 6);
  const target = clamp(ctx.settings.colorRaceTargetSec, 12, 60);
  const shape = ctx.settings.colorRaceShape === 'square' ? 'square' : 'circle';

  ctx.setStep('render', 'running', {
    detail: map === 'random' ? `picking a course · ${balls} marbles · running the race` : `${map} · ${balls} marbles · running the race`,
  });
  const renderScript = resolve(paths.repoRoot, 'scripts', 'colorrace', 'render.mjs');
  if (!existsSync(renderScript)) throw new Error(`color-race renderer missing: ${renderScript}`);

  await stream(
    process.execPath,
    [
      renderScript,
      '--seed', String(seed),
      '--map', map,
      '--balls', String(balls),
      '--shape', shape,
      '--sec', String(target),
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

  if (!existsSync(resultPath)) throw new Error('color race produced no result');
  const race = JSON.parse(readFileSync(resultPath, 'utf8')) as RaceResult;
  ctx.log('render', `${race.mapName}: ${race.colors.join(' vs ')} → ${race.winner} wins at ${race.winAtSec}s (seed ${race.seed})`);

  // ---- audio: music-box bounces + boost/mud whooshes + a winner arpeggio
  ctx.progress('render', 0.74, 'synthesising the sound');
  const audioRaw = ctx.file('colorrace_audio.wav');
  await runPython('colorrace_audio.py', {
    args: [
      '--events', resolve(framesDir, 'events.json'),
      '--duration', String(race.durationSec),
      '--out', audioRaw,
    ],
    signal: ctx.signal,
    onProgress: (p, m) => ctx.progress('render', 0.74 + p * 0.04, m),
    onLog: (l) => ctx.log('render', l),
  });

  // gentle two-pass loudnorm — present and satisfying, never loud
  ctx.progress('render', 0.8, 'balancing the sound');
  const audio = ctx.file('colorrace_audio_final.wav');
  const comp = 'highpass=f=68,acompressor=threshold=-22dB:ratio=3:attack=8:release=200';
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
    ['-y', '-i', audioRaw, '-af', `${comp},${ln},alimiter=limit=0.8`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', audio],
    { signal: ctx.signal },
  );

  // ---- mux the frame sequence + audio → a sharp 4K (2160×3840) 9:16 mp4
  ctx.progress('render', 0.86, 'compositing 4K');
  const outPath = ctx.file('final.0.mp4');
  const thumbPath = ctx.file('thumb.0.jpg');
  const needsScale = race.frameWidth !== race.width || race.frameHeight !== race.height;
  const vf = [
    needsScale ? `scale=${race.width}:${race.height}:flags=lanczos+accurate_rnd+full_chroma_int` : null,
    'unsharp=5:5:0.5:5:5:0.0',
    'format=yuv420p',
  ].filter(Boolean).join(',');
  await runFfmpeg(
    [
      '-y',
      '-framerate', String(race.fps),
      '-start_number', '1',
      '-i', resolve(framesDir, 'f_%05d.jpg'),
      '-i', audio,
      '-map', '0:v', '-map', '1:a',
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-x264-params', 'aq-mode=3:aq-strength=0.9',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-shortest',
      outPath,
    ],
    {
      signal: ctx.signal,
      totalDurationSec: race.durationSec,
      onProgress: (p) => ctx.progress('render', 0.86 + p * 0.12),
    },
  );

  await ffmpegOnce(
    ['-y', '-ss', String(Math.min(race.winAtSec * 0.5, 5)), '-i', outPath, '-frames:v', '1', '-q:v', '3', thumbPath],
    ctx.signal,
  );
  const probe = await ffprobe(outPath);
  log.ok(`color race — ${race.mapName} — ${race.winner} wins (${probe.durationSec.toFixed(1)}s, seed ${race.seed})`);

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
    race,
  };
}

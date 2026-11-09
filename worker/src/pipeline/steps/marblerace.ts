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

export interface MarbleRaceResult {
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
}

/**
 * '3D marble race' — a wooden marble run rendered headlessly with Three.js +
 * Rapier physics (scripts/marblerace/render.mjs drives Chrome), then a rolling +
 * knock soundtrack synthesised from the physics event log, muxed to a 9:16 mp4.
 * No source video, no LLM. A brand-new course and winner every run.
 */
export async function runMarbleRace(
  ctx: StepContext,
): Promise<{ render: RenderResult; race: MarbleRaceResult }> {
  const framesDir = ctx.file('mrframes');
  mkdirSync(framesDir, { recursive: true });
  const resultPath = ctx.file('marblerace.json');

  const seed = randomInt(1, 2_000_000_000);
  const fps = 30;
  const marbles = clamp(ctx.settings.marbleRaceMarbles, 3, 6);
  const target = clamp(ctx.settings.marbleRaceTargetSec, 12, 60);

  ctx.setStep('render', 'running', { detail: 'building a new course + running the physics' });
  const renderScript = resolve(paths.repoRoot, 'scripts', 'marblerace', 'render.mjs');
  if (!existsSync(renderScript)) throw new Error(`marble-race renderer missing: ${renderScript}`);

  await stream(
    process.execPath,
    [
      renderScript,
      '--seed', String(seed),
      '--marbles', String(marbles),
      '--target', String(target),
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

  if (!existsSync(resultPath)) throw new Error('marble race produced no result');
  const race = JSON.parse(readFileSync(resultPath, 'utf8')) as MarbleRaceResult;
  ctx.log(
    'render',
    `race: ${race.colors.join(' vs ')} → ${race.winner} wins at ${race.winAtSec}s (seed ${race.seed})`,
  );

  // ---- audio: rolling bed + knocks from the physics event log (no music)
  ctx.progress('render', 0.74, 'synthesising the sound');
  const audioRaw = ctx.file('marblerace_audio.wav');
  await runPython('marblerace_audio.py', {
    args: [
      '--events', resolve(framesDir, 'events.json'),
      '--duration', String(race.durationSec),
      '--out', audioRaw,
    ],
    signal: ctx.signal,
    onLog: (l) => ctx.log('render', l),
  });

  // gentle two-pass loudnorm to a quiet −22 LUFS — SFX should never be loud
  ctx.progress('render', 0.8, 'balancing the sound');
  const audio = ctx.file('marblerace_audio_final.wav');
  const pre = 'highpass=f=32,acompressor=threshold=-20dB:ratio=3:attack=6:release=180';
  const measure = await run(
    FFMPEG,
    ['-hide_banner', '-i', audioRaw, '-af', `${pre},loudnorm=I=-22:TP=-3:LRA=8:print_format=json`, '-f', 'null', '-'],
    { signal: ctx.signal },
  ).catch(() => null);
  let ln = 'loudnorm=I=-22:TP=-3:LRA=8';
  const m = measure?.stderr.match(/\{[\s\S]*?\}/g)?.at(-1);
  if (m) {
    try {
      const j = JSON.parse(m) as Record<string, string>;
      ln = `loudnorm=I=-22:TP=-3:LRA=8:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
    } catch {
      /* single-pass */
    }
  }
  await runFfmpeg(
    ['-y', '-i', audioRaw, '-af', `${pre},${ln},alimiter=limit=0.82`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', audio],
    { signal: ctx.signal },
  );

  // ---- mux the frame sequence + audio → 9:16 mp4
  ctx.progress('render', 0.86, 'compositing');
  const outPath = ctx.file('final.0.mp4');
  const thumbPath = ctx.file('thumb.0.jpg');
  await runFfmpeg(
    [
      '-y',
      '-framerate', String(race.fps),
      '-start_number', '1',
      '-i', resolve(framesDir, 'f_%05d.jpg'),
      '-i', audio,
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest',
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
  log.ok(`marble race — ${race.winner} wins (${probe.durationSec.toFixed(1)}s, seed ${race.seed})`);

  // the ~500 JPEG frames are baked into the mp4 now — reclaim the disk
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

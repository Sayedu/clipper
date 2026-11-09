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

export interface LaserNationsResult {
  seed: number;
  map: string;
  mapName: string;
  /** Winning nation, e.g. "Japan". */
  winner: string;
  winnerHue: number;
  winnerRgb: [number, number, number];
  /** The four nations in play. */
  colors: string[];
  countries: string[];
  winAtSec: number;
  durationSec: number;
  blackHole: boolean;
  /** Winner's final score (territory held over time + cut bonuses; only ever climbs). */
  score: number;
  scores: number[];
  cuts: number;
  kills: number;
  tag: string;
  frames: number;
  fps: number;
  width: number;
  height: number;
  /** On-disk frame size (supersampled); ffmpeg downscales it to width×height. */
  frameWidth: number;
  frameHeight: number;
  ss: number;
}

/**
 * 'Laser Nations' — a neon "territory capture" sim. Four flagged balls bounce
 * around a widening arena leaving glowing laser trails; driving through an enemy
 * trail snaps it, the pace steps up every 5s, and the nation holding the most
 * territory when the clock runs out wins (optionally: a black-hole sudden-death
 * finish). Rendered headlessly frame-by-frame in Chrome (deterministic, seeded),
 * then a soundtrack synthesised from the sim's event log and muxed to a 9:16 mp4.
 * No source video, no LLM — a brand-new run and winner every time.
 */
export async function runLaserNations(
  ctx: StepContext,
): Promise<{ render: RenderResult; race: LaserNationsResult }> {
  const framesDir = ctx.file('lnframes');
  mkdirSync(framesDir, { recursive: true });
  const resultPath = ctx.file('lasernations.json');

  const seed = randomInt(1, 2_000_000_000);
  const fps = 60; // match the live game's motion smoothness
  const sec = clamp(ctx.settings.laserNationsMatchSec, 35, 65);
  const blackHole = Boolean(ctx.settings.laserNationsBlackHole);

  ctx.setStep('render', 'running', {
    detail: `${sec}s match${blackHole ? ' · black-hole finish' : ''} · running the sim`,
  });
  const renderScript = resolve(paths.repoRoot, 'scripts', 'lasernations', 'render.mjs');
  if (!existsSync(renderScript)) throw new Error(`laser-nations renderer missing: ${renderScript}`);

  await stream(
    process.execPath,
    [
      renderScript,
      '--seed', String(seed),
      '--sec', String(sec),
      '--bh', blackHole ? '1' : '0',
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

  if (!existsSync(resultPath)) throw new Error('laser nations produced no result');
  const race = JSON.parse(readFileSync(resultPath, 'utf8')) as LaserNationsResult;
  ctx.log(
    'render',
    `${race.countries.join(' · ')} → ${race.winner} wins on ${race.score.toLocaleString()} (seed ${race.seed})`,
  );

  // ---- audio: transients synthesised from the sim event log (no music bed)
  ctx.progress('render', 0.74, 'synthesising the sound');
  const audioRaw = ctx.file('lasernations_audio.wav');
  await runPython('lasernations_audio.py', {
    args: [
      '--events', resolve(framesDir, 'events.json'),
      '--duration', String(race.durationSec),
      '--out', audioRaw,
    ],
    signal: ctx.signal,
    onProgress: (p, m) => ctx.progress('render', 0.74 + p * 0.04, m),
    onLog: (l) => ctx.log('render', l),
  });

  // two-pass loudnorm — quiet and soft (SFX should sit under, never jump out),
  // with a de-esser-ish shelf so dense stretches never get harsh
  ctx.progress('render', 0.8, 'balancing the sound');
  const audio = ctx.file('lasernations_audio_final.wav');
  const comp = 'highpass=f=70,acompressor=threshold=-24dB:ratio=3.2:attack=12:release=260,treble=g=-3:f=5500:width_type=q:w=0.7';
  const measure = await run(
    FFMPEG,
    ['-hide_banner', '-i', audioRaw, '-af', `${comp},loudnorm=I=-24.5:TP=-3.5:LRA=10:print_format=json`, '-f', 'null', '-'],
    { signal: ctx.signal },
  ).catch(() => null);
  let ln = 'loudnorm=I=-24.5:TP=-3.5:LRA=10';
  const m = measure?.stderr.match(/\{[\s\S]*?\}/g)?.at(-1);
  if (m) {
    try {
      const j = JSON.parse(m) as Record<string, string>;
      ln = `loudnorm=I=-24.5:TP=-3.5:LRA=10:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
    } catch {
      /* single-pass */
    }
  }
  await runFfmpeg(
    ['-y', '-i', audioRaw, '-af', `${comp},${ln},alimiter=limit=0.7`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', audio],
    { signal: ctx.signal },
  );

  // ---- mux the frame sequence + audio → a sharp 4K (2160×3840) 9:16 mp4
  // The frames are supersampled (frameWidth×frameHeight, e.g. 3240×5760); the
  // lanczos downscale to width×height (2160×3840) IS the anti-aliasing, then a
  // light unsharp for game-crisp edges.
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
    ['-y', '-ss', String(Math.min(race.winAtSec * 0.5, 6)), '-i', outPath, '-frames:v', '1', '-q:v', '3', thumbPath],
    ctx.signal,
  );
  const probe = await ffprobe(outPath);
  log.ok(`laser nations — ${race.winner} wins (${probe.durationSec.toFixed(1)}s, seed ${race.seed})`);

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

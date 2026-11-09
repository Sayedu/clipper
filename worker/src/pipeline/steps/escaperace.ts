import { randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { paths } from '../../paths.ts';
import { log } from '../../lib/log.ts';
import { runPython } from '../../lib/python.ts';
import { run } from '../../lib/exec.ts';
import { FFMPEG, ffmpegOnce, ffprobe, runFfmpeg } from '../ffmpeg.ts';
import type { StepContext } from '../context.ts';
import type { RenderResult } from './render.ts';

export interface EscapeRaceResult {
  seed: number;
  map: string;
  mapName: string;
  winner: string;
  winnerRgb: [number, number, number];
  colors: string[];
  winAtSec: number;
  durationSec: number;
  rings: number;
  events: number;
}

/**
 * "Which colour escapes first?" — a fresh ring-escape race every run. Coloured
 * balls start caged in the centre of a stack of spinning neon rings; each ball
 * climbs outward one ring at a time through a rotating gap, and the first to
 * clear the outermost ring wins. `escaperace.py` runs the (seeded, deterministic)
 * sim, renders the full video (rings + HUD + countdown + winner card) and the
 * synthesised bounce/boom audio; here we just loudness-normalise and mux.
 */
export async function runEscapeRace(
  ctx: StepContext,
): Promise<{ render: RenderResult; race: EscapeRaceResult }> {
  const videoRaw = ctx.file('escape.mp4');
  const audioRaw = ctx.file('escape.wav');
  const resultPath = ctx.file('escape.json');

  // fresh random seed every run → a brand-new race + winner every time
  const seed = randomInt(1, 2_000_000_000);
  const balls = Math.max(3, Math.min(6, ctx.settings.escapeRaceBalls));
  const rings = Math.max(3, Math.min(14, ctx.settings.escapeRaceRings));
  const target = Math.max(12, Math.min(45, ctx.settings.escapeRaceTargetSec));
  ctx.setStep('render', 'running', { detail: `${rings} rings · ${balls} balls · running the race` });

  const stdout = await runPython('escaperace.py', {
    args: [
      '--seed', String(seed),
      '--balls', String(balls),
      '--rings', String(rings),
      '--target', String(target),
      '--fonts-dir', paths.fonts,
      '--ffmpeg', FFMPEG,
      '--out-video', videoRaw,
      '--out-audio', audioRaw,
      '--out', resultPath,
    ],
    signal: ctx.signal,
    onProgress: (p, m) => ctx.progress('render', p * 0.86, m),
    onLog: (l) => ctx.log('render', l),
  });
  const race = JSON.parse(
    existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : stdout.trim().split('\n').filter(Boolean).at(-1)!,
  ) as EscapeRaceResult;
  if (!existsSync(videoRaw) || !existsSync(audioRaw)) throw new Error('escaperace produced no media');
  ctx.log(
    'render',
    `${race.mapName}: ${race.colors.join(' vs ')} → ${race.winner} escapes first at ${race.winAtSec}s (seed ${race.seed})`,
  );

  // gentle loudness — present and warm, never loud (same chain as the colour race)
  ctx.progress('render', 0.88, 'balancing the sound');
  const audio = ctx.file('escape_final.wav');
  const comp = 'highpass=f=68,acompressor=threshold=-22dB:ratio=3:attack=8:release=200';
  const measure = await run(
    FFMPEG,
    ['-hide_banner', '-i', audioRaw, '-af', `${comp},loudnorm=I=-21:TP=-2.5:LRA=8:print_format=json`, '-f', 'null', '-'],
    { signal: ctx.signal },
  ).catch(() => null);
  const m = measure?.stderr.match(/\{[\s\S]*?\}/g)?.at(-1);
  let ln = 'loudnorm=I=-21:TP=-2.5:LRA=8';
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

  // the Python side already burned every text element in — this is just a mux
  ctx.progress('render', 0.92, 'muxing');
  const outPath = ctx.file('final.0.mp4');
  const thumbPath = ctx.file('thumb.0.jpg');
  await runFfmpeg(
    [
      '-y',
      '-i', videoRaw,
      '-i', audio,
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest',
      outPath,
    ],
    { signal: ctx.signal, totalDurationSec: race.durationSec, onProgress: (p) => ctx.progress('render', 0.92 + p * 0.06) },
  );

  await ffmpegOnce(['-y', '-ss', String(Math.min(race.winAtSec * 0.5, 6)), '-i', outPath, '-frames:v', '1', '-q:v', '3', thumbPath]);
  const probe = await ffprobe(outPath);
  log.ok(`escape race — ${race.mapName} — ${race.winner} escapes first (${probe.durationSec.toFixed(1)}s)`);
  return {
    render: { videoPath: outPath, thumbPath, durationSec: probe.durationSec, width: probe.width, height: probe.height },
    race,
  };
}

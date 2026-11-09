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

export interface ColorWarResult {
  seed: number;
  mode: string;
  modeName: string;
  winner: string;
  winnerRgb: [number, number, number];
  colors: string[];
  order: string[];
  winAtSec: number;
  durationSec: number;
  frames: number;
  fps: number;
  winnerPct: number;
  width: number;
  height: number;
  /** On-disk frame size; ffmpeg lanczos-downscales it to width×height when larger. */
  frameWidth: number;
  frameHeight: number;
  ss: number;
  // close-game/comeback telemetry (Season Mode's seed search verifies these
  // BEFORE this render ever runs — they're carried through here only so
  // run.ts can source the "COMEBACK!" caption line without re-deriving it).
  wonCleanly: boolean;
  closestMarginDuelPct: number;
  deepestDipDuringDuelPct: number;
  isThriller: boolean;
  isComeback: boolean;
}

/**
 * 'Color war' — four colours fight for grid territory: a ball paints a band every
 * time it strikes an enemy cell, paint-bomb pickups blow a hole in the map, and a
 * colour that gets squeezed under a threshold is wiped out. Last one alive wins.
 * A faithful browser render of the Color War design, driven headlessly
 * frame-by-frame in Chrome (deterministic, seeded), 4K / 60fps. Soundtrack is
 * synthesised from the flip/bomb/death event log and muxed to a 9:16 mp4.
 * No source video, no LLM — a brand-new board + winner every run.
 */
export async function runColorWar(ctx: StepContext): Promise<{ render: RenderResult; race: ColorWarResult }> {
  const framesDir = ctx.file('cwframes');
  mkdirSync(framesDir, { recursive: true });
  const resultPath = ctx.file('colorwar.json');

  // preview studio pins an exact seed so "render this" reproduces what was previewed
  const pinned = ctx.settings.colorWarSeed;
  const seed = pinned && pinned > 0 ? Math.floor(pinned) : randomInt(1, 2_000_000_000);
  const fps = 60;
  const mode = ctx.settings.colorWarMode ?? 'classic';
  const shape = ctx.settings.colorWarShape === 'square' ? 'square' : 'circle';
  const flipSound = ctx.settings.colorWarFlipSound === 'pluck' ? 'pluck' : 'bubble';
  // SPRINT self-terminates ~16 s; the other boards are the ~45 s format (a ~17 s
  // final-two battle → most land 43-46 s; a rare 4-way drag or a stalemated duel
  // that hits the overtime fallback → ~50-53 s). This is a SAFETY ceiling only —
  // passed as --sec it force-ends the sim — so it must sit ABOVE the natural
  // length, never at it, or the battle gets truncated.
  const capSec = mode === 'sprint' ? 24 : 66;

  // Season Mode display settings (intro card, score chips, outro badge) — see
  // render/colorwar/game.js's SEASON_MODE block. Purely visual: the OUTCOME
  // was already decided by which seed got pinned above, via the season's
  // seed search (worker/src/colorwarSeason.ts) — none of this affects the sim.
  const seasonArgs: string[] = [];
  if (ctx.settings.colorWarSeasonNumber && ctx.settings.colorWarEpisodeIndex) {
    seasonArgs.push(
      '--season', String(ctx.settings.colorWarSeasonNumber),
      '--episode', String(ctx.settings.colorWarEpisodeIndex),
      '--totalEpisodes', String(ctx.settings.colorWarTotalEpisodes ?? 1),
      '--scoresBefore', (ctx.settings.colorWarScoresBefore ?? [0, 0, 0, 0]).join(','),
    );
  }

  ctx.setStep('render', 'running', {
    detail: mode === 'random' ? `picking a board · running the war` : `${mode} · running the war`,
  });
  const renderScript = resolve(paths.repoRoot, 'scripts', 'colorwar', 'render.mjs');
  if (!existsSync(renderScript)) throw new Error(`color-war renderer missing: ${renderScript}`);

  await stream(
    process.execPath,
    [
      renderScript,
      '--seed', String(seed),
      '--mode', mode,
      '--shape', shape,
      '--flipsound', flipSound,
      '--sec', String(capSec),
      '--fps', String(fps),
      '--out-frames', framesDir,
      '--out', resultPath,
      ...seasonArgs,
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

  if (!existsSync(resultPath)) throw new Error('color war produced no result');
  const race = JSON.parse(readFileSync(resultPath, 'utf8')) as ColorWarResult;
  ctx.log('render', `${race.modeName}: ${race.colors.join(' vs ')} → ${race.winner} wins at ${race.winAtSec}s (seed ${race.seed})`);

  // ---- audio: an exact offline rebuild of the design's Web Audio graph
  //      (SPEC §11) from the event log — flip ladder, bomb + duck, death, win
  ctx.progress('render', 0.74, 'scoring the sound');
  const audioRaw = ctx.file('colorwar_audio.wav');
  await runPython('colorwar_audio.py', {
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
  const audio = ctx.file('colorwar_audio_final.wav');
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
    // gentle edge sharpen — the game is drawn oversampled then shown in a smaller
    // safe box, so it arrives a touch soft; small radius + low amount lifts the
    // grid lines and ball edges without haloing the flat colour blocks. Frames
    // are lossless PNG so there are no compression artefacts to amplify.
    'unsharp=3:3:0.32:3:3:0.0',
    'format=yuv420p',
  ].filter(Boolean).join(',');
  await runFfmpeg(
    [
      '-y',
      '-framerate', String(race.fps),
      '-start_number', '1',
      '-i', resolve(framesDir, 'f_%05d.png'),
      '-i', audio,
      '-map', '0:v', '-map', '1:a',
      '-vf', vf,
      // low CRF — flat block art is cheap to encode, so spend the bits on keeping
      // every tile edge and the 1px grid crisp. `fast` preset because the ss=3
      // capture + lanczos already makes this step the render's long pole and
      // flat-block art barely benefits from slower motion search.
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '17',
      '-x264-params', 'aq-mode=3:aq-strength=0.8',
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
  log.ok(`color war — ${race.modeName} — ${race.winner} wins (${probe.durationSec.toFixed(1)}s, seed ${race.seed})`);

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

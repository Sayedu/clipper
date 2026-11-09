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

export interface FollowBallResult {
  seed: number;
  mode: string;
  modeName: string;
  rounds: number;
  /** The correct cup (1-indexed) for each round — the answer key. */
  answers: number[];
  /** Cups per round. */
  cups: number[];
  /** Swaps per round — logged, never shown on screen (SPEC §7). */
  swapCounts: number[];
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
 * 'Follow the ball' — a shell-game ability test. The ball is shown under a cup,
 * the cups shuffle back-to-back, the correct cup lifts, and a score card lists
 * every round's answer so the viewer can self-score and comment a number. Three
 * modes (SPRINT default / CLASSIC / INSANE), fully rerolled per seed. A faithful
 * browser render of the Follow The Ball design, driven headlessly frame-by-frame
 * in Chrome (deterministic, seeded), 4K / 60fps. Soundtrack is synthesised from
 * the swap/reveal/tick/answer/finish event log and muxed to a 9:16 mp4. No
 * source video, no LLM.
 */
export async function runFollowBall(ctx: StepContext): Promise<{ render: RenderResult; game: FollowBallResult }> {
  const framesDir = ctx.file('fbframes');
  mkdirSync(framesDir, { recursive: true });
  const resultPath = ctx.file('followball.json');

  // preview studio pins an exact seed so "render this" reproduces what was previewed
  const pinned = ctx.settings.followBallSeed;
  const seed = pinned && pinned > 0 ? Math.floor(pinned) : randomInt(1, 2_000_000_000);
  const fps = 60;
  const mode = ctx.settings.followBallMode ?? 'sprint';
  // SPRINT self-terminates ~19 s; CLASSIC / INSANE ~42 s. Give the frame-cap
  // headroom (the game still self-terminates on the score card first).
  const capSec = mode === 'sprint' ? 26 : mode === 'random' ? 50 : 48;

  ctx.setStep('render', 'running', {
    detail: mode === 'random' ? `picking a mode · shuffling the cups` : `${mode} · shuffling the cups`,
  });
  const renderScript = resolve(paths.repoRoot, 'scripts', 'followball', 'render.mjs');
  if (!existsSync(renderScript)) throw new Error(`follow-the-ball renderer missing: ${renderScript}`);

  await stream(
    process.execPath,
    [
      renderScript,
      '--seed', String(seed),
      '--mode', mode,
      '--sec', String(capSec),
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

  if (!existsSync(resultPath)) throw new Error('follow the ball produced no result');
  const game = JSON.parse(readFileSync(resultPath, 'utf8')) as FollowBallResult;
  ctx.log('render', `${game.modeName}: ${game.rounds} rounds · answers ${game.answers.join(' ')} (seed ${game.seed})`);

  // ---- audio: an offline rebuild of the design's Web Audio graph (SPEC §6)
  //      from the event log — walking-pentatonic swap notes, reveal, tick, answer, finish
  ctx.progress('render', 0.74, 'scoring the sound');
  const audioRaw = ctx.file('followball_audio.wav');
  await runPython('followball_audio.py', {
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
  const audio = ctx.file('followball_audio_final.wav');
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
    // gentle edge sharpen — the game is drawn oversampled then shown in a smaller
    // safe box, so it arrives a touch soft; small radius + low amount lifts the
    // cup edges and slot numbers without haloing the flat field.
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

  await ffmpegOnce(
    ['-y', '-ss', String(Math.min(game.durationSec * 0.4, 6)), '-i', outPath, '-frames:v', '1', '-q:v', '3', thumbPath],
    ctx.signal,
  );
  const probe = await ffprobe(outPath);
  log.ok(`follow the ball — ${game.modeName} — ${game.rounds} rounds (${probe.durationSec.toFixed(1)}s, seed ${game.seed})`);

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

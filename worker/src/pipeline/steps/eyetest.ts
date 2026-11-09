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

export interface EyeTestResult {
  seed: number;
  /** Round count = ballsPerRound.length (1-6). */
  rounds: number;
  /** Ball count per round, in order (4-10 each). */
  ballsPerRound: number[];
  /** Seconds the real-physics shuffle phase runs, the same every round. */
  shuffleSec: number;
  /** The correct ball number (1-indexed, assigned left-to-right at freeze), one per round. */
  answers: number[];
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
 * 'Eye test' — the "Ghost Object Tracker" visual focus test. Each round: some
 * identical spheres sit in a circular arena; one flashes neon gold as the
 * target during a 3s lock-in countdown, then they all launch on random
 * headings for a timed shuffle — real elastic ball-ball collisions plus
 * circular-wall bounces while the arena itself slowly spins for
 * disorientation. Everything freezes instantly, numbers fade in on the
 * frozen spheres, and the true target re-flashes gold for that round's
 * reveal. Fully user-authored round plan (round count, balls per round,
 * shuffle length) rather than preset modes — a short score card lists every
 * round's answer at the end. Fully reproducible per seed. A faithful browser
 * render of that design, driven headlessly frame-by-frame in Chrome
 * (deterministic, seeded), 4K / 60fps. Soundtrack is synthesised from the
 * target-shown/lock/near-miss/freeze/reveal-fanfare/finish event log and
 * muxed to a 9:16 mp4. No source video, no LLM.
 */
export async function runEyeTest(ctx: StepContext): Promise<{ render: RenderResult; game: EyeTestResult }> {
  const framesDir = ctx.file('etframes');
  mkdirSync(framesDir, { recursive: true });
  const resultPath = ctx.file('eyetest.json');

  // preview studio pins an exact seed so "render this" reproduces what was previewed
  const pinned = ctx.settings.eyeTestSeed;
  const seed = pinned && pinned > 0 ? Math.floor(pinned) : randomInt(1, 2_000_000_000);
  const fps = 60;
  const ballsPerRound = (ctx.settings.eyeTestBallsPerRound?.length ? ctx.settings.eyeTestBallsPerRound : [8, 8, 8])
    .map((n) => Math.max(4, Math.min(10, Math.round(n))))
    .slice(0, 6);
  const shuffleSec = Math.max(3, Math.min(15, ctx.settings.eyeTestShuffleSec ?? 6));
  const ballsArg = ballsPerRound.join(',');
  // mirrors game.js's own estimateDurationSec(): 7.35s of fixed beats/round
  // (3s lock-in + 0.25s flash + 2.6s freeze-hold + 1.5s reveal-hold) plus the
  // shuffle, then a one-time 3.5s score card + 1s render-completion buffer.
  // The game still self-terminates on its own fixed timers first — this is
  // just frame-cap headroom.
  const capSec = Math.min(160, Math.ceil(ballsPerRound.length * (7.35 + shuffleSec) + 4.5) + 4);

  ctx.setStep('render', 'running', {
    detail: `${ballsPerRound.length} round${ballsPerRound.length > 1 ? 's' : ''} (${ballsArg} balls) · tracking the target`,
  });
  const renderScript = resolve(paths.repoRoot, 'scripts', 'eyetest', 'render.mjs');
  if (!existsSync(renderScript)) throw new Error(`eye-test renderer missing: ${renderScript}`);

  await stream(
    process.execPath,
    [
      renderScript,
      '--seed', String(seed),
      '--balls', ballsArg,
      '--shuffle', String(shuffleSec),
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

  if (!existsSync(resultPath)) throw new Error('eye test produced no result');
  const game = JSON.parse(readFileSync(resultPath, 'utf8')) as EyeTestResult;
  ctx.log('render', `${game.rounds} round(s) (${game.ballsPerRound.join(',')} balls) · answers ${game.answers.join(' ')} (seed ${game.seed})`);

  // ---- audio: an offline rebuild of the game's Web Audio voices from the
  //      event log — target-shown / lock / near-miss / freeze / reveal-fanfare / finish
  ctx.progress('render', 0.74, 'scoring the sound');
  const audioRaw = ctx.file('eyetest_audio.wav');
  await runPython('eyetest_audio.py', {
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
  const audio = ctx.file('eyetest_audio_final.wav');
  const comp = 'highpass=f=64,acompressor=threshold=-22dB:ratio=3:attack=8:release=200';
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
    // gentle edge sharpen — the game is drawn oversampled then shown in a smaller
    // safe box, so it arrives a touch soft.
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
  log.ok(`eye test — ${game.rounds} round(s) — answers ${game.answers.join(' ')} (${probe.durationSec.toFixed(1)}s, seed ${game.seed})`);

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

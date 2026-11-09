import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { paths } from '../../paths.ts';
import { log } from '../../lib/log.ts';
import { run, stream } from '../../lib/exec.ts';
import { runPython } from '../../lib/python.ts';
import { FFMPEG, ffmpegOnce, ffprobe, runFfmpeg } from '../ffmpeg.ts';
import { searchDuelSeed } from '../laserDuelSearch.ts';
import type { StepContext } from '../context.ts';
import type { RenderResult } from './render.ts';

export interface LaserDuelResult {
  seed: number;
  mode: 'duel';
  nationA: string;
  nationB: string;
  winner: string;
  loser: string;
  cause: string;   // 'ko' | 'decision' ('decision' only ever fires off the internal safety cap, not a real timer)
  hpA: number;
  hpB: number;
  maxHp: number;
  searchScore: number;
  usedFallback: boolean;
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
 * 'Laser Nations: Duel' — a 1v1 fight bolted onto the same engine as the
 * 4-way territory game (render/lasernations/game.js's stepDuel/renderDuel).
 * Two chosen (or random) nations, real health bars, direct clashes + an
 * always-spinning orbiting weapon, and pickup perks (heal / shield / rage /
 * haste). No timer — the fight ends when a fighter hits 0 hp, full stop. The winner
 * can be left to chance, or forced — but never by telling the sim who's
 * supposed to win: `searchDuelSeed()` runs the exact same unbiased duel
 * headlessly (no Chrome) under many random seeds and keeps whichever one
 * produced the requested outcome with a genuinely dramatic health curve
 * (real lead changes, a real comeback), the same trick this app's Color War
 * Season Mode already uses. A dedicated MMA-style "fight poster" frame (both
 * flags, VS, names) becomes the video's thumbnail instead of an arbitrary
 * mid-fight grab. Rendered headlessly, deterministic, 4K / 60fps.
 */
export async function runLaserDuel(ctx: StepContext): Promise<{ render: RenderResult; duel: LaserDuelResult }> {
  const framesDir = ctx.file('lnframes');
  mkdirSync(framesDir, { recursive: true });
  const resultPath = ctx.file('lasernations.json');

  const s = ctx.settings;
  const pinnedSeed = s.laserNationsSeed && s.laserNationsSeed > 0 ? Math.floor(s.laserNationsSeed) : 0;
  const winnerChoice = s.laserNationsDuelWinner ?? 'random';
  const fps = 60;

  let seed: number, searchScore = 0, usedFallback = false;
  let nationA = s.laserNationsDuelA || '', nationB = s.laserNationsDuelB || '';

  if (pinnedSeed) {
    // the preview studio pins an exact seed so "render this seed" reproduces
    // exactly what was previewed — no search needed (the live preview only
    // ever shows a genuinely random, unforced run in the first place; the
    // studio only offers this button when winner === 'random', for exactly
    // this reason).
    seed = pinnedSeed;
    ctx.setStep('render', 'running', { detail: `${nationA || 'a nation'} vs ${nationB || 'a nation'} · pinned seed` });
  } else {
    ctx.setStep('render', 'running', {
      detail: winnerChoice === 'random'
        ? 'searching for a close, dramatic fight'
        : `searching for a ${winnerChoice === 'A' ? (nationA || 'fighter A') : (nationB || 'fighter B')} comeback win`,
    });
    const found = await searchDuelSeed({ nationA, nationB, winner: winnerChoice, budget: 450 });
    seed = found.seed; nationA = found.nationA; nationB = found.nationB;
    searchScore = found.score; usedFallback = found.usedFallback;
    ctx.log('render', `search: seed ${seed} · ${nationA} vs ${nationB} · drama score ${found.score} (${found.attempts} attempt${found.attempts === 1 ? '' : 's'}${found.usedFallback ? ', fallback' : ''})`);
  }

  const renderScript = resolve(paths.repoRoot, 'scripts', 'lasernations', 'render.mjs');
  if (!existsSync(renderScript)) throw new Error(`laser-nations renderer missing: ${renderScript}`);

  // ---- fight poster: one static frame (both flags + VS), used as the thumbnail ----
  ctx.progress('render', 0.03, 'drawing the fight poster');
  const posterFrames = ctx.file('lnposter');
  mkdirSync(posterFrames, { recursive: true });
  const posterJson = ctx.file('lnposter.json');
  await stream(
    process.execPath,
    [renderScript, '--seed', String(seed), '--poster', '--duel', '--a', nationA, '--b', nationB,
      '--fps', '1', '--out-frames', posterFrames, '--out', posterJson, '--out-scale', '2', '--ss', '2'],
    { signal: ctx.signal, cwd: paths.repoRoot, onStderr: () => {} },
  );
  const thumbPath = ctx.file('thumb.0.jpg');
  try {
    const posterFile = resolve(posterFrames, 'f_00001.jpg');
    if (existsSync(posterFile)) {
      await ffmpegOnce(['-y', '-i', posterFile, '-q:v', '3', thumbPath], ctx.signal);
    }
  } catch {
    /* the mid-fight frame grab below still runs as a fallback */
  }

  // ---- the actual fight ----
  await stream(
    process.execPath,
    [
      renderScript,
      '--seed', String(seed), '--duel',
      '--a', nationA, '--b', nationB,
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
            ctx.progress('render', 0.06 + pct * 0.6, msg ?? '');
            return;
          } catch {
            /* fall through */
          }
        }
        ctx.log('render', line);
      },
    },
  );

  if (!existsSync(resultPath)) throw new Error('laser nations duel produced no result');
  const raw = JSON.parse(readFileSync(resultPath, 'utf8')) as {
    seed: number; winner: string; loser: string; cause: string; hpA: number; hpB: number; maxHp: number;
    countries: string[]; durationSec: number; frames: number; fps: number;
    width: number; height: number; frameWidth: number; frameHeight: number; ss: number;
  };
  const duel: LaserDuelResult = {
    seed: raw.seed, mode: 'duel', nationA: raw.countries[0] ?? nationA, nationB: raw.countries[1] ?? nationB,
    winner: raw.winner, loser: raw.loser, cause: raw.cause, hpA: raw.hpA, hpB: raw.hpB, maxHp: raw.maxHp,
    searchScore, usedFallback,
    durationSec: raw.durationSec, frames: raw.frames, fps: raw.fps,
    width: raw.width, height: raw.height, frameWidth: raw.frameWidth, frameHeight: raw.frameHeight, ss: raw.ss,
  };
  ctx.log('render', `${duel.nationA} vs ${duel.nationB} → ${duel.winner} wins (${duel.cause}, ${duel.hpA}%/${duel.hpB}% hp) · seed ${duel.seed}`);

  // ---- audio: the same synth as territory mode, but it reads `mode:"duel"`
  //      from events.json and switches to a punchier, louder master chain ----
  ctx.progress('render', 0.7, 'scoring the sound');
  const audioRaw = ctx.file('lasernations_audio.wav');
  await runPython('lasernations_audio.py', {
    args: ['--events', resolve(framesDir, 'events.json'), '--duration', String(duel.durationSec), '--out', audioRaw],
    signal: ctx.signal,
    onProgress: (p, m) => ctx.progress('render', 0.7 + p * 0.05, m),
    onLog: (l) => ctx.log('render', l),
  });

  // duel wants presence, not the territory mode's deliberately soft wash
  ctx.progress('render', 0.76, 'balancing the sound');
  const audio = ctx.file('lasernations_audio_final.wav');
  const comp = 'highpass=f=55,acompressor=threshold=-20dB:ratio=3:attack=8:release=200';
  const measure = await run(
    FFMPEG,
    ['-hide_banner', '-i', audioRaw, '-af', `${comp},loudnorm=I=-16:TP=-1.5:LRA=9:print_format=json`, '-f', 'null', '-'],
    { signal: ctx.signal },
  ).catch(() => null);
  let ln = 'loudnorm=I=-16:TP=-1.5:LRA=9';
  const m = measure?.stderr.match(/\{[\s\S]*?\}/g)?.at(-1);
  if (m) {
    try {
      const j = JSON.parse(m) as Record<string, string>;
      ln = `loudnorm=I=-16:TP=-1.5:LRA=9:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
    } catch {
      /* single-pass */
    }
  }
  await runFfmpeg(
    ['-y', '-i', audioRaw, '-af', `${comp},${ln},alimiter=limit=0.85`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', audio],
    { signal: ctx.signal },
  );

  // ---- mux the frame sequence + audio → a sharp 4K (2160×3840) 9:16 mp4 ----
  ctx.progress('render', 0.84, 'compositing 4K');
  const outPath = ctx.file('final.0.mp4');
  const needsScale = duel.frameWidth !== duel.width || duel.frameHeight !== duel.height;
  const vf = [
    needsScale ? `scale=${duel.width}:${duel.height}:flags=lanczos+accurate_rnd+full_chroma_int` : null,
    'unsharp=5:5:0.5:5:5:0.0',
    'format=yuv420p',
  ].filter(Boolean).join(',');
  await runFfmpeg(
    [
      '-y',
      '-framerate', String(duel.fps),
      '-start_number', '1',
      '-i', resolve(framesDir, 'f_%05d.jpg'),
      '-i', audio,
      '-map', '0:v', '-map', '1:a',
      '-vf', vf,
      // crf 19 + a loose maxrate/bufsize safety net — a duel has NO fixed
      // timer (ends whenever someone hits 0 hp, only a 90s safety backstop),
      // so crf alone gives no hard guarantee on file size for a freak long
      // fight. The daily auto-poster (scripts/post/daily.ts) now serves
      // videos through GitHub Pages, not jsDelivr — Pages' real limit is
      // git's own ~100MB/file, not jsDelivr's tight 20MB CDN cap — so this
      // ceiling is sized to bound even a full 90s fight to well under THAT
      // (not under 20MB), meaning it only binds on a truly pathological
      // run, not on normal output like the tighter version did.
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-maxrate', '5900k', '-bufsize', '11800k',
      '-x264-params', 'aq-mode=3:aq-strength=0.9',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-shortest',
      outPath,
    ],
    { signal: ctx.signal, totalDurationSec: duel.durationSec, onProgress: (p) => ctx.progress('render', 0.84 + p * 0.14) },
  );

  if (!existsSync(thumbPath)) {
    // poster generation failed for some reason — fall back to a mid-fight frame
    await ffmpegOnce(
      ['-y', '-ss', String(Math.min(duel.durationSec * 0.4, 6)), '-i', outPath, '-frames:v', '1', '-q:v', '3', thumbPath],
      ctx.signal,
    );
  }
  const probe = await ffprobe(outPath);
  log.ok(`laser nations duel — ${duel.nationA} vs ${duel.nationB} → ${duel.winner} (${probe.durationSec.toFixed(1)}s, seed ${duel.seed})`);

  try {
    rmSync(framesDir, { recursive: true, force: true });
    rmSync(posterFrames, { recursive: true, force: true });
  } catch {
    /* not fatal */
  }

  return {
    render: { videoPath: outPath, thumbPath, durationSec: probe.durationSec, width: probe.width, height: probe.height },
    duel,
  };
}

import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { paths } from '../../paths.ts';
import { log } from '../../lib/log.ts';
import { run, stream } from '../../lib/exec.ts';
import { runPython } from '../../lib/python.ts';
import { FFMPEG, appendEndCard, ffmpegOnce, ffprobe, runFfmpeg } from '../ffmpeg.ts';
import type { StepContext } from '../context.ts';
import type { RenderResult } from './render.ts';
import { buildPostKit, coverTimeSec, postKitText, writeCover } from '../../../../scripts/findthecat/postkit.mjs';

export interface FindTheCatResult {
  seed: number;
  roundCount: number;
  lengthMode: 'short' | 'long' | 'custom';
  /** Each round's cup count, in order (easy/medium/hard escalation). */
  cups: number[];
  /** Each round's difficulty, in order. */
  difficulty: string[];
  /** Each round's visual twist ('none' | 'fakeout' | 'colorshift'). */
  twists: string[];
  theme: string;
  backdrop: string;
  hook: string;
  label: string;
  /** The winning cup per round, 1-indexed — the answer key. */
  answers: number[];
  roundTotalSec: number;
  revealOffsetSec: number;
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
 * mechanic with a cat-face "ball". A real multi-round game: the user picks
 * how many rounds (always starting at round 1), difficulty escalates by
 * round index (easy, medium, hard, hard, ...). Driven headlessly frame by
 * frame in Chrome by scripts/findthecat/render.mjs, same as the CLI.
 *
 * Writes, next to the usual final.0.mp4 / thumb.0.jpg:
 *   sfx.0.mp4      the same video with an SFX-only mix (no cat laugh clip,
 *                  100% self-generated — for adding a TikTok sound in-app)
 *   cover.0.png    the final reveal with the hook text burned in
 *   postkit.0.txt  caption, hashtags, pinned comment, answers
 */
export async function runFindTheCat(ctx: StepContext): Promise<{ render: RenderResult; game: FindTheCatResult }> {
  const framesDir = ctx.file('ftcframes');
  mkdirSync(framesDir, { recursive: true });
  const resultPath = ctx.file('findthecat.json');

  // the preview studio pins an exact seed so "render this" reproduces what
  // was previewed; batch jobs leave it unpinned and let the variety check
  // pick a seed whose look wasn't used in the last 10 renders
  const pinned = ctx.settings.findTheCatSeed;
  const seed = pinned && pinned > 0 ? Math.floor(pinned) : randomInt(1, 2_000_000_000);
  const s = ctx.settings;
  const rounds = s.findTheCatRounds ?? 3;

  ctx.setStep('render', 'running', { detail: `${rounds} round(s) · shuffling the cups` });
  const renderScript = resolve(paths.repoRoot, 'scripts', 'findthecat', 'render.mjs');
  if (!existsSync(renderScript)) throw new Error(`find-the-cat renderer missing: ${renderScript}`);

  await stream(
    process.execPath,
    [
      renderScript,
      '--seed', String(seed),
      '--rounds', String(rounds),
      '--theme', s.findTheCatTheme ?? 'random',
      '--hook', s.findTheCatHook || 'FIND THE CAT',
      '--hook-sec', String(s.findTheCatHookSec ?? 2),
      '--twists', s.findTheCatTwists === false ? '0' : '1',
      ...(s.findTheCatLabel ? ['--label', s.findTheCatLabel] : []),
      ...(pinned && pinned > 0 ? [] : ['--variety']),
      '--fps', '60',
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

  // ---- audio: the full mix (SFX + the cat laugh clip) and an SFX-only mix
  ctx.progress('render', 0.74, 'scoring the sound');
  const mixes = [
    { raw: ctx.file('findthecat_audio.wav'), final: ctx.file('findthecat_audio_final.wav'), extra: [] as string[] },
    { raw: ctx.file('findthecat_sfx.wav'), final: ctx.file('findthecat_sfx_final.wav'), extra: ['--no-clip'] },
  ];
  for (const mix of mixes) {
    await runPython('findthecat_audio.py', {
      args: ['--events', resolve(framesDir, 'events.json'), '--duration', String(game.durationSec), '--out', mix.raw, ...mix.extra],
      signal: ctx.signal,
      onProgress: (p, m) => ctx.progress('render', 0.74 + p * 0.03, m),
      onLog: (l) => ctx.log('render', l),
    });
    await finalizeAudio(mix.raw, mix.final, ctx.signal);
  }

  // ---- encode the frames ONCE (sharp 4K 2160x3840 9:16), then stream-copy
  //      that video under each audio mix
  ctx.progress('render', 0.82, 'compositing 4K');
  const videoOnly = ctx.file('findthecat_video.mp4');
  const needsScale = game.frameWidth !== game.width || game.frameHeight !== game.height;
  const vf = [
    needsScale ? `scale=${game.width}:${game.height}:flags=lanczos+accurate_rnd+full_chroma_int` : null,
    'unsharp=3:3:0.6:3:3:0.0',   // was 0.3 — asked for sharper
    'format=yuv420p',
  ].filter(Boolean).join(',');
  await runFfmpeg(
    [
      '-y',
      '-framerate', String(game.fps),
      '-start_number', '1',
      '-i', resolve(framesDir, 'f_%05d.png'),
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '17',
      '-x264-params', 'aq-mode=3:aq-strength=0.8',
      '-pix_fmt', 'yuv420p', '-r', String(game.fps), '-an',
      videoOnly,
    ],
    {
      signal: ctx.signal,
      totalDurationSec: game.durationSec,
      onProgress: (p) => ctx.progress('render', 0.82 + p * 0.12),
    },
  );

  const outPath = ctx.file('final.0.mp4');
  const sfxPath = ctx.file('sfx.0.mp4');
  for (const [wav, dest] of [[mixes[0]!.final, outPath], [mixes[1]!.final, sfxPath]] as const) {
    await runFfmpeg(
      ['-y', '-i', videoOnly, '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-shortest', dest],
      { signal: ctx.signal },
    );
  }
  // finishPost() appends the branded end card to final.0.mp4; give the
  // SFX-only twin the same ending so the two stay frame-for-frame identical
  await appendEndCard(sfxPath, paths.endCard, ctx.signal);

  // ---- post kit: cover (final reveal + hook text) and the caption txt
  ctx.progress('render', 0.96, 'writing the post kit');
  const kit = buildPostKit(game);
  const coverPath = ctx.file('cover.0.png');
  await writeCover({ ffmpeg: FFMPEG, video: outPath, atSec: coverTimeSec(game), out: coverPath, hook: kit.hook, sub: kit.coverSub });
  writeFileSync(ctx.file('postkit.0.txt'), postKitText(kit, game));

  // thumbnail mid-shuffle (not the reveal) — the dashboard's own preview tile
  const thumbPath = ctx.file('thumb.0.jpg');
  await ffmpegOnce(
    ['-y', '-ss', String(Math.min(game.durationSec * 0.4, 8)), '-i', outPath, '-frames:v', '1', '-q:v', '3', thumbPath],
    ctx.signal,
  );
  const probe = await ffprobe(outPath);
  log.ok(`find the cat — ${game.roundCount} round(s) — answers ${game.answers.join(' ')} (${probe.durationSec.toFixed(1)}s, seed ${game.seed})`);

  for (const p of [framesDir, videoOnly]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* not fatal */
    }
  }

  return {
    render: { videoPath: outPath, thumbPath, durationSec: probe.durationSec, width: probe.width, height: probe.height },
    game,
  };
}

/** gentle two-pass loudnorm — present and satisfying, never loud */
async function finalizeAudio(raw: string, out: string, signal?: AbortSignal): Promise<void> {
  const comp = 'highpass=f=60,acompressor=threshold=-22dB:ratio=3:attack=8:release=200';
  const measure = await run(
    FFMPEG,
    ['-hide_banner', '-i', raw, '-af', `${comp},loudnorm=I=-20:TP=-2:LRA=9:print_format=json`, '-f', 'null', '-'],
    { signal },
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
  await runFfmpeg(['-y', '-i', raw, '-af', `${comp},${ln},alimiter=limit=0.9`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', out], { signal });
}

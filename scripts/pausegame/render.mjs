// Headless renderer for "Pause Game".
//
// Boots the static server, drives the 2-D Canvas pause challenge in
// headless Chrome one frame at a time (deterministic — no physics
// randomness at all, the seed only picks the neon accent color), screenshots
// each frame, and records the per-frame sound-event log the audio pass
// turns into a soundtrack.
//
//   node scripts/pausegame/render.mjs --seed 7 --target 9 --rotation 1100 \
//        --laps 10 --fps 60 --out-frames /path/frames --out /path/result.json
//
//   --target   win-zone width in degrees (5-30). Smaller = harder. Default 9.
//   --rotation ms for one full 360deg sweep (600-2500). Smaller = faster. Default 1100.
//   --laps     how many full rotations before the clip ends (4-20). The
//              render is engineered to land exactly back at frame 0's angle
//              at that point, so the finished mp4 loops seamlessly on
//              TikTok's native replay. Default 10.
//   --mux : also synthesise audio + ffmpeg-mux a watchable
//           pausegame-<seed>.mp4 (the studio "RENDER THIS" path)

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from './serve.mjs';

const pexec = promisify(execFile);
const REPO = resolve(new URL('../..', import.meta.url).pathname);

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
function numArg(name, def, int) {
  const raw = arg(name, undefined);
  if (raw === undefined || raw === true) return def;
  const n = int ? parseInt(raw, 10) : parseFloat(raw);
  return Number.isFinite(n) ? n : def;
}

const opts = {
  seed: numArg('seed', Math.floor(Math.random() * 1e9), true) >>> 0,
  target: Math.max(5, Math.min(30, numArg('target', 9, true))),
  rotation: Math.max(600, Math.min(2500, numArg('rotation', 1100, true))),
  laps: Math.max(4, Math.min(20, numArg('laps', 10, true))),
  fps: numArg('fps', 60, true),
  w: numArg('w', 1080, true),
  h: numArg('h', 1920, true),
  ss: Math.max(1, Math.min(4, numArg('ss', 2))),
  out: Math.max(1, Math.min(4, numArg('out-scale', 2))),
  outFrames: arg('out-frames', join(process.cwd(), 'render/pausegame/_frames')),
  outJson: arg('out', join(process.cwd(), 'render/pausegame/_result.json')),
  mux: arg('mux', false) !== false,
  muxDir: String(arg('mux-dir', join(process.cwd(), 'render/pausegame/out'))),
};

const FFMPEG = ['/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg']
  .find((p) => p === 'ffmpeg' || existsSync(p)) || 'ffmpeg';
const VENV_PY = join(REPO, 'python/.venv/bin/python');
const PY = existsSync(VENV_PY) ? VENV_PY : 'python3';

function log(m) { process.stderr.write(m + '\n'); }
function progress(pct, msg) {
  process.stderr.write('@progress ' + JSON.stringify({ pct: Math.max(0, Math.min(1, pct)), msg }) + '\n');
}

const renderOne = async (seed, target, rotation, laps) => {
  await rm(opts.outFrames, { recursive: true, force: true });
  await mkdir(opts.outFrames, { recursive: true });

  const { server, port } = await startServer(0);

  const browser = await chromium.launch({
    executablePath: chromium.executablePath(),
    headless: true,
    args: [
      '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb',
      '--font-render-hinting=none', '--disable-lcd-text',
      '--disable-gpu-vsync', '--disable-frame-rate-limit',
      `--window-size=${opts.w},${opts.h}`,
    ],
  });
  const page = await browser.newPage({ viewport: { width: opts.w, height: opts.h }, deviceScaleFactor: opts.ss });

  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') log('  [page] ' + t);
  });
  page.on('pageerror', (e) => log('  [pageerror] ' + e.message));

  const url = `http://127.0.0.1:${port}/render/pausegame/index.html`
    + `?render=1&seed=${seed}&target=${target}&rotation=${rotation}&laps=${laps}`
    + `&fps=${opts.fps}&w=${opts.w}&h=${opts.h}&ss=${opts.ss}`;
  log(`\n━━ PAUSE GAME · seed ${seed} · target ${target}° · ${rotation}ms/rotation · ${laps} laps · @ ${opts.fps}fps · capture ${opts.w * opts.ss}×${opts.h * opts.ss} → out ${opts.w * opts.out}×${opts.h * opts.out} ━━`);
  progress(0.02, 'loading the game');
  await page.goto(url, { waitUntil: 'load' });

  const err = await page.evaluate(() => window.__PG_ERROR || null);
  if (err) throw new Error('page error: ' + err);

  await page.waitForFunction(() => window.PG && window.PG.meta, null, { timeout: 30000 });
  const meta = await page.evaluate(() => window.PG.meta);
  log('meta: ' + JSON.stringify(meta));

  const cdp = await page.context().newCDPSession(page);
  const allEvents = [];
  const writes = [];
  let frame = 0;
  const cap = meta.totalFrames;

  while (true) {
    const r = await page.evaluate(() => window.PG.step());
    frame = r.frame;
    const idx = String(frame).padStart(5, '0');
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png', optimizeForSpeed: true,
      clip: { x: 0, y: 0, width: opts.w, height: opts.h, scale: opts.ss },
    });
    writes.push(writeFile(join(opts.outFrames, `f_${idx}.png`), Buffer.from(shot.data, 'base64')));
    if (writes.length >= 16) await Promise.all(writes.splice(0));
    for (const ev of r.events) allEvents.push(ev);

    if (frame % 15 === 0 || r.done) progress(0.05 + 0.9 * (frame / cap), `frame ${frame}/${cap}`);
    if (r.done || frame >= cap) break;
  }
  await Promise.all(writes);

  const result = await page.evaluate(() => window.PG.result());
  result.width = Math.round(opts.w * opts.out);
  result.height = Math.round(opts.h * opts.out);
  result.frameWidth = Math.round(opts.w * opts.ss);
  result.frameHeight = Math.round(opts.h * opts.ss);
  result.ss = opts.ss;

  await writeFile(opts.outJson, JSON.stringify(result, null, 2));
  await writeFile(
    join(opts.outFrames, 'events.json'),
    JSON.stringify({ fps: meta.fps, durationSec: result.durationSec, events: allEvents }),
  );

  log(`   seed ${seed} → ${result.targetDeg}° target, ${result.rotationMs}ms/rotation, ${result.laps} laps · ${result.frames} frames · ${allEvents.length} sound events`);
  progress(1, 'frames done');

  await browser.close();
  server.close();
  return result;
};

/* synthesise audio + ffmpeg-mux a finished mp4 (studio "RENDER THIS" path).
   Mirrors worker/src/pipeline/steps/pausegame.ts. */
const mux = async (result, seed) => {
  await mkdir(opts.muxDir, { recursive: true });
  const framesDir = opts.outFrames;
  const rawWav = join(framesDir, '_audio_raw.wav');
  const finalWav = join(framesDir, '_audio_final.wav');
  const outMp4 = join(opts.muxDir, `pausegame-${seed}.mp4`);

  progress(0.9, 'scoring the sound');
  await pexec(PY, [join(REPO, 'python/pausegame_audio.py'),
    '--events', join(framesDir, 'events.json'), '--duration', String(result.durationSec), '--out', rawWav],
    { cwd: REPO, maxBuffer: 1 << 24 });

  const comp = 'highpass=f=80,acompressor=threshold=-22dB:ratio=3:attack=8:release=200';
  let ln = 'loudnorm=I=-21:TP=-2.5:LRA=8';
  try {
    const { stderr } = await pexec(FFMPEG,
      ['-hide_banner', '-i', rawWav, '-af', `${comp},${ln}:print_format=json`, '-f', 'null', '-'],
      { cwd: REPO, maxBuffer: 1 << 24 }).catch((e) => ({ stderr: e.stderr || '' }));
    const j = JSON.parse((stderr.match(/\{[\s\S]*?\}/g) || []).at(-1));
    ln = `loudnorm=I=-21:TP=-2.5:LRA=8:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
  } catch { /* single-pass */ }
  await pexec(FFMPEG, ['-y', '-i', rawWav, '-af', `${comp},${ln},alimiter=limit=0.9`,
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', finalWav], { cwd: REPO, maxBuffer: 1 << 24 });

  progress(0.94, 'compositing 4K');
  const needsScale = result.frameWidth !== result.width || result.frameHeight !== result.height;
  const vf = [
    needsScale ? `scale=${result.width}:${result.height}:flags=lanczos+accurate_rnd+full_chroma_int` : null,
    'unsharp=3:3:0.3:3:3:0.0', 'format=yuv420p',
  ].filter(Boolean).join(',');
  await pexec(FFMPEG, ['-y', '-framerate', String(result.fps), '-start_number', '1',
    '-i', join(framesDir, 'f_%05d.png'), '-i', finalWav, '-map', '0:v', '-map', '1:a', '-vf', vf,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-x264-params', 'aq-mode=3:aq-strength=0.8',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-shortest', outMp4],
    { cwd: REPO, maxBuffer: 1 << 24 });

  await rm(framesDir, { recursive: true, force: true });
  progress(1, 'done');
  log(`   ✅  ${outMp4}`);
  return outMp4;
};

const main = async () => {
  const result = await renderOne(opts.seed, opts.target, opts.rotation, opts.laps);
  const mp4 = opts.mux ? await mux(result, opts.seed) : null;
  process.stdout.write(JSON.stringify(mp4 ? { ...result, mp4 } : result));
};

main().catch((e) => { log('ERROR ' + (e.stack || e.message)); process.exit(1); });

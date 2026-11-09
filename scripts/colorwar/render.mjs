// Headless renderer for "Color war".
//
// Boots the static server, drives the 2-D Canvas territory fight in headless
// Chrome one frame at a time (deterministic — seeded RNG), screenshots each
// frame, and records the per-frame sound-event log the audio pass turns into
// a soundtrack.
//
//   node scripts/colorwar/render.mjs --seed 7 --mode random \
//        --fps 60 --out-frames /path/frames --out /path/result.json

import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
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
// numeric arg with a hard fallback. A bare `--r` / `--fps` (no value) makes
// arg() return `true`, and `parseFloat(true)` is NaN — which downstream renders
// a blank board. Any non-finite parse falls back to the default.
function numArg(name, def, int) {
  const raw = arg(name, undefined);
  if (raw === undefined || raw === true) return def;
  const n = int ? parseInt(raw, 10) : parseFloat(raw);
  return Number.isFinite(n) ? n : def;
}

const opts = {
  seed: numArg('seed', Math.floor(Math.random() * 1e9), true) >>> 0,
  // `--mode classic` (the default; or bigtiles / finegrain / stripes) is the
  // ~44 s "wild finish" format. `--mode sprint` is the ~16 s cold-open cut.
  // Never random unless `--mode random` is passed explicitly.
  mode: String(arg('mode', 'classic')),
  shape: arg('shape', 'circle') === 'square' ? 'square' : 'circle',
  flipsound: arg('flipsound', 'bubble') === 'pluck' ? 'pluck' : 'bubble',
  r: numArg('r', 26),                           // ball size (design ballSize, 14–44)
  // safety frame cap override (seconds). Absent -> the game picks per mode
  // (SPRINT ~26 s, the ~44 s boards ~60 s). Pass only to force a different cap.
  sec: arg('sec', undefined) === undefined || arg('sec', undefined) === true
    ? null : Math.max(10, Math.min(120, parseFloat(arg('sec')) || 0)) || null,
  fps: numArg('fps', 60, true),
  w: numArg('w', 1080, true),
  h: numArg('h', 1920, true),
  // ss  = deviceScaleFactor — the page renders (and every frame is captured) at
  //       ss× the logical size. 3 -> 3240×5760 capture. The game canvas sizes its
  //       backing store to its on-screen box × ss (see game.js resize()), so the
  //       browser blits it 1:1 — no soft compositor downscale.
  // out = final output multiplier vs w/h. ss > out means the capture is
  //       lanczos-downscaled to the 4K output in the worker step (clean supersample).
  // ss=2 captures at exactly the 4K output resolution (no ffmpeg scaling at
  // all — neither upscale-blur from ss=1 nor the ~4x slower downscale ss=3
  // needs), which measured as sharp as ss=3 with ~4-5x less per-frame
  // screenshot-capture time in CI (ss=3's ~1.3s/frame is why renders were
  // timing out — see scripts/post/daily.ts commit history).
  ss: Math.max(1, Math.min(4, numArg('ss', 2))),
  out: Math.max(1, Math.min(4, numArg('out-scale', 2))),
  outFrames: arg('out-frames', join(process.cwd(), 'render/colorwar/_frames')),
  outJson: arg('out', join(process.cwd(), 'render/colorwar/_result.json')),
  // --mux: after the frames, synthesise audio + ffmpeg-mux to a watchable
  //   mp4 named colorwar-<mode>-<seed>.mp4 (the studio's "RENDER THIS" path).
  mux: arg('mux', false) !== false,
  muxDir: String(arg('mux-dir', join(process.cwd(), 'render/colorwar/out'))),
  // --queue <file>: render every "<seed> [mode]" line in the file, in order.
  queue: arg('queue', undefined) === undefined || arg('queue', undefined) === true ? null : String(arg('queue')),
  // Season Mode display params (intro card / score chips / outro badge) — see
  // render/colorwar/game.js's SEASON_MODE block. Purely visual passthrough;
  // absent unless the worker is rendering a season episode.
  season: numArg('season', 0, true),
  episode: numArg('episode', 1, true),
  totalEpisodes: numArg('totalEpisodes', 1, true),
  scoresBefore: String(arg('scoresBefore', '0,0,0,0')),
};

const FFMPEG = ['/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg']
  .find((p) => p === 'ffmpeg' || existsSync(p)) || 'ffmpeg';
const VENV_PY = join(REPO, 'python/.venv/bin/python');
const PY = existsSync(VENV_PY) ? VENV_PY : 'python3';

function log(m) { process.stderr.write(m + '\n'); }
function progress(pct, msg) {
  process.stderr.write('@progress ' + JSON.stringify({ pct: Math.max(0, Math.min(1, pct)), msg }) + '\n');
}

const renderOne = async (seed, mode) => {
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
    else if (t.startsWith('[CW]')) log('  ' + t);
  });
  page.on('pageerror', (e) => log('  [pageerror] ' + e.message));

  const url = `http://127.0.0.1:${port}/render/colorwar/index.html`
    + `?render=1&seed=${seed}&mode=${encodeURIComponent(mode)}`
    + `&shape=${opts.shape}&flipsound=${opts.flipsound}&r=${opts.r}`
    + (opts.sec ? `&sec=${opts.sec}` : '')
    + `&fps=${opts.fps}&w=${opts.w}&h=${opts.h}&ss=${opts.ss}`
    + (opts.season ? `&season=${opts.season}&episode=${opts.episode}&totalEpisodes=${opts.totalEpisodes}&scoresBefore=${encodeURIComponent(opts.scoresBefore)}` : '');
  log(`\n━━ COLOR WAR · seed ${seed} · mode ${mode}${opts.sec ? ` · cap ${opts.sec}s` : ''} · @ ${opts.fps}fps · capture ${opts.w * opts.ss}×${opts.h * opts.ss} → out ${opts.w * opts.out}×${opts.h * opts.out} ━━`);
  progress(0.02, 'loading the board');
  await page.goto(url, { waitUntil: 'load' });

  const err = await page.evaluate(() => window.__CW_ERROR || null);
  if (err) throw new Error('page error: ' + err);

  await page.waitForFunction(() => window.CW && window.CW.meta, null, { timeout: 30000 });
  const meta = await page.evaluate(() => window.CW.meta);
  log('meta: ' + JSON.stringify(meta));

  const cdp = await page.context().newCDPSession(page);
  const allEvents = [];
  const writes = [];
  let frame = 0;
  const cap = meta.totalFrames;

  while (true) {
    const r = await page.evaluate(() => window.CW.step());
    frame = r.frame;
    const idx = String(frame).padStart(5, '0');
    // PNG, not JPEG: the art is flat colour blocks, 1px grid lines and crisp
    // DOM text — exactly what JPEG's DCT rings and smears. PNG is lossless and
    // compresses this kind of frame well, so the 4K output actually looks 4K.
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

  const result = await page.evaluate(() => window.CW.result());
  result.width = Math.round(opts.w * opts.out);
  result.height = Math.round(opts.h * opts.out);
  result.frameWidth = Math.round(opts.w * opts.ss);
  result.frameHeight = Math.round(opts.h * opts.ss);
  result.ss = opts.ss;

  await writeFile(opts.outJson, JSON.stringify(result, null, 2));
  await writeFile(
    join(opts.outFrames, 'events.json'),
    JSON.stringify({ fps: meta.fps, durationSec: result.durationSec, mode: result.mode, events: allEvents }),
  );

  log(`   seed ${seed} → ${result.winner} wins @ ${result.winAtSec}s · ${result.frames} frames · ${allEvents.length} sound events`);
  progress(1, 'frames done');

  await browser.close();
  server.close();
  return result;
};

/* synthesise audio + ffmpeg-mux a finished mp4 (studio "RENDER THIS" path).
   Mirrors worker/src/pipeline/steps/colorwar.ts so the studio preview matches
   what the pipeline would produce. */
const mux = async (result, seed, mode) => {
  await mkdir(opts.muxDir, { recursive: true });
  const framesDir = opts.outFrames;
  const rawWav = join(framesDir, '_audio_raw.wav');
  const finalWav = join(framesDir, '_audio_final.wav');
  const outMp4 = join(opts.muxDir, `colorwar-${mode}-${seed}.mp4`);

  progress(0.9, 'scoring the sound');
  await pexec(PY, [join(REPO, 'python/colorwar_audio.py'),
    '--events', join(framesDir, 'events.json'), '--duration', String(result.durationSec), '--out', rawWav],
    { cwd: REPO, maxBuffer: 1 << 24 });

  const comp = 'highpass=f=68,acompressor=threshold=-22dB:ratio=3:attack=8:release=200';
  let ln = 'loudnorm=I=-21:TP=-2.5:LRA=8';
  try {
    const { stderr } = await pexec(FFMPEG,
      ['-hide_banner', '-i', rawWav, '-af', `${comp},${ln}:print_format=json`, '-f', 'null', '-'],
      { cwd: REPO, maxBuffer: 1 << 24 }).catch((e) => ({ stderr: e.stderr || '' }));
    const j = JSON.parse((stderr.match(/\{[\s\S]*?\}/g) || []).at(-1));
    ln = `loudnorm=I=-21:TP=-2.5:LRA=8:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
  } catch { /* single-pass */ }
  await pexec(FFMPEG, ['-y', '-i', rawWav, '-af', `${comp},${ln},alimiter=limit=0.8`,
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', finalWav], { cwd: REPO, maxBuffer: 1 << 24 });

  progress(0.94, 'compositing 4K');
  const needsScale = result.frameWidth !== result.width || result.frameHeight !== result.height;
  const vf = [
    needsScale ? `scale=${result.width}:${result.height}:flags=lanczos+accurate_rnd+full_chroma_int` : null,
    'unsharp=3:3:0.32:3:3:0.0', 'format=yuv420p',
  ].filter(Boolean).join(',');
  await pexec(FFMPEG, ['-y', '-framerate', String(result.fps), '-start_number', '1',
    '-i', join(framesDir, 'f_%05d.png'), '-i', finalWav, '-map', '0:v', '-map', '1:a', '-vf', vf,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '17', '-x264-params', 'aq-mode=3:aq-strength=0.8',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-shortest', outMp4],
    { cwd: REPO, maxBuffer: 1 << 24 });

  await rm(framesDir, { recursive: true, force: true });
  progress(1, 'done');
  log(`   ✅  ${outMp4}`);
  return outMp4;
};

const main = async () => {
  if (opts.queue) {
    const lines = (await readFile(opts.queue, 'utf8')).split('\n')
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (!lines.length) { log(`queue ${opts.queue} is empty`); return; }
    log(`rendering ${lines.length} queued seed(s) from ${opts.queue}`);
    const outs = [];
    for (const line of lines) {
      const [s, m] = line.split(/\s+/);
      const seed = (parseInt(s, 10) >>> 0) || 1;
      const mode = m || opts.mode;
      const result = await renderOne(seed, mode);
      outs.push(await mux(result, seed, mode));
    }
    log(`\nqueue done — ${outs.length} clip(s):\n${outs.map((o) => '  ' + o).join('\n')}`);
    return;
  }

  // single render — renderOne() already wrote --out (result json) + events.json
  const result = await renderOne(opts.seed, opts.mode);
  const mp4 = opts.mux ? await mux(result, opts.seed, opts.mode) : null;
  process.stdout.write(JSON.stringify(mp4 ? { ...result, mp4 } : result));
};

main().catch((e) => { log('ERROR ' + (e.stack || e.message)); process.exit(1); });

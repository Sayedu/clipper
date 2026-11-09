// Headless renderer for "Color race" (Marble Rush).
//
// Boots the static server, drives the 2-D Canvas marble race in headless Chrome
// one frame at a time (deterministic — seeded RNG), screenshots each frame, and
// records the per-frame sound-event log the audio pass turns into a soundtrack.
//
//   node scripts/colorrace/render.mjs --seed 7 --map random --balls 4 --sec 22 \
//        --fps 60 --out-frames /path/frames --out /path/result.json

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from './serve.mjs';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const opts = {
  seed: parseInt(arg('seed', String(Math.floor(Math.random() * 1e9))), 10) >>> 0,
  map: String(arg('map', 'random')),         // random | 0..4 | zigzag|pegstorm|spinner|fork|bumper
  balls: parseInt(arg('balls', '4'), 10),
  shape: arg('shape', 'circle') === 'square' ? 'square' : 'circle',
  sec: parseFloat(arg('sec', '22')),         // target race length
  zoom: parseFloat(arg('zoom', '1')),        // 1 = the design's exact framing; >1 pulls the camera back
  // 60 fps by default so the motion is as smooth on a phone as in the live game.
  fps: parseInt(arg('fps', '60'), 10),
  // w/h = the game's logical (CSS) canvas size; layout is authored against this.
  w: parseInt(arg('w', '1080'), 10),
  h: parseInt(arg('h', '1920'), 10),
  // ss  = deviceScaleFactor — the page renders (and every frame is captured) at
  //       ss× the logical size. 2 -> 2160×3840 capture.
  // out = final output multiplier vs w/h. 2 -> a true 2160×3840 (4K vertical) mp4.
  //       When ss > out the capture is lanczos-downscaled (extra supersampling).
  ss: Math.max(1, Math.min(4, parseFloat(arg('ss', '2')))),
  out: Math.max(1, Math.min(4, parseFloat(arg('out-scale', '2')))),
  outFrames: arg('out-frames', join(process.cwd(), 'render/colorrace/_frames')),
  outJson: arg('out', join(process.cwd(), 'render/colorrace/_result.json')),
};

function log(m) { process.stderr.write(m + '\n'); }
function progress(pct, msg) {
  process.stderr.write('@progress ' + JSON.stringify({ pct: Math.max(0, Math.min(1, pct)), msg }) + '\n');
}

const main = async () => {
  await rm(opts.outFrames, { recursive: true, force: true });
  await mkdir(opts.outFrames, { recursive: true });

  const { server, port } = await startServer(0);

  const browser = await chromium.launch({
    executablePath: chromium.executablePath(),
    headless: true,
    args: [
      // CI runners have no real GPU. Without an explicit software-GL backend,
      // Chromium can fall back to a far slower raw-CPU canvas path instead of
      // SwiftShader (measured ~1 frame/sec on GitHub Actions without these).
      // Scoped to CI only (GitHub Actions sets CI=true) — a real local GPU is fine.
      ...(process.env.CI ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []),
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
    else if (t.startsWith('[CR]')) log('  ' + t);
  });
  page.on('pageerror', (e) => log('  [pageerror] ' + e.message));

  const url = `http://127.0.0.1:${port}/render/colorrace/index.html`
    + `?render=1&seed=${opts.seed}&map=${encodeURIComponent(opts.map)}&balls=${opts.balls}`
    + `&shape=${opts.shape}&sec=${opts.sec}&zoom=${opts.zoom}`
    + `&fps=${opts.fps}&w=${opts.w}&h=${opts.h}&ss=${opts.ss}`;
  log(`seed ${opts.seed} · map ${opts.map} · ${opts.balls} marbles · ~${opts.sec}s @ ${opts.fps}fps · capture ${opts.w * opts.ss}×${opts.h * opts.ss} → out ${opts.w * opts.out}×${opts.h * opts.out}`);
  progress(0.02, 'loading the course');
  await page.goto(url, { waitUntil: 'load' });

  const err = await page.evaluate(() => window.__CR_ERROR || null);
  if (err) throw new Error('page error: ' + err);

  await page.waitForFunction(() => window.CR && window.CR.meta, null, { timeout: 30000 });
  const meta = await page.evaluate(() => window.CR.meta);
  log('meta: ' + JSON.stringify(meta));

  // CDP JPEG screenshots at ss× (deviceScaleFactor). ffmpeg lanczos-downscales the
  // sequence to w×h in the worker step — that downscale IS the anti-aliasing, so
  // neon edges, gradients and text all come out crisp.
  const cdp = await page.context().newCDPSession(page);
  const allEvents = [];
  const writes = [];
  let frame = 0;
  const cap = meta.totalFrames;

  while (true) {
    const r = await page.evaluate(() => window.CR.step());
    frame = r.frame;
    const idx = String(frame).padStart(5, '0');
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg', quality: 93, optimizeForSpeed: true,
      clip: { x: 0, y: 0, width: opts.w, height: opts.h, scale: opts.ss },
    });
    writes.push(writeFile(join(opts.outFrames, `f_${idx}.jpg`), Buffer.from(shot.data, 'base64')));
    if (writes.length >= 16) await Promise.all(writes.splice(0));
    for (const ev of r.events) allEvents.push(ev);

    if (frame % 15 === 0 || r.done) progress(0.05 + 0.9 * (frame / cap), `frame ${frame}/${cap}`);
    if (r.done || frame >= cap) break;
  }
  await Promise.all(writes);

  const result = await page.evaluate(() => window.CR.result());
  result.width = Math.round(opts.w * opts.out);      // final mp4 size (4K by default)
  result.height = Math.round(opts.h * opts.out);
  result.frameWidth = Math.round(opts.w * opts.ss);  // on-disk capture size
  result.frameHeight = Math.round(opts.h * opts.ss);
  result.ss = opts.ss;

  await writeFile(opts.outJson, JSON.stringify(result, null, 2));
  await writeFile(
    join(opts.outFrames, 'events.json'),
    JSON.stringify({ fps: meta.fps, durationSec: result.durationSec, map: result.map, events: allEvents }),
  );

  log(`winner ${result.winner} · ${result.frames} frames · ${result.durationSec}s · ${allEvents.length} sound events`);
  progress(1, 'done');

  await browser.close();
  server.close();
  process.stdout.write(JSON.stringify(result));
};

main().catch((e) => { log('ERROR ' + (e.stack || e.message)); process.exit(1); });

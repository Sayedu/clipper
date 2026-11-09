// Headless renderer for the marble race.
//
// Boots the static server, drives the Three.js + Rapier scene in headless Chrome
// one frame at a time (deterministic — no requestAnimationFrame), screenshots the
// canvas per frame, and records the per-frame physics events an audio pass needs.
//
//   node scripts/marblerace/render.mjs --seed 7 --marbles 4 --target 20 --fps 30 \
//        --out-frames /path/frames --out /path/result.json [--quick] [--w 1080 --h 1920]

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
  seed: parseInt(arg('seed', String(Math.floor(Math.random() * 1e9))), 10),
  marbles: parseInt(arg('marbles', '4'), 10),
  target: parseFloat(arg('target', '22')),
  fps: parseInt(arg('fps', '30'), 10),
  quick: !!arg('quick', false),
  w: parseInt(arg('w', '1080'), 10),
  h: parseInt(arg('h', '1920'), 10),
  outFrames: arg('out-frames', join(process.cwd(), 'render/marblerace/_frames')),
  out: arg('out', join(process.cwd(), 'render/marblerace/_result.json')),
};

function log(m) { process.stderr.write(m + '\n'); }
function progress(pct, msg) {
  process.stderr.write('@progress ' + JSON.stringify({ pct: Math.max(0, Math.min(1, pct)), msg }) + '\n');
}

const main = async () => {
  await rm(opts.outFrames, { recursive: true, force: true });
  await mkdir(opts.outFrames, { recursive: true });

  const { server, port } = await startServer(0);
  const vw = opts.quick ? Math.round(opts.w * 0.5) : opts.w;
  const vh = opts.quick ? Math.round(opts.h * 0.5) : opts.h;

  const browser = await chromium.launch({
    executablePath: chromium.executablePath(),
    headless: true,
    args: [
      '--use-angle=metal', '--enable-webgl', '--enable-gpu',
      '--ignore-gpu-blocklist', '--enable-unsafe-webgpu',
      '--hide-scrollbars', '--mute-audio',
      `--window-size=${vw},${vh}`,
    ],
  });
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 });

  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') log('  [page] ' + t);
    else if (t.startsWith('[MR]')) log('  ' + t);
  });
  page.on('pageerror', (e) => log('  [pageerror] ' + e.message));

  const url = `http://127.0.0.1:${port}/render/marblerace/index.html`
    + `?seed=${opts.seed}&marbles=${opts.marbles}&target=${opts.target}&fps=${opts.fps}`
    + `&w=${opts.w}&h=${opts.h}${opts.quick ? '&quick=1' : ''}${arg('cam', false) ? `&cam=${arg('cam', '')}` : ''}`;
  log('seed ' + opts.seed + ' · ' + opts.marbles + ' marbles · ~' + opts.target + 's @ ' + opts.fps);
  progress(0.02, 'loading scene');
  await page.goto(url, { waitUntil: 'load' });

  const err = await page.evaluate(() => window.__MR_ERROR || null);
  if (err) throw new Error('scene error: ' + err);

  await page.waitForFunction(() => window.MR && window.MR.meta, null, { timeout: 60000 });
  const meta = await page.evaluate(() => window.MR.meta);
  log('meta: ' + JSON.stringify(meta));

  // CDP screenshots as JPEG — a few times faster to encode than element PNGs,
  // and the frames only feed an h264 encode anyway.
  const cdp = await page.context().newCDPSession(page);
  const frameEvents = [];
  const writes = [];
  let frame = 0;
  const cap = Math.min(meta.hardCap, parseInt(arg('max-frames', String(meta.hardCap)), 10));

  while (true) {
    const r = await page.evaluate(() => window.MR.step());
    frame = r.frame;
    const idx = String(frame).padStart(5, '0');
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg', quality: 92, optimizeForSpeed: true,
      clip: { x: 0, y: 0, width: vw, height: vh, scale: 1 },
    });
    writes.push(writeFile(join(opts.outFrames, `f_${idx}.jpg`), Buffer.from(shot.data, 'base64')));
    if (writes.length >= 16) { await Promise.all(writes.splice(0)); }
    frameEvents.push({ f: frame, impacts: r.impacts, maxSpeed: +r.maxSpeed.toFixed(3) });

    if (frame % 15 === 0 || r.done) {
      progress(0.05 + 0.9 * (frame / cap), `frame ${frame}/${cap}`);
    }
    if (r.done || frame >= cap) break;
  }
  await Promise.all(writes);

  const result = await page.evaluate(() => window.MR.result());
  result.width = opts.w;
  result.height = opts.h;
  result.quick = opts.quick;

  await writeFile(opts.out, JSON.stringify(result, null, 2));
  await writeFile(join(opts.outFrames, 'events.json'), JSON.stringify({ fps: meta.fps, frames: frameEvents }));

  log('winner ' + result.winner + ' at ' + result.winAtSec + 's · ' + result.frames + ' frames · order ' + result.order.join(' > '));
  progress(1, 'done');

  await browser.close();
  server.close();
  process.stdout.write(JSON.stringify(result));
};

main().catch((e) => { log('ERROR ' + (e.stack || e.message)); process.exit(1); });

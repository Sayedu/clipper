// Headless renderer for "Reminders" — the silent 15s quote card.
//
// Boots the static server, drives the Canvas render one frame at a time in
// headless Chrome (deterministic — no requestAnimationFrame, seeded RNG),
// and screenshots each frame. No audio events to record: this content type
// is silent by design, so --mux just attaches a silent track for platform
// compatibility rather than synthesising anything.
//
//   node scripts/quotes/render.mjs --seed 7 --fps 30 \
//        --out-frames /path/frames --out /path/result.json [--w 1080 --h 1920]

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

const opts = {
  seed: parseInt(arg('seed', String(Math.floor(Math.random() * 1e9))), 10) >>> 0,
  sec: parseFloat(arg('sec', '15')),
  fps: parseInt(arg('fps', '30'), 10),
  w: parseInt(arg('w', '1080'), 10),
  h: parseInt(arg('h', '1920'), 10),
  ss: Math.max(1, Math.min(4, parseFloat(arg('ss', '2')))),
  out: Math.max(1, Math.min(4, parseFloat(arg('out-scale', '2')))),
  outFrames: arg('out-frames', join(process.cwd(), 'render/quotes/_frames')),
  outJson: arg('out', join(process.cwd(), 'render/quotes/_result.json')),
  mux: arg('mux', false) !== false,
  muxDir: String(arg('mux-dir', join(process.cwd(), 'render/quotes/out'))),
};

const FFMPEG = ['/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg']
  .find((p) => p === 'ffmpeg' || existsSync(p)) || 'ffmpeg';

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

  page.on('console', (m) => { if (m.type() === 'error') log('  [page] ' + m.text()); });
  page.on('pageerror', (e) => log('  [pageerror] ' + e.message));

  const url = `http://127.0.0.1:${port}/render/quotes/index.html`
    + `?render=1&seed=${opts.seed}&sec=${opts.sec}&fps=${opts.fps}&w=${opts.w}&h=${opts.h}&ss=${opts.ss}`;
  log(`seed ${opts.seed} · ${opts.sec}s @ ${opts.fps}fps · capture ${opts.w * opts.ss}×${opts.h * opts.ss} → out ${opts.w * opts.out}×${opts.h * opts.out}`);
  progress(0.02, 'loading the card');
  await page.goto(url, { waitUntil: 'load' });

  const err = await page.evaluate(() => window.__QT_ERROR || null);
  if (err) throw new Error('page error: ' + err);

  await page.waitForFunction(() => window.QT && window.QT.meta, null, { timeout: 30000 });
  const meta = await page.evaluate(() => window.QT.meta);
  log('meta: ' + JSON.stringify(meta));

  const cdp = await page.context().newCDPSession(page);
  const writes = [];
  let frame = 0;
  const cap = meta.totalFrames;

  while (true) {
    const r = await page.evaluate(() => window.QT.step());
    frame = r.frame;
    const idx = String(frame).padStart(5, '0');
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg', quality: 93, optimizeForSpeed: true,
      clip: { x: 0, y: 0, width: opts.w, height: opts.h, scale: opts.ss },
    });
    writes.push(writeFile(join(opts.outFrames, `f_${idx}.jpg`), Buffer.from(shot.data, 'base64')));
    if (writes.length >= 16) await Promise.all(writes.splice(0));

    if (frame % 15 === 0 || r.done) progress(0.05 + 0.9 * (frame / cap), `frame ${frame}/${cap}`);
    if (r.done || frame >= cap) break;
  }
  await Promise.all(writes);

  const result = await page.evaluate(() => window.QT.result());
  result.width = Math.round(opts.w * opts.out);
  result.height = Math.round(opts.h * opts.out);
  result.frameWidth = Math.round(opts.w * opts.ss);
  result.frameHeight = Math.round(opts.h * opts.ss);
  result.ss = opts.ss;

  await writeFile(opts.outJson, JSON.stringify(result, null, 2));
  log(`tag "${result.tag}" · "${result.setup} / ${result.punch}" · ${result.frames} frames · ${result.durationSec}s`);
  progress(1, 'done');

  await browser.close();
  server.close();

  if (!opts.mux) { process.stdout.write(JSON.stringify(result)); return; }

  // ---- local-dev convenience: mux a watchable mp4 with a silent audio track
  //      (many platforms play back oddly with zero audio streams) ----
  await mkdir(opts.muxDir, { recursive: true });
  const outMp4 = join(opts.muxDir, `quotes-${opts.seed}.mp4`);

  progress(0.5, 'compositing');
  const vf = ['scale=' + result.width + ':' + result.height + ':flags=lanczos+accurate_rnd+full_chroma_int', 'format=yuv420p'].join(',');
  await pexec(FFMPEG, ['-y', '-framerate', String(result.fps), '-start_number', '1',
    '-i', join(opts.outFrames, 'f_%05d.jpg'),
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-map', '0:v', '-map', '1:a', '-vf', vf,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '19',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-shortest', '-movflags', '+faststart', outMp4],
    { cwd: REPO, maxBuffer: 1 << 24 });

  await rm(opts.outFrames, { recursive: true, force: true });
  progress(1, 'done');
  log('wrote ' + outMp4);
  process.stdout.write(JSON.stringify(result));
};

main().catch((e) => { console.error(e); process.exit(1); });

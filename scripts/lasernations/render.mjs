// Headless renderer for "Laser Nations".
//
// Boots the static server, drives the 2-D Canvas sim in headless Chrome one
// frame at a time (deterministic — no requestAnimationFrame, seeded RNG),
// screenshots each frame, and records the per-frame sound-event log the audio
// pass turns into a soundtrack.
//
//   node scripts/lasernations/render.mjs --seed 7 --sec 55 --bh 0 --fps 30 \
//        --out-frames /path/frames --out /path/result.json [--w 1080 --h 1920]
//
//   --duel        1v1 combat mode instead of the 4-way territory game
//   --a / --b     pin the two duel fighters by country name (else random)
//   --poster      capture ONE static "fight poster" frame instead of a match
//                 (used for the duel mode's video thumbnail)
//   --mux         also synthesise audio + ffmpeg-mux a watchable
//                 lasernations[-duel]-<seed>.mp4 (local-dev convenience —
//                 the real pipeline's own step does this itself)

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
  sec: arg('sec', undefined),
  bh: arg('bh', '0') === '1' || arg('bh', '0') === true,
  duel: arg('duel', '0') === '1' || arg('duel', '0') === true,
  poster: arg('poster', '0') === '1' || arg('poster', '0') === true,
  a: String(arg('a', '')),
  b: String(arg('b', '')),
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
  outFrames: arg('out-frames', join(process.cwd(), 'render/lasernations/_frames')),
  outJson: arg('out', join(process.cwd(), 'render/lasernations/_result.json')),
  mux: arg('mux', false) !== false,
  muxDir: String(arg('mux-dir', join(process.cwd(), 'render/lasernations/out'))),
};
if (opts.sec === undefined || opts.sec === true) opts.sec = opts.duel ? 32 : 65;
else opts.sec = parseFloat(opts.sec);

const FFMPEG = ['/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg']
  .find((p) => p === 'ffmpeg' || existsSync(p)) || 'ffmpeg';
const VENV_PY = join(REPO, 'python/.venv/bin/python');
const PY = existsSync(VENV_PY) ? VENV_PY : 'python3';

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
    else if (t.startsWith('[LN]')) log('  ' + t);
  });
  page.on('pageerror', (e) => log('  [pageerror] ' + e.message));

  const url = `http://127.0.0.1:${port}/render/lasernations/index.html`
    + `?render=1&seed=${opts.seed}&sec=${opts.sec}&bh=${opts.bh ? 1 : 0}`
    + (opts.duel ? '&duel=1' : '')
    + (opts.poster ? '&poster=1' : '')
    + (opts.a ? `&a=${encodeURIComponent(opts.a)}` : '')
    + (opts.b ? `&b=${encodeURIComponent(opts.b)}` : '')
    + `&fps=${opts.fps}&w=${opts.w}&h=${opts.h}&ss=${opts.ss}`;
  log(`seed ${opts.seed} · ${opts.duel ? 'DUEL' : 'territory'}${opts.poster ? ' · POSTER' : ''} · ~${opts.sec}s @ ${opts.fps}fps · capture ${opts.w * opts.ss}×${opts.h * opts.ss} → out ${opts.w * opts.out}×${opts.h * opts.out}${opts.duel ? ` · ${opts.a || 'random'} vs ${opts.b || 'random'}` : ` · black-hole ${opts.bh ? 'on' : 'off'}`}`);
  progress(0.02, 'loading the arena');
  await page.goto(url, { waitUntil: 'load' });

  const err = await page.evaluate(() => window.__LN_ERROR || null);
  if (err) throw new Error('page error: ' + err);

  await page.waitForFunction(() => window.LN && window.LN.meta, null, { timeout: 30000 });
  const meta = await page.evaluate(() => window.LN.meta);
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
    const r = await page.evaluate(() => window.LN.step());
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

  const result = await page.evaluate(() => window.LN.result());
  if (!opts.poster) {
    result.width = Math.round(opts.w * opts.out);      // final mp4 size (4K by default)
    result.height = Math.round(opts.h * opts.out);
    result.frameWidth = Math.round(opts.w * opts.ss);  // on-disk capture size
    result.frameHeight = Math.round(opts.h * opts.ss);
    result.ss = opts.ss;
  }

  await writeFile(opts.outJson, JSON.stringify(result, null, 2));
  if (!opts.poster) {
    await writeFile(
      join(opts.outFrames, 'events.json'),
      JSON.stringify({ fps: meta.fps, durationSec: result.durationSec, blackHole: result.blackHole, mode: result.mode || 'territory', events: allEvents }),
    );
  }

  if (opts.poster) log(`poster frame captured (${opts.a || 'random'} vs ${opts.b || 'random'})`);
  else log(`winner ${result.winner} · ${result.frames} frames · ${result.durationSec}s · ${allEvents.length} sound events`);
  progress(1, 'done');

  await browser.close();
  server.close();

  if (opts.poster || !opts.mux) {
    process.stdout.write(JSON.stringify(result));
    return;
  }

  // ---- local-dev convenience: synth audio + mux a watchable mp4 (mirrors
  //      worker/src/pipeline/steps/lasernations.ts's own, slightly fuller pass) ----
  await mkdir(opts.muxDir, { recursive: true });
  const rawWav = join(opts.outFrames, '_audio_raw.wav');
  const finalWav = join(opts.outFrames, '_audio_final.wav');
  const outMp4 = join(opts.muxDir, `lasernations${opts.duel ? '-duel' : ''}-${opts.seed}.mp4`);

  progress(0, 'scoring the sound');
  await pexec(PY, [join(REPO, 'python/lasernations_audio.py'),
    '--events', join(opts.outFrames, 'events.json'), '--duration', String(result.durationSec), '--out', rawWav],
    { cwd: REPO, maxBuffer: 1 << 24 });
  const comp = opts.duel
    ? 'highpass=f=55,acompressor=threshold=-20dB:ratio=3:attack=8:release=200'
    : 'highpass=f=70,acompressor=threshold=-24dB:ratio=3.2:attack=12:release=260,treble=g=-3:f=5500:width_type=q:w=0.7';
  const target = opts.duel ? 'I=-16:TP=-1.5:LRA=9' : 'I=-24.5:TP=-3.5:LRA=10';
  await pexec(FFMPEG, ['-y', '-i', rawWav, '-af', `${comp},loudnorm=${target}`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', finalWav],
    { cwd: REPO, maxBuffer: 1 << 24 });

  progress(0.5, 'compositing');
  const vf = ['scale=' + result.width + ':' + result.height + ':flags=lanczos+accurate_rnd+full_chroma_int', 'unsharp=5:5:0.5:5:5:0.0', 'format=yuv420p'].join(',');
  await pexec(FFMPEG, ['-y', '-framerate', String(result.fps), '-start_number', '1',
    '-i', join(opts.outFrames, 'f_%05d.jpg'), '-i', finalWav, '-map', '0:v', '-map', '1:a', '-vf', vf,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-x264-params', 'aq-mode=3:aq-strength=0.9',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-shortest', outMp4],
    { cwd: REPO, maxBuffer: 1 << 24 });

  await rm(opts.outFrames, { recursive: true, force: true });
  progress(1, 'done');
  log(`   ✅  ${outMp4}`);
  process.stdout.write(JSON.stringify({ ...result, mp4: outMp4 }));
};

main().catch((e) => { log('ERROR ' + (e.stack || e.message)); process.exit(1); });

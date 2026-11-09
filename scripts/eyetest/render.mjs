// Headless renderer for "Eye Test".
//
// Boots the static server, drives the 2-D Canvas tracking challenge in
// headless Chrome one frame at a time (deterministic — seeded RNG),
// screenshots each frame, and records the per-frame sound-event log the
// audio pass turns into a soundtrack.
//
//   node scripts/eyetest/render.mjs --seed 7 --balls 8,8,6 --shuffle 6 \
//        --fps 60 --out-frames /path/frames --out /path/result.json
//
//   --balls   comma-separated ball count PER ROUND (list length = round
//             count, 1-6 rounds, 4-10 balls each). Default "8,8,8".
//   --shuffle how many seconds the real-physics scatter phase runs, EVERY
//             round (3-15). Default 6.
//   --mux : also synthesise audio + ffmpeg-mux a watchable
//           eyetest-<rounds>r-<seed>.mp4 (the studio "RENDER THIS" path)
//   --queue <file> : render every "<seed> [ballsCSV] [shuffleSec]" line in
//           the file (missing fields fall back to --balls/--shuffle)

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
function numArg(name, def, int) {
  const raw = arg(name, undefined);
  if (raw === undefined || raw === true) return def;
  const n = int ? parseInt(raw, 10) : parseFloat(raw);
  return Number.isFinite(n) ? n : def;
}
function normalizeBalls(raw) {
  const nums = String(raw ?? '')
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.max(4, Math.min(10, n)))
    .slice(0, 6);
  return (nums.length ? nums : [8, 8, 8]).join(',');
}
function normalizeShuffle(raw) {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? Math.max(3, Math.min(15, n)) : 6;
}

const opts = {
  seed: numArg('seed', Math.floor(Math.random() * 1e9), true) >>> 0,
  balls: normalizeBalls(arg('balls', '8,8,8')),
  shuffle: normalizeShuffle(arg('shuffle', 6)),
  // safety frame-cap override (seconds). Absent -> the game estimates it
  // from the round plan itself. Ceiling widened (was 90) for long plans.
  sec: arg('sec', undefined) === undefined || arg('sec', undefined) === true
    ? null : Math.max(8, Math.min(160, parseFloat(arg('sec')) || 0)) || null,
  fps: numArg('fps', 60, true),
  w: numArg('w', 1080, true),
  h: numArg('h', 1920, true),
  // ss=2 captures at exactly the 4K output resolution (no ffmpeg scaling at
  // all), which measured as sharp as ss=3 with ~4-5x less per-frame
  // screenshot-capture time in CI (not in the current posting rotation, but
  // shares the same render.mjs pattern as the 3 that are).
  ss: Math.max(1, Math.min(4, numArg('ss', 2))),
  out: Math.max(1, Math.min(4, numArg('out-scale', 2))),
  outFrames: arg('out-frames', join(process.cwd(), 'render/eyetest/_frames')),
  outJson: arg('out', join(process.cwd(), 'render/eyetest/_result.json')),
  mux: arg('mux', false) !== false,
  muxDir: String(arg('mux-dir', join(process.cwd(), 'render/eyetest/out'))),
  queue: arg('queue', undefined) === undefined || arg('queue', undefined) === true ? null : String(arg('queue')),
};

const FFMPEG = ['/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg']
  .find((p) => p === 'ffmpeg' || existsSync(p)) || 'ffmpeg';
const VENV_PY = join(REPO, 'python/.venv/bin/python');
const PY = existsSync(VENV_PY) ? VENV_PY : 'python3';

function log(m) { process.stderr.write(m + '\n'); }
function progress(pct, msg) {
  process.stderr.write('@progress ' + JSON.stringify({ pct: Math.max(0, Math.min(1, pct)), msg }) + '\n');
}

const renderOne = async (seed, balls, shuffleSec) => {
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
    else if (t.startsWith('[ET]')) log('  ' + t);
  });
  page.on('pageerror', (e) => log('  [pageerror] ' + e.message));

  const url = `http://127.0.0.1:${port}/render/eyetest/index.html`
    + `?render=1&seed=${seed}&balls=${encodeURIComponent(balls)}&shuffle=${shuffleSec}`
    + (opts.sec ? `&sec=${opts.sec}` : '')
    + `&fps=${opts.fps}&w=${opts.w}&h=${opts.h}&ss=${opts.ss}`;
  log(`\n━━ EYE TEST · seed ${seed} · balls ${balls} · shuffle ${shuffleSec}s${opts.sec ? ` · cap ${opts.sec}s` : ''} · @ ${opts.fps}fps · capture ${opts.w * opts.ss}×${opts.h * opts.ss} → out ${opts.w * opts.out}×${opts.h * opts.out} ━━`);
  progress(0.02, 'loading the game');
  await page.goto(url, { waitUntil: 'load' });

  const err = await page.evaluate(() => window.__ET_ERROR || null);
  if (err) throw new Error('page error: ' + err);

  await page.waitForFunction(() => window.ET && window.ET.meta, null, { timeout: 30000 });
  const meta = await page.evaluate(() => window.ET.meta);
  log('meta: ' + JSON.stringify(meta));

  const cdp = await page.context().newCDPSession(page);
  const allEvents = [];
  const writes = [];
  let frame = 0;
  const cap = meta.totalFrames;

  while (true) {
    const r = await page.evaluate(() => window.ET.step());
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

  const result = await page.evaluate(() => window.ET.result());
  result.width = Math.round(opts.w * opts.out);
  result.height = Math.round(opts.h * opts.out);
  result.frameWidth = Math.round(opts.w * opts.ss);
  result.frameHeight = Math.round(opts.h * opts.ss);
  result.ss = opts.ss;

  await writeFile(opts.outJson, JSON.stringify(result, null, 2));
  await writeFile(
    join(opts.outFrames, 'events.json'),
    JSON.stringify({
      fps: meta.fps, durationSec: result.durationSec,
      rounds: result.rounds, ballsPerRound: result.ballsPerRound, shuffleSec: result.shuffleSec,
      events: allEvents,
    }),
  );

  log(`   seed ${seed} → ${result.rounds} round(s) (${result.ballsPerRound.join(',')} balls) · answers ${result.answers.join(' ')} · ${result.frames} frames · ${allEvents.length} sound events`);
  progress(1, 'frames done');

  await browser.close();
  server.close();
  return result;
};

/* synthesise audio + ffmpeg-mux a finished mp4 (studio "RENDER THIS" path).
   Mirrors worker/src/pipeline/steps/eyetest.ts. */
const mux = async (result, seed) => {
  await mkdir(opts.muxDir, { recursive: true });
  const framesDir = opts.outFrames;
  const rawWav = join(framesDir, '_audio_raw.wav');
  const finalWav = join(framesDir, '_audio_final.wav');
  const outMp4 = join(opts.muxDir, `eyetest-${result.rounds}r-${seed}.mp4`);

  progress(0.9, 'scoring the sound');
  await pexec(PY, [join(REPO, 'python/eyetest_audio.py'),
    '--events', join(framesDir, 'events.json'), '--duration', String(result.durationSec), '--out', rawWav],
    { cwd: REPO, maxBuffer: 1 << 24 });

  const comp = 'highpass=f=64,acompressor=threshold=-22dB:ratio=3:attack=8:release=200';
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
      const [s, b, sh] = line.split(/\s+/);
      const seed = (parseInt(s, 10) >>> 0) || 1;
      const balls = normalizeBalls(b || opts.balls);
      const shuffleSec = normalizeShuffle(sh || opts.shuffle);
      const result = await renderOne(seed, balls, shuffleSec);
      outs.push(await mux(result, seed));
    }
    log(`\nqueue done — ${outs.length} clip(s):\n${outs.map((o) => '  ' + o).join('\n')}`);
    return;
  }

  const result = await renderOne(opts.seed, opts.balls, opts.shuffle);
  const mp4 = opts.mux ? await mux(result, opts.seed) : null;
  process.stdout.write(JSON.stringify(mp4 ? { ...result, mp4 } : result));
};

main().catch((e) => { log('ERROR ' + (e.stack || e.message)); process.exit(1); });

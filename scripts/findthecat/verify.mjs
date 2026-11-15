// Automated checks for Find The Cat. Renders a short and a long sample
// into render/findthecat/samples/ and asserts:
//   1. ffprobe: 9:16 at 1080x1920 (or 2160x3840), 60 fps, H.264 + AAC, for
//      both the full-audio and SFX-only files; short 15-30s, long > 60s
//   2. frame 1 is already moving (frame 0 vs 0.1s differ), the hook text is
//      on screen at frame 1 (measured from the DOM during the render), and
//      the last frame is close enough to the first to loop
//   3. 20 seeded headless sims: no cup or the cat ever leaves the stage, no
//      two resting cups ever share a slot, every answer is a real cup, and
//      the same seed always gives the same answers
//   4. safe zone: every piece of text and every resting cup / the revealed
//      cat stays out of TikTok's top 10%, bottom 20% and right 15%
//   5. two renders with different seeds look visibly different at frame 1
//
//   node scripts/findthecat/verify.mjs            # renders samples + all checks
//   node scripts/findthecat/verify.mjs --no-render  # reuse existing samples
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { startServer } from '../followball/serve.mjs';

const pexec = promisify(execFile);
const REPO = resolve(new URL('../..', import.meta.url).pathname);
const SAMPLES = join(REPO, 'render/findthecat/samples');
const FFMPEG = '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/opt/ffmpeg-full/bin/ffprobe';
const NO_RENDER = process.argv.includes('--no-render');
const SHORT_SEED = 1101, LONG_SEED = 2202;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
};

async function renderSample(length, seed) {
  await pexec(process.execPath, [
    join(REPO, 'scripts/findthecat/render.mjs'), '--length', length, '--seed', String(seed),
    '--fps', '60', '--ss', '1', '--res', '1080', '--label', 'Find The Cat S1 E1', '--mux', '--mux-dir', SAMPLES,
    '--out-frames', join(SAMPLES, `_frames_${length}`), '--out', join(SAMPLES, `_result_${length}.json`),
  ], { cwd: REPO, maxBuffer: 1 << 26 });
}

const findSample = (length, seed, suffix) => {
  const f = readdirSync(SAMPLES).find((n) => n.startsWith(`findthecat-${length}-`) && n.endsWith(`-seed${seed}${suffix}`));
  return f ? join(SAMPLES, f) : null;
};

async function probe(file) {
  const { stdout } = await pexec(FFPROBE, ['-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration', '-of', 'json', file]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const [num, den] = v.r_frame_rate.split('/').map(Number);
  return { width: v.width, height: v.height, fps: num / den, vcodec: v.codec_name, acodec: a && a.codec_name, duration: +j.format.duration };
}

/** a 108x192 grayscale thumbnail of the frame at time t, as raw bytes */
async function grayFrame(file, t) {
  const { stdout } = await pexec(FFMPEG, ['-v', 'error', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1',
    '-vf', 'scale=108:192:flags=area,format=gray', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 });
  return stdout;
}
const meanAbsDiff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

/* ── headless helpers ─────────────────────────────────────────── */
async function withPage(fn) {
  const { server, port } = await startServer(0);
  const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true, args: ['--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  try {
    return await fn(page, (q) => `http://127.0.0.1:${port}/render/findthecat/index.html?render=1&fps=30&ss=1&${q}`);
  } finally {
    await browser.close();
    server.close();
  }
}

async function bootGame(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.FTB && window.FTB.meta, null, { timeout: 30000 });
}

async function simulateAll(page, url) {
  await bootGame(page, url);
  return page.evaluate(() => {
    const TABLE_Y = 1230, bad = [];
    let frames = 0, done = false;
    while (!done && frames < 20000) {
      done = window.FTB.step().done;
      frames++;
      const s = window.FTB.debugState();
      for (const e of s.entries) {
        if (e.x - s.cupW / 2 < -1 || e.x + s.cupW / 2 > 1081) bad.push({ t: s.t, why: 'cup off stage (x)', x: e.x });
        if (TABLE_Y + e.yOff > 1920 + 1) bad.push({ t: s.t, why: 'cup below stage', yOff: e.yOff });
      }
      if (s.phase === 'shuffle' || s.phase === 'guess') {
        const resting = s.entries.filter((e) => !e.moving && e.slot >= 0).map((e) => e.slot);
        if (new Set(resting).size !== resting.length) bad.push({ t: s.t, why: 'two resting cups share a slot', resting });
      }
      if (s.ball.show && (s.ball.x - s.ballD / 2 < -1 || s.ball.x + s.ballD / 2 > 1081)) bad.push({ t: s.t, why: 'cat off stage', x: s.ball.x });
    }
    const r = window.FTB.result();
    r.answers.forEach((a, i) => { if (!(a >= 1 && a <= r.cups[i])) bad.push({ why: 'answer is not a real cup', round: i + 1, a }); });
    return { frames, answers: r.answers, cups: r.cups, violations: bad.slice(0, 5), violationCount: bad.length };
  });
}

/* every important element's on-screen box, in 1080x1920 frame pixels */
async function safeZoneSample(page) {
  return page.evaluate(() => {
    const box = (r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom });
    const textBox = (id) => {
      const n = document.getElementById(id);
      if (!n || !n.textContent.trim() || getComputedStyle(n).display === 'none') return null;
      let p = n; while (p) { if (getComputedStyle(p).display === 'none' || +getComputedStyle(p).opacity < 0.05) return null; p = p.parentElement; }
      const range = document.createRange(); range.selectNodeContents(n);
      return box(range.getBoundingClientRect());
    };
    const out = {};
    for (const id of ['roundLabel', 'diffChip', 'titleText', 'titleSub', 'cdNum', 'caption', 'seriesLabel']) {
      const b = id === 'diffChip' ? box(document.getElementById(id).getBoundingClientRect()) : textBox(id);
      if (b) out[id] = b;
    }
    const cd = document.getElementById('cdWrap');
    if (getComputedStyle(cd).display !== 'none') out.countdownRing = box(cd.getBoundingClientRect());
    const s = window.FTB.debugState();
    const k = s.stage.w / 1080;
    const at = (x, y) => ({ x: s.stage.x + x * k, y: s.stage.y + y * k });
    // resting cups only — cups dropping in / flying off cross the edges by design
    s.entries.filter((e) => !e.moving && Math.abs(e.yOff) < 1 && s.phase !== 'intro' && s.phase !== 'outro').forEach((e, i) => {
      const tl = at(e.x - s.cupW / 2, 1230 - s.cupH), br = at(e.x + s.cupW / 2, 1230);
      out['cup' + i] = { l: tl.x, t: tl.y, r: br.x, b: br.y };
    });
    if (s.ball.show && s.phase === 'reveal') {
      const c = at(s.ball.x, s.ball.cy), rad = (s.ballD / 2) * k;
      out.cat = { l: c.x - rad, t: c.y - rad, r: c.x + rad, b: c.y + rad };
    }
    return { t: s.t, phase: s.phase, boxes: out };
  });
}

async function main() {
  await mkdir(SAMPLES, { recursive: true });
  if (!NO_RENDER) {
    console.log('rendering the short sample…');
    await renderSample('short', SHORT_SEED);
    console.log('rendering the long sample…');
    await renderSample('long', LONG_SEED);
  }

  // ── 1. export specs ──────────────────────────────────────────
  for (const [length, seed] of [['short', SHORT_SEED], ['long', LONG_SEED]]) {
    for (const suffix of ['.mp4', '_sfx.mp4']) {
      const file = findSample(length, seed, suffix);
      if (!file) { check(`${length}${suffix} exists`, false); continue; }
      const p = await probe(file);
      const sizeOk = (p.width === 1080 && p.height === 1920) || (p.width === 2160 && p.height === 3840);
      check(`${length}${suffix}: 9:16 size`, sizeOk, `${p.width}x${p.height}`);
      check(`${length}${suffix}: 60 fps`, Math.abs(p.fps - 60) < 0.01, `${p.fps}`);
      check(`${length}${suffix}: H.264 + AAC`, p.vcodec === 'h264' && p.acodec === 'aac', `${p.vcodec}/${p.acodec}`);
      if (length === 'short') check(`${length}${suffix}: 15-30s`, p.duration >= 15 && p.duration <= 30, `${p.duration}s`);
      else check(`${length}${suffix}: over 60s (Creator Rewards)`, p.duration > 60, `${p.duration}s`);
    }
    for (const suffix of ['_cover.png', '.txt', '.json']) check(`${length}${suffix} written`, !!findSample(length, seed, suffix));
    const txt = findSample(length, seed, '.txt');
    if (txt) {
      const caption = readFileSync(txt, 'utf8').split('\n')[1];
      const tags = (readFileSync(txt, 'utf8').split('\n')[3] || '').split(' ').filter((t) => t.startsWith('#'));
      check(`${length} caption: keyword first, has a question, no dashes, 3-5 hashtags`,
        /^find the cat/i.test(caption) && caption.includes('?') && !/[-–—]/.test(caption) && tags.length >= 3 && tags.length <= 5,
        { caption, tags: tags.length });
    }
  }

  // ── 2. hook / motion / loop ──────────────────────────────────
  for (const [length, seed] of [['short', SHORT_SEED], ['long', LONG_SEED]]) {
    const file = findSample(length, seed, '.mp4');
    const cfg = JSON.parse(readFileSync(findSample(length, seed, '.json'), 'utf8'));
    const p = await probe(file);
    const f0 = await grayFrame(file, 0);
    const f01 = await grayFrame(file, 0.1);
    const f1 = await grayFrame(file, 1.0);
    const fLast = await grayFrame(file, p.duration - 1.5 / 60);
    check(`${length}: frame 1 already in motion`, meanAbsDiff(f0, f01) > 0.5, `frame 0 vs 0.1s mean diff ${meanAbsDiff(f0, f01).toFixed(2)}`);
    check(`${length}: still moving at 1s`, meanAbsDiff(f01, f1) > 0.5, `0.1s vs 1s mean diff ${meanAbsDiff(f01, f1).toFixed(2)}`);
    const hook = cfg.frame1Hook;
    check(`${length}: hook text on screen at frame 1`, hook && hook.text && hook.opacity >= 0.95,
      hook ? `"${hook.text}" / "${hook.sub}" opacity ${hook.opacity}` : 'missing');
    check(`${length}: hook names the game ("CUP GAME" / "CAT")`, hook && /CAT/.test(hook.text) && /CUP GAME/.test(hook.sub));
    const loopDiff = meanAbsDiff(f0, fLast);
    check(`${length}: last frame close enough to frame 1 to loop`, loopDiff < 20, `mean diff ${loopDiff.toFixed(2)} / 255`);
  }

  // ── 5. different seeds look different ────────────────────────
  {
    const a = await grayFrame(findSample('short', SHORT_SEED, '.mp4'), 0);
    const b = await grayFrame(findSample('long', LONG_SEED, '.mp4'), 0);
    const ca = JSON.parse(readFileSync(findSample('short', SHORT_SEED, '.json'), 'utf8'));
    const cb = JSON.parse(readFileSync(findSample('long', LONG_SEED, '.json'), 'utf8'));
    check('different seeds look different at frame 1', meanAbsDiff(a, b) > 3,
      `${ca.signature} vs ${cb.signature}, mean diff ${meanAbsDiff(a, b).toFixed(2)}`);
  }

  // ── 3. 20 seeded headless sims + determinism ─────────────────
  await withPage(async (page, url) => {
    let totalFrames = 0, totalBad = 0;
    for (let i = 0; i < 20; i++) {
      const seed = 9000 + i * 37, rounds = (i % 6) + 1;
      const r = await simulateAll(page, url(`seed=${seed}&rounds=${rounds}&theme=random`));
      totalFrames += r.frames; totalBad += r.violationCount;
      if (r.violationCount) check(`sim seed ${seed} (${rounds} rounds)`, false, r.violations);
    }
    check('20 seeded sims: nothing leaves the stage, no overlapping resting cups, valid answers', totalBad === 0,
      `${totalFrames} frames checked, ${totalBad} violation(s)`);
    const a = await simulateAll(page, url('seed=4242&rounds=4&theme=random'));
    const b = await simulateAll(page, url('seed=4242&rounds=4&theme=random'));
    check('same seed, same answers (deterministic)', JSON.stringify(a.answers) === JSON.stringify(b.answers), a.answers);
  });

  // ── 4. safe zone ─────────────────────────────────────────────
  await withPage(async (page, url) => {
    const ZONE = { l: 0, t: 1920 * 0.10, r: 1080 * 0.85, b: 1920 * 0.80 };
    const offenders = [];
    let samples = 0;
    for (const seed of [11, 22, 33]) {
      await bootGame(page, url(`seed=${seed}&rounds=6&theme=random&label=${encodeURIComponent('Find The Cat S1 E3')}`));
      const total = await page.evaluate(() => window.FTB.meta.totalFrames);
      const every = 9;   // ~3 checks a second of video at 30fps
      for (let f = 1; f <= total; f++) {
        await page.evaluate(() => window.FTB.step());
        if (f % every) continue;
        const s = await safeZoneSample(page);
        samples++;
        for (const [name, b] of Object.entries(s.boxes)) {
          if (b.l < ZONE.l - 1 || b.r > ZONE.r + 1 || b.t < ZONE.t - 1 || b.b > ZONE.b + 1) {
            offenders.push({ seed, t: +s.t.toFixed(2), phase: s.phase, name, box: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(v)])) });
          }
        }
      }
    }
    const uniq = [...new Map(offenders.map((o) => [o.name + o.phase, o])).values()];
    check('safe zone: text, resting cups and the revealed cat stay clear of TikTok UI', offenders.length === 0,
      offenders.length ? uniq.slice(0, 6) : `${samples} frames sampled across 3 six-round seeds`);

    // a debug frame with the overlay on, for a human to look at
    await bootGame(page, url('seed=11&rounds=6&theme=random&safezone=1&label=Find%20The%20Cat%20S1%20E3'));
    for (let f = 0; f < Math.round(13.5 * 30); f++) await page.evaluate(() => window.FTB.step());
    await page.screenshot({ path: join(SAMPLES, 'safe-zone-debug.png') });
  });

  const passed = results.filter((r) => r.pass).length;
  await writeFile(join(SAMPLES, 'verify-report.json'), JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results }, null, 2));
  console.log(`\n${passed}/${results.length} checks passed — report: ${join(SAMPLES, 'verify-report.json')}`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

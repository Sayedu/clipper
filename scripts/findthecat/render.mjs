// Headless renderer for "Find The Cat" (the Follow The Ball alt-variant).
//
// Boots the static server, drives the canvas shell game in headless Chrome
// one frame at a time (deterministic — seeded RNG), screenshots each frame,
// and records the per-frame sound-event log the audio pass turns into a
// soundtrack. Every render (this CLI and the dashboard pipeline, which
// shells out to this same script) appends its seed + full config to
// render/findthecat/render-log.jsonl.
//
//   node scripts/findthecat/render.mjs --length long --mux
//   node scripts/findthecat/render.mjs --seed 7 --rounds 3 --theme neon --mux
//   node scripts/findthecat/render.mjs --batch 5 --length short          # 5 varied videos
//
//   --length short|long  preset: short = 1 round (~19s), long = 4 rounds (~75s,
//                        always over 60s). Overrides --rounds.
//   --rounds 1-6         how many rounds (default 3), always starting at round 1
//   --theme              candy | neon | sunset | colorblind | random (default random)
//   --hook "TEXT"        the big opening line (default FIND THE CAT)
//   --hook-sec 1-3       how long the hook line stays up (default 2)
//   --label "TEXT"       optional series label, e.g. "Find The Cat S1 E3"
//   --twists 0|1         per-round visual twists from round 2 on (default 1)
//   --variety            skip seeds whose first-second look was used in the
//                        last 10 renders (on automatically for --batch)
//   --batch N            render N variants with fresh seeds (implies --mux)
//   --res 1080|2160      output height 1920 or 3840 (default 2160 — 4K)
//   --safezone           burn the TikTok UI-zone debug overlay into the video
//   --mux                also synthesise audio + write the finished files:
//                          <base>.mp4        full audio (SFX + cat laugh clip)
//                          <base>_sfx.mp4    SFX only (100% self-generated)
//                          <base>_cover.png  cover with the hook text
//                          <base>.txt        caption, hashtags, pinned comment
//                          <base>.json       seed + full config
//                        where <base> = findthecat-<mode>-<secs>s-seed<seed>
//   --mux-dir DIR        where those go (default render/findthecat/out)

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from '../followball/serve.mjs';
import { LENGTH_ROUNDS, baseName, buildPostKit, coverTimeSec, lengthModeFor, postKitText, writeCover } from './postkit.mjs';
import { appendEntry, loadPlan, pickVarietySeed } from './renderlog.mjs';

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
const strArg = (name, def) => { const v = arg(name, undefined); return v === undefined || v === true ? def : String(v); };

const THEMES = new Set(['candy', 'neon', 'sunset', 'colorblind', 'random']);
const lengthArg = strArg('length', '').toLowerCase();
const batch = Math.max(0, Math.min(50, numArg('batch', 0, true)));

const opts = {
  seed: arg('seed', undefined) === undefined ? null : numArg('seed', 1, true) >>> 0,
  rounds: LENGTH_ROUNDS[lengthArg] ?? Math.max(1, Math.min(6, numArg('rounds', 3, true))),
  theme: THEMES.has(strArg('theme', 'random').toLowerCase()) ? strArg('theme', 'random').toLowerCase() : 'random',
  hook: strArg('hook', ''),
  hookSec: Math.max(1, Math.min(3, numArg('hook-sec', 2))),
  // --nohook: hide the fixed round 1 title; the post packaging adds its own hook
  nohook: arg('nohook', false) !== false,
  label: strArg('label', ''),
  twists: strArg('twists', '1') !== '0',
  variety: arg('variety', false) !== false || batch > 0,
  safezone: arg('safezone', false) !== false,
  fps: numArg('fps', 60, true),
  w: numArg('w', 1080, true),
  h: numArg('h', 1920, true),
  // ss = deviceScaleFactor: frames are captured at ss× the 1080x1920 layout
  ss: Math.max(1, Math.min(4, numArg('ss', 2))),
  out: strArg('res', '') === '1080' ? 1 : Math.max(1, Math.min(4, numArg('out-scale', 2))),
  outFrames: strArg('out-frames', join(process.cwd(), 'render/findthecat/_frames')),
  outJson: strArg('out', join(process.cwd(), 'render/findthecat/_result.json')),
  mux: arg('mux', false) !== false || batch > 0,
  muxDir: strArg('mux-dir', join(process.cwd(), 'render/findthecat/out')),
};

const FFMPEG = ['/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg']
  .find((p) => p === 'ffmpeg' || existsSync(p)) || 'ffmpeg';
const VENV_PY = join(REPO, 'python/.venv/bin/python');
const PY = existsSync(VENV_PY) ? VENV_PY : 'python3';

function log(m) { process.stderr.write(m + '\n'); }
function progress(pct, msg) {
  process.stderr.write('@progress ' + JSON.stringify({ pct: Math.max(0, Math.min(1, pct)), msg }) + '\n');
}
const randSeed = () => (Math.floor(Math.random() * 2_000_000_000) >>> 0) || 1;
const planOpts = () => ({ rounds: opts.rounds, theme: opts.theme, twists: opts.twists });

async function gitCommit() {
  try { return (await pexec('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO })).stdout.trim(); } catch { return null; }
}

const renderOne = async (seed) => {
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
  page.on('console', (m) => { if (m.type() === 'error') log('  [page] ' + m.text()); });
  page.on('pageerror', (e) => log('  [pageerror] ' + e.message));

  const q = new URLSearchParams({
    render: '1', seed: String(seed), rounds: String(opts.rounds), theme: opts.theme,
    hooksec: String(opts.hookSec), twists: opts.twists ? '1' : '0',
    fps: String(opts.fps), w: String(opts.w), h: String(opts.h), ss: String(opts.ss),
  });
  if (opts.hook) q.set('hook', opts.hook);
  if (opts.label) q.set('label', opts.label);
  if (opts.safezone) q.set('safezone', '1');
  if (opts.nohook) q.set('nohook', '1');
  const url = `http://127.0.0.1:${port}/render/findthecat/index.html?${q}`;
  log(`\n━━ FIND THE CAT · seed ${seed} · ${opts.rounds} round(s) (${lengthModeFor(opts.rounds)}) · theme ${opts.theme} · @ ${opts.fps}fps · capture ${opts.w * opts.ss}×${opts.h * opts.ss} → out ${opts.w * opts.out}×${opts.h * opts.out} ━━`);
  progress(0.02, 'loading the game');
  await page.goto(url, { waitUntil: 'load' });

  const err = await page.evaluate(() => window.__FTC_ERROR || null);
  if (err) throw new Error('page error: ' + err);
  await page.waitForFunction(() => window.FTB && window.FTB.meta, null, { timeout: 30000 });
  const meta = await page.evaluate(() => window.FTB.meta);

  const cdp = await page.context().newCDPSession(page);
  const allEvents = [];
  const writes = [];
  let frame = 0, frame1Hook = null;
  const cap = meta.totalFrames;

  while (true) {
    const r = await page.evaluate(() => window.FTB.step());
    frame = r.frame;
    // proof for the verify step that frame 1 already shows the hook text
    if (frame === 1) {
      frame1Hook = await page.evaluate(() => {
        const tt = document.getElementById('titleText');
        const range = document.createRange(); range.selectNodeContents(tt);
        const b = range.getBoundingClientRect();
        return {
          text: tt.textContent, sub: document.getElementById('titleSub').textContent,
          opacity: +getComputedStyle(document.getElementById('titleWrap')).opacity,
          box: { x: b.left, y: b.top, w: b.width, h: b.height },
        };
      });
    }
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

  const result = await page.evaluate(() => window.FTB.result());
  Object.assign(result, {
    lengthMode: lengthModeFor(result.roundCount),
    width: Math.round(opts.w * opts.out), height: Math.round(opts.h * opts.out),
    frameWidth: Math.round(opts.w * opts.ss), frameHeight: Math.round(opts.h * opts.ss), ss: opts.ss,
    frame1Hook, signature: loadPlan().signature(loadPlan().buildPlan(seed, planOpts())),
    renderedAt: new Date().toISOString(), commit: await gitCommit(),
  });
  if (opts.nohook) result.nohook = true;
  // the Creator Rewards guarantee: a long render can never come out at 60s or less
  if (result.lengthMode === 'long' && result.durationSec <= 60) {
    throw new Error(`long render came out at ${result.durationSec}s — must be over 60s`);
  }

  await writeFile(opts.outJson, JSON.stringify(result, null, 2));
  await writeFile(
    join(opts.outFrames, 'events.json'),
    JSON.stringify({ fps: meta.fps, durationSec: result.durationSec, events: allEvents }),
  );
  await appendEntry({
    at: result.renderedAt, seed: result.seed, signature: result.signature, lengthMode: result.lengthMode,
    rounds: result.roundCount, durationSec: result.durationSec, theme: result.theme, backdrop: result.backdrop,
    cups: result.cups, twists: result.twists, hook: result.hook, label: result.label, commit: result.commit,
    config: opts.outJson,
  });

  log(`   seed ${seed} → answers ${result.answers.join(' ')} (${result.difficulty.join('/')}) · ${result.theme}/${result.backdrop} · ${result.frames} frames · ${allEvents.length} sound events`);
  progress(1, 'frames done');
  await browser.close();
  server.close();
  return result;
};

/* two-pass loudnorm: present and satisfying, never loud */
async function finalizeAudio(rawWav, outWav) {
  const comp = 'highpass=f=60,acompressor=threshold=-22dB:ratio=3:attack=8:release=200';
  let ln = 'loudnorm=I=-20:TP=-2:LRA=9';
  try {
    const { stderr } = await pexec(FFMPEG,
      ['-hide_banner', '-i', rawWav, '-af', `${comp},${ln}:print_format=json`, '-f', 'null', '-'],
      { cwd: REPO, maxBuffer: 1 << 24 }).catch((e) => ({ stderr: e.stderr || '' }));
    const j = JSON.parse((stderr.match(/\{[\s\S]*?\}/g) || []).at(-1));
    ln = `loudnorm=I=-20:TP=-2:LRA=9:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
  } catch { /* single-pass */ }
  await pexec(FFMPEG, ['-y', '-i', rawWav, '-af', `${comp},${ln},alimiter=limit=0.9`,
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', outWav], { cwd: REPO, maxBuffer: 1 << 24 });
}

/* synthesise both audio mixes, encode the video once, mux both, write the
   post kit. Mirrors worker/src/pipeline/steps/findthecat.ts. */
const mux = async (result) => {
  await mkdir(opts.muxDir, { recursive: true });
  const framesDir = opts.outFrames;
  const base = baseName(result);
  const out = (suffix) => join(opts.muxDir, base + suffix);
  const events = join(framesDir, 'events.json');

  progress(0.9, 'scoring the sound');
  for (const [raw, extra] of [['_full_raw.wav', []], ['_sfx_raw.wav', ['--no-clip']]]) {
    await pexec(PY, [join(REPO, 'python/findthecat_audio.py'), '--events', events,
      '--duration', String(result.durationSec), '--out', join(framesDir, raw), ...extra], { cwd: REPO, maxBuffer: 1 << 24 });
  }
  await finalizeAudio(join(framesDir, '_full_raw.wav'), join(framesDir, '_full.wav'));
  await finalizeAudio(join(framesDir, '_sfx_raw.wav'), join(framesDir, '_sfx.wav'));

  progress(0.93, 'encoding video');
  const videoOnly = join(framesDir, '_video.mp4');
  const needsScale = result.frameWidth !== result.width || result.frameHeight !== result.height;
  const vf = [
    needsScale ? `scale=${result.width}:${result.height}:flags=lanczos+accurate_rnd+full_chroma_int` : null,
    'unsharp=3:3:0.6:3:3:0.0', 'format=yuv420p',
  ].filter(Boolean).join(',');
  await pexec(FFMPEG, ['-y', '-framerate', String(result.fps), '-start_number', '1',
    '-i', join(framesDir, 'f_%05d.png'), '-vf', vf,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '17', '-x264-params', 'aq-mode=3:aq-strength=0.8',
    '-pix_fmt', 'yuv420p', '-r', String(result.fps), '-an', videoOnly], { cwd: REPO, maxBuffer: 1 << 24 });

  progress(0.97, 'muxing');
  const files = { video: out('.mp4'), sfxOnly: out('_sfx.mp4'), cover: out('_cover.png'), postKit: out('.txt'), config: out('.json') };
  for (const [wav, dest] of [['_full.wav', files.video], ['_sfx.wav', files.sfxOnly]]) {
    await pexec(FFMPEG, ['-y', '-i', videoOnly, '-i', join(framesDir, wav), '-map', '0:v', '-map', '1:a',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-shortest', dest], { cwd: REPO, maxBuffer: 1 << 24 });
  }

  const kit = buildPostKit(result);
  try {
    await writeCover({ ffmpeg: FFMPEG, video: files.video, atSec: coverTimeSec(result), out: files.cover, hook: kit.hook, sub: kit.coverSub });
  } catch (e) {
    log(`   cover skipped: ${e.message}`);   // an extra — never worth failing the render over
    files.cover = null;
  }
  await writeFile(files.postKit, postKitText(kit, result, files));
  await writeFile(files.config, JSON.stringify({ ...result, postKit: kit, files }, null, 2));

  await rm(framesDir, { recursive: true, force: true });
  progress(1, 'done');
  log(`   ✅  ${files.video}\n       ${files.sfxOnly}\n       ${files.cover}\n       ${files.postKit}`);
  return files;
};

async function chooseSeed(requested) {
  if (requested && !opts.variety) return requested;
  const v = await pickVarietySeed(requested || randSeed(), planOpts());
  log(`   variety: seed ${v.seed} (${v.signature})${v.rerolls ? ` after ${v.rerolls} reroll(s)` : ''}${v.repeated ? ' — every candidate was recent, using the least recently seen look' : ''}`);
  return v.seed;
}

const main = async () => {
  if (batch > 0) {
    const made = [];
    for (let i = 0; i < batch; i++) {
      log(`\n── batch ${i + 1}/${batch} ──`);
      const result = await renderOne(await chooseSeed(null));
      made.push(await mux(result));
    }
    log(`\nbatch done — ${made.length} video(s) in ${opts.muxDir}`);
    process.stdout.write(JSON.stringify(made));
    return;
  }
  const result = await renderOne(await chooseSeed(opts.seed));
  const files = opts.mux ? await mux(result) : null;
  process.stdout.write(JSON.stringify(files ? { ...result, files } : result));
};

main().catch((e) => { log('ERROR ' + (e.stack || e.message)); process.exit(1); });

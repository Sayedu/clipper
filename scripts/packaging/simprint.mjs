// Gameplay fingerprint for the posted games. Runs each simulation at fixed
// seeds and hashes everything gameplay is made of: every frame's playfield
// pixels (= every object's position), every event the sim emits, and the
// final result (outcome, answers, timings). Two code versions with the same
// fingerprint play out identically.
//
//   node scripts/packaging/simprint.mjs --root <repo checkout> [--extra "nohook=1"] [--out file.json]
//
// --root lets the verifier fingerprint an older checkout (a git worktree of
// the pre-change tag) with this same script, so "before" and "after" are
// measured the same way. --extra adds query params (e.g. the packaging
// display flags) to prove they change no gameplay pixels either.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';

const pexec = promisify(execFile);
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const ROOT = resolve(arg('root', process.cwd()));
const EXTRA = arg('extra', '');
const OUT = arg('out', null);
const ONLY = arg('games', '');
const MAIN = resolve(new URL('../..', import.meta.url).pathname);

// fps 60 like production; ss 1 keeps the canvases small enough to hash every frame
const BROWSER = {
  colorwar: { api: 'CW', runs: [['mode=classic', 11], ['mode=classic', 4242]] },
  followball: { api: 'FTB', runs: [['mode=sprint', 11], ['mode=classic', 4242]] },
  eyetest: { api: 'ET', runs: [['', 11], ['', 4242]] },
  findthecat: { api: 'FTB', runs: [['rounds=1', 11], ['rounds=3', 4242]] },
};
const COLORWARS = { ringofdoom: 'ring_of_doom', hotpotato: 'hot_potato' };
const COLORWARS_SEEDS = [11, 4242];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg' };
function serve(root) {
  return new Promise((ok) => {
    const server = createServer(async (req, res) => {
      const p = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
      if (!p.startsWith(root)) return res.writeHead(403).end();
      let body;
      try { body = await readFile(p); } catch { return res.writeHead(404).end(); }
      res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' }).end(body);
    });
    server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port }));
  });
}

// FNV-1a over 32-bit words, chained
const fnv = (h, n) => Math.imul(h ^ (n >>> 0), 16777619) >>> 0;
function hashString(s, h = 2166136261) { for (let i = 0; i < s.length; i++) h = fnv(h, s.charCodeAt(i)); return h; }

async function browserGame(page, port, name) {
  const { api, runs } = BROWSER[name];
  const out = [];
  for (const [query, seed] of runs) {
    const q = [query, EXTRA].filter(Boolean).join('&');
    await page.goto(`http://127.0.0.1:${port}/render/${name}/index.html?render=1&fps=60&ss=1&seed=${seed}&${q}`, { waitUntil: 'load' });
    await page.waitForFunction((a) => window[a] && window[a].meta, api, { timeout: 30000 });
    const total = await page.evaluate((a) => window[a].meta.totalFrames, api);
    let pixels = 2166136261, events = 2166136261, frames = 0;
    const perSecond = [];
    for (let f = 1; f <= total + 600; f++) {
      const r = await page.evaluate((a) => {
        const st = window[a].step();
        let h = 2166136261;
        for (const c of document.querySelectorAll('canvas')) {
          const ctx = c.getContext('2d', { willReadFrequently: true });
          if (!ctx || !c.width || !c.height) continue;
          const d = new Uint32Array(ctx.getImageData(0, 0, c.width, c.height).data.buffer);
          for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619) >>> 0;
          h = Math.imul(h ^ c.width ^ (c.height << 16), 16777619) >>> 0;
        }
        const dbg = typeof window[a].debugState === 'function' ? JSON.stringify(window[a].debugState()) : '';
        return { h, ev: JSON.stringify(st.events ?? []), done: !!st.done, dbg };
      }, api);
      frames = f;
      pixels = fnv(pixels, r.h);
      events = hashString(r.ev + r.dbg, events);
      if (f % 60 === 0) perSecond.push((pixels ^ events) >>> 0);
      if (r.done) break;
    }
    const result = await page.evaluate((a) => window[a].result(), api);
    // a wall-clock or commit stamp is metadata, not gameplay
    for (const k of ['renderedAt', 'commit']) delete result[k];
    out.push({ query, seed, frames, pixels, events, perSecond, result, resultHash: hashString(JSON.stringify(result)) });
    process.stderr.write(`  ${name} ${query || '(default)'} seed ${seed}: ${frames} frames\n`);
  }
  return out;
}

async function colorwarsEvent(id) {
  const py = join(MAIN, 'colorwars', '.venv', 'bin', 'python');
  const out = [];
  for (const seed of COLORWARS_SEEDS) {
    const { stdout } = await pexec(py, [join(MAIN, 'scripts', 'packaging', 'simprint_colorwars.py'), '--code', join(ROOT, 'colorwars'), '--config', join(MAIN, 'colorwars'), '--event', id, '--seed', String(seed)], { maxBuffer: 64 << 20 });
    out.push(JSON.parse(stdout));
    process.stderr.write(`  ${id} seed ${seed}\n`);
  }
  return out;
}

const want = (g) => !ONLY || ONLY.split(',').includes(g);
const report = { root: ROOT, extra: EXTRA, games: {} };
const { server, port } = await serve(ROOT);
const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true, args: ['--mute-audio'] });
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  // Color War and Follow The Ball draw their cosmetic screen shake with
  // unseeded Math.random() on purpose (their sims use their own seeded rnd()),
  // so raw pixels differ run to run even on identical code. A fixed
  // Math.random sequence, the same for every run, makes the shake repeatable
  // without touching anything the sim reads.
  await page.addInitScript(() => {
    let s = 0x2545f491;
    Math.random = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  });
  for (const g of Object.keys(BROWSER)) if (want(g)) report.games[g] = await browserGame(page, port, g);
} finally {
  await browser.close();
  server.close();
}
for (const [g, id] of Object.entries(COLORWARS)) if (want(g)) report.games[g] = await colorwarsEvent(id);

const json = JSON.stringify(report, null, 1);
if (OUT) await writeFile(OUT, json);
else process.stdout.write(json);

// Safe-zone + first-frame check for the posted browser games (Color War,
// Follow The Ball, Eye Test, Find The Cat). Boots each game's render page
// headless, steps through a whole video, and reports:
//   - any visible text, and the playfield itself (#stage — everything the
//     game draws lives inside it), that reaches into TikTok's UI zones:
//     top 10%, bottom 20%, right 15% of the 1080x1920 frame
//   - what text is on screen at frame 1, and whether frame 1 is moving
//
//   node scripts/post/safezone-check.mjs [colorwar followball eyetest findthecat]
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { startServer } from '../followball/serve.mjs';

const pexec = promisify(execFile);
const FFMPEG = '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
const GAMES = {
  colorwar: { api: 'CW', query: 'mode=classic' },
  followball: { api: 'FTB', query: 'mode=sprint' },
  eyetest: { api: 'ET', query: '' },
  findthecat: { api: 'FTB', query: 'rounds=6&label=Find%20The%20Cat%20S1%20E3' },
};
const ZONE = { l: 0, t: 1920 * 0.10, r: 1080 * 0.85, b: 1920 * 0.80 };
const FPS = 30;

async function gray(png) {
  const { stdout } = await pexec(FFMPEG, ['-v', 'error', '-i', png, '-vf', 'scale=108:192:flags=area,format=gray', '-f', 'rawvideo', '-'], { encoding: 'buffer' });
  return stdout;
}
// share of pixels that clearly changed — small moving balls on a big static
// board barely move a mean-difference, but they do flip pixels
const changed = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 24) n++; return (100 * n) / a.length; };

async function checkGame(page, base, name) {
  const { api, query } = GAMES[name];
  const out = { game: name, offenders: [], frame1Text: [], motion: null, samples: 0 };
  const tmp = await mkdtemp(join(tmpdir(), 'sz-'));
  try {
    for (const seed of [101, 202]) {
      await page.goto(`${base}/render/${name}/index.html?render=1&fps=${FPS}&ss=1&seed=${seed}&${query}`, { waitUntil: 'load' });
      await page.waitForFunction((a) => window[a] && window[a].meta, api, { timeout: 30000 });
      const total = Math.min(await page.evaluate((a) => window[a].meta.totalFrames, api), FPS * 75);
      for (let f = 1; f <= total; f++) {
        const r = await page.evaluate((a) => window[a].step(), api);
        if (seed === 101 && f === 1) await page.screenshot({ path: join(tmp, 'f1.png') });
        if (seed === 101 && f === 4) await page.screenshot({ path: join(tmp, 'f4.png') });
        if (f !== 1 && f % 15) { if (r.done) break; continue; }
        const s = await page.evaluate(() => {
          const visible = (n) => { for (let p = n; p && p.nodeType === 1; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false; } return true; };
          const items = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const t = n.textContent.trim();
            if (!t || !visible(n.parentElement) || n.parentElement.closest('#studio, #err, script, style, #safezone')) continue;
            const range = document.createRange(); range.selectNodeContents(n);
            const b = range.getBoundingClientRect();
            if (b.width < 1 || b.height < 1) continue;
            items.push({ what: `"${t.slice(0, 24)}"`, l: b.left, t: b.top, r: b.right, b: b.bottom });
          }
          const st = document.getElementById('stage');
          if (st) { const b = st.getBoundingClientRect(); items.push({ what: 'playfield (#stage)', l: b.left, t: b.top, r: b.right, b: b.bottom }); }
          return items;
        });
        out.samples++;
        if (seed === 101 && f === 1) out.frame1Text = s.filter((i) => i.what.startsWith('"')).map((i) => i.what);
        for (const i of s) {
          if (i.l < ZONE.l - 1 || i.r > ZONE.r + 1 || i.t < ZONE.t - 1 || i.b > ZONE.b + 1) {
            out.offenders.push({ what: i.what, at: `${(f / FPS).toFixed(1)}s`, box: [i.l, i.t, i.r, i.b].map(Math.round) });
          }
        }
        if (r.done) break;
      }
    }
    out.motion = +changed(await gray(join(tmp, 'f1.png')), await gray(join(tmp, 'f4.png'))).toFixed(2);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  // one line per distinct offender. The playfield's own edge is reported
  // as a note, not a failure: it's the board's background, and nothing
  // important is drawn in its outer band (look at the ?safezone=1 frames)
  const uniq = [...new Map(out.offenders.map((o) => [o.what, o])).values()];
  out.notes = uniq.filter((o) => o.what.startsWith('playfield'));
  out.offenders = uniq.filter((o) => !o.what.startsWith('playfield'));
  return out;
}

const games = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(GAMES);
const { server, port } = await startServer(0);
const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true, args: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
let bad = 0;
for (const g of games) {
  const r = await checkGame(page, `http://127.0.0.1:${port}`, g);
  bad += r.offenders.length;
  console.log(`\n== ${g}: ${r.offenders.length ? `${r.offenders.length} element(s) reach into TikTok's UI zones` : 'clear of TikTok UI zones'} (${r.samples} frames sampled)`);
  for (const o of r.offenders) console.log(`   ✗ ${o.what} at ${o.at}  box [l,t,r,b] ${o.box.join(',')}`);
  for (const o of r.notes) console.log(`   note: ${o.what} edge reaches a zone (background only)  box [l,t,r,b] ${o.box.join(',')}`);
  console.log(`   frame 1 text: ${r.frame1Text.join(' | ') || '(none)'}`);
  console.log(`   frame 1 -> 4: ${r.motion}% of pixels changed ${r.motion > 0.05 ? '(moving)' : '(STILL)'}`);
}
await browser.close();
server.close();
process.exit(bad ? 1 : 0);

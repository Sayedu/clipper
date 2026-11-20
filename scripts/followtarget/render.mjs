// Renders one Follow the Target video headlessly (the same page and the same
// Record button the website uses) and saves it.
//
//   node scripts/followtarget/render.mjs                        voice on, end text on
//   node scripts/followtarget/render.mjs --voice off            no voiceover
//   node scripts/followtarget/render.mjs --end-text off         no text under the button
//   node scripts/followtarget/render.mjs --voice off --end-text off
//
// Options (all optional):
//   --theme cups|parking|sky|carton|coins|infinite   --rows 3|4|5   --seed N
//   --object "🚀 rocket"     with --theme infinite: use this emoji (and name) instead of a random object; no animals, faces or people
//   --voice on|off            voiceover at the start (default on)
//   --end-text on|off         rotating text under the end button (default on)
//   --voice-line N|next|random   which line from the list (default next = rotate, remembered between renders)
//   --voice-text "custom line"   use exactly this line (placeholders {question} and {find} still work)
//   --voice-engine kokoro|edge   offline Kokoro (default) or online edge-tts
//   --voice-name am_adam         --voice-rate +10%      --max-voice-sec 6
//   --duck 35                 sound effects drop to this percent while the voice plays
//   --end1 "TEXT" --end2 "TEXT" --end-switch 1.5   end texts and when the second one appears (seconds into the freeze)
//   --out DIR                 default render/followtarget/out
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from '../followball/serve.mjs';
import { ttsLine } from './tts.mjs';

const REPO = resolve(new URL('../..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const onOff = (k, d) => { const v = opt(k, d); if (!['on', 'off'].includes(v)) { console.error(`--${k} must be on or off`); process.exit(2); } return v === 'on'; };

const voiceOn = onOff('voice', 'on'), endOn = onOff('end-text', 'on');
const seed = opt('seed') ? Number(opt('seed')) >>> 0 : (Math.random() * 4294967296) >>> 0;
const theme = opt('theme', 'random'), rows = Number(opt('rows', 0)) || undefined;
const outDir = resolve(opt('out', join(REPO, 'render', 'followtarget', 'out')));
mkdirSync(outDir, { recursive: true });
const statePath = join(REPO, 'data', 'followtarget', 'state.json');
const readState = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return { next: 0 }; } };

const voice = { enabled: voiceOn };
if (opt('voice-engine')) voice.engine = opt('voice-engine');
if (opt('voice-name')) voice.name = opt('voice-name');
if (opt('voice-rate')) voice.rate = opt('voice-rate');
if (opt('max-voice-sec')) voice.maxSec = Number(opt('max-voice-sec'));
if (opt('duck')) voice.duck = Number(opt('duck'));
if (opt('voice-text')) { voice.lines = [opt('voice-text')]; voice.mode = 'fixed'; voice.fixed = 1; }
let rotating = false;
const lineArg = opt('voice-line', opt('voice-text') ? '1' : 'next');
if (!opt('voice-text')) {
  if (/^\d+$/.test(lineArg)) { voice.mode = 'fixed'; voice.fixed = Number(lineArg); }
  else if (lineArg === 'random') voice.mode = 'random';
  else if (lineArg === 'next') { voice.mode = 'fixed'; voice.fixed = readState().next + 1; rotating = true; }   // fixed to the remembered position; wrapped below
  else { console.error('--voice-line must be a number, next or random'); process.exit(2); }
}
const endText = { enabled: endOn };
if (opt('end1') || opt('end2')) endText.texts = [opt('end1', "I'LL REPLY IF YOU'RE RIGHT"), opt('end2', 'SEND TO A FRIEND • LOSER BUYS LUNCH')];
if (opt('end-switch')) endText.switchAt = Number(opt('end-switch'));

const { server, port } = await startServer(0, async (req, res, url) => {
  if (url.pathname !== '/worker/tts') return false;
  try {
    const q = url.searchParams, r = await ttsLine({ text: q.get('text') ?? '', engine: q.get('engine') ?? undefined, voice: q.get('voice') ?? undefined, rate: q.get('rate') ?? undefined });
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(readFileSync(r.path));
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.message }));
  }
  return true;
});

const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
let exit = 0;
try {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  // the voice list wraps around, so "next" is turned into a line number once the page knows how many lines there are
  await page.addInitScript(({ voice, endText }) => { window.FTT_CONFIG = { voice, endText }; }, { voice, endText });
  await page.goto(`http://127.0.0.1:${port}/web/public/generators/follow-the-target.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.FTT && window.FTT.cur, null, { timeout: 30000 });
  if (rotating) await page.evaluate((n) => { const L = window.FTT.cfg.voice.lines.length; window.FTT.setConfig({ voice: { fixed: (n % L) + 1 } }); }, readState().next);
  await page.evaluate(([seed, theme, rows, object]) => window.FTT.load(seed, { theme, rows, object }), [seed, theme, rows, opt('object')]);
  const info = await page.evaluate(() => window.FTT.voiceInfo());
  const v = await page.evaluate(() => ({ key: window.FTT.cur.key, rows: window.FTT.cur.rows, win: window.FTT.cur.win }));

  console.log(`theme ${v.key}, ${v.rows} rows, seed ${seed}, winning number ${v.win.map((n) => '#' + n).join(' & ')}`);
  console.log(`voiceover: ${voiceOn ? 'ON' : 'off'}   end text: ${endOn ? 'ON' : 'off'}`);
  if (voiceOn) {
    if (info.error) { console.error(`ERROR: the voice could not be made: ${info.error}`); exit = 1; }
    else {
      console.log(`voice (${info.engine} ${info.name} ${info.rate}), line ${info.index + 1} of ${info.lines}, ${info.sec} s:\n  "${info.line}"`);
      if (info.tooLong) console.error(`WARNING: the voice line is ${info.sec} s, over the ${info.maxSec} s limit. Shorten the line, raise --voice-rate, or raise --max-voice-sec.`);
    }
  }
  if (!exit) {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('#btnRec')]);
    const name = `follow-the-target-${v.key}-${seed}${voiceOn ? '' : '-novoice'}${endOn ? '' : '-noendtext'}.${dl.suggestedFilename().split('.').pop()}`;
    const file = join(outDir, name);
    await dl.saveAs(file);
    writeFileSync(join(outDir, name.replace(/\.[^.]+$/, '.json')), JSON.stringify({ file: name, seed, theme: v.key, rows: v.rows, winningNumber: v.win, voice: voiceOn ? info : null, endText, problems, renderedAt: new Date().toISOString() }, null, 1));
    console.log(`saved ${file}`);
    if (rotating && voiceOn) { mkdirSync(join(REPO, 'data', 'followtarget'), { recursive: true }); writeFileSync(statePath, JSON.stringify({ next: readState().next + 1 })); }
    if (problems.length) console.error('page errors:', problems);
  }
} catch (err) {
  console.error('render failed:', err.message); exit = 1;
} finally {
  await browser.close(); server.close();
}
process.exit(exit);

// Renders a batch of Follow the Target videos into a folder, each with a different
// theme, grid and voice challenge, and writes the captions in the same order.
//
//   node scripts/followtarget/batch.mjs                         20 videos into ~/Desktop/tiktok
//   node scripts/followtarget/batch.mjs --count 5 --out ./test
//   node scripts/followtarget/batch.mjs --voice off --end-text off
//
// Files:   01_sky.mp4, 03_infinite_rocket.mp4 ... (the number is the order)
//          captions.txt  caption + hashtags for each video, in file order
//          answers.txt   the winning number of each video (for replying to comments), and the voice line used
//
// Options: --count N  --out DIR  --start N (first number)  --voice on|off  --end-text on|off
//          --themes cups,parking,sky,carton,coins,infinite   --seed-base N
// The Egg Carton theme uses the eggs only (the box variant has a cat in it).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mulberry32 } from './rng.mjs';
import { buildCaption } from './captions.mjs';
import { LINES, PLAN } from './plan.mjs';

const REPO = resolve(new URL('../..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const count = Number(opt('count', 20)), start = Number(opt('start', 1));
const out = resolve(opt('out', join(homedir(), 'Desktop', 'tiktok')));
const voice = opt('voice', 'on'), endText = opt('end-text', 'on'), only = opt('only') ? opt('only').split(',').map(Number) : null;   // --only 3,7 renders just those plan numbers
const rnd = mulberry32(Number(opt('seed-base', Date.now() % 2 ** 31)) >>> 0);
mkdirSync(out, { recursive: true });

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const done = [];
const history = [];
const pad = (n) => String(n).padStart(2, '0');
function writeFiles() {
  const cap = done.map((v) => `${v.file}\n${v.caption}\n\n${v.hashtags.map((t) => '#' + t).join(' ')}\n`).join('\n----------------------------------------\n\n');
  writeFileSync(join(out, 'captions.txt'), `FOLLOW THE TARGET: ${done.length} videos, captions in the same order as the files\n\n${cap}`);
  const ans = done.map((v) => `${v.file}\n  winning number: ${v.win.map((n) => '#' + n).join(' and ')}\n  ${v.theme}${v.kind ? ' · ' + v.kind : ''}, ${v.items} items${v.voiceLine ? `\n  voice line ${v.voiceIndex}: "${v.voiceLine}"` : ''}${v.voiceTooLong ? '\n  WARNING: voice line is over 6 s' : ''}`).join('\n\n');
  writeFileSync(join(out, 'answers.txt'), `ANSWER KEY (not for posting): use it to reply to comments\n\n${ans}\n`);
}

for (let i = 0; i < count; i++) {
  const n = start + i, P = PLAN[i % PLAN.length], theme = P.theme, rows = P.rows, line = LINES[i % LINES.length];
  if (only && !only.includes(i + 1)) continue;
  const tmp = join(out, '_tmp'); rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
  const base = `${pad(n)}_${theme}`;
  console.log(`\n[${i + 1}/${count}] ${base}  rows ${rows}  voice line ${line}`);
  let ok = false, side = null, tooLong = null;
  for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
    const args = [join(REPO, 'scripts', 'followtarget', 'render.mjs'), '--theme', theme, '--rows', String(rows), '--voice', voice, '--end-text', endText,
      '--voice-line', String(line), '--carton', 'egg', '--name', base, '--out', tmp, '--seed', String((rnd() * 4294967296) >>> 0),
      ...(P.want ? ['--want', P.want] : []), ...(P.object ? ['--object', P.object] : [])];
    const r = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 });
    process.stdout.write((r.stdout || '').split('\n').filter((l) => /^(theme|voice \(|  ")/.test(l)).join('\n') + '\n');
    if (/WARNING: the voice line/.test(r.stderr || '')) tooLong = true;
    const jsonPath = join(tmp, `${base}.json`);
    if (r.status === 0 && existsSync(jsonPath)) { side = JSON.parse(readFileSync(jsonPath, 'utf8')); ok = true; }
    else console.error(`  attempt ${attempt} failed: ${(r.stderr || '').trim().split('\n').pop()}`);
  }
  if (!ok) { console.error(`  SKIPPED ${base}`); continue; }
  const d = side.describe;
  // a theme that needs a different object name gets it in the file name
  const file = `${base}${theme === 'infinite' ? '_' + slug(d.kind) : ''}.mp4`;
  renameSync(join(tmp, side.file), join(out, file));
  const c = buildCaption(d, i, history);
  history.push(c);
  done.push({ file, ...c, win: side.winningNumber, theme: d.themeName, kind: theme === 'infinite' ? d.kind : '', items: d.items, voiceLine: side.voice && side.voice.line, voiceIndex: side.voice && side.voice.index + 1, voiceTooLong: !!(side.voice && side.voice.tooLong) });
  rmSync(tmp, { recursive: true, force: true });
  writeFiles();
  console.log(`  saved ${file}\n  caption: ${c.caption.replace('\n', ' / ')}`);
}
const wanted = only ? only.length : count;
console.log(`\nDone: ${done.length}/${wanted} videos in ${out}`);
process.exit(done.length === wanted ? 0 : 1);

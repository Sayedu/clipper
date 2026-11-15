// Automated checks for the post packaging.
//
//   node scripts/packaging/verify.mjs                 everything
//   node scripts/packaging/verify.mjs --skip-sim      skip the (slow) gameplay fingerprint
//   node scripts/packaging/verify.mjs --kits-only     reuse the 10 kits from the last run
//   node scripts/packaging/verify.mjs --reuse-sim     reuse the saved gameplay fingerprints
//
// 1. gameplay unchanged: the same seeds run on the pre-change code (a git
//    worktree of the `pre-post-packaging` tag) and on the current code, with
//    and without the packaging's display flag, must fingerprint identically:
//    every frame's playfield pixels, every sim event, the result/outcome
//    (browser games), and every physics step + event + placement (Ring of
//    Doom, Hot Potato)
// 2. ten post kits of one format, made one after another into a throwaway
//    log: every caption, hook, cover, hashtag set and sound passes the repeat
//    checker against the kits before it
// 3. no caption, hook, cover text or pinned comment reveals the winner or an
//    answer; every cover frame comes from the undecided middle, never a reveal
// 4. files and specs: video + SFX-only video (H.264/AAC, source size, fps and
//    length), 1080x1920 cover, caption.txt (3-5 hashtags, no dashes),
//    pinned_comment.txt; the hook is on screen at frame 1 and stays inside
//    TikTok's safe zone on every frame
// 5. posting queue never puts one format twice in a row when it can avoid it
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { LIMITS, repeatProblems, revealProblems } from './checks.mjs';
import { buildFacts, loadSource } from './facts.mjs';
import { KITS_DIR, findRenders, packageVideo } from './package.mjs';
import { REPO, buildQueue, readLog } from './postlog.mjs';
import { hamming, probe } from './util.mjs';
import { PALETTES, PLATES } from './styles.mjs';
import { lineColours, lum } from './visual.mjs';

const pexec = promisify(execFile);
const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const val = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const OUT = join(KITS_DIR, '_verify');
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
};

// ------------------------------------------------------------ 1. gameplay
async function simprint(root, extra, out) {
  await pexec(process.execPath, [join(REPO, 'scripts', 'packaging', 'simprint.mjs'), '--root', root, ...(extra ? ['--extra', extra] : []), '--out', out], { maxBuffer: 1 << 28 });
  return JSON.parse(readFileSync(out, 'utf8'));
}
function compare(a, b, { pixels = true } = {}) {
  const diffs = [];
  for (const [g, runs] of Object.entries(a.games)) {
    runs.forEach((x, i) => {
      const y = b.games[g]?.[i];
      if (!y) return diffs.push(`${g}#${i} missing`);
      const keys = 'stepsHash' in x ? ['steps', 'stepsHash', 'eventsHash', 'events', 'placements', 'winner', 'mvp'] : ['frames', 'events', 'resultHash', ...(pixels ? ['pixels'] : [])];
      for (const k of keys) if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) diffs.push(`${g} seed ${x.seed}: ${k} differs`);
    });
  }
  return diffs;
}
async function gameplay() {
  const tag = val('tag', 'pre-post-packaging');
  const wt = join(tmpdir(), `pkg-verify-${Date.now()}`);
  await pexec('git', ['-C', REPO, 'worktree', 'add', '--detach', wt, tag]);
  try {
    console.log(`\n-- gameplay fingerprint: ${tag} (before) vs working tree (after)`);
    // --reuse-sim: compare the fingerprints a previous run saved (valid as
    // long as no game file changed since)
    const reuse = flag('reuse-sim') && ['before', 'after', 'after-nohook'].every((n) => existsSync(join(OUT, `simprint-${n}.json`)));
    const get = (root, extra, name) => (reuse ? JSON.parse(readFileSync(join(OUT, name), 'utf8')) : simprint(root, extra, join(OUT, name)));
    if (reuse) console.log('   (reusing the saved fingerprints)');
    const before = await get(wt, '', 'simprint-before.json');
    const after = await get(REPO, '', 'simprint-after.json');
    const flagged = await get(REPO, 'nohook=1', 'simprint-after-nohook.json');
    const runs = Object.values(before.games).flat().length;
    const d1 = compare(before, after);
    check(`same seeds, before vs after: positions, events and outcome identical (${runs} runs, 6 games)`, d1.length === 0, d1.length ? d1.slice(0, 6) : 'all identical');
    const d2 = compare(before, flagged);
    check('with the packaging display flag (nohook=1): gameplay still identical', d2.length === 0, d2.length ? d2.slice(0, 6) : 'all identical');
    for (const [g, list] of Object.entries(before.games)) {
      const r = list[0];
      console.log(`      ${g}: ${'stepsHash' in r ? `${r.steps} physics steps, winner ${r.winner}` : `${r.frames} frames, result ${r.resultHash}`}`);
    }
  } finally {
    await pexec('git', ['-C', REPO, 'worktree', 'remove', '--force', wt]).catch(() => {});
  }
}

// ------------------------------------------------------------ 2-4. kits
async function checkKitFiles(kit) {
  const dir = kit.kitDir;
  const src = await probe(kit.source.video);
  for (const f of ['video.mp4', 'video_sfx_only.mp4']) {
    const p = await probe(join(dir, f));
    const ok = p.vcodec === 'h264' && p.acodec === 'aac' && p.width === src.width && p.height === src.height
      && Math.abs(p.fps - src.fps) < 0.5 && Math.abs(p.duration - src.duration) < 0.15;
    if (!ok) return `${f}: ${p.vcodec}/${p.acodec} ${p.width}x${p.height} ${p.fps}fps ${p.duration}s vs source ${src.width}x${src.height} ${src.fps}fps ${src.duration}s`;
  }
  const c = await probe(join(dir, 'cover.png'));
  if (c.width !== 1080 || c.height !== 1920) return `cover is ${c.width}x${c.height}`;
  const cap = readFileSync(join(dir, 'caption.txt'), 'utf8');
  const tags = cap.match(/#\w+/g) ?? [];
  if (tags.length < 3 || tags.length > 5) return `caption.txt has ${tags.length} hashtags`;
  if (/[-‐-―]/.test(cap)) return 'caption.txt has a dash';
  if (!readFileSync(join(dir, 'pinned_comment.txt'), 'utf8').trim()) return 'empty pinned comment';
  const e = kit.hook.extent, f1 = kit.hook.firstFrame;
  if (e.x0 < -1 || e.x1 > 919 || e.y0 < 191 || e.y1 > 1537) return `hook leaves the safe zone: ${JSON.stringify(e)}`;
  if (!f1 || f1.o < 0.99) return `hook not fully on screen at frame 1 (opacity ${f1?.o})`;
  return null;
}

function coverInTense(kit, facts) {
  // inside an undecided window, and after the opening hook has left the screen
  return kit.cover.atSec > (kit.hook.style?.sec ?? 3) + 0.2
    && facts.tense.some(([a, b]) => kit.cover.atSec >= a - 0.05 && kit.cover.atSec <= b + 0.05);
}

async function tenKits() {
  const format = val('format', null);
  const all = findRenders();
  const counts = {};
  for (const r of all) counts[r.format] = (counts[r.format] ?? 0) + 1;
  const fmt = format ?? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const sources = all.filter((r) => r.format === fmt).slice(0, 10).map((r) => r.dir);
  const log = join(OUT, 'ten-kits-log.json');
  const kitsOut = join(OUT, 'ten-kits');
  if (!flag('kits-only')) {
    rmSync(log, { force: true });
    rmSync(kitsOut, { recursive: true, force: true });
    console.log(`\n-- ten ${fmt} post kits, one after another (throwaway log ${log})`);
    for (const s of sources) {
      try {
        await packageVideo(s, { writeLog: log, readLogs: [log], outDir: kitsOut, preset: 'veryfast', verbose: false });
        process.stdout.write('.');
      } catch (err) {
        console.log(`\n   ✗ ${s}: ${err.message}`);
      }
    }
    console.log('');
  }
  const kits = readLog([log]);
  check(`made 10 ${fmt} kits from 10 different videos`, kits.length === 10 && new Set(kits.map((k) => k.source.input)).size === 10, `${kits.length} kits`);

  // the repeat checker, re-run independently: each kit against every kit before it
  const repeatFails = [];
  kits.forEach((k, i) => { for (const p of repeatProblems(k, kits.slice(0, i))) repeatFails.push(`${k.id}: ${p.why}`); });
  check('all 10 captions, hooks, covers, hashtag sets and sounds pass the repeat checker', repeatFails.length === 0, repeatFails.length ? repeatFails.slice(0, 5) : 'no repeats');
  check('10 different caption first lines', new Set(kits.map((k) => k.captionFirstLine)).size === kits.length);
  check('10 different hook texts', new Set(kits.map((k) => k.hook.lines.join(' '))).size === kits.length);
  const covDist = [];
  kits.forEach((k, i) => kits.slice(0, i).forEach((o) => covDist.push(hamming(k.cover.phash, o.cover.phash))));
  check(`covers all look different (pHash distance > ${LIMITS.coverHamming} for every pair)`, Math.min(...covDist) > LIMITS.coverHamming, `closest pair ${Math.min(...covDist)}, average ${(covDist.reduce((a, b) => a + b, 0) / covDist.length).toFixed(1)}`);
  check('no two hashtag sets identical', new Set(kits.map((k) => [...k.hashtags].sort().join(' '))).size === kits.length);
  const styles = new Set(kits.map((k) => k.captionStyle));
  check('caption styles rotate (question / challenge / moment / episode)', styles.size >= 3, [...kits.map((k) => k.captionStyle)].join(', '));
  const firstFrames = new Set(kits.map((k) => `${k.look.bg}|${k.hook.style.font}|${k.hook.style.palette}|${k.look.zoom}`));
  check('first frames differ (background, hook font/colour, zoom)', firstFrames.size === kits.length, `${firstFrames.size} distinct`);
  return kits;
}

async function revealAndFiles(kits, label) {
  const reveal = [], cover = [], files = [];
  for (const k of kits) {
    // the facts the kit was built from (kit.json) win over a fresh read of
    // the render folder: a replayed event log only exists in the kit
    const facts = { ...buildFacts(loadSource(k.source.input), {}), ...(k.facts?.tense ? { tense: k.facts.tense } : {}) };
    const kit = { caption: k.caption, hashtags: k.hashtags, pinned: k.pinned, hook: k.hook, cover: k.cover };
    for (const p of revealProblems(kit, { ...facts, keyword: facts.keyword })) reveal.push(`${k.id}: ${p}`);
    // nothing on the kit may contain the winner's name with an outcome word,
    // and a cup game's answers never appear next to cup/ball words
    if (!coverInTense(k, facts)) cover.push(`${k.id}: cover at ${k.cover.atSec}s is outside ${JSON.stringify(facts.tense)}`);
    const f = await checkKitFiles(k);
    if (f) files.push(`${k.id}: ${f}`);
  }
  check(`${label}: no caption, hook, cover or pinned comment reveals the winner or answer`, reveal.length === 0, reveal.length ? reveal.slice(0, 4) : `${kits.length} kits clean`);
  check(`${label}: every cover is a frame from the undecided middle (never a reveal, never under the opening hook)`, cover.length === 0, cover.length ? cover.slice(0, 4) : `${kits.length} covers`);
  check(`${label}: files and specs (videos, cover, caption, pinned, hook safe zone + frame 1)`, files.length === 0, files.length ? files.slice(0, 4) : `${kits.length} kits`);
}

// every palette x plate combination the packaging can pick stays readable:
// a plated line needs 3:1 contrast with its plate (WCAG large text), a bare
// line (black outline, any background) needs a light fill
function legibilityChecks() {
  const rel = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [x, y] = [rel(a), rel(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const bad = [];
  for (const p of PALETTES) for (const plate of PLATES) {
    const c = lineColours(p, plate);
    for (const [k, l] of Object.entries({ l1: c.l1, l2: c.l2 })) {
      if (l.bg ? ratio(l.fg, l.bg) < 3 : lum(l.fg) <= 0.45) bad.push(`${p.id}/${plate}/${k}: ${l.fg} on ${l.bg ?? 'outline'}`);
    }
  }
  check(`hook/cover text readable in every colour scheme (${PALETTES.length} palettes x ${PLATES.length} plate styles)`, bad.length === 0, bad.length ? bad.slice(0, 6) : 'all pass');
}

function queueChecks() {
  const items = ['colorwar', 'colorwar', 'colorwar', 'followball', 'followball', 'eyetest', 'findthecat', 'ringofdoom', 'hotpotato', 'colorwar'].map((format, i) => ({ id: String(i), format }));
  const q = buildQueue(items, 'colorwar');
  const b2b = q.filter((x, i) => i > 0 && x.format === q[i - 1].format).length;
  check('posting queue: mixed batch never repeats a format back to back, and never starts with the last posted format', b2b === 0 && q[0].format !== 'colorwar', q.map((x) => x.format).join(' > '));
  const only = buildQueue([{ id: 'a', format: 'eyetest' }, { id: 'b', format: 'eyetest' }], null);
  check('posting queue: flags an unavoidable repeat instead of hiding it', only[1].backToBack === true);
}

// ------------------------------------------------------------ run
const started = Date.now();
if (!flag('skip-sim')) await gameplay();
const kits = await tenKits();
await revealAndFiles(kits, 'ten kits');
const samples = readLog([val('samples-log', join(OUT, '..', 'post-log.json'))].filter(existsSync));
if (samples.length) await revealAndFiles(samples, `${samples.length} sample kits (all formats)`);
legibilityChecks();
queueChecks();

const passed = results.filter((r) => r.pass).length;
writeFileSync(join(OUT, 'verify-report.json'), JSON.stringify({ at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), passed, total: results.length, results }, null, 1));
console.log(`\n${passed}/${results.length} passed · report: ${join(OUT, 'verify-report.json')}`);
process.exit(passed === results.length ? 0 : 1);

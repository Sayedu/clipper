// Post packaging: turns a finished render into a post kit that looks clearly
// different from the recent posts, without touching the simulation.
//
//   node scripts/packaging/package.mjs <job dir | episode dir | video.mp4> [...more]
//   node scripts/packaging/package.mjs --recent 5            the 5 newest unpackaged renders
//   node scripts/packaging/package.mjs --recent 10 --format colorwar
//   node scripts/packaging/package.mjs --queue               (re)write the posting queue only
//
// Each kit lands in post-kits/<date>_<format>_seed<seed>_<id>/:
//   video.mp4             packaged video (hook, background, border, zoom, sound bed)
//   video_sfx_only.mp4    same picture, the game's own sound effects only
//   cover.png             1080x1920 cover from the tense middle + hook text
//   caption.txt           caption + hashtags
//   pinned_comment.txt
//   kit.json              every pick, the facts it came from, the checks it passed
// and is appended to the post log the repeat checker reads.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { analyzeVideo, bandDetail, boxMotion, writeMaskPgm } from './analyze.mjs';
import { LIMITS, repeatProblems, revealProblems } from './checks.mjs';
import { composeVideo, extractAudio, eyeCatch, frameAt, maskedBackground, mixBed, overlayPng, swapAudio, thumbRgb } from './compose.mjs';
import { FORMATS, buildFacts, loadSource } from './facts.mjs';
import { CI_LOG, LOCAL_LOG, REPO, appendEntry, buildQueue, lastPostedFormat, readLog, writeLogPath } from './postlog.mjs';
import { ALIGNS, ANIMS, BACKGROUNDS, BORDERS, BORDER_COLOURS, FONTS, PALETTES, PLATES, ZOOMS, freshPick } from './styles.mjs';
import { firstLine, hamming, hashString, phash, probe, rng } from './util.mjs';
import { replayEvents } from './replay.mjs';
import { openRenderer, renderBackground, renderBorder, renderHook, renderTextLayer } from './visual.mjs';
import { writeCopy } from './writer.mjs';

export const KITS_DIR = resolve(process.env.POST_KITS_DIR ?? join(REPO, 'post-kits'));
export const TRACKS = ['pulse', 'arp', 'lofi', 'marimba', 'chip', 'ambient', 'tension', 'bounce'];
const HOOK_SLOTS = [300, 420, 560, 700, 860, 1020, 1180, 1320, 1430];
const COVER_SLOTS = [340, 460, 580, 1160, 1280, 1400];

const ids = (list, get) => list.map(get).filter(Boolean);
const log = (on, ...a) => on && process.stderr.write(`${a.join(' ')}\n`);

/** Pick every non-text look for this kit, avoiding the recent ones. */
function pickLook(history, fmt, r) {
  const same = history.filter((e) => e.format === fmt);
  const lastSame = (n, get) => ids(same.slice(-n), get);
  const lastAll = (n, get) => ids(history.slice(-n), get);
  const hookFont = freshPick(r, FONTS, [...lastSame(4, (e) => e.hook?.style?.font), ...lastAll(1, (e) => e.hook?.style?.font)]);
  const hookPal = freshPick(r, PALETTES, [...lastSame(4, (e) => e.hook?.style?.palette), ...lastAll(1, (e) => e.hook?.style?.palette)]);
  const coverFont = freshPick(r, FONTS.filter((f) => f.id !== hookFont.id), lastSame(4, (e) => e.cover?.style?.font));
  const coverPal = freshPick(r, PALETTES.filter((p) => p.id !== hookPal.id), lastSame(4, (e) => e.cover?.style?.palette));
  return {
    bg: freshPick(r, BACKGROUNDS, [...lastSame(5, (e) => e.look?.bg), ...lastAll(2, (e) => e.look?.bg)]),
    border: freshPick(r, BORDERS, lastSame(2, (e) => e.look?.border)),
    borderColour: freshPick(r, BORDER_COLOURS, lastSame(2, (e) => e.look?.borderColour)),
    zoom: freshPick(r, ZOOMS, lastSame(1, (e) => e.look?.zoom)),
    hook: {
      font: hookFont.id, palette: hookPal,
      plate: freshPick(r, PLATES, lastSame(2, (e) => e.hook?.style?.plate)),
      anim: freshPick(r, ANIMS, lastSame(3, (e) => e.hook?.style?.anim)),
      align: freshPick(r, ALIGNS, lastSame(1, (e) => e.hook?.style?.align)),
      size: r.pick([104, 112, 120, 128]),
      tilt: r.pick([-4, -3, 3, 4]),
      sec: r.pick([2.0, 2.2, 2.4, 2.6, 2.8]),
    },
    cover: {
      font: coverFont.id, palette: coverPal,
      plate: freshPick(r, PLATES.filter((p) => p !== 'underline'), lastSame(2, (e) => e.cover?.style?.plate)),
      align: r.pick(ALIGNS),
      size: r.pick([132, 146, 160]),
      tilt: r.pick([-4, -2, 2, 4]),
    },
  };
}

/**
 * Where the hook goes: the band with the least going on during its seconds
 * on screen — average motion, the fastest single mover (a ball crossing a
 * still board) and static detail (the game's own text) all count against a
 * band. Among the calmest few, last post's band is skipped for variety. A
 * band that still holds the game's own text gets a solid card behind the
 * hook, sized to cover that text while the hook is up.
 */
function pickHookSlot(an, look, history, fmt, r) {
  const lastCy = history.filter((e) => e.format === fmt).at(-1)?.hook?.style?.cy;
  const scored = HOOK_SLOTS.map((cy) => {
    const b = boxMotion(an, { x: 40, y: cy - 130, w: 878, h: 260 });
    return { cy, ...b, busy: 30 * b.active + b.mean + 0.25 * b.detail };
  }).sort((a, b) => a.busy - b.busy);
  const calm = scored.filter((s) => s.busy <= Math.max(2, scored[0].busy * 1.5)).slice(0, 3);
  const options = calm.filter((s) => lastCy == null || Math.abs(s.cy - lastCy) > 150);
  const slot = r.pick(options.length ? options : calm);
  if (slot.detailBox && slot.detail > 6) {
    const d = slot.detailBox;
    slot.backing = { w: Math.min(870, d.w + 90), h: Math.min(320, d.h + 44) };
    slot.cy = Math.round(d.y + d.h / 2);
    slot.cx = Math.round(Math.max(44 + slot.backing.w / 2, Math.min(914 - slot.backing.w / 2, d.x + d.w / 2)));
  }
  return slot;
}

/** Tense-window candidate times for the cover, most eye-catching first. */
async function coverCandidates(video, facts, r, after) {
  const times = [];
  // never while the opening hook is still on screen
  for (const [a0, b] of facts.tense) {
    const a = Math.max(a0, after);
    if (b - a < 0.6) continue;
    for (let i = 0; i < 4; i++) times.push(a + ((b - a) * (i + 0.5)) / 4);
  }
  const scored = [];
  for (const t of times) scored.push({ t, score: eyeCatch(await thumbRgb(video, t)) });
  scored.sort((x, y) => y.score - x.score);
  // the top third, shuffled, so a format's covers don't all come from the
  // same beat of the game; then the rest as fallbacks
  const top = Math.max(2, Math.ceil(scored.length / 3));
  return [...r.shuffle(scored.slice(0, top)), ...scored.slice(top)];
}

export async function packageVideo(input, opts = {}) {
  const verbose = opts.verbose ?? true;
  const src = loadSource(input);
  const history = readLog(opts.readLogs ?? (opts.writeLog ? [CI_LOG, LOCAL_LOG, opts.writeLog] : null));
  const same = history.filter((e) => e.format === src.format);
  // a render from before event logs were kept: rebuild the log by replaying
  // its seed (read-only), trusted only if it reproduces the stored result
  let eventsFrom = src.events ? 'render' : 'none';
  if ((!src.events && (src.format === 'followball' || src.format === 'eyetest')) || (src.format === 'colorwar' && !src.result.timeline)) {
    log(verbose, '   no event log with this render: replaying its seed to rebuild one');
    const rep = await replayEvents(src);
    if (rep) {
      src.events = { events: rep.events };
      if (rep.timeline) src.result.timeline = rep.timeline;
      eventsFrom = 'replayed';
    } else if (src.format !== 'colorwar') {
      throw new Error('this render has no event log and replaying its seed does not reproduce it, so there is no safe way to pick a cover that is not a reveal');
    }
  }
  const facts = buildFacts(src, { episode: same.length + 1 });
  if ((src.format === 'ringofdoom' || src.format === 'hotpotato') && src.result.episode_number) facts.episode = src.result.episode_number;
  const r = rng(hashString(`${src.id}|${history.length}|${opts.salt ?? ''}`));
  log(verbose, `\n== ${src.format} · seed ${facts.seed} · ${input}`);

  const text = writeCopy(facts, history, r);
  const look = pickLook(history, src.format, r);
  const lastTracks = ids(history.slice(-LIMITS.soundWindow), (e) => e.sound?.track);
  const usedAt = (t) => history.map((e) => e.sound?.track).lastIndexOf(t);
  // no music by default (by request): the video keeps only the game's own
  // sound. PACKAGING_BED=on (or opts.bed === true) adds a generated bed.
  const bedOn = opts.bed === true || process.env.PACKAGING_BED === 'on';
  const track = bedOn ? r.shuffle(TRACKS.filter((t) => !lastTracks.includes(t))).sort((a, b) => usedAt(a) - usedAt(b))[0] : 'none';

  const pr = await probe(src.video);
  const contentEnd = Math.min(pr.duration, facts.contentSec || pr.duration);
  const an = await analyzeVideo(src.video, { contentEnd, hookSec: look.hook.sec });
  const slot = pickHookSlot(an, look, history, src.format, r);

  const date = new Date().toISOString().slice(0, 10);
  const kitDir = join(opts.outDir ?? KITS_DIR, `${date}_${src.format}_seed${facts.seed}_${hashString(`${src.id}${Date.now()}`).toString(36).slice(0, 5)}`);
  const work = join(kitDir, '_work');
  mkdirSync(work, { recursive: true });
  const k = pr.width / 1080;

  const R = await openRenderer();
  try {
    // ---- graphics
    log(verbose, `   look: bg ${look.bg.id} · border ${look.border}/${look.borderColour} · zoom ${look.zoom.id} · hook ${look.hook.font}/${look.hook.palette.id}/${look.hook.plate}/${look.hook.anim} @ y${slot.cy}`);
    await renderBackground(R, look.bg, join(work, 'bg.png'), k);
    writeMaskPgm(an, join(work, 'mask.pgm'));
    await maskedBackground(join(work, 'bg.png'), join(work, 'mask.pgm'), pr.width, pr.height, join(work, 'bg_masked.png'));
    await renderBorder(R, { style: look.border, colour: look.borderColour, stage: an.stage }, join(work, 'border.png'), k);
    const hookSpec = { ...look.hook, ...(slot.backing ? { align: 'center' } : {}), lines: text.hook.lines, cx: slot.cx ?? 520, cy: slot.cy, maxW: slot.backing ? Math.max(760, slot.backing.w + 4) : 760, backing: slot.backing ?? null };
    const hook = await renderHook(R, hookSpec, join(work, 'hook'), { fps: Math.round(pr.fps), scale: k });

    // ---- sound: the game's audio, plus a generated bed under it
    log(verbose, `   sound: ${track}`);
    await extractAudio(src.video, join(work, 'game.wav'));
    const sfxWav = join(work, 'sfx.wav');
    await extractAudio(src.sfxVideo ?? src.video, sfxWav);
    const bed = bedOn
      ? await mixBed({ track, seed: facts.seed, orig: join(work, 'game.wav'), contentEnd, out: join(work, 'mix.wav') })
      : (copyFileSync(join(work, 'game.wav'), join(work, 'mix.wav')), { track: 'none' });

    // ---- the video
    log(verbose, '   encoding');
    const video = join(kitDir, 'video.mp4');
    await composeVideo({
      src: src.video, probe: pr, bg: join(work, 'bg_masked.png'), border: join(work, 'border.png'), hook,
      zoom: look.zoom, contentEnd, audio: join(work, 'mix.wav'), out: video, preset: opts.preset ?? 'fast',
    });
    await swapAudio(video, sfxWav, join(kitDir, 'video_sfx_only.mp4'), pr.duration);

    // ---- cover: a tense-middle frame, never a reveal, unlike the last 10
    const history10 = history.slice(-LIMITS.window);
    let cover = null;
    const tried = [];
    const cands = await coverCandidates(video, facts, r, look.hook.sec + 0.4);
    for (let i = 0; i < Math.min(8, cands.length) && !cover; i++) {
      const c = cands[i];
      const style = i === 0 ? look.cover : { ...look.cover, font: r.pick(FONTS).id, palette: r.pick(PALETTES), align: r.pick(ALIGNS) };
      await frameAt(video, c.t, join(work, 'cover_frame.png'));
      // the cover text goes where the frame is plainest (top or bottom band)
      const bands = await bandDetail(join(work, 'cover_frame.png'), COVER_SLOTS);
      const cy = r.pick(bands.slice(0, 2)).cy;
      const box = await renderTextLayer(R, { ...style, lines: text.cover.lines, cx: 520, cy, maxW: 800 }, join(work, 'cover_text.png'));
      await overlayPng(join(work, 'cover_frame.png'), join(work, 'cover_text.png'), join(kitDir, 'cover.png'));
      const hash = await phash(join(kitDir, 'cover.png'));
      const near = history10.filter((e) => e.cover?.phash).map((e) => ({ id: e.id, d: hamming(hash, e.cover.phash) })).sort((a, b) => a.d - b.d)[0];
      tried.push({ t: +c.t.toFixed(2), score: +c.score.toFixed(1), nearest: near ?? null });
      if (!near || near.d > LIMITS.coverHamming) cover = { t: c.t, cy, box, style, phash: hash, nearest: near ?? null };
    }
    if (!cover) throw new Error(`every cover candidate looked too much like a recent cover: ${JSON.stringify(tried)}`);

    // ---- the final gates
    const kit = {
      caption: text.caption, hashtags: text.hashtags, pinned: text.pinned,
      hook: { id: text.hook.id, lines: text.hook.lines },
      cover: { id: text.cover.id, lines: text.cover.lines, phash: cover.phash },
      sound: { track },
    };
    const reveal = revealProblems(kit, facts);
    const repeats = repeatProblems(kit, history);
    if (reveal.length || repeats.length) throw new Error(`post kit failed its checks: ${[...reveal, ...repeats.map((x) => x.why)].join('; ')}`);

    // ---- files
    writeFileSync(join(kitDir, 'caption.txt'), `${text.caption}\n\n${text.hashtags.map((t) => `#${t}`).join(' ')}\n`);
    writeFileSync(join(kitDir, 'pinned_comment.txt'), `${text.pinned}\n`);
    const entry = {
      id: basename(kitDir),
      createdAt: new Date().toISOString(),
      format: src.format,
      seed: facts.seed,
      source: { input: resolve(input), video: src.video },
      kitDir,
      caption: text.caption,
      captionFirstLine: firstLine(text.caption),
      captionStyle: text.captionStyle,
      captionIds: text.captionIds,
      hashtags: text.hashtags,
      hook: {
        id: text.hook.id, lines: text.hook.lines,
        style: { font: look.hook.font, palette: look.hook.palette.id, plate: look.hook.plate, anim: look.hook.anim, align: look.hook.align, size: look.hook.size, sec: look.hook.sec, cy: slot.cy },
        slotMotion: +slot.mean.toFixed(2), slotDetail: +slot.detail.toFixed(1), slotPeak: +slot.peak.toFixed(1), backing: slot.backing ?? null, extent: hook.extent, firstFrame: hook.first,
      },
      cover: {
        id: text.cover.id, lines: text.cover.lines, phash: cover.phash, atSec: +cover.t.toFixed(2), nearest: cover.nearest,
        style: { font: cover.style.font, palette: cover.style.palette.id, plate: cover.style.plate, align: cover.style.align, size: cover.style.size, cy: cover.cy },
        tried,
      },
      pinned: text.pinned,
      pinnedId: text.pinnedId,
      sound: { track, ...bed },
      look: { bg: look.bg.id, border: look.border, borderColour: look.borderColour, zoom: look.zoom.id, stage: an.stage, letterbox: +an.letterboxShare.toFixed(2) },
      video: { width: pr.width, height: pr.height, fps: Math.round(pr.fps), durationSec: +pr.duration.toFixed(2), contentEndSec: +contentEnd.toFixed(2) },
      facts: Object.fromEntries(Object.entries(facts).filter(([key]) => !['moments'].includes(key))),
      checks: { reveal: 'pass', repeat: 'pass', notes: text.notes, eventsFrom },
      posted: false,
    };
    writeFileSync(join(kitDir, 'kit.json'), JSON.stringify(entry, null, 1));
    if (opts.log !== false) appendEntry(entry, opts.writeLog ?? writeLogPath());
    log(verbose, `   ✓ ${kitDir}`);
    return entry;
  } catch (err) {
    rmSync(kitDir, { recursive: true, force: true });
    throw err;
  } finally {
    await R.close();
    if (!opts.keepWork) rmSync(work, { recursive: true, force: true });
  }
}

/** Finished renders of the posted formats, newest first. */
export function findRenders({ format = null } = {}) {
  const out = [];
  const jobs = join(REPO, 'data', 'work');
  if (existsSync(jobs)) for (const d of readdirSync(jobs)) {
    const dir = join(jobs, d);
    if (!existsSync(join(dir, 'final.0.mp4'))) continue;
    try { const s = loadSource(dir); out.push({ dir, format: s.format, mtime: statSync(join(dir, 'final.0.mp4')).mtimeMs }); } catch { /* not a posted game */ }
  }
  const eps = join(REPO, 'colorwars', 'out');
  if (existsSync(eps)) for (const d of readdirSync(eps)) {
    const dir = join(eps, d);
    if (!existsSync(join(dir, 'final.mp4')) || !existsSync(join(dir, 'meta.json'))) continue;
    try { const s = loadSource(dir); out.push({ dir, format: s.format, mtime: statSync(join(dir, 'final.mp4')).mtimeMs }); } catch { /* another colorwars event */ }
  }
  return out.filter((x) => !format || x.format === format).sort((a, b) => b.mtime - a.mtime);
}

/** Posting order for every kit not yet posted, never the same format twice in a row. */
export function writeQueue(outDir = KITS_DIR, logPath = null) {
  const history = readLog(logPath ? [CI_LOG, LOCAL_LOG, logPath] : null);
  const pending = history.filter((e) => !e.posted && e.kitDir && existsSync(join(e.kitDir, 'video.mp4')));
  const order = buildQueue(pending.map((e) => ({ id: e.id, format: e.format, kitDir: e.kitDir, caption: e.captionFirstLine })), lastPostedFormat(history.filter((e) => e.posted)));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'queue.json'), JSON.stringify({ createdAt: new Date().toISOString(), order }, null, 1));
  writeFileSync(join(outDir, 'queue.txt'), order.map((o, i) => `${i + 1}. [${o.format}]${o.backToBack ? ' (same format as the one before: not enough other formats left)' : ''} ${o.caption}\n   ${o.kitDir}`).join('\n') + '\n');
  return order;
}

// ------------------------------------------------------------------ CLI
async function cli() {
  const args = process.argv.slice(2);
  const flag = (k) => args.includes(`--${k}`);
  const val = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  const positional = args.filter((a, i) => !a.startsWith('--') && !['--recent', '--format', '--log', '--preset', '--out'].includes(args[i - 1]));
  const format = val('format', null);
  if (format && !FORMATS.includes(format)) { console.error(`--format must be one of ${FORMATS.join(', ')}`); process.exit(2); }
  let inputs = positional;
  if (flag('recent')) {
    const done = new Set(readLog().map((e) => e.source?.input));
    inputs = findRenders({ format }).map((x) => x.dir).filter((d) => !done.has(d)).slice(0, Number(val('recent', 5)));
  }
  const results = [];
  let failed = 0;
  for (const input of inputs) {
    try {
      results.push(await packageVideo(input, { preset: val('preset', 'fast'), writeLog: val('log', undefined), outDir: val('out', undefined), log: !flag('no-log') }));
    } catch (err) {
      failed++;
      console.error(`   ✗ ${input}: ${err.message}`);
    }
  }
  if (flag('queue') || inputs.length > 1) {
    const q = writeQueue(val('out', undefined), val('log', null));
    console.error(`\nposting queue (${q.length}): ${q.map((o) => o.format).join(' -> ')}`);
  }
  if (flag('json')) process.stdout.write(JSON.stringify(results, null, 1));
  if (!inputs.length && !flag('queue')) console.error('nothing to package (pass job/episode folders or --recent N)');
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) cli();

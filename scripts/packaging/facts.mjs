// Read-only: turns a finished render (its result JSON + event log) into the
// facts the packaging is written from. Nothing here runs or touches a sim —
// it only reads files a render already wrote.
//
// A "source" is one rendered video plus its data:
//   - a worker job folder   data/work/<id>/   final.0.mp4 + <game>.json (+ <game>_events.json, sfx.0.mp4)
//   - a colorwars episode   colorwars/out/<ep>/   final.mp4 + meta.json (+ events.json)
//   - a CLI render          <name>.mp4 next to <name>.json (+ <name>_sfx.mp4)
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { hashString, rng, title } from './util.mjs';

const GAME_JSON = ['colorwar', 'followball', 'eyetest', 'findthecat'];
export const FORMATS = ['colorwar', 'ringofdoom', 'hotpotato', 'followball', 'eyetest', 'findthecat'];
export const FORMAT_NAME = {
  colorwar: 'Color war', ringofdoom: 'Ring of Doom', hotpotato: 'Hot Potato',
  followball: 'Follow the ball', eyetest: 'Eye test', findthecat: 'Find the cat',
};

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function detectFormat(r) {
  if (r.event === 'ring_of_doom') return 'ringofdoom';
  if (r.event === 'hot_potato') return 'hotpotato';
  if (r.difficulty && r.twists && 'roundTotalSec' in r) return 'findthecat';
  if (r.swapCounts) return 'followball';
  if (r.ballsPerRound) return 'eyetest';
  if (r.colors && r.winner && r.modeName) return 'colorwar';
  return null;
}

/** Locate the video + data for a path (job dir, episode dir, or an .mp4). */
export function loadSource(input) {
  const p = resolve(input);
  if (!existsSync(p)) throw new Error(`no such file or folder: ${input}`);
  let dir, video, resultPath, eventsPath = null, sfxVideo = null;
  if (statSync(p).isDirectory()) {
    dir = p;
    if (existsSync(join(dir, 'meta.json'))) {
      video = join(dir, 'final.mp4');
      resultPath = join(dir, 'meta.json');
      eventsPath = join(dir, 'events.json');
    } else {
      video = join(dir, 'final.0.mp4');
      const g = GAME_JSON.find((n) => existsSync(join(dir, `${n}.json`)));
      if (!g) throw new Error(`${input}: no game result json (is it a Color War / Follow The Ball / Eye Test / Find The Cat job?)`);
      resultPath = join(dir, `${g}.json`);
      eventsPath = join(dir, `${g}_events.json`);
      if (existsSync(join(dir, 'sfx.0.mp4'))) sfxVideo = join(dir, 'sfx.0.mp4');
    }
  } else {
    dir = dirname(p);
    video = p;
    const base = basename(p).replace(/\.mp4$/, '');
    resultPath = [join(dir, `${base}.json`), join(dir, 'meta.json')].find(existsSync);
    if (!resultPath) throw new Error(`${input}: no ${base}.json next to the video`);
    if (existsSync(join(dir, `${base}_events.json`))) eventsPath = join(dir, `${base}_events.json`);
    if (existsSync(join(dir, `${base}_sfx.mp4`))) sfxVideo = join(dir, `${base}_sfx.mp4`);
  }
  if (!existsSync(video)) throw new Error(`${input}: video missing (${video})`);
  const result = readJson(resultPath);
  const format = detectFormat(result);
  if (!format) throw new Error(`${input}: unrecognised result json — not one of the posted games`);
  const events = eventsPath && existsSync(eventsPath) ? readJson(eventsPath) : null;
  const id = `${format}-${result.seed ?? 0}-${hashString(video).toString(36)}`;
  return { id, format, dir, video, sfxVideo, result, events };
}

// ------------------------------------------------------------------ facts
//
// Every fact is a plain value a template can quote. `tense` lists time
// windows (video seconds) where the action is undecided — the cover frame
// comes from in there. `hidden` lists the answer: things no caption, hook,
// cover or pinned comment may state (checked by reveal.mjs).

const pctStr = (x) => `${Math.round(x)}`;
const secStr = (x) => `${Math.round(x)}`;

export function buildFacts(src, { episode = null } = {}) {
  const fn = { colorwar: colorWar, ringofdoom: colorwarsEvent, hotpotato: colorwarsEvent, followball: followBall, eyetest: eyeTest, findthecat: findTheCat }[src.format];
  const f = fn(src);
  f.format = src.format;
  f.keyword = FORMAT_NAME[src.format];
  f.seed = src.result.seed ?? 0;
  if (f.episode == null) f.episode = episode;
  return f;
}

// Color War: the timeline (shares per colour, sampled every 0.1s) is
// recorded read-only off the score chips by scripts/colorwar/render.mjs.
function colorWar(src) {
  const r = src.result;
  const colours = r.colors.map(title);
  const winAt = r.winAtSec ?? r.durationSec;
  const f = {
    contentSec: r.durationSec,
    board: title(r.modeName ?? 'Classic'),
    colours, n: colours.length,
    closest: r.wonCleanly && r.closestMarginDuelPct != null ? Math.max(1, Math.round(r.closestMarginDuelPct)) : null,
    dip: r.wonCleanly && r.deepestDipDuringDuelPct != null ? Math.max(1, Math.round(r.deepestDipDuringDuelPct)) : null,
    tense: [[Math.max(4, winAt * 0.3), Math.max(5, winAt - 2.5)]],
    hidden: { winner: title(r.winner), words: [title(r.winner)] },
    moments: [],
  };
  const tl = r.timeline;
  if (Array.isArray(tl) && tl.length) {
    // leader changes, counted on the live share read (a 2-point dead zone so
    // two colours trading the lead by a hair every frame counts once)
    let leader = null, changes = 0;
    const outAt = {};
    let bombs = 0, lastFlash = '';
    for (const s of tl) {
      s.shares.forEach((v, i) => { if (v === null && outAt[i] == null) outAt[i] = s.t; });
      const live = s.shares.map((v, i) => [v, i]).filter(([v]) => v !== null).sort((a, b) => b[0] - a[0]);
      if (live.length >= 2 && (leader === null || (live[0][1] !== leader && live[0][0] - (s.shares[leader] ?? 0) >= 2))) {
        if (leader !== null && s.t > 1) changes++;
        leader = live[0][1];
      }
      if (s.flash && s.flash.endsWith('PAINT BOMB') && s.flash !== lastFlash) bombs++;
      lastFlash = s.flash ?? '';
    }
    f.leadChanges = changes;
    f.bombs = bombs;
    const outs = Object.entries(outAt).map(([i, t]) => ({ colour: colours[+i], t })).sort((a, b) => a.t - b.t);
    if (outs.length) f.firstOut = { colour: outs[0].colour, t: secStr(outs[0].t) };
    if (outs.length >= colours.length - 2) f.duelT = secStr(outs[colours.length - 3]?.t ?? outs.at(-1).t);
    // one snapshot fact: a colour picked uniformly at random (NOT by how it
    // ends up) at a time picked at random from the first half of the war, so
    // which colour a caption mentions says nothing about who wins
    const pick = rng(hashString(`cw-moment-${r.seed}`));
    const early = tl.filter((s) => s.t >= 6 && s.t <= Math.max(8, winAt * 0.55) && Math.abs(s.t - Math.round(s.t)) < 0.051);
    if (early.length) {
      const s = pick.pick(early);
      const alive = s.shares.map((v, i) => [v, i]).filter(([v]) => v !== null);
      const [v, i] = pick.pick(alive);
      const ranked = [...alive].sort((a, b) => b[0] - a[0]).map(([, k]) => k);
      const pos = ranked.indexOf(i);
      f.snap = {
        colour: colours[i], pct: pctStr(v), t: secStr(s.t),
        rank: pos === 0 ? 'first' : pos === ranked.length - 1 ? 'last' : pos === 1 ? 'second' : 'third',
      };
    }
    if (f.duelT && +f.duelT + 1.5 < winAt - 2.5) f.tense = [[+f.duelT + 0.8, winAt - 2.5], [Math.max(4, winAt * 0.3), +f.duelT]];
  }
  return f;
}

// Ring of Doom / Hot Potato: meta.json (placements, drama, stats, names) plus
// events.json (every sim event with its time in the FINAL video), both written
// read-only by colorwars' pipeline after the sim has already run.
function colorwarsEvent(src) {
  const m = src.result;
  const ev = src.events;
  const content = ev?.content_duration_sec ?? Math.max(1, m.duration_sec - 2);
  const names = Object.values(m.names_used ?? {}).flat();
  const teams = Object.keys(m.names_used ?? {}).filter((t) => (m.names_used[t] ?? []).some((n) => n !== m.mvp && !/^(red|blue|green|yellow)\s*\d+$/i.test(String(n).trim())));
  // with an empty viewer-name queue the engine falls back to "Red 1" style
  // labels; those aren't names worth a shout-out
  const placeholder = (n) => /^(red|blue|green|yellow)\s*\d+$/i.test(String(n).trim());
  const namesOf = (t) => m.names_used[t].filter((n) => n !== m.mvp && !placeholder(n));
  const pick = rng(hashString(`cwl-names-${m.seed}-${m.episode_id}`));
  const f = {
    contentSec: content,
    episode: m.episode_number ?? null,
    finale: !!m.is_finale,
    teams: teams.length || 4,
    balls: names.length || 16,
    leadChanges: m.drama?.lead_changes ?? null,
    nearMisses: m.drama?.near_misses || null,
    finalTwoSec: m.drama?.final_two_sec != null && m.drama.final_two_sec >= 1 ? Math.round(m.drama.final_two_sec) : null,
    collisions: m.stats?.collisions ?? null,
    eliminations: m.stats?.eliminations ?? null,
    // three viewer names from three different teams, chosen at random — a
    // shout-out, never the MVP (the MVP tends to be on the winning team)
    shout: pick.shuffle(teams).slice(0, 3).map((t) => pick.pick(namesOf(t))).filter(Boolean),
    hidden: { winner: title(m.winner ?? ''), words: [title(m.winner ?? ''), m.mvp].filter(Boolean) },
    tense: [[content * 0.25, content * 0.6]],
    moments: [],
  };
  if (ev?.events?.length) {
    const elim = ev.events.filter((e) => e.kind === 'elimination' && e.video_t != null).sort((a, b) => a.video_t - b.video_t);
    if (elim.length) {
      const e0 = elim[0];
      const nm = e0.data?.name ?? null;
      f.firstOut = { name: nm && !/^(red|blue|green|yellow)\s*\d+$/i.test(nm) ? nm : null, team: title(e0.data?.team_name ?? e0.data?.team ?? ''), t: secStr(e0.video_t) };
      const last = elim.at(-1).video_t;
      f.tense = [[Math.max(2, last * 0.3), Math.max(3, last - 1.2)]];
      if (elim.length >= 8) f.halfGoneT = secStr(elim[Math.floor(elim.length / 2) - 1].video_t);
    }
  }
  return f;
}

// cup games: round-by-round numbers from the result json; the event log
// (swaps, reveals) gives exact windows for the cover
function followBall(src) {
  const r = src.result;
  const ev = src.events?.events ?? src.events ?? [];
  const swaps = r.swapCounts ?? [];
  const f = {
    contentSec: r.durationSec,
    mode: title(r.modeName ?? r.mode ?? ''),
    rounds: r.rounds,
    cups: r.cups,
    maxCups: Math.max(...r.cups),
    swaps,
    totalSwaps: swaps.reduce((a, b) => a + b, 0),
    lastSwaps: swaps.at(-1),
    hidden: { answers: r.answers },
    tense: [],
    moments: [],
  };
  // a round runs reveal(show) -> swaps -> ticks -> answer. Tense = from the
  // first swap of a round to its answer (cups closed, ball hidden).
  const reveals = ev.filter((e) => e.type === 'answer').map((e) => e.t);
  const swapT = ev.filter((e) => e.type === 'swap').map((e) => e.t);
  for (let k = 0; k < reveals.length; k++) {
    const start = swapT.find((t) => t < reveals[k] && (k === 0 || t > reveals[k - 1]));
    if (start != null) f.tense.push([start + 0.3, reveals[k] - 0.4]);
  }
  // no event log = no safe window: the cover step then refuses instead of
  // guessing (a guess can land on a reveal)
  return f;
}

function eyeTest(src) {
  const r = src.result;
  const ev = src.events?.events ?? src.events ?? [];
  const f = {
    contentSec: r.durationSec,
    rounds: r.rounds,
    balls: r.ballsPerRound,
    maxBalls: Math.max(...r.ballsPerRound),
    shuffleSec: Math.round(r.shuffleSec),
    nearMisses: ev.filter((e) => e.type === 'near-miss').length || null,
    hidden: { answers: r.answers },
    tense: [],
    moments: [],
  };
  // shuffle = from the round's lock (after the gold flash) to its freeze
  const freezes = ev.filter((e) => e.type === 'freeze').map((e) => e.t);
  const locks = ev.filter((e) => e.type === 'lock').map((e) => e.t);
  for (const fz of freezes) {
    const lk = [...locks].reverse().find((t) => t < fz);
    if (lk != null && fz - lk > 1.5) f.tense.push([lk + 0.8, fz - 0.3]);
  }
  return f;
}

function findTheCat(src) {
  const r = src.result;
  const plan = Array.isArray(r.plan) ? r.plan : r.plan?.plan ?? [];
  const swaps = plan.map((p) => (typeof p.swaps === 'number' ? p.swaps : p.swaps?.length ?? 0));
  const f = {
    contentSec: r.durationSec,
    rounds: r.roundCount,
    cups: r.cups,
    maxCups: Math.max(...r.cups),
    swaps,
    totalSwaps: swaps.reduce((a, b) => a + b, 0) || null,
    lastSwaps: swaps.at(-1) || null,
    fakeoutRound: (r.twists ?? []).indexOf('fakeout') + 1 || null,
    colourshiftRound: (r.twists ?? []).indexOf('colorshift') + 1 || null,
    hidden: { answers: r.answers },
    tense: [],
    moments: [],
  };
  // per round: intro 1.6 + show 2.6, then 7s of shuffle and 3.5s of guess
  // before the reveal at revealOffsetSec (all from the round's own start)
  for (let k = 0; k < r.roundCount; k++) {
    const t0 = k * r.roundTotalSec;
    f.tense.push([t0 + 4.6, t0 + r.revealOffsetSec - 0.5]);
  }
  return f;
}

"use strict";
(function () {
/* ═══════════════════════════════════════════════════════════════
   COLOR WAR — the clipper "Color war" content type.

   A port of the Claude Design handoff (design_handoff_color_war/
   SPEC.md + _extracted-logic.js.txt) — the board, the separated-axis
   4-substep physics, the speed ramp, the draw order and the HUD are
   the design's. Per-mode knobs (ramp / pickBase / deathAt / hold) let
   the SPRINT mode run a fast ~18 s round; the other modes keep their
   original constants via `|| default` fallbacks.

   SPRINT is a "cold open": no countdown, and reset() fast-forwards the
   sim `warmup` seconds (fixed 1/240 steps) before the first visible
   frame, so frame one is already mid-fight. Other modes just start on
   frame 1 (the countdown was dropped earlier at the user's request).

   SPRINT also engineers a real 1-on-1: `shapeRace()` keeps every phase
   close, and once the field is down to two it holds off the knockout for
   `w.duelHold` s while a deadband + quadratic catch-up makes the pair
   trade the lead back and forth (~6 s, several lead changes), then a
   ramping threshold — gated on a decisive lead — closes it out on a
   comeback. All deterministic (tile counts + seeded pickup bias); the
   long modes never call shapeRace and keep the design's dynamics.

   Render plumbing (invisible): seeded mulberry32 for Math.random()
   (scrambled); CW.step/meta/result frame API; Web-Audio calls become an
   event log that python/colorwar_audio.py re-synthesises offline. The
   warmup's sound events are discarded (the `warming` flag).
   ═══════════════════════════════════════════════════════════════ */

const QS = new URLSearchParams(location.search);
const RENDER = QS.get('render') === '1';
const SEED = (parseInt(QS.get('seed') || '1', 10) >>> 0) || 1;
const FPS = Math.max(20, Math.min(60, parseInt(QS.get('fps') || '60', 10)));
const W = 1080, H = 1920;                          // the design's fixed coordinate space
const OUT_W = Math.max(320, parseInt(QS.get('w') || '1080', 10));
const OUT_H = Math.max(320, parseInt(QS.get('h') || '1920', 10));
const SS = Math.max(1, Math.min(4, parseFloat(QS.get('ss') || '2')));
const SHAPE = QS.get('shape') === 'square' ? 'square' : 'circle';
const FLIP_SOUND = QS.get('flipsound') === 'bubble' ? 'bubble' : 'pluck';
const BALL_R = Math.max(14, Math.min(44, parseFloat(QS.get('r') || '26')));
const MODE_PARAM = (QS.get('mode') || 'sprint').toLowerCase();   // sprint | classic | bigtiles | finegrain | stripes | random
// Season Mode (worker/web feature): purely a VISUAL overlay — title card, a
// panel-snap reveal, score chips instead of the live % bar, and an outro badge.
// None of this touches the sim/physics; a season episode's OUTCOME is decided
// entirely by its seed, found beforehand by scripts/colorwar/search.mjs running
// the plain (non-season) URL. Absent `season=`, every code path below is dead.
const SEASON_MODE = QS.has('season');
const SEASON_N = Math.max(1, parseInt(QS.get('season') || '1', 10) || 1);
const EPISODE_N = Math.max(1, parseInt(QS.get('episode') || '1', 10) || 1);
const TOTAL_EPISODES = Math.max(1, parseInt(QS.get('totalEpisodes') || '1', 10) || 1);
const SCORES_BEFORE = (QS.get('scoresBefore') || '0,0,0,0')
  .split(',').map((n) => Math.max(0, parseInt(n, 10) || 0));
// taller HUD box for the persistent "SEASON N · EPISODE N OF N" label — CSS-gated
// on this class so a plain render's #hud height/layout never changes.
if (SEASON_MODE) document.documentElement.classList.add('season');
// live in preview mode — the studio can reroll the seed and switch the board.
// render mode never touches these, so preview seed N and render seed N build
// from the identical RNG state.
let curSeed = SEED;
let curMode = MODE_PARAM;
// safety frame cap only — the sim self-terminates well before this. SPRINT is
// tight; the long modes need headroom. ?sec= overrides; absent -> per-mode default.
const CAP_SEC = QS.has('sec') ? Math.max(10, Math.min(120, parseFloat(QS.get('sec')) || 30)) : null;
let warming = false;      // true while SPRINT fast-forwards the sim before frame 1

const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
const el = (id) => document.getElementById(id);

const CW = { frame: 0, done: false, meta: null, _hardCap: 999999 };

/* ── deterministic RNG (mulberry32) for the SIM. reset() re-seeds it from the
   current seed every round, so a given seed always produces the same board /
   winner / length whether it's previewed or rendered. Cosmetic-only randomness
   (screen shake) uses Math.random(), never this — otherwise a preview running
   at a different refresh rate would draw a different number of shake samples
   and diverge from the render. ── */
let _s = 1;
function rnd() {
  _s |= 0; _s = (_s + 0x6D2B79F5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function seedRng(seed) {
  const s = seed >>> 0;
  _s = (Math.imul(s ^ 0x9e3779b9, 2654435761) ^ (s << 13)) >>> 0;
  for (let i = 0; i < 12; i++) rnd();
}

/* ── SPEC §1: board ── */
const BX = 34, BY = 330, BW = W - BX * 2, BH = H - BY - 44;   // 1012 × 1546

/* ── SPEC §3: colours + identity ── */
const NAMES = ['BLUE', 'RED', 'GREEN', 'YELLOW'];
const COLS = ['#2f6bff', '#ff2f3d', '#1fd645', '#ffd21f'];

/* ── modes. SPRINT (default was flipped to CLASSIC) is a fast ~16 s cold-open.
   The other boards are the "~45 s" format (user 2026-09-09: "when there's only 2
   left it should be FAST… a battle where one seems about to lose then comes back,
   then the other… the ending needs to be TIGHT, fast, multiple plot twists").
   `targetSec` narrows the 4-way on a curve; then the final two run a WILD
   lead-swapping phase (no slow-mo) and a TIGHT closing where the bar hugs ~50/50
   with a few more lead changes before the winner clinches — see shapeRace().
   ramp/pickBase/deathAt/warmup/hold/targetSec default in reset() so an un-tagged
   mode keeps the design's numbers. ── */
const MODES = [
  { key: 'sprint',   name: 'SPRINT',     tag: '~16s · cold open',        cols: 10, rows: 16, speed: 1090, layout: 'quarters',
    ramp: 0.08, pickBase: 1.0, deathAt: 5, warmup: 3.4, hold: 1.1 },
  { key: 'classic',  name: 'CLASSIC',    tag: '16×26 · wild survival duel · ~42s', cols: 16, rows: 26, speed: 1075, layout: 'quarters',
    ramp: 0.055, pickBase: 1.2, targetSec: 44 },
  { key: 'bigtiles', name: 'BIG TILES',  tag: 'Chunky · wild survival duel · ~41s', cols: 12, rows: 18, speed: 1145, layout: 'quarters',
    ramp: 0.057, pickBase: 1.1, targetSec: 44 },
  { key: 'finegrain',name: 'FINE GRAIN', tag: 'Dense · wild survival duel · ~43s', cols: 22, rows: 36, speed: 1095, layout: 'quarters',
    ramp: 0.057, pickBase: 1.2, targetSec: 45 },
  { key: 'stripes',  name: 'STRIPES',    tag: 'Four bands · wild survival duel · ~42s', cols: 16, rows: 26, speed: 1085, layout: 'bands',
    ramp: 0.055, pickBase: 1.2, targetSec: 44 },
];
function pickMode() {
  // 'random' picks one of the four ~44 s boards — never SPRINT (that's a distinct
  // short format you opt into, not a surprise). MODES[0] is SPRINT, so skip it.
  if (curMode === 'random') return 1 + Math.floor(rnd() * (MODES.length - 1));
  const i = MODES.findIndex((m) => m.key === curMode);
  return i >= 0 ? i : 0;   // absent / unknown -> SPRINT, never random
}

/* ═══════════════ world (SPEC §2, §4 — reset()) ═══════════════ */
let G = null, Sound = null;

function reset(seed, mode) {
  if (mode !== undefined) curMode = mode;
  if (seed !== undefined) curSeed = seed >>> 0;
  seedRng(curSeed);          // canonical RNG state — identical for preview & render
  CW.frame = 0; CW.done = false;
  const M = MODES[pickMode()];
  const cols = M.cols, rows = M.rows, tw = BW / cols, th = BH / rows;
  const grid = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    grid[r * cols + c] = M.layout === 'bands'
      ? Math.min(3, Math.floor((r / rows) * 4))
      : (c < cols / 2 ? 0 : 1) + (r < rows / 2 ? 0 : 2);
  }
  const spawn = M.layout === 'bands'
    ? [[0.5, 0.12], [0.5, 0.37], [0.5, 0.62], [0.5, 0.87]]
    : [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
  const R = BALL_R;

  G = {
    mode: M, cols, rows, tw, th, grid,
    brush: cols >= 20 ? 2 : 1, bombR: Math.max(4, Math.round(cols / 3.2)),
    // per-mode knobs — an un-tagged mode keeps the design's numbers via `|| default`
    ramp: M.ramp || 0.042, pickBase: M.pickBase || 2.1, deathAt: M.deathAt || 2, hold: M.hold || 3,
    // "shaped" = race shaping + the field-narrowing eff ramp (SPRINT via warmup,
    // the long boards via targetSec). targetSec 0 => the design's natural resolve.
    shaped: !!(M.warmup || M.targetSec), targetSec: M.targetSec || 0,
    time: 0, phase: 'run', overAt: 0, shake: 0, sparks: [], pops: [], timeScale: 1,
    pickups: [], nextPick: M.warmup ? 0.5 : 1.4, bombAt: -9, bombBy: 0,
    stage: 0, stageAt: -9, outAt: -9, outWho: 0, overFrame: 0, needy: null,
    // final-two fight: when it started, how long the free trading lasts, and
    // who's currently ahead + since when (the knockout waits for a held lead)
    duelAt: -9, duelHold: M.warmup ? 2.2 : 3, duelSettle: 0, duelWinner: -1, leadClock: [0, 0, 0, 0],
    duelArc: -1, arcAt: -9, leadWho: -1, leadSince: 0, endgame: false, effLevel: 0,
    barShown: [25, 25, 25, 25], winnerIdx: -1, elimOrder: [],
    // telemetry for the close-game/comeback classifier (Season Mode's seed-search
    // oracle, and this episode's own outro badge) — running MINIMUMS over the
    // final-two DUEL only (never the 4-way: every board starts at an exact
    // 25/25/25/25 split and stays noisy/near-tied while balls first contest
    // territory, so a whole-match "closest margin ever" is ~always ~0 and
    // doesn't discriminate a real blowout from a real nail-biter — the duel is
    // the phase the "nail-biter" / "comeback" language actually describes).
    // duelMarginMin: closest the two duelists' shares ever got. duelShareMin:
    // each duelist's own lowest share of the final two. Both from advance().
    duelMarginMin: 100, duelShareMin: [1, 1, 1, 1],
    balls: spawn.map((s, i) => {
      let a = rnd() * Math.PI * 2;
      for (let g = 0; g < 24; g++) {
        const off = Math.abs(((a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2) - Math.PI / 4);
        if (off < Math.PI / 4 - 0.25) break;
        a = rnd() * Math.PI * 2;
      }
      const mul = 0.92 + rnd() * 0.2;
      return {
        i, x: BX + s[0] * BW, y: BY + s[1] * BH, r: R, mul,
        vx: Math.cos(a) * M.speed * mul, vy: Math.sin(a) * M.speed * mul,
        trail: [], flash: 0, out: false, rb: 0,
      };
    }),
  };

  // SPRINT cold-open: fast-forward the sim so frame one is already mid-fight.
  // Fixed 1/240 step (NOT fps-derived); warmup flips/bombs are discarded by the
  // recorder (see `warming`). Trails are pushed at ~frame cadence (every 4th
  // substep) so frame one shows the streaks, like a running game.
  if (M.warmup) {
    warming = true;
    const sdt = 1 / 240;
    let sub = 0;
    for (let t = 0; t < M.warmup; t += sdt) {
      G.time += sdt; step(sdt);
      if (++sub % 4 === 0) for (const b of G.balls) if (!b.out) {
        b.trail.push(b.x, b.y); if (b.trail.length > 20) b.trail.splice(0, 2);
      }
    }
    G.stage = Math.floor(G.time / 10);
    // clear transient state so frame one isn't shaking or flashing a "PAINT BOMB"
    // banner for a warmup bomb nobody heard.
    G.shake = 0; G.bombAt = -9; G.outAt = -9; G.sparks.length = 0; G.pops.length = 0;
    for (const b of G.balls) b.flash = 0;
    warming = false;
  }

  hudT = -9;
  hud(true);
}

/* ═══════════════ audio — SPEC §11 (event recorder in render mode) ═══════════════
   Mirrors sfxFlip's rate gate + combo ladder exactly so the offline synth
   in python/colorwar_audio.py reproduces the same graph. */
const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
const BASE_HZ = [55, 62, 69, 74].map((n) => n * 4);   // 220 / 248 / 276 / 296

function makeSoundRecorder() {
  let buf = [];
  let combo = 0, comboAt = -9, lastFlip = -9;
  // drop everything the SPRINT warmup fires — those ~3.4 s of flips/bombs happen
  // before frame zero and would otherwise pile up at t=0 (design guards audioOn()).
  const push = (o) => { if (warming) return; o.t = +G.time.toFixed(4); o.f = CW.frame; buf.push(o); };
  return {
    _drain() { const b = buf; buf = []; return b; },
    flip(who) {
      const now = G.time;
      if (now - lastFlip < 0.045) return;             // §11.1 rate gate — drops the sound entirely
      lastFlip = now;
      if (now - comboAt > 0.4) combo = 0;             // §11.1 combo reset
      comboAt = now;
      const step = SCALE[Math.min(SCALE.length - 1, combo)];
      combo++;
      push({ type: 'flip', hz: BASE_HZ[who] * Math.pow(2, step / 12), sound: FLIP_SOUND });
    },
    bomb() { push({ type: 'bomb' }); },
    death() { push({ type: 'death' }); },
    win(who) { push({ type: 'win', base: BASE_HZ[who] }); },
  };
}

function liveSound() {
  // browser-preview only — a faithful-ish Web Audio version of §11.
  // starts MUTED: rerolling 20 candidate sims shouldn't blast audio each time.
  let ac, master, duck, noiseBuf, muted = true;
  let combo = 0, comboAt = 0, lastFlip = 0;
  const ensure = () => {
    if (!ac) {
      const A = window.AudioContext || window.webkitAudioContext; if (!A) return;
      ac = new A();
      master = ac.createGain(); master.gain.value = 0.26; master.connect(ac.destination);
      duck = ac.createGain(); duck.gain.value = 1; duck.connect(master);
      noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.5, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ac && ac.state === 'suspended') ac.resume();
  };
  const pluck = (hz, now) => {
    const g = ac.createGain();
    g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(0.5, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0008, now + 0.09); g.connect(duck);
    const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = hz;
    o.connect(g); o.start(now); o.stop(now + 0.1);
    const o2 = ac.createOscillator(); o2.type = 'sine'; o2.frequency.value = hz * 2.01;
    const g2 = ac.createGain(); g2.gain.setValueAtTime(0.18, now);
    g2.gain.exponentialRampToValueAtTime(0.0006, now + 0.05);
    o2.connect(g2); g2.connect(duck); o2.start(now); o2.stop(now + 0.06);
    const cs = ac.createBufferSource(); cs.buffer = noiseBuf;
    const cf = ac.createBiquadFilter(); cf.type = 'highpass'; cf.frequency.value = 3200;
    const cg = ac.createGain(); cg.gain.setValueAtTime(0.1, now);
    cg.gain.exponentialRampToValueAtTime(0.0005, now + 0.02);
    cs.connect(cf); cf.connect(cg); cg.connect(duck); cs.start(now); cs.stop(now + 0.03);
  };
  const bubble = (hz, now) => {
    const o = ac.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(hz * 0.42, now);
    o.frequency.exponentialRampToValueAtTime(hz, now + 0.042);
    o.frequency.exponentialRampToValueAtTime(hz * 1.06, now + 0.075);
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 5.5;
    bp.frequency.setValueAtTime(hz * 1.6, now);
    bp.frequency.exponentialRampToValueAtTime(hz * 3.4, now + 0.06);
    const g = ac.createGain(); g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.62, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0008, now + 0.085);
    o.connect(bp); bp.connect(g); g.connect(duck); o.start(now); o.stop(now + 0.1);
    const cs = ac.createBufferSource(); cs.buffer = noiseBuf;
    const cf = ac.createBiquadFilter(); cf.type = 'bandpass'; cf.Q.value = 2.2;
    cf.frequency.setValueAtTime(hz * 1.2, now);
    cf.frequency.exponentialRampToValueAtTime(hz * 3.2, now + 0.05);
    const cg = ac.createGain(); cg.gain.setValueAtTime(0.0001, now);
    cg.gain.linearRampToValueAtTime(0.16, now + 0.008);
    cg.gain.exponentialRampToValueAtTime(0.0004, now + 0.055);
    cs.connect(cf); cf.connect(cg); cg.connect(duck); cs.start(now); cs.stop(now + 0.07);
  };
  return {
    _drain() { return []; },
    ensure,
    toggle() { muted = !muted; if (ac) master.gain.value = muted ? 0 : 0.26; return muted; },
    setEnabled(on) { muted = !on; if (on) ensure(); if (ac) master.gain.value = muted ? 0 : 0.26; },
    flip(who) {
      if (warming) return;
      ensure(); if (!ac || muted) return;
      const now = ac.currentTime;
      if (now - lastFlip < 0.045) return; lastFlip = now;
      if (now - comboAt > 0.4) combo = 0; comboAt = now;
      const step = SCALE[Math.min(SCALE.length - 1, combo)]; combo++;
      const hz = BASE_HZ[who] * Math.pow(2, step / 12);
      (FLIP_SOUND === 'bubble' ? bubble : pluck)(hz, now);
    },
    bomb() {
      if (warming) return;
      ensure(); if (!ac || muted) return;
      const now = ac.currentTime, out = master;
      const s = ac.createBufferSource(); s.buffer = noiseBuf;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
      bp.frequency.setValueAtTime(1500, now); bp.frequency.exponentialRampToValueAtTime(420, now + 0.13);
      const sg = ac.createGain(); sg.gain.setValueAtTime(0.0001, now);
      sg.gain.linearRampToValueAtTime(0.22, now + 0.008); sg.gain.exponentialRampToValueAtTime(0.0005, now + 0.14);
      s.connect(bp); bp.connect(sg); sg.connect(out); s.start(now); s.stop(now + 0.16);
      const o = ac.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(96, now); o.frequency.exponentialRampToValueAtTime(34, now + 0.26);
      const og = ac.createGain(); og.gain.setValueAtTime(0.0001, now);
      og.gain.linearRampToValueAtTime(0.5, now + 0.01); og.gain.exponentialRampToValueAtTime(0.001, now + 0.34);
      o.connect(og); og.connect(out); o.start(now); o.stop(now + 0.36);
      const root = 174.6;
      const bl = ac.createBiquadFilter(); bl.type = 'lowpass';
      bl.frequency.setValueAtTime(1500, now); bl.frequency.exponentialRampToValueAtTime(3400, now + 0.12);
      const bg = ac.createGain(); bg.gain.setValueAtTime(0.0001, now);
      bg.gain.linearRampToValueAtTime(0.34, now + 0.05); bg.gain.exponentialRampToValueAtTime(0.0006, now + 0.5);
      bl.connect(bg); bg.connect(out);
      [1, 1.25, 1.5, 2].forEach((mul, k) => {
        const t0 = now + 0.014 + k * 0.012;
        const v = ac.createOscillator(); v.type = k === 3 ? 'sine' : 'triangle'; v.frequency.value = root * mul;
        const vg = ac.createGain(); vg.gain.setValueAtTime(0.0001, t0);
        vg.gain.linearRampToValueAtTime(k === 3 ? 0.07 : 0.13, t0 + 0.02);
        vg.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.46);
        v.connect(vg); vg.connect(bl); v.start(t0); v.stop(t0 + 0.48);
      });
      duck.gain.cancelScheduledValues(now);
      duck.gain.setValueAtTime(0.4, now); duck.gain.setValueAtTime(0.4, now + 0.07);
      duck.gain.linearRampToValueAtTime(1, now + 0.3);
    },
    death() {
      ensure(); if (!ac || muted) return;
      const now = ac.currentTime;
      const o = ac.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(620, now); o.frequency.exponentialRampToValueAtTime(48, now + 0.7);
      const lpf = ac.createBiquadFilter(); lpf.type = 'lowpass';
      lpf.frequency.setValueAtTime(2400, now); lpf.frequency.exponentialRampToValueAtTime(300, now + 0.7);
      const g = ac.createGain(); g.gain.setValueAtTime(0.34, now);
      g.gain.exponentialRampToValueAtTime(0.0006, now + 0.78);
      o.connect(lpf); lpf.connect(g); g.connect(duck); o.start(now); o.stop(now + 0.8);
    },
    win(who) {
      ensure(); if (!ac || muted) return;
      const now = ac.currentTime, base = BASE_HZ[who];
      [0, 4, 7, 12].forEach((st, k) => {
        const t0 = now + k * 0.09;
        const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = base * Math.pow(2, st / 12);
        const g = ac.createGain(); g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.36, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0006, t0 + 0.42);
        o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + 0.44);
      });
    },
  };
}

/* ═══════════════ helpers (SPEC §5.2, §9) ═══════════════ */
function claim(c, r, owner) {
  const w = G;
  if (c < 0 || r < 0 || c >= w.cols || r >= w.rows) return false;
  const k = r * w.cols + c;
  if (w.grid[k] === owner) return false;
  w.grid[k] = owner;
  if (w.pops.length < 260) w.pops.push({ c, r, life: 1, owner });
  return true;
}
function spark(x, y, col, n) {
  const w = G;
  if (w.sparks.length > 320) return;
  for (let k = 0; k < n; k++) {
    const a = rnd() * 6.28, sp = 90 + rnd() * 340;
    w.sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, c: col });
  }
}
function speedMul() {
  // SPEC §5.4 ramp, per-mode rate. Capped: a ~45 s board would otherwise ramp the
  // balls fast enough to tunnel tiles by the finish. Past the cap the pace stays
  // high — and the wild final-two shaping carries the "fast" feel — but bounded.
  const cap = G.mode.warmup ? 2.4 : 1.5;
  return 1 + Math.min(cap, Math.max(0, G.time) * G.ramp);
}
function tally() {
  const w = G, n = w.cols * w.rows, cnt = [0, 0, 0, 0];
  for (let k = 0; k < n; k++) cnt[w.grid[k]]++;
  return cnt.map((v, i) => ({ i, v, pct: (v / n) * 100 }));
}

/* ── race shaping (per frame, before step) — every shaped mode. Two regimes:

   3-4 alive (the "pump"): a WEAK spring so colours genuinely drift apart, then a
   per-colour storm-back — a colour slides toward the danger zone almost unopposed
   ("it's going to lose"), and once it's genuinely tiny (<13.5% share) it ROCKETS
   back into contention ("it's back!"). A runaway leader (>par+16%) is eased. That
   gives several big, readable "was tiny, now huge" swings on the top bar per clip.
   The elimination `rescuing` guard keeps a mid-comeback colour alive until the
   field-narrowing ramp (w.effLevel) is really climbing.

   Final two (user 2026-09-09: "FAST… one seems about to lose then comes back,
   then the other… the ending needs to be TIGHT, little room each, multiple plot
   twists"):
     SPRINT — a 3-act fight (trade → closing → endgame collapse) over ~5-6 s.
     Boards — ONE continuous tight oscillator (no phase change): a stiff spring to
       50/50 + a `b.behindFor` integral so a rally OVERSHOOTS into a lead → the
       lead keeps flipping (~10-24×), both colours keep hitting ~42-56 % and
       storming back, right to the end. From `settle 0.66` a `clinch` ramp toward
       `w.duelWinner` (the fair `w.leadClock` winner) grows until it resolves the
       round — late enough the loser still surges once or twice first.
   Deterministic (tile counts + seeded pickup bias). `b.rb` feeds step()'s brush
   width / speed / pickup reach. ── */
function shapeRace(tly) {
  const w = G, n = w.cols * w.rows;
  const alive = w.balls.filter((b) => !b.out);
  const tot = alive.reduce((s, b) => s + tly[b.i].v, 0) || 1;
  const par = 1 / alive.length;
  let lead = alive[0], trail = alive[0];
  for (const b of alive) {
    const bv = tly[b.i].v;
    // b.mul (seeded per colour per seed) breaks exact ties, so a dead-even
    // opening doesn't consistently favour the lowest colour index
    if (bv > tly[lead.i].v || (bv === tly[lead.i].v && b.mul > lead.mul)) lead = b;
    if (bv < tly[trail.i].v || (bv === tly[trail.i].v && b.mul < trail.mul)) trail = b;
  }
  const gap = (tly[lead.i].v - tly[trail.i].v) / n;                 // 0..1 board fraction
  const two = alive.length === 2;
  const sprint = !!w.mode.warmup;
  const duelT = two && w.duelAt > 0 ? w.time - w.duelAt : -1;
  // SPRINT final-two acts
  const closing = two && sprint && duelT > w.duelHold;
  const endgameS = two && sprint && duelT > w.duelHold + 1.3;
  // board final two — legit physics only (bombs a ball grabs on its own frontier
  // + mild ball steering toward the frontier). Runs in ARCS:
  //   arc 0,1  a "victim" colour (which one first is seeded) is GROUND DOWN to
  //            ~12-18 % over ~3.5 s ("it's FINISHED"), then storms back over ~2 s.
  //   arc 2    the victim is forced = `w.duelWinner` → the winner drops to ~15 %.
  //   FINAL ACT  `w.duelSettle` ramps → w.duelWinner storms back and WINS.
  const dph = ((((curSeed >>> 0) * 2654435761) >>> 0) % 62831) / 10000;
  if (two && !sprint && duelT > 6 && w.duelWinner < 0) {
    // lock the winner = who led MORE of the first ~6 s. Tie-break on seeded
    // `b.mul`, NOT index order.
    const [a, b2] = alive;
    const d = w.leadClock[a.i] - w.leadClock[b2.i];
    w.duelWinner = (Math.abs(d) > 0.3 ? d > 0 : a.mul > b2.mul) ? a.i : b2.i;
  }
  let vic = null, agg = null, swGrind = false, settle = 0;
  if (two && !sprint) {
    if (w.arcAt < 0 || (w.duelArc < 2 && w.time - w.arcAt > 4.2)) {
      w.duelArc = w.arcAt < 0 ? 0 : w.duelArc + 1;
      w.arcAt = w.time;
    }
    const arcT = w.time - w.arcAt;
    if (w.duelArc >= 2) {
      // forced arc: grind the winner to ~22 % over ~2.2 s, then the FINAL-ACT
      // ramp (winner storms back and wins).
      vic = w.balls[w.duelWinner];
      agg = alive[0] === vic ? alive[1] : alive[0];
      swGrind = arcT < 2.2;
      settle = Math.max(0, Math.min(1, (arcT - 2.2) / 3.2));
    } else if (w.duelArc >= 0) {
      const first = dph > Math.PI ? alive[0] : alive[1];
      vic = w.duelArc % 2 === 0 ? first : (first === alive[0] ? alive[1] : alive[0]);
      agg = vic === alive[0] ? alive[1] : alive[0];
      swGrind = arcT < 3.7;              // grind 3.7 s (to ~10-15 %), storm back ~1 s
    }
    w.duelFloor = w.duelArc >= 2 ? 0.3 : 0.1;   // the winner's forced dip is shallower (fast recovery)
  }
  w.duelSettle = settle;
  // "pump" = the 4-way "crash then storm back" shaping — all shaped modes.
  const pump = alive.length > 2;
  // once the field-narrowing ramp is really climbing (w.effLevel set in advance()),
  // stop rescuing stragglers so the field can narrow — until then, comebacks win.
  const lateGame = (w.effLevel || 0) > 0.42;
  const g = Math.max(0, gap - 0.06);                                // deadband — trade phases only
  // capped: a big deficit (e.g. right after 3→2 hands the heir a chunk of
  // territory) claws back over ~2 s, not in a single half-second teleport.
  const surge = Math.min(3.2, g * 3 + g * g * 26);
  for (const b of w.balls) {
    if (b.out) { b.rb = 0; continue; }
    const share = tly[b.i].v / tot;
    // 3-4 alive: a WEAK spring, so colours genuinely drift apart. Then the pump:
    // a colour slides DOWN almost unopposed toward the danger zone ("it's going
    // to lose"), and once it's genuinely tiny it ROCKETS back into contention
    // ("it's back!") — a big, readable swing on the top bar. All shaped modes.
    let rb = (par - share) * (two ? 5.5 : 1.4);
    if (two && sprint) {
      // ── SPRINT: the original 3-act fight ──
      if (endgameS) {
        if (b === lead) rb = Math.max(rb, 2) + gap * 4;
        else rb = Math.min(rb, -2) - gap * 5;
      } else if (b === trail) {
        rb += Math.max(closing ? 1 : 0, 0.4 + surge * (closing ? 1.5 : 1));
      } else {
        rb -= (0.2 + surge * 0.4) * (closing ? 1.35 : 1);
      }
    } else if (two && vic) {
      // ── boards, FINAL TWO ──
      const win = b.i === w.duelWinner;
      if (settle > 0) {
        // FINAL ACT — w.duelWinner (at ~30 % coming in) storms back and wins,
        // the loser choked. Strong so it resolves from a deficit in ~3-4 s.
        rb = win ? 4 + settle * 2.6 : -(2.6 + settle * 4.6);
      } else {
        const vshare = tly[vic.i].v / tot;
        const fl = w.duelFloor || 0.1;
        if (b === vic) {
          rb = swGrind
            ? (vshare < fl ? 0.3 : -(4 + Math.max(0, 0.3 - vshare) * 12))       // ground down
            : 3 + Math.max(0, 0.45 - vshare) * 10;                              // storming back
        } else {
          rb = swGrind ? 2.8 : -1.8;                                            // agg pushes / eases off
        }
      }
    } else if (pump) {
      if (share < 0.135 && !lateGame) {
        // VERY small — hard rocket back. At 4% share: 2.4 + 3.8 = ~6.2 rb (max
        // brush, +16% speed, a huge pickup vacuum) — back to ~25% in ~1.5 s.
        rb += 2.4 + (0.135 - share) * 42;
      } else if (share < par - 0.05) {
        // behind but not tiny — only a gentle nudge, so it keeps sliding toward
        // the danger zone (that's the "it's losing" part of the arc)
        rb += (par - share) * 1.6;
      } else if (share > par + 0.16) {
        // a real runaway — ease off so the leader can't just win outright at 50%
        rb -= (share - par - 0.16) * 8;
      }
    }
    b.rb = rb;
  }
  // pickups: a paint bomb a colour's ball grabs in ENEMY ground = a big legit
  // swing (step() places it there). Board final two: GRIND → feed the aggressor
  // (drives the victim down); STORM-BACK → feed the victim; FINAL ACT → feed
  // w.duelWinner. SPRINT endgame feeds the LEADER. 4-way: whoever's behind.
  w.endgame = two && sprint && endgameS;
  const trailShare = tly[trail.i].v / n;
  w.needy = two
    ? (sprint
        ? (w.endgame ? lead : trail)
        : settle > 0 ? (w.duelWinner >= 0 ? w.balls[w.duelWinner] : lead)
        : swGrind ? agg
        : vic)
    : (pump && trailShare < par - 0.045) ? trail
    : (trail.rb > 0.5 ? trail : null);
}

/* ═══════════════ step — SPEC §5, 1:1 with _extracted-logic.js ═══════════════ */
function step(dt) {
  const w = G, cols = w.cols, rows = w.rows, tw = w.tw, th = w.th;
  const cellAt = (x, y) => {
    const c = Math.floor((x - BX) / tw), r = Math.floor((y - BY) / th);
    if (c < 0 || r < 0 || c >= cols || r >= rows) return -1;
    return w.grid[r * cols + c];
  };
  const gcol = (x) => Math.floor((x - BX) / tw);
  const grow = (y) => Math.floor((y - BY) / th);
  const sm = speedMul();
  const nLive = w.balls.reduce((s, b) => s + (b.out ? 0 : 1), 0);
  const boardTwo2 = nLive === 2 && !w.mode.warmup;

  for (const b of w.balls) {
    if (b.out) continue;
    // race shaping: behind -> wider brush + a touch faster; ahead -> the reverse
    const bru = Math.max(w.brush - 1, Math.min(w.brush + 2, w.brush + Math.round(b.rb || 0)));
    const spdF = 1 + Math.max(-0.05, Math.min(0.16, (b.rb || 0) * 0.09));
    let nx = b.x + b.vx * dt;
    const edgeX = b.vx > 0 ? nx + b.r : nx - b.r;
    if (edgeX < BX || edgeX > BX + BW) { b.vx = -b.vx; b.flash = 1; w.shake = Math.max(w.shake, 5); }
    else {
      const o = cellAt(edgeX, b.y);
      if (o !== b.i && o !== -1) {
        const c = gcol(edgeX), r = grow(b.y);
        for (let d = -bru; d <= bru; d++) claim(c, r + d, b.i);
        b.vx = -b.vx; b.flash = 1;
        spark(BX + c * tw + tw / 2, BY + r * th + th / 2, COLS[b.i], 5);
        Sound.flip(b.i);
        w.shake = Math.max(w.shake, 4);
      } else b.x = nx;
    }
    let ny = b.y + b.vy * dt;
    const edgeY = b.vy > 0 ? ny + b.r : ny - b.r;
    if (edgeY < BY || edgeY > BY + BH) { b.vy = -b.vy; b.flash = 1; w.shake = Math.max(w.shake, 5); }
    else {
      const o = cellAt(b.x, edgeY);
      if (o !== b.i && o !== -1) {
        const c = gcol(b.x), r = grow(edgeY);
        for (let d = -bru; d <= bru; d++) claim(c + d, r, b.i);
        b.vy = -b.vy; b.flash = 1;
        spark(BX + c * tw + tw / 2, BY + r * th + th / 2, COLS[b.i], 5);
        Sound.flip(b.i);
        w.shake = Math.max(w.shake, 4);
      } else b.y = ny;
    }

    claim(gcol(b.x), grow(b.y), b.i);
    b.x = Math.max(BX + b.r, Math.min(BX + BW - b.r, b.x));
    b.y = Math.max(BY + b.r, Math.min(BY + BH - b.r, b.y));
    if (b.flash > 0) b.flash -= dt * 4;
    const sp = Math.hypot(b.vx, b.vy) || 1;
    const want = w.mode.speed * b.mul * spdF * sm;
    const eased = sp + (want - sp) * Math.min(1, dt * 3);
    b.vx = (b.vx / sp) * eased; b.vy = (b.vy / sp) * eased;
    // board final two: both balls hover the contested FRONTIER (roughly the
    // midpoint between them) — mild steering, so the fight happens where enemy
    // tiles actually are and the brush/bomb shaping decides it. w.needy also
    // homes its nearest bomb. All still ball motion — nothing moves on its own.
    if (boardTwo2 && w.duelAt >= 0) {
      let tx = 0, ty = 0, sw2 = 0;
      for (const o of w.balls) if (!o.out && o !== b) { tx = (b.x + o.x) / 2; ty = (b.y + o.y) / 2; }
      if (b === w.needy) {
        let nd2 = 1e18;
        for (const p of w.pickups) {
          if (p.owner !== b.i) continue;
          const dd = (p.x - b.x) ** 2 + (p.y - b.y) ** 2;
          if (dd < nd2) { nd2 = dd; tx = p.x; ty = p.y; sw2 = 1; }
        }
      }
      const dx = tx - b.x, dy = ty - b.y, dl = Math.hypot(dx, dy) || 1;
      const steer = eased * (sw2 ? 2.4 : 1.1) * dt;
      b.vx += (dx / dl) * steer; b.vy += (dy / dl) * steer;
      const s2 = Math.hypot(b.vx, b.vy) || 1;
      b.vx = (b.vx / s2) * eased; b.vy = (b.vy / s2) * eased;
    }
    if (Math.abs(b.vx) < eased * 0.25) b.vx += (b.vx >= 0 ? 1 : -1) * eased * 0.6 * dt;
    if (Math.abs(b.vy) < eased * 0.25) b.vy += (b.vy >= 0 ? 1 : -1) * eased * 0.6 * dt;
  }

  w.nextPick -= dt;
  // board final two: a stream of heavy bombs, each spawned on the FRONTIER in
  // enemy ground next to nd's ball, owner-gated to nd. nd's ball is right on its
  // frontier constantly, so it sweeps them up — a legit "ball hits pickup" swing.
  const lull = boardTwo2 && (w.duelSettle || 0) >= 1;
  const cap = lull ? 0 : boardTwo2 ? 3 : w.endgame ? 1 : nLive === 2 ? 3 : 2 + w.stage;
  if (w.nextPick <= 0 && w.pickups.length < cap) {
    w.nextPick = boardTwo2 ? 0.34 : w.endgame ? 1 : nLive === 2 ? 0.8 : Math.max(0.3, w.pickBase - w.stage * 0.42);
    const nd = w.needy;
    if (boardTwo2 && nd) {
      // nearest enemy frontier cell to nd's ball.
      const foeI = w.balls.find((b) => !b.out && b !== nd).i;
      const bc = gcol(nd.x), br = grow(nd.y);
      let best = -1, bestD = 1e9;
      for (let rr = 1; rr < rows - 1; rr++) for (let cc = 1; cc < cols - 1; cc++) {
        const k = rr * cols + cc;
        if (w.grid[k] !== foeI) continue;
        if (w.grid[k - 1] !== nd.i && w.grid[k + 1] !== nd.i &&
            w.grid[k - cols] !== nd.i && w.grid[k + cols] !== nd.i) continue;
        const d = (cc - bc) ** 2 + (rr - br) ** 2;
        if (d < bestD) { bestD = d; best = k; }
      }
      if (best >= 0) {
        const cc = best % cols, rr = (best - cc) / cols;
        let ok = true;
        for (const p of w.pickups) if (Math.abs(p.c - cc) + Math.abs(p.r - rr) < 3) ok = false;
        if (ok) w.pickups.push({ c: cc, r: rr, x: BX + cc * tw + tw / 2, y: BY + rr * th + th / 2, born: w.time, owner: nd.i });
      }
    } else for (let tries = 0; tries < 14; tries++) {
      let c, r;
      const nearNeedy = nd && rnd() < 0.6;
      if (nearNeedy) {   // bias the spawn toward the trailing colour's ball
        c = gcol(nd.x) + Math.round((rnd() - 0.5) * 6);   // tighter ring, so it can reach it
        r = grow(nd.y) + Math.round((rnd() - 0.5) * 6);
        c = Math.max(1, Math.min(cols - 2, c)); r = Math.max(1, Math.min(rows - 2, r));
      } else {
        c = 1 + Math.floor(rnd() * (cols - 2)); r = 1 + Math.floor(rnd() * (rows - 2));
      }
      const px = BX + c * tw + tw / 2, py = BY + r * th + th / 2;
      let ok = true;
      // straggler-biased spawns may land a bit closer (120 px) so they're
      // actually reachable; everything else keeps the 175 px buffer
      const minGap = nearNeedy ? 120 : 175;
      for (const b of w.balls) if (!b.out && Math.hypot(b.x - px, b.y - py) < minGap) ok = false;
      for (const p of w.pickups) if (Math.hypot(p.x - px, p.y - py) < 190) ok = false;
      if (ok) { w.pickups.push({ c, r, x: px, y: py, born: w.time }); break; }
    }
  }
  // board final-two pickups clear after ~2 s (a stale one, from before an arc
  // flipped, would otherwise just sit there).
  if (boardTwo2) for (let pi = w.pickups.length - 1; pi >= 0; pi--) {
    if (w.pickups[pi].owner !== undefined && w.time - w.pickups[pi].born > 2) w.pickups.splice(pi, 1);
  }
  for (let pi = w.pickups.length - 1; pi >= 0; pi--) {
    const p = w.pickups[pi];
    for (const b of w.balls) {
      // grab range: the ball's edge reaches the pickup's ring (drawn ~46 px). A
      // touch ALWAYS detonates — no owner gate on the trigger (that made a ball
      // visibly hit a bomb and nothing happen). `p.owner` only decides who it
      // detonates FOR (so a grind bomb still hurts the victim if the victim runs
      // into it); an un-owned pickup goes to the toucher.
      const reach = p.owner !== undefined ? b.r + 55 : b.r + 40;
      if (b.out || Math.hypot(b.x - p.x, b.y - p.y) > reach) continue;
      w.pickups.splice(pi, 1);
      const benef = p.owner !== undefined ? p.owner : b.i;
      // Bomb radius. Board final-two bombs are a big board fraction — the pickup
      // sits at the frontier so ~half the circle flips enemy tiles → a ~15 %
      // swing per bomb. The 4-way keeps the design's growing bomb, capped ~38 %.
      const frac = (f) => Math.max(2, Math.round(Math.sqrt((f * w.cols * w.rows) / Math.PI)));
      const rad = boardTwo2
        ? frac(0.4)
        : w.endgame
        ? Math.max(3, Math.round((w.bombR + w.stage * 2) * 0.6))
        : w.mode.warmup
        ? w.bombR + w.stage * 2
        : Math.min(w.bombR + w.stage * 2, frac(0.38));
      for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
        if (dc * dc + dr * dr > rad * rad) continue;
        claim(p.c + dc, p.r + dr, benef);
      }
      spark(p.x, p.y, COLS[benef], 46);
      spark(p.x, p.y, '#ffffff', 20);
      w.shake = 26; b.flash = 1; w.bombAt = w.time; w.bombBy = benef;
      Sound.bomb();
      break;
    }
  }

  for (const s of w.sparks) { s.x += s.vx * dt; s.y += s.vy * dt; s.vx *= 1 - 2 * dt; s.vy *= 1 - 2 * dt; s.life -= dt * 2.2; }
  w.sparks = w.sparks.filter((s) => s.life > 0);
  for (const p of w.pops) p.life -= dt * 3.2;
  w.pops = w.pops.filter((p) => p.life > 0);
}

/* ═══════════════ advance one frame — the design's loop() body ═══════════════ */
function advance(dt) {
  const w = G;
  w.time += dt;

  // No countdown — the round starts on frame 1 (SPRINT additionally fast-forwards
  // in reset()). `w.time` runs continuously from 0 and the audio pass places
  // every event by its absolute frame index.

  if (w.phase === 'run') {
    const st = Math.floor(w.time / 10);
    if (st !== w.stage) { w.stage = st; w.stageAt = w.time; }
  }

  const tly = tally();
  const nAll = w.cols * w.rows;
  // field-narrowing "eff ramp" level (0..1 of the board). Read by shapeRace (to
  // decide when to stop protecting comebacks) and used below as the 3+ knockout
  // threshold. SPRINT: quadratic off visible time. The ~30 s boards: a curve
  // landing the last knockout near targetSec (nothing before ~10 s — pure 4-way).
  if (w.phase === 'run' && w.shaped) {
    const vs = w.time - (w.mode.warmup || 0);
    w.effLevel = w.mode.warmup
      ? Math.min(1, (Math.max(0, vs - 6) ** 2 * 1.7) / nAll)
      : Math.min(0.85, Math.max(0, (w.time - 10) / Math.max(5, (w.targetSec || 30) - 22)) ** 1.8 * 0.9);
  }
  const ranked = tly.slice().sort((a, b) => b.v - a.v);
  const liveRanked = ranked.filter((t) => !w.balls[t.i].out);
  // SPRINT keeps a touch of slow-mo on the neck-and-neck beats (its cinematic
  // cold-open finish). The ~45 s boards stay at FULL speed once it's down to two —
  // the user's note was explicit: "why are they slow, this is the endgame, it
  // should be fast". The wild lead-swapping carries the drama, not a slowed clock.
  const duel = w.mode.warmup && liveRanked.length === 2 &&
    Math.abs(liveRanked[0].pct - liveRanked[1].pct) < 9;
  w.timeScale += ((duel ? 0.55 : 1) - w.timeScale) * Math.min(1, dt * 8);

  if (w.phase === 'run') {
    // race shaping — close scores + the comeback beat. SPRINT + the ~30 s boards;
    // an un-tagged mode keeps the design's untouched dynamics.
    if (w.shaped) shapeRace(tly);
    const sub = 4, sdt = (dt * w.timeScale) / sub;
    for (let k = 0; k < sub; k++) step(sdt);
  }

  if (w.phase === 'run') {
    const alive = w.balls.filter((b) => !b.out);
    // FINAL TWO: step()'s big bomb swings moved the grid since `tly` was taken —
    // re-tally so the leader tracking + KO threshold read the CURRENT board.
    if (!w.mode.warmup && alive.length === 2 && w.duelAt >= 0) {
      for (let i = 0; i < 4; i++) tly[i].v = 0;
      for (let k = 0; k < w.grid.length; k++) tly[w.grid[k]].v++;
      for (let i = 0; i < 4; i++) tly[i].pct = (tly[i].v / nAll) * 100;
    }
    if (alive.length === 2 && w.duelAt < 0) w.duelAt = w.time;   // start the final-two fight clock
    // track who leads the final two, and since when — the knockout won't fire
    // until the leader has actually held the lead a beat (so a bomb swing can't
    // instantly end it on the colour that was, a frame ago, losing).
    if (alive.length === 2) {
      // tile-count leader, tie-broken on seeded b.mul (NOT index order — in a
      // 50/50 nailbiter the tie fires constantly and index order would pile all
      // the leadClock onto BLUE).
      const [d0, d1] = alive;
      const dv = tly[d0.i].v - tly[d1.i].v;
      const ld = (dv !== 0 ? dv > 0 : d0.mul > d1.mul) ? d0.i : d1.i;
      if (ld !== w.leadWho) { w.leadWho = ld; w.leadSince = w.time; }
      // who's been ahead LONGER over the whole fight — the closing locks the
      // winner on this. The first ~4 s are weighted DOWN: the 3→2 elimination
      // dumps the dead colour's tiles on the nearest survivor, so whoever gets
      // that dump starts ahead — discount it so leadClock reflects the actual
      // back-and-forth, not the board geometry of the last knockout.
      if ((w.duelSettle || 0) < 0.4) {
        w.leadClock[ld] += dt * Math.min(1, (w.time - w.duelAt) / 3.5);
      }
      // `b.behindFor` (seconds the colour has been the trailer) — an integral
      // term read by shapeRace: the longer a colour is stuck behind, the harder
      // its rally, so a storm-back OVERSHOOTS into a lead instead of stalling.
      const tot2 = tly[alive[0].i].v + tly[alive[1].i].v || 1;
      for (const b of alive) {
        b.behindFor = tly[b.i].v / tot2 < 0.5 ? (b.behindFor || 0) + dt : 0;
        // each duelist's own lowest share of the final two, ever — "was the
        // eventual winner down to a sliver at some point" reads this off
        // whichever colour ends up winning.
        w.duelShareMin[b.i] = Math.min(w.duelShareMin[b.i], tly[b.i].v / tot2);
      }
      // closest the two duelists' shares ever got, e.g. a lead-flip crossing
      // near 50/50 — a genuine blowout duel (no flips, decisive from the
      // start) never dips back down near 0 the way a real back-and-forth does.
      w.duelMarginMin = Math.min(w.duelMarginMin, (Math.abs(tly[d0.i].v - tly[d1.i].v) / tot2) * 100);
    }
    // a colour dies at <= deathAt tiles (SPRINT 5, others 2). Knockouts are spaced
    // so 4-way → 3-way → duel reads as distinct stages, never a pile-up. The
    // ~30 s boards space them wide; SPRINT tighter (it only has ~16 s total).
    const koGap = !w.shaped ? 0.7
      : alive.length === 4 ? (w.mode.warmup ? 1.1 : 2.5)
      : alive.length === 3 ? (w.mode.warmup ? 1.3 : 5)
      : 0.7;
    if (alive.length > 1 && w.time - w.outAt > koGap) {
      const n = w.cols * w.rows;
      let eff = w.deathAt;
      let heldLead = true;
      const boardTwo = w.shaped && !w.mode.warmup && alive.length === 2;
      const duelT = alive.length === 2 && w.duelAt > 0 ? w.time - w.duelAt : 0;
      // pathological seed: the bombs won't fall for w.duelWinner (bad board
      // geometry), so the finish stalemates. Well past the window, drop the lock —
      // whoever's actually ahead finishes it. Deterministic + bounded.
      const overtime = boardTwo && duelT > 19;
      if (w.shaped) {
        if (alive.length === 2) {
          if (w.mode.warmup) {
            // SPRINT — unchanged: the threshold ramps once the trade window is
            // spent, and only bites once one colour is decisively ahead AND has
            // held that lead a beat (an earned collapse, not a coin flip).
            eff += Math.max(0, duelT - w.duelHold - 1.2) ** 2 * 3.6;
            const strongest = tly[alive[0].i].v >= tly[alive[1].i].v ? alive[0] : alive[1];
            heldLead = w.leadWho === strongest.i && w.time - w.leadSince > 1.2;
          } else if (overtime) {
            eff = n;                                   // threshold wide open
            heldLead = w.time - w.leadSince > 0.6;
          } else {
            // boards — NO knockout through the big bomb swings (settle 0). In the
            // FINAL ACT `settle` ramps 0→1; the winner's bombs + brush crush the
            // loser and the KO bites once the loser is genuinely beaten AND
            // w.duelWinner has held the lead ~0.8 s (so a last swing delays it).
            const cl = w.duelSettle || 0;
            eff += cl ** 1.25 * n * 0.34;             // → ~36 % of board at settle 1
            heldLead = cl > 0.5 && w.leadWho === w.duelWinner && w.time - w.leadSince > 0.8;
          }
        } else {
          // 3-4 alive: the field-narrowing ramp (w.effLevel, both mode types)
          eff += w.effLevel * n;
        }
      } else if (w.time > 90) eff = n;
      // boards final-two: the loser is the NON-w.duelWinner (not picked by tile
      // count — an osc surge briefly makes the winner the fewest-tiles colour, and
      // knocking THEM out would break the lock). In overtime the lock is off, so
      // fall back to fewest tiles. Elsewhere: fewest tiles, tie → lowest index.
      const weakest = (boardTwo && w.duelWinner >= 0 && !overtime)
        ? (alive[0].i === w.duelWinner ? alive[1] : alive[0])
        : alive.slice().sort((a, b) => tly[a.i].v - tly[b.i].v)[0];
      // final two: once the leader has held it and the loser is clearly beaten,
      // end it — no slow grind-out. SPRINT: loser < 30 %. Boards: loser genuinely
      // crushed in the final act (the eff ramp is the normal trigger).
      const crushLine = w.mode.warmup ? 0.3 : 0.2;
      const crushed = w.shaped && alive.length === 2 &&
        (w.mode.warmup || (w.duelSettle || 0) > 0.6) && tly[weakest.i].v < n * crushLine;
      // 3-4 alive: never knock out a colour that's mid-comeback (rb high) until
      // the ramp is really climbing (lateGame) — that's what makes the deep dips
      // safe, so "about to lose" doesn't just mean "eliminated".
      const rescuing = alive.length > 2 && weakest.rb > 2 && w.effLevel <= 0.42;
      if (heldLead && !rescuing && (tly[weakest.i].v <= eff || crushed)) {
        const b = weakest;
        b.out = true; w.elimOrder.push(b.i);
        w.shake = 28; w.outAt = w.time; w.outWho = b.i;
        spark(b.x, b.y, COLS[b.i], 40);
        spark(b.x, b.y, '#ffffff', 16);
        Sound.death();
        const survivors = alive.filter((o) => o !== b);
        if (w.mode.warmup || survivors.length === 1) {
          // SPRINT (unchanged) / any final hand-off: lowest-index survivor inherits.
          const heir = survivors[0].i;
          for (let k = 0; k < n; k++) if (w.grid[k] === b.i) w.grid[k] = heir;
        } else {
          // boards: split the eliminated colour's tiles to the NEAREST surviving
          // ball, tile by tile — a clean regional takeover, and (unlike "lowest
          // index inherits everything") no colour gets a systematic territory
          // dump that would skew who enters / wins the duel.
          for (let k = 0; k < n; k++) {
            if (w.grid[k] !== b.i) continue;
            const cx = BX + ((k % w.cols) + 0.5) * w.tw;
            const cy = BY + ((Math.floor(k / w.cols)) + 0.5) * w.th;
            let heir = survivors[0].i, bd = Infinity;
            for (const o of survivors) {
              const d = (o.x - cx) ** 2 + (o.y - cy) ** 2;
              if (d < bd) { bd = d; heir = o.i; }
            }
            w.grid[k] = heir;
          }
        }
      }
    }
    const left = w.balls.filter((b) => !b.out);
    if (left.length === 1) {
      const win = left[0];
      w.phase = 'over'; w.overAt = w.time; w.overFrame = CW.frame; w.winnerIdx = win.i;
      announce(win.i);
      spark(win.x, win.y, COLS[win.i], 60);
      Sound.win(win.i);
      w.shake = 32;
      // Season Mode confetti: a few extra bursts across the top of the board in
      // the winner's colour, on top of the design's existing win spark. Fired
      // once, right here (never from hud(), which can run more than once per
      // frame in live preview) so it can't double-fire or skip the seeded rnd().
      if (SEASON_MODE) {
        for (const fx of [0.22, 0.5, 0.78]) spark(BX + BW * fx, BY + 10, COLS[win.i], 44);
        spark(win.x, win.y, '#ffffff', 24);
      }
    }
  }

  w.shake *= 1 - Math.min(1, dt * 7);
  for (const b of w.balls) if (!b.out) { b.trail.push(b.x, b.y); if (b.trail.length > 20) b.trail.splice(0, 2); }

  // share-bar display lerp — advanced per fixed sim step (NOT per paint) so the
  // bar animates identically in preview and render.
  const k = Math.min(1, dt / 0.18);
  for (let i = 0; i < 4; i++) {
    const target = w.balls[i].out ? 0.001 : Math.max(0.5, tly[i].pct);
    w.barShown[i] += (target - w.barShown[i]) * k;
  }
}

/* paint the current sim state — canvas + DOM HUD. No state change, no seeded
   RNG; safe to call any number of times per frame. */
function paint() {
  draw();
  hud(false);
}

function announce(i) {
  el('winLine').textContent = SEASON_MODE ? `EPISODE ${EPISODE_N} WINNER: ${NAMES[i]}` : NAMES[i] + ' WON';
  el('win').style.setProperty('--wc', COLS[i]);
  el('win').style.display = 'flex';
}

/* close-game/comeback classifier — read by CW.result() (the season seed-search
   oracle) AND by the season outro badge, off the SAME running-min state, so
   the two never disagree. Thresholds map onto the spec's own "5-8 %" / "small
   sliver" language and this session's measured classic averages (~7 % typical
   deepest dip), so most seeds are expected to pass without any searching. */
function thrillerInfo() {
  const w = G, wi = w.winnerIdx >= 0 ? w.winnerIdx : 0;
  const wonCleanly = w.phase === 'over';
  const closestMarginDuelPct = +Math.min(100, w.duelMarginMin).toFixed(1);
  const deepestDipDuringDuelPct = +(Math.min(1, w.duelShareMin[wi]) * 100).toFixed(1);
  const isComeback = wonCleanly && deepestDipDuringDuelPct <= 15;
  const isThriller = wonCleanly && (closestMarginDuelPct <= 8 || isComeback);
  return { wonCleanly, closestMarginDuelPct, deepestDipDuringDuelPct, isThriller, isComeback };
}

/* ═══════════════ draw — SPEC §9, 1:1 with _extracted-logic.js ═══════════════ */
function draw() {
  const w = G, cols = COLS, tw = w.tw, th = w.th;
  const S = cv.width / W;
  ctx.setTransform(S, 0, 0, S, 0, 0);
  ctx.fillStyle = '#05050b'; ctx.fillRect(0, 0, W, H);
  ctx.save();
  // cosmetic jitter — Math.random(), NOT the seeded rnd() (see the RNG note): a
  // preview at 120 Hz would draw() twice as often and shift the sim's RNG stream.
  ctx.translate((Math.random() - 0.5) * w.shake, (Math.random() - 0.5) * w.shake);

  for (let r = 0; r < w.rows; r++) for (let c = 0; c < w.cols; c++) {
    ctx.fillStyle = cols[w.grid[r * w.cols + c]];
    ctx.globalAlpha = 0.52;   // SPEC §9.3 is 0.4; nudged up for a more solid,
    ctx.fillRect(BX + c * tw, BY + r * th, tw + 1, th + 1);   // less washed field (user)
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(0,0,0,.44)'; ctx.lineWidth = 1.5;   // §9.3 is .34
  for (let c = 1; c < w.cols; c++) { ctx.beginPath(); ctx.moveTo(BX + c * tw, BY); ctx.lineTo(BX + c * tw, BY + BH); ctx.stroke(); }
  for (let r = 1; r < w.rows; r++) { ctx.beginPath(); ctx.moveTo(BX, BY + r * th); ctx.lineTo(BX + BW, BY + r * th); ctx.stroke(); }

  for (const p of w.pops) {
    const g = 1 - p.life;
    ctx.globalAlpha = p.life * 0.9;
    ctx.fillStyle = cols[p.owner];
    const pad = g * Math.min(tw, th) * 0.5;
    ctx.fillRect(BX + p.c * tw + pad, BY + p.r * th + pad, tw - pad * 2, th - pad * 2);
  }
  ctx.globalAlpha = 1;

  ctx.strokeStyle = 'rgba(140,170,255,.5)'; ctx.lineWidth = 4;
  ctx.strokeRect(BX - 2, BY - 2, BW + 4, BH + 4);

  for (const p of w.pickups) {
    const pu = 0.5 + 0.5 * Math.sin((w.time - p.born) * 7);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate((w.time - p.born) * 1.6);
    ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 22 + pu * 26;
    ctx.fillStyle = '#ffffff';
    const s3 = 20 + pu * 5;
    ctx.beginPath();
    ctx.moveTo(0, -s3); ctx.lineTo(s3, 0); ctx.lineTo(0, s3); ctx.lineTo(-s3, 0);
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.25 + pu * 0.45) + ')'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(0, 0, 34 + pu * 12, 0, 6.284); ctx.stroke();
    ctx.restore();
  }

  for (const s of w.sparks) {
    ctx.globalAlpha = Math.max(0, s.life); ctx.fillStyle = s.c;
    const sz = 6 * s.life + 2;
    ctx.fillRect(s.x - sz / 2, s.y - sz / 2, sz, sz);
  }
  ctx.globalAlpha = 1;

  const square = SHAPE === 'square';
  for (const b of w.balls) {
    if (b.out) continue;
    const col = cols[b.i];
    ctx.strokeStyle = col; ctx.lineCap = 'round';
    for (let k = 2; k < b.trail.length; k += 2) {
      ctx.globalAlpha = (k / b.trail.length) * 0.4;
      ctx.lineWidth = b.r * 1.5 * (k / b.trail.length);
      ctx.beginPath(); ctx.moveTo(b.trail[k - 2], b.trail[k - 1]); ctx.lineTo(b.trail[k], b.trail[k + 1]); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.shadowColor = col; ctx.shadowBlur = 28 + b.flash * 50;
    ctx.fillStyle = col;
    if (square) {
      const s2 = b.r, k2 = 7;
      ctx.beginPath();
      ctx.moveTo(b.x - s2 + k2, b.y - s2);
      ctx.arcTo(b.x + s2, b.y - s2, b.x + s2, b.y + s2, k2);
      ctx.arcTo(b.x + s2, b.y + s2, b.x - s2, b.y + s2, k2);
      ctx.arcTo(b.x - s2, b.y + s2, b.x - s2, b.y - s2, k2);
      ctx.arcTo(b.x - s2, b.y - s2, b.x + s2, b.y - s2, k2);
      ctx.closePath(); ctx.fill();
    } else { ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 6.284); ctx.fill(); }
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    ctx.beginPath(); ctx.arc(b.x - b.r * 0.3, b.y - b.r * 0.32, b.r * 0.26, 0, 6.284); ctx.fill();
    if (b.flash > 0) {
      ctx.globalAlpha = b.flash * 0.7; ctx.strokeStyle = '#fff'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 10 + b.flash * 20, 0, 6.284); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();

  const vg = ctx.createRadialGradient(W / 2, H / 2, 620, W / 2, H / 2, 1280);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.42)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
}

/* ═══════════════ HUD — SPEC §10, 1:1 ═══════════════ */
// reproduces the @keyframes cwPop the design's CSS applies to the winner text
// (scale .55 -> 1.1 at 62% -> 1.0, opacity 0 -> 1 by 62%, ease-out) — driven off
// sim time so it stays deterministic under frame-stepping.
function popStyle(t0, dur) {
  const p = Math.min(1, Math.max(0, (G.time - t0) / dur));
  const e = 1 - Math.pow(1 - p, 2);                       // ease-out
  const s = e < 0.62 ? 0.55 + 0.55 * (e / 0.62)
                     : 1.1 - 0.1 * ((e - 0.62) / 0.38);
  return { t: 'scale(' + s.toFixed(4) + ')', o: String(Math.min(1, e / 0.62)) };
}

// Season Mode's displayed score for each colour: SCORES_BEFORE, plus an eased
// +1 tick-up for the winner once the episode is over. Frame-time-driven (no
// CSS), same philosophy as popStyle() — deterministic under frame-stepping.
function seasonScores() {
  const w = G, out = SCORES_BEFORE.slice();
  if (w.phase === 'over') {
    const wi = w.winnerIdx >= 0 ? w.winnerIdx : 0;
    const p = Math.min(1, Math.max(0, (w.time - w.overAt) / 0.6));
    out[wi] += 1 - Math.pow(1 - p, 2);   // ease-out, matches popStyle's curve
  }
  return out;
}

// Season Mode's three visual-only additions, all purely a function of w.time /
// CW.frame so they render identically under frame-stepping: an opening title
// card, a <1s panel-snap reveal of the board, and an outro COMEBACK/CLUTCH
// badge. None of this reads or writes anything the sim/physics depend on.
const SNAP_DIRS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];   // per-quadrant slide-out direction
let seasonPanelsInit = false;
function seasonOverlay() {
  if (!SEASON_MODE) return;
  const w = G;
  const card = el('seasonCard'), panels = el('snapPanels'), badge = el('epBadge');
  if (!seasonPanelsInit) {
    el('seasonBig').textContent = `SEASON ${SEASON_N}`;
    el('seasonSmall').textContent = `EPISODE ${EPISODE_N} OF ${TOTAL_EPISODES}`;
    for (let i = 0; i < 4; i++) panels.children[i].style.background = COLS[i];
    // persistent label above the score bar — up for the WHOLE episode (not just
    // the opening card), so any frame you land on still reads season/episode.
    const label = el('seasonLabel');
    label.textContent = `SEASON ${SEASON_N} · EPISODE ${EPISODE_N} OF ${TOTAL_EPISODES}`;
    label.style.display = 'block';
    seasonPanelsInit = true;
  }
  const introEnd = 1.0, snapEnd = 1.6;
  // the score-chip HUD is otherwise on from frame 1 — hide it under the title
  // card so that first moment reads as one clean beat, not text-over-a-HUD.
  el('hud').style.visibility = w.time < introEnd ? 'hidden' : 'visible';
  if (w.time < introEnd) {
    // quick fade IN, then hold solid — no fade OUT. The user was explicit
    // ("no slow fades") and a dissolve here would spend ~0.2s with the title
    // text fighting the board for attention right when the hook needs to land.
    // It CUTS straight to the panel-snap phase below instead.
    card.style.display = 'flex'; panels.style.display = 'none';
    card.style.opacity = String(Math.min(1, w.time / 0.1));
  } else if (w.time < snapEnd) {
    card.style.display = 'none'; panels.style.display = 'block';
    const p = (w.time - introEnd) / (snapEnd - introEnd);
    const ease = 1 - Math.pow(1 - p, 3);   // ease-out cubic — a snappy finish
    for (let i = 0; i < 4; i++) {
      const pn = panels.children[i];
      pn.style.transform = `translate(${SNAP_DIRS[i][0] * ease * 120}%, ${SNAP_DIRS[i][1] * ease * 120}%)`;
    }
  } else {
    card.style.display = 'none'; panels.style.display = 'none';
  }
  if (w.phase === 'over') {
    const info = thrillerInfo();
    const label = info.isComeback ? 'COMEBACK!' : info.isThriller ? 'CLUTCH WIN' : '';
    if (label) {
      const wi = w.winnerIdx >= 0 ? w.winnerIdx : 0;
      badge.textContent = label;
      badge.style.background = COLS[wi];
      badge.style.display = 'block';
      const p = popStyle(w.overAt + 0.25, 0.3);
      badge.style.transform = p.t; badge.style.opacity = p.o;
    } else badge.style.display = 'none';
  } else badge.style.display = 'none';
}

let hudT = -9;
function hud(force) {
  const w = G;
  if (!force && !RENDER && w.time - hudT < 0.1) return;   // §10: throttled to 0.1s
  hudT = w.time;
  const tly = tally();
  const c = COLS;
  const aliveArr = w.balls.filter((b) => !b.out);
  const doomedI = aliveArr.length > 1
    ? aliveArr.slice().sort((a, b) => tly[a.i].v - tly[b.i].v)[0].i
    : -1;

  el('count').style.display = 'none';   // no countdown — starts on frame 1

  // win pop (cwPop)
  if (w.phase === 'over') {
    const wp = popStyle(w.overAt, 0.38);
    const wls = el('winLine').style; wls.transform = wp.t; wls.opacity = wp.o;
  }

  // share bar — width comes from w.barShown, which advance() lerps per fixed step.
  // Season Mode replaces the LIVE territory read with the running season score
  // (wins so far, not counting this episode) — same markup, different numbers,
  // so nothing about the layout/CSS has to change.
  const barEl = el('bar'), chipsEl = el('chips');
  const seasonScoreNow = SEASON_MODE ? seasonScores() : null;
  const seasonTotal = seasonScoreNow ? Math.max(1, seasonScoreNow.reduce((s, v) => s + v, 0)) : 1;
  for (let i = 0; i < 4; i++) {
    const t = tly[i], out = w.balls[i].out;
    const seg = barEl.children[i], chip = chipsEl.children[i];
    const dot = chip.querySelector('.dot');
    dot.style.background = c[i]; dot.style.color = c[i];
    if (seasonScoreNow) {
      seg.style.width = (seasonScoreNow[i] / seasonTotal) * 100 + '%';
      seg.style.background = c[i]; seg.style.opacity = '1';
      chip.style.opacity = '1'; chip.style.borderColor = 'rgba(255,255,255,.09)';
      chip.querySelector('.cv').textContent = String(Math.round(seasonScoreNow[i]));
    } else {
      seg.style.width = w.barShown[i] + '%';
      seg.style.background = c[i];
      seg.style.opacity = out ? '0.22' : '1';
      chip.style.opacity = out ? '0.22' : '1';
      chip.style.borderColor = i === doomedI && w.phase === 'run'
        ? 'rgba(255,61,113,.9)' : 'rgba(255,255,255,.09)';
      chip.querySelector('.cv').textContent = out ? 'OUT' : Math.round(t.pct) + '%';
    }
  }
  seasonOverlay();

  const lr = tly.slice().sort((a, b) => b.v - a.v).filter((t) => !w.balls[t.i].out);
  const duel = lr.length === 2 && Math.abs(lr[0].pct - lr[1].pct) < 6;
  const stageFresh = w.phase === 'run' && w.time - w.stageAt < 1.6 && w.stage > 0;
  const bomb = w.phase === 'run' && w.time - w.bombAt < 1.1;
  const knock = w.phase === 'run' && w.time - w.outAt < 1.6;
  const fl = w.phase !== 'run' ? null
    : knock ? NAMES[w.outWho] + ' WIPED OUT'
    : bomb ? NAMES[w.bombBy] + ' PAINT BOMB'
    : duel ? 'FINAL DUEL' : null;
  // a speed stage never sets its own label — it only recolours whatever
  // banner is already showing. Precedence: knock > stageFresh > bomb.
  const fc = knock ? 'rgba(255,61,113,.94)'
    : stageFresh ? 'rgba(0,231,255,.9)'
    : bomb ? c[w.bombBy] : 'rgba(0,0,0,.7)';
  const flEl = el('flash');
  if (fl) {
    flEl.textContent = fl; flEl.style.background = fc; flEl.style.display = 'block';
    // cwPulse — opacity .5 -> 1 -> .5 over 0.7s, triangular
    const ph = (w.time % 0.7) / 0.7;
    flEl.style.opacity = 0.5 + 0.5 * (ph < 0.5 ? ph / 0.5 : (1 - ph) / 0.5);
  } else flEl.style.display = 'none';
}

/* finishing order for the result JSON (not part of the design) */
function orderByProgress() {
  const w = G, t = tally();
  const done = new Set(w.elimOrder);
  const standing = [0, 1, 2, 3].filter((i) => !done.has(i)).sort((a, b) => t[b].v - t[a].v);
  return [...standing, ...w.elimOrder.slice().reverse()].map((i) => NAMES[i]);
}

/* ═══════════════ loop / render API ═══════════════ */
const DT = 1 / FPS;             // fixed timestep — the ONLY dt ever passed to advance()

// preview loop: a fixed-timestep accumulator. rAF delta varies with refresh
// rate + drops, so we bank wall-time (scaled by `speed`) and spend it in whole
// DT steps. `speed` runs MORE steps, it does not change DT — so preview seed N
// and render seed N step the sim identically.
let raf = 0, acc = 0, prevT = 0, speed = 1, autoReplay = false;
const randSeed = () => ((Math.random() * 0x7fffffff) >>> 0) || 1;

function startRound(seed, mode) {
  el('win').style.display = 'none';
  reset(seed, mode);
  acc = 0; prevT = 0;
}

function tick(now) {
  raf = requestAnimationFrame(tick);
  if (!prevT) prevT = now;
  acc += Math.min(0.25, (now - prevT) / 1000) * speed;
  prevT = now;
  let guard = 0;
  while (acc >= DT && guard++ < 800) { CW.frame += 1; advance(DT); acc -= DT; }
  if (G.phase === 'over' && G.time - G.overAt > G.hold + (autoReplay ? 1.2 : 0) && autoReplay) {
    startRound(randSeed(), curMode);
  }
  paint();
}

function resize() {
  const dpr = RENDER ? SS : Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  // Size the backing store to the pixels the canvas ACTUALLY occupies on screen.
  // In render mode the stage is shrunk to a TikTok-safe box, so a canvas sized to
  // the full 1080×1920 space would be > its CSS box and the compositor would give
  // it a soft non-integer downscale (that was the "brushed out" look). Matching
  // clientWidth·dpr makes it a 1:1 blit; the supersampling comes from a high --ss
  // + the ffmpeg lanczos step.
  const cssW = cv.clientWidth || W;
  const cssH = cv.clientHeight || H;
  cv.width = Math.max(1, Math.round(cssW * dpr));
  cv.height = Math.max(1, Math.round(cssH * dpr));
  ctx.imageSmoothingQuality = 'high';
}
resize();
addEventListener('resize', () => { if (!RENDER) resize(); });

function boot() {
  Sound = RENDER ? makeSoundRecorder() : liveSound();
  el('win').style.display = 'none';
  resize();                 // re-measure now that layout + fonts are settled
  reset();
}

if (RENDER) {
  CW.step = () => {
    CW.frame += 1;
    advance(DT);
    paint();
    const events = Sound._drain();
    let done = false;
    if (G.phase === 'over' && G.time >= G.overAt + G.hold) done = true;
    if (CW.frame >= CW._hardCap) done = true;
    CW.done = done;
    return { frame: CW.frame, events, done };
  };
  CW.result = () => {
    const w = G, wi = w.winnerIdx >= 0 ? w.winnerIdx : 0, t = tally();
    return {
      seed: curSeed,
      mode: w.mode.key, modeName: w.mode.name,
      winner: NAMES[wi],
      winnerRgb: hexToRgb(COLS[wi]),
      colors: NAMES.slice(),
      order: orderByProgress(),
      // render-relative (frame-based) — the SPRINT warmup runs before frame 1 so
      // w.overAt / w.time carry the warmup seconds; CW.frame does not.
      winAtSec: +((w.phase === 'over' ? (w.overFrame || CW.frame) : CW.frame) / FPS).toFixed(2),
      durationSec: +(CW.frame / FPS).toFixed(2),
      frames: CW.frame, fps: FPS,
      winnerPct: Math.round(t[wi].pct),
      // close-game/comeback telemetry — see thrillerInfo(). `wonCleanly` also
      // covers a latent bug: without it, a seed that only ever hit the safety
      // frame-cap (never a real phase==='over' win) reported `winner` silently
      // defaulted to index 0/BLUE with no way to tell it wasn't a real result.
      ...thrillerInfo(),
    };
  };
  (async () => {
    try { if (document.fonts) { document.fonts.load('700 40px "Chakra Petch"'); await document.fonts.ready; } } catch (e) {}
    boot();
    // safety cap only — the round self-terminates. ?sec= overrides; else SPRINT
    // gets a tight cap, the ~30 s boards land near targetSec, an un-tagged mode
    // gets the design's generous headroom.
    const capSec = CAP_SEC || (G.mode.warmup ? 26 : G.targetSec ? G.targetSec + 20 : 95);
    CW._hardCap = Math.round(capSec * FPS);
    CW.meta = { fps: FPS, totalFrames: CW._hardCap, seed: curSeed, width: W, height: H };
  })();
} else {
  /* ── preview studio API (window.CW.*) ── */
  boot();
  CW.replay = (seed) => startRound(seed === undefined || seed === null || seed === '' ? randSeed() : (Number(seed) >>> 0) || 1, curMode);
  CW.again = () => startRound(curSeed, curMode);
  CW.setMode = (m) => startRound(randSeed(), String(m).toLowerCase());
  CW.setSpeed = (s) => { speed = [0.5, 1, 2, 4].includes(+s) ? +s : 1; };
  CW.setAutoReplay = (on) => { autoReplay = !!on; };
  CW.setSound = (on) => { if (Sound.setEnabled) Sound.setEnabled(!!on); };
  CW.getSeed = () => curSeed;
  CW.getMode = () => curMode;
  CW.readout = () => {
    const w = G, live = w.balls.filter((b) => !b.out);
    return {
      seed: curSeed, mode: curMode, modeName: w.mode.name,
      phase: w.phase,
      roundSec: +Math.max(0, w.time - (w.mode.warmup || 0)).toFixed(2),
      alive: live.map((b) => NAMES[b.i]),
      elimOrder: w.elimOrder.map((i) => NAMES[i]),
      winner: w.phase === 'over' ? NAMES[w.winnerIdx] : null,
      finalSec: w.phase === 'over' ? +(w.overFrame / FPS).toFixed(2) : null,
    };
  };
  CW._tick = tick;   // exposed so a headless harness can pump the accumulator with fake timestamps
  raf = requestAnimationFrame(tick);
  el('stage').addEventListener('pointerdown', () => Sound.ensure && Sound.ensure(), { once: true });
}

function hexToRgb(h) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255];
}

window.ColorWar = { restart: boot, get world() { return G; }, seed: () => curSeed };
window.CW = CW;

})();

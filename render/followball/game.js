"use strict";
(function () {
/* ═══════════════════════════════════════════════════════════════
   FOLLOW THE BALL — the clipper "Follow the ball" content type.

   A 1:1 port of the Claude Design handoff (Follow The Ball handoff/
   SPEC.md + Follow The Ball.dc.html) — a shell game: the ball is shown
   under a cup, the cups shuffle back-to-back, the viewer calls the cup,
   the correct cup lifts. Every run rerolls (start cup, swap count, swap
   pairs, arc directions, durations) so no two clips share a solution.
   Layout constants, the smoothstep swap arc, the z-sorted draw order,
   the satisfaction layer (contact shadow / landing squash / table
   ripple / sheen / ground glow), the HUD and the palette are the
   design's. Modes: SPRINT (default, 3 rounds) / CLASSIC (5) / INSANE (5).

   Render plumbing (invisible): seeded mulberry32 for Math.random()
   in the SIM (scrambled — cosmetic screen-shake keeps Math.random()),
   FTB.step/meta/result frame API, and the Web-Audio calls become an
   event log that python/followball_audio.py re-synthesises offline
   (walking minor-pentatonic swap notes, reveal / tick / answer / finish).
   ═══════════════════════════════════════════════════════════════ */

const QS = new URLSearchParams(location.search);
const RENDER = QS.get('render') === '1';
const SEED = (parseInt(QS.get('seed') || '1', 10) >>> 0) || 1;
const FPS = Math.max(20, Math.min(60, parseInt(QS.get('fps') || '60', 10)));
const W = 1080, H = 1920;                             // the design's fixed coordinate space
const SS = Math.max(1, Math.min(4, parseFloat(QS.get('ss') || '2')));
const MODE_PARAM = (QS.get('mode') || 'sprint').toLowerCase();   // sprint | classic | insane | random
// live in preview mode — the studio can reroll the seed and switch the mode.
// render mode never touches these, so preview seed N and render seed N build
// from the identical RNG state.
let curSeed = SEED;
let curMode = MODE_PARAM;
// safety frame cap only — the game self-terminates on the score card. ?sec= overrides.
const CAP_SEC = QS.has('sec') ? Math.max(8, Math.min(90, parseFloat(QS.get('sec')) || 24)) : null;

const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
const el = (id) => document.getElementById(id);

const FTB = { frame: 0, done: false, meta: null, _hardCap: 999999 };

/* ── deterministic RNG (mulberry32) for the SIM. reset() re-seeds it from the
   current seed, so a given seed always produces the same script / answers /
   length whether it's previewed or rendered. Cosmetic-only randomness (the
   answer screen-shake in draw()) uses Math.random(), never this — a preview at
   a different refresh rate would draw() a different number of times and shift
   the sim's RNG stream. ── */
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
// seeded ints/floats — the design's `ri` / `rf`, renamed so they never read as
// the world's round index `w.ri`.
const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const rflt = (a, b) => a + rnd() * (b - a);

/* ── SPEC §1: layout (authored 1080×1920). Nudged off the design (1360/560/980)
   for the vertical TikTok crop: CUP_BOT a touch lower + taller cups (CUP_H 680)
   so the cup row FILLS the band between the HUD and the guess bar instead of
   floating with dead space above and below. LIFT respects both SPEC §1 bounds —
   a fully raised cup tops out at 1400-400-680 = 320 (clears the HUD, rises behind
   the big label as in the design) and bottoms out at 1000 (above the ball ~1172). ── */
const CUP_BOT = 1400, CUP_H = 680, LIFT = 400;
const ROW_Y = 1020;

/* ── SPEC §2: difficulty labels by round index ── */
const DIFF = [
  { name: 'EASY',   c: '#1fd645' },
  { name: 'MEDIUM', c: '#ffd21f' },
  { name: 'HARD',   c: '#ff9d2f' },
  { name: 'EXPERT', c: '#ff2f3d' },
  { name: 'INSANE', c: '#ff3dd1' },
];

/* ── SPEC §2: modes — rounds are RANGES, the actual values reroll every run.
   SPRINT carries a "pace" layer (show / answer / askMul / scoreHold): the spec's
   own numeric ranges run ~24 s, which contradicts its "~17s" header and the
   README's hard "do not lengthen it" (16 s clip = 60% completion vs 29% on 60 s).
   This trims only the fixed dead time (show 1.0→0.6, answer 1.5→0.82, ask ×0.8,
   end card 3→1.9) — the shuffle, the actual game, and every rerolled value in
   SPEC §3 are untouched. Lands ~18–19 s. CLASSIC / INSANE keep the design's exact
   values via `|| default`. ── */
const MODES = [
  { name: 'SPRINT', tag: '3 rounds · ~20s',
    show: 0.8, answer: 0.9, askMul: 0.82, durMul: 1, scoreHold: 2.0, rounds: [
    { cups: 3, swaps: [4, 5],   dur: [0.42, 0.5],  ask: 2.0 },
    { cups: 4, swaps: [6, 8],   dur: [0.32, 0.38], ask: 2.0 },
    { cups: 5, swaps: [9, 11],  dur: [0.24, 0.29], ask: 2.2 },
  ] },
  { name: 'CLASSIC', tag: '5 rounds · ~34s', rounds: [
    { cups: 3, swaps: [3, 4],   dur: [0.5, 0.58],  ask: 2.2 },
    { cups: 3, swaps: [5, 7],   dur: [0.4, 0.46],  ask: 2.2 },
    { cups: 4, swaps: [7, 9],   dur: [0.32, 0.38], ask: 2.2 },
    { cups: 4, swaps: [10, 12], dur: [0.26, 0.31], ask: 2.4 },
    { cups: 5, swaps: [12, 15], dur: [0.21, 0.26], ask: 2.6 },
  ] },
  { name: 'INSANE', tag: '5 rounds · brutal', rounds: [
    { cups: 4, swaps: [6, 8],   dur: [0.3, 0.35],  ask: 1.8 },
    { cups: 5, swaps: [9, 11],  dur: [0.24, 0.28], ask: 1.8 },
    { cups: 5, swaps: [13, 16], dur: [0.19, 0.23], ask: 2.0 },
    { cups: 6, swaps: [16, 19], dur: [0.16, 0.2],  ask: 2.2 },
    { cups: 6, swaps: [20, 24], dur: [0.13, 0.17], ask: 2.4 },
  ] },
];
function pickMode() {
  if (curMode === 'random') return Math.floor(rnd() * MODES.length);
  const i = MODES.findIndex((m) => m.name.toLowerCase() === curMode);
  return i >= 0 ? i : 0;   // absent / unknown -> SPRINT, never random
}

/* ═══════════════ world (SPEC §1–3 — reset()) ═══════════════ */
let G = null, Sound = null;

function cupSpan(n) { return n <= 3 ? 320 : n === 4 ? 240 : n === 5 ? 195 : 162; }
// the ball scales with the cup it hides under, so 6-cup rounds still fit
function ballR(n) { return Math.min(108, cupSpan(n) * 0.94 * 0.36); }
function slotX(slot, n) {
  const span = cupSpan(n), gap = 18;
  const total = n * span + (n - 1) * gap;
  return (W - total) / 2 + slot * (span + gap) + span / 2;
}

function reset(seed, mode) {
  if (mode !== undefined) curMode = mode;
  if (seed !== undefined) curSeed = seed >>> 0;
  seedRng(curSeed);          // canonical RNG state — identical for preview & render
  FTB.frame = 0; FTB.done = false;
  const M = MODES[pickMode()];
  // reroll the whole script up front so the run is fully determined but new (SPEC §3)
  const dMul = M.durMul || 1, aMul = M.askMul || 1;
  const plan = M.rounds.map((r) => ({
    cups: r.cups,
    swaps: rint(r.swaps[0], r.swaps[1]),
    dur: rflt(r.dur[0], r.dur[1]) * dMul,
    ask: r.ask * aMul,
  }));
  G = {
    mode: M, plan, ri: -1, time: 0, phase: 'intro', phaseAt: 0,
    cups: [], ball: 0, swap: null, left: 0, sparks: [], ripples: [],
    results: [], shake: 0, lift: 0, reveal: 0, pulse: 0, note: 0, tick: -1,
    bigAt: 0, bigKey: '', pipsKey: '',
  };
  nextRound();
  hudT = -9;
  hud(true);
}

function nextRound() {
  const w = G;
  w.ri++;
  if (w.ri >= w.plan.length) {
    w.phase = 'score'; w.phaseAt = w.time;
    Sound.finish();
    return;   // hud() renders the end card
  }
  const R = w.plan[w.ri], n = R.cups;
  w.cups = [];
  for (let i = 0; i < n; i++) w.cups.push({ id: i, slot: i, x: slotX(i, n), y: 0, z: 0, land: 0 });
  w.ball = rint(0, n - 1);   // SPEC §3: which cup starts with the ball
  w.left = R.swaps;
  w.swap = null;
  w.lift = 0; w.reveal = 0;
  w.phase = 'show'; w.phaseAt = w.time;
  Sound.reveal();
}

/* ═══════════════ audio — SPEC §6 (event recorder in render mode) ═══════════════
   The recorder mirrors sfxSwap's 0.045s rate gate + the walking-pentatonic note
   walk exactly (on the SIM clock, not wall clock) so the offline synth in
   python/followball_audio.py reproduces the same sequence. */
const SWAP_SCALE = [0, 3, 5, 7, 10, 12, 15, 17];
const SWAP_BASE = 233;

function makeSoundRecorder() {
  let buf = [];
  let lastSwap = -9;
  const push = (o) => { o.t = +G.time.toFixed(4); o.f = FTB.frame; buf.push(o); };
  return {
    _drain() { const b = buf; buf = []; return b; },
    swap(speed) {
      if (G.time - lastSwap < 0.045) return;          // SPEC §6 rate gate — drops the sound
      lastSwap = G.time;
      G.note = ((G.note || 0) + 1) % SWAP_SCALE.length;
      push({ type: 'swap', hz: SWAP_BASE * Math.pow(2, SWAP_SCALE[G.note] / 12), speed });
    },
    reveal() { push({ type: 'reveal' }); },
    tick(hot) { push({ type: 'tick', hot: hot ? 1 : 0 }); },
    answer() { push({ type: 'answer' }); },
    finish() { push({ type: 'finish' }); },
  };
}

function liveSound() {
  // browser-preview only — a faithful Web Audio port of SPEC §6.
  // starts MUTED: rerolling 20 candidate sims shouldn't blast audio each time.
  let ac, master, duck, noiseBuf, muted = true;
  let lastSwap = 0, note = 0;
  const ensure = () => {
    if (!ac) {
      const A = window.AudioContext || window.webkitAudioContext; if (!A) return;
      ac = new A();
      master = ac.createGain(); master.gain.value = muted ? 0 : 0.28; master.connect(ac.destination);
      duck = ac.createGain(); duck.gain.value = 1; duck.connect(master);
      noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.5, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ac && ac.state === 'suspended') ac.resume();
  };
  // SPEC §6 shared envelope — nothing is ever cut while still audible
  const env = (node, at, peak, atk, dec, dest) => {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(peak, at + atk);
    g.gain.exponentialRampToValueAtTime(0.0008, at + atk + dec);
    g.gain.linearRampToValueAtTime(0, at + atk + dec + 0.02);
    node.connect(g); g.connect(dest || duck);
    return at + atk + dec + 0.04;
  };
  return {
    _drain() { return []; },
    ensure,
    toggle() { muted = !muted; if (ac) master.gain.value = muted ? 0 : 0.28; return muted; },
    setEnabled(on) { muted = !on; if (on) ensure(); if (ac) master.gain.value = muted ? 0 : 0.28; },
    swap(speed) {
      ensure(); if (!ac || muted) return;
      const now = ac.currentTime;
      if (now - lastSwap < 0.045) return; lastSwap = now;
      note = (note + 1) % SWAP_SCALE.length;
      const hz = SWAP_BASE * Math.pow(2, SWAP_SCALE[note] / 12);
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.value = 2200 + speed * 1400; lp.Q.value = 0.9;
      const end = env(lp, now, 0.3, 0.012, 0.26);
      const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = hz;
      o.connect(lp); o.start(now); o.stop(end);
      const o2 = ac.createOscillator(); o2.type = 'triangle'; o2.frequency.value = hz * 2;
      const g2 = ac.createGain(); g2.gain.value = 0.24;
      o2.connect(g2); g2.connect(lp); o2.start(now); o2.stop(end);
      const s = ac.createBufferSource(); s.buffer = noiseBuf;
      s.playbackRate.value = 0.8 + Math.random() * 0.4;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.8;
      bp.frequency.setValueAtTime(900 + speed * 700, now);
      bp.frequency.linearRampToValueAtTime(1800 + speed * 900, now + 0.1);
      const e2 = env(bp, now, 0.045, 0.03, 0.1);
      s.connect(bp); s.start(now); s.stop(e2);
    },
    reveal() {
      ensure(); if (!ac || muted) return;
      const now = ac.currentTime;
      [0, 7].forEach((st, k) => {
        const t0 = now + k * 0.07;
        const o = ac.createOscillator(); o.type = 'sine';
        o.frequency.value = 392 * Math.pow(2, st / 12);
        const end = env(o, t0, 0.22, 0.014, 0.3);
        o.start(t0); o.stop(end);
      });
    },
    tick(hot) {
      ensure(); if (!ac || muted) return;
      const now = ac.currentTime;
      const o = ac.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(hot ? 1100 : 740, now);
      o.frequency.linearRampToValueAtTime(hot ? 980 : 680, now + 0.07);
      const end = env(o, now, hot ? 0.1 : 0.07, 0.008, 0.08);
      o.start(now); o.stop(end);
    },
    answer() {
      ensure(); if (!ac || muted) return;
      const now = ac.currentTime;
      [0, 4, 7, 12].forEach((st, k) => {
        const t0 = now + k * 0.04;
        const o = ac.createOscillator(); o.type = 'triangle';
        o.frequency.value = 349 * Math.pow(2, st / 12);
        const end = env(o, t0, 0.24, 0.014, 0.46, master);
        o.start(t0); o.stop(end);
      });
      const s = ac.createBufferSource(); s.buffer = noiseBuf;
      const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 4600;
      const e2 = env(hp, now, 0.09, 0.01, 0.1);
      s.connect(hp); s.start(now); s.stop(e2);
      duck.gain.cancelScheduledValues(now);
      duck.gain.setValueAtTime(0.5, now);
      duck.gain.setValueAtTime(0.5, now + 0.06);
      duck.gain.linearRampToValueAtTime(1, now + 0.3);
    },
    finish() {
      ensure(); if (!ac || muted) return;
      const now = ac.currentTime;
      [0, 4, 7, 12, 16].forEach((st, k) => {
        const t0 = now + k * 0.08;
        const o = ac.createOscillator(); o.type = 'triangle';
        o.frequency.value = 262 * Math.pow(2, st / 12);
        const end = env(o, t0, 0.27, 0.016, 0.54, master);
        o.start(t0); o.stop(end);
      });
    },
  };
}

/* ═══════════════ helpers (SPEC §3–4) ═══════════════ */
function spark(x, y, col, n) {
  const w = G;
  if (w.sparks.length > 260) return;
  for (let k = 0; k < n; k++) {
    const a = rnd() * 6.283, sp = 90 + rnd() * 300;
    w.sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, c: col });
  }
}

function startSwap() {
  const w = G, R = w.plan[w.ri], n = R.cups;
  let a = rint(0, n - 1), b = rint(0, n - 1);
  while (b === a) b = rint(0, n - 1);
  // SPEC §3: 55% of swaps are biased to involve the ball's cup — do not drop this
  if (rnd() < 0.55) {
    const bc = w.cups.find((c) => c.id === w.ball);
    a = bc.slot;
    b = rint(0, n - 1);
    while (b === a) b = rint(0, n - 1);
  }
  const ca = w.cups.find((c) => c.slot === a), cb = w.cups.find((c) => c.slot === b);
  w.swap = { a: ca, b: cb, t: 0, dur: R.dur, dir: rnd() < 0.5 ? 1 : -1, from: [ca.x, cb.x] };
  Sound.swap(Math.min(1, 0.5 / R.dur));
}

/* ═══════════════ advance one frame — the design's loop() body, frame-stepped ═══════════════ */
function advance(dt) {
  const w = G;
  w.time += dt;
  const e = w.time - w.phaseAt;
  const R = w.plan[w.ri];

  if (w.phase === 'show') {
    // SPEC §2: cup lifts (0.3s), ball glows underneath, holds (1.0s; SPRINT trims it)
    w.lift = Math.min(1, e / 0.3);
    if (e > (w.mode.show || 1.0)) { w.phase = 'shuffle'; w.phaseAt = w.time; }
  } else if (w.phase === 'shuffle') {
    w.lift = Math.max(0, w.lift - dt * 5);
    if (w.lift <= 0.01) {
      if (!w.swap && w.left > 0) { startSwap(); w.left--; }
      else if (!w.swap && w.left <= 0) { w.phase = 'ask'; w.phaseAt = w.time; w.tick = -1; }
    }
    if (w.swap) {
      const s = w.swap;
      s.t += dt / s.dur;
      const p = Math.min(1, s.t), sm = p * p * (3 - 2 * p);   // SPEC §4 smoothstep
      const [xa, xb] = s.from;
      s.a.x = xa + (xb - xa) * sm;
      s.b.x = xb + (xa - xb) * sm;
      const arc = Math.sin(p * Math.PI);
      s.a.y = -arc * 150 * s.dir;
      s.b.y = arc * 150 * s.dir;
      s.a.z = -s.dir; s.b.z = s.dir;
      if (p >= 1) {
        const sa = s.a.slot; s.a.slot = s.b.slot; s.b.slot = sa;
        s.a.x = slotX(s.a.slot, R.cups); s.b.x = slotX(s.b.slot, R.cups);
        s.a.y = s.b.y = 0; s.a.z = s.b.z = 0;
        s.a.land = s.b.land = 1;                              // SPEC §4/§5 landing weight
        w.ripples.push({ x: s.a.x, life: 1 }, { x: s.b.x, life: 1 });
        w.swap = null;
      }
    }
  } else if (w.phase === 'ask') {
    const p = e / R.ask;
    const tk = Math.floor(e / 0.5);
    if (tk !== w.tick) { w.tick = tk; if (e > 0.1) Sound.tick(p > 0.6); }
    if (e > R.ask) {
      w.phase = 'answer'; w.phaseAt = w.time;
      w.results.push(w.cups.find((c) => c.id === w.ball).slot);
      const bc = w.cups.find((c) => c.id === w.ball);
      spark(bc.x, CUP_BOT - 140, '#b4ff2e', 34);
      spark(bc.x, CUP_BOT - 140, '#ffffff', 14);
      w.shake = 18;
      Sound.answer();
    }
  } else if (w.phase === 'answer') {
    w.reveal = Math.min(1, e / 0.26);
    if (e > (w.mode.answer || 1.5)) nextRound();   // SPEC §2 is 1.5s; SPRINT trims it
  }
  // 'score' phase: the render's FTB.step() decides done; preview auto-replays in tick()

  for (const s of w.sparks) { s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 900 * dt; s.life -= dt * 2.1; }
  w.sparks = w.sparks.filter((s) => s.life > 0);
  for (const c of w.cups) if (c.land > 0) c.land -= dt * 5.5;
  for (const r of w.ripples) r.life -= dt * 2.4;
  w.ripples = w.ripples.filter((r) => r.life > 0);
  w.shake *= 1 - Math.min(1, dt * 7);
  w.pulse += dt;
}

/* paint the current sim state — canvas + DOM HUD. No state change, no seeded RNG. */
function paint() {
  draw();
  hud(false);
}

/* ═══════════════ draw — SPEC §4, §5, §8, 1:1 with the design ═══════════════ */
function cup(x, lift, n, dim, depth, land) {
  const span = cupSpan(n);
  const sq = Math.max(0, land || 0);
  const dp = 1 + (depth || 0) * 0.05;                          // SPEC §4: forward cup scales 1 + z*0.05
  const topW = span * 0.56 * dp * (1 + sq * 0.07), botW = span * 0.94 * dp * (1 + sq * 0.09);
  const h = CUP_H * dp * (1 - sq * 0.09);
  const yb = CUP_BOT - lift * LIFT, yt = yb - h;

  // contact shadow — tightens as the cup lands, spreads + fades as it lifts (SPEC §5)
  ctx.save();
  ctx.globalAlpha = (dim ? 0.3 : 0.55) * (1 - lift * 0.75);
  const sw = botW * (0.56 + lift * 0.5 + sq * 0.16);
  const sg = ctx.createRadialGradient(x, CUP_BOT + 8, 0, x, CUP_BOT + 8, sw);
  sg.addColorStop(0, 'rgba(0,0,0,.85)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sg;
  ctx.beginPath(); ctx.ellipse(x, CUP_BOT + 8, sw, sw * 0.2, 0, 0, 6.283); ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = dim ? 0.5 : 1;
  ctx.beginPath();
  ctx.moveTo(x - topW / 2, yt);
  ctx.lineTo(x + topW / 2, yt);
  ctx.lineTo(x + botW / 2, yb);
  ctx.lineTo(x - botW / 2, yb);
  ctx.closePath();
  const g = ctx.createLinearGradient(x - botW / 2, 0, x + botW / 2, 0);
  g.addColorStop(0, 'rgba(46,60,104,.96)');
  g.addColorStop(.42, 'rgba(28,38,72,.96)');
  g.addColorStop(1, 'rgba(14,20,42,.96)');
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = 'rgba(0,231,255,.62)'; ctx.lineWidth = 7;
  ctx.shadowColor = '#00e7ff'; ctx.shadowBlur = 18;
  ctx.stroke();
  ctx.shadowBlur = 0;
  // vertical sheen down the body, so the swap arc catches light (SPEC §5)
  const sh = ctx.createLinearGradient(x - botW / 2, 0, x + botW / 2, 0);
  sh.addColorStop(0, 'rgba(255,255,255,0)');
  sh.addColorStop(.3, 'rgba(255,255,255,.11)');
  sh.addColorStop(.44, 'rgba(255,255,255,0)');
  ctx.fillStyle = sh; ctx.fill();
  // rim highlight so the mouth of the cup reads
  ctx.strokeStyle = 'rgba(180,255,255,.5)'; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(x - topW / 2, yt); ctx.lineTo(x + topW / 2, yt); ctx.stroke();
  ctx.restore();
}

function draw() {
  const w = G;
  const S = cv.width / W;
  ctx.setTransform(S, 0, 0, S, 0, 0);
  ctx.fillStyle = '#05050b'; ctx.fillRect(0, 0, W, H);   // SPEC §8 background (flat, like the design)
  if (!w.plan[w.ri] && w.phase !== 'score') return;
  ctx.save();
  // cosmetic answer jitter — Math.random(), NOT the seeded rnd() (see the RNG note)
  ctx.translate((Math.random() - .5) * w.shake, (Math.random() - .5) * w.shake);

  const R = w.plan[Math.min(w.ri, w.plan.length - 1)], n = R.cups;

  // table
  const tg = ctx.createLinearGradient(0, ROW_Y, 0, H);
  tg.addColorStop(0, 'rgba(20,28,54,.6)');
  tg.addColorStop(1, 'rgba(8,11,24,.9)');
  ctx.fillStyle = tg;
  ctx.fillRect(0, ROW_Y, W, H - ROW_Y);
  ctx.strokeStyle = 'rgba(140,170,255,.3)'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(0, CUP_BOT + 6); ctx.lineTo(W, CUP_BOT + 6); ctx.stroke();

  // slot markers with numbers — the answer vocabulary (SPEC §1)
  for (let i = 0; i < n; i++) {
    const x = slotX(i, n);
    const hot = w.phase === 'ask';
    ctx.font = '700 86px "Chakra Petch", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = hot ? 'rgba(0,231,255,.9)' : 'rgba(255,255,255,.3)';
    if (hot) { ctx.shadowColor = '#00e7ff'; ctx.shadowBlur = 22; }
    ctx.fillText(String(i + 1), x, CUP_BOT + 54);
    ctx.shadowBlur = 0;
  }

  // landing ripples on the table surface (SPEC §5)
  for (const r of w.ripples) {
    ctx.save();
    ctx.globalAlpha = r.life * 0.4;
    ctx.strokeStyle = 'rgba(0,231,255,.9)'; ctx.lineWidth = 4 * r.life + 1;
    const rr = (1 - r.life) * 180 + 30;
    ctx.beginPath(); ctx.ellipse(r.x, CUP_BOT + 8, rr, rr * 0.22, 0, 0, 6.283); ctx.stroke();
    ctx.restore();
  }

  const ballCup = w.cups.find((c) => c.id === w.ball);
  const bR = ballR(n);

  // ball: drawn under its cup, visible only while that cup is lifted (show / answer)
  const showBall = (w.phase === 'show' && w.lift > 0.05) || (w.phase === 'answer' && w.reveal > 0.05);
  if (showBall && ballCup) {
    const bx = ballCup.x, by = CUP_BOT - bR - 12;
    const pu = 0.6 + 0.4 * Math.sin(w.pulse * 7);
    // ground glow first, clipped above the table line so it never washes over
    // the slot numbers below it (SPEC §5)
    ctx.save();
    ctx.beginPath(); ctx.rect(bx - 300, CUP_BOT - 300, 600, 306); ctx.clip();
    ctx.globalAlpha = 0.45;
    const rg = ctx.createRadialGradient(bx, CUP_BOT, 0, bx, CUP_BOT, 300);
    rg.addColorStop(0, 'rgba(180,255,46,.7)'); rg.addColorStop(1, 'rgba(180,255,46,0)');
    ctx.fillStyle = rg; ctx.fillRect(bx - 300, CUP_BOT - 300, 600, 306);
    ctx.restore();
    ctx.save();
    ctx.shadowColor = '#b4ff2e'; ctx.shadowBlur = 44 + pu * 46;
    ctx.fillStyle = '#b4ff2e';
    ctx.beginPath(); ctx.arc(bx, by, bR, 0, 6.283); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.beginPath(); ctx.arc(bx - bR * 0.3, by - bR * 0.33, bR * 0.26, 0, 6.283); ctx.fill();
    ctx.restore();
  }

  // cups, back-to-front by arc depth so swaps read as passing over/under (SPEC §4)
  const order = w.cups.slice().sort((a, b) => a.z - b.z);
  for (const c of order) {
    const isBall = c.id === w.ball;
    const lift = (w.phase === 'show' && isBall) ? w.lift
      : (w.phase === 'answer' && isBall) ? w.reveal : 0;
    ctx.save();
    ctx.translate(0, c.y);
    cup(c.x, lift, n, c.z < 0, c.z, c.land);
    ctx.restore();
  }

  // winning-cup halo on reveal
  if (w.phase === 'answer' && ballCup) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, w.reveal) * 0.9;
    ctx.strokeStyle = '#b4ff2e'; ctx.lineWidth = 8;
    ctx.shadowColor = '#b4ff2e'; ctx.shadowBlur = 34;
    const span = cupSpan(n);
    ctx.beginPath();
    ctx.roundRect(ballCup.x - span * 0.56, CUP_BOT - CUP_H - 24, span * 1.12, CUP_H + 56, 26);
    ctx.stroke();
    ctx.restore();
  }

  for (const s of w.sparks) {
    ctx.globalAlpha = Math.max(0, s.life); ctx.fillStyle = s.c;
    const sz = 7 * s.life + 2;
    ctx.fillRect(s.x - sz / 2, s.y - sz / 2, sz, sz);
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // vignette (SPEC §8)
  const vg = ctx.createRadialGradient(W / 2, H / 2, 640, W / 2, H / 2, 1280);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.42)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
}

/* ═══════════════ HUD — SPEC §7, driven off the DOM in index.html ═══════════════ */
// reproduces the @keyframes fbPop the design's CSS applies (scale .55 -> 1.1 at
// 62% -> 1.0, opacity 0 -> 1 by 62%, ease-out) — off sim time so it stays
// deterministic under frame-stepping (CSS animation is disabled in render mode).
function popStyle(t0, dur) {
  const p = Math.min(1, Math.max(0, (G.time - t0) / dur));
  const eo = 1 - Math.pow(1 - p, 2);
  const s = eo < 0.62 ? 0.55 + 0.55 * (eo / 0.62) : 1.1 - 0.1 * ((eo - 0.62) / 0.38);
  return { t: 'scale(' + s.toFixed(4) + ')', o: String(Math.min(1, eo / 0.62)) };
}

let hudT = -9;
function hud(force) {
  const w = G;
  if (!force && !RENDER && w.time - hudT < 0.08) return;   // preview: throttle to ~0.08s
  hudT = w.time;
  const R = w.plan[Math.min(w.ri, w.plan.length - 1)];
  const d = DIFF[Math.min(4, w.ri)];
  const scoring = w.phase === 'score';

  el('roundLabel').textContent = scoring ? 'COMPLETE' : 'ROUND ' + (w.ri + 1) + '/' + w.plan.length;
  const dl = el('diffLabel');
  dl.textContent = scoring ? '' : d.name;
  dl.style.color = d.c;

  // progress pips — rebuilt only when the round changes
  const pk = w.ri + '/' + w.plan.length;
  if (pk !== w.pipsKey) {
    w.pipsKey = pk;
    el('pips').innerHTML = w.plan.map((_, k) => {
      const done = k < w.ri, cur = k === w.ri;
      const c = DIFF[Math.min(4, k)].c;
      const bg = done ? c : cur ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.12)';
      const glow = done ? '0 0 2cqw ' + c : 'none';
      return '<i style="flex:1;border-radius:99px;background:' + bg + ';box-shadow:' + glow + '"></i>';
    }).join('');
  }

  // SPEC §7: every phase sets a big label (never null) — shuffle is the longest phase
  const big = w.phase === 'show' ? 'WATCH THE BALL'
    : w.phase === 'shuffle' ? 'KEEP TRACKING'
    : w.phase === 'ask' ? 'WHICH CUP?'
    : w.phase === 'answer' ? 'CUP #' + (w.cups.find((c) => c.id === w.ball).slot + 1)
    : null;
  const bigEl = el('big'), labelEl = el('bigLabel'), subEl = el('bigSub');
  if (big === null) {
    bigEl.style.display = 'none';
  } else {
    if (big !== w.bigKey) { w.bigKey = big; w.bigAt = w.time; }
    bigEl.style.display = 'flex';
    labelEl.textContent = big;
    labelEl.style.color = w.phase === 'answer' ? '#b4ff2e' : w.phase === 'ask' ? '#00e7ff' : '#ffffff';
    labelEl.style.fontSize = w.phase === 'answer' ? '13cqw' : '8cqw';
    const pp = popStyle(w.bigAt, 0.32);
    labelEl.style.transform = pp.t; labelEl.style.opacity = pp.o;
    const sub = w.phase === 'show' ? 'Round ' + (w.ri + 1) + ' · ' + R.cups + ' cups'
      : w.phase === 'shuffle' ? 'Don’t blink' : '';
    subEl.textContent = sub;
    subEl.style.display = sub ? 'block' : 'none';
  }

  // ask bar
  const asking = w.phase === 'ask';
  const aw = el('askWrap');
  aw.style.display = asking ? 'block' : 'none';
  if (asking) el('askBar').style.width = Math.max(0, 100 - ((w.time - w.phaseAt) / R.ask) * 100) + '%';

  // end card — built once on entering 'score'
  const sc = el('scoreCard');
  if (scoring) {
    if (w.pipsKey !== 'score') {
      w.pipsKey = 'score';
      el('scoreList').innerHTML = w.results.map((slot, k) => {
        const dd = DIFF[Math.min(4, k)];
        return '<div class="scoreRow">'
          + '<span class="sr">Round ' + (k + 1) + '</span>'
          + '<span class="sd" style="color:' + dd.c + '">' + dd.name + '</span>'
          + '<span class="sc">#' + (slot + 1) + '</span></div>';
      }).join('');
    }
    sc.style.display = 'flex';
    const sp = popStyle(w.phaseAt, 0.38);
    el('scoreTitle').style.transform = sp.t; el('scoreTitle').style.opacity = sp.o;
  } else {
    sc.style.display = 'none';
  }
}

/* answers for the result JSON (1-indexed cup numbers) */
function answerList() { return G.results.map((s) => s + 1); }

/* ═══════════════ loop / render API ═══════════════ */
const DT = 1 / FPS;             // fixed timestep — the ONLY dt ever passed to advance()

// preview loop: a fixed-timestep accumulator. rAF delta varies with refresh
// rate + drops, so we bank wall-time (scaled by `speed`) and spend it in whole
// DT steps. `speed` runs MORE steps, it does not change DT — so preview seed N
// and render seed N step the sim identically.
let raf = 0, acc = 0, prevT = 0, speed = 1, autoReplay = false;
const randSeed = () => ((Math.random() * 0x7fffffff) >>> 0) || 1;

function startRound(seed, mode) {
  reset(seed, mode);
  acc = 0; prevT = 0;
}

function tick(now) {
  raf = requestAnimationFrame(tick);
  if (!prevT) prevT = now;
  acc += Math.min(0.25, (now - prevT) / 1000) * speed;
  prevT = now;
  let guard = 0;
  while (acc >= DT && guard++ < 800) { FTB.frame += 1; advance(DT); acc -= DT; }
  if (G.phase === 'score' && G.time - G.phaseAt > (G.mode.scoreHold || 3.0) + (autoReplay ? 0.8 : 0) && autoReplay) {
    startRound(randSeed(), curMode);
  }
  paint();
}

function resize() {
  const dpr = RENDER ? SS : Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  // Size the backing store to the pixels the canvas ACTUALLY occupies on screen.
  // In render mode the stage is shrunk to a TikTok-safe box; a canvas sized to the
  // full 1080×1920 space would be > its CSS box and the compositor would give it a
  // soft non-integer downscale (the "brushed out" look). Matching clientWidth·dpr
  // makes it a 1:1 blit; the supersampling comes from a high --ss + ffmpeg lanczos.
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
  resize();                 // re-measure now that layout + fonts are settled
  reset();
}

if (RENDER) {
  FTB.step = () => {
    FTB.frame += 1;
    advance(DT);
    paint();
    const events = Sound._drain();
    let done = false;
    if (G.phase === 'score' && G.time - G.phaseAt >= (G.mode.scoreHold || 3.0)) done = true;
    if (FTB.frame >= FTB._hardCap) done = true;
    FTB.done = done;
    return { frame: FTB.frame, events, done };
  };
  FTB.result = () => {
    const w = G;
    return {
      seed: curSeed,
      mode: w.mode.name.toLowerCase(), modeName: w.mode.name,
      rounds: w.plan.length,
      answers: answerList(),                 // 1-indexed correct cup per round
      cups: w.plan.map((r) => r.cups),
      swapCounts: w.plan.map((r) => r.swaps), // logged only — never shown (SPEC §7)
      durationSec: +(FTB.frame / FPS).toFixed(2),
      frames: FTB.frame, fps: FPS,
    };
  };
  (async () => {
    try { if (document.fonts) { document.fonts.load('700 86px "Chakra Petch"'); await document.fonts.ready; } } catch (e) {}
    boot();
    const capSec = CAP_SEC || ({ sprint: 26, classic: 48, insane: 44 }[G.mode.name.toLowerCase()] || 50);
    FTB._hardCap = Math.round(capSec * FPS);
    FTB.meta = { fps: FPS, totalFrames: FTB._hardCap, seed: curSeed, width: W, height: H };
  })();
} else {
  /* ── preview studio API (window.FTB.*) ── */
  boot();
  FTB.replay = (seed) => startRound(seed === undefined || seed === null || seed === '' ? randSeed() : (Number(seed) >>> 0) || 1, curMode);
  FTB.again = () => startRound(curSeed, curMode);
  FTB.setMode = (m) => startRound(randSeed(), String(m).toLowerCase());
  FTB.setSpeed = (s) => { speed = [0.5, 1, 2, 4].includes(+s) ? +s : 1; };
  FTB.setAutoReplay = (on) => { autoReplay = !!on; };
  FTB.setSound = (on) => { if (Sound.setEnabled) Sound.setEnabled(!!on); };
  FTB.getSeed = () => curSeed;
  FTB.getMode = () => curMode;
  FTB.readout = () => {
    const w = G;
    return {
      seed: curSeed, mode: curMode, modeName: w.mode.name,
      phase: w.phase,
      round: w.phase === 'score' ? w.plan.length : Math.max(1, w.ri + 1),
      rounds: w.plan.length,
      answers: answerList(),
      cups: w.plan.map((r) => r.cups),
      done: w.phase === 'score',
      roundSec: +Math.max(0, w.time).toFixed(2),
    };
  };
  FTB._tick = tick;   // exposed so a headless harness can pump the accumulator with fake timestamps
  raf = requestAnimationFrame(tick);
  el('stage').addEventListener('pointerdown', () => Sound.ensure && Sound.ensure(), { once: true });
}

window.FollowBall = { restart: boot, get world() { return G; }, seed: () => curSeed };
window.FTB = FTB;

})();

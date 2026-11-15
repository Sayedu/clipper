"use strict";
(function () {
/* ═══════════════════════════════════════════════════════════════
   FIND THE CAT — a "Follow The Ball" alt-variant content type.

   Based on the "Find The Cat" design handoff (design_handoff_find_the_cat/
   README.md + shell-game.jsx): a cat-face "ball" hidden under a cup, the
   cups shuffle, the viewer calls the cup. A real multi-round game: the
   user picks how many rounds (1-6), every render starts at round 1 and
   plays exactly that many back to back, and difficulty escalates by round
   index (easy, medium, hard, hard, ...).

   Everything visible that varies per video (palette, backdrop pattern,
   cups/swaps per round, starting cup, twists) comes from plan.js's seeded
   buildPlan(), shared with the Node render log / variety check / verify
   scripts. buildSchedule (accelerating weighted swap timing + biased-pair
   selection, now also biased toward the cat's own cup so the cup worth
   tracking actually moves) is a pure function of (cups, swaps, seed) —
   every visual quantity is computed fresh from elapsed time T each frame,
   not a frame-stepped state machine; each round gets its own time slice
   (ROUND_TOTAL seconds) stacked along one global timeline.

   Retention notes (see the findthecat commit history for the reasoning):
     - frame 1 is already moving: cups are mid-drop and the hook text is up
     - the hook (configurable text + duration) names the game ("CUP GAME")
     - every later round opens with its own "ROUND n" / "FINAL ROUND" card
     - a tension riser leads into every reveal, which zooms in on the cup
     - the ray backdrop and camera land back where they started at the end
       of every round, so round->round and the video's own loop don't snap

   Render plumbing (invisible, same contract as render/followball/game.js):
   FTB.step/meta/result frame API; land/swap/tick/riser/reveal become an
   event log python/findthecat_audio.py re-synthesises offline.
   ═══════════════════════════════════════════════════════════════ */

const QS = new URLSearchParams(location.search);
const RENDER = QS.get('render') === '1';
const FPS = Math.max(20, Math.min(60, parseInt(QS.get('fps') || '60', 10)));
const W = 1080, H = 1920, TABLE_Y = 1230;
const SS = Math.max(1, Math.min(4, parseFloat(QS.get('ss') || '2')));
const PLAN = window.FTC_PLAN;

const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
const el = (id) => document.getElementById(id);

/* ── presentation options (not part of the seeded plan) ── */
const clampNum = (v, lo, hi, d) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const cleanText = (v, max) => String(v || '').replace(/[<>]/g, '').trim().slice(0, max);
const OPTS = {
  hook: cleanText(QS.get('hook'), 28).toUpperCase() || 'FIND THE CAT',
  hookSec: clampNum(QS.get('hooksec'), 1, 3, 2),
  label: cleanText(QS.get('label'), 40),
  twists: QS.get('twists') !== '0',
};
if (QS.get('safezone') === '1') document.documentElement.classList.add('safezone');
if (QS.get('frame') === '1') document.documentElement.classList.add('frame');

/* ── CUES: one round's scene durations, turned into cumulative start times.
   intro 2.0 -> 1.6 now that frame 1 already starts mid-drop (no dead air
   while the first cup falls in); shuffle 9.0 -> 7.0 for a denser feel;
   reveal sized so the cat-laugh-meme-1.wav clip (fires 0.38s into reveal,
   ~3.24s long) finishes before the quick outro. ── */
const SCENE_DUR = { intro: 1.6, show: 2.6, shuffle: 7.0, guess: 3.5, reveal: 3.7, outro: 0.4 };
const I = 0;
const S = I + SCENE_DUR.intro;
const Sh = S + SCENE_DUR.show;
const G = Sh + SCENE_DUR.shuffle;
const R = G + SCENE_DUR.guess;
const O = R + SCENE_DUR.reveal;
const ROUND_TOTAL = O + SCENE_DUR.outro;   // 18.8s — one round's own fixed length
// cups start this far into their drop at frame 1, so the opening frame is
// already full of motion (first cup touching down, the rest mid-fall)
// instead of an empty stage waiting for the first cup
const INTRO_HEAD = 0.45;
function totalDuration() { return (W_ ? W_.roundCount : 1) * ROUND_TOTAL; }

const THEMES = {
  candy:  { bg: '#1A0838', ray: '#2A0F5A', floor: '#33107A', cup: '#FF3B5C', light: '#FF9AAB', dark: '#A80F35', rim: '#FFE3E9', ball: '#D4FF3A', glow: 'rgba(212,255,58,.75)', accent: '#FFD23F' },
  neon:   { bg: '#04060F', ray: '#0A1534', floor: '#0B1F48', cup: '#19D3FF', light: '#A6F1FF', dark: '#0A5F8C', rim: '#E8FBFF', ball: '#FF3DCB', glow: 'rgba(255,61,203,.75)', accent: '#FFE600' },
  sunset: { bg: '#2A0B10', ray: '#40141B', floor: '#561C24', cup: '#FFB020', light: '#FFE39A', dark: '#B85E00', rim: '#FFF5DA', ball: '#3DF2FF', glow: 'rgba(61,242,255,.75)', accent: '#FF4D6D' },
  // Okabe-Ito based: blue cups vs orange/yellow highlights stays distinct
  // under deuteranopia, protanopia and (by brightness) tritanopia
  colorblind: { bg: '#0B1026', ray: '#16204A', floor: '#1A2A5E', cup: '#0072B2', light: '#56B4E9', dark: '#003E66', rim: '#E6F2FA', ball: '#F0E442', glow: 'rgba(240,228,66,.75)', accent: '#E69F00' },
};
// the "colorshift" twist's second cup palette, per theme
const ALT_CUPS = {
  candy: { cup: '#FFB020', light: '#FFE39A', dark: '#B85E00', rim: '#FFF5DA' },
  neon: { cup: '#FF3B5C', light: '#FF9AAB', dark: '#A80F35', rim: '#FFE3E9' },
  sunset: { cup: '#19D3FF', light: '#A6F1FF', dark: '#0A5F8C', rim: '#E8FBFF' },
  colorblind: { cup: '#E69F00', light: '#F5C26B', dark: '#8A5F00', rim: '#FFF3D6' },
};
const DIFF = { easy: { name: 'EASY', color: '#3DFF8B' }, medium: { name: 'MEDIUM', color: '#FFD23F' }, hard: { name: 'HARD', color: '#FF4D6D' } };

/* ── easing (hand-rolled, ported from the handoff's animations-v3.jsx) ── */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const Easing = {
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1),
  easeOutBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  easeOutElastic: (t) => { const c4 = (2 * Math.PI) / 3; if (t === 0) return 0; if (t === 1) return 1; return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1; },
};
const MOTION = { enter: Easing.easeOutBack, glide: Easing.easeInOutCubic, pop: Easing.easeOutElastic };
const cl = (v) => clamp(v, 0, 1);
const fall = (p) => cl(p) * cl(p);
const squash = (u, d = 0.36) => { const k = cl(u / d); return (u < 0 || u > d) ? 1 : 1 - 0.2 * Math.sin(2 * Math.PI * k) * (1 - k); };
const rng = PLAN.rng;

/* ── buildSchedule — ported from shell-game.jsx, plus a bias: 55% of swaps
   (the same share classic Follow The Ball uses) involve whichever slot the
   cat's cup is in right now. Without it the cup worth tracking could sit
   still for most of a round, which is no test at all. ── */
const TRACK_BIAS = 0.55;
function buildSchedule(n, count, seed, t0, t1, biasCup) {
  const r = rng(seed * 7919 + n * 31 + count);
  const w = []; for (let i = 0; i < count; i++) w.push(1 / (1 + 2.2 * i / count));
  const sum = w.reduce((a, b) => a + b, 0);
  let t = t0, slots = [...Array(n).keys()], prev = '';
  const swaps = [];
  for (let i = 0; i < count; i++) {
    const d = (t1 - t0) * w[i] / sum;
    let a, b, key, guard = 0;
    do {
      if (guard < 12 && r() < TRACK_BIAS) {
        a = slots.indexOf(biasCup);
        b = r() < 0.6 ? a + (r() < 0.5 ? -1 : 1) : Math.floor(r() * n);
        if (b < 0) b = a + 1;
        if (b >= n) b = a - 1;
      } else if (r() < 0.6) { a = Math.floor(r() * (n - 1)); b = a + 1; } else { a = Math.floor(r() * n); b = Math.floor(r() * n); }
      if (a > b) { const tmp = a; a = b; b = tmp; }
      key = a + '-' + b;
      guard++;
    } while (a === b || key === prev);
    prev = key;
    swaps.push({ start: t, end: t + d * 0.88, a, b, ca: slots[a], cb: slots[b], frontA: r() < 0.5 });
    slots = slots.slice();
    const tmp = slots[a]; slots[a] = slots[b]; slots[b] = tmp;
    t += d;
  }
  return { swaps, finalSlots: slots };
}

/* Classic Follow The Ball's own clean swap motion: smoothstep position + a
   flat 150px sine arc, no rotation/scale/trail. The cup passing in FRONT
   dips toward the viewer (down) and draws on top, the one passing behind
   rises — the same perspective classic uses. */
function cupMotion(c, T, swaps, slotX) {
  let slot = c;
  for (const sw of swaps) {
    if (T >= sw.end) { if (sw.ca === c) slot = sw.b; else if (sw.cb === c) slot = sw.a; continue; }
    if (T >= sw.start && (sw.ca === c || sw.cb === c)) {
      const p = Math.min(1, (T - sw.start) / (sw.end - sw.start));
      const sm = p * p * (3 - 2 * p);   // smoothstep
      const mine = sw.ca === c, from = mine ? sw.a : sw.b, to = mine ? sw.b : sw.a;
      const xa = slotX(from), xb = slotX(to);
      const arc = Math.sin(p * Math.PI);
      const front = mine === sw.frontA, dir = front ? 1 : -1;
      return { x: xa + (xb - xa) * sm, y: arc * 150 * dir, sc: 1, rot: 0, z: front ? 30 : 10, dim: 0, moving: true, dur: sw.end - sw.start };
    }
    break;
  }
  return { x: slotX(slot), y: 0, sc: 1, rot: 0, z: 20, dim: 0, moving: false, slot };
}

/* ── confetti — a fixed, non-seeded particle set; only its launch POSITION
   (the winning slot) varies per round ── */
const CONFETTI = (() => {
  const r = rng(4242);
  return Array.from({ length: 48 }, () => ({
    a: -Math.PI * (0.08 + 0.84 * r()), v: 900 + 900 * r(), spin: (r() - 0.5) * 1400,
    ci: Math.floor(r() * 4), w: 14 + r() * 12,
  }));
})();

/* ═══════════════ world ═══════════════ */
let W_ = null;
let catImg = null;

function cupSpacing(n) { return Math.min(340, 1050 / n); }
function slotXFor(n) { const spacing = cupSpacing(n); return (i) => 540 + (i - (n - 1) / 2) * spacing; }

function buildRound(seed, i, rp, roundCount) {
  const n = rp.cups;
  const spacing = cupSpacing(n);
  const slotX = slotXFor(n);
  // bigger than the handoff's own 0.84 — the ball carries a specific meme
  // image (the cat face + the pointing finger) that needs to read at a glance
  const cupW = spacing * 0.9, cupH = cupW * 1.3, ballD = cupW * 1.05;
  // several rounds share the same (cups, swaps) once difficulty plateaus at
  // hard — without a per-round offset they'd be the identical shuffle
  const roundSeed = (seed + i * 104729) >>> 0;
  const sched = buildSchedule(n, rp.swaps, roundSeed, Sh + 0.25, G - 0.3, rp.ballCup);
  const win = sched.finalSlots.indexOf(rp.ballCup);
  let fakeSlot = -1;
  if (rp.twist === 'fakeout') {
    const wrong = [...Array(n).keys()].filter((k) => k !== win);
    fakeSlot = wrong[Math.floor(rp.fakeDraw * wrong.length)];
  }
  const tickTimes = [0, 1, 2].map((k) => G + 0.35 + k * 0.95);
  const riserAt = tickTimes[2];
  return {
    index: i, isFinal: roundCount > 1 && i === roundCount - 1,
    cups: n, diffKey: rp.difficulty, diff: DIFF[rp.difficulty], swapCount: rp.swaps, twist: rp.twist, fakeSlot,
    spacing, slotX, cupW, cupH, ballD, ballCup: rp.ballCup,
    swaps: sched.swaps, finalSlots: sched.finalSlots, win,
    tickTimes, riserAt, riserDur: R + 0.3 - riserAt, revealAt: R + 0.3,
  };
}

function reset(seed, roundCount, themeChoice) {
  const rc = clamp(Math.round(roundCount ?? (W_ ? W_.roundCount : 3)), 1, 6);
  const tc = themeChoice ?? (W_ ? W_.themeChoice : 'random');
  const P = PLAN.buildPlan(seed, { rounds: rc, theme: tc, twists: OPTS.twists });
  W_ = {
    seed: P.seed, roundCount: rc, themeChoice: P.themeChoice, themeKey: P.theme, theme: THEMES[P.theme],
    backdrop: PLAN.BACKDROPS.find((b) => b.id === P.backdrop), plan: P,
    rounds: P.plan.map((rp, i) => buildRound(P.seed, i, rp, rc)),
  };
}

function introStart(c) { return I - INTRO_HEAD + c * 0.13; }

function extra(c, slot, T, w) {
  let dy = 0, rot = 0, sq = 1;
  const st = introStart(c), land = st + 0.45;
  dy += -1500 * (1 - fall((T - st) / 0.45));
  sq *= squash(T - land);
  if (c === w.ballCup) {
    const up = MOTION.enter(cl((T - S - 0.1) / 0.45)), down = fall((T - S - 1.8) / 0.32);
    dy += -330 * up * (1 - down); rot += -9 * up * (1 - down);
    sq *= squash(T - S - 2.12);
  }
  if (T >= G && T < R + 0.3) dy += -16 * Math.abs(Math.sin((T - G) * 5 + slot * 0.9)) * cl((T - G) / 0.3);
  // "fakeout" twist: a wrong cup teases a lift mid-countdown, empty beneath
  if (w.fakeSlot >= 0 && slot === w.fakeSlot) {
    const u = (T - (G + 1.05)) / 0.8;
    if (u > 0 && u < 1) dy += -95 * Math.sin(Math.PI * u);
  }
  // quick, clean pop-up on reveal (no rotation) — classic's own snappy lift
  if (slot === w.win) { const e = MOTION.enter(cl((T - R - 0.3) / 0.25)); dy += -380 * e; }
  // fits even a 6-cup round inside the 0.4s outro (5*0.02 + 0.3 = 0.4s)
  dy += -1700 * fall((T - O - slot * 0.02) / 0.3);
  return { dy, rot, sq };
}

/* the per-cup state for one frame — shared by draw() and debugState() */
function cupEntries(T, w) {
  const entries = [];
  for (let c = 0; c < w.cups; c++) {
    const m = cupMotion(c, T, w.swaps, w.slotX);
    const slotNow = m.moving ? -1 : (T >= G ? w.finalSlots.indexOf(c) : m.slot);
    const ex = extra(c, slotNow, T, w);
    const dimLosers = T > R + 0.5 && T < O && slotNow !== w.win ? 0.35 * cl((T - R - 0.5) / 0.3) : 0;
    entries.push({ c, m, ex, slotNow, dim: m.dim + dimLosers });
  }
  return entries;
}

/* the cat: drops in under its lifted cup during Show, and stays fully on
   screen from the reveal onward (no shrink-away — by request) */
function ballState(T, w) {
  let show = false, x = w.slotX(w.ballCup), y = 0;
  const bt = T - S - 0.42;
  if (bt >= 0 && T < S + 2.15) {
    show = true;
    if (bt < 0.36) y = -820 * (1 - fall(bt / 0.36));
    else if (bt < 0.7) { const u = (bt - 0.36) / 0.34; y = -4 * 110 * u * (1 - u); }
    else if (bt < 0.9) { const u = (bt - 0.7) / 0.2; y = -4 * 36 * u * (1 - u); }
  }
  if (T >= R + 0.3) { show = true; x = w.slotX(w.win); }
  return { show, x, y, cy: TABLE_Y - w.ballD / 2 + y - 4 };
}

function slice(globalT) {
  const roundIdx = Math.min(W_.roundCount - 1, Math.floor(globalT / ROUND_TOTAL));
  return { roundIdx, T: globalT - roundIdx * ROUND_TOTAL, w: W_.rounds[roundIdx] };
}

/* ═══════════════ sound events (edge-triggered off T crossing known instants) ═══════════════ */
const SWAP_SCALE = [0, 3, 5, 7, 10, 12, 15, 17];
const SWAP_BASE = 233;
let swapNote = 0;

function emitEvents(prevT, T, frame, push) {
  // every round's events are checked against their GLOBAL (round-offset)
  // time — correct across the reset-to-zero boundary between rounds
  W_.rounds.forEach((w, i) => {
    const base = i * ROUND_TOTAL;
    const cross = (t) => prevT < base + t && T >= base + t;
    const ev = (o) => push(Object.assign({ t: +T.toFixed(4), f: frame, round: i }, o));
    for (let c = 0; c < w.cups; c++) if (cross(introStart(c) + 0.45)) ev({ type: 'land', soft: 0 });
    if (cross(S + 2.12)) ev({ type: 'land', soft: 0 });
    for (const sw of w.swaps) {
      if (cross(sw.start)) {
        swapNote = (swapNote + 1) % SWAP_SCALE.length;
        const dur = Math.max(0.001, sw.end - sw.start);
        ev({ type: 'swap', hz: SWAP_BASE * Math.pow(2, SWAP_SCALE[swapNote] / 12), speed: Math.min(1, 0.5 / dur) });
      }
      if (cross(sw.end)) ev({ type: 'land', soft: 1 });
    }
    w.tickTimes.forEach((tt, k) => { if (cross(tt)) ev({ type: 'tick', hot: k === 2 }); });
    if (cross(w.riserAt)) ev({ type: 'riser', dur: +w.riserDur.toFixed(3) });
    if (cross(w.revealAt)) ev({ type: 'reveal', final: i === W_.roundCount - 1 });
  });
}

/* ═══════════════ draw ═══════════════ */
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function lerpHex(a, b, k) {
  const x = hexRgb(a), y = hexRgb(b);
  return 'rgb(' + x.map((v, i) => Math.round(v + (y[i] - v) * k)).join(',') + ')';
}
function cupPalette(th, w, T) {
  if (w.twist !== 'colorshift') return th;
  const k = MOTION.glide(cl((T - (Sh + (G - Sh) * 0.58)) / 0.5));
  if (k <= 0) return th;
  const alt = ALT_CUPS[W_.themeKey];
  return Object.assign({}, th, {
    cup: lerpHex(th.cup, alt.cup, k), light: lerpHex(th.light, alt.light, k),
    dark: lerpHex(th.dark, alt.dark, k), rim: lerpHex(th.rim, alt.rim, k),
  });
}

function drawCupPath() {
  // SPEC: "Cup Shape (SVG, viewBox 0 0 100 130)" — ported path commands exactly.
  ctx.beginPath();
  ctx.moveTo(24, 8);
  ctx.quadraticCurveTo(50, 2, 76, 8);
  ctx.lineTo(95, 118);
  ctx.quadraticCurveTo(50, 128, 5, 118);
  ctx.closePath();
}

function drawCup(th) {
  const g = ctx.createLinearGradient(0, 0, 100, 0);
  g.addColorStop(0, th.dark); g.addColorStop(0.3, th.cup); g.addColorStop(0.55, th.light);
  g.addColorStop(0.75, th.cup); g.addColorStop(1, th.dark);
  drawCupPath();
  ctx.fillStyle = g; ctx.fill();
  ctx.globalAlpha = 0.35; ctx.fillStyle = th.dark;
  ctx.beginPath(); ctx.moveTo(13, 54); ctx.lineTo(87, 54); ctx.lineTo(88, 60); ctx.lineTo(12, 60); ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 0.3;
  ctx.beginPath(); ctx.moveTo(10, 76); ctx.lineTo(90, 76); ctx.lineTo(91, 81); ctx.lineTo(9, 81); ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath(); ctx.moveTo(7.4, 102); ctx.lineTo(92.6, 102); ctx.lineTo(95, 118); ctx.quadraticCurveTo(50, 128, 5, 118); ctx.closePath();
  ctx.fillStyle = th.rim; ctx.fill();
  ctx.globalAlpha = 0.25; ctx.fillStyle = th.dark;
  ctx.beginPath(); ctx.moveTo(7.4, 102); ctx.lineTo(92.6, 102); ctx.lineTo(93, 105); ctx.lineTo(7, 105); ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = th.dark;
  ctx.beginPath(); ctx.ellipse(50, 8, 26, 4.5, 0, 0, 6.283); ctx.fill();
  ctx.globalAlpha = 0.35; ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.moveTo(33, 14); ctx.lineTo(40, 14); ctx.lineTo(31, 98); ctx.lineTo(22, 98); ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 1;
}

function paintCup(entry, th, cupW) {
  const { m, ex } = entry;
  const unit = cupW / 100;
  ctx.save();
  if (entry.dim) ctx.filter = `brightness(${1 - entry.dim})`;
  ctx.translate(m.x, TABLE_Y + m.y + ex.dy);
  ctx.rotate(((m.rot + ex.rot) * Math.PI) / 180);
  ctx.scale(unit * m.sc, unit * m.sc * ex.sq);
  ctx.translate(-50, -130);
  drawCup(th);
  ctx.restore();
}

function draw(globalT) {
  const { T, w } = slice(globalT);
  const th = W_.theme, n = w.cups, slotX = w.slotX, bd = W_.backdrop;
  const S_ = cv.width / W;
  ctx.setTransform(S_, 0, 0, S_, 0, 0);
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);

  // ── rays (screen space). The ray pattern repeats every 720/wedges
  // degrees; the trailing correction term makes each round end exactly one
  // whole pattern period from where it started, so the backdrop doesn't
  // snap between rounds or when the video loops back to frame 1.
  const sp = cl((T - Sh) / (G - Sh));
  const period = 720 / bd.wedges;
  const excess = (6 * ROUND_TOTAL + 200) % period;
  const rayAngle = bd.spin * (T * 6 + 160 * sp * sp + 40 * cl((T - G) / (R - G)) - excess * (T / ROUND_TOTAL));
  ctx.save();
  ctx.globalAlpha = 0.6 + 0.3 * sp * (T < G ? 1 : 0);
  ctx.translate(540, 1050);
  ctx.rotate((rayAngle * Math.PI) / 180);
  const wedge = (2 * Math.PI) / bd.wedges;
  for (let i = 0; i < bd.wedges; i++) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 1500, i * wedge, (i + 1) * wedge);
    ctx.closePath();
    ctx.fillStyle = i % 2 === 0 ? th.ray : th.bg;
    ctx.fill();
  }
  ctx.restore();

  const vg = ctx.createRadialGradient(540, 1113.6, 0, 540, 1113.6, 1237.6);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(0.25, 'rgba(0,0,0,0)'); vg.addColorStop(0.7, th.bg); vg.addColorStop(1, th.bg);
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

  // ── camera: zoom toward the winning cup on reveal, fully back out by the
  // end of the outro (the next round / the loop starts from zoom 1) ──
  const revealE = MOTION.glide(cl((T - R - 0.2) / 0.7)) * (1 - MOTION.glide(cl((T - O) / SCENE_DUR.outro)));
  const zoom = 1 + 0.07 * MOTION.glide(sp) * (1 - MOTION.glide(cl((T - G) / 0.6))) + 0.12 * revealE;
  const ox = 540 + (slotX(w.win) - 540) * revealE;
  const oy = TABLE_Y - 220;
  ctx.save();
  ctx.translate(ox, oy); ctx.scale(zoom, zoom); ctx.translate(-ox, -oy);

  const fg = ctx.createLinearGradient(0, 1040, 0, 2120);
  fg.addColorStop(0, th.floor); fg.addColorStop(0.75, th.bg); fg.addColorStop(1, th.bg);
  ctx.fillStyle = fg; ctx.fillRect(-200, 1040, 1480, 1080);

  const lastEnd = w.swaps.filter((s) => s.end <= T).pop();
  const pulse = lastEnd && T < G ? Math.exp(-(T - lastEnd.end) * 7) : 0;
  ctx.save();
  ctx.shadowColor = th.cup; ctx.shadowBlur = 24;
  ctx.globalAlpha = 0.35 + 0.5 * pulse;
  ctx.fillStyle = th.light; ctx.fillRect(0, 1040, W, 3);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.5 + 0.5 * pulse;
  const gg = ctx.createRadialGradient(540, TABLE_Y, 0, 540, TABLE_Y, 500);
  gg.addColorStop(0, th.cup + '55'); gg.addColorStop(1, th.cup + '00');
  ctx.fillStyle = gg;
  ctx.beginPath(); ctx.ellipse(540, TABLE_Y, 500, 110, 0, 0, 6.283); ctx.fill();
  ctx.restore();

  const entries = cupEntries(T, w);

  for (const en of entries) {
    const lift = Math.max(0, -(en.m.y + en.ex.dy));
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - lift / 1400);
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.filter = 'blur(6px)';
    const sc = Math.max(0.3, 1 - lift / 900) * en.m.sc;
    ctx.translate(en.m.x, TABLE_Y);
    ctx.scale(sc, sc);
    ctx.beginPath(); ctx.ellipse(0, 0, w.cupW * 0.6, 18, 0, 0, 6.283); ctx.fill();
    ctx.restore();
  }

  const ball = ballState(T, w);
  const glowPulse = T >= R + 0.45 ? 0.6 + 0.4 * Math.sin((T - R) * 9) : 0.3;
  if (ball.show && catImg) {
    const bx = ball.x, by = ball.cy;
    ctx.save();
    ctx.shadowColor = th.glow; ctx.shadowBlur = 30 + 60 * glowPulse;
    ctx.fillStyle = th.ball;
    ctx.beginPath(); ctx.arc(bx, by, w.ballD / 2, 0, 6.283); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.save();
    ctx.beginPath(); ctx.arc(bx, by, w.ballD / 2, 0, 6.283); ctx.clip();
    ctx.translate(bx, by);
    ctx.rotate((Math.sin(T * 6) * 8 * Math.PI) / 180);
    // contain-fit so the whole meme (cat face AND pointing finger) reads
    const natW = catImg.naturalWidth || 480, natH = catImg.naturalHeight || 448;
    const fit = Math.min(w.ballD / natW, w.ballD / natH) * 1.08;
    const iw = natW * fit, ih = natH * fit;
    ctx.drawImage(catImg, -iw / 2, -ih / 2, iw, ih);
    ctx.restore();
    ctx.restore();
  }

  [0, 0.15].forEach((d) => {
    const u = (T - R - 0.45 - d) / 0.8;
    if (u < 0 || u > 1) return;
    const rr = 100 * (0.3 + 3 * MOTION.glide(u));
    ctx.save();
    ctx.globalAlpha = 1 - u;
    ctx.strokeStyle = th.ball; ctx.lineWidth = 8;
    ctx.beginPath(); ctx.arc(slotX(w.win), TABLE_Y - w.ballD / 2, rr, 0, 6.283); ctx.stroke();
    ctx.restore();
  });

  const cupTh = cupPalette(th, w, T);
  entries.sort((a, b) => a.m.z - b.m.z);
  for (const en of entries) paintCup(en, cupTh, w.cupW);

  for (let i = 0; i < n; i++) {
    const e = MOTION.enter(cl((T - G - i * 0.08) / 0.4)) * (1 - cl((T - O) / 0.3));
    const isWin = i === w.win && T > R + 0.4;
    const lose = i !== w.win && T > R + 0.4;
    if (e <= 0.001) continue;
    ctx.save();
    ctx.globalAlpha = lose ? 0.35 : 1;
    ctx.translate(slotX(i), TABLE_Y + 96); ctx.scale(e * (isWin ? 1.3 : 1), e * (isWin ? 1.3 : 1));
    ctx.beginPath(); ctx.arc(0, 0, 46, 0, 6.283);
    ctx.fillStyle = isWin ? th.accent : 'rgba(255,255,255,.08)';
    ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = isWin ? th.accent : 'rgba(255,255,255,.35)'; ctx.stroke();
    ctx.fillStyle = isWin ? th.bg : '#fff';
    ctx.font = '900 48px "Chakra Petch", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), 0, 2);
    ctx.restore();
  }

  const ct = T - R - 0.45;
  if (ct > 0 && ct < 2.6) {
    const confCols = [th.accent, th.ball, th.cup, '#FFFFFF'];
    const endFade = Math.max(0, 1 - cl((ct - 2) / 0.6)) * (1 - cl((T - O) / 0.3));
    for (const p of CONFETTI) {
      const x = slotX(w.win) + Math.cos(p.a) * p.v * ct;
      const y = TABLE_Y - 140 + Math.sin(p.a) * p.v * ct + 1300 * ct * ct;
      ctx.save();
      ctx.globalAlpha = Math.max(0, endFade);
      ctx.translate(x, y); ctx.rotate(((p.spin * ct) * Math.PI) / 180);
      ctx.fillStyle = confCols[p.ci];
      ctx.fillRect(-p.w / 2, -(p.w * 0.55) / 2, p.w, p.w * 0.55);
      ctx.restore();
    }
  }

  ctx.restore();   // end camera transform
}

/* ═══════════════ HUD — DOM overlay, updated every frame ═══════════════ */
function titlesFor(w) {
  const first = w.index === 0
    ? { at: I - 0.12, text: OPTS.hook, sub: 'CUP GAME · ' + W_.roundCount + (W_.roundCount > 1 ? ' ROUNDS' : ' ROUND') }
    : w.isFinal
      ? { at: I - 0.12, text: 'FINAL ROUND', sub: w.cups + ' CUPS · LAST CHANCE' }
      : { at: I - 0.12, text: 'ROUND ' + (w.index + 1), sub: w.cups + ' CUPS · ' + w.diff.name };
  return [
    first,
    { at: w.index === 0 ? Math.max(S + 0.1, OPTS.hookSec) : S + 0.1, text: 'EYES ON THE CAT', sub: "DON'T BLINK" },
    { at: Sh, text: 'KEEP TRACKING', sub: 'STAY LOCKED IN' },
    { at: Sh + (G - Sh) * 0.58, text: 'FASTER!!', sub: w.twist === 'colorshift' ? 'THE CUPS CHANGED COLOR' : 'NO WAY YOU GOT THIS', hot: true },
    { at: G, text: "WHERE'S THE CAT?", sub: 'COMMENT YOUR ANSWER' },
    { at: R + 0.4, text: 'CUP ' + (w.win + 1) + '!', sub: 'DID YOU GET IT?', hot: true },
  ];
}

let pipsRoundCount = -1;

function hud(globalT) {
  const { roundIdx, T, w } = slice(globalT);
  const th = W_.theme;

  el('roundLabel').textContent = 'ROUND ' + (roundIdx + 1) + '/' + W_.roundCount;
  const chip = el('diffChip');
  chip.textContent = w.diff.name + ' · ' + w.cups + ' CUPS';
  chip.style.borderColor = w.diff.color;

  if (pipsRoundCount !== W_.roundCount) {
    pipsRoundCount = W_.roundCount;
    el('pips').innerHTML = Array.from({ length: W_.roundCount }, () => '<i><b></b></i>').join('');
  }
  const prog = cl(T / O);
  [...el('pips').children].forEach((pip, i) => {
    const b = pip.firstElementChild;
    b.style.width = (i < roundIdx ? 100 : i === roundIdx ? prog * 100 : 0) + '%';
    b.style.background = i === roundIdx ? th.accent : '#fff';
  });

  const cur = titlesFor(w).filter((x) => T >= x.at).pop();
  const titleWrap = el('titleWrap'), titleText = el('titleText'), titleSub = el('titleSub');
  if (!cur || T >= O) {
    titleWrap.style.opacity = 0;
  } else {
    const tk = T - cur.at;
    const sc = 0.55 + 0.45 * MOTION.pop(cl(tk / 0.8));
    const op = cl(tk / 0.1) * (1 - cl((T - O) / 0.35));
    const rot = cur.hot ? Math.sin(T * 30) * 2.2 * (T < G ? 1 : Math.exp(-tk * 2)) : 0;
    titleWrap.style.opacity = String(op);
    titleWrap.style.transform = `scale(${sc}) rotate(${rot}deg)`;
    titleText.textContent = cur.text;
    titleText.style.fontSize = cur.text.length > 13 ? '7.4cqw' : '9.4cqw';
    titleText.style.color = cur.hot ? th.accent : '#fff';
    titleSub.textContent = cur.sub;
  }

  const cdT = T - G - 0.35, cdI = Math.floor(cdT / 0.95);
  const cdWrap = el('cdWrap');
  if (cdT >= 0 && cdI < 3 && T < R + 0.2) {
    cdWrap.style.display = 'flex';
    const cdK = cdT - cdI * 0.95;
    const ring = el('cdRing');
    const circ = 2 * Math.PI * 84;
    ring.setAttribute('stroke-dasharray', String(circ));
    ring.setAttribute('stroke-dashoffset', String(circ * cl(cdK / 0.95)));
    ring.setAttribute('stroke', th.accent);
    el('cdNum').textContent = String(3 - cdI);
    el('cdNum').style.transform = `scale(${0.4 + 0.6 * MOTION.pop(cl(cdK / 0.6))})`;
  } else {
    cdWrap.style.display = 'none';
  }

  // end-of-video question: a real one, never "like = ..." bait
  const revealed = T >= R + 0.4;
  const isLast = roundIdx === W_.roundCount - 1;
  el('caption').textContent = !revealed ? 'Can you follow the cat?'
    : isLast && W_.roundCount > 1 ? 'How many did you get right?' : 'Did you find him?';
  el('caption').style.transform = `translateY(${Math.sin(T * 3) * 6}px)`;

  const lab = el('seriesLabel');
  lab.textContent = OPTS.label;
  lab.style.display = OPTS.label ? 'block' : 'none';
}

function paint(T) {
  draw(T);
  hud(T);
}

/* ═══════════════ render / preview harness (same contract as followball/game.js) ═══════════════ */
const DT = 1 / FPS;
let frame = 0, prevT = -1, lastT = 0;

function stepOnce(push) {
  const T = Math.min(totalDuration(), frame / FPS);
  emitEvents(prevT, T, frame, push);
  paint(T);
  prevT = T;
  lastT = T;
  frame += 1;
  return T;
}

/* positions in the 1080x1920 design space for the frame last painted —
   verify.mjs uses this for its bounds / overlap / safe-zone checks */
function debugState() {
  const { roundIdx, T, w } = slice(lastT);
  const ball = ballState(T, w);
  const st = el('stage').getBoundingClientRect();
  return {
    t: lastT, localT: T, roundIdx, cups: w.cups, cupW: w.cupW, cupH: w.cupH, ballD: w.ballD, win: w.win,
    phase: T < S ? 'intro' : T < Sh ? 'show' : T < G ? 'shuffle' : T < R ? 'guess' : T < O ? 'reveal' : 'outro',
    entries: cupEntries(T, w).map((e) => ({ c: e.c, x: e.m.x, yOff: e.m.y + e.ex.dy, moving: e.m.moving, slot: e.slotNow })),
    ball: { show: ball.show, x: ball.x, cy: ball.cy },
    stage: { x: st.left, y: st.top, w: st.width, h: st.height },
  };
}

function resize() {
  const dpr = RENDER ? SS : Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const cssW = cv.clientWidth || W;
  const cssH = cv.clientHeight || H;
  cv.width = Math.max(1, Math.round(cssW * dpr));
  cv.height = Math.max(1, Math.round(cssH * dpr));
  ctx.imageSmoothingQuality = 'high';
}
resize();
addEventListener('resize', () => { if (!RENDER) resize(); });

function loadCat() {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => { catImg = img; res(); };
    img.onerror = () => res();   // draw without the ball rather than hang the render
    img.src = './cat.png';
  });
}

function parseQueryDefaults() {
  return {
    seed: (parseInt(QS.get('seed') || '1', 10) >>> 0) || 1,
    // how many rounds the WHOLE video contains — always starts at round 1
    rounds: parseInt(QS.get('rounds') || '3', 10),
    theme: (QS.get('theme') || 'random').toLowerCase(),
  };
}

function resultData() {
  return {
    seed: W_.seed, roundCount: W_.roundCount, theme: W_.themeKey, themeChoice: W_.themeChoice,
    backdrop: W_.backdrop.id, twistsEnabled: OPTS.twists, hook: OPTS.hook, hookSec: OPTS.hookSec, label: OPTS.label,
    plan: W_.rounds.map((r) => ({
      cups: r.cups, difficulty: r.diffKey, swaps: r.swapCount, twist: r.twist, startCup: r.ballCup + 1, answer: r.win + 1,
    })),
    cups: W_.rounds.map((r) => r.cups), difficulty: W_.rounds.map((r) => r.diffKey),
    twists: W_.rounds.map((r) => r.twist), answers: W_.rounds.map((r) => r.win + 1),
    roundTotalSec: ROUND_TOTAL, revealOffsetSec: R + 0.3,
  };
}

const FTB = { frame: 0, done: false, meta: null };

if (RENDER) {
  const d = parseQueryDefaults();
  FTB.step = () => {
    const events = [];
    const T = stepOnce((ev) => events.push(ev));
    FTB.frame = frame;
    const done = T >= totalDuration();
    FTB.done = done;
    return { frame, events, done };
  };
  FTB.result = () => Object.assign(resultData(), { durationSec: +(frame / FPS).toFixed(2), frames: frame, fps: FPS });
  FTB.debugState = debugState;
  (async () => {
    try { if (document.fonts) { document.fonts.load('900 48px "Chakra Petch"'); await document.fonts.ready; } } catch (e) {}
    await loadCat();
    reset(d.seed, d.rounds, d.theme);
    FTB.meta = { fps: FPS, totalFrames: Math.round(totalDuration() * FPS), seed: W_.seed, width: W, height: H };
  })();
} else {
  /* ── preview studio API (window.FTB.*) ── */
  let raf = 0, acc = 0, prevWallT = 0, speed = 1;
  const randSeed = () => ((Math.random() * 0x7fffffff) >>> 0) || 1;

  const boot = async () => {
    const d = parseQueryDefaults();
    await loadCat();
    reset(d.seed, d.rounds, d.theme);
    frame = 0; prevT = -1;
    resize();
  };

  const restart = (seed, roundCount, themeChoice) => {
    reset(seed, roundCount, themeChoice);
    frame = 0; prevT = -1; acc = 0; prevWallT = 0;
  };

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!prevWallT) prevWallT = now;
    acc += Math.min(0.25, (now - prevWallT) / 1000) * speed;
    prevWallT = now;
    let guard = 0;
    while (acc >= DT && guard++ < 800) { stepOnce(() => {}); acc -= DT; }
    // always keep playing: loop the whole video with a fresh seed once it ends
    if (frame / FPS >= totalDuration() + 0.3) restart(randSeed(), W_.roundCount, W_.themeChoice);
  }

  // every method below is a no-op (or a safe placeholder) until boot()
  // resolves — the dashboard treats `FTB.replay` existing as "ready"
  FTB.replay = (seed) => W_ && restart(seed === undefined || seed === null || seed === '' ? randSeed() : (Number(seed) >>> 0) || 1, W_.roundCount, W_.themeChoice);
  FTB.again = () => W_ && restart(W_.seed, W_.roundCount, W_.themeChoice);
  FTB.setRounds = (n) => W_ && restart(randSeed(), n, W_.themeChoice);
  FTB.setTheme = (t) => W_ && restart(W_.seed, W_.roundCount, String(t).toLowerCase());
  FTB.setSpeed = (s) => { speed = [0.5, 1, 2, 4].includes(+s) ? +s : 1; };
  FTB.setSound = () => {};
  // hook / hook seconds / series label just change what's drawn; twists
  // changes the plan, so it rebuilds the same seed
  FTB.setOptions = (o) => {
    if (!o) return;
    const twistsBefore = OPTS.twists;
    if (o.hook !== undefined) OPTS.hook = cleanText(o.hook, 28).toUpperCase() || 'FIND THE CAT';
    if (o.hookSec !== undefined) OPTS.hookSec = clampNum(o.hookSec, 1, 3, 2);
    if (o.label !== undefined) OPTS.label = cleanText(o.label, 40);
    if (o.twists !== undefined) OPTS.twists = !!o.twists;
    if (W_ && OPTS.twists !== twistsBefore) restart(W_.seed, W_.roundCount, W_.themeChoice);
  };
  // debug overlay: shows the full 9:16 frame layout (same black safe box the
  // render uses) with TikTok's UI zones shaded on top
  FTB.setSafeZone = (on) => {
    document.documentElement.classList.toggle('frame', !!on);
    document.documentElement.classList.toggle('safezone', !!on);
    requestAnimationFrame(resize);
  };
  FTB.getSeed = () => (W_ ? W_.seed : 0);
  FTB.readout = () => {
    if (!W_) return { seed: 0, roundCount: 3, round: 1, cups: 3, difficulty: 'easy', theme: 'candy', themeChoice: 'random', twist: 'none', phase: 'Loading', t: 0, totalSec: ROUND_TOTAL * 3, win: 0, done: false };
    const T = Math.min(totalDuration(), frame / FPS);
    const { roundIdx, T: localT, w } = slice(T);
    const phase = localT < S ? 'Intro' : localT < Sh ? 'Show' : localT < G ? 'Shuffle' : localT < R ? 'Guess' : localT < O ? 'Reveal' : 'Outro';
    return {
      seed: W_.seed, roundCount: W_.roundCount, round: roundIdx + 1, cups: w.cups, difficulty: w.diffKey,
      theme: W_.themeKey, themeChoice: W_.themeChoice, twist: w.twist, backdrop: W_.backdrop.id,
      phase, t: T, totalSec: totalDuration(), win: w.win + 1, done: T >= totalDuration(),
    };
  };
  FTB.debugState = debugState;
  FTB._tick = tick;

  boot().then(() => { raf = requestAnimationFrame(tick); });
}

window.FTB = FTB;

})();

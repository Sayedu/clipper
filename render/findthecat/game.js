"use strict";
(function () {
/* ═══════════════════════════════════════════════════════════════
   FIND THE CAT — a "Follow The Ball" alt-variant content type.

   Based on the "Find The Cat" design handoff (design_handoff_find_the_cat/
   README.md + shell-game.jsx) — the SAME shell-game mechanic as Follow The
   Ball, but the ball is a cat-face "ball", and each render is a single
   fixed-length shuffle round rather than a multi-round, adaptive-length
   game. buildSchedule (the accelerating weighted swap timing + biased-pair
   selection) is ported verbatim from the handoff's shell-game.jsx, since
   it's a pure function of (cups, swap count, seed) -- every visual
   quantity is computed fresh from elapsed time T each frame, not a
   frame-stepped state machine. ROUND (1-5) now actually drives difficulty
   via ROUND_PRESETS (more cups + a harder swap count as it climbs) instead
   of being a cosmetic label; the live preview loops continuously through
   rounds 1->5->1 with a fresh shuffle each time rather than freezing on
   the empty outro stage. The single-swap VISUAL style (cupMotion) was
   simplified away from the handoff's own scale/rotate/dim/ghost-trail
   version to classic Follow The Ball's cleaner flat-arc smoothstep motion.

   Render plumbing (invisible, same contract as render/followball/game.js):
   FTB.step/meta/result frame API; swap/tick/reveal become an event log
   python/findthecat_audio.py re-synthesises offline (a swoosh per swap, a
   tick per countdown beat, a pop + the real cat-laugh-meme-1.wav clip on
   reveal — the README's own suggested SFX list).
   ═══════════════════════════════════════════════════════════════ */

const QS = new URLSearchParams(location.search);
const RENDER = QS.get('render') === '1';
const FPS = Math.max(20, Math.min(60, parseInt(QS.get('fps') || '60', 10)));
const W = 1080, H = 1920, TABLE_Y = 1230;
const SS = Math.max(1, Math.min(4, parseFloat(QS.get('ss') || '2')));

const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
const el = (id) => document.getElementById(id);

/* ── CUES: the handoff's own scene durations (Find The Ball.dc.html
   OM_SCENES), tuned from the original 9.0/3.0/0.8 shuffle/reveal/outro --
   shuffle shortened for a denser/faster feel, but reveal is sized to let
   the cat-laugh-meme-1.wav clip (fires 0.38s into reveal, runs ~3.24s)
   finish playing before the cut, then a quick outro to the next round
   rather than a long lingering one. Turned into cumulative start times;
   the whole clip is a fixed-length loop — duration is NOT adaptive the way
   Follow The Ball's is. ── */
const SCENE_DUR = { intro: 2.0, show: 2.6, shuffle: 7.0, guess: 3.5, reveal: 3.7, outro: 0.4 };
const I = 0;
const S = I + SCENE_DUR.intro;
const Sh = S + SCENE_DUR.show;
const G = Sh + SCENE_DUR.shuffle;
const R = G + SCENE_DUR.guess;
const O = R + SCENE_DUR.reveal;
const TOTAL = O + SCENE_DUR.outro;   // 20.9s

const THEMES = {
  candy:  { bg: '#1A0838', ray: '#2A0F5A', floor: '#33107A', cup: '#FF3B5C', light: '#FF9AAB', dark: '#A80F35', rim: '#FFE3E9', ball: '#D4FF3A', glow: 'rgba(212,255,58,.75)', accent: '#FFD23F' },
  neon:   { bg: '#04060F', ray: '#0A1534', floor: '#0B1F48', cup: '#19D3FF', light: '#A6F1FF', dark: '#0A5F8C', rim: '#E8FBFF', ball: '#FF3DCB', glow: 'rgba(255,61,203,.75)', accent: '#FFE600' },
  sunset: { bg: '#2A0B10', ray: '#40141B', floor: '#561C24', cup: '#FFB020', light: '#FFE39A', dark: '#B85E00', rim: '#FFF5DA', ball: '#3DF2FF', glow: 'rgba(61,242,255,.75)', accent: '#FF4D6D' },
};
const DIFF = { easy: { swaps: 13, name: 'EASY', color: '#3DFF8B' }, medium: { swaps: 19, name: 'MEDIUM', color: '#FFD23F' }, hard: { swaps: 27, name: 'HARD', color: '#FF4D6D' } };

/* ── "ROUND r/5" now actually drives difficulty (more cups, harder swap
   count) instead of being a cosmetic label only the creator sets -- matches
   how classic Follow The Ball's own MODES.rounds escalate. cups goes up to
   6 (same ceiling classic's own INSANE mode already uses, not a new
   untested extreme for this layout math). An explicit ?cups=/?difficulty=
   query param still overrides a round's preset (the dashboard's "render
   this seed" reproduces exactly what was just previewed by passing the
   live readout's values straight through). ── */
const ROUND_PRESETS = [
  { cups: 3, difficulty: 'easy' },
  { cups: 4, difficulty: 'easy' },
  { cups: 4, difficulty: 'medium' },
  { cups: 5, difficulty: 'medium' },
  { cups: 6, difficulty: 'hard' },
];

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

/* ── seeded RNG — mulberry32, ported verbatim from shell-game.jsx's rng() ── */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── buildSchedule / cupMotion — ported verbatim from shell-game.jsx. The
   whole shuffle is fully determined by (n, count, seed): same inputs always
   produce the same swap sequence, no shared RNG stream with anything else. ── */
function buildSchedule(n, count, seed, t0, t1) {
  const r = rng(seed * 7919 + n * 31 + count);
  const w = []; for (let i = 0; i < count; i++) w.push(1 / (1 + 2.2 * i / count));
  const sum = w.reduce((a, b) => a + b, 0);
  let t = t0, slots = [...Array(n).keys()], prev = '';
  const swaps = [];
  for (let i = 0; i < count; i++) {
    const d = (t1 - t0) * w[i] / sum;
    let a, b, key;
    do {
      if (r() < 0.6) { a = Math.floor(r() * (n - 1)); b = a + 1; } else { a = Math.floor(r() * n); b = Math.floor(r() * n); }
      if (a > b) { const tmp = a; a = b; b = tmp; }
      key = a + '-' + b;
    } while (a === b || key === prev);
    prev = key;
    swaps.push({ start: t, end: t + d * 0.88, a, b, ca: slots[a], cb: slots[b], frontA: r() < 0.5 });
    slots = slots.slice();
    const tmp = slots[a]; slots[a] = slots[b]; slots[b] = tmp;
    t += d;
  }
  return { swaps, finalSlots: slots };
}

/* Deliberately NOT the handoff's own cupMotion (which scaled/rotated/dimmed
   cups by how far they'd travelled, plus a 3-ghost motion-trail in draw()) --
   by request, swapped for the exact same clean smoothstep-position +
   sine-arc motion classic Follow The Ball's own cup swap uses: a flat 150px
   arc, no rotation, no scale pulse, no trail. Reuses this game's own
   schedule (buildSchedule's accelerating weighted timing + biased-pair
   selection) -- only the single-swap VISUAL style changed, not the pacing. */
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
      return { x: xa + (xb - xa) * sm, y: -arc * 150 * dir, sc: 1, rot: 0, z: front ? 30 : 10, dim: 0, moving: true, dur: sw.end - sw.start };
    }
    break;
  }
  return { x: slotX(slot), y: 0, sc: 1, rot: 0, z: 20, dim: 0, moving: false, slot };
}

/* ── confetti — a fixed, non-seeded particle set (identical every render,
   per the handoff's own `rng(4242)` useMemo — only its launch POSITION
   (the winning slot) varies per video) ── */
const CONFETTI = (() => {
  const r = rng(4242);
  return Array.from({ length: 48 }, () => ({
    a: -Math.PI * (0.08 + 0.84 * r()), v: 900 + 900 * r(), spin: (r() - 0.5) * 1400,
    ci: Math.floor(r() * 4), w: 14 + r() * 12,
  }));
})();

/* ═══════════════ world (reset() rebuilds everything from seed/cups/difficulty) ═══════════════ */
let W_ = null;   // current run's derived state
let catImg = null, fontsReady = false;

function cupSpacing(n) { return Math.min(340, 1050 / n); }
function slotXFor(n) { const spacing = cupSpacing(n); return (i) => 540 + (i - (n - 1) / 2) * spacing; }

function reset(seed, round, theme, cupsOverride, difficultyOverride) {
  const roundN = clamp(Math.round(round ?? (W_ ? W_.round : 1)), 1, 5);
  const preset = ROUND_PRESETS[roundN - 1];
  const n = clamp(Math.round(cupsOverride ?? preset.cups), 3, 6);
  const diffKey = difficultyOverride ?? preset.difficulty;
  const diff = DIFF[diffKey] || DIFF.easy;
  const themeKey = theme ?? (W_ ? W_.themeKey : 'candy');
  const s = (seed >>> 0) || 1;

  const spacing = cupSpacing(n);
  const slotX = slotXFor(n);
  // bigger than the handoff's own 0.84 -- the ball carries a specific meme
  // image (the cat face + the pointing finger), not a flat color, so it
  // needs to read clearly at a glance, not just as "a circle under a cup".
  const cupW = spacing * 0.9, cupH = cupW * 1.3, ballD = cupW * 1.05;
  const ballCup = Math.floor(n / 2);
  const sched = buildSchedule(n, diff.swaps, s, Sh + 0.25, G - 0.3);
  const win = sched.finalSlots.indexOf(ballCup);

  // sound-event crossing detector state — see emitEvents()
  const tickTimes = [0, 1, 2].map((i) => G + 0.35 + i * 0.95);

  W_ = {
    seed: s, cups: n, diffKey, diff, round: roundN, themeKey, theme: THEMES[themeKey] || THEMES.candy,
    spacing, slotX, cupW, cupH, ballD, ballCup, swaps: sched.swaps, finalSlots: sched.finalSlots, win,
    tickTimes, revealAt: R + 0.3,
    prevT: -1, bigKey: '', bigAt: 0, cdKey: -1,
  };
}

function extra(c, slot, T) {
  const w = W_;
  let dy = 0, rot = 0, sq = 1;
  const st = I + 0.3 + c * 0.13, land = st + 0.45;
  dy += -1500 * (1 - fall((T - st) / 0.45));
  sq *= squash(T - land);
  if (c === w.ballCup) {
    const up = MOTION.enter(cl((T - S - 0.1) / 0.45)), down = fall((T - S - 1.8) / 0.32);
    dy += -330 * up * (1 - down); rot += -9 * up * (1 - down);
    sq *= squash(T - S - 2.12);
  }
  if (T >= G && T < R + 0.3) dy += -16 * Math.abs(Math.sin((T - G) * 5 + slot * 0.9)) * cl((T - G) / 0.3);
  // quick, clean pop-up on reveal (no rotation) -- matches classic's own
  // snappy ~0.26s winning-cup lift rather than a slower, tilting one
  if (slot === w.win) { const e = MOTION.enter(cl((T - R - 0.3) / 0.25)); dy += -380 * e; }
  // shrunk + less staggered so even a 6-cup round fully completes inside
  // the now-short 0.4s outro (worst case: 5*0.02 + 0.3 = 0.4s)
  dy += -1700 * fall((T - O - slot * 0.02) / 0.3);
  return { dy, rot, sq };
}

/* ═══════════════ sound events (edge-triggered off T crossing known instants) ═══════════════ */
const SWAP_SCALE = [0, 3, 5, 7, 10, 12, 15, 17];
const SWAP_BASE = 233;
let swapNote = 0;

function emitEvents(prevT, T, frame, push) {
  const w = W_;
  for (const sw of w.swaps) {
    if (prevT < sw.start && T >= sw.start) {
      swapNote = (swapNote + 1) % SWAP_SCALE.length;
      const dur = Math.max(0.001, sw.end - sw.start);
      push({ type: 'swap', t: +T.toFixed(4), f: frame, hz: SWAP_BASE * Math.pow(2, SWAP_SCALE[swapNote] / 12), speed: Math.min(1, 0.5 / dur) });
    }
  }
  w.tickTimes.forEach((tt, i) => {
    if (prevT < tt && T >= tt) push({ type: 'tick', t: +T.toFixed(4), f: frame, hot: i === 2 });
  });
  if (prevT < w.revealAt && T >= w.revealAt) push({ type: 'reveal', t: +T.toFixed(4), f: frame });
}

/* ═══════════════ draw — SPEC-equivalent, 1:1 with the design's Piece() ═══════════════ */
function drawCupPath() {
  // SPEC: "Cup Shape (SVG, viewBox 0 0 100 130)" — ported path commands exactly.
  ctx.beginPath();
  ctx.moveTo(24, 8);
  ctx.quadraticCurveTo(50, 2, 76, 8);
  ctx.lineTo(95, 118);
  ctx.quadraticCurveTo(50, 128, 5, 118);
  ctx.closePath();
}

function drawCup(th, w, h) {
  // body gradient: dark -> cup -> light -> cup -> dark, horizontal across the viewBox
  const g = ctx.createLinearGradient(0, 0, 100, 0);
  g.addColorStop(0, th.dark); g.addColorStop(0.3, th.cup); g.addColorStop(0.55, th.light);
  g.addColorStop(0.75, th.cup); g.addColorStop(1, th.dark);
  drawCupPath();
  ctx.fillStyle = g; ctx.fill();
  // two faint ridges
  ctx.globalAlpha = 0.35; ctx.fillStyle = th.dark;
  ctx.beginPath(); ctx.moveTo(13, 54); ctx.lineTo(87, 54); ctx.lineTo(88, 60); ctx.lineTo(12, 60); ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 0.3;
  ctx.beginPath(); ctx.moveTo(10, 76); ctx.lineTo(90, 76); ctx.lineTo(91, 81); ctx.lineTo(9, 81); ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 1;
  // light rim band
  ctx.beginPath(); ctx.moveTo(7.4, 102); ctx.lineTo(92.6, 102); ctx.lineTo(95, 118); ctx.quadraticCurveTo(50, 128, 5, 118); ctx.closePath();
  ctx.fillStyle = th.rim; ctx.fill();
  ctx.globalAlpha = 0.25; ctx.fillStyle = th.dark;
  ctx.beginPath(); ctx.moveTo(7.4, 102); ctx.lineTo(92.6, 102); ctx.lineTo(93, 105); ctx.lineTo(7, 105); ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 1;
  // dark ellipse top (the cup's mouth)
  ctx.fillStyle = th.dark;
  ctx.beginPath(); ctx.ellipse(50, 8, 26, 4.5, 0, 0, 6.283); ctx.fill();
  // white highlight stripe
  ctx.globalAlpha = 0.35; ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.moveTo(33, 14); ctx.lineTo(40, 14); ctx.lineTo(31, 98); ctx.lineTo(22, 98); ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 1;
}

function paintCup(entry, th, cupW, cupH) {
  const { m, ex, op } = entry;
  const pivotX = m.x, pivotY = TABLE_Y + m.y + (ex ? ex.dy : 0);
  const unit = cupW / 100;
  const scX = m.sc, scY = m.sc * (ex ? ex.sq : 1);
  ctx.save();
  ctx.globalAlpha = op !== undefined ? op : 1;
  if (entry.dim) ctx.filter = `brightness(${1 - entry.dim})`;
  ctx.translate(pivotX, pivotY);
  ctx.rotate(((m.rot + (ex ? ex.rot : 0)) * Math.PI) / 180);
  ctx.scale(unit * scX, unit * scY);
  ctx.translate(-50, -130);
  drawCup(th, cupW, cupH);
  ctx.restore();
}

function draw(T) {
  const w = W_, th = w.theme, n = w.cups, spacing = w.spacing, slotX = w.slotX;
  const S_ = cv.width / W;
  ctx.setTransform(S_, 0, 0, S_, 0, 0);
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);

  // ── rays (screen space, behind everything) ──
  const sp = cl((T - Sh) / (G - Sh));
  const rayAngle = T * 6 + 160 * sp * sp + 40 * cl((T - G) / (R - G));
  const rayOpacity = 0.6 + 0.3 * sp * (T < G ? 1 : 0);
  ctx.save();
  ctx.globalAlpha = rayOpacity;
  ctx.translate(540, 1050);
  ctx.rotate((rayAngle * Math.PI) / 180);
  const wedge = (9 * Math.PI) / 180;
  for (let i = 0; i < 40; i++) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 1500, i * wedge, (i + 1) * wedge);
    ctx.closePath();
    ctx.fillStyle = i % 2 === 0 ? th.ray : th.bg;
    ctx.fill();
  }
  ctx.restore();

  // ── vignette (screen space) ──
  const vg = ctx.createRadialGradient(540, 1113.6, 0, 540, 1113.6, 1237.6);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(0.25, 'rgba(0,0,0,0)'); vg.addColorStop(0.7, th.bg); vg.addColorStop(1, th.bg);
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

  // ── camera (zoom toward the winning cup on reveal) ──
  const revealE = MOTION.glide(cl((T - R - 0.2) / 0.7)) * (1 - MOTION.glide(cl((T - O) / 0.6)));
  const zoom = 1 + 0.07 * MOTION.glide(sp) * (1 - MOTION.glide(cl((T - G) / 0.6))) + 0.12 * revealE;
  const ox = 540 + (slotX(w.win) - 540) * revealE;
  const oy = TABLE_Y - 220;

  ctx.save();
  ctx.translate(ox, oy); ctx.scale(zoom, zoom); ctx.translate(-ox, -oy);

  // floor
  const fg = ctx.createLinearGradient(0, 1040, 0, 2120);
  fg.addColorStop(0, th.floor); fg.addColorStop(0.75, th.bg); fg.addColorStop(1, th.bg);
  ctx.fillStyle = fg; ctx.fillRect(-200, 1040, 1480, 1080);

  // horizon line + pulse
  const lastEnd = w.swaps.filter((s) => s.end <= T).pop();
  const pulse = lastEnd && T < G ? Math.exp(-(T - lastEnd.end) * 7) : 0;
  ctx.save();
  ctx.shadowColor = th.cup; ctx.shadowBlur = 24;
  ctx.globalAlpha = 0.35 + 0.5 * pulse;
  ctx.fillStyle = th.light; ctx.fillRect(0, 1040, W, 3);
  ctx.restore();

  // ground glow
  ctx.save();
  ctx.globalAlpha = 0.5 + 0.5 * pulse;
  const gg = ctx.createRadialGradient(540, TABLE_Y, 0, 540, TABLE_Y, 500);
  gg.addColorStop(0, th.cup + '55'); gg.addColorStop(1, th.cup + '00');
  ctx.fillStyle = gg;
  ctx.beginPath(); ctx.ellipse(540, TABLE_Y, 500, 110, 0, 0, 6.283); ctx.fill();
  ctx.restore();

  // per-cup motion/extra, built once for this frame. No motion-trail ghosts
  // (removed by request -- read as "blur", not polish) -- clean solid cups
  // only, same as classic Follow The Ball.
  const entries = [];
  for (let c = 0; c < n; c++) {
    const m = cupMotion(c, T, w.swaps, slotX);
    const slotNow = m.moving ? -1 : (T >= G ? w.finalSlots.indexOf(c) : m.slot);
    const ex = extra(c, slotNow, T);
    const dimLosers = T > R + 0.5 && T < O && slotNow !== w.win ? 0.35 * cl((T - R - 0.5) / 0.3) : 0;
    entries.push({ c, m, ex, slotNow, dim: m.dim + dimLosers });
  }

  // shadows (drawn before the ball/cups)
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

  // ball (the cat), visible under its cup during Show, and after Reveal --
  // stays fully visible (no shrink-to-zero outro) by request: the cat's
  // face should stay on screen, not disappear right after it's revealed.
  let ballShow = false, ballX = slotX(w.ballCup), ballY = 0;
  const bt = T - S - 0.42;
  if (bt >= 0 && T < S + 2.15) {
    ballShow = true;
    if (bt < 0.36) ballY = -820 * (1 - fall(bt / 0.36));
    else if (bt < 0.7) { const u = (bt - 0.36) / 0.34; ballY = -4 * 110 * u * (1 - u); }
    else if (bt < 0.9) { const u = (bt - 0.7) / 0.2; ballY = -4 * 36 * u * (1 - u); }
  }
  if (T >= R + 0.3) { ballShow = true; ballX = slotX(w.win); }
  const glowPulse = T >= R + 0.45 ? 0.6 + 0.4 * Math.sin((T - R) * 9) : 0.3;

  if (ballShow && catImg) {
    const bx = ballX, by = TABLE_Y - w.ballD + ballY - 4 + w.ballD / 2;
    ctx.save();
    ctx.shadowColor = th.glow; ctx.shadowBlur = 30 + 60 * glowPulse;
    ctx.fillStyle = th.ball;
    ctx.beginPath(); ctx.arc(bx, by, w.ballD / 2, 0, 6.283); ctx.fill();   // a filled circle casts the glow shadow
    ctx.shadowBlur = 0;
    ctx.save();
    ctx.beginPath(); ctx.arc(bx, by, w.ballD / 2, 0, 6.283); ctx.clip();
    ctx.translate(bx, by);
    ctx.rotate((Math.sin(T * 6) * 8 * Math.PI) / 180);
    // contain-fit (not cover/crop) -- the whole meme (the cat face AND the
    // pointing finger) has to read, not just whatever a tight center-crop
    // happens to keep. A touch over pure "contain" (1.08x) so the themed
    // circle behind it doesn't show as a big empty ring.
    const natW = catImg.naturalWidth || 480, natH = catImg.naturalHeight || 448;
    const fit = Math.min(w.ballD / natW, w.ballD / natH) * 1.08;
    const iw = natW * fit, ih = natH * fit;
    ctx.drawImage(catImg, -iw / 2, -ih / 2, iw, ih);
    ctx.restore();
    ctx.restore();
  }

  // winner shockwave rings (only during the reveal window)
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

  // cups, back-to-front by z (ghosts interleaved correctly)
  entries.sort((a, b) => a.m.z - b.m.z);
  for (const en of entries) paintCup(en, th, w.cupW, w.cupH);

  // slot number markers (always above the cups)
  for (let i = 0; i < n; i++) {
    const e = MOTION.enter(cl((T - G - i * 0.08) / 0.4)) * (1 - cl((T - O) / 0.3));
    const isWin = i === w.win && T > R + 0.4;
    const lose = i !== w.win && T > R + 0.4;
    if (e <= 0.001) continue;
    const x = slotX(i), y = TABLE_Y + 50 + 46;
    ctx.save();
    ctx.globalAlpha = lose ? 0.35 : 1;
    ctx.translate(x, y); ctx.scale(e * (isWin ? 1.3 : 1), e * (isWin ? 1.3 : 1));
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

  // confetti
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

/* ═══════════════ HUD — DOM overlay, updated every frame (no CSS animation
   in render mode; JS computes the exact easeOutElastic pop every tick) ═══════════════ */
const TITLES = [
  { at: I + 0.15, text: 'FIND THE CAT', sub: 'READY?' },
  { at: S + 0.1, text: 'EYES ON THE CAT', sub: "DON'T BLINK" },
  { at: Sh, text: 'KEEP TRACKING', sub: 'STAY LOCKED IN' },
  { at: Sh + (G - Sh) * 0.58, text: 'FASTER!!', sub: 'NO WAY YOU GOT THIS', hot: true },
  { at: G, text: "WHERE'S THE CAT?", sub: 'COMMENT YOUR ANSWER' },
];

function hud(T) {
  const w = W_;
  el('roundLabel').textContent = 'ROUND ' + w.round + '/5';
  const chip = el('diffChip');
  chip.textContent = w.diff.name + ' · ' + w.cups + ' CUPS';
  chip.style.borderColor = w.diff.color;

  const prog = cl(T / O);
  [...el('pips').children].forEach((pip, r0) => {
    const r = r0 + 1;
    const b = pip.firstElementChild;
    b.style.width = (r < w.round ? 100 : r === w.round ? prog * 100 : 0) + '%';
    b.style.background = r === w.round ? w.theme.accent : '#fff';
  });

  const titleList = T > R + 0.4 ? TITLES.concat([{ at: R + 0.4, text: 'CUP ' + (w.win + 1) + '!', sub: 'DID YOU GET IT?', hot: true }]) : TITLES;
  const cur = titleList.filter((x) => T >= x.at).pop();
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
    titleText.style.color = cur.hot ? w.theme.accent : '#fff';
    titleSub.textContent = cur.sub;
  }

  const cdT = T - G - 0.35, cdI = Math.floor(cdT / 0.95);
  const cdShow = cdT >= 0 && cdI < 3 && T < R + 0.2;
  const cdWrap = el('cdWrap');
  if (cdShow) {
    cdWrap.style.display = 'flex';
    const cdK = cdT - cdI * 0.95;
    const ring = el('cdRing');
    const circ = 2 * Math.PI * 84;
    ring.setAttribute('stroke-dasharray', String(circ));
    ring.setAttribute('stroke-dashoffset', String(circ * cl(cdK / 0.95)));
    ring.setAttribute('stroke', w.theme.accent);
    const numEl = el('cdNum');
    numEl.textContent = String(3 - cdI);
    numEl.style.transform = `scale(${0.4 + 0.6 * MOTION.pop(cl(cdK / 0.6))})`;
  } else {
    cdWrap.style.display = 'none';
  }

  el('caption').textContent = T >= R + 0.4 ? 'Did you find him?' : 'Can you follow the cat?';
  el('caption').style.transform = `translateY(${Math.sin(T * 3) * 6}px)`;
}

function paint(T) {
  draw(T);
  hud(T);
}

/* ═══════════════ render / preview harness (same contract as followball/game.js) ═══════════════ */
const DT = 1 / FPS;
let frame = 0, prevT = -1;

function stepOnce(push) {
  const T = Math.min(TOTAL, frame / FPS);
  emitEvents(prevT, T, frame, push);
  paint(T);
  prevT = T;
  frame += 1;
  return T;
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
    round: parseInt(QS.get('round') || '1', 10),
    theme: (QS.get('theme') || 'candy').toLowerCase(),
    // explicit overrides only -- absent means "derive from the round preset"
    // (see ROUND_PRESETS / reset()). The dashboard's render-this-seed path
    // always sends these explicitly, reproducing exactly what was previewed.
    cupsOverride: QS.has('cups') ? parseInt(QS.get('cups'), 10) : undefined,
    difficultyOverride: QS.has('difficulty') ? QS.get('difficulty').toLowerCase() : undefined,
  };
}

const FTB = { frame: 0, done: false, meta: null };

if (RENDER) {
  const d = parseQueryDefaults();
  FTB.step = () => {
    const events = [];
    const T = stepOnce((ev) => events.push(ev));
    FTB.frame = frame;
    const done = T >= TOTAL;
    FTB.done = done;
    return { frame, events, done };
  };
  FTB.result = () => ({
    seed: W_.seed, cups: W_.cups, difficulty: W_.diffKey, round: W_.round, theme: W_.themeKey,
    win: W_.win + 1, durationSec: +(frame / FPS).toFixed(2), frames: frame, fps: FPS,
  });
  (async () => {
    try { if (document.fonts) { document.fonts.load('900 48px "Chakra Petch"'); await document.fonts.ready; } } catch (e) {}
    await loadCat();
    reset(d.seed, d.round, d.theme, d.cupsOverride, d.difficultyOverride);
    FTB.meta = { fps: FPS, totalFrames: Math.round(TOTAL * FPS), seed: W_.seed, width: W, height: H };
  })();
} else {
  /* ── preview studio API (window.FTB.*) ── */
  let raf = 0, acc = 0, prevWallT = 0, speed = 1, soundOn = false;
  const randSeed = () => ((Math.random() * 0x7fffffff) >>> 0) || 1;

  const boot = async () => {
    const d = parseQueryDefaults();
    await loadCat();
    reset(d.seed, d.round, d.theme, d.cupsOverride, d.difficultyOverride);
    frame = 0; prevT = -1;
    resize();
  };

  const restart = (seed, round, theme) => {
    reset(seed, round, theme);
    frame = 0; prevT = -1; acc = 0; prevWallT = 0;
  };

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!prevWallT) prevWallT = now;
    acc += Math.min(0.25, (now - prevWallT) / 1000) * speed;
    prevWallT = now;
    let guard = 0;
    while (acc >= DT && guard++ < 800) { stepOnce(() => {}); acc -= DT; }
    // Always keep playing -- a single round ending on an intentionally empty
    // "outro" stage would otherwise just sit there forever (looked like a
    // broken/frozen preview). Loops straight into the next round, escalating
    // difficulty (round wraps 1->5->1), a fresh shuffle each time -- the
    // preview is always "playing something", same as classic's own.
    if (frame / FPS >= TOTAL + 0.3) {
      restart(randSeed(), (W_.round % 5) + 1, W_.themeKey);
    }
  }

  // every method below is a no-op (or a safe placeholder) until boot() resolves
  // (loading the cat image is async) -- the dashboard's own readiness poll
  // treats `FTB.replay` existing as "ready" and calls getSeed()/readout()
  // right away, so none of these can assume W_ is already built.
  FTB.replay = (seed) => W_ && restart(seed === undefined || seed === null || seed === '' ? randSeed() : (Number(seed) >>> 0) || 1, W_.round, W_.themeKey);
  FTB.again = () => W_ && restart(W_.seed, W_.round, W_.themeKey);
  FTB.setRound = (r) => W_ && restart(randSeed(), r, W_.themeKey);
  FTB.setTheme = (t) => W_ && restart(W_.seed, W_.round, t);
  FTB.setSpeed = (s) => { speed = [0.5, 1, 2, 4].includes(+s) ? +s : 1; };
  FTB.setSound = (on) => { soundOn = !!on; };
  FTB.getSeed = () => (W_ ? W_.seed : 0);
  FTB.getMode = () => (W_ ? W_.diffKey : 'easy');
  FTB.readout = () => {
    if (!W_) return { seed: 0, cups: 5, difficulty: 'easy', round: 1, theme: 'candy', phase: 'Loading', t: 0, totalSec: TOTAL, win: 0, done: false };
    const T = Math.min(TOTAL, frame / FPS);
    const phase = T < S ? 'Intro' : T < Sh ? 'Show' : T < G ? 'Shuffle' : T < R ? 'Guess' : T < O ? 'Reveal' : 'Outro';
    return {
      seed: W_.seed, cups: W_.cups, difficulty: W_.diffKey, round: W_.round, theme: W_.themeKey,
      phase, t: T, totalSec: TOTAL, win: W_.win + 1, done: T >= TOTAL,
    };
  };
  FTB._tick = tick;

  boot().then(() => { raf = requestAnimationFrame(tick); });
}

window.FTB = FTB;

})();

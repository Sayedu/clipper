"use strict";
(function () {
/* ═══════════════════════════════════════════════════════════════
   EYE TEST — "Ghost Object Tracker" Visual Focus Test, MULTI-ROUND.

   One PLAN drives the whole clip: an ordered list of per-round ball counts
   (round count = list length, 1-6 rounds) plus a single shuffle-duration
   (seconds) shared by every round. Both are fully user-configurable — via
   `?balls=8,8,6&shuffle=6` for render/CLI, or `ET.setPlan(ballsArr,sec)` in
   the live preview — there is no more fixed SPRINT/CLASSIC preset table.

   Each round runs the same automatic sequence:
   Phase 1 (LOCK IN, 3s): the round's spheres appear at random non-overlapping
   spots inside a circular arena; one flashes gold as the target; a 3-2-1
   countdown runs.
   Phase 2 (SHUFFLE, user's seconds): the target strobes back to matte gray,
   every sphere launches on a random heading, and REAL physics takes over —
   elastic ball-ball collisions (equal-mass, swap the velocity component along
   the collision normal) plus circular-wall bounces. The arena slowly spins
   for disorientation. Near-misses are an emergent property of N fast bodies
   in a bounded circle, never scripted.
   Phase 3 (FREEZE): everything stops instantly, numbers 1..N fade in on the
   frozen spheres (assigned left-to-right so nothing leaks during tracking),
   then the true target re-flashes gold for that round's reveal.
   After the last round: a short SCORE CARD lists every round's answer
   ("comment your scores"), matching this app's other multi-round formats.

   Render plumbing (invisible, same contract as every other content type):
   seeded mulberry32 for the SIM only (ball placement, headings) — cosmetic
   randomness (spark jitter reuses the same seeded stream deliberately, see
   spark()) never touches Math.random(). ET.step/meta/result frame API.
   Web-Audio calls become an event log python/eyetest_audio.py resynthesises
   offline.
   ═══════════════════════════════════════════════════════════════ */

const QS = new URLSearchParams(location.search);
const RENDER = QS.get('render') === '1';
const SEED = (parseInt(QS.get('seed') || '1', 10) >>> 0) || 1;
const FPS = Math.max(20, Math.min(60, parseInt(QS.get('fps') || '60', 10)));
const W = 1080, H = 1920;                              // the design's fixed coordinate space
const SS = Math.max(1, Math.min(4, parseFloat(QS.get('ss') || '2')));
// safety frame cap only — the game self-terminates once the score card holds.
// ?sec= overrides; range widened (was 90) to cover long custom round plans.
const CAP_SEC = QS.has('sec') ? Math.max(8, Math.min(160, parseFloat(QS.get('sec')) || 24)) : null;

const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
const el = (id) => document.getElementById(id);

const ET = { frame: 0, done: false, meta: null, _hardCap: 999999 };

/* ── deterministic RNG (mulberry32) — identical pattern to every other
   content type in this app. Only ball placement + initial headings consume
   it; the collision physics itself is fully deterministic (no randomness in
   the collision response), so the seeded stream's consumption count never
   depends on how many collisions happen to occur. ── */
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
const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));

/* ── circular arena — centred, sized to clear the HUD above it. Ball radius
   and speed are the spec's own numbers (15px / 400-600px/s) scaled up 2.4×
   to this app's authored 1080-wide canvas (every other content type shares
   it, so the 4K output pipeline stays untouched): 1080/450 = 2.4. Fixed
   regardless of round ball-count — difficulty comes from ball count + your
   shuffle length, not from shrinking the balls. ── */
const ARENA_CX = W / 2, ARENA_CY = 1100, ARENA_R = 480;
const SCALE = 1080 / 450;
const BALL_R = Math.round(15 * SCALE);   // 36
const SPEED_MIN = Math.round(400 * SCALE), SPEED_MAX = Math.round(600 * SCALE);

const COL_BG = '#0d0e12';
const COL_ARENA = '#00e5ff';   // neon cyber-blue
const COL_GRAY = '#3a3d4a';    // matte background spheres
const COL_GOLD = '#ffd700';    // the target

/* ── the plan: an ordered per-round ball-count list (length = round count,
   1-6 rounds, 4-10 balls each) + one shuffle-duration shared by every round
   (3-15s). Fully user-set — via the querystring for render/CLI, or
   ET.setPlan() from the live preview. No preset tables. ── */
function parseBallsParam(raw) {
  const nums = String(raw || '')
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.max(4, Math.min(10, n)))
    .slice(0, 6);
  return nums.length ? nums : [8, 8, 8];
}
const clampShuffle = (n) => Math.max(3, Math.min(15, Number(n) || 6));
let curPlan = { balls: parseBallsParam(QS.get('balls') || '8,8,8'), shuffleSec: clampShuffle(QS.get('shuffle') || 6) };
let curSeed = SEED;

// fixed per-round beat timings (not user-configurable — only round count,
// balls/round, and shuffle length are): how long the lock-in countdown runs,
// the flash-transition, the frozen "which number" hold before the reveal,
// and the reveal hold. Plus the once-only score-card hold at the very end.
const T_LOCKIN = 3.0, T_FLASH = 0.25, T_HOLD_ASK = 2.6, T_HOLD_REVEAL = 1.5;
const T_SCORECARD = 3.5, T_DONE = 1.0;
const PER_ROUND_FIXED = T_LOCKIN + T_FLASH + T_HOLD_ASK + T_HOLD_REVEAL;   // 7.35s of every round isn't the shuffle

function estimateDurationSec(plan) {
  return plan.balls.length * (PER_ROUND_FIXED + plan.shuffleSec) + T_SCORECARD + T_DONE;
}

/* ═══════════════════ world (reset()) ═══════════════════ */
let G = null, Sound = null;

function placeBalls(n, r) {
  const balls = [];
  for (let i = 0; i < n; i++) {
    let x = 0, y = 0, ok = false, tries = 0;
    while (!ok && tries < 80) {
      // uniform-in-disk sampling (sqrt on the radial fraction), kept fully
      // inside the arena wall
      const ang = rnd() * Math.PI * 2;
      const rad = Math.sqrt(rnd()) * (ARENA_R - r - 8);
      x = ARENA_CX + Math.cos(ang) * rad;
      y = ARENA_CY + Math.sin(ang) * rad;
      ok = balls.every((b) => Math.hypot(b.x - x, b.y - y) > r * 2.3);
      tries++;
    }
    balls.push({ id: i, x, y, r, vx: 0, vy: 0, speed: 0, num: 0, glow: 0 });
  }
  return balls;
}

function reset(seed, plan) {
  if (plan) curPlan = plan;
  if (seed !== undefined) curSeed = seed >>> 0;
  seedRng(curSeed);          // canonical RNG state — identical for preview & render
  ET.frame = 0; ET.done = false;
  const n0 = curPlan.balls[0];
  G = {
    round: 1, totalRounds: curPlan.balls.length,
    time: 0, phase: 'lockin', phaseAt: 0,
    balls: placeBalls(n0, BALL_R),
    target: rint(0, n0 - 1),
    answer: 0, arenaRot: 0, sparks: [],
    results: [],            // {round, answer} per finished round
    scoreBuilt: false,
    manualReveal: false,    // preview-only override, see ET.revealNow()
  };
  hudT = -9;
  hud(true);
}

/* ═══════════════ audio — event recorder in render mode ═══════════════
   Mirrors colorwar/followball's approach: rate-gated push() objects the
   offline synth (python/eyetest_audio.py) turns into the actual soundtrack.
   Event NAMES are unchanged from every previous build (target-shown / lock /
   near-miss / freeze / reveal-fanfare / finish) so the python side needs no
   changes — `reveal-fanfare` fires every round, `finish` once at the very
   end. `near-miss` fires on a genuine physics collision, rate-gated. */
function makeSoundRecorder() {
  let buf = [];
  let lastMiss = -9;
  const push = (o) => { o.t = +G.time.toFixed(4); o.f = ET.frame; buf.push(o); };
  return {
    _drain() { const b = buf; buf = []; return b; },
    targetShown() { push({ type: 'target-shown' }); },
    lock() { push({ type: 'lock' }); },
    nearMiss() {
      // rate-gated — with several fast bodies in a bounded circle, real
      // collisions can cluster tightly; this keeps the mix from stacking a
      // wall of hits.
      if (G.time - lastMiss < 0.12) return;
      lastMiss = G.time;
      push({ type: 'near-miss' });
    },
    freeze() { push({ type: 'freeze' }); },
    reveal() { push({ type: 'reveal-fanfare' }); },
    finish() { push({ type: 'finish' }); },
  };
}

function liveSound() {
  // browser-preview only — a restrained Web Audio port of the same voices
  // eyetest_audio.py synthesises offline. Starts MUTED (rerolling shouldn't
  // blast audio each time).
  let ac, master, noiseBuf, muted = true;
  const ensure = () => {
    if (!ac) {
      const A = window.AudioContext || window.webkitAudioContext; if (!A) return;
      ac = new A();
      master = ac.createGain(); master.gain.value = muted ? 0 : 0.26; master.connect(ac.destination);
      noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.3, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ac && ac.state === 'suspended') ac.resume();
  };
  const env = (node, at, peak, atk, dec, dest) => {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(peak, at + atk);
    g.gain.exponentialRampToValueAtTime(0.0008, at + atk + dec);
    g.gain.linearRampToValueAtTime(0, at + atk + dec + 0.02);
    node.connect(g); g.connect(dest || master);
    return at + atk + dec + 0.04;
  };
  let lastMiss = -9;
  return {
    _drain() { return []; },
    ensure,
    setEnabled(on) { muted = !on; if (on) ensure(); if (ac) master.gain.value = muted ? 0 : 0.26; },
    targetShown() {
      ensure(); if (!ac || muted) return;
      const now = ac.currentTime;
      [0, 5].forEach((st, k) => {
        const t0 = now + k * 0.08;
        const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = 440 * Math.pow(2, st / 12);
        const end = env(o, t0, 0.2, 0.012, 0.24);
        o.start(t0); o.stop(end);
      });
    },
    lock() {
      ensure(); if (!ac || muted) return;
      const now = ac.currentTime;
      const s = ac.createBufferSource(); s.buffer = noiseBuf;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 2.2;
      const end = env(bp, now, 0.16, 0.004, 0.05);
      s.connect(bp); s.start(now); s.stop(end);
    },
    nearMiss() {
      ensure(); if (!ac || muted) return;
      const now = ac.currentTime;
      if (now - lastMiss < 0.12) return; lastMiss = now;   // rate-gate — real collisions can be frequent
      const s = ac.createBufferSource(); s.buffer = noiseBuf; s.playbackRate.value = 1.3;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.7;
      bp.frequency.setValueAtTime(1400, now); bp.frequency.linearRampToValueAtTime(700, now + 0.22);
      const end = env(bp, now, 0.07, 0.02, 0.2);
      s.connect(bp); s.start(now); s.stop(end);
    },
    freeze() {
      ensure(); if (!ac || muted) return;
      const now = ac.currentTime;
      const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = 110;
      const end = env(o, now, 0.12, 0.01, 0.3);
      o.start(now); o.stop(end);
    },
    reveal() {
      ensure(); if (!ac || muted) return;
      const now = ac.currentTime;
      [0, 4, 7, 12].forEach((st, k) => {
        const t0 = now + k * 0.05;
        const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = 349 * Math.pow(2, st / 12);
        const end = env(o, t0, 0.22, 0.014, 0.4);
        o.start(t0); o.stop(end);
      });
    },
    finish() {
      ensure(); if (!ac || muted) return;
      const now = ac.currentTime;
      [0, 4, 7, 12, 16].forEach((st, k) => {
        const t0 = now + k * 0.08;
        const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = 262 * Math.pow(2, st / 12);
        const end = env(o, t0, 0.25, 0.016, 0.5);
        o.start(t0); o.stop(end);
      });
    },
  };
}

/* ═══════════════ helpers ═══════════════ */
// seeded — part of the deterministic sim, fired from the reveal beat only
// (the one moment it happens, so it can never change how many times the
// seeded stream gets pumped per frame during the physics-heavy shuffle).
function spark(x, y, col, n) {
  const w = G;
  if (w.sparks.length > 220) return;
  for (let k = 0; k < n; k++) {
    const a = rnd() * 6.283, sp = 70 + rnd() * 220;
    w.sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, c: col });
  }
}

/* real physics: circular-arena wall bounce (reflect the velocity across the
   wall normal) + equal-mass elastic ball-ball collisions (swap the velocity
   COMPONENT along the collision normal, keep the tangential component — the
   standard elastic-collision-between-equal-masses identity). Both are pure
   functions of position/velocity — no randomness, so collision frequency
   never perturbs the deterministic RNG stream. */
function physicsStep(dt) {
  const w = G;
  for (const b of w.balls) { b.x += b.vx * dt; b.y += b.vy * dt; }

  for (const b of w.balls) {
    const dx = b.x - ARENA_CX, dy = b.y - ARENA_CY, dist = Math.hypot(dx, dy) || 0.0001;
    const maxDist = ARENA_R - b.r;
    if (dist > maxDist) {
      const nx = dx / dist, ny = dy / dist;
      const dot = b.vx * nx + b.vy * ny;
      if (dot > 0) { b.vx -= 2 * dot * nx; b.vy -= 2 * dot * ny; }
      b.x = ARENA_CX + nx * maxDist; b.y = ARENA_CY + ny * maxDist;
    }
  }

  for (let i = 0; i < w.balls.length; i++) for (let j = i + 1; j < w.balls.length; j++) {
    const a = w.balls[i], b = w.balls[j];
    const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy) || 0.0001;
    const minDist = a.r + b.r;
    if (dist < minDist) {
      const nx = dx / dist, ny = dy / dist;
      const overlap = minDist - dist;
      a.x -= nx * overlap * 0.5; a.y -= ny * overlap * 0.5;
      b.x += nx * overlap * 0.5; b.y += ny * overlap * 0.5;
      const avn = a.vx * nx + a.vy * ny, bvn = b.vx * nx + b.vy * ny;
      if (bvn - avn < 0) {   // only resolve if they're actually closing, not already separating
        const avtX = a.vx - avn * nx, avtY = a.vy - avn * ny;
        const bvtX = b.vx - bvn * nx, bvtY = b.vy - bvn * ny;
        a.vx = avtX + bvn * nx; a.vy = avtY + bvn * ny;
        b.vx = bvtX + avn * nx; b.vy = bvtY + avn * ny;
        Sound.nearMiss();
      }
    }
  }

  // pin every ball back to its own assigned speed. A true elastic exchange
  // (above) redistributes energy BETWEEN the two balls in a collision — real
  // physics, but with several balls colliding in a small arena a ball can
  // absorb a string of "losing" hits in a row and visibly crawl for a
  // stretch even though total system energy is fine. Collisions should only
  // ever redirect a ball here, never leave it slow — so re-normalize the
  // magnitude back to b.speed (picked once, at shuffle-start) every substep,
  // keeping only the direction the physics just computed.
  for (const b of w.balls) {
    const v = Math.hypot(b.vx, b.vy);
    if (v > 0.0001) {
      const k = b.speed / v;
      b.vx *= k; b.vy *= k;
    }
  }
}

/* ═══════════════ advance one frame ═══════════════ */
function advance(dt) {
  const w = G;
  w.time += dt;
  const e = w.time - w.phaseAt;

  if (w.phase === 'lockin') {
    w.balls[w.target].glow = Math.min(1, e / 0.25);
    if (e === dt) Sound.targetShown();   // fires once, the moment this round's lock-in begins
    if (e > T_LOCKIN) { w.phase = 'flash'; w.phaseAt = w.time; Sound.lock(); }
  } else if (w.phase === 'flash') {
    // the target strobes gold/gray rapidly, then settles to gray as
    // shuffling begins — a fast on/off flicker driven off sim time, not CSS.
    const t = w.balls[w.target];
    t.glow = Math.floor(e / 0.04) % 2 === 0 ? 1 : 0;
    if (e > T_FLASH) {
      t.glow = 0;
      w.phase = 'shuffle'; w.phaseAt = w.time;
      for (const b of w.balls) {
        const a = rnd() * Math.PI * 2;
        const sp = SPEED_MIN + rnd() * (SPEED_MAX - SPEED_MIN);
        b.speed = sp;   // pinned for the whole shuffle — see physicsStep()
        b.vx = Math.cos(a) * sp; b.vy = Math.sin(a) * sp;
      }
    }
  } else if (w.phase === 'shuffle') {
    const sub = 4, sdt = dt / sub;
    for (let k = 0; k < sub; k++) physicsStep(sdt);
    w.arenaRot += dt * 0.35;   // slow clockwise spin — visual only, physics stays in the fixed frame
    if (e > curPlan.shuffleSec) {
      w.phase = 'freeze'; w.phaseAt = w.time;
      for (const b of w.balls) { b.vx = 0; b.vy = 0; }
      // number left-to-right AT THE FREEZE INSTANT — never a persistent
      // identity, so nothing leaks during the shuffle.
      const byX = w.balls.slice().sort((a, b) => a.x - b.x);
      byX.forEach((b, i) => (b.num = i + 1));
      w.answer = w.balls[w.target].num;
      Sound.freeze();
    }
  } else if (w.phase === 'freeze') {
    // holds here until either the fixed timer elapses (always, in a headless
    // render — there's no human to click anything) or the studio's manual
    // "Reveal Now" override fires (preview-only, see ET.revealNow()).
    if (w.manualReveal || e > T_HOLD_ASK) {
      w.phase = 'reveal'; w.phaseAt = w.time;
      const t = w.balls[w.target];
      spark(t.x, t.y, COL_GOLD, 44);
      spark(t.x, t.y, '#ffffff', 16);
      Sound.lock(); Sound.reveal();
    }
  } else if (w.phase === 'reveal') {
    w.balls[w.target].glow = Math.min(1, e / 0.22);
    if (e > T_HOLD_REVEAL) {
      w.results.push({ round: w.round, answer: w.answer });
      if (w.round < w.totalRounds) {
        // next round — fresh layout/target for its own ball count, same
        // continuous seeded stream (never re-seeded mid-clip).
        w.round += 1;
        const n = curPlan.balls[w.round - 1];
        w.balls = placeBalls(n, BALL_R);
        w.target = rint(0, n - 1);
        w.answer = 0; w.arenaRot = 0; w.manualReveal = false;
        w.phase = 'lockin'; w.phaseAt = w.time;
      } else {
        w.phase = 'scorecard'; w.phaseAt = w.time;
        Sound.finish();
      }
    }
  } else if (w.phase === 'scorecard') {
    if (e > T_SCORECARD) { w.phase = 'done'; w.phaseAt = w.time; }
  }
  // 'done' phase: the render's ET.step() decides when to stop

  for (const s of w.sparks) { s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 700 * dt; s.life -= dt * 2.0; }
  w.sparks = w.sparks.filter((s) => s.life > 0);
}

/* paint the current sim state — canvas + DOM HUD. No state change, no seeded RNG. */
function paint() {
  draw();
  hud(false);
}

/* ═══════════════ draw ═══════════════ */
function glowRing(x, y, r, alpha, col) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  const rg = ctx.createRadialGradient(x, y, 0, x, y, r * 2.4);
  rg.addColorStop(0, col + 'e6'); rg.addColorStop(1, col + '00');
  ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(x, y, r * 2.4, 0, 6.283); ctx.fill();
  ctx.restore();
}

function draw() {
  const w = G;
  const S = cv.width / W;
  ctx.setTransform(S, 0, 0, S, 0, 0);
  ctx.fillStyle = COL_BG; ctx.fillRect(0, 0, W, H);

  // the arena + balls + numbers rotate together as one rigid frame (visual
  // disorientation only — physics always runs in the fixed, unrotated
  // coordinate space above). The HUD text is DOM, so it never rotates.
  // Applied unconditionally (not just during 'shuffle') so freeze/reveal hold
  // the exact angle the shuffle ended on — w.arenaRot itself is what does the
  // gating (0 through lockin/flash, incrementing through shuffle, frozen from
  // there until the next round resets it to 0). Gating on phase here too was
  // the bug: 'reveal' was left out, so the view snapped back to angle 0 for
  // one frame right as the target flashed gold — read as "the balls jump" at
  // the exact moment everything's supposed to be perfectly still.
  ctx.save();
  ctx.translate(ARENA_CX, ARENA_CY);
  ctx.rotate(w.arenaRot);
  ctx.translate(-ARENA_CX, -ARENA_CY);

  // arena — glowing neon cyber-blue ring
  ctx.save();
  ctx.strokeStyle = COL_ARENA; ctx.lineWidth = 5;
  ctx.shadowColor = COL_ARENA; ctx.shadowBlur = 26;
  ctx.beginPath(); ctx.arc(ARENA_CX, ARENA_CY, ARENA_R, 0, 6.283); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.25; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(ARENA_CX, ARENA_CY, ARENA_R - 14, 0, 6.283); ctx.stroke();
  ctx.restore();

  // balls
  for (const b of w.balls) {
    if (b.glow > 0.02) glowRing(b.x, b.y, b.r, b.glow * 0.55, COL_GOLD);
    ctx.save();
    ctx.fillStyle = b.glow > 0.02 ? COL_GOLD : COL_GRAY;
    if (b.glow > 0.02) { ctx.shadowColor = COL_GOLD; ctx.shadowBlur = 22 * b.glow; }
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 6.283); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 2; ctx.stroke();
    // a soft specular highlight so identical spheres still read as spheres
    ctx.globalAlpha = 0.35; ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(b.x - b.r * 0.32, b.y - b.r * 0.35, b.r * 0.28, 0, 6.283); ctx.fill();
    ctx.restore();

    if ((w.phase === 'freeze' || w.phase === 'reveal' || w.phase === 'scorecard' || w.phase === 'done') && b.num) {
      // counter-rotate just the glyph so the digit always reads upright —
      // the ball itself stays wherever the arena's spin left it, but a
      // sideways/upside-down number is illegible right when the viewer most
      // needs to read it (comment your guess).
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(-w.arenaRot);
      ctx.font = '800 ' + Math.round(b.r * 1.05) + 'px "Chakra Petch", system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 6;
      ctx.fillText(String(b.num), 0, b.r * 0.02);
      ctx.restore();
    }
  }

  for (const s of w.sparks) {
    ctx.globalAlpha = Math.max(0, s.life); ctx.fillStyle = s.c;
    const sz = 6 * s.life + 2;
    ctx.fillRect(s.x - sz / 2, s.y - sz / 2, sz, sz);
  }
  ctx.globalAlpha = 1;
  ctx.restore();   // undo the arena rotation before the vignette (screen-space)

  drawVignette();
}

function drawVignette() {
  const vg = ctx.createRadialGradient(W / 2, H / 2, 640, W / 2, H / 2, 1280);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.5)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
}

/* ═══════════════ HUD ═══════════════ */
// reproduces a CSS pop (scale .55 -> 1.1 at 62% -> 1.0, opacity 0 -> 1 by
// 62%) off sim time — deterministic under frame-stepping, same pattern as
// every other content type's popStyle().
function popStyle(t0, dur) {
  const p = Math.min(1, Math.max(0, (G.time - t0) / dur));
  const eo = 1 - Math.pow(1 - p, 2);
  const s = eo < 0.62 ? 0.55 + 0.55 * (eo / 0.62) : 1.1 - 0.1 * ((eo - 0.62) / 0.38);
  return { t: 'scale(' + s.toFixed(4) + ')', o: String(Math.min(1, eo / 0.62)) };
}

let hudT = -9;
function hud(force) {
  const w = G;
  if (!force && !RENDER && w.time - hudT < 0.08) return;
  hudT = w.time;

  const inScore = w.phase === 'scorecard' || w.phase === 'done';

  const pill = el('roundPill');
  if (!inScore && w.totalRounds > 1) {
    pill.style.display = 'block';
    pill.textContent = 'ROUND ' + w.round + ' / ' + w.totalRounds;
  } else {
    pill.style.display = 'none';
  }

  const big = w.phase === 'lockin' || w.phase === 'flash' ? 'DYNAMIC VISION TEST: FOCUS ON THE GOLD BALL'
    : w.phase === 'shuffle' ? "DON'T BLINK! TRACK THE TARGET"
    : w.phase === 'freeze' ? 'WHICH NUMBER IS THE TARGET? LOCK IN YOUR GUESS IN THE COMMENTS'
    : w.phase === 'reveal' ? 'THE TARGET WAS BALL #' + w.answer
    : null;
  const bigEl = el('big'), labelEl = el('bigLabel');
  if (inScore || big === null) {
    bigEl.style.display = 'none';
  } else {
    // key on round+text (not just text) so the pop-in replays every round
    // even though most rounds repeat the same phase copy verbatim.
    const bigKeyFull = w.round + '|' + big;
    if (bigKeyFull !== w.bigKey) { w.bigKey = bigKeyFull; w.bigAt = w.time; }
    bigEl.style.display = 'flex';
    labelEl.textContent = big;
    labelEl.style.color = w.phase === 'reveal' ? '#ffd700' : '#ffffff';
    const pp = popStyle(w.bigAt, 0.28);
    labelEl.style.transform = pp.t; labelEl.style.opacity = pp.o;
  }

  const cd = el('countdown');
  if (w.phase === 'lockin') {
    const left = Math.max(1, Math.ceil(T_LOCKIN - (w.time - w.phaseAt)));
    if (String(left) !== w.cdKey) { w.cdKey = String(left); w.cdAt = w.time; }
    cd.textContent = String(left);
    cd.style.display = 'flex';
    const pp = popStyle(w.cdAt, 0.22);
    cd.style.transform = pp.t; cd.style.opacity = pp.o;
  } else {
    cd.style.display = 'none';
  }

  const scoreCard = el('scoreCard');
  if (inScore) {
    scoreCard.style.display = 'flex';
    if (!w.scoreBuilt) {
      w.scoreBuilt = true;
      el('scoreList').innerHTML = w.results.map((r) =>
        '<div class="scoreRow"><span class="sr">Round ' + r.round + '</span><span class="sc">' + r.answer + '</span></div>'
      ).join('');
      el('scoreTitle').innerHTML = w.results.length > 1 ? 'YOUR RESULTS' : 'THE RESULT';
    }
  } else {
    scoreCard.style.display = 'none';
  }
}

/* ═══════════════ loop / render API ═══════════════ */
const DT = 1 / FPS;

let raf = 0, acc = 0, prevT = 0, speed = 1, autoReplay = false;
const randSeed = () => ((Math.random() * 0x7fffffff) >>> 0) || 1;

function startRound(seed, plan) {
  reset(seed, plan);
  acc = 0; prevT = 0;
}

function tick(now) {
  raf = requestAnimationFrame(tick);
  if (!prevT) prevT = now;
  acc += Math.min(0.25, (now - prevT) / 1000) * speed;
  prevT = now;
  let guard = 0;
  while (acc >= DT && guard++ < 800) { ET.frame += 1; advance(DT); acc -= DT; }
  if (G.phase === 'done' && G.time - G.phaseAt > 1.0 && autoReplay) {
    startRound(randSeed(), curPlan);
  }
  paint();
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

function boot() {
  Sound = RENDER ? makeSoundRecorder() : liveSound();
  resize();
  reset();
}

if (RENDER) {
  ET.step = () => {
    ET.frame += 1;
    advance(DT);
    paint();
    const events = Sound._drain();
    let done = false;
    if (G.phase === 'done' && G.time - G.phaseAt >= 1.0) done = true;
    if (ET.frame >= ET._hardCap) done = true;
    ET.done = done;
    return { frame: ET.frame, events, done };
  };
  ET.result = () => {
    const w = G;
    return {
      seed: curSeed,
      rounds: w.totalRounds,
      ballsPerRound: curPlan.balls.slice(),
      shuffleSec: curPlan.shuffleSec,
      answers: w.results.map((r) => r.answer),   // 1-indexed correct ball number, per round
      durationSec: +(ET.frame / FPS).toFixed(2),
      frames: ET.frame, fps: FPS,
    };
  };
  (async () => {
    try { if (document.fonts) { document.fonts.load('800 60px "Chakra Petch"'); await document.fonts.ready; } } catch (e) {}
    boot();
    const capSec = CAP_SEC || Math.ceil(estimateDurationSec(curPlan) + 3);
    ET._hardCap = Math.round(capSec * FPS);
    ET.meta = { fps: FPS, totalFrames: ET._hardCap, seed: curSeed, width: W, height: H };
  })();
} else {
  /* ── preview studio API (window.ET.*) ── */
  boot();
  ET.replay = (seed) => startRound(seed === undefined || seed === null || seed === '' ? randSeed() : (Number(seed) >>> 0) || 1, curPlan);
  ET.again = () => startRound(curSeed, curPlan);
  ET.setPlan = (ballsArr, shuffleSec) => {
    const balls = parseBallsParam(Array.isArray(ballsArr) ? ballsArr.join(',') : ballsArr);
    startRound(randSeed(), { balls, shuffleSec: clampShuffle(shuffleSec) });
  };
  ET.setSpeed = (s) => { speed = [0.5, 1, 2, 4].includes(+s) ? +s : 1; };
  ET.setAutoReplay = (on) => { autoReplay = !!on; };
  ET.setSound = (on) => { if (Sound.setEnabled) Sound.setEnabled(!!on); };
  ET.getSeed = () => curSeed;
  ET.getPlan = () => ({ balls: curPlan.balls.slice(), shuffleSec: curPlan.shuffleSec });
  // manual "Reveal Answer" override for the studio panel (SPEC §3) — lets a
  // creator screen-recording live jump straight to the reveal instead of
  // waiting out the fixed hold. Never used by the deterministic render path.
  ET.revealNow = () => { if (G.phase === 'freeze') G.manualReveal = true; };
  ET.readout = () => {
    const w = G;
    return {
      seed: curSeed, rounds: w.totalRounds, ballsPerRound: curPlan.balls.slice(), shuffleSec: curPlan.shuffleSec,
      round: w.round, phase: w.phase,
      answers: w.results.map((r) => r.answer),
      done: w.phase === 'done',
      roundSec: +Math.max(0, w.time).toFixed(2),
    };
  };
  ET._tick = tick;   // exposed so a headless harness can pump the accumulator with fake timestamps
  raf = requestAnimationFrame(tick);
  el('stage').addEventListener('pointerdown', () => Sound.ensure && Sound.ensure(), { once: true });
}

window.EyeTest = { restart: boot, get world() { return G; }, seed: () => curSeed };
window.ET = ET;

})();

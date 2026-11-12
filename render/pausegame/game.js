"use strict";
(function () {
/* ═══════════════════════════════════════════════════════════════
   PAUSE GAME — "Screenshot / Pause Game" challenge.

   A single neon needle sweeps clockwise around a dial, continuously, at a
   fixed speed, forever. A thin green win-margin sits fixed at 12 o'clock.
   The needle's own color is the whole feedback mechanism — it glows its
   accent color everywhere EXCEPT the instant it's inside the win zone,
   where it snaps to green. There's no tap/pause/button logic baked into the
   clip itself: the viewer uses TikTok's OWN native pause control on the
   posted video, and whatever color the needle happens to be frozen on tells
   them instantly whether they caught it.

   Physics has zero randomness (pure time -> angle), so the only thing a
   seed decides is which neon accent color this render uses — every post
   looks like a different video by palette alone, never by difficulty
   drifting around. The rotation is engineered to land EXACTLY back at frame
   0's angle after `laps` full rotations, so the clip loops seamlessly on
   TikTok's native replay with no visible seam.

   Render plumbing (invisible, same contract as every other content type):
   PG.step/meta/result frame API. Web-Audio calls become an event log
   python/pausegame_audio.py resynthesises offline (one soft chime each time
   the needle enters the zone).
   ═══════════════════════════════════════════════════════════════ */

const QS = new URLSearchParams(location.search);
const RENDER = QS.get('render') === '1';
const SEED = (parseInt(QS.get('seed') || '1', 10) >>> 0) || 1;
const FPS = Math.max(20, Math.min(60, parseInt(QS.get('fps') || '60', 10)));
const W = 1080, H = 1920;
const SS = Math.max(1, Math.min(4, parseFloat(QS.get('ss') || '2')));

const clampTarget = (n) => Math.max(5, Math.min(30, Math.round(Number(n)) || 10));
const clampRotation = (n) => Math.max(600, Math.min(2500, Math.round(Number(n)) || 1100));
const clampLaps = (n) => Math.max(4, Math.min(20, Math.round(Number(n)) || 10));

let curSeed = SEED;
let curParams = {
  targetDeg: clampTarget(QS.get('target') || 9),
  rotationMs: clampRotation(QS.get('rotation') || 1100),
  laps: clampLaps(QS.get('laps') || 10),
};

// a different neon accent per seed -- the needle's OFF-zone color; it always
// snaps to green while inside the win margin regardless of which accent won.
const PALETTE = ['#ffcc33', '#00e5ff', '#ff2d95', '#ff7a00', '#b026ff', '#2f7dff', '#ff3ea5', '#c6ff00'];
const GREEN = '#00ff66';

const cv = document.getElementById('c');
const ctx = cv.getContext('2d');

const PG = { frame: 0, done: false, meta: null, _hardCap: 999999 };

/* ═══════════════ world ═══════════════ */
let G = null, Sound = null;

function reset(seed, params) {
  if (params) curParams = params;
  if (seed !== undefined) curSeed = seed >>> 0;
  PG.frame = 0; PG.done = false;
  G = {
    elapsedMs: 0,
    accent: PALETTE[curSeed % PALETTE.length],
    wasInZone: false,
    lap: 1,
  };
}

function relativeToTop(angleDeg) {
  const a = ((angleDeg % 360) + 360) % 360;
  return a > 180 ? a - 360 : a; // -180..180, 0 = top (12 o'clock)
}
function currentAngleDeg() {
  return (G.elapsedMs * 360 / curParams.rotationMs) % 360;
}
function isInZone(angleDeg) {
  return Math.abs(relativeToTop(angleDeg)) <= curParams.targetDeg / 2;
}

/* ═══════════════ audio — event recorder in render mode ═══════════════ */
function makeSoundRecorder() {
  let buf = [];
  const push = (o) => { o.f = PG.frame; buf.push(o); };
  return {
    _drain() { const b = buf; buf = []; return b; },
    zoneEnter() { push({ type: 'zone-enter' }); },
  };
}

function liveSound() {
  let ac, master, muted = true;
  const ensure = () => {
    if (!ac) {
      const A = window.AudioContext || window.webkitAudioContext; if (!A) return;
      ac = new A();
      master = ac.createGain(); master.gain.value = muted ? 0 : 0.3; master.connect(ac.destination);
    }
    if (ac && ac.state === 'suspended') ac.resume();
  };
  const env = (node, at, peak, atk, dec) => {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(peak, at + atk);
    g.gain.exponentialRampToValueAtTime(0.0008, at + atk + dec);
    g.gain.linearRampToValueAtTime(0, at + atk + dec + 0.02);
    node.connect(g); g.connect(master);
    return at + atk + dec + 0.04;
  };
  return {
    _drain() { return []; },
    ensure,
    setEnabled(on) { muted = !on; if (on) ensure(); if (ac) master.gain.value = muted ? 0 : 0.3; },
    zoneEnter() {
      ensure(); if (!ac || muted) return;
      const now = ac.currentTime;
      [0, 7].forEach((st, k) => {
        const t0 = now + k * 0.03;
        const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = 660 * Math.pow(2, st / 12);
        const end = env(o, t0, 0.18, 0.006, 0.14);
        o.start(t0); o.stop(end);
      });
    },
  };
}

/* ═══════════════ advance one frame ═══════════════ */
function advance(dtMs) {
  const w = G;
  w.elapsedMs += dtMs;
  const angleDeg = currentAngleDeg();
  const inZone = isInZone(angleDeg);
  if (inZone && !w.wasInZone) Sound.zoneEnter();
  w.wasInZone = inZone;
  w.lap = Math.min(curParams.laps, Math.floor(w.elapsedMs / curParams.rotationMs) + 1);
}

/* ═══════════════ draw ═══════════════ */
const DIAL_CX = W / 2, DIAL_CY = 950, DIAL_R = 380;

function draw() {
  const S = cv.width / W;
  ctx.setTransform(S, 0, 0, S, 0, 0);
  ctx.fillStyle = '#0a0b0f'; ctx.fillRect(0, 0, W, H);

  // faint crosshair guide
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, DIAL_CY); ctx.lineTo(W, DIAL_CY);
  ctx.moveTo(DIAL_CX, 0); ctx.lineTo(DIAL_CX, H);
  ctx.stroke();
  ctx.restore();

  // outer dashed boundary
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 3;
  ctx.setLineDash([9, 15]);
  ctx.beginPath(); ctx.arc(DIAL_CX, DIAL_CY, DIAL_R * 1.16, 0, 6.283); ctx.stroke();
  ctx.restore();

  // solid track ring
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.13)'; ctx.lineWidth = 34;
  ctx.beginPath(); ctx.arc(DIAL_CX, DIAL_CY, DIAL_R, 0, 6.283); ctx.stroke();
  ctx.restore();

  // target pin, teardrop shape, centred at 12 o'clock
  const pinY = DIAL_CY - DIAL_R - 32;
  ctx.save();
  ctx.fillStyle = GREEN; ctx.shadowColor = GREEN; ctx.shadowBlur = 24;
  ctx.beginPath(); ctx.arc(DIAL_CX, pinY, 20, 0, 6.283); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(DIAL_CX - 15, pinY + 5);
  ctx.quadraticCurveTo(DIAL_CX, pinY + 46, DIAL_CX + 15, pinY + 5);
  ctx.closePath(); ctx.fill();
  ctx.restore();

  // thin win-margin arc riding the track, under the pin
  const halfW = (curParams.targetDeg / 2) * Math.PI / 180;
  const top = -Math.PI / 2;
  ctx.save();
  ctx.strokeStyle = 'rgba(0,255,102,.55)'; ctx.lineWidth = 13;
  ctx.beginPath(); ctx.arc(DIAL_CX, DIAL_CY, DIAL_R, top - halfW, top + halfW); ctx.stroke();
  ctx.restore();

  // needle: line + ring-outline tip + center dot -- snaps to green in-zone
  const angleDeg = currentAngleDeg();
  const inZone = isInZone(angleDeg);
  const needleColor = inZone ? GREEN : G.accent;
  const theta = (angleDeg - 90) * Math.PI / 180;
  const nx = DIAL_CX + Math.cos(theta) * DIAL_R;
  const ny = DIAL_CY + Math.sin(theta) * DIAL_R;

  ctx.save();
  ctx.strokeStyle = needleColor; ctx.shadowColor = needleColor;
  ctx.shadowBlur = inZone ? 32 : 18;
  ctx.lineWidth = 8; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(DIAL_CX, DIAL_CY); ctx.lineTo(nx, ny); ctx.stroke();
  ctx.lineWidth = 13;
  ctx.beginPath(); ctx.arc(nx, ny, 22, 0, 6.283); ctx.stroke();
  ctx.restore();

  // center hub
  ctx.save();
  ctx.fillStyle = needleColor; ctx.shadowColor = needleColor; ctx.shadowBlur = inZone ? 24 : 12;
  ctx.beginPath(); ctx.arc(DIAL_CX, DIAL_CY, 19, 0, 6.283); ctx.fill();
  ctx.restore();
}

/* ═══════════════ loop / render API ═══════════════ */
const DT = 1000 / FPS;

let raf = 0, acc = 0, prevT = 0, speed = 1;
const randSeed = () => ((Math.random() * 0x7fffffff) >>> 0) || 1;

function startRound(seed, params) {
  reset(seed, params);
  acc = 0; prevT = 0;
}

function tick(now) {
  raf = requestAnimationFrame(tick);
  if (!prevT) prevT = now;
  acc += Math.min(250, (now - prevT)) * speed;
  prevT = now;
  let guard = 0;
  while (acc >= DT && guard++ < 800) { advance(DT); acc -= DT; }
  draw();
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
  reset(curSeed, curParams);
}

if (RENDER) {
  PG.step = () => {
    PG.frame += 1;
    advance(DT);
    draw();
    const events = Sound._drain();
    const done = PG.frame >= PG._hardCap;
    PG.done = done;
    return { frame: PG.frame, events, done };
  };
  PG.result = () => ({
    seed: curSeed,
    targetDeg: curParams.targetDeg,
    rotationMs: curParams.rotationMs,
    laps: curParams.laps,
    durationSec: +(PG.frame / FPS).toFixed(2),
    frames: PG.frame, fps: FPS,
  });
  (async () => {
    // wait for the DOM text overlays' custom font before signalling ready --
    // render.mjs waits for PG.meta before capturing frame 1, so this keeps
    // the badge/title/caption from briefly showing a fallback font early on.
    try { if (document.fonts) { document.fonts.load('700 60px "Chakra Petch"'); await document.fonts.ready; } } catch (e) {}
    boot();
    const totalSec = curParams.laps * curParams.rotationMs / 1000;
    PG._hardCap = Math.max(1, Math.round(totalSec * FPS));
    PG.meta = { fps: FPS, totalFrames: PG._hardCap, seed: curSeed, width: W, height: H };
  })();
} else {
  /* ── preview studio API (window.PG.*) ── */
  boot();
  PG.replay = (seed) => startRound(seed === undefined || seed === null || seed === '' ? randSeed() : (Number(seed) >>> 0) || 1, curParams);
  PG.again = () => startRound(curSeed, curParams);
  PG.setParams = (targetDeg, rotationMs, laps) => {
    startRound(curSeed, { targetDeg: clampTarget(targetDeg), rotationMs: clampRotation(rotationMs), laps: clampLaps(laps) });
  };
  PG.setSpeed = (s) => { speed = [0.5, 1, 2, 4].includes(+s) ? +s : 1; };
  PG.setSound = (on) => { if (Sound.setEnabled) Sound.setEnabled(!!on); };
  PG.getSeed = () => curSeed;
  PG.getParams = () => ({ ...curParams });
  PG.readout = () => ({
    seed: curSeed, ...curParams,
    lap: G.lap,
    elapsedSec: +(G.elapsedMs / 1000).toFixed(2),
    inZone: G.wasInZone,
  });
  raf = requestAnimationFrame(tick);
  document.getElementById('stage').addEventListener('pointerdown', () => Sound.ensure && Sound.ensure(), { once: true });
}

window.PauseGame = { restart: boot, get world() { return G; }, seed: () => curSeed };
window.PG = PG;

})();

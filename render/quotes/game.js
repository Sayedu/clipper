"use strict";
(function(){

/* ═══════════════════════════════════════════════════════════════
   REMINDERS — a silent, 15-second "hits hard" quote card. A short
   setup line settles in, a beat of pause, then a punch line lands with
   a soft flash — the visual stand-in for the hit a sound cue would
   normally give, since this content type is intentionally silent.

   Deterministic from ?seed like every other content type in the app:
   the seed picks which line from quotes.js runs AND the exact drift of
   every background particle, so a given seed always renders pixel
   identical. Runs headlessly frame-by-frame when loaded with ?render=1
   (window.QT exposes meta / step() / result() for the renderer) or
   live in a browser otherwise.
   ═══════════════════════════════════════════════════════════════ */

const QS = new URLSearchParams(location.search);
const RENDER = QS.get('render') === '1';
const EMBED = QS.get('embed') === '1';
const SEED_PARAM = (parseInt(QS.get('seed') || '1', 10) >>> 0) || 1;
const FPS = Math.max(20, Math.min(60, parseInt(QS.get('fps') || '30', 10)));
const W = Math.max(320, parseInt(QS.get('w') || '1080', 10));
const H = Math.max(320, parseInt(QS.get('h') || '1920', 10));
const SS = Math.max(1, Math.min(4, parseFloat(QS.get('ss') || '3')));
// exactly 15s by default — clamp is generous only so a dev can nudge it locally.
const DURATION = Math.max(10, Math.min(20, parseFloat(QS.get('sec') || '15')));

const cv = document.getElementById('c');
const ctx = cv.getContext('2d', { alpha:false });

/* ── deterministic RNG (mulberry32) — same algorithm as every other
     content type, so "seeded-deterministic" means the same thing everywhere. */
let _s = 0;
const srand = s => { _s = s >>> 0; };
function rnd(){
  _s = _s + 0x6D2B79F5 | 0;
  let t = Math.imul(_s ^ _s >>> 15, 1 | _s);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}
const rr = (a,b) => a + rnd()*(b-a);

/* ── a SEPARATE stream for purely cosmetic randomness (particle drift, the
   noise texture). Kept apart from rnd() above so tuning the background's
   pixel count or particle count never reshuffles which quote a given seed
   picks — the same "visual RNG stays decoupled from content RNG" split
   Laser Nations uses for its screen-shake stream. ── */
let _vs = 0;
function vrnd(){
  _vs = _vs + 0x6D2B79F5 | 0;
  let t = Math.imul(_vs ^ _vs >>> 15, 1 | _vs);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}
const vrr = (a,b) => a + vrnd()*(b-a);
const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
const easeOutCubic = x => 1 - Math.pow(1-x, 3);
const easeOutBack = x => { const c1=1.70158, c3=c1+1; return 1 + c3*Math.pow(x-1,3) + c1*Math.pow(x-1,2); };
const lerp = (a,b,t) => a + (b-a)*t;

let SEED = 0;
function pickSeed(){
  return RENDER ? SEED_PARAM
    : (() => { try { return (parseInt(new URLSearchParams(location.search).get('seed')||'',10) >>> 0) || ((Date.now() ^ (Math.random()*1e9)) >>> 0); } catch(e){ return (Date.now() >>> 0); } })();
}

/* ── canvas backing store — logical W×H, backed at Q× so it's pixel-1:1
     with whatever the renderer (or the device) captures. ── */
let Q = 1;
function resize(){
  Q = RENDER ? SS : Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  cv.width = Math.round(W*Q);
  cv.height = Math.round(H*Q);
  ctx.imageSmoothingQuality = 'high';
}
resize();
window.addEventListener('resize', () => { if(!RENDER) resize(); });

/* ═══ text layout — wraps a string to a max width at a given font, then
   hands back per-word geometry so the reveal animation can stagger by
   word in natural reading order regardless of how many lines it wrapped
   to. Computed once per quote (not per frame) since it never changes. ═══ */
function layoutWords(text, fontWeight, fontPx, maxWidth, lineHeight){
  ctx.font = `${fontWeight} ${fontPx}px Montserrat, sans-serif`;
  const words = text.split(' ');
  const lines = [];
  let cur = [];
  let curW = 0;
  const spaceW = ctx.measureText(' ').width;
  for(const w of words){
    const ww = ctx.measureText(w).width;
    if(cur.length && curW + spaceW + ww > maxWidth){ lines.push(cur); cur = []; curW = 0; }
    cur.push({ text:w, w:ww });
    curW += (curW ? spaceW : 0) + ww;
  }
  if(cur.length) lines.push(cur);

  const laidLines = lines.map((line, li) => {
    const totalW = line.reduce((s,w)=>s+w.w,0) + spaceW*(line.length-1);
    let x = -totalW/2;
    const laidWords = line.map(w => {
      const o = { text:w.text, x, w:w.w };
      x += w.w + spaceW;
      return o;
    });
    return { words: laidWords, y: li*fontPx*lineHeight };
  });
  return { lines: laidLines, fontWeight, fontPx, height: lines.length*fontPx*lineHeight, wordCount: words.length };
}

/* draws a laid-out block, word by word revealing in reading order starting
   at `start`, each word fading + rising over `dur` seconds, `stagger`
   seconds apart. `cx,cy` is the block's centered anchor. */
function drawRevealBlock(layout, cx, cy, start, t, stagger, dur, rise, color, glow, glowBlur){
  ctx.font = `${layout.fontWeight} ${layout.fontPx}px Montserrat, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  let wi = 0;
  const top = cy - layout.height/2 + layout.fontPx*0.38;
  for(const line of layout.lines){
    for(const w of line.words){
      const wStart = start + wi*stagger;
      const p = easeOutCubic(clamp01((t - wStart)/dur));
      if(p > 0){
        ctx.save();
        ctx.globalAlpha = p;
        ctx.fillStyle = color;
        ctx.shadowColor = glow; ctx.shadowBlur = glowBlur;
        ctx.fillText(w.text, cx + w.x, top + line.y + (1-p)*rise);
        ctx.restore();
      }
      wi++;
    }
  }
}

/* ═══ background — a gloomy overcast nature scene: a cold, heavy sky, slow
   drifting cloud masses, a distant bare-tree treeline, ground fog, and
   wind-angled rain. All seeded so a given seed reproduces the exact same
   drift, frame for frame. The treeline sits low (H*0.84+) so it never
   competes with the text block above it. ═══ */
let bg;
function buildBackground(){
  // heavy, slow drifting overcast cloud masses, several depths for parallax.
  const clouds = [];
  const CLOUD_N = 5;
  for(let i=0;i<CLOUD_N;i++){
    const rx = W*vrr(0.4,0.65);
    clouds.push({
      y: H*vrr(0.06,0.5), rx, ry: H*vrr(0.045,0.085),
      x0: vrr(0,W), speed: vrr(5,13)*(i%2?1:-1),
      a: vrr(0.22,0.4),
    });
  }
  // thin high fog wisps — faster and paler than the clouds, pure atmosphere.
  const wisps = [];
  const WISP_N = 4;
  for(let i=0;i<WISP_N;i++){
    const rx = W*vrr(0.55,0.95);
    wisps.push({
      y: H*vrr(0.15,0.72), rx, ry: H*vrr(0.018,0.034),
      x0: vrr(0,W), speed: vrr(14,24)*(i%2?1:-1),
      a: vrr(0.05,0.1),
    });
  }
  // rain — thin wind-angled streaks, looping top to bottom.
  const rain = [];
  const RAIN_N = 70;
  for(let i=0;i<RAIN_N;i++){
    rain.push({
      x: vrr(-80,W+80), y0: vrr(0,H), len: vrr(34,74),
      speed: vrr(950,1500), a: vrr(0.05,0.15),
    });
  }
  // distant treeline — a jagged horizon ridge with a handful of bare,
  // leafless trees breaking the skyline.
  const baseline = H*0.84;
  const RIDGE_N = 26;
  const ridge = [];
  for(let i=0;i<=RIDGE_N;i++){
    ridge.push({ x: (i/RIDGE_N)*W, y: baseline - vrr(0,H*0.022) - Math.sin(i*1.7)*H*0.01 });
  }
  const trees = [];
  const TREE_N = 9;
  for(let i=0;i<TREE_N;i++){
    const x = vrr(0.04,0.96)*W;
    const seg = Math.min(RIDGE_N-1, Math.floor((x/W)*RIDGE_N));
    trees.push({ x, baseY: ridge[seg].y, h: vrr(H*0.028,H*0.085), lean: vrr(-0.1,0.1), branches: Math.floor(vrr(2,4)) });
  }

  // seeded dither noise, one texel per output pixel (NOT stretched — a small
  // tile upscaled turns into visible blotches instead of fine grain), drawn
  // once and reused every frame.
  const noise = document.createElement('canvas');
  noise.width = W; noise.height = H;
  const nctx = noise.getContext('2d');
  const id = nctx.createImageData(W,H);
  for(let i=0;i<id.data.length;i+=4){ const v = Math.floor(vrr(0,255)); id.data[i]=id.data[i+1]=id.data[i+2]=v; id.data[i+3]=255; }
  nctx.putImageData(id,0,0);

  return { clouds, wisps, rain, ridge, trees, baseline, noise };
}

/** a soft, squashed glow — the shared shape behind clouds/fog wisps. */
function drawSoftBlob(cx, cy, rx, ry, rgb, a){
  const g = ctx.createRadialGradient(cx,cy,0, cx,cy,rx);
  g.addColorStop(0, `rgba(${rgb},${a})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.save();
  ctx.translate(cx,cy); ctx.scale(1, ry/rx); ctx.translate(-cx,-cy);
  ctx.fillRect(cx-rx, cy-rx, rx*2, rx*2);
  ctx.restore();
}

function drawBackground(t){
  // overcast sky — cold, desaturated slate at the top easing into a faintly
  // sickly gray-green horizon. No sun, no warmth: a heavy, lightless sky.
  const sky = ctx.createLinearGradient(0,0,0,H);
  sky.addColorStop(0,    '#22262a');
  sky.addColorStop(0.55, '#323a3c');
  sky.addColorStop(0.84, '#434d47');
  sky.addColorStop(1,    '#3b443e');
  ctx.fillStyle = sky; ctx.fillRect(0,0,W,H);

  // thick, slow-drifting cloud masses — blurred as a group so each reads as
  // heavy overcast rather than a cartoon puff.
  ctx.save();
  ctx.filter = 'blur(55px)';
  for(const c of bg.clouds){
    const span = W + c.rx*2;
    const x = ((c.x0 + t*c.speed) % span + span) % span - c.rx;
    drawSoftBlob(x, c.y, c.rx, c.ry, '16,18,19', c.a);
  }
  ctx.restore();

  // thin high fog wisps
  ctx.save();
  ctx.filter = 'blur(38px)';
  for(const w of bg.wisps){
    const span = W + w.rx*2;
    const x = ((w.x0 + t*w.speed) % span + span) % span - w.rx;
    drawSoftBlob(x, w.y, w.rx, w.ry, '198,204,201', w.a);
  }
  ctx.restore();

  // distant treeline — near-black silhouette, low enough it never collides
  // with the text block above it.
  ctx.save();
  ctx.fillStyle = '#121513';
  ctx.beginPath();
  ctx.moveTo(0, H);
  for(const p of bg.ridge) ctx.lineTo(p.x, p.y);
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fill();

  // a handful of bare, leafless trees poking above the ridge
  ctx.strokeStyle = '#121513';
  ctx.lineCap = 'round';
  for(const tr of bg.trees){
    ctx.save();
    ctx.translate(tr.x, tr.baseY);
    ctx.rotate(tr.lean);
    ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(0,-tr.h); ctx.stroke();
    ctx.lineWidth = 1.4;
    for(let b=0;b<tr.branches;b++){
      const by = -tr.h*(0.42+b*0.17), dir = b%2 ? 1 : -1;
      ctx.beginPath(); ctx.moveTo(0,by); ctx.lineTo(dir*tr.h*0.24, by-tr.h*0.15); ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();

  // ground fog — a soft pale band hugging the base of the treeline.
  const gfog = ctx.createLinearGradient(0, bg.baseline-H*0.05, 0, bg.baseline+H*0.05);
  gfog.addColorStop(0,   'rgba(178,183,180,0)');
  gfog.addColorStop(0.5, 'rgba(178,183,180,0.16)');
  gfog.addColorStop(1,   'rgba(178,183,180,0)');
  ctx.fillStyle = gfog; ctx.fillRect(0, bg.baseline-H*0.05, W, H*0.1);

  // rain — a sheared field of short vertical streaks reads as wind-angled rain.
  ctx.save();
  ctx.transform(1,0, -0.16,1, 0,0);
  ctx.strokeStyle = 'rgba(200,208,210,1)';
  ctx.lineWidth = 1.3;
  for(const r of bg.rain){
    const span = H + r.len;
    const y = ((r.y0 + t*r.speed) % span + span) % span - r.len;
    ctx.globalAlpha = r.a;
    ctx.beginPath(); ctx.moveTo(r.x,y); ctx.lineTo(r.x, y+r.len); ctx.stroke();
  }
  ctx.restore();

  // vignette — cold and a touch heavier than usual, the oppressive-sky feel.
  const vg = ctx.createRadialGradient(W*0.5,H*0.44,H*0.26, W*0.5,H*0.44,H*0.78);
  vg.addColorStop(0,'rgba(0,0,0,0)'); vg.addColorStop(1,'rgba(4,6,7,0.62)');
  ctx.fillStyle = vg; ctx.fillRect(0,0,W,H);

  // dither — breaks up 8-bit banding rings in the dark gradients above.
  // Plain source-over (not 'overlay'/'soft-light') on purpose: those modes
  // multiply toward black on shadows, so they do ~nothing exactly where the
  // banding is worst. A flat low-alpha noise layer nudges every pixel by a
  // few values regardless of how dark it is, which is what actually hides it.
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.drawImage(bg.noise, 0,0,W,H);
  ctx.restore();
}

/* ═══ timeline ═══ */
const FADE_IN = 0.6;
const EYEBROW_START = 0.35, EYEBROW_DUR = 0.55;
const SETUP_START = 0.85;
const WORD_STAGGER = 0.075, WORD_DUR = 0.42, WORD_RISE = 16;
const PAUSE_BETWEEN = 0.6;
const PUNCH_DUR = 0.42, PUNCH_RISE = 0;
const FADE_OUT_DUR = 1.4;
const SAFE_W = W*0.8; // 10% margin each side — mirrors the TikTok side-crop safe zone

let Q_TEXT, setupStart, punchStart, punchLandT, cy;

function buildQuote(){
  const bank = window.QUOTE_BANK;
  const q = bank[Math.floor(rnd()*bank.length)];

  const eyebrowLayout = layoutWords(q.tag, 700, H*0.018, SAFE_W, 1.3);
  const setupLayout = layoutWords(q.setup, 300, H*0.034, SAFE_W, 1.32);
  const punchLayout = layoutWords(q.punch, 800, H*0.05, SAFE_W, 1.22);

  const gapEyebrowSetup = H*0.045;
  const gapSetupPunch = H*0.05;
  const totalH = eyebrowLayout.height + gapEyebrowSetup + setupLayout.height + gapSetupPunch + punchLayout.height;
  cy = H*0.46;
  let top = cy - totalH/2;
  const eyebrowY = top + eyebrowLayout.height/2; top += eyebrowLayout.height + gapEyebrowSetup;
  const setupY = top + setupLayout.height/2; top += setupLayout.height + gapSetupPunch;
  const punchY = top + punchLayout.height/2;

  setupStart = SETUP_START;
  const setupSpan = (setupLayout.wordCount-1)*WORD_STAGGER + WORD_DUR;
  punchStart = setupStart + setupSpan + PAUSE_BETWEEN;
  punchLandT = punchStart + PUNCH_DUR;

  return { q, eyebrowLayout, setupLayout, punchLayout, eyebrowY, setupY, punchY };
}

/* ═══ render ═══ */
let shakeT = -1;
function render(t){
  ctx.setTransform(Q,0,0,Q,0,0);

  // whole-scene Ken Burns drift + a tiny punch-in kick timed to the reveal.
  const kenBurns = 1 + 0.035*clamp01(t/DURATION);
  const kickT = clamp01((t-punchStart)/0.5);
  const kick = kickT<1 ? 1 + 0.018*(1-kickT)*Math.sin(kickT*Math.PI) : 1;
  const scale = kenBurns*kick;

  let shakeX = 0, shakeY = 0;
  if(t >= punchStart && t < punchStart+0.16){
    const k = 1-(t-punchStart)/0.16;
    shakeX = Math.sin(t*90)*3*k; shakeY = Math.cos(t*70)*2*k;
  }

  ctx.save();
  ctx.translate(W/2+shakeX, H/2+shakeY);
  ctx.scale(scale, scale);
  ctx.translate(-W/2, -H/2);

  drawBackground(t);

  const Qd = state;
  // eyebrow
  const eA = easeOutCubic(clamp01((t-EYEBROW_START)/EYEBROW_DUR));
  if(eA>0){
    ctx.save();
    ctx.globalAlpha = eA;
    ctx.font = `700 ${Qd.eyebrowLayout.fontPx}px Montserrat, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9aa7ac';
    ctx.shadowColor = 'rgba(170,188,192,.45)'; ctx.shadowBlur = 14;
    // letter-spaced eyebrow — canvas has no letter-spacing, so space it by hand
    const spaced = Qd.q.tag.split('').join('  ');
    ctx.fillText(spaced, W/2, Qd.eyebrowY - (1-eA)*8);
    ctx.restore();
  }

  drawRevealBlock(Qd.setupLayout, W/2, Qd.setupY, setupStart, t, WORD_STAGGER, WORD_DUR, WORD_RISE,
    '#c3cbcc', 'rgba(190,206,210,.22)', 10);

  // punch lands as one unified slam rather than word-by-word — that's the hit.
  const pT = clamp01((t-punchStart)/PUNCH_DUR);
  if(pT>0){
    const pe = easeOutBack(pT);
    ctx.save();
    ctx.globalAlpha = clamp01(pT/0.7);
    ctx.translate(W/2, Qd.punchY);
    ctx.scale(0.85+0.15*pe, 0.85+0.15*pe);
    ctx.translate(-W/2, -Qd.punchY);
    ctx.font = `800 ${Qd.punchLayout.fontPx}px Montserrat, sans-serif`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#edf1f0';
    ctx.shadowColor = 'rgba(195,214,217,.55)'; ctx.shadowBlur = 26;
    const top = Qd.punchY - Qd.punchLayout.height/2 + Qd.punchLayout.fontPx*0.38;
    for(const line of Qd.punchLayout.lines){
      for(const w of line.words) ctx.fillText(w.text, W/2 + w.x, top + line.y);
    }
    ctx.restore();
  }

  // impact flash — the silent stand-in for a hit sound, reframed as a
  // lightning flicker (a quick pulse, then a dimmer echo) lighting the
  // whole overcast sky rather than a warm localized glow.
  const pulse = (t0, dur, peak) => {
    const p = (t-t0)/dur;
    return (p<0 || p>1) ? 0 : peak * Math.sin(p*Math.PI);
  };
  const flashA = Math.max(pulse(punchStart, 0.12, 0.22), pulse(punchStart+0.1, 0.22, 0.12));
  if(flashA>0.002){ ctx.fillStyle = `rgba(214,222,222,${flashA})`; ctx.fillRect(0,0,W,H); }

  ctx.restore(); // Ken Burns transform

  // fade in / out — drawn in screen space, outside the Ken Burns transform.
  const fadeIn = 1-easeOutCubic(clamp01(t/FADE_IN));
  const fadeOut = easeOutCubic(clamp01((t-(DURATION-FADE_OUT_DUR))/FADE_OUT_DUR));
  const fadeA = Math.max(fadeIn, fadeOut);
  if(fadeA>0.001){ ctx.fillStyle = `rgba(2,2,3,${fadeA})`; ctx.fillRect(0,0,W,H); }
}

/* ═══ boot / loop ═══ */
// canvas measureText/fillText silently fall back to a system font until the
// real one finishes loading — layoutWords ran on the fallback's metrics
// once, so words drawn later in the actual (wider) Montserrat overlapped
// each other. Block on every weight this page uses before laying out text.
async function ensureFontsReady(){
  const specs = ['300 10px Montserrat', '700 10px Montserrat', '800 10px Montserrat'];
  try{ await Promise.all(specs.map(s => document.fonts.load(s))); await document.fonts.ready; }catch(e){}
}

const freshSeed = () => ((Date.now() ^ Math.floor(Math.random()*1e9)) >>> 0) || 1;

let state, t0, raf;
function boot(explicitSeed){
  SEED = explicitSeed === undefined || explicitSeed === null || explicitSeed === ''
    ? pickSeed() : ((Number(explicitSeed) >>> 0) || 1);
  srand(SEED);
  state = buildQuote();     // consumes the content stream first...
  _vs = (SEED ^ 0x9E3779B9) >>> 0;   // ...then the visual stream, seeded off a derived value
  bg = buildBackground();
}

let autoReplay = false, autoTimer = null;
function loop(){
  const t = (performance.now()-t0)/1000;
  render(Math.min(t, DURATION));
  if(t < DURATION){ raf = requestAnimationFrame(loop); return; }
  if(autoReplay){ clearTimeout(autoTimer); autoTimer = setTimeout(() => RM.replay(), 700); }
}

/* preview studio API (window.RM.*) — same replay/getSeed/readout shape the
   other content types' studios already drive (see render/eyetest/game.js). */
const RM = {};
RM.replay = (seed) => {
  cancelAnimationFrame(raf);
  clearTimeout(autoTimer);
  boot(seed === undefined || seed === null || seed === '' ? freshSeed() : seed);
  t0 = performance.now();
  loop();
};
RM.again = () => RM.replay(SEED);
RM.setAutoReplay = (on) => { autoReplay = !!on; };
RM.getSeed = () => SEED;
RM.readout = () => ({
  seed: SEED, tag: state.q.tag, setup: state.q.setup, punch: state.q.punch,
  elapsed: +Math.min((performance.now()-t0)/1000, DURATION).toFixed(2),
  duration: DURATION,
  done: (performance.now()-t0)/1000 >= DURATION,
});
window.RM = RM;

const restartBtn = document.getElementById('restart');
if(restartBtn) restartBtn.addEventListener('click', () => RM.replay());

/* ═══ headless render API — mirrors the same window.<NAME> contract every
   other content type exposes (meta / step() / result()) so render.mjs can
   drive it identically: no audio events here, so `events` is always []. ═══ */
(async () => {
  await ensureFontsReady();
  boot();

  if(!RENDER){ t0 = performance.now(); loop(); return; }

  const totalFrames = Math.round(DURATION*FPS);
  const QT = { frame:0, done:false, meta:{ fps:FPS, totalFrames, seed:SEED, width:W, height:H, tag:state.q.tag } };
  QT.step = () => {
    QT.frame += 1;
    render(QT.frame/FPS);
    const done = QT.frame >= totalFrames;
    QT.done = done;
    return { frame:QT.frame, events:[], done };
  };
  QT.result = () => ({
    durationSec: +(totalFrames/FPS).toFixed(2), frames: totalFrames, fps: FPS,
    width: W, height: H, seed: SEED, tag: state.q.tag,
    setup: state.q.setup, punch: state.q.punch,
  });
  window.QT = QT;
})();

})();

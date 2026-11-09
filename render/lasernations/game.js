"use strict";
(function(){

/* ═══════════════════════════════════════════════════════════════
   LASER NATIONS — a neon territory sim for short video.
   Four nations carve glowing laser trails as they bounce and speed
   up; drive through an enemy string and it snaps. The arena widens
   as the pace climbs. When the clock runs out, the most territory
   wins. Optional: a black-hole sudden-death finish.

   This is the clipper-app build: it also runs headlessly, frame by
   frame, when loaded with ?render=1 — the sim is fully deterministic
   from ?seed, the audio is emitted as an event log for a Python pass,
   and window.LN exposes meta / step() / result() for the renderer.
   ═══════════════════════════════════════════════════════════════ */

const QS = new URLSearchParams(location.search);
const RENDER = QS.get('render') === '1';
const SEED_PARAM = (parseInt(QS.get('seed') || '1', 10) >>> 0) || 1;
const FPS = Math.max(20, Math.min(60, parseInt(QS.get('fps') || '30', 10)));
const W = Math.max(320, parseInt(QS.get('w') || '1080', 10));
const H = Math.max(320, parseInt(QS.get('h') || '1920', 10));
// deviceScaleFactor the renderer set — the canvas backs at this so it's pixel-1:1
const SS = Math.max(1, Math.min(4, parseFloat(QS.get('ss') || '3')));
const END_HOLD = 3.4;   // seconds of video after the winner is decided

/* ═══ DUEL MODE flags — read up front so CFG's defaults below can branch on
   them. See the big comment further down (by DCFG) for what duel mode is. ═══ */
const DUEL = QS.get('duel') === '1';
const EMBED = QS.get('embed') === '1';
const POSTER = QS.get('poster') === '1';
const DUEL_A = QS.get('a') || '';
const DUEL_B = QS.get('b') || '';

const cv = document.getElementById('c');
const ctx = cv.getContext('2d', { alpha:false });

// window.LN — the headless renderer's handle. Declared early so the Sound
// recorder closure can read LN.frame the moment sounds start firing.
const LN = { frame: 0, done: false, meta: null, _hardCap: 999999 };

// the arena — base rect (positioned live, just below the scoreboard) that
// grows a little over the match. F is the live rect used everywhere.
const F0 = { x:130, y:640, w:820, h:980 };
const F  = { x:130, y:640, w:820, h:980, cx:540, cy:1130 };

const CFG = {
  matchSec:   RENDER ? Math.max(20, Math.min(DUEL ? 55 : 90, parseFloat(QS.get('sec') || (DUEL ? '32' : '65')))) : (DUEL ? 32 : 65),
  speedEvery:  5,
  speedStep:   1.235,
  speedMax:    8.5,
  speedStart:  1.4,
  baseSpeed:   400,
  ballR:       26,
  segCap:      200,
  grow:        0.16,        // the arena widens this fraction over the match
  vortexAt:    50,
  grace:       3.5,
};

let vortexOn = false;
if(RENDER){
  vortexOn = QS.get('bh') === '1';
} else {
  try{ vortexOn = localStorage.getItem('ln_vortex') === '1'; }catch(e){}
}

// vortex opens ~11s before the buzzer regardless of match length
if(RENDER) CFG.vortexAt = Math.max(6, CFG.matchSec - 11);

/* ═══ DUEL MODE — a 1v1 fight bolted onto the same arena/physics/flags/
   particle/banner engine as the 4-way territory game above, but with its own
   step/render/init/finish (stepDuel/renderDuel/initDuel/finishDuel below) so
   the original territory mode is never touched. Activated by ?duel=1.
   ?a=<Country>&b=<Country> pin the two fighters (else random, never the
   same one twice). The WINNER IS NEVER TOLD TO THIS FILE — there is no
   "let nation A win" branch anywhere below. A caller that wants a specific
   outcome (the worker's duel-seed search) simply runs this exact same,
   unbiased sim under many different seeds and keeps whichever one happened
   to produce that outcome — same trick this app already uses for Color War
   Season Mode's guaranteed comebacks. */
const DCFG = {
  maxHp: 100,
  arenaFrac: 0.82,         // duel arena is more intimate than the 4-way field
  ballR: 30,
  baseSpeed: 520,
  speedMax: 1150,
  speedRamp: 0.14,          // per second, eases toward speedMax as the fight goes on
  clashDmgMin: 4, clashDmgMax: 13,     // ball-vs-ball clash — hurts BOTH fighters
  hitCooldown: 0.22,        // per-pair minimum gap between damage events (no machine-gun stacking)
  // the orbiting weapon — a spinning flail each fighter always has out, on a
  // RIGID rod (fixed length, never elastic — no spring, no stretch). Its
  // reach (weaponOrbitR + weaponHitR + the other ball's radius) is
  // meaningfully wider than a body-to-body clash, so it's the fighter's real
  // "attack," not just a last-ditch bump.
  weaponOrbitR: 120,         // the rod's fixed length — about 2x the body's own diameter, ALWAYS this exact distance
  weaponHitR: 15,            // hit-reach used along the WHOLE rod (checked as a segment), not just the tip
  weaponRodW: 11,            // purely the shaft's drawn thickness, so it renders as a solid bar, not a thin line
  weaponSpinSpeed: 6.4,      // radians/sec — constant swing speed, only its sign flips when it bounces
  weaponDmgMin: 3, weaponDmgMax: 8,   // per landed hit — lower than a clash since it can fire far more often
  safetyCapSec: 90,          // hard backstop only — the fight always ends at 0 hp long before this in practice
  perkEvery: [4.0, 7.2],    // seconds between perk spawns (random in this range)
  perkR: 30,
  perkLosingBias: 0.62,     // chance a perk spawns nearer the CURRENTLY-losing fighter (never guaranteed)
  perkLife: 9,              // a perk despawns if nobody claims it in time
  buffDur: 4.6,
  healAmt: 27,
  shieldReduce: 0.55,
  rageBoost: 0.65,
  hasteBoost: 0.34,
  hpSampleEvery: 0.4,       // hp-history sampling interval for the seed-search's drama scoring
};

/* ── deterministic sim RNG (mulberry32) ── */
let SEED = 0, _s = 0;
const srand = s => { _s = s >>> 0; };
function rnd(){
  _s = _s + 0x6D2B79F5 | 0;
  let t = Math.imul(_s ^ _s >>> 15, 1 | _s);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}
const rr = (a,b) => a + rnd()*(b-a);
const ri = (a,b) => Math.floor(rr(a, b+1));
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=ri(0,i); [a[i],a[j]]=[a[j],a[i]]; } return a; }

/* ── visual-only RNG — screen shake etc. Kept a separate stream so the render
     pass never disturbs the sim RNG when it runs decoupled from step(). ── */
let _vs = 0;
function vrand(){
  _vs = _vs + 0x6D2B79F5 | 0;
  let t = Math.imul(_vs ^ _vs >>> 15, 1 | _vs);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}
const vrr = (a,b) => a + vrand()*(b-a);

const clamp01 = x => x == null ? 0.5 : (x < 0 ? 0 : x > 1 ? 1 : x);

/* ── neon faction palette (randomised each run, hues spread apart) ── */
const NEON = [186,206,232,262,286,308,330,8,36,58,96,140,164];
const hsl = (h,s,l,a) => `hsla(${h},${s}%,${l}%,${a==null?1:a})`;
function hslRgb(h, s, l){
  h = ((h % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const cc = t => {
    t = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if(t < 1/6) return p + (q - p) * 6 * t;
    if(t < 1/2) return q;
    if(t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  return [Math.round(cc(h + 1/3) * 255), Math.round(cc(h) * 255), Math.round(cc(h - 1/3) * 255)];
}
function pickHues(){
  const pool = shuffle(NEON.slice());
  const out = [];
  for(const h of pool){
    let d = 999; for(const o of out){ let g = Math.abs(o-h)%360; g = g>180?360-g:g; d = Math.min(d,g); }
    if(d >= 46) out.push(h);
    if(out.length === 4) break;
  }
  while(out.length < 4) out.push(pool[out.length]);
  return out;
}

/* ═══ country flags — drawn procedurally so they render anywhere ═══
   Israel is intentionally not in the pool.                          */
const COUNTRIES = [
  {n:'Japan',        t:'disc',    c:['#fff','#bc002d'], k:.30},
  {n:'France',       t:'v3',      c:['#0055a4','#fff','#ef4135']},
  {n:'Germany',      t:'h3',      c:['#141414','#dd0000','#ffce00']},
  {n:'Italy',        t:'v3',      c:['#009246','#fff','#ce2b37']},
  {n:'Netherlands',  t:'h3',      c:['#ae1c28','#fff','#21468b']},
  {n:'Spain',        t:'hw',      c:['#aa151b','#f1bf00','#aa151b'], w:[1,2,1], em:'#c8102e'},
  {n:'Portugal',     t:'vw',      c:['#046a38','#da020e'], w:[2,3], em:'#ffd200'},
  {n:'Sweden',       t:'nordic',  c:['#005293','#fecb00']},
  {n:'Norway',       t:'nordic',  c:['#ba0c2f','#fff','#00205b']},
  {n:'Denmark',      t:'nordic',  c:['#c60c30','#fff']},
  {n:'Finland',      t:'nordic',  c:['#fff','#003580']},
  {n:'Iceland',      t:'nordic',  c:['#02529c','#fff','#dc1e35']},
  {n:'Ireland',      t:'v3',      c:['#169b62','#fff','#ff883e']},
  {n:'Belgium',      t:'v3',      c:['#141414','#fdda24','#ef3340']},
  {n:'Romania',      t:'v3',      c:['#002b7f','#fcd116','#ce1126']},
  {n:'Poland',       t:'h2',      c:['#fff','#dc143c']},
  {n:'Ukraine',      t:'h2',      c:['#0057b7','#ffd700']},
  {n:'Switzerland',  t:'swiss',   c:['#d52b1e','#fff']},
  {n:'Greece',       t:'greece',  c:['#0d5eaf','#fff']},
  {n:'Austria',      t:'h3',      c:['#ed2939','#fff','#ed2939']},
  {n:'Russia',       t:'h3',      c:['#fff','#0039a6','#d52b1e']},
  {n:'Brazil',       t:'brazil',  c:['#009c3b','#ffdf00','#002776']},
  {n:'Argentina',    t:'sun',     c:['#74acdf','#fff','#74acdf'], em:'#f6b40e'},
  {n:'Canada',       t:'maple',   c:['#ff0000','#fff']},
  {n:'USA',          t:'usa',     c:['#b31942','#fff','#0a3161']},
  {n:'Mexico',       t:'v3',      c:['#006847','#fff','#ce1126'], em:'#9c6b3f'},
  {n:'Turkey',       t:'crescent',c:['#e30a17']},
  {n:'Egypt',        t:'h3',      c:['#ce1126','#fff','#141414'], em:'#c8a951'},
  {n:'Nigeria',      t:'v3',      c:['#008751','#fff','#008751']},
  {n:'South Africa', t:'za',      c:['#007a4d','#ffb612','#000','#de3831','#002395','#fff']},
  {n:'Kenya',        t:'h3',      c:['#000','#bb0000','#006600'], em:'#fff'},
  {n:'Morocco',      t:'star',    c:['#c1272d','#006233']},
  {n:'South Korea',  t:'korea',   c:['#fff','#cd2e3a','#0047a0','#141414']},
  {n:'China',        t:'stars',   c:['#de2910','#ffde00']},
  {n:'Vietnam',      t:'star',    c:['#da251d','#ffff00']},
  {n:'India',        t:'h3',      c:['#ff9933','#fff','#138808'], em:'#000080'},
  {n:'Indonesia',    t:'h2',      c:['#ff0000','#fff']},
  {n:'Colombia',     t:'hw',      c:['#fcd116','#003893','#ce1126'], w:[2,1,1]},
  {n:'Jamaica',      t:'jamaica', c:['#009b3a','#000','#fed100']},
  {n:'Pakistan',     t:'pakistan',c:['#01411c','#fff']},
];

function drawFlag(g, C, S){
  const c = C.c;
  g.save();
  const hf = S/2;
  switch(C.t){
    case 'v3': for(let i=0;i<3;i++){ g.fillStyle=c[i]; g.fillRect(i*S/3,0,S/3+1,S);} break;
    case 'h3': for(let i=0;i<3;i++){ g.fillStyle=c[i]; g.fillRect(0,i*S/3,S,S/3+1);} break;
    case 'h2': g.fillStyle=c[0]; g.fillRect(0,0,S,hf); g.fillStyle=c[1]; g.fillRect(0,hf,S,hf); break;
    case 'hw':{ let a=0,t=C.w.reduce((x,y)=>x+y); for(let i=0;i<c.length;i++){ g.fillStyle=c[i]; const hh=S*C.w[i]/t; g.fillRect(0,a,S,hh+1); a+=hh;} } break;
    case 'vw':{ let a=0,t=C.w.reduce((x,y)=>x+y); for(let i=0;i<c.length;i++){ g.fillStyle=c[i]; const ww=S*C.w[i]/t; g.fillRect(a,0,ww+1,S); a+=ww;} } break;
    case 'disc': g.fillStyle=c[0]; g.fillRect(0,0,S,S); disc(g,hf,hf,S*C.k,c[1]); break;
    case 'sun': for(let i=0;i<3;i++){ g.fillStyle=c[i]; g.fillRect(0,i*S/3,S,S/3+1);} sun(g,hf,hf,S*.12,C.em); break;
    case 'nordic':{
      g.fillStyle=c[0]; g.fillRect(0,0,S,S);
      const t=S*.16, ox=S*.36;
      if(c[2]){ g.fillStyle=c[2]; g.fillRect(ox-t*.75,0,t*1.5,S); g.fillRect(0,hf-t*.75,S,t*1.5); }
      g.fillStyle=c[1]; g.fillRect(ox-t/2,0,t,S); g.fillRect(0,hf-t/2,S,t);
    } break;
    case 'swiss':
      g.fillStyle=c[0]; g.fillRect(0,0,S,S);
      g.fillStyle=c[1]; { const a=S*.44,b=S*.14; g.fillRect(hf-b/2,hf-a/2,b,a); g.fillRect(hf-a/2,hf-b/2,a,b); }
      break;
    case 'greece':{
      for(let i=0;i<9;i++){ g.fillStyle = i%2?c[1]:c[0]; g.fillRect(0,i*S/9,S,S/9+1); }
      g.fillStyle=c[0]; g.fillRect(0,0,S*5/9,S*5/9);
      g.fillStyle=c[1]; { const a=S*5/9,b=a*.3; g.fillRect(a/2-b/2,0,b,a); g.fillRect(0,a/2-b/2,a,b); }
    } break;
    case 'crescent':
      g.fillStyle=c[0]; g.fillRect(0,0,S,S);
      crescent(g,hf*1.04,hf,S*.21,S*.16,'#fff'); star(g,hf*1.34,hf,S*.085,'#fff');
      break;
    case 'pakistan':
      g.fillStyle=c[1]; g.fillRect(0,0,S*.28,S);
      g.fillStyle=c[0]; g.fillRect(S*.28,0,S*.72,S);
      crescent(g,S*.63,hf,S*.16,S*.12,'#fff'); star(g,S*.77,hf*.76,S*.07,'#fff');
      break;
    case 'star':
      g.fillStyle=c[0]; g.fillRect(0,0,S,S); star(g,hf,hf,S*.27,c[1]);
      break;
    case 'stars':
      g.fillStyle=c[0]; g.fillRect(0,0,S,S);
      star(g,S*.28,S*.30,S*.15,c[1]);
      [[.50,.13],[.60,.24],[.60,.40],[.50,.51]].forEach(p=> star(g,S*p[0],S*p[1],S*.048,c[1]));
      break;
    case 'brazil':
      g.fillStyle=c[0]; g.fillRect(0,0,S,S);
      g.fillStyle=c[1]; g.beginPath(); g.moveTo(hf,S*.13); g.lineTo(S*.87,hf); g.lineTo(hf,S*.87); g.lineTo(S*.13,hf); g.closePath(); g.fill();
      disc(g,hf,hf,S*.185,c[2]);
      break;
    case 'maple':
      g.fillStyle=c[1]; g.fillRect(0,0,S,S);
      g.fillStyle=c[0]; g.fillRect(0,0,S/4,S); g.fillRect(S*3/4,0,S/4,S);
      maple(g,hf,hf,S*.19,c[0]);
      break;
    case 'usa':{
      for(let i=0;i<7;i++){ g.fillStyle = i%2?c[1]:c[0]; g.fillRect(0,i*S/7,S,S/7+1); }
      g.fillStyle=c[2]; g.fillRect(0,0,S*.44,S*4/7);
      g.fillStyle=c[1];
      for(let ro=0;ro<5;ro++) for(let co=0;co<5;co++)
        disc(g, S*.05+(ro%2)*S*.042+co*S*.083, S*.055+ro*S*.093, S*.016, c[1]);
    } break;
    case 'korea':
      g.fillStyle=c[0]; g.fillRect(0,0,S,S);
      g.save(); g.translate(hf,hf); g.rotate(-Math.PI/6);
      g.fillStyle=c[1]; g.beginPath(); g.arc(0,0,S*.17,0,Math.PI); g.fill();
      g.fillStyle=c[2]; g.beginPath(); g.arc(0,0,S*.17,Math.PI,Math.PI*2); g.fill();
      g.fillStyle=c[1]; g.beginPath(); g.arc(-S*.085,0,S*.085,0,7); g.fill();
      g.fillStyle=c[2]; g.beginPath(); g.arc(S*.085,0,S*.085,0,7); g.fill();
      g.restore();
      g.fillStyle=c[3];
      [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(d=>{ for(let b=-1;b<=1;b++)
        g.fillRect(hf+d[0]*S*.3-S*.05, hf+d[1]*S*.3+b*S*.034-S*.007, S*.1, S*.015); });
      break;
    case 'jamaica':
      g.fillStyle=c[0]; g.fillRect(0,0,S,S);
      g.fillStyle=c[1];
      g.beginPath(); g.moveTo(0,0); g.lineTo(S*.5,S*.5); g.lineTo(0,S); g.fill();
      g.beginPath(); g.moveTo(S,0); g.lineTo(S*.5,S*.5); g.lineTo(S,S); g.fill();
      g.strokeStyle=c[2]; g.lineWidth=S*.15; g.beginPath(); g.moveTo(0,0); g.lineTo(S,S); g.moveTo(S,0); g.lineTo(0,S); g.stroke();
      break;
    case 'za':
      g.fillStyle=c[3]; g.fillRect(0,0,S,hf); g.fillStyle=c[4]; g.fillRect(0,hf,S,hf);
      g.fillStyle=c[5]; g.beginPath(); g.moveTo(0,S*.1); g.lineTo(S*.52,hf); g.lineTo(0,S*.9); g.fill();
      g.fillStyle=c[0]; g.beginPath(); g.moveTo(0,S*.2); g.lineTo(S*.4,hf); g.lineTo(0,S*.8); g.fill();
      g.fillStyle=c[1]; g.beginPath(); g.moveTo(0,0); g.lineTo(S*.33,0); g.lineTo(S,hf); g.lineTo(S*.33,S); g.lineTo(0,S); g.lineTo(S*.44,hf); g.closePath(); g.fill();
      g.fillStyle=c[2]; g.beginPath(); g.moveTo(0,0); g.lineTo(S*.19,0); g.lineTo(S*.63,hf); g.lineTo(S*.19,S); g.lineTo(0,S); g.lineTo(S*.34,hf); g.closePath(); g.fill();
      break;
    default: g.fillStyle=c[0]; g.fillRect(0,0,S,S);
  }
  if(C.em && C.t!=='sun') disc(g,hf,hf,S*.1,C.em);
  g.restore();
}
function disc(g,x,y,r,col){ g.fillStyle=col; g.beginPath(); g.arc(x,y,r,0,7); g.fill(); }
function star(g,x,y,r,col){
  g.fillStyle=col; g.beginPath();
  for(let i=0;i<5;i++){
    const a=-Math.PI/2 + i*2.513; g.lineTo(x+Math.cos(a)*r, y+Math.sin(a)*r);
    const b=a+0.628; g.lineTo(x+Math.cos(b)*r*.42, y+Math.sin(b)*r*.42);
  }
  g.closePath(); g.fill();
}
function sun(g,x,y,r,col){
  g.fillStyle=col;
  for(let i=0;i<16;i++){ const a=i*Math.PI/8;
    g.beginPath(); g.moveTo(x,y);
    g.lineTo(x+Math.cos(a-.1)*r*2.1, y+Math.sin(a-.1)*r*2.1);
    g.lineTo(x+Math.cos(a+.1)*r*2.1, y+Math.sin(a+.1)*r*2.1); g.fill(); }
  g.beginPath(); g.arc(x,y,r,0,7); g.fill();
}
function crescent(g,x,y,ro,ri,col){
  g.save(); g.fillStyle=col;
  g.beginPath(); g.arc(x,y,ro,0,7); g.fill();
  g.globalCompositeOperation='destination-out';
  g.beginPath(); g.arc(x+ro*.42,y,ri,0,7); g.fill();
  g.restore();
}
function maple(g,x,y,r,col){
  g.save(); g.translate(x,y); g.scale(r/13,r/13); g.fillStyle=col;
  const p=[[0,-13],[1.6,-7.5],[5,-8.4],[3.7,-4.6],[9.5,-3.2],[7.8,-1.2],[13,3.4],[6.4,3],[7.3,6.8],
           [2.7,5.7],[3.3,12.6],[0,9.5],[-3.3,12.6],[-2.7,5.7],[-7.3,6.8],[-6.4,3],[-13,3.4],
           [-7.8,-1.2],[-9.5,-3.2],[-3.7,-4.6],[-5,-8.4],[-1.6,-7.5]];
  g.beginPath(); p.forEach((q,i)=> i?g.lineTo(q[0],q[1]):g.moveTo(q[0],q[1])); g.closePath(); g.fill();
  g.restore();
}
function flagCanvas(C, size){
  const f = document.createElement('canvas'); f.width = f.height = size;
  const g = f.getContext('2d');
  g.fillStyle = '#0b0f19'; g.fillRect(0,0,size,size);
  g.save(); g.beginPath(); g.arc(size/2,size/2,size/2,0,7); g.clip();
  drawFlag(g, C, size); g.restore();
  return f;
}
function shortName(n){
  return ({'South Africa':'S.AFRICA','South Korea':'S.KOREA','Netherlands':'DUTCH','Switzerland':'SWISS'}[n] || n).toUpperCase();
}

/* ═══════════════ audio ═══════════════
   In render mode the whole module is a recorder — every call appends an event
   (with sim time + frame) to a buffer the headless driver drains each step.
   In live mode it's the real Web Audio synth. */
function makeSoundRecorder(){
  let buf = [];
  let lastB = -9, lastS = -9;
  const push = o => { o.t = +G.t.toFixed(4); o.f = LN.frame; buf.push(o); };
  return {
    _drain(){ const b = buf; buf = []; return b; },
    ensure(){}, toggle(){ return true; }, muted(){ return true; },
    droneTo(){},
    bounce(hue, pace, x){
      if(G.t - lastB < 0.045) return; lastB = G.t;
      push({ type:'bounce', hue: hue|0, pace: +(+pace || 0).toFixed(3), x: clamp01(x) });
    },
    slice(combo, x){
      if(G.t - lastS < 0.04) return; lastS = G.t;
      push({ type:'slice', combo: combo|0, x: clamp01(x) });
    },
    speed(){ push({ type:'speed' }); },
    start(){ push({ type:'start' }); },
    down(hue){ push({ type:'down', hue: hue|0 }); },
    tick(){ push({ type:'tick' }); },
    vortexHit(){ push({ type:'vortex' }); },
    win(hue){ push({ type:'win', hue: hue|0 }); },
    // duel-only voices
    clash(impact){ push({ type:'clash', impact: +(+impact || 0).toFixed(3) }); },
    slash(combo, pace){ push({ type:'slash', combo: combo|0, pace: +(+pace || 0).toFixed(3) }); },
    perk(kind){ push({ type:'perk', kind: String(kind || 'heal') }); },
  };
}

const Sound = RENDER ? makeSoundRecorder() : (()=>{
  let ac, master, comp, lp, hs, verbG, drone, droneG, muted=false, ready=false;
  let tB=0, tS=0, sliceRun=0;
  // C major pentatonic, 3 octaves — bounces climb this as the match speeds up
  const SCALE = [];
  for(let o=0;o<3;o++) for(const d of [0,2,4,7,9]) SCALE.push(196 * Math.pow(2, o + d/12));

  function build(){
    if(ready) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return false;
    ac = new AC();
    master = ac.createGain(); master.gain.value = 0.30;
    comp = ac.createDynamicsCompressor();
    comp.threshold.value=-20; comp.knee.value=28; comp.ratio.value=3.2; comp.attack.value=.006; comp.release.value=.22;
    lp = ac.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=7200; lp.Q.value=.4;   // soft ceiling — kills harshness
    hs = ac.createBiquadFilter(); hs.type='highshelf'; hs.frequency.value=3200; hs.gain.value=-5;
    // soft, long reverb
    const len = ac.sampleRate*2.0, b = ac.createBuffer(2,len,ac.sampleRate);
    for(let ch=0;ch<2;ch++){ const d=b.getChannelData(ch);
      for(let i=0;i<len;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/len,3.2)*0.5; }
    verbG = ac.createGain(); verbG.gain.value=.2;
    const verb = ac.createConvolver(); verb.buffer=b;
    const verbLp = ac.createBiquadFilter(); verbLp.type='lowpass'; verbLp.frequency.value=4200;
    master.connect(comp); comp.connect(lp); lp.connect(hs); hs.connect(ac.destination);
    verb.connect(verbLp); verbLp.connect(verbG); verbG.connect(comp);
    Sound._verb = verb;

    // deep vortex rumble — silent unless the black-hole finish is on
    drone = ac.createOscillator();
    drone.type='sine'; drone.frequency.value=40;
    droneG = ac.createGain(); droneG.gain.value=0.0001;
    const droneLp = ac.createBiquadFilter(); droneLp.type='lowpass'; droneLp.frequency.value=110;
    drone.connect(droneLp); droneLp.connect(droneG); droneG.connect(comp);
    drone.start();

    ready = true; return true;
  }
  const t = () => ac.currentTime;
  const on = () => ready && !muted;
  function env(g, at, a, d, pk){
    g.gain.setValueAtTime(.0001,at);
    g.gain.exponentialRampToValueAtTime(pk, at+a);
    g.gain.exponentialRampToValueAtTime(.0001, at+a+d);
  }
  function tone(f, at, a, d, pk, type, glide, wet, ot){
    const o=ac.createOscillator(), g=ac.createGain();
    o.type=type||'sine'; o.frequency.setValueAtTime(f,at);
    if(glide) o.frequency.exponentialRampToValueAtTime(Math.max(20,glide), at+a+d);
    env(g,at,a,d,pk); o.connect(g); g.connect(master); if(wet) g.connect(verbG);
    o.start(at); o.stop(at+a+d+.06);
    if(ot){
      const o2=ac.createOscillator(), g2=ac.createGain();
      o2.type='sine'; o2.frequency.setValueAtTime(f*2,at);
      if(glide) o2.frequency.exponentialRampToValueAtTime(Math.max(20,glide*2), at+a+d);
      env(g2,at,a,d*.5,pk*.32); o2.connect(g2); g2.connect(master);
      o2.start(at); o2.stop(at+a+d);
    }
  }
  function softNoise(at, dur, pk, cutoff, wet){
    const src=ac.createBufferSource(), b=ac.createBuffer(1, Math.ceil(ac.sampleRate*dur), ac.sampleRate);
    const d=b.getChannelData(0); for(let i=0;i<d.length;i++) d[i]=Math.random()*2-1;
    src.buffer=b;
    const f=ac.createBiquadFilter(); f.type='lowpass'; f.Q.value=.7;
    f.frequency.setValueAtTime(cutoff,at); f.frequency.exponentialRampToValueAtTime(cutoff*.4, at+dur);
    const g=ac.createGain(); env(g,at,dur*.2,dur*.8,pk);
    src.connect(f); f.connect(g); g.connect(master); if(wet) g.connect(verbG);
    src.start(at); src.stop(at+dur+.02);
  }
  return {
    ensure(){ if(build() && ac.state==='suspended') ac.resume(); },
    toggle(){ muted=!muted; if(!muted) this.ensure(); return muted; },
    muted(){ return muted; },
    droneTo(v){ if(ready) droneG.gain.setTargetAtTime(Math.max(.0001,v), ac.currentTime, 1.4); },
    bounce(hue, pace){
      if(!on()) return; const n=t(); if(n-tB<.03) return; tB=n;
      const base = Math.round(Math.min(1, Math.max(0, pace)) * (SCALE.length - 5));
      const idx = Math.min(SCALE.length-1, base + (Math.floor(hue/47) % 3));
      const f = SCALE[idx] * (1 + ((hue%13)-6)*0.0016);
      tone(f, n, .004, .5, .055, 'sine', null, true, true);
    },
    slice(combo){
      if(!on()) return; const n=t(); if(n-tS<.045) return;
      sliceRun = (n - tS < .5) ? sliceRun + 1 : 0; tS=n;
      const up = Math.min(sliceRun, 10) * 34;
      tone(560 + up, n, .003, .16, .07, 'sine', 210 + up, true);
      softNoise(n, .12, .045, 2600, true);
      tone(2300 + up*6, n, .001, .05, .022, 'sine', 1500);
    },
    speed(){
      if(!on()) return; const n=t();
      tone(150, n, .04, .5, .09, 'sine', 320, true);
      tone(60, n, .01, .32, .1, 'sine', 42);
      softNoise(n, .4, .04, 1800, true);
    },
    start(){
      if(!on()) return; const n=t();
      tone(90, n, .006, .28, .16, 'sine', 220);
      tone(200, n, .004, .22, .09, 'sine', 90, true);
      softNoise(n, .22, .06, 3200, true);
    },
    down(hue){
      if(!on()) return; const n=t();
      tone(150, n, .01, .5, .12, 'sine', 66, true);
      [0,-3,-7].forEach((s,i)=> tone(330*Math.pow(2,s/12), n+i*.08, .006, .3, .05-i*.012, 'triangle', null, true));
    },
    tick(){ if(!on()) return; tone(760, t(), .001, .05, .03, 'sine', 620); },
    vortexHit(){
      if(!on()) return; const n=t();
      tone(40, n, .9, 2.8, .16, 'sine', 26, true);
      tone(120, n, .6, 2.0, .05, 'sine', 60, true);
      softNoise(n, 2.4, .04, 900, true);
    },
    win(hue){
      if(!on()) return; const n=t();
      const root = 174.61; // F
      [0,4,7,12,16,19].forEach((s,i)=>
        tone(root*Math.pow(2,s/12), n + i*.1, .012, 1.5 - i*.08, .1 - i*.011, i>2?'triangle':'sine', null, true, true));
      tone(root/2, n, .03, 2.2, .1, 'sine', null, true);
      tone(root*4, n+.06, .02, 1.4, .028, 'sine', null, true);
    },
    // duel-only voices — a heavier "clang" for a direct clash, a punchier
    // "swoosh-thwack" for a landed slash (reuses slice()'s escalating-pitch
    // combo feel but with a harder transient), and a warm reward chime for
    // perk pickups (root note by kind, so heal/shield/rage/haste each have a
    // faintly distinct colour without needing four separate voices).
    clash(impact){
      if(!on()) return; const n=t();
      const k = Math.max(0, Math.min(1, impact));
      tone(70 + k*20, n, .006, .34, .16 + k*.08, 'sine', 40, true);
      softNoise(n, .12, .09 + k*.05, 1400 + k*900, true);
      tone(1400 + k*500, n, .002, .05, .04, 'sine', 700);
    },
    slash(combo, pace){
      if(!on()) return; const n=t();
      const up = Math.min(combo,8) * 30;
      tone(620 + up, n, .003, .14, .09 + pace*.05, 'sine', 260+up, true);
      softNoise(n, .1, .05, 2800, true);
      tone(2600 + up*5, n, .001, .04, .026, 'sine', 1600);
    },
    perk(kind){
      if(!on()) return; const n=t();
      const root = { heal:392, shield:466.16, rage:220, haste:523.25 }[kind] || 392;
      [0,4,7].forEach((s,i)=> tone(root*Math.pow(2,s/12), n+i*.055, .008, .34, .09-i*.014, 'triangle', null, true, i===0));
      softNoise(n, .18, .03, 3600, true);
    }
  };
})();

/* ═══════════════════════════ game ═══════════════════════════ */
const el = id => document.getElementById(id);
const timerEl = el('timer'), speedEl = el('speed').querySelector('b'),
      boardEl = el('board'), bannerEl = el('banner'), winEl = el('win'),
      seedEl = el('seed'), bootEl = el('boot'), hookEl = el('hook');

let G, bannerT = 0, hudT = 0;
let winShown = false, bannerHold = false, bannerClearAt = 0, bannerShownAt = -9;

function init(seed){
  SEED = (seed != null ? seed
          : RENDER ? SEED_PARAM
          : ((Date.now() ^ (Math.random()*1e9)) >>> 0)) >>> 0;
  srand(SEED);
  _vs = (SEED ^ 0x9E3779B9) >>> 0;
  seedEl.textContent = 'SEED ' + SEED.toString(36).toUpperCase();

  if(DUEL){ initDuel(); return; }

  layoutArena();
  Object.assign(F, F0);
  F.cx = F.x + F.w/2; F.cy = F.y + F.h/2;

  const hues = pickHues();
  const nations = shuffle(COUNTRIES.slice()).slice(0,4);

  // fully random spawns every run — a random minimum spacing too, so some runs
  // spread to the corners and others start clustered. Balls NEVER overlap: a hard
  // floor of just over two ball-diameters is always enforced.
  const spawns = [];
  const padX = rr(70, 130), padY = rr(80, 150);
  const hardMin = CFG.ballR * 2 + 24;                       // ~76px — no overlap, ever
  let want = rr(hardMin + 24, Math.min(330, F.w * 0.36));   // the "feel" spacing this run
  const inBounds = () => ({ x: rr(F.x+padX, F.x+F.w-padX), y: rr(F.y+padY, F.y+F.h-padY) });
  for(let tries = 0; spawns.length < 4 && tries < 5000; tries++){
    if(tries && tries % 500 === 0) want = Math.max(hardMin, want * 0.82);   // relax if stuck
    const p = inBounds();
    if(spawns.every(s => Math.hypot(s.x-p.x, s.y-p.y) >= want)) spawns.push(p);
  }
  while(spawns.length < 4){                                  // guaranteed fill, still non-overlapping
    let p, k = 0;
    do { p = inBounds(); } while(spawns.some(s => Math.hypot(s.x-p.x, s.y-p.y) < hardMin) && k++ < 3000);
    spawns.push(p);
  }

  const factions = hues.map((hue,i) => {
    const a = rr(0, Math.PI*2);
    return {
      i, hue,
      col: hsl(hue,100,62), core: hsl(hue,100,86),
      country: nations[i],
      flagS: flagCanvas(nations[i], 256),
      flagL: flagCanvas(nations[i], 512),
      x: spawns[i].x, y: spawns[i].y, px: spawns[i].x, py: spawns[i].y,
      vx: Math.cos(a), vy: Math.sin(a),
      r: CFG.ballR, alive: true,
      anchor: { x: spawns[i].x, y: spawns[i].y },
      segs: [], travel: 0, travelMark: 0, lastAng: a,
      cuts: 0, kills: 0, eliminable: false, eliminatedAt: -1, lastCutBy: -1,
      lc: 0, zeroAt: -1, peakLc: 0,
      score: 0,   // only ever climbs: territory held over time + a bonus per cut
    };
  });

  G = {
    // RENDER: no dead countdown — the sim runs from frame 1 so the first second
    // is already full of motion (that's the whole hook window on TikTok).
    t:0, state: RENDER ? 'run' : 'boot', bootT:0, introT:0,
    speedMul:CFG.speedStart, nextSpeedAt:CFG.speedEvery,
    factions,
    vortex:{ active:false, str:0, age:0, R:0, end:0 },
    parts:[], shake:0, flash:0, chroma:0, spin:0, zoom:1,
    combo:0, comboT:0, lastTick:99, lastElimT:-9,
    winner:null, elimOrder:[], finishAt:0, winRevealAt:1e9,
  };

  buildBoard();
  winShown = false; bannerHold = false;
  winEl.classList.remove('show');
  bannerEl.className = '';
  bootEl.style.opacity = 0;
  cv.style.transform = 'translate(0,0)';
  Sound.droneTo(0.0001);

  if(RENDER){
    // kickoff: a spark burst off every ball, a bright flash + shake + a punchy hit
    for(const f of factions){
      burst(f.x, f.y, f.col, 34, 12, true);
      burst(f.x, f.y, '#ffffff', 10, 7, true);
    }
    G.flash = 1; G.chroma = 1; G.shake = 0.55;
    bootEl.textContent = 'GO'; bootEl.style.opacity = 1;
    Sound.start();
  }

  hud(true);
}

/* arena sits right below the scoreboard (touching is fine, just not overlapping)
   and inside a TikTok-safe band */
function layoutArena(){
  const sr = cv.getBoundingClientRect();
  const br = boardEl.getBoundingClientRect();
  let topFrac = sr.height ? (br.bottom - sr.top) / sr.height : 0.32;
  if(!isFinite(topFrac) || topFrac < 0.2) topFrac = 0.32;
  F0.y = Math.min(0.47, topFrac + 0.012) * H;   // hug the board
  F0.h = 0.865 * H - F0.y;
  F0.w = 0.88 * W;                                // same width as the scoreboard
  F0.x = (W - F0.w) / 2;
}

/* ── bloom offscreen (third-res blurred copy, added back with 'lighter') ── */
const bloom = document.createElement('canvas');
bloom.width = Math.round(W/2.4); bloom.height = Math.round(H/2.4);
const bctx = bloom.getContext('2d');
let FX = { bloom:true };
let _frameMs = 16, _slowRun = 0, Q = 1;

function resize(){
  // Canvas backs 1:1 with the captured frame (SS×). Canvas's own stroke AA keeps
  // the neon clean at 4K; a heavier supersample isn't worth the render cost.
  Q = RENDER ? SS : Math.min(1.75, Math.max(1, window.devicePixelRatio || 1));
  cv.width = Math.round(W*Q);
  cv.height = Math.round(H*Q);
  ctx.imageSmoothingQuality = 'high';
}

/* ── scoreboard ── */
function buildBoard(){
  boardEl.innerHTML = '';
  G.factions.forEach(f => {
    const chip = document.createElement('div');
    chip.className = 'chip'; chip.style.setProperty('--fac', f.col);
    const fl = document.createElement('span'); fl.className = 'flag';
    const fc = document.createElement('canvas'); fc.width = fc.height = 256;
    fc.getContext('2d').drawImage(f.flagS, 0, 0);
    fl.appendChild(fc);
    const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = shortName(f.country.n);
    const ln = document.createElement('span'); ln.className = 'lines'; ln.textContent = '0';
    chip.append(fl, nm, ln);
    f._chip = chip; f._ln = ln;
    boardEl.appendChild(chip);
  });
}
const live = f => { let c = 0; for(const s of f.segs) if(!s.dead) c++; return c; };

function hud(){
  if(DUEL){ hudDuel(); return; }
  const rem = Math.max(0, CFG.matchSec - G.t);
  timerEl.textContent = Math.floor(rem/60) + ':' + String(Math.floor(rem%60)).padStart(2,'0');
  timerEl.classList.toggle('low', rem <= 10 && G.state !== 'over');
  speedEl.textContent = '×' + G.speedMul.toFixed(1);

  // retention hook — a message that pulls the viewer to the finish
  if(hookEl){
    const M = CFG.matchSec, endPhase = G.vortex.active || G.t >= M - 12;
    let msg, hot = false;
    if(G.state === 'over')            msg = '';
    else if(endPhase){                msg = rem <= 5 ? 'Who won?!' : 'Almost over — wait for it'; hot = true; }
    else if(G.t < 3.2)                msg = 'Watch till the end';
    else if(G.t < 6.5)                msg = 'Guess the winner';
    else if(G.t < M * 0.34)            msg = 'Can you call it?';
    else if(G.t < M * 0.56)            msg = (Math.floor(G.t / 4) % 2) ? 'Comment your country' : "Who's in the lead?";
    else                              msg = 'Anyone can still win this';
    if(hookEl.textContent !== msg) hookEl.textContent = msg;
    hookEl.style.visibility = msg ? 'visible' : 'hidden';
    hookEl.classList.toggle('hot', hot);
    hookEl.classList.toggle('big', G.t < 3.2 && G.state !== 'over');   // bold in the hook window
  }

  // standings by score — the number only ever climbs; a knocked-out nation keeps
  // its frozen score (dimmed) so you can still see it might win on points
  const rank = G.factions.slice().sort((a,b) =>
    (a.alive !== b.alive) ? (a.alive ? -1 : 1) : b.score - a.score);
  rank.forEach((f, idx) => {
    boardEl.appendChild(f._chip);
    f._chip.classList.toggle('out', !f.alive);
    f._chip.classList.toggle('lead',
      idx === 0 && G.state === 'run' && rank[0].score > (rank[1] ? rank[1].score : 0));
    f._ln.textContent = Math.round(f.score).toLocaleString();
  });
}

/* shrink an element's font-size until its text fits `availPx` on one line */
function fitText(node, availPx, capPx){
  node.style.fontSize = '';
  let px = capPx || parseFloat(getComputedStyle(node).fontSize);
  node.style.fontSize = px + 'px';
  let guard = 40;
  while(node.scrollWidth > availPx && px > 11 && guard--){
    px = Math.max(11, px * Math.min(0.94, availPx / node.scrollWidth));
    node.style.fontSize = px + 'px';
  }
}
function stageW(){ return el('stage').clientWidth || innerWidth; }

function banner(big, sub, hold, col, life){
  const b = bannerEl.querySelector('.big');
  b.textContent = big;
  bannerEl.querySelector('.sub').textContent = sub || '';
  bannerEl.style.color = col || 'var(--ink)';
  bannerEl.className = ''; void bannerEl.offsetWidth;
  b.style.fontSize = '';
  fitText(b, stageW() * 0.92);
  if(RENDER){
    bannerEl.className = 'hold';
    bannerHold = true;
    bannerShownAt = G.t;
    bannerClearAt = G.t + (hold ? 1e9 : (life || 1.6));
    bannerEl.style.opacity = 0;   // faded in from advance()
    bannerEl.style.transform = 'translate(-50%,-50%) scale(1.12)';
  } else {
    bannerEl.className = hold ? 'hold' : 'show';
    bannerT = hold ? 1e9 : 1.05;
  }
}

/* ═══════════════════ simulation ═══════════════════ */
function step(dt){
  if(DUEL){ stepDuel(dt); return; }
  G.t += dt;

  if(G.state === 'run'){
    // the arena keeps expanding as the pace climbs — mostly wider, a little taller
    const g = Math.min(1, G.t / 52);
    F.w = Math.min(0.965*W, F0.w * (1 + CFG.grow * g));
    F.h = Math.min(0.875*H - F0.y, F0.h * (1 + CFG.grow * 0.42 * g));
    F.x = (W - F.w) / 2;
    F.y = F0.y;
    F.cx = W/2; F.cy = F.y + F.h/2;

    // final stretch: the whole battlefield slowly rotates and the camera
    // pulls back — a cinematic build to the buzzer (skipped if the black hole is on)
    const endP = G.vortex.active ? 0 : Math.max(0, Math.min(1, (G.t - (CFG.matchSec - 18)) / 15));
    G.spin = endP * endP * 0.19;
    G.zoom = 1 - endP * 0.16;

    // exponential-feeling acceleration every 5 s (silent — banner + flash only).
    // Stops once the black hole is open — the vortex takes over the pacing then.
    if(!G.vortex.active && G.t >= G.nextSpeedAt && G.nextSpeedAt <= CFG.matchSec - 5){
      G.speedMul = Math.min(CFG.speedMax, G.speedMul * CFG.speedStep);
      G.nextSpeedAt += CFG.speedEvery;
      G.flash = 0.55; G.chroma = 0.6;
      banner('SPEED ×' + G.speedMul.toFixed(1), 'the field accelerates', false,
             'var(--cyanlight)', 1.9);
    }

    // optional black-hole sudden death
    if(vortexOn && !G.vortex.active && G.t >= CFG.vortexAt){
      G.vortex.active = true; G.vortex.age = 0;
      banner('BLACK HOLE', 'do not touch the core', false, 'var(--violet)', 2.1);
      Sound.vortexHit(); Sound.droneTo(0.02);
      G.shake = 1; G.flash = 0.8; G.chroma = 1;
      // ease each ball into a wide orbit, aimed tangentially
      G.factions.filter(f=>f.alive).forEach(f=>{
        const dx=F.cx-f.x, dy=F.cy-f.y, d=Math.hypot(dx,dy)||1;
        f.vx = (-dy/d)*440 + (dx/d)*70;
        f.vy = ( dx/d)*440 + (dy/d)*70;
      });
    }
    if(G.vortex.active){
      G.vortex.age += dt;
      const a = G.vortex.age;
      // two phases:
      //   • open → matchSec-8 : balls hold a wide, slowly-decaying orbit (dread)
      //   • matchSec-8 → end  : the hole rapidly grows + yanks EVERYONE straight in,
      //     so the last ball is consumed within ~a second of the picked time.
      G.vortex.end = Math.max(0, Math.min(1, (G.t - (CFG.matchSec - 6)) / 6));
      const e = G.vortex.end;
      // hold most of the suck for the final ~2.5 s so the last deaths land right on the clock
      const late = Math.max(0, (e - 0.55) / 0.45);
      G.vortex.str = 0.6 + Math.min(0.5, a/6) + e*e*3 + late*late*9;
      G.vortex.R = Math.min(F.w*0.62, 14 + a*2.2 + e*e*180 + late*late*260);
      Sound.droneTo(0.02 + Math.min(.06, a*.005 + e*.02));
    }

    // opening frenzy — the balls fly for the first ~1.6 s so the hook window is
    // already loud with bounces / trails / sparks, then it settles to normal pace.
    const kick = G.t < 1.6 ? 1 + 1.05 * (1 - G.t / 1.6) : 1;
    const target = CFG.baseSpeed * G.speedMul * kick;
    const pace = (G.speedMul - 1) / (CFG.speedMax - 1);
    const alive = G.factions.filter(f=>f.alive);

    for(const f of alive){
      f.px = f.x; f.py = f.y;
      if(!G.vortex.active){
        const sp = Math.hypot(f.vx, f.vy) || 1;
        const ns = sp + (target - sp) * 0.1;
        f.vx = f.vx/sp*ns; f.vy = f.vy/sp*ns;
      } else {
        // real black-hole gravity: gentle far out (a wide, curving, slow-decaying
        // orbit), but once a ball crosses the capture zone the pull explodes and the
        // swirl dies — it gets SUCKED straight in and cannot climb back out. The
        // endgame term (e) then yanks everyone left toward the core.
        const dx=F.cx-f.x, dy=F.cy-f.y; let d=Math.hypot(dx,dy)||1;
        const s = Math.min(6, G.vortex.str), e = G.vortex.end || 0;
        const killR = Math.max(44, G.vortex.R * 0.42);
        const near = Math.max(0, 1 - d / (killR * 3.4));      // 0 far → ~1 at the horizon
        const late = Math.max(0, (e - 0.55) / 0.45);
        const grav  = 3.5*s + 170000*s/(d*d)
                    + near*near*5200*s                        // event-horizon suck
                    + e*e*3500*s + late*late*16000*s;         // endgame: everyone in, hard at the very end
        const swirl = (170000*s/d) * (1 - near*0.85) * (1 - e*0.7);
        const ax = dx/d*grav - dy/d*swirl;
        const ay = dy/d*grav + dx/d*swirl;
        f.vx += ax*dt; f.vy += ay*dt;
        let cs = Math.hypot(f.vx,f.vy) || 1;
        const cap = d < 240 ? 760 + (240 - d) * 5 : 760;      // whip faster the closer it gets
        const lo  = near > 0.2 ? 160 : 320;                   // let it slow near the core → falls straight in
        if(cs > cap){ f.vx=f.vx/cs*cap; f.vy=f.vy/cs*cap; }
        else if(cs < lo){ f.vx=f.vx/cs*lo; f.vy=f.vy/cs*lo; }
      }
    }

    // integrate + walls, chunked so fast balls never tunnel
    for(const f of alive){
      const vmag = Math.hypot(f.vx, f.vy);
      const n = Math.max(1, Math.ceil(vmag*dt / 7));
      const fdt = dt/n;
      for(let k=0;k<n;k++){
        f.x += f.vx*fdt; f.y += f.vy*fdt;
        f.travel += vmag*fdt;
        let hit = false;
        if(f.x-f.r < F.x){ f.x=F.x+f.r; f.vx=Math.abs(f.vx); hit=true; }
        else if(f.x+f.r > F.x+F.w){ f.x=F.x+F.w-f.r; f.vx=-Math.abs(f.vx); hit=true; }
        if(f.y-f.r < F.y){ f.y=F.y+f.r; f.vy=Math.abs(f.vy); hit=true; }
        else if(f.y+f.r > F.y+F.h){ f.y=F.y+F.h-f.r; f.vy=-Math.abs(f.vy); hit=true; }
        if(hit){
          commit(f, f.x, f.y, true);
          Sound.bounce(f.hue, pace, (f.x - F.x) / F.w);
          burst(f.x, f.y, f.col, 4, 2.2);
        } else if(!G.vortex.active || G.vortex.str < 0.85){
          const segLen = f.travel - f.travelMark;
          let da = Math.abs(Math.atan2(f.vy, f.vx) - f.lastAng);
          if(da > Math.PI) da = 2*Math.PI - da;
          if((da > 0.12 && segLen > 16) || segLen > (G.vortex.active ? 90 : 150)){
            commit(f, f.x, f.y, false);
          }
        }
      }
    }

    // ball ↔ ball
    for(let a=0;a<alive.length;a++) for(let b=a+1;b<alive.length;b++){
      const A=alive[a], B=alive[b];
      const dx=B.x-A.x, dy=B.y-A.y, d=Math.hypot(dx,dy), md=A.r+B.r;
      if(d>0 && d<md){
        const nx=dx/d, ny=dy/d, ov=(md-d)/2;
        A.x-=nx*ov; A.y-=ny*ov; B.x+=nx*ov; B.y+=ny*ov;
        const dvn=(B.vx-A.vx)*nx+(B.vy-A.vy)*ny;
        if(dvn<0){
          const j = -1.9*dvn/2;
          A.vx-=j*nx; A.vy-=j*ny; B.vx+=j*nx; B.vy+=j*ny;
          commit(A,A.x,A.y,true); commit(B,B.x,B.y,true);
          Sound.bounce((A.hue+B.hue)/2, pace, ((A.x+B.x)/2 - F.x) / F.w);
          burst((A.x+B.x)/2, (A.y+B.y)/2, '#ffffff', 6, 3);
        }
      }
    }

    // slicing — each ball's swept motion vs every OTHER nation's live segs
    for(const f of alive){
      for(const gf of G.factions){
        if(gf === f) continue;
        for(const s of gf.segs){
          if(s.dead) continue;
          if(segDist(s.ax,s.ay,s.bx,s.by, f.px,f.py,f.x,f.y) <= f.r*0.8){
            s.dead = true; gf.lastCutBy = f.i; f.cuts++; f.score += 5;   // aggression is the tie-breaker
            G.combo++; G.comboT = G.t;
            Sound.slice(G.combo, ((s.ax+s.bx)/2 - F.x) / F.w);
            burst((s.ax+s.bx)/2, (s.ay+s.by)/2, gf.col, 9, 4.5, true);
          }
        }
      }
    }
    if(G.combo && G.t - G.comboT > 0.5) G.combo = 0;

    // vortex devours the web (only when the toggle is on)
    if(G.vortex.active){
      const s = Math.min(5, G.vortex.str);
      const rot = 0.55 * Math.min(2.6, s) * dt, cs = Math.cos(rot), sn = Math.sin(rot);
      const frac = Math.min(0.5, (0.06 + s*0.19) * dt);
      const R2 = G.vortex.R * G.vortex.R;
      for(const gf of G.factions) for(const seg of gf.segs){
        if(seg.dead) continue;
        let ax = seg.ax - F.cx, ay = seg.ay - F.cy, bx = seg.bx - F.cx, by = seg.by - F.cy;
        let nax = ax*cs - ay*sn, nay = ax*sn + ay*cs;
        let nbx = bx*cs - by*sn, nby = bx*sn + by*cs;
        nax -= nax*frac; nay -= nay*frac; nbx -= nbx*frac; nby -= nby*frac;
        seg.ax = F.cx+nax; seg.ay = F.cy+nay; seg.bx = F.cx+nbx; seg.by = F.cy+nby;
        const mx=(nax+nbx)/2, my=(nay+nby)/2;
        if(mx*mx + my*my < R2){ seg.dead = true; if(rnd()<0.5) burst(F.cx+mx, F.cy+my, gf.col, 3, 7, true); }
      }
    }

    // score — only ever climbs: territory held, integrated over time
    const alive2 = G.factions.filter(f=>f.alive);
    for(const f of alive2){
      f.lc = live(f);
      if(f.lc > f.peakLc) f.peakLc = f.lc;
      f.score += f.lc * dt * 0.62;
      if(f.peakLc >= 12 || (G.vortex.active && f.peakLc >= 6)) f.eliminable = true;
      if(f.eliminable && f.lc === 0){ if(f.zeroAt < 0) f.zeroAt = G.t; }
      else f.zeroAt = -1;
    }

    // black hole: crossing the core = consumed. one at a time (0.3 s apart) so the
    // deaths read clearly — except in the final seconds, when it takes whatever's left.
    if(G.vortex.active){
      const killR = Math.max(44, G.vortex.R * 0.42) + CFG.ballR * 0.4;
      const rush = G.t >= CFG.matchSec - 0.8;
      if(rush || G.t - G.lastElimT > 0.3){
        for(const f of alive2){
          if(f.alive && Math.hypot(f.x - F.cx, f.y - F.cy) < killR){
            eliminate(f, 'vortex');
            G.lastElimT = G.t;
            if(!rush) break;   // one per frame normally; all-at-once in the last moment
          }
        }
      }
    }

    // web fully severed → the nation detonates (one at a time, never the last)
    const stillNow = G.factions.filter(f=>f.alive);
    if(stillNow.length > 1 && G.t > CFG.grace && G.t - G.lastElimT > 0.16){
      const gone = stillNow.filter(f => f.eliminable && f.lc === 0).sort((a,b) => a.zeroAt - b.zeroAt);
      if(gone.length){
        const kill = gone.length >= stillNow.length ? gone.slice(0, -1) : [gone[0]];
        for(const f of kill) eliminate(f);
        G.lastElimT = G.t;
      }
    }

    // THE WINNER IS ALWAYS THE HIGHEST SCORE — alive or dead. Surviving the black
    // hole is not winning; a nation that got pulled in still wins if it banked the
    // most territory.
    //   • black hole on  → the match ends when EVERY ball has been consumed (the
    //     endgame vortex guarantees this within a couple seconds of the clock).
    //   • black hole off → the match ends at the buzzer, or early if the field
    //     collapses to one with real time left (no dull solo bouncing).
    const still = G.factions.filter(f=>f.alive);
    const byScore = arr => arr.slice().sort((a,b) => b.score - a.score || b.cuts - a.cuts || b.peakLc - a.peakLc);
    if(G.vortex.active){
      if(still.length === 0 || G.t >= CFG.matchSec + 10) finish(byScore(G.factions)[0], 'Highest score');
    } else if(G.t >= CFG.matchSec || (still.length <= 1 && G.t < CFG.matchSec - 2.5)){
      finish(byScore(G.factions)[0], 'Highest score');
    }

  }

  // particles
  const P = G.parts;
  for(let i=P.length-1;i>=0;i--){
    const p = P[i];
    const damp = Math.pow(0.05, dt);
    p.vx *= damp; p.vy *= damp;
    p.x += p.vx*dt*60; p.y += p.vy*dt*60; p.life -= dt;
    if(G.vortex.active){
      const dx=F.cx-p.x, dy=F.cy-p.y, d=Math.hypot(dx,dy)||1;
      p.x += dx/d*2800*G.vortex.str*dt; p.y += dy/d*2800*G.vortex.str*dt;
    }
    if(p.life <= 0) P.splice(i,1);
  }
  if(P.length > 420) P.splice(0, P.length-420);

  G.shake *= Math.pow(0.045, dt);
  G.flash *= Math.pow(0.02, dt);
  G.chroma *= Math.pow(0.03, dt);
  if(bannerT < 1e8) bannerT -= dt;
}

function commit(f, x, y, force){
  const segs = f.segs, a = f.anchor;
  if(!force && Math.hypot(x-a.x, y-a.y) < 5) return;
  segs.push({ ax:a.x, ay:a.y, bx:x, by:y, dead:false });
  if(segs.length > CFG.segCap) segs.shift();
  f.anchor = { x, y };
  f.travelMark = f.travel;
  f.lastAng = Math.atan2(f.vy, f.vx);
}

/* segment ↔ segment min distance (0 if they cross) */
function segDist(ax,ay,bx,by, cx,cy,dx,dy){
  if(segX(ax,ay,bx,by,cx,cy,dx,dy)) return 0;
  return Math.min(
    ptSeg(ax,ay,cx,cy,dx,dy), ptSeg(bx,by,cx,cy,dx,dy),
    ptSeg(cx,cy,ax,ay,bx,by), ptSeg(dx,dy,ax,ay,bx,by));
}
function segX(ax,ay,bx,by,cx,cy,dx,dy){
  const d1=cr(dx-cx,dy-cy, ax-cx,ay-cy), d2=cr(dx-cx,dy-cy, bx-cx,by-cy);
  const d3=cr(bx-ax,by-ay, cx-ax,cy-ay), d4=cr(bx-ax,by-ay, dx-ax,dy-ay);
  return ((d1>0)!==(d2>0)) && ((d3>0)!==(d4>0));
}
const cr = (ax,ay,bx,by) => ax*by - ay*bx;
function ptSeg(px,py, ax,ay,bx,by){
  const dx=bx-ax, dy=by-ay, l=dx*dx+dy*dy;
  let t = l ? ((px-ax)*dx+(py-ay)*dy)/l : 0;
  t = t<0?0:t>1?1:t;
  return Math.hypot(px-(ax+t*dx), py-(ay+t*dy));
}

function burst(x,y,col,n,spd,spark){
  for(let i=0;i<n;i++){
    const a=rr(0,6.2832), s=rr(spd*.3, spd);
    G.parts.push({ x,y, vx:Math.cos(a)*s, vy:Math.sin(a)*s, life:rr(.28,.75), col, spark:!!spark, r:spark?rr(1.6,3.4):rr(1,2.3) });
  }
}
function detonate(f){
  for(let i=0;i<80;i++){
    const a=rr(0,6.2832), s=rr(2.5,14);
    G.parts.push({ x:f.x, y:f.y, vx:Math.cos(a)*s, vy:Math.sin(a)*s, life:rr(.5,1.35), col:i%4?f.col:'#ffffff', spark:true, r:rr(2,5) });
  }
}
function eliminate(f, cause){
  f.alive = false; f.eliminatedAt = G.t; G.elimOrder.push(f.i);
  if(cause !== 'vortex' && f.lastCutBy >= 0 && G.factions[f.lastCutBy] !== f) G.factions[f.lastCutBy].kills++;
  detonate(f);
  Sound.down(f.hue);
  G.shake = cause === 'vortex' ? 1 : 0.85; G.flash = cause === 'vortex' ? 0.9 : 0.7; G.chroma = 0.8;
  if(cause === 'vortex') burst(f.x, f.y, '#ffffff', 26, 9, true);
  const by = (cause !== 'vortex' && f.lastCutBy >= 0 && G.factions[f.lastCutBy] !== f) ? G.factions[f.lastCutBy] : null;
  if(G.factions.filter(x=>x.alive).length >= 1 && G.t - (G._bTime||-9) > 0.7){
    G._bTime = G.t;
    banner(shortName(f.country.n) + ' Down',
           cause === 'vortex' ? 'pulled into the black hole'
             : (by ? 'severed by ' + shortName(by.country.n) : 'territory collapsed'),
           false, f.col, 1.7);
  }
}

/* ═══════════════════════ render ═══════════════════════ */
function render(){
  if(DUEL){ renderDuel(); return; }
  if(G.shake > 0.008){
    cv.style.transform = `translate(${vrr(-1,1)*G.shake*1.4}%, ${vrr(-1,1)*G.shake*1.4}%)`;
  } else if(cv.style.transform !== 'translate(0px, 0px)'){
    cv.style.transform = 'translate(0,0)';
  }

  ctx.setTransform(Q,0,0,Q,0,0);
  ctx.fillStyle = '#0b0f19';
  ctx.fillRect(-30,-30, W+60, H+60);

  // final-stretch cinematic: rotate + pull the camera back around the arena
  ctx.save();
  if(G.spin || G.zoom !== 1){
    ctx.translate(F.cx, F.cy);
    ctx.rotate(G.spin);
    ctx.scale(G.zoom, G.zoom);
    ctx.translate(-F.cx, -F.cy);
  }

  // grid — drawn to the live arena so it grows with it
  ctx.strokeStyle = 'rgba(122,142,205,.05)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for(let x=F.x; x<=F.x+F.w+1; x+=80){ ctx.moveTo(x+.5,F.y); ctx.lineTo(x+.5,F.y+F.h); }
  for(let y=F.y; y<=F.y+F.h+1; y+=80){ ctx.moveTo(F.x,y+.5); ctx.lineTo(F.x+F.w,y+.5); }
  ctx.stroke();

  // arena frame
  ctx.save();
  ctx.strokeStyle = 'rgba(150,170,240,.4)';
  ctx.shadowColor = 'rgba(120,150,255,.5)'; ctx.shadowBlur = 20;
  ctx.lineWidth = 2;
  rrect(F.x,F.y,F.w,F.h,10); ctx.stroke();
  ctx.restore();

  ctx.save();
  rrect(F.x-1,F.y-1,F.w+2,F.h+2,10); ctx.clip();

  // trails — underglow + bright core (bloom adds the outer halo)
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'lighter';
  for(const f of G.factions){
    if(!f.segs.length && !f.alive) continue;
    ctx.beginPath();
    for(const s of f.segs){ if(s.dead) continue; ctx.moveTo(s.ax,s.ay); ctx.lineTo(s.bx,s.by); }
    if(f.alive){ ctx.moveTo(f.anchor.x, f.anchor.y); ctx.lineTo(f.x, f.y); }
    const A = f.alive ? 1 : 0.3;
    ctx.strokeStyle = f.col;  ctx.globalAlpha = .2*A;  ctx.lineWidth = 9; ctx.stroke();
    ctx.strokeStyle = f.core; ctx.globalAlpha = .95*A; ctx.lineWidth = 2.4; ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';

  if(G.vortex.active) vortex();

  ctx.globalCompositeOperation = 'lighter';
  for(const p of G.parts){
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life*1.7));
    ctx.fillStyle = p.col;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';

  // balls
  for(const f of G.factions){
    if(!f.alive) continue;
    const R = f.r;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = f.col; ctx.globalAlpha = .5; ctx.lineWidth = 4;
    ctx.shadowColor = f.col; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.arc(f.x, f.y, R+4, 0, 6.2832); ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.translate(f.x, f.y);
    if(G.vortex.active){
      // stretch toward the core — spaghettification ramps up sharply when close
      const ang = Math.atan2(F.cy-f.y, F.cx-f.x);
      const d = Math.hypot(F.cx-f.x, F.cy-f.y);
      const q = Math.pow(Math.max(0, 1 - d/420), 1.6) * 0.95 * Math.min(1, G.vortex.str);
      ctx.rotate(ang); ctx.scale(1+q, 1/(1+q*0.8)); ctx.rotate(-ang);
    }
    ctx.beginPath(); ctx.arc(0,0,R,0,6.2832); ctx.clip();
    ctx.drawImage(f.flagS, -R, -R, R*2, R*2);
    ctx.restore();

    ctx.strokeStyle = f.core; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(f.x, f.y, R, 0, 6.2832); ctx.stroke();
  }

  ctx.restore(); // arena clip

  // soft vignette on the arena
  const vg = ctx.createRadialGradient(F.cx, F.cy, F.h*0.3, F.cx, F.cy, F.h*0.72);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(3,4,9,.5)');
  ctx.fillStyle = vg;
  ctx.save(); rrect(F.x,F.y,F.w,F.h,10); ctx.clip(); ctx.fillRect(F.x,F.y,F.w,F.h); ctx.restore();

  ctx.restore(); // end cinematic transform

  // ---- bloom ----
  if(FX.bloom){
    bctx.clearRect(0, 0, bloom.width, bloom.height);
    bctx.filter = 'blur(4px)';
    bctx.drawImage(cv, 0, 0, cv.width, cv.height, 0, 0, bloom.width, bloom.height);
    bctx.filter = 'none';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.58 + Math.min(0.3, G.chroma * 0.34);
    ctx.drawImage(bloom, 0, 0, cv.width, cv.height);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  if(G.flash > 0.01){
    ctx.setTransform(Q, 0, 0, Q, 0, 0);
    ctx.fillStyle = `rgba(205,222,255,${G.flash * 0.09})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function vortex(){
  const s = Math.min(1.7, G.vortex.str);
  const R = G.vortex.R + Math.sin(G.t*3)*3;
  const x = F.cx, y = F.cy;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.translate(x, y); ctx.scale(1, 0.6); ctx.rotate(G.t*0.6);
  const N = FX.bloom ? 32 : 20;
  for(let i=0;i<N;i++){
    const ang = i*0.74 + G.t*2.4 + (i%2)*0.4;
    const rad = R*0.5 + (i/N)*R*2.6;
    const k = 1 - i/N;
    ctx.fillStyle = hsl(258 - k*130, 100, 56+k*28, 0.55*k*s);
    ctx.beginPath(); ctx.arc(Math.cos(ang)*rad, Math.sin(ang)*rad, 1.6 + k*3.4, 0, 6.2832); ctx.fill();
  }
  ctx.restore();

  const grd = ctx.createRadialGradient(x,y,0, x,y,R*2);
  grd.addColorStop(0, '#04050b'); grd.addColorStop(0.5, '#04050b');
  grd.addColorStop(0.7, hsl(266,100,58,.34*s));
  grd.addColorStop(0.88, hsl(300,100,60,.12*s));
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grd;
  ctx.beginPath(); ctx.arc(x, y, R*2, 0, 6.2832); ctx.fill();

  ctx.save();
  ctx.strokeStyle = hsl(282,100,82,.95);
  ctx.shadowColor = hsl(286,100,64,1); ctx.shadowBlur = 24*s;
  ctx.lineWidth = 2.4;
  ctx.beginPath(); ctx.arc(x, y, R*0.6, 0, 6.2832); ctx.stroke();
  ctx.restore();
}

function rrect(x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y, x+w,y+h, r); ctx.arcTo(x+w,y+h, x,y+h, r);
  ctx.arcTo(x,y+h, x,y, r);     ctx.arcTo(x,y, x+w,y, r);
  ctx.closePath();
}

/* ═══════════════════ finish ═══════════════════ */
function finish(w, tag){
  if(G.state === 'over') return;
  G.state = 'over'; G.winner = w; G.finishAt = G.t;
  Sound.win(w ? w.hue : 200); Sound.droneTo(0.0001);
  G.shake = 1; G.flash = 1; G.chroma = 1;

  document.documentElement.style.setProperty('--wc', w ? w.col : '#9fe8ff');
  el('winName').textContent = w ? w.country.n.toUpperCase() : 'DRAW';
  el('winTag').textContent = tag;
  const wf = el('winFlag'); wf.innerHTML = '';
  if(w){ const fc = document.createElement('canvas'); fc.width = fc.height = 512;
    fc.getContext('2d').drawImage(w.flagL, 0, 0); wf.appendChild(fc); }
  const plur = (n, s) => `<b>${n}</b> ${s}${n === 1 ? '' : 's'}`;
  el('winScore').textContent = w ? Math.round(w.score).toLocaleString() : '—';
  el('winStats').innerHTML = w
    ? `${plur(w.cuts, 'enemy string')} cut &nbsp;·&nbsp; ${plur(w.kills, 'knockout')}`
    : '';
  G.winRevealAt = G.t + 0.6;
  const revealFit = () => {
    winEl.classList.add('show');
    fitText(el('winName'), stageW() * 0.86, 96);
    fitText(el('winScore'), stageW() * 0.8, 150);
  };
  if(!RENDER) setTimeout(revealFit, 600); else G._revealFit = revealFit;
  hud();
}

/* ═══════════════════ loop ═══════════════════ */
let last = 0, acc = 0;

/* one frame's worth of simulation + a render + a hud refresh */
function advance(dt){
  if(!RENDER){
    _frameMs = _frameMs*0.9 + dt*1000*0.1;
    if(_frameMs > 26) _slowRun++; else if(_frameMs < 19) _slowRun = Math.max(0, _slowRun-1);
    if(_slowRun > 40 && FX.bloom){ FX.bloom = false; _slowRun = 0; }
    else if(_slowRun > 70 && Q > 1){ Q = 1; resize(); _slowRun = 0; }
  }

  if(G.state === 'boot'){
    G.bootT += dt;
    const b = G.bootT;
    bootEl.textContent = b < 0.6 ? '3' : b < 1.1 ? '2' : b < 1.55 ? '1' : 'GO';
    bootEl.style.opacity = b > 1.8 ? Math.max(0, 1 - (b - 1.8) / 0.25) : 1;
    if(b >= 2.05){ bootEl.style.opacity = 0; G.state = 'run'; }
  } else if(RENDER){
    // opening: a quick 'GO' hit that pops then fades in the first ~0.6 s
    G.introT += dt;
    const b = G.introT;
    bootEl.style.opacity = b < 0.28 ? 1 : Math.max(0, 1 - (b - 0.28) / 0.34);
  }

  acc += dt;
  const HS = 1/120; let it = 0;
  while(acc >= HS && it++ < 10){ step(HS); acc -= HS; }

  render();

  if(RENDER){
    hud();
    // sim-timed fade for the moment banner (CSS animation is off in render mode)
    if(bannerHold){
      const age = G.t - bannerShownAt, life = bannerClearAt - bannerShownAt;
      const inK = Math.min(1, age / 0.32);                         // ease in ~0.32s
      const outK = life < 1e6 ? Math.min(1, Math.max(0, (bannerClearAt - G.t) / 0.55)) : 1;
      const o = Math.min(inK, outK);
      bannerEl.style.opacity = (o * (2 - o)).toFixed(3);           // smootherstep-ish
      const pop = 1 + 0.12 * (1 - inK);                            // tiny scale settle
      bannerEl.style.transform = `translate(-50%,-50%) scale(${pop.toFixed(3)})`;
      if(G.t >= bannerClearAt){ bannerEl.className = ''; bannerEl.style.opacity = 0; bannerHold = false; }
    }
    if(G.state === 'over' && !winShown && G.t >= G.winRevealAt){
      (G._revealFit || (() => winEl.classList.add('show')))();
      winShown = true;
    }
  } else {
    hudT += dt;
    if(hudT > 0.06){ hudT = 0; hud(); }
  }
}

function frame(ts){
  requestAnimationFrame(frame);
  if(!last) last = ts;
  let dt = (ts - last)/1000; last = ts;
  if(dt > 0.1) dt = 0.1;
  advance(dt);
}

/* ═══════════════════ wire-up ═══════════════════ */
function restart(){
  Sound.ensure();
  winEl.classList.remove('show');
  init();
  last = 0; acc = 0;
}
function setVortexBtn(){
  const b = el('vortex');
  if(!b) return;
  b.classList.toggle('on', vortexOn);
  b.innerHTML = vortexOn ? '&#9673;' : '&#9711;';
  b.setAttribute('aria-label', 'Black-hole finish: ' + (vortexOn ? 'on' : 'off'));
}
el('restart').addEventListener('click', restart);
el('mute').addEventListener('click', function(){
  const m = Sound.toggle();
  this.classList.toggle('off', m);
  this.innerHTML = m ? '&#128263;' : '&#9834;';
  this.setAttribute('aria-label', m ? 'Unmute sound' : 'Mute sound');
});
el('vortex').addEventListener('click', function(){
  vortexOn = !vortexOn;
  try{ localStorage.setItem('ln_vortex', vortexOn ? '1' : '0'); }catch(e){}
  setVortexBtn();
  banner(vortexOn ? 'Black Hole: On' : 'Black Hole: Off',
         vortexOn ? 'sudden death near the end' : 'decided on the clock', false,
         vortexOn ? 'var(--violet)' : 'var(--ink-dim)');
});
addEventListener('keydown', e => {
  if(e.code === 'Space'){ e.preventDefault(); restart(); }
  else if(e.key === 'm' || e.key === 'M'){ el('mute').click(); }
  else if(e.key === 'v' || e.key === 'V'){ el('vortex').click(); }
});
el('stage').addEventListener('pointerdown', () => Sound.ensure(), { once:true });
addEventListener('resize', () => {
  if(RENDER) return;
  const q = Math.min(2, Math.max(1, window.devicePixelRatio||1));
  if(q !== Q) resize();
  if(winEl.classList.contains('show')) fitText(el('winName'), stageW() * 0.86, 92);
});
document.addEventListener('visibilitychange', () => { if(!document.hidden) last = 0; });

resize();
setVortexBtn();

/* ═══════════════════════════ DUEL MODE engine ═══════════════════════════
   Everything below is additive: it reuses the primitives above (rnd/rr/ri,
   hsl/hslRgb, COUNTRIES/flagCanvas/drawFlag, shortName, burst/detonate,
   commit/segDist, banner/fitText/stageW, rrect, the bloom canvas, Sound) but
   never calls into the territory-mode step()/render()/init()/finish() — the
   branches added at the top of those four functions route here instead. */

let pinA = DUEL_A, pinB = DUEL_B;   // mutable so the live preview's dropdowns can change the matchup

function initDuel(){
  const pool = shuffle(COUNTRIES.slice());
  const findC = name => COUNTRIES.find(c => c.n === name);
  let ca = (pinA && findC(pinA)) || pool[0];
  let cb = (pinB && findC(pinB)) || pool.find(c => c !== ca) || pool[1];
  if(ca === cb) cb = pool.find(c => c !== ca) || pool[1];
  const hues = pickHues();

  layoutArena();
  Object.assign(F, F0);
  // the duel ring is smaller and more central than the 4-way field — a
  // tighter box means the two fighters cross paths constantly instead of
  // orbiting each other at a polite distance. No arena growth over time here
  // (F stays fixed all match — duel pacing comes from speed + perks, not a
  // widening field).
  const shrinkW = (1 - DCFG.arenaFrac) / 2, shrinkH = (1 - (DCFG.arenaFrac + 0.12)) / 2;
  const nx = F.x + F.w*shrinkW, ny = F.y + F.h*Math.max(0, shrinkH);
  F.w = F.w * DCFG.arenaFrac; F.h = F.h * Math.min(1, DCFG.arenaFrac + 0.12);
  F.x = nx; F.y = ny;
  F.cx = F.x + F.w/2; F.cy = F.y + F.h/2;

  const mkFighter = (i, hue, country, x, y, ang) => {
    // the orbiting weapon — a RIGID rod of fixed length (weaponOrbitR),
    // never elastic: its tip position is always derived straight from
    // weaponAngle, so it can never stretch, compress, or wobble. It's a
    // solid bar, not a bungee — see stepDuel for the wall/opponent ricochet.
    const wAngle = rr(0,6.2832), wDir = rnd() < 0.5 ? 1 : -1;
    const wx = x + Math.cos(wAngle)*DCFG.weaponOrbitR, wy = y + Math.sin(wAngle)*DCFG.weaponOrbitR;
    return {
      i, hue, col: hsl(hue,100,62), core: hsl(hue,100,86),
      country, flagS: flagCanvas(country,256), flagL: flagCanvas(country,512),
      x, y, px:x, py:y, vx:Math.cos(ang), vy:Math.sin(ang),
      r: DCFG.ballR, alive: true,
      hp: DCFG.maxHp, maxHp: DCFG.maxHp, hpShown: DCFG.maxHp,
      shieldT:0, rageT:0, hasteT:0, hits:0, clashes:0,
      _lastClash:-9, _lastWeapon:-9,
      weaponAngle: wAngle, weaponDir: wDir, wx, wy,
    };
  };
  // randomised start: position AND heading, not a mirror-image face-off —
  // a perfectly symmetric start (same line, aimed dead at each other) made
  // every seed play out identically (both fighters always equally "fast" at
  // every clash, so damage split 50/50 forever and both hit 0 HP on the same
  // frame, every single time). Real variety needs the sim to actually be
  // seed-sensitive from frame one — this is the fix that makes it one.
  const pad = Math.min(F.w,F.h) * 0.24;
  const spawnY = () => rr(F.y + F.h*0.22, F.y + F.h*0.78);
  const ax0 = F.x + pad + rr(-F.w*0.05, F.w*0.05), ay0 = spawnY();
  const bx0 = F.x + F.w - pad + rr(-F.w*0.05, F.w*0.05), by0 = spawnY();
  const angA = rr(-0.9, 0.9), angB = Math.PI + rr(-0.9, 0.9);   // roughly facing across, never a perfect mirror
  const fighters = [
    mkFighter(0, hues[0], ca, ax0, ay0, angA),
    mkFighter(1, hues[1], cb, bx0, by0, angB),
  ];

  G = {
    t:0, state: 'lockin', lockinT:0, introT:0,
    factions: fighters,
    parts:[], hitRings:[], shake:0, flash:0, chroma:0,
    combo:0, comboT:0,
    perks:[], nextPerkAt: rr(DCFG.perkEvery[0], DCFG.perkEvery[1]),
    winner:null, loser:null, finishAt:0, winRevealAt:1e9,
    hpHistory:[[0, DCFG.maxHp, DCFG.maxHp]], nextSampleAt: DCFG.hpSampleEvery,
  };

  boardEl.innerHTML = ''; boardEl.style.display = 'none';
  el('speed').style.display = 'none';
  timerEl.style.display = 'none';   // no clock — the fight ends when someone hits 0 hp, not on a buzzer
  winShown = false; bannerHold = false;
  winEl.classList.remove('show'); bannerEl.className = '';
  bootEl.style.opacity = 0; cv.style.transform = 'translate(0,0)';
  if(Sound.droneTo) Sound.droneTo(0.0001);

  if(RENDER){
    for(const f of fighters){ burst(f.x,f.y,f.col,26,10,true); burst(f.x,f.y,'#ffffff',7,6,true); }
  }
  hud();
}

function damage(f, amount, source){
  let amt = amount;
  if(f.shieldT > 0) amt *= (1 - DCFG.shieldReduce);
  if(source && source.rageT > 0) amt *= (1 + DCFG.rageBoost);
  f.hp = Math.max(0, f.hp - amt);
  if(f.hp <= 0 && f.alive){ f.alive = false; detonate(f); Sound.down(f.hue); }
}

function perkLabel(k){ return { heal:'HEALED UP', shield:'SHIELD UP', rage:'RAGE MODE', haste:'HASTE!' }[k] || k.toUpperCase(); }
function perkGlyph(kind, r){
  ctx.beginPath();
  if(kind === 'heal'){
    ctx.rect(-r*0.28,-r, r*0.56,r*2); ctx.rect(-r,-r*0.28, r*2,r*0.56);
  } else if(kind === 'shield'){
    ctx.moveTo(0,-r); ctx.lineTo(r*0.85,-r*0.4); ctx.lineTo(r*0.85,r*0.35);
    ctx.quadraticCurveTo(r*0.85,r*0.95, 0,r); ctx.quadraticCurveTo(-r*0.85,r*0.95, -r*0.85,r*0.35);
    ctx.lineTo(-r*0.85,-r*0.4); ctx.closePath();
  } else if(kind === 'rage'){
    ctx.moveTo(0,-r); ctx.quadraticCurveTo(r*0.9,-r*0.1, r*0.35,r*0.6);
    ctx.quadraticCurveTo(r*0.5,r*0.15, 0,r); ctx.quadraticCurveTo(-r*0.5,r*0.15, -r*0.35,r*0.6);
    ctx.quadraticCurveTo(-r*0.9,-r*0.1, 0,-r); ctx.closePath();
  } else {
    ctx.moveTo(r*0.3,-r); ctx.lineTo(-r*0.5,r*0.1); ctx.lineTo(-r*0.05,r*0.1);
    ctx.lineTo(-r*0.3,r); ctx.lineTo(r*0.5,-r*0.15); ctx.lineTo(r*0.05,-r*0.15); ctx.closePath();
  }
  ctx.fill();
}
function spawnPerk(){
  const [A,B] = G.factions;
  const losing = A.hp < B.hp ? A : (B.hp < A.hp ? B : null);
  let cx, cy;
  // weighted, never guaranteed, toward whoever's behind — the same "mild
  // steering toward the frontier" philosophy this app's Color War already
  // uses for its comebacks: a nudge, not a script.
  if(losing && rnd() < DCFG.perkLosingBias){ cx = losing.x + rr(-150,150); cy = losing.y + rr(-150,150); }
  else { cx = rr(F.x+60, F.x+F.w-60); cy = rr(F.y+60, F.y+F.h-60); }
  cx = Math.max(F.x+50, Math.min(F.x+F.w-50, cx));
  cy = Math.max(F.y+50, Math.min(F.y+F.h-50, cy));
  const kinds = ['heal','shield','rage','haste'];
  G.perks.push({ x:cx, y:cy, kind: kinds[ri(0,3)], age:0, spin: rr(0,6.28) });
}
function claimPerk(f, p){
  if(p.kind === 'heal') f.hp = Math.min(f.maxHp, f.hp + DCFG.healAmt);
  else if(p.kind === 'shield') f.shieldT = DCFG.buffDur;
  else if(p.kind === 'rage') f.rageT = DCFG.buffDur;
  else if(p.kind === 'haste') f.hasteT = DCFG.buffDur;
  G.shake = Math.max(G.shake,0.3); G.flash = Math.max(G.flash,0.4);
  burst(p.x,p.y,f.col,18,6,true);
  Sound.perk(p.kind);
  banner(perkLabel(p.kind), shortName(f.country.n) + ' powers up', false, f.col, 1.3);
}

function updateDuelParticles(dt){
  const P = G.parts;
  for(let i=P.length-1;i>=0;i--){
    const p = P[i];
    const damp = Math.pow(0.05, dt);
    p.vx *= damp; p.vy *= damp;
    p.x += p.vx*dt*60; p.y += p.vy*dt*60; p.life -= dt;
    if(p.life <= 0) P.splice(i,1);
  }
  if(P.length > 420) P.splice(0, P.length-420);

  const R = G.hitRings;
  for(let i=R.length-1;i>=0;i--){ R[i].life -= dt*2.6; if(R[i].life <= 0) R.splice(i,1); }
}

function stepDuel(dt){
  G.t += dt;

  if(G.state === 'lockin'){
    G.lockinT += dt;
    if(G.lockinT === dt) Sound.start();
    if(G.lockinT > 2.2) G.state = 'run';
    updateDuelParticles(dt);
    G.shake *= Math.pow(0.045,dt); G.flash *= Math.pow(0.02,dt); G.chroma *= Math.pow(0.03,dt);
    return;
  }
  if(G.state !== 'run'){ updateDuelParticles(dt); return; }

  const [A,B] = G.factions;
  const alive = G.factions.filter(f=>f.alive);

  // a fight that's visibly quickening — same "escalation" feel as the
  // territory mode's speed ramps, just tuned for a shorter, tighter fight
  const target = Math.min(DCFG.speedMax, DCFG.baseSpeed + G.t*DCFG.speedRamp*260);
  for(const f of alive){
    f.px=f.x; f.py=f.y;
    const mul = f.hasteT>0 ? (1+DCFG.hasteBoost) : 1;
    const sp = Math.hypot(f.vx,f.vy) || 1;
    const ns = sp + (target*mul - sp) * 0.09;
    f.vx = f.vx/sp*ns; f.vy = f.vy/sp*ns;
  }

  for(const f of alive){
    const vmag = Math.hypot(f.vx,f.vy);
    const n = Math.max(1, Math.ceil(vmag*dt/7));
    const fdt = dt/n;
    for(let k=0;k<n;k++){
      f.x += f.vx*fdt; f.y += f.vy*fdt;
      let hit = false;
      if(f.x-f.r < F.x){ f.x=F.x+f.r; f.vx=Math.abs(f.vx); hit=true; }
      else if(f.x+f.r > F.x+F.w){ f.x=F.x+F.w-f.r; f.vx=-Math.abs(f.vx); hit=true; }
      if(f.y-f.r < F.y){ f.y=F.y+f.r; f.vy=Math.abs(f.vy); hit=true; }
      else if(f.y+f.r > F.y+F.h){ f.y=F.y+F.h-f.r; f.vy=-Math.abs(f.vy); hit=true; }
      // wall bounces stay silent in duel mode — no Sound.bounce() here (kept
      // in territory mode) — with an always-spinning weapon + clashes + hits
      // already sounding, a bounce chime on top just made the mix noisy.
      // The little spark still shows so a bounce reads visually.
      if(hit){ burst(f.x,f.y,f.col,3,2); }
    }
  }

  // the orbiting weapon — a RIGID rod, fixed at exactly weaponOrbitR from
  // its fighter every single frame (recomputed straight from weaponAngle,
  // never integrated from a velocity), so it can't stretch, sag, or wobble
  // like the old spring model — it's one solid bar of constant length.
  // It's solid against the arena walls AND the opponent's whole body: a
  // step that would swing the tip past a wall, or swing the ROD (the full
  // shaft, checked as a segment, not just its tip) into the other fighter,
  // is simply never taken — the swing ricochets (reverses direction)
  // instead, the same way a real bar would bounce off an obstacle rather
  // than pass through it. Checking only the tip against the walls is
  // enough to guarantee the WHOLE rod stays in-bounds: the fighter's own
  // centre never leaves the arena, the arena is a plain rectangle (convex),
  // and a straight line between two in-bounds points in a convex shape can
  // never itself step outside it — but the opponent's body isn't a wall of
  // the arena, so THAT check has to cover the rod's entire length, which is
  // also exactly what makes "anything touching them" count as a landed hit.
  const whr = DCFG.weaponHitR;
  for(const f of alive){
    const opp = f === A ? B : A;
    const tryAngle = f.weaponAngle + f.weaponDir * DCFG.weaponSpinSpeed * dt;
    const tx = f.x + Math.cos(tryAngle)*DCFG.weaponOrbitR;
    const ty = f.y + Math.sin(tryAngle)*DCFG.weaponOrbitR;

    let blocked = tx-whr < F.x || tx+whr > F.x+F.w || ty-whr < F.y || ty+whr > F.y+F.h;
    let landed = false;
    if(!blocked && opp.alive){
      const reach = whr + opp.r;
      if(ptSeg(opp.x, opp.y, f.x, f.y, tx, ty) <= reach){ blocked = true; landed = true; }
    }

    if(blocked){ f.weaponDir *= -1; }   // bounced off a wall or the opponent — reverse, never clip through
    else { f.weaponAngle = tryAngle; }
    f.wx = f.x + Math.cos(f.weaponAngle)*DCFG.weaponOrbitR;
    f.wy = f.y + Math.sin(f.weaponAngle)*DCFG.weaponOrbitR;

    if(landed && G.t - f._lastWeapon > DCFG.hitCooldown){
      f._lastWeapon = G.t;
      const spd = Math.hypot(f.vx,f.vy), pace = Math.min(1, spd/DCFG.speedMax);
      damage(opp, DCFG.weaponDmgMin + pace*(DCFG.weaponDmgMax-DCFG.weaponDmgMin), f);
      f.hits++;
      G.combo++; G.comboT = G.t;
      G.shake = Math.max(G.shake,0.38); G.flash = Math.max(G.flash,0.46);
      // a clear "that landed" impact: sparks at the point of contact + a
      // white-hot flash mixed in + an expanding ring on whoever got hit, so
      // a weapon connecting reads as a real hit, not just HP silently
      // ticking down.
      burst(f.wx,f.wy,f.col,10,5,true);
      burst(f.wx,f.wy,'#ffffff',6,4,true);
      G.hitRings.push({ x:opp.x, y:opp.y, life:1, col:f.col });
      Sound.slash(G.combo, pace);
    }
  }
  if(G.combo && G.t - G.comboT > 0.6) G.combo = 0;

  if(A.alive && B.alive){
    const dx=B.x-A.x, dy=B.y-A.y, d=Math.hypot(dx,dy)||1, md=A.r+B.r;

    if(d < md){
      // ball-vs-ball CLASH — a direct hit. Damage splits by who was moving
      // HARDER into the hit (each fighter's own speed at impact, not a true
      // closing-velocity projection — close enough to read as "who hit
      // harder" without needing a full jousting model): the pool of damage
      // is shared in proportion to speed, so a clash is never a flat mutual
      // tax — it can swing the fight either way, and a haste perk (or just
      // better positioning) means landing a clash while faster genuinely
      // pays off instead of hurting both fighters identically forever.
      const nx=dx/d, ny=dy/d, ov=(md-d)/2;
      A.x-=nx*ov; A.y-=ny*ov; B.x+=nx*ov; B.y+=ny*ov;
      const dvn=(B.vx-A.vx)*nx+(B.vy-A.vy)*ny;
      if(dvn<0){
        const j=-1.85*dvn/2;
        A.vx-=j*nx; A.vy-=j*ny; B.vx+=j*nx; B.vy+=j*ny;
        if(G.t - A._lastClash > DCFG.hitCooldown){
          A._lastClash = B._lastClash = G.t;
          const impact = Math.min(1, Math.abs(dvn)/900);
          const spA = Math.hypot(A.vx,A.vy), spB = Math.hypot(B.vx,B.vy), tot = spA+spB || 1;
          const shareA = spA/tot;
          const pool = (DCFG.clashDmgMin + impact*(DCFG.clashDmgMax-DCFG.clashDmgMin)) * 2;
          damage(B, pool*shareA, A);
          damage(A, pool*(1-shareA), B);
          A.clashes++; B.clashes++;
          G.shake = Math.max(G.shake,0.62); G.flash = Math.max(G.flash,0.68); G.chroma = Math.max(G.chroma,0.72);
          burst((A.x+B.x)/2,(A.y+B.y)/2,'#ffffff',18,7,true);
          Sound.clash(impact);
        }
      }
    }

    // weapon vs WEAPON — solid on solid, the two rods can clang off each
    // other too ("anything" includes each other, not just walls and
    // bodies). Checked as a full segment-to-segment distance (both rods'
    // entire shafts, base to tip), not just tip-to-tip, for the same reason
    // the opponent-body check above uses the whole rod. No damage from
    // this one, just a mutual direction-reverse + spark — two rigid bars
    // don't stick, they ricochet apart.
    if(segDist(A.x,A.y,A.wx,A.wy, B.x,B.y,B.wx,B.wy) <= whr*2){
      A.weaponDir *= -1; B.weaponDir *= -1;
      burst((A.wx+B.wx)/2,(A.wy+B.wy)/2,'#ffffff',7,4,true);
    }
  }

  for(const f of G.factions){
    if(f.shieldT>0) f.shieldT = Math.max(0,f.shieldT-dt);
    if(f.rageT>0) f.rageT = Math.max(0,f.rageT-dt);
    if(f.hasteT>0) f.hasteT = Math.max(0,f.hasteT-dt);
    f.hpShown += (f.hp - f.hpShown) * Math.min(1, dt*3.2);
  }

  if(G.t >= G.nextPerkAt && G.factions.every(f=>f.alive)){
    spawnPerk();
    G.nextPerkAt = G.t + rr(DCFG.perkEvery[0], DCFG.perkEvery[1]);
  }
  for(let i=G.perks.length-1;i>=0;i--){
    const p = G.perks[i];
    p.age += dt;
    let taken = false;
    for(const f of alive){ if(Math.hypot(f.x-p.x,f.y-p.y) < f.r+DCFG.perkR){ claimPerk(f,p); taken=true; break; } }
    if(taken || p.age > DCFG.perkLife) G.perks.splice(i,1);
  }

  updateDuelParticles(dt);
  G.shake *= Math.pow(0.045,dt); G.flash *= Math.pow(0.02,dt); G.chroma *= Math.pow(0.03,dt);
  if(bannerT < 1e8) bannerT -= dt;

  if(G.t >= G.nextSampleAt){
    G.hpHistory.push([+G.t.toFixed(2), Math.round(A.hp), Math.round(B.hp)]);
    G.nextSampleAt = G.t + DCFG.hpSampleEvery;
  }

  if(!A.alive || !B.alive){
    const w = A.alive ? A : B, l = A.alive ? B : A;
    finishDuel(w, l, 'ko');
  } else if(G.t >= DCFG.safetyCapSec){
    // pure backstop — with a clash + an always-spinning weapon both chipping
    // away, a real fight should never actually reach this; it exists only
    // so a pathological seed can't render forever. Not a "timer", never
    // shown, and never the normal way a fight ends.
    const w = A.hp === B.hp ? (rnd()<0.5?A:B) : (A.hp>B.hp?A:B);
    finishDuel(w, w===A?B:A, 'decision');
  }
}

function finishDuel(w, l, cause){
  if(G.state === 'over') return;
  G.state = 'over'; G.winner = w; G.loser = l; G.finishAt = G.t;
  Sound.win(w.hue); if(Sound.droneTo) Sound.droneTo(0.0001);
  G.shake=1; G.flash=1; G.chroma=1;
  if(l.alive){ l.alive=false; detonate(l); }

  document.documentElement.style.setProperty('--wc', w.col);
  el('winName').textContent = w.country.n.toUpperCase();
  const tagEl = el('winTag');
  tagEl.textContent = cause === 'ko' ? 'KNOCKOUT — ' + l.country.n.toUpperCase() + ' IS DOWN' : 'DECISION — MORE HEALTH LEFT';
  const wf = el('winFlag'); wf.innerHTML = '';
  const fc = document.createElement('canvas'); fc.width=fc.height=512;
  fc.getContext('2d').drawImage(w.flagL,0,0); wf.appendChild(fc);
  el('winScore').textContent = Math.round(w.hp) + '%';
  const lbl = el('winScoreLabel'); if(lbl) lbl.textContent = 'Health remaining';
  el('winStats').innerHTML = `<b>${w.hits}</b> hit${w.hits===1?'':'s'} landed &nbsp;·&nbsp; <b>${w.clashes}</b> clash${w.clashes===1?'':'es'}`;
  G.winRevealAt = G.t + 0.6;
  const revealFit = () => {
    winEl.classList.add('show');
    fitText(el('winName'), stageW()*0.86, 96);
    fitText(el('winScore'), stageW()*0.8, 150);
  };
  if(!RENDER) setTimeout(revealFit,600); else G._revealFit = revealFit;
  hud();
}

function hudDuel(){
  // no clock — the fight ends purely at 0 hp, so the retention hook leans on
  // HP state (how close, how low someone's gotten) instead of time remaining.
  if(hookEl){
    const [A,B] = G.factions;
    let msg, hot=false;
    const lowHp = Math.min(A.hp,B.hp);
    if(G.state === 'over') msg = '';
    else if(G.state === 'lockin') msg = shortName(A.country.n) + '  vs  ' + shortName(B.country.n);
    else if(lowHp <= 15){ msg = shortName((A.hp<B.hp?A:B).country.n) + ' IS ABOUT TO GO DOWN'; hot = true; }
    else if(lowHp <= 32){ msg = shortName((A.hp<B.hp?A:B).country.n) + ' IS ON THE ROPES'; hot = true; }
    else if(G.t < 4) msg = "Don't blink";
    else if(Math.abs(A.hp-B.hp) < 12) msg = 'Anyone could win this';
    else msg = (Math.floor(G.t/4)%2) ? 'Comment who wins' : "Who's got this?";
    if(hookEl.textContent !== msg) hookEl.textContent = msg;
    hookEl.style.visibility = msg ? 'visible' : 'hidden';
    hookEl.classList.toggle('hot', hot);
    hookEl.classList.toggle('big', G.state === 'lockin');
  }
}

function drawHealthBars(){
  const [A,B] = G.factions;
  const y = H*0.145, barH = H*0.026, gap = W*0.045;
  const fr = barH*1.55;             // flag badge radius
  // solved so each flag badge's OUTER edge sits a full 10% of W in from the
  // canvas edge — TikTok fills taller phone screens (iPhone 14/15 etc. are
  // ~19.5:9, not 16:9) by scaling a 9:16 video up and cropping ~11% off each
  // side, so anything closer than that to the left/right edge gets clipped
  // on real devices even though it looks fine in our own 1080-wide render.
  const sidePad = fr + W*0.1;
  const barW = W/2 - sidePad - fr*0.7 - gap/2;
  const xa = sidePad + fr*0.7, xb = W - sidePad - fr*0.7 - barW;

  const drawBar = (f, x, flip) => {
    const pct = Math.max(0, f.hp/f.maxHp), shownPct = Math.max(0, f.hpShown/f.maxHp);
    const fillFrom = (p) => flip ? x + barW*(1-p) : x;
    ctx.save();
    ctx.fillStyle = 'rgba(16,22,42,.78)'; rrect(x,y,barW,barH,barH/2); ctx.fill();
    ctx.strokeStyle = 'rgba(150,170,240,.35)'; ctx.lineWidth = 1.5; rrect(x,y,barW,barH,barH/2); ctx.stroke();
    ctx.save(); rrect(x,y,barW,barH,barH/2); ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.fillRect(fillFrom(shownPct), y, barW*shownPct, barH);
    const col = pct < 0.28 ? '#ff3b5c' : f.col;
    ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 10;
    ctx.fillRect(fillFrom(pct), y, barW*pct, barH);
    ctx.restore();
    if(f.shieldT > 0){ ctx.strokeStyle = '#5ec8ff'; ctx.lineWidth = 2.2; rrect(x,y,barW,barH,barH/2); ctx.stroke(); }
    ctx.restore();

    const fr = barH*1.55, flagX = flip ? x+barW+fr*0.7 : x-fr*0.7;
    ctx.save();
    ctx.beginPath(); ctx.arc(flagX, y+barH/2, fr, 0, 6.2832); ctx.clip();
    ctx.drawImage(f.flagS, flagX-fr, y+barH/2-fr, fr*2, fr*2);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(flagX, y+barH/2, fr, 0, 6.2832); ctx.stroke();

    ctx.font = '700 ' + Math.round(H*0.017) + 'px "Chakra Petch", sans-serif';
    ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#eef1fb';
    ctx.textAlign = flip ? 'right' : 'left';
    ctx.fillText(shortName(f.country.n), flip ? x+barW : x, y-H*0.012);
  };
  drawBar(A, xa, false);
  drawBar(B, xb, true);
}

function drawVsCard(){
  const [A,B] = G.factions;
  ctx.save();
  ctx.setTransform(Q,0,0,Q,0,0);
  ctx.fillStyle = `rgba(6,8,15,${0.72*Math.min(1,G.lockinT*3)})`;
  ctx.fillRect(0,0,W,H);

  const slam = t => 1 - Math.pow(1-Math.min(1,Math.max(0,t)), 3);
  const kIn = slam(G.lockinT/0.5);
  // spread solved so each badge's outer edge lands 10% of W in from the
  // canvas edge at full kIn (same TikTok side-crop margin as drawHealthBars).
  const cy = H*0.42, R = Math.min(W,H)*0.16, spread = (W*0.4 - R) * kIn;

  const badge = (f, dir) => {
    const x = W/2 + dir*spread;
    ctx.save();
    ctx.globalAlpha = kIn; ctx.translate(x,cy); ctx.scale(0.6+0.4*kIn, 0.6+0.4*kIn);
    ctx.shadowColor = f.col; ctx.shadowBlur = 40;
    ctx.beginPath(); ctx.arc(0,0,R,0,6.2832); ctx.clip();
    ctx.drawImage(f.flagL,-R,-R,R*2,R*2);
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = kIn; ctx.strokeStyle = f.col; ctx.lineWidth = 5;
    ctx.shadowColor = f.col; ctx.shadowBlur = 22;
    ctx.beginPath(); ctx.arc(x,cy,R,0,6.2832); ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = kIn;
    ctx.font = '800 ' + Math.round(H*0.032) + 'px "Chakra Petch", sans-serif';
    ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
    ctx.shadowColor = f.col; ctx.shadowBlur = 16;
    ctx.fillText(f.country.n.toUpperCase(), x, cy+R+H*0.055);
    ctx.restore();
  };
  badge(A,-1); badge(B,1);

  const vsK = slam((G.lockinT-0.32)/0.4);
  if(vsK > 0){
    ctx.save();
    ctx.globalAlpha = vsK; ctx.translate(W/2,cy); ctx.scale(0.4+0.6*vsK, 0.4+0.6*vsK);
    ctx.font = '800 ' + Math.round(H*0.08) + 'px "Chakra Petch", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffd23f'; ctx.shadowColor = '#ffd23f'; ctx.shadowBlur = 34;
    ctx.fillText('VS', 0, 0);
    ctx.restore();
  }
  const kickK = slam((G.lockinT-0.75)/0.4) * Math.max(0, Math.min(1, (2.2-G.lockinT)/0.3));
  if(kickK > 0){
    ctx.save();
    ctx.globalAlpha = kickK;
    ctx.font = '700 ' + Math.round(H*0.02) + 'px "Chakra Petch", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#9fe8ff'; ctx.shadowColor = '#9fe8ff'; ctx.shadowBlur = 18;
    ctx.fillText('L A S E R   N A T I O N S   ·   D U E L', W/2, cy+R+H*0.11);
    ctx.restore();
  }
  ctx.restore();
}

function renderDuel(){
  if(G.shake > 0.008) cv.style.transform = `translate(${vrr(-1,1)*G.shake*1.4}%, ${vrr(-1,1)*G.shake*1.4}%)`;
  else if(cv.style.transform !== 'translate(0px, 0px)') cv.style.transform = 'translate(0,0)';

  ctx.setTransform(Q,0,0,Q,0,0);
  ctx.fillStyle = '#0b0f19';
  ctx.fillRect(-30,-30, W+60, H+60);

  ctx.strokeStyle = 'rgba(122,142,205,.05)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for(let x=F.x; x<=F.x+F.w+1; x+=80){ ctx.moveTo(x+.5,F.y); ctx.lineTo(x+.5,F.y+F.h); }
  for(let y=F.y; y<=F.y+F.h+1; y+=80){ ctx.moveTo(F.x,y+.5); ctx.lineTo(F.x+F.w,y+.5); }
  ctx.stroke();

  ctx.save();
  ctx.strokeStyle = 'rgba(150,170,240,.4)';
  ctx.shadowColor = 'rgba(120,150,255,.5)'; ctx.shadowBlur = 20;
  ctx.lineWidth = 2;
  rrect(F.x,F.y,F.w,F.h,14); ctx.stroke();
  ctx.restore();

  ctx.save();
  rrect(F.x-1,F.y-1,F.w+2,F.h+2,14); ctx.clip();

  // the orbiting weapon — a solid rigid rod from the fighter out to a
  // spiked head, always spinning. Drawn as a thick coloured glow with a
  // bright core line down the middle, so it reads as a rigid metal bar
  // catching the light, not a wispy laser thread. No laser trails in duel
  // mode (that's the territory game's identity, not this one's).
  ctx.lineCap='round'; ctx.lineJoin='round';
  for(const f of G.factions){
    if(!f.alive) continue;
    const rw = DCFG.weaponRodW;
    ctx.save();
    ctx.globalCompositeOperation='lighter';
    ctx.strokeStyle = f.col; ctx.globalAlpha = .9; ctx.lineWidth = rw*2;
    ctx.shadowColor = f.col; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.moveTo(f.x,f.y); ctx.lineTo(f.wx,f.wy); ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = f.core; ctx.globalAlpha = .95; ctx.lineWidth = rw*0.7;
    ctx.beginPath(); ctx.moveTo(f.x,f.y); ctx.lineTo(f.wx,f.wy); ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation='lighter';
    ctx.translate(f.wx,f.wy); ctx.rotate(f.weaponAngle*3);
    ctx.fillStyle = f.core; ctx.shadowColor = f.col; ctx.shadowBlur = 16;
    const wr = DCFG.weaponHitR;
    ctx.beginPath();
    for(let i=0;i<6;i++){
      const a = i*Math.PI/3;
      ctx.lineTo(Math.cos(a)*wr*1.5, Math.sin(a)*wr*1.5);
      ctx.lineTo(Math.cos(a+Math.PI/6)*wr*0.55, Math.sin(a+Math.PI/6)*wr*0.55);
    }
    ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = f.col; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(f.wx,f.wy,wr*0.5,0,6.2832); ctx.stroke();
  }

  for(const p of G.perks){
    const puls = 0.7 + 0.3*Math.sin(G.t*6+p.spin);
    const col = { heal:'#4dff9e', shield:'#5ec8ff', rage:'#ff5252', haste:'#ffe14d' }[p.kind];
    ctx.save();
    ctx.globalCompositeOperation='lighter';
    ctx.translate(p.x,p.y); ctx.rotate(G.t*1.4+p.spin);
    ctx.fillStyle=col; ctx.globalAlpha=.9*puls; ctx.shadowColor=col; ctx.shadowBlur=18;
    perkGlyph(p.kind, DCFG.perkR*0.62);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle=col; ctx.globalAlpha=.55; ctx.lineWidth=2.4;
    ctx.beginPath(); ctx.arc(p.x,p.y,DCFG.perkR*puls,0,6.2832); ctx.stroke();
    ctx.restore();
  }

  ctx.globalCompositeOperation='lighter';
  for(const pt of G.parts){
    ctx.globalAlpha = Math.max(0, Math.min(1, pt.life*1.7));
    ctx.fillStyle = pt.col;
    ctx.beginPath(); ctx.arc(pt.x,pt.y,pt.r,0,6.2832); ctx.fill();
  }
  // weapon-hit impact rings — a quick expanding, fading shockwave on
  // whoever just got tagged, so a hit reads as a real "that connected"
  // moment and not just an unexplained dip in the health bar.
  for(const hr of G.hitRings){
    const k = 1 - hr.life;
    ctx.globalAlpha = Math.max(0, hr.life) * 0.8;
    ctx.strokeStyle = hr.col; ctx.lineWidth = 4 * hr.life + 1;
    ctx.shadowColor = hr.col; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(hr.x, hr.y, DCFG.ballR*0.6 + k*46, 0, 6.2832); ctx.stroke();
  }
  ctx.globalAlpha=1; ctx.globalCompositeOperation='source-over';

  for(const f of G.factions){
    if(!f.alive) continue;
    const R = f.r;
    ctx.save();
    ctx.globalCompositeOperation='lighter';
    ctx.strokeStyle=f.col; ctx.globalAlpha = f.rageT>0 ? .85 : .5; ctx.lineWidth = f.rageT>0 ? 6 : 4;
    ctx.shadowColor=f.col; ctx.shadowBlur = f.rageT>0 ? 20 : 12;
    ctx.beginPath(); ctx.arc(f.x,f.y,R+4,0,6.2832); ctx.stroke();
    if(f.shieldT > 0){
      ctx.strokeStyle='#5ec8ff'; ctx.globalAlpha=.6+0.25*Math.sin(G.t*8); ctx.lineWidth=3;
      ctx.beginPath(); ctx.arc(f.x,f.y,R+11,0,6.2832); ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.translate(f.x,f.y);
    ctx.beginPath(); ctx.arc(0,0,R,0,6.2832); ctx.clip();
    ctx.drawImage(f.flagS,-R,-R,R*2,R*2);
    ctx.restore();

    ctx.strokeStyle=f.core; ctx.lineWidth=2.5;
    ctx.beginPath(); ctx.arc(f.x,f.y,R,0,6.2832); ctx.stroke();
  }

  ctx.restore();

  const vg = ctx.createRadialGradient(F.cx,F.cy,F.h*0.3, F.cx,F.cy,F.h*0.72);
  vg.addColorStop(0,'rgba(0,0,0,0)'); vg.addColorStop(1,'rgba(3,4,9,.5)');
  ctx.fillStyle = vg;
  ctx.save(); rrect(F.x,F.y,F.w,F.h,14); ctx.clip(); ctx.fillRect(F.x,F.y,F.w,F.h); ctx.restore();

  drawHealthBars();
  if(G.state === 'lockin') drawVsCard();

  if(FX.bloom){
    bctx.clearRect(0,0,bloom.width,bloom.height);
    bctx.filter='blur(4px)';
    bctx.drawImage(cv,0,0,cv.width,cv.height,0,0,bloom.width,bloom.height);
    bctx.filter='none';
    ctx.setTransform(1,0,0,1,0,0);
    ctx.globalCompositeOperation='lighter';
    ctx.globalAlpha = 0.58 + Math.min(0.3, G.chroma*0.34);
    ctx.drawImage(bloom,0,0,cv.width,cv.height);
    ctx.globalAlpha=1;
    ctx.globalCompositeOperation='source-over';
  }
  if(G.flash > 0.01){
    ctx.setTransform(Q,0,0,Q,0,0);
    ctx.fillStyle = `rgba(205,222,255,${G.flash*0.09})`;
    ctx.fillRect(0,0,W,H);
  }
}

/* ═══ fight-poster cover frame — a single static composite (?poster=1),
   captured as one screenshot by render.mjs to use as the video thumbnail
   instead of an arbitrary mid-fight frame. Reuses the exact same flag
   primitives as the live game so it always matches. ═══ */
function drawPoster(){
  const pool = shuffle(COUNTRIES.slice());
  const findC = name => COUNTRIES.find(c => c.n === name);
  let ca = (DUEL_A && findC(DUEL_A)) || pool[0];
  let cb = (DUEL_B && findC(DUEL_B)) || pool.find(c => c !== ca) || pool[1];
  if(ca === cb) cb = pool.find(c => c !== ca) || pool[1];
  const hues = pickHues();

  ctx.setTransform(Q,0,0,Q,0,0);
  const bg = ctx.createRadialGradient(W/2,H*0.4,0, W/2,H*0.4,H*0.75);
  bg.addColorStop(0,'#151d34'); bg.addColorStop(0.55,'#0b0f19'); bg.addColorStop(1,'#040509');
  ctx.fillStyle = bg; ctx.fillRect(0,0,W,H);

  ctx.save();
  ctx.globalAlpha=.08; ctx.strokeStyle='#9fe8ff'; ctx.lineWidth=2;
  const cx=W/2, cyR=H*0.42;
  for(let i=0;i<28;i++){
    const a = i*(Math.PI*2/28);
    ctx.beginPath(); ctx.moveTo(cx,cyR); ctx.lineTo(cx+Math.cos(a)*H*0.9, cyR+Math.sin(a)*H*0.9); ctx.stroke();
  }
  ctx.restore();

  const flagA = flagCanvas(ca,640), flagB = flagCanvas(cb,640);
  const colA = hsl(hues[0],100,62), colB = hsl(hues[1],100,62);
  const R = W*0.30, spread = W*0.30;

  const badge = (flag, col, x, dir) => {
    ctx.save(); ctx.globalCompositeOperation='lighter';
    ctx.fillStyle=col; ctx.globalAlpha=.16; ctx.shadowColor=col; ctx.shadowBlur=70;
    ctx.beginPath(); ctx.arc(x,cyR,R,0,6.2832); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.arc(x,cyR,R,0,6.2832); ctx.clip();
    ctx.drawImage(flag, x-R+dir*R*0.18, cyR-R, R*2, R*2);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle=col; ctx.lineWidth=8; ctx.shadowColor=col; ctx.shadowBlur=30;
    ctx.beginPath(); ctx.arc(x,cyR,R,0,6.2832); ctx.stroke();
    ctx.restore();
  };
  badge(flagA,colA, cx-spread, 1);
  badge(flagB,colB, cx+spread, -1);

  ctx.save();
  ctx.font = '800 ' + Math.round(W*0.20) + 'px "Chakra Petch", sans-serif';
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillStyle='#ffd23f'; ctx.shadowColor='#ffd23f'; ctx.shadowBlur=60;
  ctx.fillText('VS', cx, cyR);
  ctx.lineWidth=4; ctx.strokeStyle='rgba(0,0,0,.55)'; ctx.shadowBlur=0;
  ctx.strokeText('VS', cx, cyR);
  ctx.restore();

  ctx.save();
  ctx.font = '800 ' + Math.round(W*0.062) + 'px "Chakra Petch", sans-serif';
  ctx.textAlign='center';
  ctx.fillStyle='#fff'; ctx.shadowColor=colA; ctx.shadowBlur=22;
  ctx.fillText(shortName(ca.n), cx-spread, cyR+R+W*0.11);
  ctx.shadowColor=colB;
  ctx.fillText(shortName(cb.n), cx+spread, cyR+R+W*0.11);
  ctx.restore();

  ctx.save();
  ctx.font = '700 ' + Math.round(W*0.032) + 'px "Chakra Petch", sans-serif';
  ctx.textAlign='center'; ctx.fillStyle='#9fe8ff'; ctx.shadowColor='#9fe8ff'; ctx.shadowBlur=20;
  ctx.fillText('L A S E R   N A T I O N S', cx, H*0.115);
  ctx.font = '700 ' + Math.round(W*0.028) + 'px "Chakra Petch", sans-serif';
  ctx.fillStyle='rgba(255,255,255,.85)'; ctx.shadowBlur=0;
  ctx.fillText('WHO WINS THE FIGHT?', cx, H*0.87);
  ctx.restore();
}

if(RENDER){
  // headless: expose the deterministic frame-stepping API once fonts + layout settle
  LN.step = () => {
    if(POSTER){ drawPoster(); LN.frame = 1; LN.done = true; return { frame:1, events:[], done:true }; }
    LN.frame += 1;
    advance(1 / FPS);
    const events = Sound._drain();
    let done = false;
    if(G.state === 'over' && G.t >= G.finishAt + END_HOLD) done = true;
    if(LN.frame >= LN._hardCap) done = true;
    LN.done = done;
    return { frame: LN.frame, events, done };
  };
  LN.result = () => {
    if(POSTER) return { seed: SEED, poster: true };
    if(DUEL){
      const [A,B] = G.factions, w = G.winner, l = G.loser;
      return {
        seed: SEED, mode: 'duel',
        map: 'laser-nations-duel', mapName: 'LASER NATIONS: DUEL',
        winner: w ? w.country.n : 'Draw',
        winnerHue: w ? w.hue : 200,
        winnerRgb: w ? hslRgb(w.hue, 1, 0.62) : [159, 232, 255],
        loser: l ? l.country.n : '',
        countries: G.factions.map(f => f.country.n),
        cause: w && l && l.hp <= 0 ? 'ko' : 'decision',
        winAtSec: +((G.finishAt || G.t)).toFixed(2),
        durationSec: +(LN.frame / FPS).toFixed(2),
        hpA: Math.round(A.hp), hpB: Math.round(B.hp), maxHp: DCFG.maxHp,
        hitsA: A.hits, hitsB: B.hits, clashesA: A.clashes, clashesB: B.clashes,
        hpHistory: G.hpHistory,
        frames: LN.frame, fps: FPS,
      };
    }
    const w = G.winner;
    return {
      seed: SEED,
      map: 'laser-nations',
      mapName: 'LASER NATIONS',
      winner: w ? w.country.n : 'Draw',
      winnerHue: w ? w.hue : 200,
      winnerRgb: w ? hslRgb(w.hue, 1, 0.62) : [159, 232, 255],
      colors: G.factions.map(f => f.country.n),
      countries: G.factions.map(f => f.country.n),
      winAtSec: +((G.finishAt || G.t)).toFixed(2),
      durationSec: +(LN.frame / FPS).toFixed(2),
      blackHole: !!vortexOn,
      score: w ? Math.round(w.score) : 0,
      scores: G.factions.map(f => Math.round(f.score)),
      cuts: w ? w.cuts : 0,
      kills: w ? w.kills : 0,
      tag: (el('winTag').textContent || '').trim(),
      frames: LN.frame,
      fps: FPS,
    };
  };
  const boot = async () => {
    try {
      if(document.fonts){
        document.fonts.load('500 16px "Chakra Petch"');
        document.fonts.load('600 16px "Chakra Petch"');
        document.fonts.load('700 92px "Chakra Petch"');
        document.fonts.load('800 92px "Chakra Petch"');
        await document.fonts.ready;
      }
    } catch(e){}
    if(POSTER){
      LN._hardCap = 1;
      LN.meta = { fps: FPS, totalFrames: 1, seed: SEED, width: W, height: H };
      return;
    }
    init();
    if(!DUEL){
      // re-measure the arena now that the real font metrics are in (duel mode
      // doesn't depend on the scoreboard's height, so it skips this)
      layoutArena();
      Object.assign(F, F0);
      F.cx = F.x + F.w/2; F.cy = F.y + F.h/2;
    }
    // duel has no fixed length (it ends at 0 hp) — its hard cap is a pure
    // safety backstop (DCFG.safetyCapSec), not a target duration like
    // territory mode's CFG.matchSec.
    LN._hardCap = Math.round(((DUEL ? DCFG.safetyCapSec : CFG.matchSec) + 10) * FPS);
    LN.meta = { fps: FPS, totalFrames: LN._hardCap, seed: SEED, width: W, height: H, blackHole: !!vortexOn, mode: DUEL ? 'duel' : 'territory' };
  };
  boot();
} else {
  if(POSTER){
    (async () => { try{ if(document.fonts) await document.fonts.ready; }catch(e){} drawPoster(); })();
  } else {
    init();
    if(document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if(!DUEL){ layoutArena(); Object.assign(F, F0); F.cx=F.x+F.w/2; F.cy=F.y+F.h/2; } });
    requestAnimationFrame(frame);
  }
}

window.LaserNations = { restart, seed: () => SEED, get game(){ return G; },
  setVortex(v){ vortexOn = !!v; setVortexBtn(); },
  duel: DUEL,
  countryList: () => COUNTRIES.map(c => c.n),
  getMatchup(){ return DUEL ? { a: G.factions[0].country.n, b: G.factions[1].country.n } : null; },
  setMatchup(a, b){
    if(!DUEL) return;
    pinA = a || ''; pinB = b || '';
    restart();
  },
};
window.LN = LN;

})();

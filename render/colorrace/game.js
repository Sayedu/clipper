"use strict";
(function(){
/* ═══════════════════════════════════════════════════════════════
   MARBLE RUSH — the clipper "Color race" content type.
   A faithful port of the user's Claude Design "Marble Rush.dc.html"
   (5 courses, chase camera, neon glow, photo finish). De-framework'd
   from the DC runtime, made fully deterministic from ?seed, and driven
   headlessly frame-by-frame by scripts/colorrace/render.mjs at 4K/60 fps.

   Changes from the source, per the brief:
     • NO leaderboard; the race ENDS the instant the first marble
       crosses the line; the winner is a big centred card.
     • boost pad  → 2× speed for 2 s (a lingering state, not just
       while-inside); mud pad → 0.5× speed for 2 s. The marble tints
       toward white (boost) / dims (mud) while the state is active.
     • friction eased 0.035 → 0.02 so the slide reads as slippery.
     • neon bloom (canvas shadowBlur) scales with the render resolution
       so the 4K frame glows the same proportion as the 720px design.
     • SPINNER / FORK courses made taller (+ gentler blades / speed cap)
       so a lucky bounce can't end a first-across race in ~5 s.
     • every course is now PROCEDURALLY GENERATED (obstacle positions,
       sizes, spacing and zone placement all draw from the seeded RNG)
       and sized directly from the requested race length, instead of a
       fixed hand-built template stretched/squashed with gravity — a
       40 s ask now builds a course long enough to actually take ~40 s,
       and no two runs of the same course look identical.
   ═══════════════════════════════════════════════════════════════ */

const QS = new URLSearchParams(location.search);
const RENDER = QS.get('render') === '1';
const SEED_PARAM = (parseInt(QS.get('seed') || '1', 10) >>> 0) || 1;
const FPS = Math.max(20, Math.min(60, parseInt(QS.get('fps') || '60', 10)));
const W = Math.max(320, parseInt(QS.get('w') || '1080', 10));
const H = Math.max(320, parseInt(QS.get('h') || '1920', 10));
const SS = Math.max(1, Math.min(4, parseFloat(QS.get('ss') || '2')));
const N = Math.max(3, Math.min(6, parseInt(QS.get('balls') || '4', 10)));
const SHAPE = QS.get('shape') === 'square' ? 'square' : 'circle';
const MAP_PARAM = QS.get('map') || 'random';   // 'random' | 0..4 | name
const TARGET_SEC = Math.max(12, Math.min(60, parseFloat(QS.get('sec') || '22')));
// Camera framing: 1 = the design's exact 1920-tall view. >1 pulls back (smaller
// marbles, more course). The design ships at 1 and that's the default.
const ZOOM = Math.max(1, Math.min(1.6, parseFloat(QS.get('zoom') || '1')));
const CAM_LEAD = 0.42;   // leader sits this far down the visible band (design value)
const END_HOLD = 3.6;    // how long the centred winner card holds before the video ends

const cv = document.getElementById('c');
const ctx = cv.getContext('2d', { alpha:false });
const el = id => document.getElementById(id);

const CR = { frame:0, done:false, meta:null, _hardCap:999999 };

/* ── deterministic RNG (mulberry32) ── */
let _s = 0;
function srand(s){ _s = s >>> 0; }
function rnd(){
  _s = _s + 0x6D2B79F5 | 0;
  let t = Math.imul(_s ^ _s >>> 15, 1 | _s);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}
const rr = (a,b) => a + rnd()*(b-a);
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(rnd()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
// visual-only RNG so decoupled render() never disturbs the sim stream
let _vs = 0;
const vrnd = () => { _vs = _vs + 0x6D2B79F5 | 0; let t = Math.imul(_vs ^ _vs >>> 15, 1 | _vs); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

/* ── config (design props + defaults) ── */
const NAMES_ALL = ['CYAN','MAGENTA','LIME','AMBER','CORAL','VIOLET'];
const COLS_ALL  = ['#00e7ff','#ff2d95','#b4ff2e','#ffb020','#ff5a3c','#a855f7'];
const KIND_COL = { wall:'#2b2f4a', edge:'#4a5080', bouncy:'#8b5cf6', boost:'#00ffa3', mud:'#ff3d71', gate:'#7a83a8' };
const GRAV_BASE = 2700, BOUNCE = 1;
const MAP_IDS = ['zigzag','pegstorm','spinner','fork','bumper'];

// gravity is fixed at the design's own value for every course now — length is
// controlled by how TALL the generated course is, not by fudging gravity to
// squeeze/stretch a fixed template. V_EFF = each course's *rough* expected
// descent rate (px of course per second of race) at that fixed gravity, used
// only to size the initial build — one entry per MAP_IDS index. Bouncy pegs
// gain a hair of energy per hit (by design, for the trampoline feel), so a
// long course can pick up a lucky streak and run well ahead of any fixed
// estimate; the real length control is the dynamic finish line below, which
// watches the actual pace and pulls the line in or pushes it out to land on
// TARGET_SEC regardless. ROW_H = each course's average section height, only
// used to keep the loop's iteration count sane.
const GRAV_TUNE = 1.0;
const V_EFF = [69, 424, 472, 997, 712];      // zigzag,pegstorm,spinner,fork,bumper
const ROW_H = [430, 200, 640, 1375, 460];
const RACE_OVERHEAD = 6;   // ~2.4s countdown + 3.6s end-hold spend no time descending
const RACE_SEC = Math.max(6, TARGET_SEC - RACE_OVERHEAD);   // time the finish line targets
// how much taller than the point-estimate to build, so the dynamic finish
// line below always has real course left to extend into if the run is faster
// than expected — cheap: draw() only ever renders what's on screen
const BUILD_BUFFER = 2.6;

let MARBLE_R = Math.max(20, Math.min(46, parseFloat(QS.get('r') || '29')));
let names = [], cols = [];        // per-run, shuffled
let SEED = 0;

/* ── build one of the five courses — procedurally generated every run from
   the seeded RNG (positions/sizes/spacing/zones all randomized within safe
   ranges), and grown tall enough to fill TARGET_SEC at the fixed gravity. ── */
function buildMap(id){
  const G = [], Z = [], S = [];
  const seg = (x1,y1,x2,y2,kind,rad) => G.push({ t:'s', x1,y1,x2,y2, kind:kind||'wall', rad: rad==null?11:rad });
  const peg = (x,y,r,kind) => G.push({ t:'c', x,y,r, kind:kind||'wall' });
  const zone = (x,y,w,h,kind) => Z.push({ x,y,w,h,kind });
  const spin = (x,y,len,speed,arms,kind) => S.push({ x,y,len,speed, arms:arms||2, rad:15, kind:kind||'bouncy', a: rnd()*6.28 });

  // the marble doesn't start falling at y=0 — it sits at the gate (y=660, +300
  // after the DY shift below = 960) until it opens, and the finish line sits
  // 80px above the bottom of the generated course (-380 finish inset +300 DY).
  // So the loop must run 1040px past its own starting y before V_EFF·RACE_SEC
  // of *actual descent* has been generated, or every short/fast target
  // undershoots (that fixed overhead ate a third of a 22s Zigzag course).
  // BUILD_BUFFER over-builds so `advance()`'s dynamic finish line always has
  // real course to extend into — see the note by V_EFF.
  const target = 1040 + V_EFF[id] * RACE_SEC * BUILD_BUFFER;
  const guard = Math.ceil(target / ROW_H[id]) + 40;   // generous iteration cap, just in case
  let name, tag, y, n = 0;

  if(id === 0){
    name='ZIGZAG RUSH'; tag='Slalom · trampolines · boost bands';
    y = 620;
    while(y < target && n++ < guard){
      // ramp side MUST alternate — that's what hands the marble from one
      // trampoline into the start of the next ramp. Randomizing this (as
      // every other parameter here is) let long runs repeat the same side
      // and strand the marble bouncing between a trampoline and a ramp it
      // can never reach.
      const dy = rr(170,240), left = n % 2 === 0;
      // the bounce peg is deliberately centred, clear of BOTH side walls and
      // BOTH possible ramp-endpoint zones, with margin worked out from the
      // worst case rather than guessed: a peg needs pegR+11(ramp cap)+2×46
      // (widest marble, diameter) = up to 139px of true separation from a
      // ramp's rounded end-cap to let one through — anything tighter and its
      // bounce-exclusion circle can go *tangent* to the cap (or the wall),
      // which is a stable trap: gravity holds the marble in, the obstacle's
      // normal holds it up, and there's zero net sideways force either way
      // to ever break the tie. x∈[400,680] vs an end-cap at worst 850/230
      // gives a 170px gap at only 60px of vertical separation (≥161px real
      // distance) — comfortably clear even at max peg/marble size. The
      // y-offset is capped below the *minimum* next-ramp gap (150) so it can
      // never reach into the next iteration's geometry either.
      peg(rr(400,680), y + dy + rr(60,140), rr(20,30), 'bouncy');
      if(left){ seg(rr(10,60), y, rr(850,940), y+dy); }
      else    { seg(rr(1020,1070), y, rr(140,230), y+dy); }
      if(rnd() < 0.16){
        const boost = rnd() < 0.55, full = rnd() < 0.6;
        zone(full ? 0 : rr(0,400), y+rr(30,80), full ? 1080 : rr(500,700), rr(150,200), boost?'boost':'mud');
      }
      y += dy + rr(150,220);
    }
  } else if(id === 1){
    name='PEG STORM'; tag='Plinko chaos · pure luck';
    y = 640;
    while(y < target && n++ < guard){
      // a funnel and a normal peg row are never placed in the same stretch —
      // a peg landing inside the funnel's gap could narrow it below marble
      // width, and there'd be no way to know until it wedges there
      if(rnd() < 0.1){
        seg(-40, y, rr(300,340), y+220); seg(1120, y, rr(740,780), y+220);
        y += 260; continue;
      }
      const off = rnd() < 0.5 ? rr(70,140) : 0, bouncy = rnd() < 0.22;
      for(let c=0;c<5;c++) peg(120 + off + c*216 + rr(-16,16), y, rr(14,20), bouncy ? 'bouncy' : 'wall');
      if(rnd() < 0.09) zone(rr(0,400), y+40, rr(400,520), rr(220,300), rnd()<0.5?'mud':'boost');
      y += rr(170,230);
    }
    if(n > 4){ seg(300,y-380,300,y-40,'bouncy',12); seg(780,y-380,780,y-40,'bouncy',12); }   // a funnel to the line
  } else if(id === 2){
    // taller than the design so a lucky bounce can't end the race in ~5 s now
    // that first-across wins; blade rpm eased from the design's 2.6/2.9.
    name='SPINNER GAUNTLET'; tag='Rotating blades · big swings';
    y = 800;
    while(y < target && n++ < guard){
      const left = rnd() < 0.5, len = rr(220,300), arms = rnd() < 0.15 ? 3 : 2;
      spin(left ? rr(340,420) : rr(660,740), y, len, (left?1:-1) * rr(1.9,2.4), arms);
      seg(left ? rr(820,900) : 0, y+230, left ? 1080 : rr(180,260), y+230, 'bouncy', 13);
      if(rnd() < 0.2) zone(0, y+300, 1080, rr(200,260), rnd() < 0.3 ? 'mud' : 'boost');
      y += rr(560,720);
    }
  } else if(id === 3){
    name='THE FORK'; tag='Pick a lane · one is a trap';
    y = 700;
    while(y < target && n++ < guard){
      const fastLeft = rnd() < 0.5, pegCount = 2 + Math.floor(rnd()*3);
      peg(540, y-40, rr(28,40), 'bouncy');
      seg(540,y,250,y+300); seg(540,y,830,y+300);
      // the outer "shoulder" ledges were removed — they jutted into the dead
      // space beyond the lane walls (x<250 / x>830) and a marble knocked out
      // there would snag on ledge after ledge all the way down. With them
      // gone that space is a clean drop-through: a stray marble just falls
      // past and rejoins at the funnels below instead of needing a rescue
      // every couple of seconds. The apex peg + diamond already funnel
      // centre traffic into the V.
      seg(250,y+300,250,y+900,'bouncy',12); seg(830,y+300,830,y+900,'bouncy',12);
      zone(fastLeft?20:560, y+340, 500, 520, 'boost');
      zone(fastLeft?560:20, y+340, 500, 520, 'mud');
      // lane pegs sit toward the slow half but must keep a full marble-width
      // (58px) clear of BOTH bouncy lane walls (x=250 / x=830) — at the old
      // px=690/250 the +120 alternation put a peg's edge at x=834, past the
      // x=830 wall, pinching a sub-marble-width gap a marble could wedge in
      // and never leave. x∈[440,660] here is ≥150px off either wall.
      const px = fastLeft ? 640 : 440, pdir = fastLeft ? -1 : 1;
      for(let k=0;k<pegCount;k++) peg(px + pdir*(k%2?100:0), y+420+k*170, rr(14,20), 'wall');
      seg(250,y+900,480,y+1120); seg(830,y+900,600,y+1120);
      y += 1120 + rr(130,380);
    }
  } else {
    name='BUMPER PARK'; tag='Giant bumpers · pinball chaos';
    y = 820;
    while(y < target && n++ < guard){
      // kept well clear of the centre peg — at the old radii/positions the
      // gap between the big bumper and the centre peg could pinch to under a
      // marble's width, which is what wedged a marble bouncing between them
      const odd = rnd() < 0.5;
      peg(odd ? rr(260,330) : rr(750,820), y, rr(48,62), 'bouncy');
      peg(odd ? rr(760,840) : rr(240,320), y+rr(180,240), rr(26,38), 'bouncy');
      peg(540, y+rr(90,130), rr(16,24), 'wall');
      if(rnd() < 0.32){ seg(-40, y-130, rr(260,340), y-40); seg(1120, y-130, rr(740,820), y-40); }
      if(rnd() < 0.13) zone(rr(0,150), y+rr(220,270), rr(700,900), rr(180,230), rnd()<0.5?'mud':'boost');
      y += rr(400,520);
    }
  }

  const DY = 300;
  for(const o of G){ if(o.t==='s'){ o.y1+=DY; o.y2+=DY; } else o.y+=DY; }
  for(const z of Z) z.y += DY;
  for(const sp of S) sp.y += DY;
  const Hgt = y + DY;
  const finishY = Hgt - 380;
  const start = [];   // design: x = 200 + i*226 for 4 — spread evenly for any N
  for(let i=0;i<N;i++) start.push({ x: 200 + i*(678/(N-1)), y: 470 + (i%2)*44 });
  const gate = { t:'s', x1:60, y1:660, x2:1020, y2:660, kind:'gate', rad:12, gate:true };
  G.push(gate);
  const grid = {};
  const push = (o,a,b) => { for(let r = Math.floor(a/300)-1; r <= Math.floor(b/300)+1; r++) (grid[r] || (grid[r]=[])).push(o); };
  for(const o of G){
    if(o.t==='s') push(o, Math.min(o.y1,o.y2)-o.rad, Math.max(o.y1,o.y2)+o.rad);
    else push(o, o.y-o.r, o.y+o.r);
  }
  return { id, name, tag, H:Hgt, geo:G, zones:Z, spinners:S, start, finishY, grid, gate };
}

/* ═══════════════ audio (event recorder in render mode) ═══════════════ */
const _PENTA = [];
for(let o=0;o<2;o++) for(const s of [0,2,4,7,9]) _PENTA.push(130.81 * Math.pow(2, o + s/12));

function makeSoundRecorder(){
  let buf = [], last = -9;
  const push = o => { o.t = +W_.time.toFixed(4); o.f = CR.frame; buf.push(o); };
  return {
    _drain(){ const b = buf; buf = []; return b; },
    hit(imp, x, kind){
      if(W_.time - last < 0.05) return; last = W_.time;
      push({ type:'hit', imp:+Math.min(1, imp).toFixed(3), x: clamp01(x), kind: kind==='bouncy'?'b':'w' });
    },
    zone(kind, x){ push({ type: kind==='boost'?'boost':'mud', x: clamp01(x) }); },
    count(n){ push({ type:'count', n }); },
    finish(pos){ push({ type:'finish', pos }); },
    win(){ push({ type:'win' }); },
  };
}
const clamp01 = x => x==null ? .5 : (x<0?0:x>1?1:x);

/* ═══════════════ world ═══════════════ */
let W_ = null, S_ = null;   // world, ui-state
const props = { marbleSize: MARBLE_R, gravity: GRAV_BASE, bounciness: BOUNCE, shape: SHAPE };
let Sound = null;

function pickMap(){
  if(MAP_PARAM === 'random') return Math.floor(rnd() * 5);
  const n = parseInt(MAP_PARAM, 10);
  if(!isNaN(n) && n >= 0 && n < 5) return n;
  const i = MAP_IDS.indexOf(MAP_PARAM);
  return i >= 0 ? i : Math.floor(rnd() * 5);
}

function init(){
  SEED = SEED_PARAM;
  srand(SEED);
  _vs = (SEED ^ 0x9e3779b9) >>> 0;

  // shuffle the colour set for this run, take N
  const idx = shuffle([0,1,2,3,4,5]).slice(0, N);
  names = idx.map(i => NAMES_ALL[i]);
  cols  = idx.map(i => COLS_ALL[i]);

  const m = buildMap(pickMap());
  m.gate.open = false;
  const R = MARBLE_R;
  W_ = {
    map:m, time:0, cam:0, timeScale:1, phase:'count', finished:0, winnerIdx:-1, sparks:[],
    countLast:'', overAt:0, goTime:0, gravTune: (props.gravity / 2700) * GRAV_TUNE,
    marbles: m.start.map((s,i) => ({
      i, x: s.x + (rnd()-0.5)*30, y: s.y, vx: (rnd()-0.5)*60, vy: 0,
      r:R, trail:[], done:false, t:0, rank:0, best:s.y, still:0, stall:0, drift:0, flash:0,
      boostT:0, mudT:0, rescueT:0, hist:[], histT:0,
    })),
  };
  Sound = RENDER ? makeSoundRecorder() : liveSound();
  S_ = { countdown:'3', slowmo:false, winner:null, winnerColor:'#fff' };
  el('mapName').textContent = m.name;
  el('maptag').textContent = m.tag;
  const win = el('win');
  win.classList.remove('show'); win.style.opacity = '';
  el('winName').style.transform = '';
  el('photo').classList.remove('show');
  el('count').style.opacity = 1;
  el('countN').textContent = '3';
  hud(true);
}

// true only if a marble-sized circle at (x,y) is fully clear of every solid
// (wall/peg/spinner) and stays on the track — the exact same tests the real
// per-substep collision loop below uses, just as a read-only query. This is
// what makes the anti-stall rescue safe: it only ever *proposes* landing
// spots that pass this, so it can never place a marble inside — or on the
// far side of — geometry it didn't actually clear.
function clearAt(m, x, y, r){
  if(x < r + 16 || x > 1080 - r - 16) return false;
  if(y > m.H - 40) return false;
  const row = m.grid[Math.floor(y / 300)] || [];
  for(const o of row){
    if(o.gate && m.gate.open) continue;
    if(o.t === 's'){
      const dx = o.x2 - o.x1, dy = o.y2 - o.y1, L2 = dx*dx + dy*dy || 1;
      let t = ((x - o.x1)*dx + (y - o.y1)*dy) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if(Math.hypot(x - (o.x1 + dx*t), y - (o.y1 + dy*t)) < r + o.rad) return false;
    } else if(Math.hypot(x - o.x, y - o.y) < r + o.r) return false;
  }
  for(const sp of m.spinners){
    if(Math.abs(y - sp.y) > sp.len + r + 40) continue;
    for(let a = 0; a < sp.arms; a++){
      const ang = sp.a + (a * Math.PI * 2) / sp.arms;
      const ex = sp.x + Math.cos(ang)*sp.len, ey = sp.y + Math.sin(ang)*sp.len;
      const dx = ex - sp.x, dy = ey - sp.y, L2 = dx*dx + dy*dy || 1;
      let t = ((x - sp.x)*dx + (y - sp.y)*dy) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if(Math.hypot(x - (sp.x + dx*t), y - (sp.y + dy*t)) < r + sp.rad) return false;
    }
    if(Math.hypot(x - sp.x, y - sp.y) < r + 26) return false;
  }
  return true;
}
// a landing spot is only as safe as the road to it — sample the straight line
// every ~8 px (finer than the thinnest wall in the game, rad 11) so nothing
// in between the old and new spot can ever be skipped over.
function clearPath(m, x0, y0, x1, y1, r){
  const d = Math.hypot(x1 - x0, y1 - y0), steps = Math.max(1, Math.ceil(d / 8));
  for(let i = 1; i <= steps; i++){
    const t = i / steps;
    if(!clearAt(m, x0 + (x1 - x0)*t, y0 + (y1 - y0)*t, r)) return false;
  }
  return true;
}

/* ═══════════════ physics (ported; + 2 s timed boost/mud) ═══════════════ */
function step(dt){
  const w = W_, m = w.map;
  const g = 2700 * w.gravTune;
  const bounce = props.bounciness;
  for(const sp of m.spinners) sp.a += sp.speed * dt;

  const hit = (b, px, py, rad, kind, svx, svy) => {
    let nx = b.x - px, ny = b.y - py, d = Math.hypot(nx, ny), min = b.r + rad;
    if(d >= min) return;
    if(d < 1e-6){ nx = 0; ny = -1; d = 1; }
    nx /= d; ny /= d;
    b.x += nx * (min - d); b.y += ny * (min - d);
    const rvx = b.vx - (svx||0), rvy = b.vy - (svy||0), vn = rvx*nx + rvy*ny;
    if(vn < 0){
      const e = (kind === 'bouncy' ? 1.02 : 0.44) * bounce;
      let ox = rvx - (1+e)*vn*nx, oy = rvy - (1+e)*vn*ny;
      const tx = -ny, ty = nx, vt = ox*tx + oy*ty, f = 0.02;   // less tangential rub → slippery
      ox -= vt*f*tx; oy -= vt*f*ty;
      b.vx = ox + (svx||0); b.vy = oy + (svy||0);
      const imp = -vn;
      if(imp > 240){
        b.flash = Math.min(1, imp / 1400);
        Sound.hit(imp / 1400, px / 1080, kind);
        if(w.sparks.length < 240) for(let k=0;k<3;k++)
          w.sparks.push({ x: px + nx*rad, y: py + ny*rad,
            vx: nx*imp*0.3 + (rnd()-.5)*200, vy: ny*imp*0.3 + (rnd()-.5)*200,
            life:1, c: kind === 'bouncy' ? '#c4b5fd' : cols[b.i] });
      }
    }
  };

  // last-resort unstuck: a marble wedged between two contacts can reach a
  // genuinely stable equilibrium where the position-correction in `hit()`
  // above undoes any extra velocity every single substep, so more force (or
  // more bounce) never accumulates into real motion — confirmed by telemetry
  // (vy pinned dead constant for 30+ s straight even at max ramp). The only
  // real fix for a stable deadlock is to actually relocate past it, so this
  // searches for the *nearest* point that's forward progress AND fully clear
  // of every wall/peg/spinner along the whole path to it — never just the
  // destination — so it's exactly as safe from tunneling as normal movement.
  const tryEscape = (b) => {
    const lo = b.r + 16, hi = 1080 - b.r - 16;
    // best candidates first: a spot another marble actually occupied is
    // proof a route through this exact course passes there — far more
    // reliable than guessing, since a zigzag ramp spans nearly the whole
    // width and a blind "looks open" point has real odds of being on the
    // wrong side of one. Scan oldest→newest so the nearest real progress
    // (smallest y past this marble's best) wins.
    for(const o of w.marbles){
      if(o === b || !o.hist.length) continue;
      for(const p of o.hist){
        if(p.y <= b.best) continue;
        if(clearAt(m, p.x, p.y, b.r) && clearPath(m, b.x, b.y, p.x, p.y, b.r)) return { x: p.x, y: p.y };
      }
    }
    // a zigzag ramp can span nearly the full 1080 width, so a marble wedged
    // on the closed side of one needs room to walk all the way around its
    // end, not just a small nudge — scan outward (drift side first) across
    // the whole track at this depth, closest offset wins.
    const scanFrom = (ox, oy, ny, requireProgress) => {
      if(requireProgress && ny <= b.best) return null;
      // try the open middle of the track first — whatever local cluster of
      // obstacles just trapped this marble is very unlikely to also crowd
      // the centre, so this resolves most escapes with one clean jump
      // instead of hopping to the next equally-cramped spot right next door.
      for(const cx of [540, 300, 780]){
        if(clearAt(m, cx, ny, b.r) && clearPath(m, ox, oy, cx, ny, b.r)) return { x: cx, y: ny };
      }
      // a same-row shuffle must clear the trap for real — a 36px hop in a
      // narrow lane just slides the marble to a spot it drifts straight back
      // from, and it re-triggers every 0.7s forever (a livelock). Require a
      // genuine ≥110px move (roughly two marble radii) so it lands in
      // meaningfully different territory.
      const minStep = requireProgress ? 36 : 110;
      for(let dx = requireProgress ? 0 : minStep; dx <= hi - lo; dx += 36){
        const xs = dx === 0 ? [ox] : [ox + b.drift*dx, ox - b.drift*dx];
        for(const cx of xs){
          const nx = Math.max(lo, Math.min(hi, cx));
          // reject a candidate that (after clamping to the edges) doesn't
          // actually move the marble far enough to matter — a no-op "escape"
          // that reports success and changes nothing.
          if(Math.abs(nx - ox) < (requireProgress ? 1 : minStep) && Math.abs(ny - oy) < 1) continue;
          if(clearAt(m, nx, ny, b.r) && clearPath(m, ox, oy, nx, ny, b.r)) return { x: nx, y: ny };
        }
      }
      return null;
    };
    const depths = [40, 90, 150, 220, 300, 400, 520, 650];
    for(const dy of depths){ const esc = scanFrom(b.x, b.y, b.y + dy, true); if(esc) return esc; }
    const shuffle = scanFrom(b.x, b.y, b.y, false);
    if(shuffle) return shuffle;
    // still nothing on a straight line from here — a marble resting exactly
    // in the tangent gap between a wall and an obstacle's own bounce circle
    // can have a real nearby exit that's simply not visible from *this*
    // point, because the direct line to it clips the very obstacle it's
    // wedged against (proven: a valid spot 70px away was unreachable in a
    // straight line, only around a two-leg corner). Lift straight up first
    // — that direction is open in practice, since gravity is what put it
    // here — then re-run the same search treating the lifted spot as the
    // new vantage point. Both legs are still fully clearPath-verified, so
    // this is exactly as tunnel-proof as a single straight hop.
    for(const lift of [70, 140, 220, 320]){
      const wy = b.y - lift;
      if(wy < 0 || !clearAt(m, b.x, wy, b.r) || !clearPath(m, b.x, b.y, b.x, wy, b.r)) continue;
      for(const dy of depths){ const esc = scanFrom(b.x, wy, b.y + dy, true); if(esc) return esc; }
      const wShuffle = scanFrom(b.x, wy, wy, false);
      if(wShuffle) return wShuffle;
    }
    return null;
  };

  for(const b of w.marbles){
    // 2 s timed speed state — boost pad = 2×, mud pad = 0.5×
    if(b.boostT > 0) b.boostT -= dt;
    if(b.mudT   > 0) b.mudT   -= dt;
    const ms = b.boostT > 0 ? 2.0 : b.mudT > 0 ? 0.5 : 1.0;

    b.vy += g * dt;
    b.x += b.vx * dt * ms; b.y += b.vy * dt * ms;

    const lo = b.r + 16, hi = 1080 - b.r - 16;
    if(b.x < lo){ b.x = lo; b.vx = Math.abs(b.vx) * 0.55; }
    if(b.x > hi){ b.x = hi; b.vx = -Math.abs(b.vx) * 0.55; }
    if(b.y > m.H - 40){ b.y = m.H - 40; b.vy = -Math.abs(b.vy) * 0.3; }

    const row = m.grid[Math.floor(b.y / 300)] || [];
    for(const o of row){
      if(o.gate && m.gate.open) continue;
      if(o.t === 's'){
        const dx = o.x2 - o.x1, dy = o.y2 - o.y1, L2 = dx*dx + dy*dy || 1;
        let t = ((b.x - o.x1)*dx + (b.y - o.y1)*dy) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        hit(b, o.x1 + dx*t, o.y1 + dy*t, o.rad, o.kind);
      } else hit(b, o.x, o.y, o.r, o.kind);
    }
    for(const sp of m.spinners){
      if(Math.abs(b.y - sp.y) > sp.len + b.r + 40) continue;
      for(let a=0;a<sp.arms;a++){
        const ang = sp.a + (a * Math.PI * 2) / sp.arms;
        const ex = sp.x + Math.cos(ang)*sp.len, ey = sp.y + Math.sin(ang)*sp.len;
        const dx = ex - sp.x, dy = ey - sp.y, L2 = dx*dx + dy*dy;
        let t = ((b.x - sp.x)*dx + (b.y - sp.y)*dy) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = sp.x + dx*t, py = sp.y + dy*t;
        hit(b, px, py, sp.rad, sp.kind, -(py - sp.y)*sp.speed, (px - sp.x)*sp.speed);
      }
      hit(b, sp.x, sp.y, 26, 'wall');
    }
    for(const z of m.zones){
      if(b.x > z.x && b.x < z.x + z.w && b.y > z.y && b.y < z.y + z.h){
        if(z.kind === 'boost'){ if(b.boostT <= 0) Sound.zone('boost', b.x/1080); b.boostT = 2.0; b.mudT = 0; }
        else                  { if(b.mudT   <= 0) Sound.zone('mud',   b.x/1080); b.mudT   = 2.0; b.boostT = 0; }
      }
    }

    const sp2 = Math.hypot(b.vx, b.vy);
    // design cap 2900 — lowered so a blade/trampoline can't catapult a marble
    // to the finish in ~5 s (the race ends on first-cross now)
    if(sp2 > 2050){ b.vx *= 2050 / sp2; b.vy *= 2050 / sp2; }
    // anti-stall — real physics only, no teleports and no instant velocity
    // jolts. A marble that isn't making progress just gets its OWN gravity
    // smoothly ramped up the longer it sits there (still gravity, just
    // working harder — not a foreign force), plus a whisper of horizontal
    // drift (a real marble is never balanced in a perfectly frictionless,
    // perfectly symmetric notch — this stands in for that asymmetry so it
    // doesn't balance forever). Both are a continuous `+= dt` every substep,
    // so velocity only ever changes gradually — it can never visibly
    // "speed up on its own", and since nothing here ever moves b.y/b.x in
    // one jump, it can't skip over — or land past — a wall or the floor the
    // way a position-based rescue could.
    // a lightweight breadcrumb trail (distinct from the short visual trail
    // above) — if ANOTHER marble is later found wedged somewhere, any point
    // any marble actually occupied is proof a route through THIS course
    // passes there, which a blind geometric search has no way to know
    // (a zigzag ramp spans almost the full width, so a straight line to an
    // arbitrary "open-looking" point has real odds of clipping one anyway).
    b.histT -= dt;
    if(b.histT <= 0 && !b.done){ b.histT = 0.35; b.hist.push({ x: b.x, y: b.y }); }
    if(b.y > b.best + 6){ b.best = b.y; b.stall = 0; }
    else if(!b.done){
      if(b.y > b.best) b.best = b.y;   // still track the true best for progress/results
      // a marble wedged in a V-notch can be self-locking — more DOWNWARD force
      // just presses it harder into both walls (like a wedge/chock) instead of
      // freeing it, since only a sideways push actually overcomes that. So the
      // escape push picks ONE direction per stuck episode and holds it (real
      // per-substep RANDOM jitter has zero mean — it can't reliably build up
      // real sideways motion, it just cancels itself out).
      if(b.stall === 0) b.drift = rnd() < 0.5 ? -1 : 1;
      b.stall += dt;
      if(b.stall > 0.5){
        const k = Math.min(4.5, (b.stall - 0.5) * 0.5);   // ramps to 5.5× gravity over ~9.5s stuck
        b.vy += g * k * dt;
        b.vx += b.drift * (60 + k * 130) * dt;
      }
      // give the soft push above a few seconds to work on its own before
      // falling back to a verified-safe relocation — most stalls (a slow
      // roll, a shallow ledge) resolve well before this ever fires, so the
      // rescue stays rare and only steps in for a true geometric deadlock.
      if(b.stall > 5){
        b.rescueT -= dt;
        if(b.rescueT <= 0){
          b.rescueT = 1.0;
          const esc = tryEscape(b);
          if(esc){
            const jump = Math.hypot(esc.x - b.x, esc.y - b.y);
            b.x = esc.x; b.y = esc.y; b.best = Math.max(b.best, esc.y);
            b.vx = b.drift * 160; b.vy = Math.max(b.vy, 240);
            // keep it visually quiet — these fire often on snag-prone courses
            // and a flash + sound + spark burst every time would read as a
            // glitch. Only a big teleport (the rare full relocation) gets a
            // subtle spark puff; a normal little nudge past a ledge shows
            // nothing at all, so it just looks like the marble worked free.
            if(jump > 260 && w.sparks.length < 240) for(let k=0;k<4;k++)
              w.sparks.push({ x: b.x, y: b.y, vx: (rnd()-.5)*260, vy: -140 - rnd()*180,
                life:1, c: cols[b.i] });
          }
        }
      }
    }
    if(sp2 < 40 && !b.done){
      b.still += dt;
      if(b.still > 0.5) b.vx += (b.drift || (rnd()<0.5?-1:1)) * 90 * dt;   // it's at rest, not just failing to descend
    } else b.still = 0;

    // the world has a floor — always true, not a rescue: re-clamp after the
    // above so nothing this frame can leave a marble resting past it
    if(b.y > m.H - 40){ b.y = m.H - 40; b.vy = -Math.abs(b.vy) * 0.3; }

    if(!b.done && b.y > m.finishY){
      b.done = true; b.t = w.time; w.finished++; b.rank = w.finished;
      if(w.finished === 1){ w.winnerIdx = b.i; Sound.finish(1); announce(b); }
    }
    if(b.flash > 0) b.flash -= dt * 4;
  }

  for(let i=0;i<w.marbles.length;i++) for(let j=i+1;j<w.marbles.length;j++){
    const a = w.marbles[i], b = w.marbles[j];
    let nx = b.x - a.x, ny = b.y - a.y, d = Math.hypot(nx, ny), min = a.r + b.r;
    if(d >= min || d < 1e-6) continue;
    nx /= d; ny /= d;
    const c = (min - d) / 2;
    a.x -= nx*c; a.y -= ny*c; b.x += nx*c; b.y += ny*c;
    const vn = (b.vx - a.vx)*nx + (b.vy - a.vy)*ny;
    if(vn < 0){ const p = -(1 + 0.92)*vn / 2; a.vx -= p*nx; a.vy -= p*ny; b.vx += p*nx; b.vy += p*ny; a.flash = b.flash = 0.7; }
  }

  for(const s of w.sparks){ s.vy += 1400*dt; s.x += s.vx*dt; s.y += s.vy*dt; s.life -= dt*2.2; }
  w.sparks = w.sparks.filter(s => s.life > 0);
}

function announce(b){ S_.winner = names[b.i]; S_.winnerColor = cols[b.i]; Sound.win(); }

// marbles ordered by how far down the course they got (winner first) — for the result JSON
function orderByProgress(){
  return W_.marbles.slice().sort((a,b) => (b.done - a.done) || (b.best - a.best)).map(b => names[b.i]);
}

/* ═══════════════ advance one frame ═══════════════ */
let acc = 0, hudAcc = 0;
function advance(dt){
  const w = W_, m = w.map;
  w.time += dt;

  if(w.phase === 'count'){
    const left = 2.4 - w.time;   // slightly quicker than the source's 2.6
    const cd = left > 1.55 ? '3' : left > 0.8 ? '2' : left > 0.05 ? '1' : 'GO';
    if(w.countLast !== cd){ w.countLast = cd; S_.countdown = cd; el('countN').textContent = cd; Sound.count(cd); }
    if(left < 0.05) m.gate.open = true;
    if(left < -0.4){ w.phase = 'run'; w.goTime = w.time; S_.countdown = null; el('count').style.opacity = 0; }
  }

  const lead = w.marbles.reduce((a,b) => (b.best > a.best ? b : a), w.marbles[0]);
  const sorted = w.marbles.slice().sort((a,b) => b.best - a.best);
  const closeRace = sorted[1] && sorted[0].best - sorted[1].best < 260;
  const near = m.finishY - lead.best;
  const slow = w.phase === 'run' && w.finished === 0 && near < 620 && near > -60 && closeRace;
  w.timeScale += ((slow ? 0.32 : 1) - w.timeScale) * Math.min(1, dt * 9);
  if(S_.slowmo !== slow){ S_.slowmo = slow; el('photo').classList.toggle('show', slow); }

  // dynamic finish line — bouncy pegs gain a hair of speed per hit (by design,
  // for the trampoline feel), so a lucky long course can run well ahead of any
  // fixed-height estimate. Once the leader's pace is a reliable sample, keep
  // nudging the line toward wherever that OBSERVED average pace says it needs
  // to be to land the finish on RACE_SEC — self-corrects whether the course
  // is running faster or slower than expected. Frozen once the sprint to the
  // line is close (>94%) so the last stretch doesn't visibly move the goal.
  if(w.phase === 'run' && w.finished === 0){
    const elapsed = w.time - w.goTime, frac = elapsed / RACE_SEC;
    if(frac > 0.3 && frac < 0.94){
      const rate = lead.best / Math.max(0.5, elapsed);
      // never chase the line past the generated course — if pace is far
      // beyond even the build buffer, settle short of the floor rather than
      // stranding the marble bouncing against the bottom clamp forever
      const idealFinish = Math.min(m.H - 450, lead.best + rate * Math.max(0.4, RACE_SEC - elapsed));
      m.finishY += (idealFinish - m.finishY) * Math.min(1, dt * 1.0);
    }
  }

  // 5 substeps is the design value; only tighten during a 2× boost, where a
  // marble can otherwise cross enough ground in one substep to skip clean
  // through a thin wall without ever registering the collision. Safe to vary
  // now that the dynamic finish line (not a fixed substep count) is what
  // keeps race length on target.
  const sub = w.marbles.some(b => b.boostT > 0) ? 9 : 5;
  const sdt = (dt * w.timeScale) / sub;
  if(w.phase !== 'over') for(let k=0;k<sub;k++){
    step(sdt);
    // sample the trail 2×/frame so the streak stays smooth at speed
    if(k === 1 || k === 3)
      for(const b of w.marbles){ b.trail.push(b.x, b.y); if(b.trail.length > 22) b.trail.splice(0, 2); }
  }

  // the race ends the instant the first marble crosses the line
  if(w.finished >= 1 && w.phase !== 'over'){ w.phase = 'over'; w.overAt = w.time; revealWin(); }
  if(w.phase === 'over'){
    // pop the centred winner card in from sim time (CSS animation is off in render mode)
    const p = Math.min(1, (w.time - w.overAt) / 0.26);
    const eo = 1 - Math.pow(1 - p, 3);
    el('win').style.opacity = eo;
    el('winName').style.transform = 'scale(' + (0.8 + 0.2 * eo).toFixed(3) + ')';
    // sim is frozen — let the trails fade out
    for(const b of w.marbles){ if(b.trail.length > 2) b.trail.splice(0, 2); }
  }

  // camera — leader CAM_LEAD down the visible band (design: 0.42 of a 1920 view)
  const visH = H * ZOOM;
  const targ = Math.max(0, Math.min(m.H - visH, lead.y - visH * CAM_LEAD));
  w.cam += (targ - w.cam) * Math.min(1, dt * 4.5);

  draw();
  hudAcc += dt;
  if(hudAcc > (RENDER ? 0 : 0.11)){ hudAcc = 0; hud(); }
}

function revealWin(){
  const win = el('win'), nameEl = el('winName');
  nameEl.textContent = S_.winner || 'DRAW';
  win.style.setProperty('--wc', S_.winnerColor);
  win.classList.add('show');
  win.style.opacity = 0;
  el('photo').classList.remove('show');
  el('hookline').style.visibility = 'hidden';
  // 15cqw fits every colour name; shrink only if a wild one ever appears
  fitText(nameEl, stageW() * 0.92, null);
}

/* ═══════════════ draw (ported; + zoom + boost/mud marble tint) ═══════════════ */
function draw(){
  const w = W_, m = w.map;
  const Sx = (cv.width / W);                     // backing px per logical px
  const world = Sx / ZOOM;                       // world px → backing px
  const offX = (cv.width - 1080 * world) / 2;    // centre the 1080-wide world
  // canvas shadowBlur is in device px and ignores the transform — scale it so
  // the neon bloom is the same fraction of the frame as on the 720px design.
  const BL = cv.width / 720;

  ctx.setTransform(1,0,0,1,0,0);
  const grad = ctx.createLinearGradient(0,0,0,cv.height);
  grad.addColorStop(0,'#0a0a18'); grad.addColorStop(1,'#05050b');
  ctx.fillStyle = grad; ctx.fillRect(0,0,cv.width,cv.height);

  ctx.setTransform(world, 0, 0, world, offX, -w.cam * world);
  const top = w.cam - 120, bot = w.cam + (H * ZOOM) + 200;

  // distance markers + rails
  ctx.strokeStyle = 'rgba(255,255,255,.035)'; ctx.lineWidth = 2;
  for(let y = Math.floor(top / 200) * 200; y < bot; y += 200){
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1080, y); ctx.stroke();
    const left = Math.max(0, Math.round((m.finishY - y) / 100) * 10);
    if(left > 0){ ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.font = '600 26px "Chakra Petch",sans-serif'; ctx.fillText(left + 'm', 24, y - 14); }
  }
  ctx.fillStyle = 'rgba(255,255,255,.045)'; ctx.fillRect(0, top, 16, bot - top); ctx.fillRect(1064, top, 16, bot - top);

  // zones
  for(const z of m.zones){
    if(z.y > bot || z.y + z.h < top) continue;
    const c = z.kind === 'boost' ? '0,255,163' : '255,61,113';
    const g2 = ctx.createLinearGradient(0, z.y, 0, z.y + z.h);
    g2.addColorStop(0, 'rgba(' + c + ',.02)'); g2.addColorStop(.5, 'rgba(' + c + ',.16)'); g2.addColorStop(1, 'rgba(' + c + ',.02)');
    ctx.fillStyle = g2; ctx.fillRect(z.x, z.y, z.w, z.h);
    ctx.strokeStyle = 'rgba(' + c + ',.5)'; ctx.lineWidth = 3;
    const ph = (w.time * (z.kind === 'boost' ? 260 : -90)) % 90;
    for(let y = z.y + ph - 90; y < z.y + z.h; y += 90){
      for(let x = z.x + 60; x < z.x + z.w - 20; x += 130){
        if(y < z.y || y > z.y + z.h - 10) continue;
        ctx.beginPath();
        if(z.kind === 'boost'){ ctx.moveTo(x - 26, y - 14); ctx.lineTo(x, y + 12); ctx.lineTo(x + 26, y - 14); }
        else { ctx.moveTo(x - 24, y); ctx.lineTo(x + 24, y); }
        ctx.stroke();
      }
    }
  }

  ctx.lineCap = 'round';
  const drawSeg = (x1,y1,x2,y2,rad,kind) => {
    const col = KIND_COL[kind] || KIND_COL.wall;
    if(kind === 'bouncy' || kind === 'boost'){ ctx.shadowColor = col; ctx.shadowBlur = 26 * BL; }
    ctx.strokeStyle = col; ctx.lineWidth = rad * 2;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = kind === 'wall' ? KIND_COL.edge : 'rgba(255,255,255,.55)';
    ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  };
  for(const o of m.geo){
    if(o.gate && m.gate.open) continue;
    if(o.t === 's'){
      if(Math.min(o.y1,o.y2) > bot || Math.max(o.y1,o.y2) < top) continue;
      drawSeg(o.x1, o.y1, o.x2, o.y2, o.rad, o.kind);
    } else {
      if(o.y > bot || o.y < top) continue;
      const col = KIND_COL[o.kind];
      if(o.kind === 'bouncy'){ ctx.shadowColor = col; ctx.shadowBlur = 24 * BL; }
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, 6.284); ctx.fill(); ctx.shadowBlur = 0;
      ctx.strokeStyle = o.kind === 'wall' ? KIND_COL.edge : 'rgba(255,255,255,.6)'; ctx.lineWidth = 3; ctx.stroke();
    }
  }
  for(const sp of m.spinners){
    if(sp.y - sp.len > bot || sp.y + sp.len < top) continue;
    for(let a=0;a<sp.arms;a++){
      const ang = sp.a + (a * Math.PI * 2) / sp.arms;
      drawSeg(sp.x, sp.y, sp.x + Math.cos(ang)*sp.len, sp.y + Math.sin(ang)*sp.len, sp.rad, sp.kind);
    }
    ctx.fillStyle = '#12142a'; ctx.beginPath(); ctx.arc(sp.x, sp.y, 26, 0, 6.284); ctx.fill();
    ctx.strokeStyle = KIND_COL.edge; ctx.lineWidth = 4; ctx.stroke();
  }

  if(m.finishY < bot && m.finishY > top - 200){
    const fy = m.finishY;
    for(let x=0;x<1080;x+=54) for(let k=0;k<2;k++){
      ctx.fillStyle = ((x/54 + k) % 2 ? '#f2f4ff' : '#101228');
      ctx.fillRect(x, fy + k*27, 54, 27);
    }
    ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 40 * BL;
    ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillRect(0, fy - 6, 1080, 6); ctx.shadowBlur = 0;
    // the winner card covers the lower third — drop the canvas label once it's up
    if(w.phase !== 'over'){
      ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.font = '700 48px "Chakra Petch",sans-serif';
      ctx.fillText('FINISH', 24, fy + 120);
    }
  }

  for(const s of w.sparks){
    ctx.globalAlpha = Math.max(0, s.life); ctx.fillStyle = s.c;
    ctx.beginPath(); ctx.arc(s.x, s.y, 5 * s.life + 1, 0, 6.284); ctx.fill();
  }
  ctx.globalAlpha = 1;

  const square = props.shape === 'square';
  for(const b of w.marbles){
    let col = cols[b.i];
    // boost (2× state) = tint toward white + a hotter glow; mud (0.5×) = dim it
    let glow = 30 + b.flash * 60;
    if(b.boostT > 0){ col = mix(col, '#ffffff', 0.5); glow += 24; }
    else if(b.mudT > 0){ col = mix(col, '#241a30', 0.32); glow -= 8; }

    // trail — a thin neon light-streak drawn as one continuous path (never blobs
    // at speed, unlike the design's fat per-segment trail). Additive blend so the
    // colour stays vivid over the dark course instead of washing out.
    const tl = b.trail.length;
    if(tl >= 6){
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.globalCompositeOperation = 'lighter';
      for(let pass=0; pass<2; pass++){
        ctx.strokeStyle = col;
        ctx.globalAlpha = pass === 0 ? 0.28 : 0.6;
        ctx.lineWidth = pass === 0 ? b.r * 0.95 : b.r * 0.34;
        ctx.beginPath(); ctx.moveTo(b.trail[0], b.trail[1]);
        for(let k=2;k<tl;k+=2) ctx.lineTo(b.trail[k], b.trail[k+1]);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    ctx.shadowColor = col; ctx.shadowBlur = Math.max(0, glow) * BL;
    ctx.fillStyle = col;
    if(square){
      const r = b.r * 0.92, k = 8;
      ctx.beginPath(); ctx.moveTo(b.x - r + k, b.y - r);
      ctx.arcTo(b.x + r, b.y - r, b.x + r, b.y + r, k);
      ctx.arcTo(b.x + r, b.y + r, b.x - r, b.y + r, k);
      ctx.arcTo(b.x - r, b.y + r, b.x - r, b.y - r, k);
      ctx.arcTo(b.x - r, b.y - r, b.x + r, b.y - r, k);
      ctx.closePath(); ctx.fill();
    } else { ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 6.284); ctx.fill(); }
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,.78)';
    ctx.beginPath(); ctx.arc(b.x - b.r*0.3, b.y - b.r*0.34, b.r*0.26, 0, 6.284); ctx.fill();
    if(b.flash > 0){ ctx.globalAlpha = b.flash; ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 12 + b.flash*18, 0, 6.284); ctx.stroke(); ctx.globalAlpha = 1; }
  }

  ctx.setTransform(1,0,0,1,0,0);
  const vg = ctx.createRadialGradient(cv.width/2, cv.height*0.5, cv.width*0.45, cv.width/2, cv.height*0.5, cv.width*1.1);
  vg.addColorStop(0,'rgba(0,0,0,0)'); vg.addColorStop(1,'rgba(0,0,0,.55)');
  ctx.fillStyle = vg; ctx.fillRect(0,0,cv.width,cv.height);
}

function mix(a, b, t){
  const pa = hx(a), pb = hx(b);
  return `rgb(${Math.round(pa[0]+(pb[0]-pa[0])*t)},${Math.round(pa[1]+(pb[1]-pa[1])*t)},${Math.round(pa[2]+(pb[2]-pa[2])*t)})`;
}
function hx(c){ c = c.replace('#',''); return [parseInt(c.slice(0,2),16), parseInt(c.slice(2,4),16), parseInt(c.slice(4,6),16)]; }

/* ═══════════════ HUD (DOM) — just the retention hook line now ═══════════════ */
function hud(force){
  const hk = el('hookline');
  const t = W_.time;
  let msg = '', hot = false, big = false;
  if(W_.phase === 'over') msg = '';
  else if(W_.phase === 'count'){ msg = 'Watch till the end'; big = true; }
  else if(S_.slowmo){ msg = 'Photo finish!!'; hot = true; }
  else if(t < 4.6){ msg = 'Pick your colour'; big = t < 3.9; }
  else { msg = (Math.floor(t / 3) % 2) ? 'First across wins' : 'Comment your colour'; }
  if(hk.textContent !== msg) hk.textContent = msg;
  hk.style.visibility = msg ? 'visible' : 'hidden';
  hk.classList.toggle('hot', hot);
  hk.classList.toggle('big', big);

  // progress bar — a single bar for how far the LEADING colour is from the
  // finish line (not a per-marble leaderboard); ~770 approximates the gate
  // position every course starts from, so the bar reads ~0% at the gate
  const w = W_, m = w.map;
  const lead = w.marbles.reduce((a,b) => (b.best > a.best ? b : a), w.marbles[0]);
  const frac = Math.max(0, Math.min(1, (lead.best - 770) / Math.max(1, m.finishY - 770)));
  // hidden during the countdown (nothing to show yet) and once the winner
  // card is up (same clean-reveal treatment as the hookline)
  el('progress').style.visibility = w.phase === 'run' ? 'visible' : 'hidden';
  el('progressFill').style.width = (frac * 100).toFixed(1) + '%';
  el('progress').style.setProperty('--pc', cols[lead.i]);
}

function fitText(node, avail, cap){
  node.style.fontSize = '';
  let px = cap || parseFloat(getComputedStyle(node).fontSize), guard = 40;
  node.style.fontSize = px + 'px';
  while(node.scrollWidth > avail && px > 12 && guard--){
    px = Math.max(12, px * Math.min(0.94, avail / node.scrollWidth));
    node.style.fontSize = px + 'px';
  }
}
function stageW(){ return el('stage').clientWidth || innerWidth; }

/* ═══════════════ live Web Audio (not used in render mode) ═══════════════ */
function liveSound(){
  let ac, master, muted = false;
  const ensure = () => { if(!ac){ const A = window.AudioContext || window.webkitAudioContext; if(!A) return; ac = new A(); master = ac.createGain(); master.gain.value = 0.3; const lp = ac.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value = 6500; master.connect(lp); lp.connect(ac.destination); } if(ac && ac.state === 'suspended') ac.resume(); };
  const bell = (f, g, d) => { if(!ac || muted) return; const o = ac.createOscillator(), gn = ac.createGain(); o.type='sine'; o.frequency.value = f; const n = ac.currentTime; gn.gain.setValueAtTime(.0001, n); gn.gain.exponentialRampToValueAtTime(g, n + .005); gn.gain.exponentialRampToValueAtTime(.0001, n + d); o.connect(gn); gn.connect(master); o.start(n); o.stop(n + d + .05); };
  return {
    _drain(){ return []; },
    ensure, toggle(){ muted = !muted; return muted; },
    hit(imp, x, kind){ ensure(); bell(_PENTA[Math.floor(rnd()*_PENTA.length)] * (kind === 'b' ? 2 : 1), 0.05 + imp*0.08, 0.4); },
    zone(){ ensure(); bell(196, 0.06, 0.5); },
    count(){ ensure(); bell(523, 0.05, 0.2); },
    finish(){ ensure(); bell(392, 0.08, 0.6); },
    win(){ ensure(); [0,4,7,12].forEach((s,i)=> setTimeout(()=> bell(392*Math.pow(2,s/12), 0.07, 0.8), i*90)); },
  };
}

/* ═══════════════ loop / render API ═══════════════ */
let last = 0;
function frame(ts){
  requestAnimationFrame(frame);
  if(!last) last = ts;
  let dt = Math.min(0.04, (ts - last) / 1000); last = ts;
  advance(dt);
  if(W_.phase === 'over' && W_.time - W_.overAt > 3.6){ init(); last = 0; acc = 0; }
}

function resize(){
  const Q = RENDER ? SS : Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  cv.width = Math.round(W * Q);
  cv.height = Math.round(H * Q);
  ctx.imageSmoothingQuality = 'high';
}

resize();
addEventListener('resize', () => { if(!RENDER) resize(); });

// the course is now sized to TARGET_SEC directly, so this is just a sanity
// floor against a freak fast run — scales with the target so it never
// undershoots a long ask the way a fixed cap did
const MIN_SEC = Math.max(8, TARGET_SEC * 0.4);

if(RENDER){
  CR.step = () => {
    CR.frame += 1;
    advance(1 / FPS);
    const events = Sound._drain();
    let done = false;
    if(W_.phase === 'over' && W_.time >= W_.overAt + END_HOLD && W_.time >= MIN_SEC) done = true;
    if(CR.frame >= CR._hardCap) done = true;
    CR.done = done;
    return { frame: CR.frame, events, done };
  };
  CR.result = () => {
    const w = W_;
    const winIdx = w.winnerIdx >= 0 ? w.winnerIdx : 0;
    const wm = w.marbles[winIdx];
    return {
      seed: SEED,
      map: MAP_IDS[w.map.id], mapName: w.map.name,
      winner: names[winIdx],
      winnerRgb: hx(cols[winIdx]),
      colors: names.slice(),
      order: orderByProgress(),
      winAtSec: +((wm && wm.done ? wm.t : w.time)).toFixed(2),
      durationSec: +(CR.frame / FPS).toFixed(2),
      frames: CR.frame, fps: FPS,
      courseH: Math.round(w.map.H),   // debug/calibration — actual generated course height
    };
  };
  const boot = async () => {
    try { if(document.fonts){ document.fonts.load('700 40px "Chakra Petch"'); await document.fonts.ready; } } catch(e){}
    init();
    CR._hardCap = Math.round((TARGET_SEC + 30) * FPS);
    CR.meta = { fps: FPS, totalFrames: CR._hardCap, seed: SEED, width: W, height: H };
  };
  boot();
} else {
  init();
  requestAnimationFrame(frame);
  el('stage').addEventListener('pointerdown', () => Sound.ensure && Sound.ensure(), { once:true });
}

window.MarbleRush = { restart: init, get world(){ return W_; }, seed: () => SEED };
window.CR = CR;

})();

// Entry point. Builds the scene from ?seed / ?marbles / ?target / ?fps / ?quick,
// then exposes a tiny frame-stepping API on window.MR that the headless renderer
// drives: MR.ready -> MR.meta -> loop MR.step() + screenshot -> MR.result().

import * as THREE from 'three';
import { makeRng } from './rng.js';
import { buildCourse, MRADIUS } from './course.js';
import { initRapier, Physics } from './physics.js';
import { Stage } from './scene.js';
import { ChaseCamera } from './camera.js';

const MARBLE_COLORS = [
  ['RED', [0.86, 0.10, 0.12]],
  ['GREEN', [0.28, 0.80, 0.16]],
  ['BLUE', [0.10, 0.42, 0.95]],
  ['YELLOW', [0.99, 0.82, 0.10]],
  ['ORANGE', [0.99, 0.45, 0.06]],
  ['CYAN', [0.10, 0.83, 0.90]],
  ['PURPLE', [0.62, 0.24, 0.90]],
  ['PINK', [0.98, 0.40, 0.72]],
];

const qs = new URLSearchParams(location.search);
const SEED = parseInt(qs.get('seed') || '1', 10) >>> 0;
const N_MARBLES = Math.max(3, Math.min(6, parseInt(qs.get('marbles') || '4', 10)));
const TARGET = Math.max(12, Math.min(60, parseFloat(qs.get('target') || '22')));
const FPS = Math.max(24, Math.min(60, parseInt(qs.get('fps') || '30', 10)));
const QUICK = qs.get('quick') === '1';
const DEBUG_CAM = qs.get('cam') === 'fixed' ? true : (qs.get('cam') || false);
const RES_W = parseInt(qs.get('w') || '1080', 10);
const RES_H = parseInt(qs.get('h') || '1920', 10);

const rng = makeRng(SEED);
const canvas = document.getElementById('c');
const W = QUICK ? Math.round(RES_W * 0.5) : RES_W;
const H = QUICK ? Math.round(RES_H * 0.5) : RES_H;
canvas.width = W; canvas.height = H;

function arclen(course, p) {
  const { centre, cum } = course;
  let bestD = Infinity, bestS = 0, bestY = 0;
  for (let k = 0; k < centre.length - 1; k++) {
    const a = centre[k], b = centre[k + 1];
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const L2 = abx * abx + aby * aby + abz * abz || 1e-9;
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / L2;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + abx * t, cy = a.y + aby * t, cz = a.z + abz * t;
    const d = (p.x - cx) ** 2 + (p.y - cy) ** 2 + (p.z - cz) ** 2;
    if (d < bestD) { bestD = d; bestS = cum[k] + Math.sqrt(L2) * t; bestY = cy; }
  }
  return { s: bestS, pathY: bestY };
}

// point + up vector on the centreline at arc-length s
function pathAtS(course, s) {
  const { centre, cum, frames } = course;
  let k = 0;
  while (k < cum.length - 2 && cum[k + 1] < s) k++;
  const seg = Math.max(1e-4, cum[k + 1] - cum[k]);
  const t = THREE.MathUtils.clamp((s - cum[k]) / seg, 0, 1);
  const p = centre[k].clone().lerp(centre[k + 1], t);
  return { p, up: frames[k].up };
}

const MR = {
  ready: null,
  meta: null,
  frame: 0,
  done: false,
  _finishFrame: {},
  _lastProg: [],
};
window.MR = MR;

MR.ready = (async () => {
  await initRapier();

  const course = buildCourse(rng, { target: TARGET });
  console.log(`[MR] course: ${course.centre.length} pts, ${course.collider.trimesh.indices.length / 3} tris, `
    + `${course.spinners.length} spinners, len ${course.totalLength.toFixed(0)}m, finishS ${course.finishS.toFixed(0)}`);
  const phys = new Physics(-27);
  phys.addCourse(course.collider);
  phys.addGate(course.gate);
  for (const sp of course.spinners) phys.addSpinner(sp);

  const colors = rng.sample(MARBLE_COLORS, N_MARBLES);
  const radius = MRADIUS();
  const marbleObjs = [];
  const { fwd, right, up } = course.frames[0];
  const sp = Math.min(course.startSpread, 0.72);
  for (let i = 0; i < N_MARBLES; i++) {
    // two staggered rows so 5–6 marbles fit without spawning inside each other
    const row = i % 2;
    const col = Math.floor(i / 2);
    const cols = Math.ceil(N_MARBLES / 2);
    const lat = cols > 1 ? -sp + (2 * sp * col) / (cols - 1) : 0;
    const p = course.startPos.clone()
      .add(right.clone().multiplyScalar(lat + rng.float(-0.03, 0.03)))
      .add(fwd.clone().multiplyScalar(-row * 1.1 + rng.float(-0.04, 0.04)))
      .add(up.clone().multiplyScalar(0.5 + i * 0.03));
    marbleObjs.push(phys.addMarble(p, radius, i));
  }
  MR._launchDir = fwd.clone();

  const stage = new Stage(canvas, W, H, rng);
  stage.buildCourse(course);
  stage.addMarbles(colors, radius);

  const chase = new ChaseCamera(stage.camera, course, { introFrames: Math.round(FPS * 1.0) });

  const runFrame = Math.round(FPS * 2.4);
  const hardCap = Math.round((TARGET + 8) * FPS);
  const gateY0 = course.gate.pos[1];
  const gateYDrop = course.gate.dropTo;

  MR.meta = {
    seed: SEED, marbles: N_MARBLES, target: TARGET, fps: FPS,
    width: W, height: H, quick: QUICK, hardCap, runFrame,
    colors: colors.map((c) => c[0]),
  };

  MR._sim = { course, phys, stage, chase, marbleObjs, colors, radius, runFrame, hardCap, gateY0, gateYDrop };

  // settle so marbles rest on the start pad before frame 1
  for (let i = 0; i < 10; i++) phys.step(1 / 60);
  marbleObjs.forEach((m, i) => {
    const tr = phys.marbleTransform(m);
    stage.syncMarble(i, tr.pos, tr.quat);
  });
  stage.render();
})();

MR.step = () => {
  const S = MR._sim;
  if (!S) throw new Error('not ready');
  MR.frame += 1;
  const f = MR.frame;

  // gate animation
  if (f < S.runFrame - 2) S.phys.setGateY(S.gateY0);
  else if (f < S.runFrame + 6) {
    const k = (f - (S.runFrame - 2)) / 8;
    S.phys.setGateY(THREE.MathUtils.lerp(S.gateY0, S.gateYDrop, Math.min(1, k)));
  } else S.phys.setGateY(S.gateYDrop);
  S.stage.setGateY(S.phys.gate.y);

  // GO! one firm shove down-course so nobody can sit wedged at the line
  if (f === S.runFrame) {
    const d = MR._launchDir;
    for (const m of S.marbleObjs) {
      m.body.applyImpulse({ x: d.x * 2.6, y: -0.6, z: d.z * 2.6 }, true);
      m.body.wakeUp();
    }
  }

  // spinners
  S.phys.spinners.forEach((sp, i) => {
    const angle = sp.spec.omega * (f / MR.meta.fps);
    S.phys.setSpinnerAngle(sp, angle);
    S.stage.syncSpinner(i, angle);
  });

  const dt = 1 / MR.meta.fps;
  S.phys.step(dt);

  // read marbles + progress; derive audible impacts from sudden speed changes
  const states = [];
  const progresses = [];
  const impacts = [];
  let maxSpeed = 0;
  for (let i = 0; i < S.marbleObjs.length; i++) {
    const m = S.marbleObjs[i];
    const tr = S.phys.marbleTransform(m);
    const { s, pathY } = arclen(S.course, tr.pos);
    const near = tr.pos.y > pathY - 3.5 && tr.pos.y < pathY + 7;
    if (near) { m._offT = 0; m._lastS = s; }
    else m._offT = (m._offT || 0) + dt;
    const onTrack = near;

    // stuck detection — progress hasn't moved for a while
    if (s > (m._stuckS ?? -1) + 1.5) { m._stuckS = s; m._stuckT = 0; }
    else m._stuckT = (m._stuckT || 0) + dt;

    // flew off (or wedged) — drop it back on the track behind where it left,
    // with a little pace. Way behind, still in the race.
    let respawned = false;
    const bail = (m._offT > 1.5 && tr.pos.y < pathY - 3) || (m._stuckT > 3.2 && f > S.runFrame + 20);
    if (bail && f > S.runFrame + 4 && MR._finishFrame[i] === undefined) {
      const back = Math.max(0, (m._lastS ?? s) - rng.float(4, 8));
      const fr = pathAtS(S.course, back);
      const np = fr.p.clone().add(fr.up.clone().multiplyScalar(MRADIUS() + 0.4));
      const fwd = pathAtS(S.course, back + 2).p.clone().sub(fr.p).normalize();
      m.body.setTranslation({ x: np.x, y: np.y, z: np.z }, true);
      m.body.setLinvel({ x: fwd.x * 3, y: -1, z: fwd.z * 3 }, true);
      m.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      m._offT = 0; m._lastS = back; m._stuckS = back; m._stuckT = 0;
      respawned = true;
    }

    S.stage.syncMarble(i, respawned ? m.body.translation() : tr.pos, tr.quat);
    states.push({ pos: respawned ? new THREE.Vector3().copy(m.body.translation()) : tr.pos, speed: tr.speed, onTrack: onTrack || respawned });
    const prog = (onTrack || respawned) ? s : Math.min((m._lastS ?? s), S.course.finishS - 2);
    progresses.push(prog);
    maxSpeed = Math.max(maxSpeed, tr.speed);
    if (onTrack && s >= S.course.finishS && MR._finishFrame[i] === undefined && f > S.runFrame) {
      MR._finishFrame[i] = f;
    }
    const prev = m._spd || 0;
    const jolt = prev - tr.speed;
    if (jolt > 1.6 && f > S.runFrame - 4 && !respawned) impacts.push(Math.min(1, jolt / 7) * 900);
    m._spd = tr.speed;
  }
  MR._lastProg = progresses;

  // keep the race close & watchable: ease trailing marbles up and runaway
  // leaders down toward the pack, and hard-cap speed. Subtle — a nudge, not a
  // tractor beam. Only once everyone's actually running.
  if (f > S.runFrame + 6 && MR._finishFrame[Object.keys(MR._finishFrame)[0]] === undefined) {
    const mean = progresses.reduce((a, b) => a + b, 0) / progresses.length;
    const span = Math.max(6, Math.max(...progresses) - Math.min(...progresses));
    const rate = 1 - Math.exp(-3.6 * dt);   // frame-rate independent easing
    for (let i = 0; i < S.marbleObjs.length; i++) {
      // leave airborne / fallen marbles alone — that drama is the point
      if (!states[i].onTrack) continue;
      const rel = (mean - progresses[i]) / span;               // + behind, - ahead
      const body = S.marbleObjs[i].body;
      const v = body.linvel();
      const spd = Math.hypot(v.x, v.y, v.z);
      if (spd < 0.4) continue;
      const dv = THREE.MathUtils.clamp(rel * 2.6, -1.5, 2.2);
      const target = THREE.MathUtils.clamp(spd + dv, 0, 16);
      const ns = THREE.MathUtils.lerp(spd, target, rate);
      const k = ns / spd;
      body.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, true);
    }
  }

  if (DEBUG_CAM === 'start') {
    const sp = S.course.startPos;
    S.stage.camera.position.set(sp.x + 7, sp.y + 4, sp.z - 9);
    S.stage.camera.lookAt(sp.x, sp.y - 1, sp.z + 6);
  } else if (DEBUG_CAM === 'last') {
    // follow the last-place marble up close — shows why someone is stuck
    let li = 0;
    for (let i = 1; i < states.length; i++) if (progresses[i] < progresses[li]) li = i;
    const q = states[li].pos;
    S.stage.camera.position.set(q.x + 4, q.y + 3.5, q.z - 6);
    S.stage.camera.lookAt(q.x, q.y, q.z + 1);
  } else if (DEBUG_CAM) {
    // hover above the pack, angled back down the course — shows any pileup
    const pack = new THREE.Vector3();
    states.forEach((s) => pack.add(s.pos));
    pack.multiplyScalar(1 / states.length);
    S.stage.camera.position.set(pack.x + 2, pack.y + 26, pack.z - 20);
    S.stage.camera.lookAt(pack.x, pack.y - 2, pack.z + 6);
  } else {
    MR._sim.chase.update(states, progresses, f, MR.meta.fps);
  }
  S.stage.render();

  // done?
  const finishedIdx = Object.keys(MR._finishFrame).map(Number);
  let done = false;
  if (finishedIdx.length > 0) {
    const firstFrame = Math.min(...finishedIdx.map((i) => MR._finishFrame[i]));
    if (f >= firstFrame + Math.round(MR.meta.fps * 2.6)) done = true;
  }
  if (f >= S.hardCap) done = true;
  MR.done = done;

  return {
    frame: f, done,
    impacts,
    maxSpeed,
    progresses: progresses.slice(),
    finished: finishedIdx.length,
  };
};

MR.result = () => {
  const S = MR._sim;
  const finishFrame = MR._finishFrame;
  const order = [...Array(S.marbleObjs.length).keys()].sort((a, b) => {
    const fa = finishFrame[a] ?? 1e9;
    const fb = finishFrame[b] ?? 1e9;
    if (fa !== fb) return fa - fb;
    return (MR._lastProg[b] ?? 0) - (MR._lastProg[a] ?? 0);
  });
  const winIdx = order[0];
  const winFrame = finishFrame[winIdx] ?? MR.frame;
  return {
    seed: SEED,
    map: 'wooden-course',
    mapName: 'WOODEN COURSE',
    winner: S.colors[winIdx][0],
    winnerRgb: S.colors[winIdx][1].map((c) => Math.round(c * 255)),
    colors: S.colors.map((c) => c[0]),
    order: order.map((i) => S.colors[i][0]),
    winAtSec: +(winFrame / MR.meta.fps).toFixed(2),
    durationSec: +(MR.frame / MR.meta.fps).toFixed(2),
    frames: MR.frame,
    fps: MR.meta.fps,
  };
};

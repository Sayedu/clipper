// Procedural wooden marble run.
//
// One smooth, glossy, banked track swept along a descending centreline. It stays
// fairly narrow (so it never billows), but every so often the walls drop right
// down for a "wild zone" — a bumper, a fast spinner, a kicker ramp — where a good
// hit flings marbles clean off the edge. Anything that flies off lands on a wide
// CATCH trough a few units below, slides down, and a ramp at the end merges it
// back onto the track just before the finish: way behind, never out.
//
// Rendering and the Rapier trimesh collider share the same mesh.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const UP = new THREE.Vector3(0, 1, 0);
const box1 = new THREE.BoxGeometry(1, 1, 1);

function smooth(arr, radius) {
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0, cnt = 0;
    for (let j = -radius; j <= radius; j++) {
      const k = i + j;
      if (k < 0 || k >= arr.length) continue;
      sum += arr[k]; cnt++;
    }
    out[i] = sum / cnt;
  }
  return out;
}

function catmullRom(keys, nSub) {
  const P = [keys[0], ...keys, keys[keys.length - 1]].map((k) => k.clone());
  const out = [];
  for (let i = 1; i < P.length - 2; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    for (let s = 0; s < nSub; s++) {
      const t = s / nSub, t2 = t * t, t3 = t2 * t;
      out.push(new THREE.Vector3(
        0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
        0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
      ));
    }
  }
  out.push(P[P.length - 2].clone());
  return out;
}

function resample(poly, step) {
  const out = [poly[0].clone()];
  let acc = 0, i = 0;
  let cur = poly[0].clone();
  while (i < poly.length - 1) {
    const seg = poly[i + 1].clone().sub(cur);
    const L = seg.length();
    if (acc + L >= step) {
      cur = cur.add(seg.multiplyScalar((step - acc) / L));
      out.push(cur.clone());
      acc = 0;
    } else {
      acc += L; cur = poly[i + 1].clone(); i++;
    }
  }
  if (out[out.length - 1].distanceTo(poly[poly.length - 1]) > step * 0.4) out.push(poly[poly.length - 1].clone());
  return out;
}

function frameAt(pts, i) {
  const a = pts[Math.max(0, i - 2)];
  const b = pts[Math.min(pts.length - 1, i + 2)];
  const fwd = b.clone().sub(a);
  if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, 1);
  fwd.normalize();
  let right = new THREE.Vector3().crossVectors(UP, fwd);
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(fwd, right).normalize();
  return { fwd, right, up };
}

const _m4 = new THREE.Matrix4();
function quatFromFrame(fwd, up) {
  const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
  const upN = new THREE.Vector3().crossVectors(fwd, right).normalize();
  _m4.makeBasis(right, upN, fwd.clone());
  return new THREE.Quaternion().setFromRotationMatrix(_m4);
}

// Sweep a closed U profile. wallH is a per-vertex array. vColors optional (rgb per
// vertex, painted onto the geometry). smoothShade = glossy planed wood look.
function sweepTrough(centre, frames, halfWidths, wallH, wallT, floorT, opts = {}) {
  const { colorAt = null } = opts;
  const N = centre.length;
  const PN = 8;
  const pos = new Float32Array(N * PN * 3);
  const uv = new Float32Array(N * PN * 2);
  const col = colorAt ? new Float32Array(N * PN * 3) : null;
  const idx = [];
  let s = 0;
  const wh = (i) => (Array.isArray(wallH) ? wallH[i] : wallH);
  const _c = new THREE.Color();

  for (let i = 0; i < N; i++) {
    const hw = halfWidths[i];
    const h = Math.max(0.02, wh(i));
    const flare = h * 0.1;
    const prof = [
      [-(hw + flare), h], [-hw, 0], [hw, 0], [(hw + flare), h],
      [(hw + flare) + wallT, h], [hw + wallT, -floorT], [-hw - wallT, -floorT], [-(hw + flare) - wallT, h],
    ];
    const { right, up } = frames[i];
    if (i > 0) s += centre[i].distanceTo(centre[i - 1]);
    if (col) colorAt(i, _c);
    // fixed U per profile point so the grain never stretches in a wider spot
    const uFix = [0.0, 0.28, 0.72, 1.0, 1.06, 1.3, -0.3, -0.06];
    for (let k = 0; k < PN; k++) {
      const [px, py] = prof[k];
      const o = (i * PN + k) * 3;
      pos[o] = centre[i].x + right.x * px + up.x * py;
      pos[o + 1] = centre[i].y + right.y * px + up.y * py;
      pos[o + 2] = centre[i].z + right.z * px + up.z * py;
      const u = (i * PN + k) * 2;
      uv[u] = uFix[k]; uv[u + 1] = s / 5.0;
      if (col) { col[o] = _c.r; col[o + 1] = _c.g; col[o + 2] = _c.b; }
    }
  }
  for (let i = 0; i < N - 1; i++) {
    for (let k = 0; k < PN; k++) {
      const k2 = (k + 1) % PN;
      const a = i * PN + k, b = i * PN + k2, c = (i + 1) * PN + k2, d = (i + 1) * PN + k;
      idx.push(a, d, b, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geometry: g, vertices: pos, indices: new Uint32Array(idx) };
}

export function buildCourse(rng, opts) {
  const { target = 22 } = opts;
  const LANE_W = 4.2;
  const WALL_T = 0.5;
  const FLOOR_T = 0.7;
  const CHUTE_WALL = 2.1;

  // ---- centreline
  const wantLen = THREE.MathUtils.clamp(target * 4.8, 58, 320);
  const nKey = THREE.MathUtils.clamp(Math.round(wantLen / 12), 4, 24);
  const keys = [new THREE.Vector3(0, 10, -6), new THREE.Vector3(0, 5.2, 0)];
  let y = 5.2, z = 0, xv = 0;
  for (let i = 0; i < nKey; i++) {
    const seg = rng.float(11, 15);
    const slope = rng.float(0.30, 0.46);
    if (rng.bool(0.5)) xv = THREE.MathUtils.clamp(xv + rng.float(-4.2, 4.2), -5.2, 5.2);
    else xv *= 0.55;
    z += seg; y -= slope * seg;
    keys.push(new THREE.Vector3(xv, y, z));
  }
  keys.push(new THREE.Vector3(xv * 0.35, y - 2.4, z + 11));
  keys.push(new THREE.Vector3(xv * 0.1, y - 3.2, z + 24));

  const centre = resample(catmullRom(keys, 14), 1.05);
  const frames = centre.map((_, i) => frameAt(centre, i));
  const N = centre.length;
  let totalLength = 0;
  const cum = [0];
  for (let i = 1; i < N; i++) { totalLength += centre[i].distanceTo(centre[i - 1]); cum.push(totalLength); }

  // ---- bank the turns
  const bankRaw = centre.map((_, i) => {
    const a = frames[Math.max(0, i - 3)].fwd;
    const b = frames[Math.min(N - 1, i + 3)].fwd;
    return THREE.MathUtils.clamp((a.x * b.z - a.z * b.x) * 2.5, -0.52, 0.52);
  });
  const bank = smooth(bankRaw, 5);
  for (let i = 0; i < N; i++) {
    const q = new THREE.Quaternion().setFromAxisAngle(frames[i].fwd, bank[i]);
    frames[i].right.applyQuaternion(q).normalize();
    frames[i].up.applyQuaternion(q).normalize();
  }

  // ---- width + wall-height profile. Modest widenings for obstacle "rooms";
  // "wild zones" drop the walls to almost nothing so marbles get knocked off.
  const halfWidths = new Array(N).fill(LANE_W / 2);
  const wallHeights = new Array(N).fill(CHUTE_WALL);
  const wild = new Array(N).fill(0);

  const rooms = [];
  const nRoom = THREE.MathUtils.clamp(Math.round(nKey / 2.4), 3, 8);
  const lo = Math.floor(N * 0.12), hi = Math.floor(N * 0.86);
  const spacing = Math.floor((hi - lo) / nRoom);
  for (let p = 0; p < nRoom; p++) {
    const at = lo + Math.floor(spacing * (p + 0.5)) + rng.int(-4, 4);
    if (at < 6 || at > N - 8) continue;
    const halfLen = rng.int(4, 7);
    const grow = rng.float(1.05, 1.16);
    const isWild = rng.bool(0.6);
    for (let j = -halfLen - 3; j <= halfLen + 3; j++) {
      const k = at + j;
      if (k < 3 || k >= N - 3) continue;
      const t = Math.max(0, 1 - Math.abs(j) / (halfLen + 3));
      const ss = t * t * (3 - 2 * t);
      halfWidths[k] = Math.max(halfWidths[k], (LANE_W / 2) * (1 + (grow - 1) * ss));
      if (isWild) {
        wallHeights[k] = Math.min(wallHeights[k], THREE.MathUtils.lerp(CHUTE_WALL, 0.55, ss));
        wild[k] = Math.max(wild[k], ss);
      }
    }
    rooms.push({ at, halfLen, kind: p === 0 ? 'bumpers' : rng.pick(['spinner', 'bumpers', 'spinner']), wild: isWild, tintIdx: rooms.length });
  }
  // mild pinches on plain chute
  for (let i = 12; i < N - 16; i++) {
    if (halfWidths[i] <= LANE_W / 2 + 0.01 && rng.bool(0.02)) {
      for (let j = -2; j <= 2; j++) halfWidths[i + j] = Math.min(halfWidths[i + j], (LANE_W / 2) * (1 - 0.22 * (1 - Math.abs(j) / 3)));
    }
  }

  const hwS = smooth(halfWidths, 2);
  const whS = smooth(wallHeights, 2);
  const wildS = smooth(wild, 2);

  // ---- FINISH FUNNEL: the last stretch tapers to a single-marble neck with
  // full-height walls, so marbles queue up one-at-a-time across the line and it's
  // unmistakable who won. Applied AFTER the smooth so the neck stays tight.
  const neckHalf = MRADIUS() + 0.42;   // ~1.8 marbles wide — a clear single-file line
  const funLen = Math.min(16, N - 6);  // short: only the last few metres pinch
  for (let k = 0; k < funLen; k++) {
    const i = N - 1 - k;
    const t = k / (funLen - 1);
    hwS[i] = Math.min(hwS[i], THREE.MathUtils.lerp(neckHalf, LANE_W / 2, Math.pow(t, 1.15)));
    whS[i] = Math.max(whS[i], CHUTE_WALL);
    wildS[i] = 0;
  }

  // paint: warm wood by default; every room gets a solid bright painted stretch
  const PALETTE = [0x2fb6ac, 0xef6f4a, 0x3d7de0, 0xf2b134, 0x9b5de5, 0x38b000];
  const roomTint = rooms.map((_, ri) => new THREE.Color(PALETTE[ri % PALETTE.length]));
  const nearestRoomTint = (i) => {
    let best = 1e9, tint = null;
    rooms.forEach((r, ri) => {
      const d = Math.abs(i - r.at);
      if (d < r.halfLen + 2 && d < best) { best = d; tint = roomTint[ri]; }
    });
    if (!tint) return null;
    const k = best < 2 ? 1 : Math.max(0, 1 - (best - 2) / 2.5);
    return { tint, k };
  };
  const woodBase = new THREE.Color(0xffffff);
  const colorAt = (i, out) => {
    const rt = nearestRoomTint(i);
    if (rt) out.copy(woodBase).lerp(rt.tint, rt.k * 0.9);
    else out.copy(woodBase);
  };

  const track = sweepTrough(centre, frames, hwS, whS, WALL_T, FLOOR_T, { colorAt });

  // ---- decorative colour arches over a couple of rooms (like the reference's
  // wooden hoops). Big enough a marble never touches them — pure landmark + colour.
  const arches = [];
  for (const room of rooms.slice(0, 3)) {
    const c = centre[room.at], fr = frames[room.at];
    const g = new THREE.TorusGeometry(hwS[room.at] + 1.7, 0.34, 10, 30, Math.PI);
    g.applyQuaternion(quatFromFrame(fr.fwd, fr.up));
    g.translate(c.x, c.y - 0.3, c.z);
    const t = roomTint[room.tintIdx];
    arches.push({ geometry: g, color: [t.r, t.g, t.b] });
  }

  // ---- boxes / cylinders
  const colBoxes = [];
  const woodGeoms = [], accentGeoms = [], trimGeoms = [], postGeoms = [];
  const addBox = (list, size, pos, quat, collide = true, restitution) => {
    const g = box1.clone();
    g.scale(size.x, size.y, size.z);
    g.applyQuaternion(quat);
    g.translate(pos.x, pos.y, pos.z);
    list.push(g);
    if (collide) colBoxes.push({ hx: size.x / 2, hy: size.y / 2, hz: size.z / 2, pos: [pos.x, pos.y, pos.z], quat: [quat.x, quat.y, quat.z, quat.w], restitution: restitution ?? 0.1, friction: 0.3 });
  };
  const addCyl = (list, radius, height, pos, restitution) => {
    const g = new THREE.CylinderGeometry(radius, radius, height, 18);
    g.translate(pos.x, pos.y, pos.z);
    list.push(g);
    colBoxes.push({ cyl: true, radius, halfHeight: height / 2, pos: [pos.x, pos.y, pos.z], restitution: restitution ?? 0.9, friction: 0.3 });
  };

  // start box + gate
  const c0 = centre[0], f0 = frames[0];
  const q0 = quatFromFrame(f0.fwd, f0.up);
  addBox(woodGeoms, new THREE.Vector3(LANE_W + 2 * WALL_T, FLOOR_T, 7.0),
    c0.clone().add(f0.fwd.clone().multiplyScalar(-2.2)).add(f0.up.clone().multiplyScalar(-FLOOR_T / 2)), q0);
  addBox(woodGeoms, new THREE.Vector3(LANE_W + 2 * WALL_T, CHUTE_WALL + 1.6, 0.6),
    c0.clone().add(f0.fwd.clone().multiplyScalar(-5.3)).add(f0.up.clone().multiplyScalar((CHUTE_WALL + 1.6) / 2 - FLOOR_T)), q0);
  for (const sgn of [-1, 1]) {
    addBox(woodGeoms, new THREE.Vector3(WALL_T, CHUTE_WALL + 1.2, 7.0),
      c0.clone().add(f0.right.clone().multiplyScalar(sgn * (LANE_W / 2 + WALL_T / 2)))
        .add(f0.fwd.clone().multiplyScalar(-2.2)).add(f0.up.clone().multiplyScalar((CHUTE_WALL + 1.2) / 2 - FLOOR_T)), q0);
  }
  const startPos = c0.clone().add(f0.fwd.clone().multiplyScalar(-1.3)).add(f0.up.clone().multiplyScalar(MRADIUS() + 0.5));
  const startSpread = Math.min(1.15, LANE_W / 2 - MRADIUS() - 0.6);
  const gp = c0.clone().add(f0.fwd.clone().multiplyScalar(0.5)).add(f0.up.clone().multiplyScalar(1.0));
  const gate = { pos: [gp.x, gp.y, gp.z], quat: [q0.x, q0.y, q0.z, q0.w], hx: LANE_W / 2, hy: 1.1, hz: 0.14, dropTo: gp.y - 4.4 };

  // finish pad + banner
  const cN = centre[N - 1], fN = frames[N - 1];
  const qN = quatFromFrame(fN.fwd, fN.up);
  addBox(woodGeoms, new THREE.Vector3(LANE_W + 3.5, FLOOR_T, 13),
    cN.clone().add(fN.fwd.clone().multiplyScalar(3.5)).add(fN.up.clone().multiplyScalar(-FLOOR_T / 2)), qN);
  addBox(accentGeoms, new THREE.Vector3(LANE_W + 4, CHUTE_WALL * 2.6, 0.7),
    cN.clone().add(fN.fwd.clone().multiplyScalar(9)).add(fN.up.clone().multiplyScalar(CHUTE_WALL)), qN);
  const finishS = cum[cum.length - 1] - 2.0;

  // ---- obstacles in the rooms
  const spinners = [];
  for (const room of rooms) {
    const i = room.at;
    const c = centre[i], fr = frames[i], hw = hwS[i];
    // checker trim along both edges of the room
    for (const sgn of [-1, 1]) {
      const edge = c.clone().add(fr.right.clone().multiplyScalar(sgn * (hw + 0.04))).add(fr.up.clone().multiplyScalar(0.08));
      addBox(trimGeoms, new THREE.Vector3(0.5, 0.14, room.halfLen * 2.0), edge, quatFromFrame(fr.fwd, fr.up), false);
    }
    if (room.kind === 'spinner') {
      const omega = rng.float(0.85, 1.5) * rng.sign();
      const hub = c.clone().add(fr.up.clone().multiplyScalar(1.0));
      const armLen = hw * 0.7;
      const arms = [];
      for (let b = 0; b < 3; b++) arms.push({ len: armLen, h: 1.4, t: 0.26, angle: (b / 3) * Math.PI * 2 });
      spinners.push({ pos: [hub.x, hub.y, hub.z], omega, arms, big: true });
    } else {
      const nb = rng.int(2, 4);
      for (let b = 0; b < nb; b++) {
        const off = c.clone()
          .add(fr.right.clone().multiplyScalar(rng.float(-hw * 0.55, hw * 0.55)))
          .add(fr.fwd.clone().multiplyScalar(rng.float(-room.halfLen * 0.6, room.halfLen * 0.6)))
          .add(fr.up.clone().multiplyScalar(0.5));
        addCyl(postGeoms, 0.46, 1.0, off, 1.1);
      }
    }
  }

  const merge = (a) => (a.length ? mergeGeometries(a, false) : null);
  const meshData = {
    track: track.geometry,
    wood: merge(woodGeoms),
    accent: merge(accentGeoms),
    trim: merge(trimGeoms),
    posts: merge(postGeoms),
    arches,
  };
  [...woodGeoms, ...accentGeoms, ...trimGeoms, ...postGeoms].forEach((g) => g.dispose && g.dispose());

  return {
    centre, frames, cum, totalLength,
    startPos, startSpread, finishS,
    laneW: LANE_W, wallH: CHUTE_WALL,
    wild: wildS,
    collider: {
      trimesh: { vertices: track.vertices, indices: track.indices },
      boxes: colBoxes,
    },
    spinners, gate,
    meshData,
    bounds: courseBounds(centre),
  };
}

function courseBounds(centre) {
  const bb = new THREE.Box3();
  centre.forEach((c) => bb.expandByPoint(c));
  bb.min.y -= 8;
  bb.max.y += 10;
  bb.expandByScalar(12);
  return bb;
}

// marble radius — kept in sync with physics.js
export function MRADIUS() {
  return 0.5;
}

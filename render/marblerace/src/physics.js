// Rapier physics wrapper. Fixed small timestep, marbles get continuous collision
// detection so nothing tunnels through a wall no matter how fast it moves. The
// course is one fixed body carrying every cuboid collider; the gate and spinners
// are kinematic; marbles are dynamic balls.

import RAPIER from 'rapier';
import * as THREE from 'three';

export async function initRapier() {
  await RAPIER.init();
}

const SIM_HZ = 240; // fixed physics rate — independent of output fps

export class Physics {
  // step(dt) advances the sim by dt seconds as a whole number of fixed 1/240 s
  // sub-steps, so the race plays out identically at any output frame rate and
  // CCD stays reliable.
  constructor(gravityY = -27) {
    this.world = new RAPIER.World({ x: 0, y: gravityY, z: 0 });
    this.world.timestep = 1 / SIM_HZ;
    this._carry = 0;
    this.events = new RAPIER.EventQueue(true);
    this.marbles = [];
    this.spinners = [];
    this.gate = null;
    this._impulses = [];
  }

  addCourse(collider) {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const meshes = [...(collider.chutes || []), collider.trimesh, collider.trimesh2].filter(Boolean);
    for (const mesh of meshes) {
      const tm = RAPIER.ColliderDesc.trimesh(mesh.vertices, mesh.indices)
        .setRestitution(0.06)
        .setFriction(0.26)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(14);
      this.world.createCollider(tm, body);
    }
    for (const c of collider.boxes || []) {
      let d;
      if (c.cyl) {
        d = RAPIER.ColliderDesc.cylinder(c.halfHeight, c.radius).setTranslation(c.pos[0], c.pos[1], c.pos[2]);
      } else {
        d = RAPIER.ColliderDesc.cuboid(c.hx, c.hy, c.hz)
          .setTranslation(c.pos[0], c.pos[1], c.pos[2])
          .setRotation({ x: c.quat[0], y: c.quat[1], z: c.quat[2], w: c.quat[3] });
      }
      d.setRestitution(c.restitution ?? 0.08).setFriction(c.friction ?? 0.3);
      this.world.createCollider(d, body);
    }
    this.courseBody = body;
  }

  addGate(gate) {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(gate.pos[0], gate.pos[1], gate.pos[2])
        .setRotation({ x: gate.quat[0], y: gate.quat[1], z: gate.quat[2], w: gate.quat[3] }),
    );
    const d = RAPIER.ColliderDesc.cuboid(gate.hx, gate.hy, gate.hz)
      .setRestitution(0.1).setFriction(0.5);
    this.world.createCollider(d, body);
    this.gate = { body, spec: gate, y: gate.pos[1] };
  }

  setGateY(y) {
    if (!this.gate) return;
    this.gate.y = y;
    const s = this.gate.spec;
    this.gate.body.setNextKinematicTranslation({ x: s.pos[0], y, z: s.pos[2] });
  }

  addSpinner(spec) {
    // vertical-axis turnstile: body spins about world Y, three arms fixed in
    // body-local space, each offset outward along its own direction.
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spec.pos[0], spec.pos[1], spec.pos[2]),
    );
    const yAxis = new THREE.Vector3(0, 1, 0);
    for (const arm of spec.arms) {
      const rot = new THREE.Quaternion().setFromAxisAngle(yAxis, arm.angle);
      const dir = new THREE.Vector3(1, 0, 0).applyQuaternion(rot);
      const off = dir.multiplyScalar(arm.len / 2);
      const d = RAPIER.ColliderDesc.cuboid(arm.len / 2, arm.h / 2, arm.t / 2)
        .setTranslation(off.x, off.y, off.z)
        .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
        .setRestitution(0.3).setFriction(0.35)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(12);
      this.world.createCollider(d, body);
    }
    const s = { body, spec, angle: 0 };
    this.spinners.push(s);
    return s;
  }

  setSpinnerAngle(s, angle) {
    s.angle = angle;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    s.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
  }

  addMarble(pos, radius, idx) {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setLinearDamping(0.03)
        .setAngularDamping(0.04)
        .setCcdEnabled(true),
    );
    const d = RAPIER.ColliderDesc.ball(radius)
      .setRestitution(0.18)
      .setFriction(0.32)
      .setDensity(2.4)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(10);
    const col = this.world.createCollider(d, body);
    const m = { body, col, idx, handle: col.handle };
    this.marbles.push(m);
    return m;
  }

  // advance the sim by dt seconds (impacts derived from marble Δv in main.js)
  step(dt) {
    this._carry += dt;
    let n = Math.floor(this._carry * SIM_HZ + 1e-6);
    this._carry -= n / SIM_HZ;
    n = Math.max(1, Math.min(n, 16));
    for (let i = 0; i < n; i++) {
      this.world.step(this.events);
      // hard speed clamp — a marble pinned between a fast spinner and a wall can
      // otherwise get flung at absurd velocity ("explosion"). 24 m/s is plenty.
      for (const m of this.marbles) {
        const v = m.body.linvel();
        const sp = Math.hypot(v.x, v.y, v.z);
        if (sp > 24) {
          const k = 24 / sp;
          m.body.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, false);
        }
      }
    }
  }

  marbleTransform(m) {
    const t = m.body.translation();
    const r = m.body.rotation();
    const v = m.body.linvel();
    return {
      pos: new THREE.Vector3(t.x, t.y, t.z),
      quat: new THREE.Quaternion(r.x, r.y, r.z, r.w),
      speed: Math.hypot(v.x, v.y, v.z),
    };
  }
}

export { RAPIER };

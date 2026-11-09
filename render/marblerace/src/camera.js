// Chase camera — a drone high above and a little behind the pack, looking down
// at a steep angle so the near trough wall never hides the marbles and the
// camera always clears the terrain. Direction comes from a heavily smoothed pack
// velocity (with a fallback so it never spins when the pack bunches up). Two
// exponential filters keep the move floaty; a hard height floor keeps it clear.

import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

export class ChaseCamera {
  constructor(camera, course, opts = {}) {
    this.cam = camera;
    this.back = opts.back ?? 10;
    this.height = opts.height ?? 7.5;
    this.ahead = opts.ahead ?? 7;
    this.posLerp = opts.posLerp ?? 0.05;
    this.lookLerp = opts.lookLerp ?? 0.085;
    this.introFrames = opts.introFrames ?? 0;

    this.eye = null;
    this.look = null;
    this.dir = new THREE.Vector3(0, 0, 1);
    this.prevPack = null;
  }

  update(states, progresses, frame, fps) {
    const n = states.length;
    const pack = new THREE.Vector3();
    states.forEach((s) => pack.add(s.pos));
    pack.multiplyScalar(1 / n);

    // smoothed horizontal travel direction
    if (this.prevPack) {
      const d = pack.clone().sub(this.prevPack);
      d.y = 0;
      if (d.length() > 0.05) {
        d.normalize();
        this.dir.lerp(d, 0.08).normalize();
      }
    }
    this.prevPack = pack.clone();

    // leader, for a touch of lead-the-winner bias
    let li = 0;
    for (let i = 1; i < n; i++) if (progresses[i] > progresses[li]) li = i;
    const focus = pack.clone().lerp(states[li].pos, 0.3);

    let maxY = -Infinity;
    states.forEach((s) => { if (s.pos.y > maxY) maxY = s.pos.y; });

    // for the first ~1s sit closer & higher so we clear the tall start box,
    // then ease back to the normal chase distance
    const settle = THREE.MathUtils.clamp((frame - 6) / Math.max(1, this.introFrames), 0, 1);
    const back = THREE.MathUtils.lerp(2.5, this.back, settle);
    const hi = THREE.MathUtils.lerp(this.height + 5, this.height, settle);
    let desired = focus.clone()
      .sub(this.dir.clone().multiplyScalar(back))
      .add(new THREE.Vector3(0, hi, 0));
    const aim = focus.clone().add(this.dir.clone().multiplyScalar(this.ahead)).add(new THREE.Vector3(0, 0.5, 0));

    // slow sway
    const t = frame / fps;
    desired.x += Math.sin(t * 0.4) * 0.6;
    desired.z += Math.cos(t * 0.33) * 0.6;

    if (!this.eye) { this.eye = desired.clone(); this.look = aim.clone(); }
    this.eye.lerp(desired, this.posLerp);
    this.look.lerp(aim, this.lookLerp);
    this.eye.y = Math.max(this.eye.y, maxY + 5.5);

    this.cam.position.copy(this.eye);
    this.cam.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(this.eye, this.look, UP));
    if (false) {
      console.log(`[MR] cam f${frame} eye (${this.eye.x.toFixed(1)},${this.eye.y.toFixed(1)},${this.eye.z.toFixed(1)}) look (${this.look.x.toFixed(1)},${this.look.y.toFixed(1)},${this.look.z.toFixed(1)}) dir (${this.dir.x.toFixed(2)},${this.dir.z.toFixed(2)})`);
    }
  }
}

// Three.js scene: bright outdoor look — gradient sky dome, warm sun with soft
// shadows, hemisphere fill, PMREM room environment so the glossy marbles have
// something to reflect. Subtle bloom on top. Materials are procedural (canvas
// textures) so the bundle stays self-contained.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

function woodTexture(rng, tone = 0) {
  // smooth planed wood — flowing lengthwise grain only, NO plank seams / grid.
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const x = c.getContext('2d');
  const warm = tone > 0 ? [214, 176, 124] : [201, 156, 99];
  const gr = x.createLinearGradient(0, 0, 512, 0);
  gr.addColorStop(0, `rgb(${warm[0] - 8},${warm[1] - 8},${warm[2] - 6})`);
  gr.addColorStop(0.5, `rgb(${warm[0] + 6},${warm[1] + 5},${warm[2] + 3})`);
  gr.addColorStop(1, `rgb(${warm[0] - 6},${warm[1] - 6},${warm[2] - 4})`);
  x.fillStyle = gr;
  x.fillRect(0, 0, 512, 512);
  // long, soft, wandering grain lines
  for (let k = 0; k < 90; k++) {
    const gx = rng.next() * 512;
    const amp = 3 + rng.next() * 10;
    const ph = rng.next() * 7;
    x.strokeStyle = `rgba(${112 + rng.next() * 30},${78 + rng.next() * 24},44,${0.025 + rng.next() * 0.05})`;
    x.lineWidth = 0.6 + rng.next() * 2.4;
    x.beginPath();
    x.moveTo(gx, -10);
    for (let gy = 0; gy <= 522; gy += 26) {
      x.lineTo(gx + Math.sin(gy * 0.006 + ph) * amp + Math.sin(gy * 0.021 + k) * 1.6, gy);
    }
    x.stroke();
  }
  // a few darker knots
  for (let k = 0; k < 3; k++) {
    const kx = 40 + rng.next() * 432, ky = 40 + rng.next() * 432, kr = 6 + rng.next() * 10;
    const rg = x.createRadialGradient(kx, ky, 1, kx, ky, kr);
    rg.addColorStop(0, 'rgba(84,54,28,0.5)');
    rg.addColorStop(1, 'rgba(84,54,28,0)');
    x.fillStyle = rg;
    x.beginPath(); x.ellipse(kx, ky, kr, kr * 1.5, 0, 0, 7); x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1.4, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 16;
  return t;
}

function checkerTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  const n = 8, s = 256 / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      x.fillStyle = (i + j) % 2 ? '#f2f2f2' : '#161616';
      x.fillRect(i * s, j * s, s, s);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(4, 4);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const SKY_VERT = `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const SKY_FRAG = `
  varying vec3 vDir;
  uniform vec3 top; uniform vec3 mid; uniform vec3 bot;
  void main(){
    float h = normalize(vDir).y;
    vec3 col = h > 0.0 ? mix(mid, top, pow(h, 0.55)) : mix(mid, bot, pow(-h, 0.5));
    gl_FragColor = vec4(col, 1.0);
  }`;

export class Stage {
  constructor(canvas, width, height, rng) {
    this.rng = rng;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, width / height, 0.4, 2000);

    // environment for reflections (kept subtle — RoomEnvironment is bright)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    if ('environmentIntensity' in this.scene) this.scene.environmentIntensity = 0.35;

    // sky dome
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(900, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false,
        vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
        uniforms: {
          top: { value: new THREE.Color(0x2f74d6) },
          mid: { value: new THREE.Color(0x9fd0f2) },
          bot: { value: new THREE.Color(0xe6f1f5) },
        },
      }),
    );
    this.scene.add(sky);

    // lights: bright sky fill + one warm sun.
    const hemi = new THREE.HemisphereLight(0xd6ecff, 0x6f5f48, 0.62);
    this.scene.add(hemi);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.14));
    this.sun = new THREE.DirectionalLight(0xfff0d6, 2.25);
    this.sun.position.set(40, 70, 20);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // materials — glossy planed wood + a few bright painted accents
    const woodMap = woodTexture(rng, 0);
    this.mat = {
      wood: new THREE.MeshStandardMaterial({
        map: woodMap, vertexColors: true, roughness: 0.72, metalness: 0.0,
        envMapIntensity: 0.22,
      }),
      wall: new THREE.MeshStandardMaterial({
        map: woodTexture(rng, 1), roughness: 0.7, metalness: 0.0, envMapIntensity: 0.22,
      }),
      catch: new THREE.MeshStandardMaterial({ map: woodTexture(rng, 1), roughness: 0.7, metalness: 0.0, color: 0xcdb187, envMapIntensity: 0.3 }),
      checker: new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.45, metalness: 0.0, envMapIntensity: 0.25 }),
      accent: new THREE.MeshPhysicalMaterial({ color: 0x1fa7a0, roughness: 0.45, clearcoat: 0.4, envMapIntensity: 0.5 }),
      spinner: new THREE.MeshPhysicalMaterial({ color: 0xe4552d, roughness: 0.4, clearcoat: 0.5, clearcoatRoughness: 0.2, envMapIntensity: 0.6 }),
      post: new THREE.MeshPhysicalMaterial({ color: 0x3b7de0, roughness: 0.35, clearcoat: 0.6, envMapIntensity: 0.7 }),
      gate: new THREE.MeshStandardMaterial({ color: 0xb59060, roughness: 0.55, envMapIntensity: 0.3 }),
    };

    // postprocessing — a touch of bloom on the marble speculars
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.14, 0.45, 0.9);
    this.composer.addPass(bloom);
    this.composer.addPass(new OutputPass());

    this.width = width;
    this.height = height;
    this.marbleMeshes = [];
    this.spinnerMeshes = [];
  }

  buildCourse(course) {
    const g = new THREE.Group();
    const add = (geom, material, shadow = true) => {
      if (!geom) return;
      const m = new THREE.Mesh(geom, material);
      m.castShadow = shadow;
      m.receiveShadow = true;
      g.add(m);
    };
    add(course.meshData.track, this.mat.wood);
    add(course.meshData.wood, this.mat.wall);
    add(course.meshData.accent, this.mat.accent);
    add(course.meshData.trim, this.mat.checker);
    add(course.meshData.posts, this.mat.post);
    for (const arch of course.meshData.arches || []) {
      const am = new THREE.Mesh(arch.geometry, new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(arch.color[0], arch.color[1], arch.color[2]),
        roughness: 0.4, clearcoat: 0.5, envMapIntensity: 0.6,
      }));
      am.castShadow = true;
      g.add(am);
    }
    this.scene.add(g);
    this.courseGroup = g;

    // fit sun shadow camera to the course
    const bb = course.bounds;
    const size = new THREE.Vector3();
    bb.getSize(size);
    const centre = new THREE.Vector3();
    bb.getCenter(centre);
    const r = Math.max(size.x, size.y, size.z) * 0.62;
    const cam = this.sun.shadow.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 1; cam.far = r * 4;
    this.sun.position.copy(centre).add(new THREE.Vector3(r * 0.5, r * 1.2, r * 0.35));
    this.sun.target.position.copy(centre);
    cam.updateProjectionMatrix();

    // spinners (vertical-axis turnstiles)
    const yAxis = new THREE.Vector3(0, 1, 0);
    for (const sp of course.spinners) {
      const grp = new THREE.Group();
      grp.position.set(sp.pos[0], sp.pos[1], sp.pos[2]);
      for (const arm of sp.arms) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(arm.len, arm.h, arm.t), this.mat.spinner);
        b.castShadow = true; b.receiveShadow = true;
        const rot = new THREE.Quaternion().setFromAxisAngle(yAxis, arm.angle);
        const dir = new THREE.Vector3(1, 0, 0).applyQuaternion(rot).multiplyScalar(arm.len / 2);
        b.position.copy(dir);
        b.quaternion.copy(rot);
        grp.add(b);
      }
      const hubH = sp.big ? 2.0 : 1.7;
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, hubH, 20), this.mat.gate);
      hub.castShadow = true;
      grp.add(hub);
      this.scene.add(grp);
      this.spinnerMeshes.push({ grp, axis: yAxis });
    }

    // gate
    const gate = new THREE.Mesh(
      new THREE.BoxGeometry(course.gate.hx * 2, course.gate.hy * 2, course.gate.hz * 2),
      this.mat.gate,
    );
    gate.position.set(course.gate.pos[0], course.gate.pos[1], course.gate.pos[2]);
    gate.quaternion.set(course.gate.quat[0], course.gate.quat[1], course.gate.quat[2], course.gate.quat[3]);
    gate.castShadow = true;
    this.scene.add(gate);
    this.gateMesh = gate;
  }

  addMarbles(colors, radius) {
    const geo = new THREE.SphereGeometry(radius, 56, 40);
    for (let i = 0; i < colors.length; i++) {
      const c = new THREE.Color(colors[i][1][0], colors[i][1][1], colors[i][1][2]);
      c.convertSRGBToLinear();
      const mat = new THREE.MeshPhysicalMaterial({
        color: c,
        roughness: 0.14, metalness: 0.0,
        clearcoat: 1.0, clearcoatRoughness: 0.06,
        envMapIntensity: 1.1,
        sheen: 0.3, sheenColor: c,
      });
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      this.scene.add(m);
      this.marbleMeshes.push(m);
    }
  }

  syncMarble(i, pos, quat) {
    const m = this.marbleMeshes[i];
    m.position.copy(pos);
    m.quaternion.copy(quat);
  }

  syncSpinner(i, angle) {
    const s = this.spinnerMeshes[i];
    s.grp.quaternion.setFromAxisAngle(s.axis, angle);
  }

  setGateY(y) {
    if (this.gateMesh) this.gateMesh.position.y = y;
  }

  render() {
    this.composer.render();
  }
}

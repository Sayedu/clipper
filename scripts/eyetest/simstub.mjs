// Headless, browser-free Eye Test simulator — mirrors scripts/colorwar/simstub.mjs's
// node:vm DOM-stub technique. Runs render/eyetest/game.js's real `?render=1` code
// path with zero browser, for fast statistical/determinism sweeps before spending
// any Chrome-render time. See that file for the full rationale.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const REPO = resolve(new URL('../..', import.meta.url).pathname);
const GAME_JS_PATH = resolve(REPO, 'render/eyetest/game.js');

let cachedSrc = null;
function gameSrc() {
  if (cachedSrc === null) cachedSrc = readFileSync(GAME_JS_PATH, 'utf8');
  return cachedSrc;
}

const noop = () => {};

function ctxStub() {
  const grad = { addColorStop: noop };
  return new Proxy(
    {},
    {
      get(_t, k) {
        if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
        if (k === 'canvas') return { width: 1080, height: 1920 };
        if (k === 'measureText') return () => ({ width: 10 });
        return typeof k === 'string' ? noop : undefined;
      },
      set() {
        return true;
      },
    },
  );
}
function styleStub() {
  return new Proxy({}, { get: (_t, k) => (k === 'setProperty' ? noop : ''), set: () => true });
}
function elStub() {
  const kids = new Proxy([], {
    get(t, k) {
      if (k === 'length') return 4;
      if (typeof k === 'string' && /^\d+$/.test(k)) return elStub();
      return t[k];
    },
  });
  return new Proxy(
    {
      style: styleStub(), children: kids, textContent: '', className: '',
      classList: { add: noop, remove: noop, contains: () => false },
      querySelector: () => elStub(), querySelectorAll: () => [], appendChild: noop, addEventListener: noop,
      getContext: () => ctxStub(), width: 1080, height: 1920, clientWidth: 1080, clientHeight: 1920,
    },
    { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => ((t[k] = v), true) },
  );
}

/**
 * Run one match to completion and return game.js's own `ET.result()`.
 * @param {{seed:number, balls?:string, shuffleSec?:number, fps?:number, sec?:number}} opts
 */
export function runHeadlessSim({ seed, balls = '8,8,8', shuffleSec = 6, fps = 60, sec } = {}) {
  const search = `?render=1&seed=${seed >>> 0}&balls=${encodeURIComponent(balls)}&shuffle=${shuffleSec}&fps=${fps}&w=1080&h=1920&ss=1`
    + (sec ? `&sec=${sec}` : '');
  const sandbox = {};
  const documentStub = {
    getElementById: () => elStub(),
    createElement: () => elStub(),
    addEventListener: noop,
    fonts: null,
    documentElement: { classList: { add: noop, remove: noop, contains: () => false } },
  };
  const windowStub = {
    location: { search },
    devicePixelRatio: 1,
    addEventListener: noop,
    requestAnimationFrame: noop,
    cancelAnimationFrame: noop,
    performance: { now: () => 0 },
    AudioContext: undefined,
    webkitAudioContext: undefined,
    URLSearchParams, Math, Date, JSON, console,
  };
  Object.assign(sandbox, windowStub, {
    window: windowStub, document: documentStub, self: windowStub, globalThis: sandbox,
    navigator: { userAgent: 'node' },
  });
  windowStub.window = windowStub;
  vm.createContext(sandbox);
  vm.runInContext(gameSrc(), sandbox, { filename: 'game.js' });

  const ET = sandbox.window.ET;
  const events = [];
  const hardCapFrames = 60 * 200;
  for (let f = 0; f < hardCapFrames; f++) {
    const r = ET.step();
    for (const e of r.events) events.push(e);
    if (r.done) break;
  }
  return { result: ET.result(), events };
}

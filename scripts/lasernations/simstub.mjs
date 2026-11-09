// Headless, browser-free Laser Nations DUEL simulator — mirrors
// scripts/eyetest/simstub.mjs's node:vm DOM-stub technique (itself mirroring
// scripts/colorwar/simstub.mjs). Runs render/lasernations/game.js's real
// `?render=1&duel=1` code path with zero browser, fast enough to search
// hundreds of seeds for a specific, dramatic outcome before ever opening
// Chrome. See laserDuelSearch.ts for the search itself.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const REPO = resolve(new URL('../..', import.meta.url).pathname);
const GAME_JS_PATH = resolve(REPO, 'render/lasernations/game.js');

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
      if (k === 'length') return 2;
      if (typeof k === 'string' && /^\d+$/.test(k)) return elStub();
      return t[k];
    },
  });
  return new Proxy(
    {
      style: styleStub(), children: kids, textContent: '', className: '', innerHTML: '',
      classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
      querySelector: () => elStub(), querySelectorAll: () => [], appendChild: noop, addEventListener: noop,
      getContext: () => ctxStub(), width: 1080, height: 1920, clientWidth: 1080, clientHeight: 1920,
      getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 1080, width: 1080, height: 0 }),
    },
    { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => ((t[k] = v), true) },
  );
}

/**
 * Run one duel to completion and return game.js's own `LN.result()` (which,
 * in duel mode, includes the hp-history time series `laserDuelSearch.ts`
 * scores for drama). No `sec`/duration param — a duel has no fixed length,
 * it always runs until a fighter hits 0 hp (or the internal safety cap).
 * @param {{seed:number, a?:string, b?:string, fps?:number}} opts
 */
export function runHeadlessDuel({ seed, a = '', b = '', fps = 60 } = {}) {
  const search = `?render=1&duel=1&seed=${seed >>> 0}&fps=${fps}&w=1080&h=1920&ss=1`
    + (a ? `&a=${encodeURIComponent(a)}` : '') + (b ? `&b=${encodeURIComponent(b)}` : '');
  const sandbox = {};
  const documentStub = {
    getElementById: () => elStub(),
    createElement: () => elStub(),
    addEventListener: noop,
    fonts: null,
    documentElement: { classList: { add: noop, remove: noop, contains: () => false, toggle: noop }, style: styleStub() },
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
    localStorage: { getItem: () => null, setItem: noop },
    // banner()'s fitText() reads getComputedStyle(node).fontSize — a bare
    // global in game.js, so it must exist as a sandbox-level identifier here.
    getComputedStyle: () => ({ fontSize: '16px' }),
  };
  Object.assign(sandbox, windowStub, {
    window: windowStub, document: documentStub, self: windowStub, globalThis: sandbox,
    navigator: { userAgent: 'node' },
  });
  windowStub.window = windowStub;
  vm.createContext(sandbox);
  vm.runInContext(gameSrc(), sandbox, { filename: 'game.js' });

  const LN = sandbox.window.LN;
  const events = [];
  const hardCapFrames = 60 * 90;
  for (let f = 0; f < hardCapFrames; f++) {
    const r = LN.step();
    for (const e of r.events) events.push(e);
    if (r.done) break;
  }
  return { result: LN.result(), events };
}

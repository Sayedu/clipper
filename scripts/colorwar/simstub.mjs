// Headless, browser-free Color War simulator.
//
// Stubs just enough DOM (via node:vm + Proxies) to run render/colorwar/game.js's
// real `?render=1` code path — the exact sim/physics code the real headless-
// Chrome render uses — and drives CW.step() in a tight loop with NO screenshot
// capture. This is orders of magnitude faster than launching Chromium per
// candidate seed, which is what makes scripts/colorwar/search.mjs's per-episode
// seed search practical (dozens of candidates per episode, sub-second each).
//
// This is NOT a re-implementation of the sim — it's the same game.js file,
// so it can never drift from what actually renders. It also can't influence
// what actually renders: search.mjs only ever hands the real render pipeline
// a seed this already verified, it never feeds it any simulated frames.
//
// IMPORTANT: `fps` changes the physics integration step (DT = 1/fps), so a
// seed's outcome is only guaranteed to match the real render when simulated
// at the SAME fps the render uses — 60, always, for every real render in this
// app. Only pass a different fps if you know what you're doing.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const REPO = resolve(new URL('../..', import.meta.url).pathname);
const GAME_JS_PATH = resolve(REPO, 'render/colorwar/game.js');

let cachedSrc = null;
function gameSrc() {
  // Cached per process (search.mjs simulates many seeds in one run) — the
  // file is re-read fresh each process invocation, so an edit to game.js is
  // always picked up on the next run.
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
 * Run one match to completion and return game.js's own `CW.result()` — the
 * same object shape (now including the close-game/comeback telemetry:
 * `wonCleanly`, `closestMarginDuelPct`, `deepestDipDuringDuelPct`,
 * `isThriller`, `isComeback`) that the real render's result JSON contains.
 *
 * @param {{seed:number, mode?:string, fps?:number, sec?:number}} opts
 */
export function runHeadlessSim({ seed, mode = 'classic', fps = 60, sec } = {}) {
  const search = `?render=1&seed=${seed >>> 0}&mode=${mode}&fps=${fps}&w=1080&h=1920&ss=1`
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

  const CW = sandbox.window.CW;
  const hardCapFrames = 60 * 200;   // matches game.js's own generous safety cap; never hit in practice
  for (let f = 0; f < hardCapFrames; f++) {
    const r = CW.step();
    if (r.done) break;
  }
  return CW.result();
}

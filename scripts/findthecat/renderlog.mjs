// The Find The Cat render log + variety check.
//
// Every render (CLI or dashboard — both go through render.mjs) appends one
// JSON line to render/findthecat/render-log.jsonl with its seed and full
// config. Before an unpinned render (batch / autonomous), pickVarietySeed()
// walks candidate seeds until it finds one whose first-second look (palette
// + backdrop + round-1 cup count, see plan.js's signature()) hasn't been
// used in the last 10 renders. A seed the user picked in the preview is
// never changed — that exact video is what they asked for.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';

const REPO = resolve(new URL('../..', import.meta.url).pathname);
export const LOG_PATH = join(REPO, 'render/findthecat/render-log.jsonl');
const PLAN_PATH = join(REPO, 'render/findthecat/plan.js');

let plan = null;
/** plan.js is a plain browser script; run it in a sandbox to borrow the
 *  exact same buildPlan()/signature() the game itself uses. */
export function loadPlan() {
  if (!plan) {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(PLAN_PATH, 'utf8'), sandbox, { filename: PLAN_PATH });
    plan = sandbox.FTC_PLAN;
  }
  return plan;
}

export async function recentEntries(n = 10) {
  if (!existsSync(LOG_PATH)) return [];
  const lines = (await readFile(LOG_PATH, 'utf8')).split('\n').filter((l) => l.trim());
  return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export async function appendEntry(entry) {
  await mkdir(dirname(LOG_PATH), { recursive: true });
  await appendFile(LOG_PATH, JSON.stringify(entry) + '\n');
}

/** First seed (starting at startSeed) whose look isn't among the last
 *  `window` renders. If every candidate repeats (e.g. a pinned theme leaves
 *  only a handful of combinations), falls back to the least recently used
 *  look instead of failing. */
export async function pickVarietySeed(startSeed, opts, window = 10, maxTries = 64) {
  const P = loadPlan();
  const recent = (await recentEntries(window)).map((e) => e.signature);
  let best = null;
  for (let k = 0; k < maxTries; k++) {
    const seed = ((startSeed + k * 7919) >>> 0) || 1;
    const signature = P.signature(P.buildPlan(seed, opts));
    const lastUse = recent.lastIndexOf(signature);
    if (lastUse === -1) return { seed, signature, rerolls: k, repeated: false };
    if (!best || lastUse < best.lastUse) best = { seed, signature, rerolls: k, lastUse };
  }
  return { seed: best.seed, signature: best.signature, rerolls: best.rerolls, repeated: true };
}

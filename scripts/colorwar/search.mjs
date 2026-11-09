// Seed search for Color War Season Mode.
//
// For each requested episode target (a winner colour + a close-game/comeback
// requirement), tries deterministically-generated candidate seeds through
// simstub.mjs's headless (no-Chrome) simulator until one qualifies, or gives
// up after `maxAttempts` and returns the closest miss with `usedFallback:true`
// so a bad outcome is surfaced, never silently accepted.
//
// This never touches the real render — it only ever hands back a seed for the
// worker to pin via the EXISTING `colorWarSeed` setting, so the actual render
// pipeline (and the sim's physics) is completely unmodified by Season Mode.
//
// Exported for the worker to call in-process (fast, pure computation, no
// Chromium — a whole 12-episode search normally finishes in well under a
// second, per the classic-mode hit-rate measured this session: ~99% of seeds
// already qualify as a thriller, so the search is really just "find the right
// winner," ~4 attempts on average). Also runnable standalone for debugging:
//
//   node scripts/colorwar/search.mjs --in targets.json [--out results.json]
//
// targets.json: { "planningSeed": 12345, "mode": "classic", "maxAttempts": 80,
//   "targets": [{ "episodeIndex": 1, "targetWinnerIndex": 0, "requiredKind": "thriller" }, ...] }
// requiredKind: 'thriller' (must match targetWinnerIndex AND pass the
// close-game/comeback check) | 'any' (any winner, must still pass the check —
// this is what Test Mode uses, with a single target and no season attached).

import { readFileSync, writeFileSync } from 'node:fs';
import { runHeadlessSim } from './simstub.mjs';

// A tiny deterministic mixer (splitmix32-family) — NOT the game's own RNG,
// just used to turn (planningSeed, episodeIndex, attempt) into a candidate
// seed for game.js, so the same planningSeed always searches the same
// sequence of candidates (a "reroll plan" with a new planningSeed explores a
// genuinely different set of seeds, but re-confirming the same plan is exactly
// reproducible).
function mix(a, b, c) {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ b, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ c, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) || 1;
}

/**
 * @param {{
 *   targets: {episodeIndex:number, targetWinnerIndex?:number, requiredKind:'thriller'|'any'}[],
 *   mode?: string, planningSeed?: number, maxAttempts?: number,
 * }} opts
 * @returns {{episodeIndex:number, seed:number, winner:string, telemetry:object, attempts:number, usedFallback:boolean}[]}
 */
export function searchSeasonSeeds({ targets, mode = 'classic', planningSeed = 1, maxAttempts = 80 }) {
  return targets.map((target) => {
    let best = null;   // closest miss seen so far, for the fallback path
    let bestScore = Infinity;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const seed = mix(planningSeed, target.episodeIndex, attempt);
      const r = runHeadlessSim({ seed, mode, fps: 60 });
      const winnerOk = target.requiredKind === 'any' || target.targetWinnerIndex === undefined
        || r.winner === ['BLUE', 'RED', 'GREEN', 'YELLOW'][target.targetWinnerIndex];
      if (r.wonCleanly && winnerOk && r.isThriller) {
        return { episodeIndex: target.episodeIndex, seed, winner: r.winner, telemetry: r, attempts: attempt, usedFallback: false };
      }
      // score a miss so the fallback is the LEAST-bad one, not just the last
      // one tried: matching the required winner matters more than closeness.
      const score = (winnerOk ? 0 : 1000) + Math.min(r.closestMarginDuelPct ?? 100, r.deepestDipDuringDuelPct ?? 100);
      if (r.wonCleanly && score < bestScore) { bestScore = score; best = { seed, r, attempt }; }
    }
    const fb = best || { seed: mix(planningSeed, target.episodeIndex, 1), r: runHeadlessSim({ seed: mix(planningSeed, target.episodeIndex, 1), mode, fps: 60 }), attempt: maxAttempts };
    return { episodeIndex: target.episodeIndex, seed: fb.seed, winner: fb.r.winner, telemetry: fb.r, attempts: maxAttempts, usedFallback: true };
  });
}

// ── CLI wrapper (standalone debugging use — the worker imports the function
// above directly rather than spawning this as a subprocess) ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name) => {
    const i = process.argv.indexOf('--' + name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const inPath = arg('in');
  if (!inPath) {
    console.error('usage: node search.mjs --in targets.json [--out results.json]');
    process.exit(1);
  }
  const input = JSON.parse(readFileSync(inPath, 'utf8'));
  const results = searchSeasonSeeds(input);
  const json = JSON.stringify({ results }, null, 2);
  const outPath = arg('out');
  if (outPath) writeFileSync(outPath, json);
  else process.stdout.write(json + '\n');
  const fallbacks = results.filter((r) => r.usedFallback);
  if (fallbacks.length) {
    console.error(`⚠ ${fallbacks.length} episode(s) used a fallback (closest miss, not a verified pass): ${fallbacks.map((r) => r.episodeIndex).join(', ')}`);
  }
}

import { resolve } from 'node:path';
import { paths } from '../paths.ts';

/**
 * Finds a seed for Laser Nations DUEL mode that produces a specific,
 * dramatic outcome — without the sim itself ever being told who's "supposed"
 * to win. `render/lasernations/game.js`'s duel step/damage code has no
 * concept of a forced winner anywhere in it; this just runs that exact same
 * unbiased simulation under many different seeds (via the fast, Chrome-free
 * `scripts/lasernations/simstub.mjs`) and keeps whichever one happened to
 * produce the requested outcome with a genuinely dramatic health-history
 * curve — the same trick this app's Color War Season Mode already uses to
 * guarantee a comeback story per episode. The only thing that changes
 * between attempts is the seed; nothing about the physics or damage math is
 * altered per attempt. The fight itself has no fixed length — it always
 * ends when a fighter hits 0 hp — so there's no duration to search across.
 */

export type DuelWinnerChoice = 'A' | 'B' | 'random';

export interface DuelSearchRequest {
  nationA?: string;   // '' / undefined = let the sim pick randomly
  nationB?: string;
  winner: DuelWinnerChoice;
  /** Hard cap on how many candidate seeds to try before giving up and using the best found. */
  budget?: number;
}

export interface DuelSearchResult {
  seed: number;
  nationA: string;
  nationB: string;
  winner: string;      // country name
  score: number;        // this candidate's drama score (informational)
  usedFallback: boolean; // true if nothing hit the "good enough" bar within budget
  attempts: number;
}

const GOOD_ENOUGH_SCORE = 62;   // stop early once a candidate clears this bar

/** How dramatic a duel's hp-history curve reads, 0..~100+. Higher = better TikTok fight. */
function scoreDrama(hpHistory: Array<[number, number, number]>, winnerIsA: boolean): number {
  if (hpHistory.length < 3) return 0;
  let leadChanges = 0;
  let prevSign = 0;
  let winnerMin = 100, loserMinAfterLeading = 100;
  let closeSamples = 0;
  for (const [, hpA, hpB] of hpHistory) {
    const diff = hpA - hpB;
    const sign = diff > 4 ? 1 : diff < -4 ? -1 : 0;
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) leadChanges++;
    if (sign !== 0) prevSign = sign;
    const winnerHp = winnerIsA ? hpA : hpB;
    const loserHp = winnerIsA ? hpB : hpA;
    winnerMin = Math.min(winnerMin, winnerHp);
    if (winnerHp > loserHp) loserMinAfterLeading = Math.min(loserMinAfterLeading, loserHp);
    if (Math.abs(diff) <= 18) closeSamples++;
  }
  const closeFrac = closeSamples / hpHistory.length;

  let score = 0;
  score += Math.min(4, leadChanges) * 14;                       // back-and-forth is the core of "close game"
  if (winnerMin <= 15) score += 34;                              // the eventual winner looked nearly finished at some point
  else if (winnerMin <= 35) score += 22;                         // …or at least genuinely threatened
  else if (winnerMin <= 55) score += 8;
  score += closeFrac * 26;                                       // rewards a match that STAYED close, not just swung once
  if (loserMinAfterLeading <= 25 && leadChanges >= 1) score += 6; // the loser also had a real shot before losing it
  return +score.toFixed(1);
}

export async function searchDuelSeed(req: DuelSearchRequest): Promise<DuelSearchResult> {
  const simstubPath = resolve(paths.repoRoot, 'scripts', 'lasernations', 'simstub.mjs');
  const { runHeadlessDuel } = (await import(simstubPath)) as {
    runHeadlessDuel: (opts: { seed: number; a?: string; b?: string }) => {
      result: {
        winner: string; countries: string[]; durationSec: number;
        hpHistory: Array<[number, number, number]>;
      };
    };
  };

  const budget = req.budget ?? 400;
  let best: { seed: number; score: number; winner: string; a: string; b: string } | null = null;

  for (let attempt = 0; attempt < budget; attempt++) {
    const seed = (Math.floor(Math.random() * 0x7fffffff) + 1) >>> 0;
    const { result } = runHeadlessDuel({ seed, a: req.nationA || '', b: req.nationB || '' });
    const a = result.countries[0] ?? '', b = result.countries[1] ?? '';
    const winnerIsA = result.winner === a;

    if (req.winner === 'A' && !winnerIsA) continue;
    if (req.winner === 'B' && winnerIsA) continue;

    const score = scoreDrama(result.hpHistory, winnerIsA);
    if (!best || score > best.score) best = { seed, score, winner: result.winner, a, b };
    if (best && best.score >= GOOD_ENOUGH_SCORE) {
      return { seed: best.seed, nationA: best.a, nationB: best.b, winner: best.winner, score: best.score, usedFallback: false, attempts: attempt + 1 };
    }
  }

  if (!best) {
    // pathological — the requested winner constraint was never hit at all in
    // budget (astronomically unlikely at 400 tries for a 50/50-ish sim, but
    // never leave the pipeline with nothing to render). Fall back to one
    // more unconstrained attempt so the render always has A SEED, even if
    // this specific run couldn't honor the winner choice.
    const seed = (Math.floor(Math.random() * 0x7fffffff) + 1) >>> 0;
    const { result } = runHeadlessDuel({ seed, a: req.nationA || '', b: req.nationB || '' });
    const a = result.countries[0] ?? '', b = result.countries[1] ?? '';
    return { seed, nationA: a, nationB: b, winner: result.winner, score: 0, usedFallback: true, attempts: budget + 1 };
  }
  return { seed: best.seed, nationA: best.a, nationB: best.b, winner: best.winner, score: best.score, usedFallback: true, attempts: budget };
}

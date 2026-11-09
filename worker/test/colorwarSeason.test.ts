import { describe, expect, it } from 'vitest';
import { DEFAULT_SEASON_EPISODES, MAX_SEASON_EPISODES, MIN_SEASON_EPISODES, planColorWarSeason } from '../src/colorwarSeason.ts';

const EPISODE_COUNTS = [MIN_SEASON_EPISODES, 9, 10, 12, 16, 20, 24, MAX_SEASON_EPISODES];

/** Every invariant the spec actually asked for, derived purely from the plan
 *  (no rendering involved — that's search.mjs's job, verified separately). */
function checkInvariants(plan: ReturnType<typeof planColorWarSeason>, N: number) {
  const tally: [number, number, number, number] = [0, 0, 0, 0];
  for (const p of plan) tally[p.winnerColorIndex]++;
  const clinch = plan.find((p) => p.isClinch)!;
  const champion = clinch.winnerColorIndex;
  const maxTally = Math.max(...tally);

  const recovery = plan.find((p) => p.isRecoveryWin);
  const streakEps = plan.filter((p) => p.isStreakEntry);
  const streakColor = recovery?.winnerColorIndex;

  const tallyBeforeFinale: [number, number, number, number] = [0, 0, 0, 0];
  for (const p of plan) if (p.episodeIndex < N) tallyBeforeFinale[p.winnerColorIndex]++;
  const gapBeforeFinale = Math.max(...tallyBeforeFinale) - [...tallyBeforeFinale].sort((a, b) => b - a)[1]!;

  return {
    length: plan.length === N,
    // exactly one season winner
    uniqueWinner: tally[champion] === maxTally && tally.filter((t) => t === maxTally).length === 1,
    // the clinch is always the final episode, and it's the champion's win
    clinchIsFinale: clinch.episodeIndex === N,
    // a real losing streak — long enough to read as one on screen
    streakLongEnough: streakEps.length >= 3,
    // the colour on a losing streak never wins during its own streak window
    streakColorLosesThroughout: streakColor !== undefined && streakEps.every((p) => p.winnerColorIndex !== streakColor),
    // ...then wins the very next episode
    hasRecovery: !!recovery,
    // going into the final 2 episodes, nobody could already be uncatchable —
    // the champion is tied or ahead by exactly 1, never more, never behind
    tightGoingIntoFinale: gapBeforeFinale <= 1 && tallyBeforeFinale[champion] === Math.max(...tallyBeforeFinale),
  };
}

describe('planColorWarSeason', () => {
  for (const N of EPISODE_COUNTS) {
    it(`satisfies every season invariant across many seeds (N=${N})`, () => {
      for (let seed = 1; seed <= 150; seed++) {
        const plan = planColorWarSeason(N, seed);
        const r = checkInvariants(plan, N);
        for (const [k, v] of Object.entries(r)) {
          expect(v, `seed ${seed}, N=${N}, check "${k}" failed — plan: ${JSON.stringify(plan)}`).toBe(true);
        }
      }
    });
  }

  it('clamps out-of-range episode counts into [MIN, MAX]', () => {
    expect(planColorWarSeason(2, 1)).toHaveLength(MIN_SEASON_EPISODES);
    expect(planColorWarSeason(999, 1)).toHaveLength(MAX_SEASON_EPISODES);
  });

  it('is deterministic — the same (totalEpisodes, planningSeed) always plans identically', () => {
    const a = planColorWarSeason(DEFAULT_SEASON_EPISODES, 42);
    const b = planColorWarSeason(DEFAULT_SEASON_EPISODES, 42);
    expect(a).toEqual(b);
  });

  it('a different planning seed produces a different plan', () => {
    const a = planColorWarSeason(DEFAULT_SEASON_EPISODES, 1);
    const b = planColorWarSeason(DEFAULT_SEASON_EPISODES, 2);
    expect(a).not.toEqual(b);
  });
});

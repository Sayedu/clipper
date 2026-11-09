/**
 * Color War Season Mode: plan a whole season's episode outcomes up front (so
 * standings/tension read as a real season, not N independent coin-flips), let
 * the user review that plan, then confirm it — which seed-searches a verified
 * seed for every episode and creates + enqueues one ordinary colorwar job per
 * episode. From there each episode is just a normal job: it renders through
 * the exact same pipeline as any other Color War video, lands in
 * `awaiting_review` the same way, and this module never touches its state
 * again except to read it back for the progress view.
 *
 * The one hard rule from the spec: every episode must be a nail-biter or a
 * comeback — never a blowout. That's enforced entirely by the seed search
 * (render/colorwar/game.js's own `isThriller` telemetry, verified headlessly
 * before any video is ever rendered) — this module never scripts the sim.
 */
import { createColorWarSeason, createJob, getColorWarSeason, getJob, getSettings, listColorWarSeasons, updateColorWarSeason } from './db.ts';
import { queue } from './queue.ts';
import { log } from './lib/log.ts';
import type { ColorWarEpisodePlan, ColorWarSeason, ColorWarSeasonEpisode, Settings } from './types.ts';
// scripts/colorwar/search.mjs is plain, dependency-free ESM (no Chromium) —
// importing it directly is far simpler than a subprocess/stdio protocol, and
// a whole season's search finishes in well under a second (see its header).
import { searchSeasonSeeds, type ColorWarSeedResult } from '../../scripts/colorwar/search.mjs';

const NAMES = ['BLUE', 'RED', 'GREEN', 'YELLOW'] as const;
export const MIN_SEASON_EPISODES = 8;
export const MAX_SEASON_EPISODES = 30;
export const DEFAULT_SEASON_EPISODES = 12;

// ── tiny seeded RNG for the PLANNER's own choices (which color streaks, which
// free episodes go to whom) — unrelated to game.js's RNG or search.mjs's seed
// mixer; this one just needs to make "reroll plan" reproducible per planningSeed. ──
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the whole season's win sequence up front. Constructive, not a search:
 * picks a champion and a losing-streak color/window first, fills the rest
 * with a seeded random pick, then a short correction pass tightens the
 * standings gap heading into the final 2 episodes so the title is never
 * mathematically settled early. The champion always wins the final episode —
 * that's what guarantees a unique winner without ever needing a tiebreak.
 */
export function planColorWarSeason(totalEpisodes: number, planningSeed: number): ColorWarEpisodePlan[] {
  const N = Math.max(MIN_SEASON_EPISODES, Math.min(MAX_SEASON_EPISODES, Math.floor(totalEpisodes)));
  const rng = mulberry32(planningSeed);
  const champion = Math.floor(rng() * 4);
  let streakColor = Math.floor(rng() * 4);
  if (streakColor === champion) streakColor = (streakColor + 1) % 4;

  // losing-streak window: streakColor doesn't win any of these episodes, then
  // wins the very next one (the recovery beat). Leaves room for a 2-episode
  // finale after the recovery.
  const maxStreakEnd = N - 2; // recovery episode index must land at/before this
  const streakLenMax = Math.max(3, Math.min(5, maxStreakEnd - 1));
  const streakLen = 3 + Math.floor(rng() * (streakLenMax - 3 + 1));
  const streakStartMax = Math.max(1, maxStreakEnd - streakLen);
  const streakStart = 1 + Math.floor(rng() * streakStartMax);
  const recoveryEp = streakStart + streakLen;

  const winner = new Array<number>(N + 1).fill(-1); // 1-indexed
  const w = (e: number): number => winner[e]!; // every index in [1,N] is always set below before it's read
  for (let e = streakStart; e < streakStart + streakLen; e++) {
    // anyone but streakColor
    const pool = [0, 1, 2, 3].filter((c) => c !== streakColor);
    winner[e] = pool[Math.floor(rng() * pool.length)]!;
  }
  winner[recoveryEp] = streakColor;
  winner[N] = champion; // the forced finale — see module doc comment

  for (let e = 1; e < N; e++) {
    if (w(e) !== -1) continue; // streak window or recovery, already set
    winner[e] = Math.floor(rng() * 4);
  }

  // Correction pass: after episode N-1, the champion must be tied or ahead by
  // exactly 1 — never behind (the finale couldn't fix that) and never ahead by
  // more (the season would already be decided before the finale airs). Flips
  // one episode's winner at a time to close the gap. The recovery + finale
  // slots are always fixed; a streak-window episode CAN be reassigned (who
  // beats streakColor there was never part of the story), just never TO
  // streakColor — that's the one rule the correction must still respect.
  const inStreak = (e: number) => e >= streakStart && e < streakStart + streakLen;
  const canAssign = (e: number, who: number) => e !== recoveryEp && e !== N && !(who === streakColor && inStreak(e));
  const episodesWonBy = (who: number) =>
    Array.from({ length: N - 1 }, (_, i) => i + 1).filter((e) => w(e) === who);
  const tally = (): [number, number, number, number] => {
    const t: [number, number, number, number] = [0, 0, 0, 0];
    for (let e = 1; e < N; e++) t[w(e)]!++;
    return t;
  };
  for (let guard = 0; guard < N * 4; guard++) {
    const t = tally();
    const others = [0, 1, 2, 3].filter((c) => c !== champion);
    const bestRival = others.reduce((a, b) => (t[b]! > t[a]! ? b : a));
    const gap = t[champion]! - t[bestRival]!;
    if (gap === 0 || gap === 1) break;
    if (gap > 1) {
      // champion is running away with it — hand one of their wins to WHICHEVER
      // rival can actually accept one (skip a rival only if every one of
      // champion's remaining wins sits in that rival's forbidden streak
      // window, e.g. the rival IS streakColor) — trying every rival, poorest
      // first, instead of fixating on a single "bestRival" avoids giving up
      // early on short seasons where most episodes sit inside the window.
      const wonByChampion = episodesWonBy(champion);
      const recipient = [...others].sort((a, b) => t[a]! - t[b]!).find((r) => wonByChampion.some((e) => canAssign(e, r)));
      if (recipient === undefined) break; // truly nothing left to redistribute — rare, tiny seasons only
      const e = wonByChampion.find((e) => canAssign(e, recipient))!;
      winner[e] = recipient;
    } else {
      // champion is behind — claw back a win from whichever rival can give
      // one up, richest first.
      const donor = [...others].sort((a, b) => t[b]! - t[a]!).find((r) => episodesWonBy(r).some((e) => canAssign(e, champion)));
      if (donor === undefined) break;
      const e = episodesWonBy(donor).find((e) => canAssign(e, champion))!;
      winner[e] = champion;
    }
  }

  return Array.from({ length: N }, (_, i) => {
    const e = i + 1;
    return {
      episodeIndex: e,
      winnerColorIndex: w(e) as 0 | 1 | 2 | 3,
      isClinch: e === N,
      isStreakEntry: e >= streakStart && e < streakStart + streakLen,
      isRecoveryWin: e === recoveryEp,
    };
  });
}

function randomPlanningSeed(): number {
  return (Math.floor(Math.random() * 0x7fffffff) >>> 0) || 1;
}

export function createSeason(opts: { seasonNumber: number; totalEpisodes: number }): ColorWarSeason {
  const planningSeed = randomPlanningSeed();
  const plan = planColorWarSeason(opts.totalEpisodes, planningSeed);
  return createColorWarSeason({ seasonNumber: opts.seasonNumber, totalEpisodes: plan.length, planningSeed, plan });
}

export function rerollSeasonPlan(seasonId: string): ColorWarSeason {
  const season = getColorWarSeason(seasonId);
  if (!season) throw notFound();
  if (season.status !== 'planned') throw new Error('this season is already confirmed — a new plan would no longer match its rendered episodes');
  const planningSeed = randomPlanningSeed();
  const plan = planColorWarSeason(season.totalEpisodes, planningSeed);
  updateColorWarSeason(seasonId, { plan, planningSeed, episodes: plan.map((p) => ({ episodeIndex: p.episodeIndex, status: 'planned' })) });
  return getColorWarSeason(seasonId)!;
}

/** Wins-so-far per colour ([BLUE,RED,GREEN,YELLOW]) BEFORE the given episode. */
function scoresBefore(plan: ColorWarEpisodePlan[], episodeIndex: number): [number, number, number, number] {
  const s: [number, number, number, number] = [0, 0, 0, 0];
  for (const p of plan) if (p.episodeIndex < episodeIndex) s[p.winnerColorIndex]++;
  return s;
}

/**
 * Search a verified seed for every episode, then create + enqueue one
 * colorwar job per episode (pinned seed, classic mode, season/episode/score
 * display settings). The worker's queue is single-flight, so all N jobs
 * enqueued here simply run back-to-back — no extra scheduling needed.
 */
export function confirmSeason(seasonId: string): ColorWarSeason {
  const season = getColorWarSeason(seasonId);
  if (!season) throw notFound();
  if (season.status !== 'planned') throw new Error('this season was already confirmed');

  const targets = season.plan.map((p) => ({
    episodeIndex: p.episodeIndex,
    targetWinnerIndex: p.winnerColorIndex,
    requiredKind: 'thriller' as const,
  }));
  const found: ColorWarSeedResult[] = searchSeasonSeeds({ targets, mode: 'classic', planningSeed: season.planningSeed, maxAttempts: 80 });
  const fallbacks = found.filter((f) => f.usedFallback);
  if (fallbacks.length) {
    log.warn(`colorwar season ${seasonId}: ${fallbacks.length} episode(s) fell back to a closest-miss seed (no verified thriller found in budget): ${fallbacks.map((f) => f.episodeIndex).join(', ')}`);
  }

  const base: Settings = { ...getSettings(), contentType: 'colorwar', colorWarMode: 'classic', colorWarShape: 'circle', colorWarFlipSound: 'bubble', clipsPerRun: 1 };
  const episodes: ColorWarSeasonEpisode[] = found.map((f) => {
    const settings: Settings = {
      ...base,
      colorWarSeed: f.seed,
      colorWarSeasonNumber: season.seasonNumber,
      colorWarEpisodeIndex: f.episodeIndex,
      colorWarTotalEpisodes: season.totalEpisodes,
      colorWarScoresBefore: scoresBefore(season.plan, f.episodeIndex),
    };
    const job = createJob({ settings });
    queue.enqueue(job.id);
    return { episodeIndex: f.episodeIndex, status: 'queued', seed: f.seed, jobId: job.id, usedFallback: f.usedFallback };
  });

  updateColorWarSeason(seasonId, { episodes, status: 'confirmed' });
  log.info(`colorwar season ${seasonId}: confirmed, ${episodes.length} episode(s) queued`);
  return getColorWarSeason(seasonId)!;
}

/** Live view of a season: each episode's status is read straight off its job
 *  once one exists, rather than trusted from the (possibly stale, e.g. after
 *  a worker restart) cached episodes_json — getJob() is always the truth. */
export function getSeasonWithLiveStatus(seasonId: string): ColorWarSeason | null {
  const season = getColorWarSeason(seasonId);
  if (!season) return null;
  const episodes = season.episodes.map((ep) => {
    if (!ep.jobId) return ep;
    const job = getJob(ep.jobId);
    if (!job) return ep;
    const status: ColorWarSeasonEpisode['status'] =
      job.status === 'awaiting_review' || job.status === 'saved' ? 'done'
      : job.status === 'failed' || job.status === 'canceled' ? 'failed'
      : job.status === 'running' ? 'rendering'
      : 'queued';
    return { ...ep, status };
  });
  const allSettled = episodes.length > 0 && episodes.every((e) => e.status === 'done' || e.status === 'failed');
  if (allSettled && season.status === 'confirmed') updateColorWarSeason(seasonId, { status: 'done' });
  return { ...season, episodes, status: allSettled ? 'done' : season.status };
}

export function listSeasons(): ColorWarSeason[] {
  return listColorWarSeasons();
}

/** Cancel every episode that hasn't finished rendering yet. Episodes already
 *  `awaiting_review` are left exactly as they are — canceling a season never
 *  discards a finished video. */
export function cancelSeason(seasonId: string): ColorWarSeason {
  const season = getColorWarSeason(seasonId);
  if (!season) throw notFound();
  for (const ep of season.episodes) if (ep.jobId) queue.cancel(ep.jobId);
  updateColorWarSeason(seasonId, { status: 'canceled' });
  return getSeasonWithLiveStatus(seasonId)!;
}

function notFound(): Error & { status: number } {
  const e = new Error('season not found') as Error & { status: number };
  e.status = 404;
  return e;
}

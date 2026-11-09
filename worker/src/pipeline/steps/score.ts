import { writeFileSync } from 'node:fs';
import { excludedVideoIds, recentlyUsedChannels } from '../../db.ts';
import { readVerdict, runPython } from '../../lib/python.ts';
import type { ScoredCandidate, SourceVideo } from '../../types.ts';
import type { StepContext } from '../context.ts';

/** BCP-47-ish → is it English? Treats an unset language as "maybe" (kept). */
function isEnglish(lang: string | undefined): boolean {
  return !lang || lang.startsWith('en');
}

/** Reorder so consecutive picks come from different channels (round-robin by channel). */
function interleaveByChannel(list: ScoredCandidate[]): ScoredCandidate[] {
  const buckets = new Map<string, ScoredCandidate[]>();
  for (const v of list) {
    const k = v.channel.toLowerCase();
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(v);
  }
  const queues = [...buckets.values()]; // each already in score order
  const out: ScoredCandidate[] = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const q of queues) {
      const next = q.shift();
      if (next) {
        out.push(next);
        progress = true;
      }
    }
  }
  return out;
}

/** Views per day since upload/creation — a cheap, robust "virality" proxy. */
export function viralityScore(v: SourceVideo, asOf = Date.now()): { score: number; ageDays: number } {
  const ageDays = Math.max((asOf - new Date(v.publishedAt).getTime()) / 86_400_000, 1);
  return { score: v.viewCount / ageDays, ageDays };
}

/**
 * Rank within a group, 0..1 (best = 1). Used to put YouTube and Twitch candidates
 * on one scale when a run pulls from both — 50k views means very different things
 * on the two platforms, so we compare each clip against its own kind.
 */
function toPercentiles(values: number[]): number[] {
  if (values.length <= 1) return values.map(() => 1);
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((v) => sorted.findIndex((s) => s >= v) / (sorted.length - 1));
}

export interface ScoreResult {
  /** Full ranked list (best first). The orchestrator walks it, falling through on rejection. */
  ranked: ScoredCandidate[];
  rejected: Array<{ video: SourceVideo; reason: string }>;
  excludedCount: number; // dropped for being previously used
}

/** Step 2 — bound by views/length, drop already-used videos, rank. */
export function score(ctx: StepContext, candidates: SourceVideo[], opts?: { minViews?: number }): ScoreResult {
  const { clipLengthSec, publishedWithinDays } = ctx.settings;
  const minViewCount = opts?.minViews ?? ctx.settings.minViewCount;
  const minDuration = Math.max(clipLengthSec + 15, clipLengthSec * 1.5);
  const excluded = excludedVideoIds();
  const recentChannels = recentlyUsedChannels(4);
  // For a deep back-catalogue search, views/day buries a 5-year-old classic under
  // this week's uploads — rank by total views instead once the window is wide.
  const byTotalViews = publishedWithinDays == null || publishedWithinDays > 365 * 2;

  const rejected: ScoreResult['rejected'] = [];
  interface Kept extends ScoredCandidate {
    _raw: number; // pre-normalisation strength (views or views/day)
    _penalty: number; // channel-diversity multiplier
  }
  const kept: Kept[] = [];
  let excludedCount = 0;
  let nonEnglish = 0;

  for (const v of candidates) {
    const provider = v.provider ?? 'youtube';
    const isTwitch = provider === 'twitch';
    if (excluded.has(v.videoId)) {
      excludedCount++;
      continue;
    }
    if (!isEnglish(v.lang)) {
      nonEnglish++;
      continue;
    }
    if (v.viewCount < minViewCount) {
      rejected.push({ video: v, reason: `${v.viewCount.toLocaleString()} views < ${minViewCount.toLocaleString()}` });
      continue;
    }
    // Twitch clips are pre-trimmed (≤60s) and used whole — the "long enough to cut
    // a clip from" rule doesn't apply; just guard against near-empty clips.
    if (isTwitch) {
      if (v.durationSec < 6) {
        rejected.push({ video: v, reason: `${Math.round(v.durationSec)}s — too short` });
        continue;
      }
    } else if (v.durationSec < minDuration) {
      rejected.push({ video: v, reason: `${Math.round(v.durationSec)}s — too short for a ${clipLengthSec}s clip` });
      continue;
    }
    // long videos are fine now — download.ts pulls only a `maxSourceMinutes` window
    const { score, ageDays } = viralityScore(v);
    const raw = byTotalViews ? v.viewCount : score;
    // diversity: soft-penalise a channel already clipped in the last few days
    const penalty = recentChannels.has(v.channel.toLowerCase()) ? 0.35 : 1;
    kept.push({ ...v, viralityScore: raw * penalty, ageDays, _raw: raw, _penalty: penalty });
  }

  // Mixed-platform run → normalise each platform's strength to a 0..1 percentile
  // so YouTube and Twitch clips interleave fairly instead of one scale dominating.
  const providers = new Set(kept.map((k) => k.provider ?? 'youtube'));
  if (providers.size > 1) {
    for (const p of providers) {
      const group = kept.filter((k) => (k.provider ?? 'youtube') === p);
      const pct = toPercentiles(group.map((k) => k._raw));
      group.forEach((k, i) => {
        k.viralityScore = Math.max(0.02, pct[i]!) * k._penalty;
      });
    }
  }

  const ranked: ScoredCandidate[] = kept.map(({ _raw, _penalty, ...c }) => c);
  ranked.sort((a, b) => b.viralityScore - a.viralityScore);
  // spread the top of the list across channels so a run isn't all one creator
  const spread = interleaveByChannel(ranked.slice(0, 40));
  ranked.splice(0, spread.length, ...spread);

  if (!ranked.length) {
    const why = rejected.slice(0, 3).map((r) => `· ${r.video.title.slice(0, 50)} — ${r.reason}`);
    const notes = [
      excludedCount ? `${excludedCount} already used` : '',
      nonEnglish ? `${nonEnglish} not in English` : '',
    ].filter(Boolean);
    throw new Error(`No candidate passed filtering.${notes.length ? `\n(${notes.join(', ')})` : ''}\n${why.join('\n')}`);
  }

  const top = ranked[0]!;
  ctx.log(
    'score',
    `${ranked.length} in the running${excludedCount ? `, ${excludedCount} used` : ''}${nonEnglish ? `, ${nonEnglish} non-English` : ''}; ` +
      `top "${top.title}"`,
  );
  ctx.setStep('score', 'running', {
    detail: `${ranked.length} ranked${excludedCount ? ` · ${excludedCount} already used` : ''}`,
  });
  ctx.progress('score', 1);
  return { ranked, rejected, excludedCount };
}

// --- face-cam preference ---------------------------------------------

const FACE_BIAS_TOP_N = 14;
const FACE_BOOST = 0.6; // up to +60% rank strength for a clearly face-cam thumbnail
const FACE_FULL_AREA = 0.14; // a thumbnail face at/above this share of frame area = full boost

interface FaceOnlyVerdict {
  frames?: Array<{ image: string; faces?: Array<{ areaFrac?: number }> }>;
}

/**
 * Best-effort re-rank: screen the top candidates' thumbnails for a visible face
 * and nudge the ones that have a face-cam up the order. A boost, never a filter —
 * gameplay-only clips stay eligible, just lower. On any failure the order is
 * left untouched. Mutates `viralityScore` in place; the caller re-sorts.
 */
export async function faceCamBias(ctx: StepContext, ranked: ScoredCandidate[]): Promise<void> {
  const shortlist = ranked.slice(0, FACE_BIAS_TOP_N).filter((v) => v.thumbnailUrl);
  if (shortlist.length < 3) return;

  try {
    const byBasename = new Map<string, ScoredCandidate>();
    const jpgs: string[] = [];
    await Promise.all(
      shortlist.map(async (v) => {
        try {
          const res = await fetch(v.thumbnailUrl!, { signal: AbortSignal.timeout(8000) });
          if (!res.ok) return;
          const base = `facebias-${(v.provider ?? 'yt')}-${v.videoId}.jpg`.replace(/[^\w.-]/g, '_');
          const p = ctx.file(base);
          writeFileSync(p, Buffer.from(await res.arrayBuffer()));
          byBasename.set(base, v);
          jpgs.push(p);
        } catch {
          /* skip this thumbnail */
        }
      }),
    );
    if (jpgs.length < 3) return;

    const outPath = ctx.file('face-bias.json');
    const out = await runPython('screen.py', {
      args: ['--images', ...jpgs, '--out', outPath],
      signal: ctx.signal,
      onLog: (l) => ctx.log('score', l),
    });
    const verdict = readVerdict<FaceOnlyVerdict>(outPath, out);

    let boosted = 0;
    for (const f of verdict.frames ?? []) {
      const cand = byBasename.get(f.image);
      if (!cand) continue;
      const faceArea = Math.max(0, ...(f.faces ?? []).map((x) => x.areaFrac ?? 0));
      const hint = Math.min(1, faceArea / FACE_FULL_AREA);
      if (hint > 0) {
        cand.viralityScore *= 1 + FACE_BOOST * hint;
        cand.faceFrac = faceArea;
        if (hint > 0.3) boosted++;
      }
    }
    ctx.log('score', `face-cam bias: ${boosted}/${jpgs.length} thumbnails show a clear face`);
  } catch (err) {
    ctx.log('score', `face-cam bias skipped (${(err as Error).message})`);
  }
}

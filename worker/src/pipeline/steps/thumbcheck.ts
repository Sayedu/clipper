import { writeFileSync } from 'node:fs';
import { runPython, readVerdict } from '../../lib/python.ts';
import { CandidateRejected, type ScoredCandidate } from '../../types.ts';
import { FORBIDDEN_VISUALS } from '../../guidelines.ts';
import type { StepContext } from '../context.ts';

interface ScreenVerdict {
  frames?: Array<{ faces?: Array<{ areaFrac?: number }> }>;
  women: Array<{ conf: number; areaFrac?: number; mainSubject: boolean }>;
  conceptHits: Array<{ concept: string; score: number }>;
}

/** Largest face in the thumbnail as a fraction of frame area — a cheap face-cam hint. */
function thumbFaceArea(v: ScreenVerdict): number {
  let max = 0;
  for (const f of v.frames ?? []) for (const face of f.faces ?? []) max = Math.max(max, face.areaFrac ?? 0);
  return max;
}

/**
 * Step 3 — quick screen of the thumbnail before downloading. Only a clear-cut
 * violation skips the video here (a dominant female face, or a high-confidence
 * forbidden scene); anything borderline goes to the full post-download frame
 * screen. Returns a rough face-cam hint (0..1) for scoring.
 */
export async function thumbcheck(ctx: StepContext, video: ScoredCandidate): Promise<number> {
  if (!video.thumbnailUrl) {
    ctx.setStep('thumbcheck', 'skipped', { detail: 'no thumbnail' });
    return 0;
  }

  ctx.progress('thumbcheck', 0.1, 'fetching thumbnail');
  const jpg = ctx.file(`thumb-check-${video.videoId}.jpg`);
  try {
    const res = await fetch(video.thumbnailUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(jpg, Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    ctx.log('thumbcheck', `couldn't fetch thumbnail (${(err as Error).message}) — screening after download`);
    ctx.setStep('thumbcheck', 'running', { detail: 'no thumbnail — screening later' });
    return 0;
  }

  const verdictPath = ctx.file(`thumb-verdict-${video.videoId}.json`);
  const out = await runPython('screen.py', {
    args: ['--images', jpg, '--out', verdictPath, '--concepts', ...FORBIDDEN_VISUALS],
    signal: ctx.signal,
    onProgress: (p, m) => ctx.progress('thumbcheck', 0.1 + p * 0.85, m),
    onLog: (l) => ctx.log('thumbcheck', l),
  });
  const v = readVerdict<ScreenVerdict>(verdictPath, out);

  const strongScene = v.conceptHits?.find((h) => h.score >= 0.86);
  if (strongScene) throw new CandidateRejected(`thumbnail shows ${strongScene.concept}`);

  const femaleMain = v.women?.some((w) => w.mainSubject && w.conf >= 0.7);
  if (femaleMain) throw new CandidateRejected('the thumbnail is mainly a woman');

  const face = thumbFaceArea(v);
  ctx.progress('thumbcheck', 1);
  ctx.setStep('thumbcheck', 'running', { detail: face >= 0.04 ? 'thumbnail ok · face-cam' : 'thumbnail ok' });
  return face;
}

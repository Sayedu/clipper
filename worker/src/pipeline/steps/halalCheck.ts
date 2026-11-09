import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { generateJSON } from '../../ollama.ts';
import { FORBIDDEN_CLIP_TERMS, HALAL_JUDGEMENT_SYSTEM } from '../../guidelines.ts';
import { firstDisallowedTerm } from '../../lib/textmatch.ts';
import { CandidateRejected } from '../../types.ts';
import type { StepContext } from '../context.ts';

interface ScreenVerdict {
  frames?: Array<{ concepts?: Record<string, number> }>;
  women?: unknown[];
  conceptHits?: Array<{ concept: string; score: number }>;
}

/**
 * Final strict pass/fail on the EXACT chosen clip — the last line of the content
 * guideline. Feeds Ollama the clip's spoken words plus whatever the visual screen
 * noticed; an un-confident model answer fails the clip and the run moves on.
 */
export async function halalCheck(
  ctx: StepContext,
  input: { segmentText: string; screenVerdictPath?: string },
): Promise<void> {
  ctx.progress('select', 0.95, 'guideline check');

  // cheap keyword pass on the clip itself (profanity / intoxicants / gambling / shirk)
  const hit = firstDisallowedTerm(input.segmentText, FORBIDDEN_CLIP_TERMS);
  if (hit) throw new CandidateRejected(`the clip says "${hit}"`);

  // The frame filter (InsightFace + open_clip) already ran on this exact clip and
  // let it through, so only forward genuinely strong concept signals here — not the
  // 1-2 frame face flickers it deliberately ignored (those caused false failures).
  let visualNote = 'the automatic visual scan flagged nothing';
  if (input.screenVerdictPath && existsSync(input.screenVerdictPath)) {
    try {
      const v = JSON.parse(readFileSync(input.screenVerdictPath, 'utf8')) as ScreenVerdict;
      const hits = (v.conceptHits ?? []).filter((h) => h.score >= 0.7).map((h) => `possible ${h.concept}`);
      if (hits.length) visualNote = `the automatic visual scan noted: ${hits.join('; ')}`;
    } catch {
      /* keep default */
    }
  }

  try {
    const raw = await generateJSON<{ pass: boolean; reason: string }>({
      system: HALAL_JUDGEMENT_SYSTEM,
      prompt:
        `CLIP TRANSCRIPT:\n${input.segmentText.slice(0, 4000)}\n\n` +
        `AUTOMATIC VISUAL SCAN NOTED: ${visualNote}`,
      temperature: 0,
      signal: ctx.signal,
      timeoutMs: 60_000,
    });
    const parsed = z.object({ pass: z.boolean(), reason: z.string() }).safeParse(raw);
    if (!parsed.success) {
      ctx.log('select', 'guideline check gave an unreadable answer — passing this clip through');
      return;
    }
    if (!parsed.data.pass) {
      throw new CandidateRejected(`guideline check: ${parsed.data.reason || 'not clearly compliant'}`);
    }
    ctx.log('select', 'guideline check: clip is clear');
  } catch (err) {
    if (err instanceof CandidateRejected) throw err;
    ctx.log('select', `guideline check skipped (${(err as Error).message})`);
  }
}

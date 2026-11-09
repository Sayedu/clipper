import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { generateJSON } from '../../ollama.ts';
import { runPython } from '../../lib/python.ts';
import type { SelectedSegment, Transcript } from '../../types.ts';
import {
  buildCandidates,
  heuristicPick,
  mmss,
  snapToCut,
  splitSentences,
  type Candidate,
  type Sentence,
} from '../segment.ts';
import type { StepContext } from '../context.ts';
import type { DownloadResult } from './download.ts';

const rankedPick = z.object({
  candidate: z.number().int().nonnegative(),
  hookTitle: z.string().min(3).max(120),
  reason: z.string().max(400).optional().default(''),
  score: z.number().min(0).max(1).optional().default(0.6),
});
const llmResponse = z.object({ picks: z.array(rankedPick).min(1) });

const SYSTEM = `You are a short-form video editor. You get candidate clips already cut from a long
video's transcript — each about the right length. RANK the strongest {N} for a vertical short.
Judge each on: hook in the first 2 seconds, a complete self-contained thought, a payoff or
punchline, quotability. For each, write a punchy curiosity-driven hook title (<= 8 words, no
clickbait lies, no emoji, no hashtags) and a one-line reason. score = your confidence 0..1.
Respond ONLY with JSON: {"picks":[{"candidate":int,"hookTitle":str,"reason":str,"score":number}, ...]}
ordered best first, no duplicates.`;

export interface SelectResult {
  picks: SelectedSegment[];
  cuts: number[];
}

/** Step 5 — scene cuts + local LLM rank the strongest self-contained segments. */
export async function selectSegment(
  ctx: StepContext,
  input: { transcript: Transcript; dl: DownloadResult; want?: number },
): Promise<SelectResult> {
  const { transcript, dl } = input;
  const target = ctx.settings.clipLengthSec;
  const want = Math.max(1, Math.min(input.want ?? ctx.settings.candidatesPerVideo, 5));

  // --- scene cuts (best-effort) ------------------------------------
  const cutsPath = ctx.file('cuts.json');
  let cuts: number[] = [];
  try {
    if (!dl.videoPath) {
      // long VOD: media isn't downloaded yet, so we can't scene-detect — sentence
      // boundaries carry the selection and the clip gets cut-snapped nothing here.
      ctx.log('select', 'no local video yet (long VOD) — selecting from the transcript');
    } else if (dl.source.durationSec > 20 * 60) {
      // scanning 20+ min of video for scene cuts we'll mostly not use is wasteful —
      // sentence boundaries carry the selection instead.
      ctx.log('select', `${(dl.source.durationSec / 60).toFixed(0)} min source — selecting from the transcript, skipping scene detection`);
    } else if (existsSync(cutsPath)) {
      cuts = (JSON.parse(readFileSync(cutsPath, 'utf8')) as { cuts: number[] }).cuts;
      ctx.log('select', `reusing ${cuts.length} cached scene cuts`);
    } else {
      ctx.progress('select', 0.05, 'detecting scene cuts');
      const out = await runPython('scenedetect_cuts.py', {
        args: ['--video', dl.videoPath, '--out', cutsPath],
        signal: ctx.signal,
        onProgress: (pct, msg) => ctx.progress('select', 0.05 + pct * 0.4, msg),
        onLog: (line) => ctx.log('select', line),
      });
      cuts = (JSON.parse(out) as { cuts: number[] }).cuts;
      ctx.log('select', `${cuts.length} scene boundaries`);
    }
  } catch (err) {
    ctx.log('select', `scene detection failed (${(err as Error).message}); continuing without cut-snapping`);
    cuts = [];
  }

  // --- candidate windows -----------------------------------------
  const sentences = splitSentences(transcript);
  if (sentences.length < 2) throw new Error('Transcript has too few sentences to select a segment from.');

  let candidates: Candidate[] = [];
  for (const [minR, maxR] of [
    [0.7, 1.4],
    [0.5, 1.8],
    [0.35, 2.4],
  ] as const) {
    candidates = buildCandidates(sentences, target, { minRatio: minR, maxRatio: maxR, maxCandidates: 80 });
    if (candidates.length >= want) break;
  }
  if (!candidates.length) {
    candidates = [fullVideoFallback(sentences, transcript, target)];
  }

  const shortlist = dedupeCandidates(candidates).slice(0, Math.max(10, want * 3));
  ctx.progress('select', 0.5, `${sentences.length} sentences · ${shortlist.length} candidates`);

  // --- LLM ranking ----------------------------------------------
  const list = shortlist
    .map((c, i) => `[${i}] ${mmss(c.start)}–${mmss(c.end)} (${c.durationSec.toFixed(0)}s): ${candidateText(sentences, c)}`)
    .join('\n\n');

  const raw = shortlist.length
    ? await tryRank(ctx, list, want).catch((err) => {
        ctx.log('select', `⚠ LLM ranking unavailable (${(err as Error).message}); using heuristic order`);
        return null;
      })
    : null;

  let ordered: Array<{ cand: Candidate; hookTitle: string; reason: string; score: number; method: SelectedSegment['method'] }>;

  if (raw) {
    const seen = new Set<number>();
    ordered = raw.picks
      .filter((p) => p.candidate < shortlist.length && !seen.has(p.candidate) && seen.add(p.candidate))
      .slice(0, want)
      .map((p) => ({
        cand: shortlist[p.candidate]!,
        hookTitle: p.hookTitle.trim(),
        reason: p.reason?.trim() ?? '',
        score: p.score ?? 0.6,
        method: 'llm' as const,
      }));
  } else {
    // heuristic: densest, cleanest, spread out
    const ranked = [...shortlist].sort((a, b) => heuristicScore(b, target) - heuristicScore(a, target));
    ordered = ranked.slice(0, want).map((c, i) => ({
      cand: c,
      hookTitle: deriveHookTitle(sentences[c.startSentence]?.text ?? ''),
      reason: 'Heuristic: dense, cleanly-bounded window near target length.',
      score: Math.max(0.2, 0.55 - i * 0.1),
      method: 'heuristic-fallback' as const,
    }));
  }
  void heuristicPick; // (kept for tests/back-compat)

  // --- resolve, snap, clamp, de-overlap -------------------------
  const picks: SelectedSegment[] = [];
  for (const o of ordered) {
    let start = snapToCut(Math.max(0, o.cand.start - 0.15), cuts);
    let end = snapToCut(o.cand.end + 0.1, cuts);
    if (end - start < target * 0.55 || end - start > target * 1.7) {
      start = Math.max(0, o.cand.start - 0.1);
      end = Math.min(transcript.durationSec, o.cand.end + 0.1);
    }
    end = Math.min(end, transcript.durationSec);

    const overlaps = picks.some((p) => Math.min(end, p.end) - Math.max(start, p.start) > (end - start) * 0.5);
    if (overlaps) continue;
    picks.push({ start, end, hookTitle: o.hookTitle, reason: o.reason, score: o.score, method: o.method });
  }
  if (!picks.length) throw new Error('Could not resolve any usable segment.');

  const top = picks[0]!;
  ctx.setStep('select', 'running', {
    detail: `${picks.length} candidate${picks.length > 1 ? 's' : ''} · best ${mmss(top.start)}–${mmss(top.end)} "${top.hookTitle}"${
      top.method === 'heuristic-fallback' ? ' · heuristic' : ''
    }`,
  });
  ctx.progress('select', 1);
  return { picks, cuts };
}

async function tryRank(ctx: StepContext, list: string, want: number) {
  ctx.setStep('select', 'running', { detail: 'ranking candidates with local model' });
  const raw = await generateJSON<unknown>({
    system: SYSTEM.replace(/\{N\}/g, String(want)),
    prompt: `Rank the best ${want}.\n\nCANDIDATES:\n${list}\n\nReturn JSON.`,
    temperature: 0.2,
    numCtx: 16_384,
    signal: ctx.signal,
    timeoutMs: 180_000,
  });
  return llmResponse.parse(raw);
}

function heuristicScore(c: Candidate, target: number): number {
  const lengthFit = 1 - Math.min(Math.abs(c.durationSec - target) / target, 1);
  return c.wordsPerSec * 0.4 + lengthFit * 0.5 + (c.cleanEdges ? 0.2 : 0);
}

function candidateText(sentences: Sentence[], c: Candidate): string {
  return sentences
    .slice(c.startSentence, c.endSentence + 1)
    .map((s) => s.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 480);
}

function dedupeCandidates(cands: Candidate[]): Candidate[] {
  const kept: Candidate[] = [];
  for (const c of cands) {
    const overlaps = kept.some((k) => {
      const ov = Math.max(0, Math.min(c.end, k.end) - Math.max(c.start, k.start));
      return ov / Math.min(c.durationSec, k.durationSec) > 0.55;
    });
    if (!overlaps) kept.push(c);
  }
  return kept;
}

function fullVideoFallback(sentences: Sentence[], transcript: Transcript, target: number): Candidate {
  return {
    startSentence: 0,
    endSentence: sentences.length - 1,
    start: sentences[0]!.start,
    end: Math.min(sentences[0]!.start + target, transcript.durationSec),
    durationSec: target,
    wordCount: 0,
    wordsPerSec: 0,
    cleanEdges: false,
    engagement: 0,
  };
}

function deriveHookTitle(firstSentence: string): string {
  const cleaned = firstSentence.replace(/\s+/g, ' ').trim().replace(/[.!?…]+$/, '');
  const words = cleaned.split(' ').slice(0, 8).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

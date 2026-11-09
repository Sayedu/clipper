import type { Transcript, TranscriptWord } from '../types.ts';

export interface Sentence {
  index: number;
  start: number;
  end: number;
  text: string;
  wordCount: number;
  endsClean: boolean; // terminal punctuation
}

const TERMINAL = /[.!?…]["')\]]?\s*$/;

/** Flatten transcript words and regroup them into sentence-ish units by terminal punctuation. */
export function splitSentences(transcript: Transcript, minWords = 3): Sentence[] {
  const words: TranscriptWord[] = transcript.segments.flatMap((s) => s.words);
  if (!words.length) return [];

  const sentences: Sentence[] = [];
  let buf: TranscriptWord[] = [];

  const flush = (force = false) => {
    if (!buf.length) return;
    if (!force && buf.length < minWords) return;
    const text = buf.map((w) => w.word).join('').trim();
    sentences.push({
      index: sentences.length,
      start: buf[0]!.start,
      end: buf[buf.length - 1]!.end,
      text,
      wordCount: buf.length,
      endsClean: TERMINAL.test(text),
    });
    buf = [];
  };

  for (const w of words) {
    buf.push(w);
    const tok = w.word.trim();
    if (TERMINAL.test(tok) && buf.length >= minWords) flush();
    // guard against a runaway sentence with no punctuation
    else if (buf.length >= 60) flush(true);
  }
  flush(true);
  return sentences;
}

export interface Candidate {
  startSentence: number;
  endSentence: number;
  start: number;
  end: number;
  durationSec: number;
  wordCount: number;
  wordsPerSec: number;
  cleanEdges: boolean;
  /** 0..1 — how "clippable" the text reads (energy, surprise, stakes, questions). */
  engagement: number;
}

const HYPE_WORDS =
  /\b(insane|crazy|unbelievable|no way|actually|literally|wait|stop|bro|dude|oh my|what|how|never|first time|world record|impossible|finally|nailed it|clutch|nuts|wild|scam|caught|exposed|lied|admit|prove|worst|best ever|hardest|easiest|100|1000|million|dollars?|win|won|lose|lost|beat|destroyed)\b/gi;
const LAUGH = /\b(ha ?ha|lmao|lol|hilarious|dying|can't breathe|cracking up)\b/gi;

/** Score how attention-grabbing a run of text reads. Cheap, deterministic, no model. */
export function engagementScore(text: string): number {
  if (!text.trim()) return 0;
  const words = Math.max(text.split(/\s+/).length, 1);
  const excls = (text.match(/!/g) ?? []).length;
  const qs = (text.match(/\?/g) ?? []).length;
  const caps = (text.match(/\b[A-Z]{3,}\b/g) ?? []).length;
  const hype = (text.match(HYPE_WORDS) ?? []).length;
  const laugh = (text.match(LAUGH) ?? []).length;
  const raw =
    (excls / words) * 6 +
    (qs / words) * 4 +
    (caps / words) * 5 +
    (hype / words) * 8 +
    (laugh / words) * 6;
  return Math.max(0, Math.min(1, raw));
}

/** Contiguous sentence ranges whose duration lands near `targetSec`. */
export function buildCandidates(
  sentences: Sentence[],
  targetSec: number,
  opts: { minRatio?: number; maxRatio?: number; maxCandidates?: number } = {},
): Candidate[] {
  const minRatio = opts.minRatio ?? 0.7;
  const maxRatio = opts.maxRatio ?? 1.4;
  const lo = targetSec * minRatio;
  const hi = targetSec * maxRatio;
  const out: Candidate[] = [];

  for (let i = 0; i < sentences.length; i++) {
    for (let j = i; j < sentences.length; j++) {
      const start = sentences[i]!.start;
      const end = sentences[j]!.end;
      const dur = end - start;
      if (dur < lo) continue;
      if (dur > hi) break;
      const span = sentences.slice(i, j + 1);
      const wordCount = span.reduce((n, s) => n + s.wordCount, 0);
      out.push({
        startSentence: i,
        endSentence: j,
        start,
        end,
        durationSec: dur,
        wordCount,
        wordsPerSec: wordCount / dur,
        cleanEdges: sentences[j]!.endsClean,
        engagement: engagementScore(span.map((s) => s.text).join(' ')),
      });
    }
  }

  // Prefer engaging text, then a good length fit, then denser speech.
  out.sort((a, b) => {
    const fit = (c: Candidate) => 1 - Math.min(Math.abs(c.durationSec - targetSec) / targetSec, 1);
    const rank = (c: Candidate) => c.engagement * 1.6 + fit(c) * 1.0 + Math.min(c.wordsPerSec / 4, 1) * 0.4 + (c.cleanEdges ? 0.15 : 0);
    return rank(b) - rank(a);
  });

  return out.slice(0, opts.maxCandidates ?? 60);
}

/** Snap a timestamp to the nearest scene cut within `tolerance` seconds. */
export function snapToCut(t: number, cuts: number[], tolerance = 1.2): number {
  let best = t;
  let bestDelta = tolerance;
  for (const c of cuts) {
    const d = Math.abs(c - t);
    if (d < bestDelta) {
      best = c;
      bestDelta = d;
    }
  }
  return best;
}

export interface HeuristicPick {
  start: number;
  end: number;
  startSentence: number;
  endSentence: number;
}

/** Fallback when the LLM is unavailable or returns garbage: densest clean-edged window. */
export function heuristicPick(candidates: Candidate[], targetSec: number): HeuristicPick | null {
  if (!candidates.length) return null;
  const scored = [...candidates].sort((a, b) => score(b) - score(a));
  const top = scored[0]!;
  return {
    start: top.start,
    end: top.end,
    startSentence: top.startSentence,
    endSentence: top.endSentence,
  };

  function score(c: Candidate): number {
    const lengthFit = 1 - Math.min(Math.abs(c.durationSec - targetSec) / targetSec, 1);
    return c.engagement * 1.4 + lengthFit * 0.5 + Math.min(c.wordsPerSec / 4, 1) * 0.3 + (c.cleanEdges ? 0.2 : 0);
  }
}

export function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

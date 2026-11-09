import { STEP_ORDER, type Step } from './types';
import type { StepState } from './useJobStream';

/** Rough per-step baseline seconds (tuned on an M-series laptop). transcribe is dynamic. */
const BASELINE: Record<Step, number> = {
  search: 12,
  score: 4,
  thumbcheck: 6,
  download: 40, // higher now that long VODs download a multi-minute window
  transcribe: 0, // computed
  filter: 45, // demucs sample + frame screening
  select: 30, // + the text-draft LLM call
  reframe: 15, // per candidate
  captions: 3, // per candidate (× ~40 when precise Whisper is on)
  sfx: 6, // per candidate
  render: 15, // per candidate
};
const PER_CANDIDATE: Step[] = ['reframe', 'captions', 'sfx', 'render'];

const WHISPER_SPEED: Record<string, number> = {
  'large-v3': 1.0,
  'large-v3-turbo': 5.0,
  medium: 2.2,
  small: 4.0,
};

function transcribeBaseline(sourceMinutes: number | null, whisperModel: string): number {
  const mins = sourceMinutes && sourceMinutes > 0 ? sourceMinutes : 8;
  const speed = WHISPER_SPEED[whisperModel] ?? 1;
  return Math.max(20, (mins * 60) / speed + 12); // +model load
}

/** "3.5 min source" → 3.5 */
export function parseSourceMinutes(downloadDetail: string | null): number | null {
  const m = downloadDetail && /([\d.]+)\s*min/.exec(downloadDetail);
  return m ? Number(m[1]) : null;
}

export interface EtaResult {
  remainingSec: number;
  /** false until at least one step has finished — before that the estimate is a guess. */
  confident: boolean;
}

export function estimateRemaining(
  steps: Record<Step, StepState>,
  opts: {
    sourceMinutes: number | null;
    whisperModel: string;
    now?: number;
    candidates?: number;
    transcriptSource?: 'auto' | 'youtube' | 'whisper';
    preciseCaptions?: boolean;
  },
): EtaResult {
  const now = opts.now ?? Date.now();
  const n = Math.max(1, opts.candidates ?? 1);
  const concurrency = 2;
  let remaining = 0;
  let anyDone = false;

  for (const step of STEP_ORDER) {
    const s = steps[step];
    let base: number;
    if (step === 'transcribe') {
      base = opts.transcriptSource && opts.transcriptSource !== 'whisper' ? 6 : transcribeBaseline(opts.sourceMinutes, opts.whisperModel);
    } else if (step === 'captions') {
      const precise = opts.transcriptSource !== 'whisper' && opts.preciseCaptions !== false;
      base = Math.ceil(((precise ? 40 : 3) * n) / (precise ? concurrency : 1));
    } else if (PER_CANDIDATE.includes(step)) {
      base = Math.ceil((BASELINE[step] * n) / concurrency);
    } else {
      base = BASELINE[step];
    }

    if (s.status === 'done' || s.status === 'skipped' || s.status === 'failed') {
      anyDone = true;
      continue;
    }
    if (s.status === 'running') {
      const elapsed = s.startedAt ? (now - s.startedAt) / 1000 : 0;
      const p = s.progress;
      if (p > 0.08 && elapsed > 3) {
        remaining += Math.max(0, (elapsed * (1 - p)) / p);
      } else {
        remaining += Math.max(base - elapsed, base * 0.3);
      }
      continue;
    }
    // pending
    remaining += base;
  }

  return { remainingSec: Math.round(remaining), confident: anyDone };
}

export function fmtDuration(sec: number): string {
  if (sec < 0) sec = 0;
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

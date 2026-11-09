import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { env } from '../../env.ts';
import { runPython } from '../../lib/python.ts';
import type { CropPlan, SelectedSegment, Transcript, TranscriptWord } from '../../types.ts';
import { buildAss, type CaptionWord } from '../captions.ts';
import { extractAudio } from '../ffmpeg.ts';
import type { StepContext } from '../context.ts';
import type { DownloadResult } from './download.ts';
import type { TranscribeResult } from './transcribe.ts';

export interface CaptionResult {
  assPath: string | null;
  wordCount: number;
}

/**
 * When the transcript came from YouTube, re-transcribe every candidate segment with
 * Whisper in ONE model load so the burned-in words are tight and correctly spelled.
 * Returns absolute-time word lists keyed by candidate slot; empty map if not applicable.
 */
export async function preciseTranscribeSegments(
  ctx: StepContext,
  dl: DownloadResult,
  transcript: TranscribeResult,
  picks: SelectedSegment[],
  onSub?: (pct: number, msg: string) => void,
): Promise<Map<number, TranscriptWord[]>> {
  const result = new Map<number, TranscriptWord[]>();
  // Always refine when the words came from YouTube captions; also refine a Whisper
  // transcript taken from a long source (that first pass used the fast turbo model
  // over the whole file — a focused pass on the exact ~60 s clip tightens timing).
  const longSourceWhisper = transcript.via === 'whisper' && dl.source.durationSec > 15 * 60;
  if (!ctx.settings.captionsEnabled || !ctx.settings.preciseCaptions || (transcript.via !== 'youtube' && !longSourceWhisper)) {
    return result;
  }

  const pad = 0.4;
  const audioPaths: string[] = [];
  const outPaths: string[] = [];
  const froms: number[] = [];

  for (const [i, pick] of picks.entries()) {
    const from = Math.max(0, pick.start - pad);
    const clipAudio = ctx.file(`seg16k.${i}.wav`);
    if (!existsSync(clipAudio)) {
      await extractAudio(dl.videoPath, clipAudio, {
        sampleRate: 16_000,
        channels: 1,
        start: from,
        end: pick.end + pad,
        signal: ctx.signal,
      });
    }
    audioPaths.push(clipAudio);
    outPaths.push(ctx.file(`precise.${i}.json`));
    froms.push(from);
  }

  const model = ctx.settings.whisperModel.includes('turbo') ? ctx.settings.whisperModel : 'large-v3-turbo';
  onSub?.(0.05, `refining caption timing for ${picks.length} clip(s)`);
  try {
    await runPython('transcribe.py', {
      args: ['--audio', ...audioPaths, '--out', ...outPaths, '--model', model, '--compute', env.whisper.compute, '--language', 'en'],
      signal: ctx.signal,
      onProgress: (pct, msg) => onSub?.(0.05 + pct * 0.9, msg),
      onLog: (line) => ctx.log('captions', line),
    });
  } catch (err) {
    ctx.log('captions', `precise pass failed (${(err as Error).message}) — using YouTube word timing`);
    return result;
  }

  for (const [i, out] of outPaths.entries()) {
    if (!existsSync(out)) continue;
    try {
      const precise = JSON.parse(readFileSync(out, 'utf8')) as Transcript;
      const words = precise.segments
        .flatMap((s) => s.words)
        .map((w) => ({ ...w, start: w.start + froms[i]!, end: w.end + froms[i]! }));
      result.set(i, words);
    } catch {
      /* skip this slot */
    }
  }
  return result;
}

/** Step 7 (per candidate) — build the karaoke ASS file for one segment (+ hook / overlays). */
export function buildCaptions(
  ctx: StepContext,
  input: {
    transcript: Transcript;
    segment: SelectedSegment;
    slot: number;
    preciseWords?: TranscriptWord[];
    crop?: CropPlan;
    hook?: string;
    overlays?: string[];
    rankBadge?: number;
  },
): CaptionResult {
  const [segStart, segEnd] = [input.segment.start, input.segment.end];
  const clipDurationSec = segEnd - segStart;
  const reframeMode = input.crop?.method === 'letterbox' ? 'letterbox' : 'crop';
  const captionOpts = {
    hookText: input.hook,
    overlays: input.overlays,
    reframeMode,
    barHeight: input.crop?.barHeight,
    clipDurationSec,
    rankBadge: input.rankBadge,
  } as const;

  const source = input.preciseWords?.length
    ? input.preciseWords
    : input.transcript.segments.flatMap((s) => s.words);

  const words: CaptionWord[] = ctx.settings.captionsEnabled
    ? source
        .filter((w) => w.end > segStart && w.start < segEnd && w.word.trim())
        .map((w) => ({
          text: w.word.trim(),
          start: Math.max(0, w.start - segStart),
          end: Math.max(0.05, Math.min(w.end, segEnd) - segStart),
        }))
    : [];

  // still emit an ASS file if there's a hook / overlay / rank badge even with spoken captions off
  if (!words.length && !input.hook?.trim() && !(input.overlays ?? []).length && !input.rankBadge) {
    return { assPath: null, wordCount: 0 };
  }

  const ass = buildAss(words, ctx.settings.captionStyle, captionOpts);
  const assPath = ctx.file(`captions.${input.slot}.ass`);
  writeFileSync(assPath, ass, 'utf8');
  ctx.log(
    'captions',
    `clip ${input.slot + 1}: ${words.length} words${input.preciseWords?.length ? ' (Whisper-refined)' : ''}` +
      `${input.hook ? ` + hook (${reframeMode})` : ''}`,
  );
  return { assPath, wordCount: words.length };
}

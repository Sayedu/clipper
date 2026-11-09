import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Transcript, TranscriptSegment, TranscriptWord } from '../types.ts';

interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
}
interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Seg[];
}
interface Json3 {
  events?: Json3Event[];
}

/** Locate the best YouTube subtitle file yt-dlp wrote for the job (prefers auto = word-timed). */
export function findYoutubeSubs(workDir: string): string | null {
  if (!existsSync(workDir)) return null;
  const files = readdirSync(workDir).filter((f) => f.startsWith('source.') && f.endsWith('.json3'));
  if (!files.length) return null;
  // Prefer a plain "en" (usually the ASR track, which carries per-word offsets).
  const order = ['source.en.json3', 'source.en-orig.json3', 'source.en-US.json3', 'source.en-GB.json3'];
  for (const name of order) if (files.includes(name)) return resolve(workDir, name);
  return resolve(workDir, files[0]!);
}

/**
 * Parse a YouTube json3 caption file into our Transcript shape.
 * json3 auto-captions carry `tOffsetMs` per word; manual tracks are line-level and we
 * spread word times evenly across each line.
 */
export function parseJson3(path: string): { transcript: Transcript; wordTimed: boolean } | null {
  let data: Json3;
  try {
    data = JSON.parse(readFileSync(path, 'utf8')) as Json3;
  } catch {
    return null;
  }
  const events = (data.events ?? []).filter((e) => e.segs && e.segs.length);
  if (!events.length) return null;

  const words: TranscriptWord[] = [];
  let sawOffset = false;

  for (const ev of events) {
    const base = ev.tStartMs ?? 0;
    const dur = ev.dDurationMs ?? 0;
    const segs = (ev.segs ?? []).filter((s) => s.utf8 && s.utf8.trim() && s.utf8 !== '\n');
    if (!segs.length) continue;

    const lineIsWordTimed = segs.some((s) => (s.tOffsetMs ?? 0) > 0);
    if (lineIsWordTimed) sawOffset = true;

    if (lineIsWordTimed || segs.length > 1) {
      for (const s of segs) {
        const start = (base + (s.tOffsetMs ?? 0)) / 1000;
        words.push({ start, end: start, word: normalizeWord(s.utf8!), prob: 1 });
      }
    } else {
      // one blob for the whole line — split into words and spread across its duration
      const tokens = segs[0]!.utf8!.trim().split(/\s+/);
      const span = (dur || tokens.length * 350) / 1000;
      tokens.forEach((tok, i) => {
        const start = base / 1000 + (span * i) / tokens.length;
        words.push({ start, end: start, word: (i ? ' ' : '') + tok, prob: 1 });
      });
    }
  }

  if (!words.length) return null;
  words.sort((a, b) => a.start - b.start);

  // fill end times
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1];
    words[i]!.end = next ? Math.max(words[i]!.start + 0.05, next.start) : words[i]!.start + 0.4;
  }

  // group into sentence-ish segments on >0.8s gaps
  const segments: TranscriptSegment[] = [];
  let cur: TranscriptWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    segments.push({
      start: cur[0]!.start,
      end: cur[cur.length - 1]!.end,
      text: cur.map((w) => w.word).join('').trim(),
      words: cur,
    });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    cur.push(words[i]!);
    const gap = words[i + 1] ? words[i + 1]!.start - words[i]!.end : Infinity;
    if (gap > 0.8 || cur.length >= 30) flush();
  }
  flush();

  const durationSec = words[words.length - 1]!.end;
  return { transcript: { language: 'en', durationSec, segments }, wordTimed: sawOffset };
}

function normalizeWord(raw: string): string {
  // json3 word segs usually already carry a leading space; keep it, drop newlines
  return raw.replace(/\n/g, ' ');
}

/**
 * Rebase a whole-video transcript onto a downloaded clip that starts `offsetSec`
 * into the original and runs `spanSec` long. Words outside the clip (± slack) drop;
 * the rest shift so 0 = the start of the clip.
 */
export function shiftTranscript(t: Transcript, offsetSec: number, spanSec: number): Transcript {
  if (offsetSec <= 0) return t;
  const slack = 2;
  const segments: TranscriptSegment[] = [];
  for (const seg of t.segments) {
    const words = seg.words
      .map((w) => ({ ...w, start: w.start - offsetSec, end: w.end - offsetSec }))
      .filter((w) => w.end >= -slack && w.start <= spanSec + slack)
      .map((w) => ({ ...w, start: Math.max(0, w.start), end: Math.max(0.05, w.end) }));
    if (!words.length) continue;
    segments.push({
      start: words[0]!.start,
      end: words[words.length - 1]!.end,
      text: words.map((w) => w.word).join('').trim(),
      words,
    });
  }
  return { language: t.language, durationSec: spanSec, segments };
}

import type { CaptionStyle } from '../types.ts';

export interface CaptionWord {
  text: string;
  start: number; // segment-relative seconds
  end: number;
}

export interface Phrase {
  words: CaptionWord[];
  start: number;
  end: number;
}

interface StylePreset {
  font: string;
  fontFile: string;
  size: number;
  outline: number;
  shadow: number;
  marginV: number;
  uppercase: boolean;
  /** ASS &HBBGGRR for the active word. */
  highlight: string;
  activeScale: number;
  letterSpacing: number;
}

const WHITE = '&H00FFFFFF';
const NEAR_BLACK = '&H00101010';

export const CAPTION_PRESETS: Record<CaptionStyle, StylePreset> = {
  clean: {
    font: 'Montserrat',
    fontFile: 'Montserrat-VariableFont.ttf',
    size: 74,
    outline: 3.5,
    shadow: 1.5,
    marginV: 400,
    uppercase: false,
    highlight: '&H00E5464F', // indigo #4F46E5
    activeScale: 106,
    letterSpacing: 0,
  },
  bold: {
    font: 'Anton',
    fontFile: 'Anton-Regular.ttf',
    size: 98,
    outline: 7,
    shadow: 3,
    marginV: 380,
    uppercase: true,
    highlight: '&H0000D4FF', // yellow #FFD400
    activeScale: 112,
    letterSpacing: 1,
  },
  'karaoke-pop': {
    font: 'Anton',
    fontFile: 'Anton-Regular.ttf',
    size: 104,
    outline: 7,
    shadow: 4,
    marginV: 380,
    uppercase: true,
    highlight: '&H007CF0A6', // mint/green pop
    activeScale: 116,
    letterSpacing: 1,
  },
};

const PLAY_W = 1080;
const PLAY_H = 1920;

function assTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = (s % 60).toFixed(2).padStart(5, '0');
  return `${h}:${m.toString().padStart(2, '0')}:${rest}`;
}

function escapeText(t: string): string {
  return t.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, ' ').trim();
}

/** Wrap text into up to `maxLines` lines (ASS hard break \N) near `target` chars — never drops words. */
function softWrap(text: string, target: number, maxLines = 3): string {
  const words = text.split(/\s+/);
  if (words.length < 3) return text;
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > target && lines.length < maxLines - 1) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines.join('\\N');
}

/** Group words into short caption phrases (chunk on punctuation, pauses, and length). */
export function chunkPhrases(
  words: CaptionWord[],
  opts: { maxWords?: number; maxChars?: number; maxGap?: number } = {},
): Phrase[] {
  const maxWords = opts.maxWords ?? 4;
  const maxChars = opts.maxChars ?? 24;
  const maxGap = opts.maxGap ?? 0.55;

  const phrases: Phrase[] = [];
  let cur: CaptionWord[] = [];

  const flush = () => {
    if (!cur.length) return;
    phrases.push({ words: cur, start: cur[0]!.start, end: cur[cur.length - 1]!.end });
    cur = [];
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    cur.push(w);
    const text = cur.map((x) => x.text).join(' ');
    const next = words[i + 1];
    const endsPunct = /[.!?,;:—]$/.test(w.text.trim());
    const gapNext = next ? next.start - w.end : Infinity;

    if (cur.length >= maxWords || text.length >= maxChars || endsPunct || gapNext > maxGap) {
      flush();
    }
  }
  flush();
  return phrases;
}

export interface CaptionOptions {
  hookText?: string;
  overlays?: string[];
  reframeMode?: 'crop' | 'letterbox';
  /** letterbox only — height of the top black bar in 1920-space. */
  barHeight?: number;
  clipDurationSec?: number;
  /** Top-5 countdown: 5,4,3,2,1 — draws a big "#N" badge for the whole clip. */
  rankBadge?: number;
}

/**
 * Build an ASS subtitle file with word-by-word highlighting, plus the drafted hook
 * (in the letterbox bar or a top overlay) and any extra one-line overlays.
 * `words` are segment-relative (0 = clip start).
 */
export function buildAss(words: CaptionWord[], style: CaptionStyle, opts: CaptionOptions = {}): string {
  const p = CAPTION_PRESETS[style];
  const phrases = chunkPhrases(words);
  const dur = opts.clipDurationSec ?? (words.at(-1)?.end ?? 30) + 0.5;
  const norm = (t: string) => (p.uppercase ? t.toUpperCase() : t);

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${PLAY_W}`,
    `PlayResY: ${PLAY_H}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, ' +
      'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, ' +
      'Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,${p.font},${p.size},${WHITE},${WHITE},${NEAR_BLACK},&H90000000,` +
      `0,0,0,0,100,100,${p.letterSpacing},0,1,${p.outline},${p.shadow},2,120,120,${p.marginV},1`,
    `Style: Hook,${p.font},70,${WHITE},${WHITE},${NEAR_BLACK},&H90000000,0,0,0,0,100,100,1,0,1,6,3,5,60,60,60,1`,
    `Style: Overlay,${p.font},84,${p.highlight},${p.highlight},${NEAR_BLACK},&H90000000,0,0,0,0,100,100,1,0,1,6,3,5,120,120,0,1`,
    `Style: Rank,${p.font},150,${p.highlight},${p.highlight},${NEAR_BLACK},&H60000000,0,0,0,0,100,100,0,0,1,7,4,9,60,60,60,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events: string[] = [];

  // --- top-5 rank badge (top-right, whole clip) -----------------
  if (opts.rankBadge && opts.rankBadge >= 1) {
    events.push(
      `Dialogue: 0,${assTime(0)},${assTime(dur)},Rank,,0,0,0,,{\\an9\\pos(${PLAY_W - 70},110)\\fad(200,0)\\t(0,220,\\fscx112\\fscy112)}#${opts.rankBadge}`,
    );
  }

  // --- hook -------------------------------------------------------
  if (opts.hookText?.trim()) {
    const hook = norm(escapeText(opts.hookText.trim()));
    // wrap a long hook so the big type still fits — keeps every word
    const wrapped = hook.length > 24 ? softWrap(hook, 20) : hook;
    if (opts.reframeMode === 'letterbox' && opts.barHeight) {
      const y = Math.round(opts.barHeight * 0.56); // a touch below the bar's centre
      events.push(`Dialogue: 1,${assTime(0)},${assTime(dur)},Hook,,0,0,0,,{\\an5\\pos(${PLAY_W / 2},${y})\\fad(160,0)}${wrapped}`);
    } else {
      // crop: sit it in the upper third, not jammed at the very top
      const y = Math.round(PLAY_H * 0.15);
      events.push(`Dialogue: 1,${assTime(0)},${assTime(dur)},Hook,,0,0,0,,{\\an5\\pos(${PLAY_W / 2},${y})\\fad(180,0)}${wrapped}`);
    }
  }

  // --- extra overlays (spread across the clip) ------------------
  const overlays = (opts.overlays ?? []).map((o) => o.trim()).filter(Boolean).slice(0, 3);
  overlays.forEach((line, i) => {
    const at = dur * (0.28 + 0.32 * i);
    events.push(
      `Dialogue: 2,${assTime(at)},${assTime(Math.min(at + 2.4, dur))},Overlay,,0,0,0,,` +
        `{\\an5\\pos(${PLAY_W / 2},${Math.round(PLAY_H * 0.32)})\\fad(120,120)\\t(0,120,\\fscx108\\fscy108)}${norm(escapeText(line))}`,
    );
  });

  for (const phrase of phrases) {
    const n = phrase.words.length;
    const phraseEnd = nextPhraseStart(phrases, phrase) ?? phrase.end + 0.4;
    for (let k = 0; k < n; k++) {
      const activeStart = k === 0 ? phrase.start : phrase.words[k]!.start;
      const activeEnd =
        k === n - 1
          ? Math.min(phrase.end + 0.35, phraseEnd - 0.02) // hold last word, but not into the next phrase
          : phrase.words[k + 1]!.start;
      if (activeEnd <= activeStart) continue;

      const text = phrase.words
        .map((w, idx) => {
          const t = norm(escapeText(w.text));
          if (idx !== k) return t;
          return (
            `{\\1c${p.highlight}\\fscx${p.activeScale}\\fscy${p.activeScale}` +
            `\\t(0,90,\\fscx${p.activeScale + 3}\\fscy${p.activeScale + 3})}` +
            `${t}` +
            `{\\1c${WHITE}\\fscx100\\fscy100}`
          );
        })
        .join(' ');

      // Fade only at the phrase edges — snappy cuts between words inside a phrase.
      const fad = k === 0 ? '{\\fad(70,0)}' : k === n - 1 ? '{\\fad(0,70)}' : '';
      events.push(
        `Dialogue: 0,${assTime(activeStart)},${assTime(activeEnd)},Cap,,0,0,0,,${fad}${text}`,
      );
    }
  }

  return [...header, ...events, ''].join('\n');
}

function nextPhraseStart(phrases: Phrase[], current: Phrase): number | null {
  const i = phrases.indexOf(current);
  return i >= 0 && i < phrases.length - 1 ? phrases[i + 1]!.start : null;
}

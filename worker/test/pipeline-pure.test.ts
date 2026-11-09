import { describe, expect, it } from 'vitest';
import { viralityScore } from '../src/pipeline/steps/score.ts';
import { buildAss, chunkPhrases, type CaptionWord } from '../src/pipeline/captions.ts';
import { buildCropFilter, thinKeyframes } from '../src/pipeline/cropExpr.ts';
import { parseISODuration } from '../src/youtube.ts';
import type { CropPlan, SourceVideo } from '../src/types.ts';

const baseVideo: SourceVideo = {
  videoId: 'x',
  title: 't',
  channel: 'c',
  url: 'u',
  publishedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
  durationSec: 600,
  viewCount: 1_000_000,
  likeCount: 10_000,
};

describe('viralityScore', () => {
  it('is views per day since upload', () => {
    const { score, ageDays } = viralityScore(baseVideo);
    expect(Math.round(ageDays)).toBe(10);
    expect(Math.round(score)).toBe(100_000);
  });
  it('never divides by less than one day', () => {
    const { score } = viralityScore({ ...baseVideo, publishedAt: new Date().toISOString() });
    expect(score).toBe(1_000_000);
  });
});

describe('parseISODuration', () => {
  it('parses hours/minutes/seconds', () => {
    expect(parseISODuration('PT1H2M3S')).toBe(3723);
    expect(parseISODuration('PT45S')).toBe(45);
    expect(parseISODuration('PT10M')).toBe(600);
    expect(parseISODuration('garbage')).toBe(0);
  });
});

describe('chunkPhrases', () => {
  const w = (text: string, start: number, end: number): CaptionWord => ({ text, start, end });
  it('breaks on length, punctuation and pauses', () => {
    const phrases = chunkPhrases([
      w('the', 0, 0.3),
      w('quick', 0.3, 0.6),
      w('brown,', 0.6, 0.9), // punctuation -> break
      w('fox', 2.0, 2.3), // long gap before -> already broken; new phrase
      w('jumps', 2.3, 2.6),
    ]);
    expect(phrases.length).toBeGreaterThanOrEqual(2);
    expect(phrases[0]!.words.map((x) => x.text).join(' ')).toBe('the quick brown,');
  });
});

describe('buildAss', () => {
  const words: CaptionWord[] = [
    { text: 'Hello', start: 0, end: 0.5 },
    { text: 'there', start: 0.5, end: 1.0 },
    { text: 'world', start: 1.0, end: 1.6 },
  ];
  it('emits a valid-looking ASS document with per-word events', () => {
    const ass = buildAss(words, 'karaoke-pop');
    expect(ass).toContain('[Script Info]');
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('[V4+ Styles]');
    expect(ass).toMatch(/Dialogue: 0,0:00:00\.00,/);
    // one event per word
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogues.length).toBe(3);
    expect(ass).toContain('HELLO'); // karaoke-pop is uppercase
  });
  it('clean style keeps original case', () => {
    expect(buildAss(words, 'clean')).toContain('Hello');
  });
});

describe('cropExpr', () => {
  const plan: CropPlan = {
    sourceWidth: 1920,
    sourceHeight: 1080,
    cropWidth: 608,
    cropHeight: 1080,
    method: 'tracked',
    keyframes: [
      { t: 0, x: 100, y: 0 },
      { t: 1, x: 120, y: 0 },
      { t: 2, x: 200, y: 0 },
      { t: 3, x: 210, y: 0 },
    ],
  };

  it('thins keyframes to the requested maximum', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ t: i * 0.1, x: Math.sin(i) * 50 + 100, y: 0 }));
    expect(thinKeyframes(many, 30).length).toBeLessThanOrEqual(30);
  });

  it('builds a clamped animated crop filter', () => {
    const { filter } = buildCropFilter(plan);
    expect(filter).toMatch(/^crop=608:1080:/);
    expect(filter).toContain("x='clip(");
    expect(filter).toContain('lt(t,0)');
    expect(filter).not.toContain('\\,'); // no escaped commas inside the quoted expr
  });

  it('falls back to a static centre crop', () => {
    const { filter } = buildCropFilter({ ...plan, method: 'center-fallback', keyframes: [] });
    expect(filter).toBe('crop=608:1080:656:0');
  });
});

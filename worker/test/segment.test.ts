import { describe, expect, it } from 'vitest';
import { buildCandidates, heuristicPick, snapToCut, splitSentences } from '../src/pipeline/segment.ts';
import type { Transcript } from '../src/types.ts';

function words(spec: Array<[string, number, number]>) {
  return spec.map(([word, start, end]) => ({ word, start, end, prob: 0.9 }));
}

const transcript: Transcript = {
  language: 'en',
  durationSec: 30,
  segments: [
    {
      start: 0,
      end: 30,
      text: '',
      words: words([
        ['This ', 0, 0.4],
        ['is ', 0.4, 0.7],
        ['a ', 0.7, 0.8],
        ['test. ', 0.8, 1.3],
        ['The ', 1.4, 1.7],
        ['second ', 1.7, 2.2],
        ['sentence ', 2.2, 2.9],
        ['is ', 2.9, 3.1],
        ['here! ', 3.1, 3.6],
        ['And ', 10, 10.3],
        ['a ', 10.3, 10.4],
        ['third ', 10.4, 10.9],
        ['one ', 10.9, 11.3],
        ['ends ', 11.3, 11.7],
        ['things. ', 11.7, 12.3],
      ]),
    },
  ],
};

describe('splitSentences', () => {
  it('splits on terminal punctuation with a min word count', () => {
    const s = splitSentences(transcript);
    expect(s).toHaveLength(3);
    expect(s[0]!.text).toBe('This is a test.');
    expect(s[0]!.endsClean).toBe(true);
    expect(s[1]!.text).toContain('second sentence');
    expect(s[2]!.start).toBe(10);
  });

  it('returns [] for an empty transcript', () => {
    expect(splitSentences({ language: 'en', durationSec: 0, segments: [] })).toEqual([]);
  });
});

describe('buildCandidates', () => {
  it('produces contiguous windows near the target length', () => {
    const sentences = splitSentences(transcript);
    const cands = buildCandidates(sentences, 12, { minRatio: 0.5, maxRatio: 1.5 });
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(c.durationSec).toBeGreaterThanOrEqual(6);
      expect(c.durationSec).toBeLessThanOrEqual(18);
      expect(c.endSentence).toBeGreaterThanOrEqual(c.startSentence);
    }
  });

  it('is sorted with the closest-to-target window first', () => {
    const sentences = splitSentences(transcript);
    const cands = buildCandidates(sentences, 12, { minRatio: 0.3, maxRatio: 2 });
    const first = cands[0]!;
    const worst = cands[cands.length - 1]!;
    expect(Math.abs(first.durationSec - 12)).toBeLessThanOrEqual(Math.abs(worst.durationSec - 12) + 2);
  });
});

describe('snapToCut', () => {
  it('snaps within tolerance and leaves alone outside it', () => {
    expect(snapToCut(10.4, [0, 10, 20], 1)).toBe(10);
    expect(snapToCut(10.4, [0, 5, 20], 1)).toBe(10.4);
    expect(snapToCut(10.4, [], 1)).toBe(10.4);
  });
});

describe('heuristicPick', () => {
  it('returns a candidate when given some', () => {
    const sentences = splitSentences(transcript);
    const cands = buildCandidates(sentences, 12, { minRatio: 0.3, maxRatio: 2 });
    const pick = heuristicPick(cands, 12);
    expect(pick).not.toBeNull();
    expect(pick!.end).toBeGreaterThan(pick!.start);
  });

  it('returns null with no candidates', () => {
    expect(heuristicPick([], 12)).toBeNull();
  });
});

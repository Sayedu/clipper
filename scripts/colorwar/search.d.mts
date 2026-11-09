// Type declaration for search.mjs (plain JS) — picked up automatically by
// TypeScript for `import ... from './search.mjs'` (the `.d.mts` sibling
// convention). Keep in sync with the JSDoc types in search.mjs by hand.

export interface ColorWarSeedTarget {
  episodeIndex: number;
  targetWinnerIndex?: number;
  requiredKind: 'thriller' | 'any';
}

export interface ColorWarSeedResult {
  episodeIndex: number;
  seed: number;
  winner: string;
  telemetry: {
    wonCleanly: boolean;
    closestMarginDuelPct: number;
    deepestDipDuringDuelPct: number;
    isThriller: boolean;
    isComeback: boolean;
    [key: string]: unknown;
  };
  attempts: number;
  usedFallback: boolean;
}

export function searchSeasonSeeds(opts: {
  targets: ColorWarSeedTarget[];
  mode?: string;
  planningSeed?: number;
  maxAttempts?: number;
}): ColorWarSeedResult[];

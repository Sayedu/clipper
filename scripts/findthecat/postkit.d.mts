export interface FindTheCatRenderResult {
  seed: number;
  roundCount: number;
  durationSec: number;
  hook?: string;
  theme: string;
  backdrop: string;
  cups: number[];
  difficulty: string[];
  twists?: string[];
  answers: number[];
  roundTotalSec: number;
  revealOffsetSec: number;
}

export interface PostKit {
  caption: string;
  hashtags: string[];
  pinnedComment: string;
  hook: string;
  coverSub: string;
}

export const COVER_FONT: string;
export const LENGTH_ROUNDS: { short: number; long: number };
export function lengthModeFor(rounds: number): 'short' | 'long' | 'custom';
export function baseName(r: FindTheCatRenderResult): string;
export function buildPostKit(r: FindTheCatRenderResult): PostKit;
export function postKitText(kit: PostKit, r: FindTheCatRenderResult, files?: Record<string, string | null | undefined>): string;
export function coverTimeSec(r: FindTheCatRenderResult): number;
export function writeCover(o: { ffmpeg: string; video: string; atSec: number; out: string; hook: string; sub: string; top?: number }): Promise<string>;

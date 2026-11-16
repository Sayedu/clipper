export interface KitEntry {
  id: string;
  createdAt: string;
  format: string;
  seed: number;
  kitDir: string;
  source: { input: string; video: string };
  caption: string;
  captionFirstLine: string;
  captionStyle: string;
  hashtags: string[];
  hook: { id: string; lines: string[]; style: Record<string, unknown> };
  cover: { id: string; lines: string[]; phash: string; atSec: number; style: Record<string, unknown> };
  pinned: string;
  sound: { track: string; bpm?: number };
  look: { bg: string; border: string; borderColour: string; zoom: string };
  video: { width: number; height: number; fps: number; durationSec: number };
  posted: boolean;
  postedAt?: string;
  [k: string]: unknown;
}
export interface PackageOptions {
  preset?: string;
  writeLog?: string;
  readLogs?: string[];
  outDir?: string;
  log?: boolean;
  salt?: string;
  verbose?: boolean;
  keepWork?: boolean;
  /** true = add a generated music bed under the game sound (also PACKAGING_BED=on); off by default */
  bed?: boolean;
}
export const KITS_DIR: string;
export const TRACKS: string[];
export function packageVideo(input: string, opts?: PackageOptions): Promise<KitEntry>;
export function findRenders(o?: { format?: string | null }): Array<{ dir: string; format: string; mtime: number }>;
export function writeQueue(outDir?: string, logPath?: string | null): Array<{ id: string; format: string; kitDir: string; caption: string; backToBack: boolean }>;

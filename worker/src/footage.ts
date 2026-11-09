import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { nanoid } from 'nanoid';
import { env } from './env.ts';
import { paths } from './paths.ts';
import { log } from './lib/log.ts';
import { stream } from './lib/exec.ts';
import {
  addFootageClip,
  deleteFootageClip,
  excludedVideoIds,
  footageSourceIds,
  listFootageClips,
  recentFootageSlices,
  recordFootageSlice,
  type FootageClip,
} from './db.ts';
import { searchVideos } from './youtube.ts';
import { ffprobe } from './pipeline/ffmpeg.ts';
import { contentFilter } from './pipeline/steps/filter.ts';
import { CandidateRejected, type SourceVideo } from './types.ts';
import type { StepContext } from './pipeline/context.ts';

// We download whole SHORT gameplay videos (not deep-seek windows — those are slow
// on YouTube) and slice stories out of them. So: sources must be between these
// bounds, and we keep roughly TARGET_CLIPS of them, growing a couple per run.
const MIN_SOURCE_SEC = 150;
const MAX_SOURCE_SEC = 22 * 60;

/** Titles that mean "not actual gameplay footage" — tutorials, setup, recording guides. */
const NOT_GAMEPLAY =
  /how to|tutorial|guide|\bset ?up\b|install|\bdownload\b|\bobs\b|bluestacks|emulator|\bapk\b|\bsettings\b|\bcontrols?\b|(reduce|fix|no|less) lag|best way to|review|unboxing|explained|top \d+|tier list|reaction|face ?cam/i;
/** Titles that positively signal clean gameplay. */
const IS_GAMEPLAY = /gameplay|no commentary|longplay|walkthrough|full game|playthrough|speedrun|100%|all levels/i;
const TARGET_CLIPS = 6;
const FIRST_RUN_CLIPS = 2; // an empty library only grabs this many, then grows
const GROW_PER_RUN = 2;
const PER_DOWNLOAD_MS = 150_000;
const MAX_LIBRARY_BYTES = 6 * 1024 ** 3; // ~6 GB cap

const ffmpegLoc = () => (env.ffmpeg.startsWith('/') ? ['--ffmpeg-location', dirname(env.ffmpeg)] : []);
const ytdlpAuth = () => [
  ...(env.ytdlpCookiesFromBrowser ? ['--cookies-from-browser', env.ytdlpCookiesFromBrowser] : []),
  ...(env.ytdlpCookiesFile ? ['--cookies', env.ytdlpCookiesFile] : []),
];

export interface FootageStatus {
  count: number;
  totalMinutes: number;
  clips: Array<{ id: string; title: string | null; channel: string | null; minutes: number }>;
}

export function footageStatus(): FootageStatus {
  const clips = listFootageClips().filter((c) => existsSync(c.path));
  return {
    count: clips.length,
    totalMinutes: Math.round(clips.reduce((s, c) => s + c.durationSec, 0) / 60),
    clips: clips.map((c) => ({
      id: c.id,
      title: c.sourceTitle,
      channel: c.sourceChannel,
      minutes: Math.round(c.durationSec / 60),
    })),
  };
}

/** Download a whole short gameplay video at <=720p into data/footage/<id>.mp4. */
async function downloadFootageVideo(
  video: SourceVideo,
  outPath: string,
  signal: AbortSignal,
  onProgress: (pct: number) => void,
  onLog: (l: string) => void,
): Promise<void> {
  mkdirSync(dirname(outPath), { recursive: true });
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(PER_DOWNLOAD_MS)]);
  await stream(
    'yt-dlp',
    [
      '--no-playlist', '--newline', '--no-warnings', '--no-part',
      ...ffmpegLoc(),
      ...ytdlpAuth(),
      '-f', 'bv*[height<=720][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=720]+ba/b[height<=720]/b',
      '--merge-output-format', 'mp4',
      '--progress-template', 'download:__P__ %(progress._percent_str)s',
      '-o', outPath.replace(/\.mp4$/, '.%(ext)s'),
      video.url,
    ],
    {
      signal: timeout,
      onStdout: (l) => {
        const m = /__P__\s+([\d.]+)%/.exec(l);
        if (m) onProgress(Number(m[1]) / 100);
      },
      onStderr: (l) => onLog(l.trim()),
    },
  );
  if (!existsSync(outPath)) {
    const base = outPath.replace(/\.mp4$/, '');
    for (const e of ['mkv', 'webm', 'mov']) {
      const alt = `${base}.${e}`;
      if (existsSync(alt)) rmSync(alt, { force: true });
    }
  }
}

function libraryBytes(): number {
  return listFootageClips().reduce((s, c) => s + (existsSync(c.path) ? statSync(c.path).size : 0), 0);
}

/** Drop the oldest footage files once the library is over the size cap. */
function pruneLibrary(): void {
  const clips = [...listFootageClips()].sort((a, b) => (a.addedAt < b.addedAt ? -1 : 1));
  while (libraryBytes() > MAX_LIBRARY_BYTES && clips.length > 3) {
    const old = clips.shift()!;
    rmSync(old.path, { force: true });
    deleteFootageClip(old.id);
    log.info(`pruned old footage ${old.id} (${old.sourceTitle ?? old.sourceVideoId})`);
  }
}

/**
 * Fill the background-footage library using the existing YouTube search+download.
 * Each hit is screened with the SAME `contentFilter` (no people on camera, no
 * forbidden scenes; music is ignored — footage gets muted). Runs inside a job's
 * `search` step so it has a real StepContext for the screen.
 */
export async function populateFootage(
  ctx: StepContext,
  opts: { queries: string[]; want?: number } = { queries: [] },
): Promise<{ added: number; have: number }> {
  const queries = (opts.queries.length ? opts.queries : ctx.settings.backgroundFootageQueries)
    .map((q) => q.trim())
    .filter(Boolean);
  if (!queries.length) throw new Error('No background-footage search terms set (Settings → Storyteller).');

  const haveNow = listFootageClips().filter((c) => existsSync(c.path)).length;
  // empty library → just grab enough to make this story; otherwise grow a little
  const target = opts.want ?? (haveNow === 0 ? FIRST_RUN_CLIPS : Math.min(TARGET_CLIPS, haveNow + GROW_PER_RUN));
  const need = Math.max(0, target - haveNow);
  if (need === 0) return { added: 0, have: haveNow };
  ctx.log('search', `footage library has ${haveNow}, fetching ${need} more`);

  const skip = new Set([...footageSourceIds(), ...excludedVideoIds()]);
  const pool = new Map<string, SourceVideo>();
  for (const q of [...queries].sort(() => Math.random() - 0.5).slice(0, 3)) {
    ctx.throwIfCanceled();
    ctx.setStep('search', 'running', { detail: `finding gameplay: "${q}"` });
    const res = await searchVideos({ query: q, maxResults: 30 }).catch(() => []);
    for (const v of res) {
      if (
        !pool.has(v.videoId) &&
        !skip.has(v.videoId) &&
        v.durationSec >= MIN_SOURCE_SEC &&
        v.durationSec <= MAX_SOURCE_SEC &&
        v.viewCount >= 2_000 &&
        !NOT_GAMEPLAY.test(v.title) &&
        IS_GAMEPLAY.test(v.title)
      ) {
        pool.set(v.videoId, v);
      }
    }
  }
  // "no commentary" in the title first, then random
  const candidates = [...pool.values()].sort(
    (a, b) => Number(/no commentary/i.test(b.title)) - Number(/no commentary/i.test(a.title)) || Math.random() - 0.5,
  );
  if (!candidates.length) throw new Error('No usable short gameplay videos found for those search terms.');

  let added = 0;
  let tried = 0;
  for (const video of candidates) {
    if (added >= need || tried >= need + 8) break;
    tried++;
    ctx.throwIfCanceled();
    const id = nanoid(12);
    const outPath = resolve(paths.footage, `${id}.mp4`);
    try {
      ctx.setStep('search', 'running', { detail: `downloading gameplay ${added + 1}/${need} — ${video.channel}` });
      await downloadFootageVideo(
        video,
        outPath,
        ctx.signal,
        (p) => ctx.progress('search', p, `downloading gameplay ${added + 1}/${need} · ${Math.round(p * 100)}%`),
        (l) => ctx.log('search', l),
      );
      if (!existsSync(outPath)) throw new CandidateRejected('download produced no file');

      const probe = await ffprobe(outPath);
      if (probe.durationSec < MIN_SOURCE_SEC) throw new CandidateRejected('shorter than reported');
      ctx.setStep('search', 'running', { detail: `screening gameplay ${added + 1}/${need}` });
      await contentFilter(ctx, {
        dl: { source: video, videoPath: outPath, infoJsonPath: null, thumbnailPath: null, youtubeSubsPath: null, deferred: false, windowOffsetSec: 0 },
        transcript: { language: 'en', durationSec: probe.durationSec, segments: [] },
        skipTranscript: true,
        skipMusic: true,
        noPeople: true,
        windows: [{ start: 3, end: Math.min(probe.durationSec, 180) }],
      });

      addFootageClip({
        id,
        path: outPath,
        sourceVideoId: video.videoId,
        sourceTitle: video.title,
        sourceChannel: video.channel,
        durationSec: probe.durationSec,
      });
      added++;
      ctx.log('search', `+ footage: ${video.title.slice(0, 50)} (${(probe.durationSec / 60).toFixed(1)} min)`);
    } catch (err) {
      rmSync(outPath, { force: true });
      const reason = err instanceof CandidateRejected ? err.reason : (err as Error).message;
      ctx.log('search', `footage "${video.title.slice(0, 40)}" skipped — ${reason}`);
    }
  }

  pruneLibrary();
  const have = listFootageClips().filter((c) => existsSync(c.path)).length;
  if (have === 0) throw new Error('Could not add any clean gameplay footage — try different search terms in Settings.');
  return { added, have };
}

export interface FootageSlice {
  clip: FootageClip;
  startSec: number;
  endSec: number;
}

function overlaps(a: [number, number], b: [number, number]): boolean {
  return Math.min(a[1], b[1]) - Math.max(a[0], b[0]) > (a[1] - a[0]) * 0.4;
}

/**
 * Pick a continuous `durationSec` slice from a random library clip, avoiding
 * windows used recently (so back-to-back stories don't reuse the same footage).
 */
export function pickFootageSlice(durationSec: number): FootageSlice {
  const clips = listFootageClips().filter((c) => existsSync(c.path) && c.durationSec >= durationSec + 4);
  if (!clips.length) {
    throw new Error('The background-footage library is empty. Open Settings → Storyteller → Refresh footage.');
  }
  // fewer-recently-used clips first, then random
  const scored = clips
    .map((c) => ({ c, recent: recentFootageSlices(c.id, 50).length }))
    .sort((a, b) => a.recent - b.recent || Math.random() - 0.5);

  for (const { c } of scored) {
    const maxStart = c.durationSec - durationSec - 1;
    const used = recentFootageSlices(c.id, 25);
    for (let tries = 0; tries < 24; tries++) {
      const start = Math.random() * Math.max(1, maxStart);
      const win: [number, number] = [start, start + durationSec];
      if (!used.some((u) => overlaps(win, u))) {
        recordFootageSlice(c.id, start, start + durationSec);
        return { clip: c, startSec: start, endSec: start + durationSec };
      }
    }
  }
  // everything's been used recently — just take the least-recently-used clip from the top
  const c = scored[0]!.c;
  const start = Math.random() * Math.max(1, c.durationSec - durationSec - 1);
  recordFootageSlice(c.id, start, start + durationSec);
  return { clip: c, startSec: start, endSec: start + durationSec };
}

/** On startup, drop DB rows whose files vanished. */
export function reconcileFootage(): void {
  let gone = 0;
  for (const c of listFootageClips()) {
    if (!existsSync(c.path)) {
      deleteFootageClip(c.id);
      gone++;
    }
  }
  // also drop orphan files with no row
  if (existsSync(paths.footage)) {
    const known = new Set(listFootageClips().map((c) => resolve(c.path)));
    for (const f of readdirSync(paths.footage)) {
      const p = resolve(paths.footage, f);
      if (/\.(mp4|mkv|webm|mov)$/i.test(f) && !known.has(p)) rmSync(p, { force: true });
    }
  }
  if (gone) log.info(`footage library: dropped ${gone} missing file(s)`);
}

/**
 * How each posted game gets rendered for posting. Shared by the daily
 * poster (scripts/post/daily.ts) and the local "render + package" command
 * (scripts/packaging/render.ts) so both produce exactly the same kind of
 * video.
 *
 * Every render here sets `packaged: true`: the games skip their fixed
 * opening title (display only, gameplay untouched) because the post
 * packaging (scripts/packaging) overlays a fresh, different hook on top.
 */
import { randomInt } from 'node:crypto';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createJob, getJob } from '../../worker/src/db.ts';
import { runPipeline } from '../../worker/src/pipeline/run.ts';
import type { Broadcaster } from '../../worker/src/pipeline/context.ts';
import { jobCandidateFile } from '../../worker/src/library.ts';
import { DEFAULT_SETTINGS, type Settings } from '../../worker/src/types.ts';

const pexec = promisify(execFile);

// the daily rotation — add to this list to add another game later.
// lasernationsDuel was removed and replaced with ringofdoom by request.
// disasterdrop was tried here too, then reverted: it's an already-built,
// never-posted colorwars event, not an actually new simulation. hotpotato
// is a real new one -- 16 balls bouncing in a static bowl, one holds a
// "bomb" that passes hands on contact, a shrinking per-round timer
// eliminates whoever's holding it when it hits zero.
export const ROTATION = ['colorwar', 'ringofdoom', 'hotpotato', 'followball', 'eyetest'] as const;
export type Rotation = (typeof ROTATION)[number];
export type ColorwarsKind = Extract<Rotation, 'ringofdoom' | 'hotpotato'>;
export type JsGame = Exclude<Rotation, ColorwarsKind> | 'findthecat';

export function isRotation(v: string): v is Rotation {
  return (ROTATION as readonly string[]).includes(v);
}

// ringofdoom doesn't go through the JS pipeline/Settings at all (see
// renderColorwarsEvent), so this only ever needs to handle the rest.
export function settingsFor(kind: JsGame): Settings {
  const base: Settings = { ...DEFAULT_SETTINGS, clipsPerRun: 1, packaged: true };
  if (kind === 'colorwar') {
    // 'random' picks one of the four ~41-44s wild-duel boards (never SPRINT's
    // short cold-open) — see render/colorwar/game.js's pickMode(). Shape is a
    // cosmetic design tweak, randomized here too so the same board layout
    // doesn't look identical to a prior day's render. Flip-sound stays
    // pinned to 'bubble' — the user's chosen sound, not randomized.
    return {
      ...base,
      contentType: 'colorwar',
      colorWarMode: 'random',
      colorWarShape: randomInt(0, 2) === 0 ? 'circle' : 'square',
      colorWarFlipSound: 'bubble',
    };
  }
  if (kind === 'followball') return { ...base, contentType: 'followball', followBallMode: 'random' };
  if (kind === 'findthecat') return { ...base, contentType: 'followball', followBallVariant: 'findthecat', findTheCatRounds: randomInt(0, 2) === 0 ? 1 : 3, findTheCatTheme: 'random' };
  // eyetest
  return { ...base, contentType: 'eyetest', eyeTestBallsPerRound: [5, 6, 8], eyeTestShuffleSec: 6 };
}

export interface RenderedJs {
  kind: JsGame;
  jobDir: string;
  videoPath: string;
  caption: string;
  hashtags: string[];
}

/** One JS-game render through the same pipeline the dashboard uses. */
export async function renderJsGame(kind: JsGame, broadcast: Broadcaster): Promise<RenderedJs> {
  const job = createJob({ settings: settingsFor(kind) });
  await runPipeline({ jobId: job.id, signal: new AbortController().signal, broadcast });
  const finished = getJob(job.id);
  if (!finished || finished.status !== 'awaiting_review' || !finished.draftText) {
    throw new Error(`render did not finish cleanly — status: ${finished?.status}, error: ${finished?.errorMessage ?? 'none'}`);
  }
  const videoPath = jobCandidateFile(job.id, 0, 'video');
  return { kind, jobDir: dirname(videoPath), videoPath, caption: finished.draftText.caption ?? '', hashtags: finished.draftText.hashtags ?? [] };
}

export const COLORWARS_DIR = join(process.cwd(), 'colorwars');
const COLORWARS_PYTHON = join(COLORWARS_DIR, '.venv', 'bin', 'python');
// "post with find a great seed" — the same mining-for-drama mechanism the
// Studio page's "Find a great seed" button runs, just headless/CLI here.
// 300 runs matches the done-when bar the engine's other events were judged
// against (Phase 4's decisions log) and takes well under a minute (pure
// physics, no browser/render involved) — generous without eating much of
// the job's time budget.
const COLORWARS_MINE_RUNS = 300;

export interface ColorwarsRenderMeta {
  out_dir: string;
  episode_id: string;
  seed: number;
  winner: string;
  mvp: string;
  duration_sec: number;
}

/** ring_of_doom and hot_potato both live in colorwars/ — a separate
 *  Python engine (pymunk + skia, its own render/audio/league pipeline),
 *  not the JS game renderer the other rotation games use. Mirrors the
 *  Studio page's own flow (mine for a great seed -> render the top one)
 *  via the CLI instead of HTTP. Does NOT commit the episode to the season —
 *  the caller does that only after a successful post. */
export async function renderColorwarsEvent(eventId: string, log: (s: string) => void = console.log): Promise<ColorwarsRenderMeta> {
  const mined = await pexec(COLORWARS_PYTHON, [
    '-m', 'colorwars', 'mine', '--event', eventId, '--runs', String(COLORWARS_MINE_RUNS), '--top', '5',
  ], { cwd: COLORWARS_DIR });
  log(mined.stdout.trim());
  const rendered = await pexec(COLORWARS_PYTHON, [
    '-m', 'colorwars', 'render', '--event', eventId, '--best', '--json',
  ], { cwd: COLORWARS_DIR, maxBuffer: 64 << 20 });
  const lastLine = rendered.stdout.trim().split('\n').at(-1);
  if (!lastLine) throw new Error('colorwars render --json produced no output');
  return JSON.parse(lastLine) as ColorwarsRenderMeta;
}

export async function commitColorwarsEpisode(eventId: string, episodeId: string): Promise<void> {
  await pexec(COLORWARS_PYTHON, ['-m', 'colorwars', 'commit', episodeId, '--event', eventId], { cwd: COLORWARS_DIR });
}

export const COLORWARS_EVENT: Record<ColorwarsKind, string> = { ringofdoom: 'ring_of_doom', hotpotato: 'hot_potato' };

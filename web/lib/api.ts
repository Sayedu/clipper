import type { Clip, ColorWarSeason, DoctorReport, FootageStatus, InputResponse, Job, JobStepRow, Settings } from './types';

type InputResponseBody = Omit<InputResponse, 'requestId'> & { requestId: string };

const BASE = '/worker';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.error ?? `${res.status} ${res.statusText}`) as Error & { hint?: string };
    err.hint = body?.hint;
    throw err;
  }
  return body as T;
}

export const api = {
  health: () => req<{ ok: boolean }>('/health'),
  doctor: () => req<DoctorReport>('/doctor'),

  getSettings: () =>
    req<{ settings: Settings; sfxPacks: string[]; defaults: Settings; twitchConfigured: boolean }>('/settings'),
  saveSettings: (patch: Partial<Settings>) =>
    req<{ settings: Settings }>('/settings', { method: 'PUT', body: JSON.stringify(patch) }),

  listJobs: () => req<{ jobs: Job[] }>('/jobs'),
  getJob: (id: string) => req<{ job: Job; steps: JobStepRow[] }>(`/jobs/${id}`),
  startRun: (body: { keywords?: string[]; pinnedUrl?: string } = {}) =>
    req<{ jobs: Job[] }>('/jobs', { method: 'POST', body: JSON.stringify(body) }),
  cancelJob: (id: string) => req<{ canceled: boolean }>(`/jobs/${id}/cancel`, { method: 'POST' }),
  colorwarRender: (seed: number, mode: string) =>
    req<{ jobId: string; seed: number; mode: string }>('/colorwar/render', {
      method: 'POST',
      body: JSON.stringify({ seed, mode }),
    }),
  followballRender: (seed: number, mode: string) =>
    req<{ jobId: string; seed: number; mode: string }>('/followball/render', {
      method: 'POST',
      body: JSON.stringify({ seed, mode }),
    }),
  findTheCatRender: (seed: number, o: FindTheCatOptions) =>
    req<{ jobId: string; seed: number; rounds: number; theme: string }>('/findthecat/render', {
      method: 'POST',
      body: JSON.stringify({ seed, ...o }),
    }),
  findTheCatBatch: (count: number, o: FindTheCatOptions) =>
    req<{ jobIds: string[] }>('/findthecat/batch', { method: 'POST', body: JSON.stringify({ count, ...o }) }),
  eyetestRender: (seed: number, ballsPerRound: number[], shuffleSec: number) =>
    req<{ jobId: string; seed: number; ballsPerRound: number[]; shuffleSec: number }>('/eyetest/render', {
      method: 'POST',
      body: JSON.stringify({ seed, ballsPerRound, shuffleSec }),
    }),
  pausegameRender: (seed: number, targetDeg: number, rotationMs: number, laps: number) =>
    req<{ jobId: string; seed: number; targetDeg: number; rotationMs: number; laps: number }>('/pausegame/render', {
      method: 'POST',
      body: JSON.stringify({ seed, targetDeg, rotationMs, laps }),
    }),
  quotesRender: (seed: number) =>
    req<{ jobId: string; seed: number }>('/quotes/render', {
      method: 'POST',
      body: JSON.stringify({ seed }),
    }),
  laserDuelRender: (opts: { seed?: number; nationA: string; nationB: string; winner: 'A' | 'B' | 'random' }) =>
    req<{ jobId: string }>('/lasernations/duel/render', {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  colorwarEpisodeTest: () =>
    req<{ jobId: string; seed: number; winner: string }>('/colorwar/episode-test', { method: 'POST' }),
  createColorWarSeason: (seasonNumber: number, totalEpisodes: number) =>
    req<{ season: ColorWarSeason }>('/colorwar/seasons', {
      method: 'POST',
      body: JSON.stringify({ seasonNumber, totalEpisodes }),
    }),
  listColorWarSeasons: () => req<{ seasons: ColorWarSeason[] }>('/colorwar/seasons'),
  getColorWarSeason: (id: string) => req<{ season: ColorWarSeason }>(`/colorwar/seasons/${id}`),
  rerollColorWarSeasonPlan: (id: string) =>
    req<{ season: ColorWarSeason }>(`/colorwar/seasons/${id}/reroll-plan`, { method: 'POST' }),
  confirmColorWarSeason: (id: string) =>
    req<{ season: ColorWarSeason }>(`/colorwar/seasons/${id}/confirm`, { method: 'POST' }),
  cancelColorWarSeason: (id: string) =>
    req<{ season: ColorWarSeason }>(`/colorwar/seasons/${id}/cancel`, { method: 'POST' }),
  respondToInput: (id: string, body: InputResponseBody) =>
    req<{ ok: boolean }>(`/jobs/${id}/respond`, { method: 'POST', body: JSON.stringify(body) }),
  getTtsVoices: () =>
    req<{ voices: Array<{ id: string; label: string }>; ready: boolean }>('/tts-voices'),

  getFootage: () => req<FootageStatus>('/footage'),
  saveJob: (id: string, candidateIndex?: number) =>
    req<{ clip: Clip }>(`/jobs/${id}/save`, { method: 'POST', body: JSON.stringify({ candidateIndex }) }),
  chooseCandidate: (id: string, candidateIndex: number) =>
    req<{ ok: boolean }>(`/jobs/${id}/choose`, { method: 'POST', body: JSON.stringify({ candidateIndex }) }),
  discardJob: (id: string) => req<{ ok: boolean }>(`/jobs/${id}/discard`, { method: 'POST' }),
  newTake: (id: string, patch: Partial<Settings> = {}) =>
    req<{ job: Job }>(`/jobs/${id}/new-take`, { method: 'POST', body: JSON.stringify(patch) }),
  differentVideo: (id: string, patch: Partial<Settings> = {}) =>
    req<{ job: Job }>(`/jobs/${id}/different-video`, { method: 'POST', body: JSON.stringify(patch) }),

  listClips: () => req<{ clips: Clip[] }>('/library'),
  deleteClip: (id: string) => req<{ ok: boolean }>(`/library/${id}`, { method: 'DELETE' }),

  getSchedule: () =>
    req<{ schedule: Clip[]; dailyPostCap: number; minPostSpacingHours: number }>('/schedule'),
  reflowSchedule: () => req<{ schedule: Clip[] }>('/schedule/reflow', { method: 'POST' }),
  markPosted: (id: string, posted = true) =>
    req<{ ok: boolean }>(`/library/${id}/posted`, { method: 'POST', body: JSON.stringify({ posted }) }),
  moveSchedule: (id: string, scheduledAt: string) =>
    req<{ ok: boolean }>(`/library/${id}/schedule`, { method: 'PUT', body: JSON.stringify({ scheduledAt }) }),

  checkCreators: (names: string[]) =>
    req<{ results: Array<{ input: string; ok: boolean; title?: string }> }>(
      `/creators/check?names=${encodeURIComponent(names.join(','))}`,
    ),
};

export type FindTheCatOptions = { rounds: number; theme: string; hook: string; hookSec: number; label: string; twists: boolean };
/** extra per-render files (Find The Cat: sfx.0.mp4, cover.0.png, postkit.0.txt) */
export const jobExtraUrl = (jobId: string, name: string) => `${BASE}/jobs/${jobId}/extra/${name}`;
export const postKitFileUrl = (kitId: string, name: string, download = false) =>
  `${BASE}/postkits/${encodeURIComponent(kitId)}/${name}${download ? '?download=1' : ''}`;

export interface PostKitSource { id: string; format: string; renderedAt: string; kitId: string | null }
export interface PostKit {
  id: string;
  createdAt: string;
  format: string;
  seed: number;
  caption: string;
  captionStyle: string;
  hashtags: string[];
  pinned: string;
  hook: { lines: string[]; style: { font: string; palette: string; anim: string } };
  cover: { lines: string[]; atSec: number };
  sound: { track: string; bpm?: number };
  look: { bg: string; border: string; zoom: string };
  video: { width: number; height: number; durationSec: number };
  posted: boolean;
  exists: boolean;
}
export interface PostKitTask {
  running: boolean;
  startedAt: string;
  finishedAt?: string;
  total: number;
  current: string | null;
  done: Array<{ source: string; kitId: string }>;
  failed: Array<{ source: string; error: string }>;
}
export const postKitsApi = {
  list: () => req<{ sources: PostKitSource[]; kits: PostKit[]; task: PostKitTask | null; queue: Array<{ id: string; format: string; caption: string; backToBack: boolean }> }>('/postkits'),
  make: (sources: string[]) => req<{ task: PostKitTask }>('/postkits', { method: 'POST', body: JSON.stringify({ sources }) }),
  markPosted: (kitId: string) => req<{ ok: boolean }>(`/postkits/${encodeURIComponent(kitId)}/posted`, { method: 'POST', body: JSON.stringify({ posted: true }) }),
};
export const candidatePreviewUrl = (jobId: string, index: number) => `${BASE}/jobs/${jobId}/preview/${index}`;
export const candidateThumbUrl = (jobId: string, index: number) => `${BASE}/jobs/${jobId}/thumb/${index}`;
export const jobDownloadUrl = (jobId: string, index = 0) => `${BASE}/jobs/${jobId}/download/${index}`;
export const colorwarPreviewSrc = (shape: 'circle' | 'square' = 'circle', flipsound: 'pluck' | 'bubble' = 'bubble') =>
  `/worker/render/colorwar/index.html?embed=1&shape=${shape}&flipsound=${flipsound}`;
export const followballPreviewSrc = '/worker/render/followball/index.html?embed=1';
export const findthecatPreviewSrc = '/worker/render/findthecat/index.html?embed=1';
export const eyetestPreviewSrc = '/worker/render/eyetest/index.html?embed=1';
export const pausegamePreviewSrc = '/worker/render/pausegame/index.html?embed=1';
export const quotesPreviewSrc = '/worker/render/quotes/index.html?embed=1';
export const laserDuelPreviewSrc = '/worker/render/lasernations/index.html?embed=1&duel=1';
export const clipVideoUrl = (clipId: string) => `${BASE}/library/${clipId}/video`;
export const clipThumbUrl = (clipId: string) => `${BASE}/library/${clipId}/thumb`;
export const jobEventsUrl = (jobId: string, after = 0) => `${BASE}/jobs/${jobId}/events?after=${after}`;

import type {
  EpisodeOverrides,
  EventInfo,
  EventSchema,
  FilmstripResult,
  Job,
  LibraryCard,
  MineFilters,
  NamesParseResult,
  NamesResponse,
  Preset,
  PresetListing,
  QuickCheckResult,
  RunConfig,
  StandingsResponse,
} from './colorwarsTypes';

const BASE = '/colorwars-api';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.detail ?? body?.error ?? `${res.status} ${res.statusText}`);
  }
  return body as T;
}

export const colorwarsApi = {
  health: () => req<{ ok: boolean }>('/health'),

  listEvents: () => req<{ events: EventInfo[] }>('/events'),
  getSchema: (eventId: string) => req<EventSchema>(`/events/${eventId}/schema`),

  quickCheck: (body: RunConfig) => req<QuickCheckResult>('/quick-check', { method: 'POST', body: JSON.stringify(body) }),
  filmstrip: (body: RunConfig) => req<FilmstripResult>('/filmstrip', { method: 'POST', body: JSON.stringify(body) }),

  listPresets: (eventId: string) => req<{ presets: PresetListing[] }>(`/presets/${eventId}`),
  savePreset: (eventId: string, preset: { name: string; overrides: Record<string, unknown>; episode_overrides: Record<string, unknown>; seed: number | null }) =>
    req<{ preset: Preset }>(`/presets/${eventId}`, { method: 'POST', body: JSON.stringify(preset) }),
  loadPreset: (eventId: string, name: string) => req<{ preset: Preset }>(`/presets/${eventId}/${encodeURIComponent(name)}`),
  deletePreset: (eventId: string, name: string) =>
    req<{ ok: boolean }>(`/presets/${eventId}/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  createRenderJob: (body: RunConfig & { mode: 'final' | 'preview'; volume_mult?: number }) =>
    req<{ job: Job }>('/jobs/render', { method: 'POST', body: JSON.stringify(body) }),
  createMineJob: (body: {
    event_id: string;
    runs: number;
    top: number;
    start_seed: number;
    filters: MineFilters;
    episode_overrides: EpisodeOverrides;
    finale: boolean;
  }) => req<{ job: Job }>('/jobs/mine', { method: 'POST', body: JSON.stringify(body) }),
  listJobs: () => req<{ jobs: Job[] }>('/jobs'),
  getJob: (id: string) => req<{ job: Job }>(`/jobs/${id}`),
  cancelJob: (id: string) => req<{ ok: boolean }>(`/jobs/${id}/cancel`, { method: 'POST' }),

  listLibrary: () => req<{ cards: LibraryCard[] }>('/library'),
  deleteLibraryItem: (episodeDir: string) => req<{ ok: boolean }>(`/library/${episodeDir}`, { method: 'DELETE' }),

  getStandings: () => req<StandingsResponse>('/league/standings'),
  commitEpisode: (eventId: string, episodeDir: string) =>
    req<{ season: Record<string, unknown> }>('/league/commit', {
      method: 'POST',
      body: JSON.stringify({ event_id: eventId, episode_dir: episodeDir }),
    }),
  getNames: () => req<NamesResponse>('/league/names'),
  parseNames: (text: string) => req<NamesParseResult>('/league/names/parse', { method: 'POST', body: JSON.stringify({ text }) }),
  saveNames: (accepted: { team: string; name: string }[]) =>
    req<{ saved: number }>('/league/names/save', { method: 'POST', body: JSON.stringify({ accepted }) }),
};

export const colorwarsMediaUrl = (path: string) => (path.startsWith('/media/') ? `${BASE}${path}` : path);

export function pollJob(
  jobId: string,
  onUpdate: (job: Job) => void,
  { intervalMs = 1000 }: { intervalMs?: number } = {},
): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const { job } = await colorwarsApi.getJob(jobId);
      if (stopped) return;
      onUpdate(job);
      if (job.status === 'queued' || job.status === 'running') {
        setTimeout(tick, intervalMs);
      }
    } catch {
      if (!stopped) setTimeout(tick, intervalMs * 2);
    }
  };
  tick();
  return () => {
    stopped = true;
  };
}

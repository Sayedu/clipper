import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { runMigrations } from './lib/migrate.ts';
import { ensureDataDirs, paths } from './paths.ts';
import {
  DEFAULT_SETTINGS,
  STEP_ORDER,
  type Clip,
  type ClipMeta,
  type ClipProvider,
  type ColorWarEpisodePlan,
  type ColorWarSeason,
  type ColorWarSeasonEpisode,
  type ColorWarSeasonStatus,
  type Job,
  type JobEvent,
  type JobStatus,
  type JobStepRow,
  type PostStatus,
  type Settings,
  type SourceVideo,
  type Step,
  type StepStatus,
} from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));

ensureDataDirs();
export const db: Database.Database = new Database(paths.db);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// base schema (idempotent CREATE IF NOT EXISTS), then numbered delta migrations
db.exec(readFileSync(resolve(here, 'schema.sql'), 'utf8'));
runMigrations(db, resolve(here, 'migrations'));

const now = () => new Date().toISOString();
const parse = <T>(s: string): T => JSON.parse(s) as T;

// --- Settings ----------------------------------------------------------

export function getSettings(): Settings {
  const row = db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string } | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  const stored = parse<Record<string, unknown>>(row.data);
  // keep only keys the current Settings shape knows about (drops fields from old versions)
  const clean: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in stored) clean[k] = stored[k];
  return { ...DEFAULT_SETTINGS, ...(clean as Partial<Settings>) };
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings(), ...patch };
  db.prepare(
    `INSERT INTO settings (id, data, updated_at) VALUES (1, @data, @ts)
     ON CONFLICT(id) DO UPDATE SET data = @data, updated_at = @ts`,
  ).run({ data: JSON.stringify(next), ts: now() });
  return next;
}

// --- Jobs ------------------------------------------------------------

interface JobRow {
  id: string;
  status: JobStatus;
  settings_snapshot: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  source_json: string | null;
  virality_score: number | null;
  candidates_json: string;
  chosen_index: number;
  transcript_via: 'youtube' | 'whisper' | null;
  error_step: Step | null;
  error_message: string | null;
  parent_job_id: string | null;
  candidate_rank: number;
  pending_input_json: string | null;
  skipped_json: string;
  draft_text_json: string | null;
  chosen_reframe_mode: 'crop' | 'letterbox' | null;
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    status: r.status,
    settings: { ...DEFAULT_SETTINGS, ...parse<Partial<Settings>>(r.settings_snapshot) },
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    source: r.source_json ? parse<SourceVideo>(r.source_json) : null,
    viralityScore: r.virality_score,
    candidates: parse<Job['candidates']>(r.candidates_json || '[]'),
    chosenIndex: r.chosen_index ?? 0,
    skipped: parse<Job['skipped']>(r.skipped_json || '[]'),
    draftText: r.draft_text_json ? parse<Job['draftText']>(r.draft_text_json) : null,
    pendingInput: r.pending_input_json ? parse<Job['pendingInput']>(r.pending_input_json) : null,
    chosenReframeMode: r.chosen_reframe_mode,
    transcriptVia: r.transcript_via,
    errorStep: r.error_step,
    errorMessage: r.error_message,
    parentJobId: r.parent_job_id,
    candidateRank: r.candidate_rank ?? 0,
  };
}

export function createJob(opts: {
  settings: Settings;
  parentJobId?: string | null;
  candidateRank?: number;
  id?: string;
}): Job {
  const id = opts.id ?? nanoid(12);
  db.prepare(
    `INSERT INTO jobs (id, status, settings_snapshot, created_at, parent_job_id, candidate_rank)
     VALUES (@id, 'queued', @settings, @ts, @parent, @rank)`,
  ).run({
    id,
    settings: JSON.stringify(opts.settings),
    ts: now(),
    parent: opts.parentJobId ?? null,
    rank: opts.candidateRank ?? 0,
  });

  const insertStep = db.prepare(`INSERT INTO job_steps (job_id, step, status) VALUES (?, ?, 'pending')`);
  const tx = db.transaction(() => {
    for (const step of STEP_ORDER) insertStep.run(id, step);
  });
  tx();

  return getJob(id)!;
}

export function getJob(id: string): Job | null {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function listJobs(limit = 50): Job[] {
  const rows = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as JobRow[];
  return rows.map(rowToJob);
}

export interface JobPatch {
  status?: JobStatus;
  startedAt?: string;
  finishedAt?: string;
  source?: SourceVideo | null;
  viralityScore?: number | null;
  candidates?: Job['candidates'];
  chosenIndex?: number;
  skipped?: Job['skipped'];
  draftText?: Job['draftText'];
  pendingInput?: Job['pendingInput'];
  chosenReframeMode?: 'crop' | 'letterbox' | null;
  transcriptVia?: 'youtube' | 'whisper' | null;
  errorStep?: Step | null;
  errorMessage?: string | null;
}

export function updateJob(id: string, patch: JobPatch): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  const put = (col: string, key: string, val: unknown) => {
    sets.push(`${col} = @${key}`);
    params[key] = val;
  };
  const json = (v: unknown) => (v == null ? null : JSON.stringify(v));
  if (patch.status !== undefined) put('status', 'status', patch.status);
  if (patch.startedAt !== undefined) put('started_at', 'started_at', patch.startedAt);
  if (patch.finishedAt !== undefined) put('finished_at', 'finished_at', patch.finishedAt);
  if (patch.source !== undefined) put('source_json', 'source_json', json(patch.source));
  if (patch.viralityScore !== undefined) put('virality_score', 'virality_score', patch.viralityScore);
  if (patch.candidates !== undefined) put('candidates_json', 'candidates_json', JSON.stringify(patch.candidates));
  if (patch.chosenIndex !== undefined) put('chosen_index', 'chosen_index', patch.chosenIndex);
  if (patch.skipped !== undefined) put('skipped_json', 'skipped_json', JSON.stringify(patch.skipped));
  if (patch.draftText !== undefined) put('draft_text_json', 'draft_text_json', json(patch.draftText));
  if (patch.pendingInput !== undefined) put('pending_input_json', 'pending_input_json', json(patch.pendingInput));
  if (patch.chosenReframeMode !== undefined) put('chosen_reframe_mode', 'chosen_reframe_mode', patch.chosenReframeMode);
  if (patch.transcriptVia !== undefined) put('transcript_via', 'transcript_via', patch.transcriptVia);
  if (patch.errorStep !== undefined) put('error_step', 'error_step', patch.errorStep);
  if (patch.errorMessage !== undefined) put('error_message', 'error_message', patch.errorMessage);
  if (!sets.length) return;
  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

// --- Job steps -----------------------------------------------------

export function getJobSteps(jobId: string): JobStepRow[] {
  const rows = db
    .prepare('SELECT step, status, detail, error, started_at, finished_at FROM job_steps WHERE job_id = ?')
    .all(jobId) as Array<{
    step: Step;
    status: StepStatus;
    detail: string | null;
    error: string | null;
    started_at: string | null;
    finished_at: string | null;
  }>;
  const byStep = new Map(rows.map((r) => [r.step, r]));
  // Return in canonical pipeline order.
  return STEP_ORDER.map((step) => {
    const r = byStep.get(step);
    return {
      step,
      status: r?.status ?? 'pending',
      detail: r?.detail ?? null,
      error: r?.error ?? null,
      startedAt: r?.started_at ?? null,
      finishedAt: r?.finished_at ?? null,
    };
  });
}

export function setStepStatus(
  jobId: string,
  step: Step,
  status: StepStatus,
  extra: { detail?: string | null; error?: string | null } = {},
): void {
  const ts = now();
  const startedAt = status === 'running' ? ts : null;
  const finishedAt = status === 'done' || status === 'failed' || status === 'skipped' ? ts : null;
  db.prepare(
    `UPDATE job_steps SET
       status = @status,
       detail = COALESCE(@detail, detail),
       error = @error,
       started_at = COALESCE(started_at, @startedAt),
       finished_at = CASE WHEN @finishedAt IS NULL THEN finished_at ELSE @finishedAt END
     WHERE job_id = @jobId AND step = @step`,
  ).run({
    jobId,
    step,
    status,
    detail: extra.detail ?? null,
    error: extra.error ?? null,
    startedAt,
    finishedAt,
  });
}

// --- Events (SSE replay) ----------------------------------------

export function appendEvent(event: JobEvent): number {
  const jobId = 'jobId' in event ? event.jobId : '';
  const info = db
    .prepare('INSERT INTO job_events (job_id, ts, type, payload) VALUES (?, ?, ?, ?)')
    .run(jobId, now(), event.type, JSON.stringify(event));
  return Number(info.lastInsertRowid);
}

export function getEventsSince(jobId: string, afterId = 0): Array<{ id: number; event: JobEvent }> {
  const rows = db
    .prepare('SELECT id, payload FROM job_events WHERE job_id = ? AND id > ? ORDER BY id ASC')
    .all(jobId, afterId) as Array<{ id: number; payload: string }>;
  return rows.map((r) => ({ id: r.id, event: parse<JobEvent>(r.payload) }));
}

// --- Clips (library) ------------------------------------------

interface ClipRow {
  id: string;
  job_id: string | null;
  title: string;
  source_json: string;
  duration_sec: number;
  file_path: string;
  thumb_path: string;
  created_at: string;
  meta_json: string;
  scheduled_at: string | null;
  post_status: PostStatus;
  posted_at: string | null;
}

function rowToClip(r: ClipRow): Clip {
  return {
    id: r.id,
    jobId: r.job_id ?? '',
    title: r.title,
    source: parse<SourceVideo>(r.source_json),
    durationSec: r.duration_sec,
    filePath: r.file_path,
    thumbPath: r.thumb_path,
    createdAt: r.created_at,
    meta: parse<ClipMeta>(r.meta_json),
    scheduledAt: r.scheduled_at ?? null,
    postStatus: r.post_status ?? 'queued',
    postedAt: r.posted_at ?? null,
  };
}

export function createClip(
  input: Omit<Clip, 'id' | 'createdAt' | 'scheduledAt' | 'postStatus' | 'postedAt'>,
): Clip {
  const id = nanoid(12);
  db.prepare(
    `INSERT INTO clips (id, job_id, title, source_json, duration_sec, file_path, thumb_path, created_at, meta_json)
     VALUES (@id, @jobId, @title, @source, @duration, @file, @thumb, @ts, @meta)`,
  ).run({
    id,
    jobId: input.jobId || null,
    title: input.title,
    source: JSON.stringify(input.source),
    duration: input.durationSec,
    file: input.filePath,
    thumb: input.thumbPath,
    ts: now(),
    meta: JSON.stringify(input.meta),
  });
  return getClip(id)!;
}

export function getClip(id: string): Clip | null {
  const row = db.prepare('SELECT * FROM clips WHERE id = ?').get(id) as ClipRow | undefined;
  return row ? rowToClip(row) : null;
}

export function listClips(): Clip[] {
  const rows = db.prepare('SELECT * FROM clips ORDER BY created_at DESC').all() as ClipRow[];
  return rows.map(rowToClip);
}

export function deleteClip(id: string): void {
  db.prepare('DELETE FROM clips WHERE id = ?').run(id);
}

// --- Post schedule --------------------------------------------

export function updateClipSchedule(
  id: string,
  patch: { scheduledAt?: string | null; postStatus?: PostStatus; postedAt?: string | null },
): void {
  const sets: string[] = [];
  const args: Record<string, unknown> = { id };
  if ('scheduledAt' in patch) {
    sets.push('scheduled_at = @scheduledAt');
    args.scheduledAt = patch.scheduledAt ?? null;
  }
  if (patch.postStatus) {
    sets.push('post_status = @postStatus');
    args.postStatus = patch.postStatus;
  }
  if ('postedAt' in patch) {
    sets.push('posted_at = @postedAt');
    args.postedAt = patch.postedAt ?? null;
  }
  if (!sets.length) return;
  db.prepare(`UPDATE clips SET ${sets.join(', ')} WHERE id = @id`).run(args);
}

// --- Color War Seasons ------------------------------------------

interface ColorWarSeasonRow {
  id: string;
  season_number: number;
  total_episodes: number;
  planning_seed: number;
  plan_json: string;
  episodes_json: string;
  status: ColorWarSeasonStatus;
  created_at: string;
}

function rowToSeason(r: ColorWarSeasonRow): ColorWarSeason {
  return {
    id: r.id,
    seasonNumber: r.season_number,
    totalEpisodes: r.total_episodes,
    planningSeed: r.planning_seed,
    plan: parse<ColorWarEpisodePlan[]>(r.plan_json),
    episodes: parse<ColorWarSeasonEpisode[]>(r.episodes_json || '[]'),
    status: r.status,
    createdAt: r.created_at,
  };
}

export function createColorWarSeason(opts: {
  seasonNumber: number;
  totalEpisodes: number;
  planningSeed: number;
  plan: ColorWarEpisodePlan[];
}): ColorWarSeason {
  const id = nanoid(12);
  const episodes: ColorWarSeasonEpisode[] = opts.plan.map((p) => ({ episodeIndex: p.episodeIndex, status: 'planned' }));
  db.prepare(
    `INSERT INTO colorwar_seasons (id, season_number, total_episodes, planning_seed, plan_json, episodes_json, status, created_at)
     VALUES (@id, @seasonNumber, @totalEpisodes, @planningSeed, @plan, @episodes, 'planned', @ts)`,
  ).run({
    id,
    seasonNumber: opts.seasonNumber,
    totalEpisodes: opts.totalEpisodes,
    planningSeed: opts.planningSeed,
    plan: JSON.stringify(opts.plan),
    episodes: JSON.stringify(episodes),
    ts: now(),
  });
  return getColorWarSeason(id)!;
}

export function getColorWarSeason(id: string): ColorWarSeason | null {
  const row = db.prepare('SELECT * FROM colorwar_seasons WHERE id = ?').get(id) as ColorWarSeasonRow | undefined;
  return row ? rowToSeason(row) : null;
}

export function listColorWarSeasons(limit = 20): ColorWarSeason[] {
  const rows = db
    .prepare('SELECT * FROM colorwar_seasons ORDER BY created_at DESC LIMIT ?')
    .all(limit) as ColorWarSeasonRow[];
  return rows.map(rowToSeason);
}

export function updateColorWarSeason(
  id: string,
  patch: { plan?: ColorWarEpisodePlan[]; planningSeed?: number; episodes?: ColorWarSeasonEpisode[]; status?: ColorWarSeasonStatus },
): void {
  const sets: string[] = [];
  const args: Record<string, unknown> = { id };
  if (patch.plan) { sets.push('plan_json = @plan'); args.plan = JSON.stringify(patch.plan); }
  if (patch.planningSeed !== undefined) { sets.push('planning_seed = @planningSeed'); args.planningSeed = patch.planningSeed; }
  if (patch.episodes) { sets.push('episodes_json = @episodes'); args.episodes = JSON.stringify(patch.episodes); }
  if (patch.status) { sets.push('status = @status'); args.status = patch.status; }
  if (!sets.length) return;
  db.prepare(`UPDATE colorwar_seasons SET ${sets.join(', ')} WHERE id = @id`).run(args);
}

// --- OAuth tokens (Twitch app access token) -------------------

export function getOAuthToken(provider: string): { accessToken: string; expiresAt: string } | null {
  const row = db
    .prepare('SELECT access_token, expires_at FROM oauth_tokens WHERE provider = ?')
    .get(provider) as { access_token: string; expires_at: string } | undefined;
  return row ? { accessToken: row.access_token, expiresAt: row.expires_at } : null;
}

export function putOAuthToken(provider: string, accessToken: string, expiresAt: string): void {
  db.prepare(
    `INSERT INTO oauth_tokens (provider, access_token, expires_at, updated_at)
     VALUES (@provider, @token, @exp, @ts)
     ON CONFLICT(provider) DO UPDATE SET access_token = @token, expires_at = @exp, updated_at = @ts`,
  ).run({ provider, token: accessToken, exp: expiresAt, ts: now() });
}

// --- Used source videos (avoid repeating a source) --------------

export type VideoOutcome = 'processing' | 'saved' | 'discarded' | 'rejected' | 'failed';

export function recordUsedVideo(
  v: { videoId: string; title?: string; channel?: string; provider?: ClipProvider },
  outcome: VideoOutcome = 'processing',
): void {
  db.prepare(
    `INSERT INTO used_videos (video_id, title, channel, provider, first_used_at, last_used_at, times_used, outcome)
     VALUES (@id, @title, @channel, @provider, @ts, @ts, 1, @outcome)
     ON CONFLICT(video_id) DO UPDATE SET
       last_used_at = @ts, times_used = times_used + 1, outcome = @outcome,
       title = COALESCE(@title, title), channel = COALESCE(@channel, channel)`,
  ).run({
    id: v.videoId,
    title: v.title ?? null,
    channel: v.channel ?? null,
    provider: v.provider ?? 'youtube',
    ts: now(),
    outcome,
  });
}

export function setVideoOutcome(videoId: string, outcome: VideoOutcome): void {
  db.prepare('UPDATE used_videos SET outcome = ?, last_used_at = ? WHERE video_id = ?').run(outcome, now(), videoId);
}

/**
 * ISO timestamp marking the edge of the reuse cooldown: a used video whose
 * `last_used_at` is strictly after this is still excluded. `null` cooldown →
 * `null` cutoff, meaning "exclude forever". Pure; exported for testing.
 */
export function usedVideoCutoff(cooldownDays: number | null, now = Date.now()): string | null {
  if (cooldownDays == null || !Number.isFinite(cooldownDays)) return null;
  return new Date(now - Math.max(0, cooldownDays) * 86_400_000).toISOString();
}

const REJECTED_GRACE_DAYS = 30; // don't re-try a guideline-rejected video for a month

/**
 * Video IDs to exclude at the Score step. Any video the pipeline has already
 * finished with — one you **saved** a clip from OR one you **discarded** — is out
 * for good; the run should always move on to something new. A video that's
 * mid-flight is excluded while it runs, and one the guideline rejected sits out a
 * month (in case settings change). Transient failures are released right away.
 */
export function excludedVideoIds(_cooldownDays?: number | null, now = Date.now()): Set<string> {
  const rejectedCutoff = new Date(now - REJECTED_GRACE_DAYS * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT video_id FROM used_videos WHERE
         outcome IN ('processing', 'saved', 'discarded')
         OR (outcome = 'rejected' AND last_used_at > @rejectedCutoff)`,
    )
    .all({ rejectedCutoff }) as Array<{ video_id: string }>;
  return new Set(rows.map((r) => r.video_id));
}

/** Channels a clip was already made/attempted from in the last `days` — for diversity. */
export function recentlyUsedChannels(days = 4, now = Date.now()): Set<string> {
  const cutoff = new Date(now - days * 86_400_000).toISOString();
  const rows = db
    .prepare(`SELECT DISTINCT channel FROM used_videos WHERE channel IS NOT NULL AND last_used_at > ?`)
    .all(cutoff) as Array<{ channel: string }>;
  return new Set(rows.map((r) => r.channel.toLowerCase()));
}

// --- Channel resolution cache (creators mode) -------------------

export interface CachedChannel {
  handle: string;
  channelId: string;
  title: string;
  uploadsPlaylistId: string;
  resolvedAt: string;
}

export function getCachedChannel(handle: string): CachedChannel | null {
  const row = db.prepare('SELECT * FROM channel_cache WHERE handle = ?').get(handle.toLowerCase()) as
    | { handle: string; channel_id: string; title: string; uploads_playlist_id: string; resolved_at: string }
    | undefined;
  return row
    ? {
        handle: row.handle,
        channelId: row.channel_id,
        title: row.title,
        uploadsPlaylistId: row.uploads_playlist_id,
        resolvedAt: row.resolved_at,
      }
    : null;
}

export function putCachedChannel(c: Omit<CachedChannel, 'resolvedAt'>): void {
  db.prepare(
    `INSERT INTO channel_cache (handle, channel_id, title, uploads_playlist_id, resolved_at)
     VALUES (@handle, @channelId, @title, @uploads, @ts)
     ON CONFLICT(handle) DO UPDATE SET
       channel_id = @channelId, title = @title, uploads_playlist_id = @uploads, resolved_at = @ts`,
  ).run({
    handle: c.handle.toLowerCase(),
    channelId: c.channelId,
    title: c.title,
    uploads: c.uploadsPlaylistId,
    ts: now(),
  });
}

// --- Storyteller background-footage library --------------------

export interface FootageClip {
  id: string;
  path: string;
  sourceVideoId: string;
  sourceTitle: string | null;
  sourceChannel: string | null;
  durationSec: number;
  addedAt: string;
}

function rowToFootage(r: Record<string, unknown>): FootageClip {
  return {
    id: r.id as string,
    path: r.path as string,
    sourceVideoId: r.source_video_id as string,
    sourceTitle: (r.source_title as string) ?? null,
    sourceChannel: (r.source_channel as string) ?? null,
    durationSec: r.duration_sec as number,
    addedAt: r.added_at as string,
  };
}

export function listFootageClips(): FootageClip[] {
  return (db.prepare('SELECT * FROM footage_clips ORDER BY added_at DESC').all() as Array<Record<string, unknown>>).map(
    rowToFootage,
  );
}

export function footageSourceIds(): Set<string> {
  const rows = db.prepare('SELECT DISTINCT source_video_id FROM footage_clips').all() as Array<{ source_video_id: string }>;
  return new Set(rows.map((r) => r.source_video_id));
}

export function addFootageClip(c: Omit<FootageClip, 'addedAt'>): void {
  db.prepare(
    `INSERT INTO footage_clips (id, path, source_video_id, source_title, source_channel, duration_sec, added_at)
     VALUES (@id, @path, @src, @title, @channel, @dur, @ts)
     ON CONFLICT(id) DO UPDATE SET path = @path, duration_sec = @dur`,
  ).run({
    id: c.id,
    path: c.path,
    src: c.sourceVideoId,
    title: c.sourceTitle ?? null,
    channel: c.sourceChannel ?? null,
    dur: c.durationSec,
    ts: now(),
  });
}

export function deleteFootageClip(id: string): void {
  db.prepare('DELETE FROM footage_clips WHERE id = ?').run(id);
}

/** Slice windows used from a footage clip in the last `keep` uses — to avoid repeats. */
export function recentFootageSlices(footageId: string, keep = 25): Array<[number, number]> {
  const rows = db
    .prepare('SELECT start_sec, end_sec FROM used_footage_slices WHERE footage_id = ? ORDER BY used_at DESC LIMIT ?')
    .all(footageId, keep) as Array<{ start_sec: number; end_sec: number }>;
  return rows.map((r) => [r.start_sec, r.end_sec]);
}

export function recordFootageSlice(footageId: string, startSec: number, endSec: number): void {
  db.prepare(
    'INSERT INTO used_footage_slices (footage_id, start_sec, end_sec, used_at) VALUES (?, ?, ?, ?)',
  ).run(footageId, startSec, endSec, now());
}

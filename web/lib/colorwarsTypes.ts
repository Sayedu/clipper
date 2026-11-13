/* Mirror of colorwars/colorwars/studio_api's response shapes. Keep in sync
   with colorwars/colorwars/engine/params.py (ParamSpec) and studio_api/main.py. */

export type ParamType = 'int' | 'float' | 'bool' | 'select' | 'text';

export interface ParamSpec {
  name: string; // dotted path into event_cfg ("balls.per_team") or "team.<id>.<trait>"
  label: string;
  type: ParamType;
  default: unknown;
  min: number | null;
  max: number | null;
  step: number | null;
  options: { value: unknown; label: string }[] | null;
  help: string;
  randomizable: boolean;
  group: string;
}

export interface TeamInfo {
  id: string;
  name: string;
  color: string;
  traits: Record<string, number>;
}

export interface EventInfo {
  id: string;
  display_name: string;
}

export interface EventSchema {
  event_id: string;
  params: ParamSpec[];
  teams: TeamInfo[];
  duration_min_sec: number;
  duration_max_sec: number;
}

export interface EpisodeOverrides {
  hook_line_mode?: 'auto' | 'custom';
  hook_line_text?: string;
  crown_team_mode?: 'auto' | 'override';
  crown_team_override?: string;
  names_mode?: 'queue' | 'custom';
  custom_names?: Record<string, string[]>;
  duration_min_sec?: number;
  duration_max_sec?: number;
}

export interface RunConfig {
  event_id: string;
  seed: number;
  overrides: Record<string, unknown>;
  episode_overrides: EpisodeOverrides;
  finale: boolean;
}

export interface TimelineEvent {
  t: number;
  kind: string;
  data: Record<string, unknown>;
}

export interface QuickCheckResult {
  valid: boolean;
  winner: string | null;
  placements: string[];
  mvp: string | null;
  duration_sec: number | null;
  in_window: boolean;
  duration_min_sec: number;
  duration_max_sec: number;
  drama: Record<string, unknown>;
  timeline_events: TimelineEvent[];
  hook_line: string | null;
  teaser: string | null;
  crown_team: string | null;
}

export interface FilmstripResult {
  valid: boolean;
  frame_urls: string[];
  frame_indices?: number[];
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled';
export type JobKind = 'render' | 'mine';

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  frames_done: number;
  total_frames: number | null;
  error: string | null;
  result: Record<string, unknown> | null;
  cancel_requested: boolean;
  event_id: string;
  [key: string]: unknown;
}

export interface MineFilters {
  winner?: string;
  not_winner?: string;
  comeback?: boolean;
  min_lead_changes?: number;
  photo_finish?: boolean;
}

export interface MineTopRow {
  seed: number;
  winner: string;
  mvp: string;
  duration_sec: number;
  score: number;
  [key: string]: unknown;
}

export interface MineResult {
  top_rows: MineTopRow[];
  total_valid: number;
}

export interface RenderResult {
  out_dir: string;
  meta: {
    seed: number;
    event: string;
    episode_id: string;
    episode_number: number;
    is_finale: boolean;
    duration_sec: number;
    placements: string[];
    mvp: string;
    winner: string;
    crown_team_before: string | null;
    names_used: Record<string, string[]>;
    stats: Record<string, number>;
    drama: Record<string, unknown>;
    studio_overrides?: Record<string, unknown>;
    studio_episode_overrides?: EpisodeOverrides;
  };
}

export interface LibraryCard {
  episode_dir: string;
  meta: RenderResult['meta'];
  caption: string;
  pinned_comment: string;
  video_url: string | null;
  cover_url: string | null;
}

export interface Preset {
  name: string;
  saved_at: number;
  event_id?: string;
  overrides: Record<string, unknown>;
  episode_overrides: EpisodeOverrides;
  seed: number | null;
}

export interface PresetListing {
  name: string;
  saved_at: number;
}

export interface Storyline {
  text: string;
  score: number;
  kind: string;
}

export interface StandingsResponse {
  season: Record<string, unknown>;
  crown_team: string | null;
  last_place_team: string | null;
  storyline_candidates: Storyline[];
}

export interface NameEntry {
  team: string;
  name: string;
}

export interface NamesResponse {
  queue: NameEntry[];
  used: NameEntry[];
}

export interface ParsedNameAccepted {
  raw: string;
  team: string;
  name: string;
}

export interface ParsedNameRejected {
  raw: string;
  team: string | null;
  reason: string;
}

export interface NamesParseResult {
  accepted: ParsedNameAccepted[];
  rejected: ParsedNameRejected[];
}

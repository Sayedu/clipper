PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  data       TEXT NOT NULL,          -- JSON: Settings
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT PRIMARY KEY,
  status            TEXT NOT NULL,
  settings_snapshot TEXT NOT NULL,   -- JSON: Settings
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  source_json       TEXT,            -- JSON: SourceVideo
  virality_score    REAL,
  candidates_json   TEXT NOT NULL DEFAULT '[]',  -- JSON: JobCandidate[]
  chosen_index      INTEGER NOT NULL DEFAULT 0,
  transcript_via    TEXT,            -- 'youtube' | 'whisper'
  error_step        TEXT,
  error_message     TEXT,
  parent_job_id     TEXT REFERENCES jobs(id),
  candidate_rank    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS job_steps (
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  step        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  detail      TEXT,
  error       TEXT,
  started_at  TEXT,
  finished_at TEXT,
  PRIMARY KEY (job_id, step)
);

CREATE TABLE IF NOT EXISTS job_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ts      TEXT NOT NULL,
  type    TEXT NOT NULL,
  payload TEXT NOT NULL              -- JSON: JobEvent
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events (job_id, id);

CREATE TABLE IF NOT EXISTS channel_cache (
  handle              TEXT PRIMARY KEY,   -- lower-cased handle / name as entered
  channel_id          TEXT NOT NULL,
  title               TEXT NOT NULL,
  uploads_playlist_id TEXT NOT NULL,
  resolved_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clips (
  id           TEXT PRIMARY KEY,
  job_id       TEXT REFERENCES jobs(id),
  title        TEXT NOT NULL,
  source_json  TEXT NOT NULL,        -- JSON: SourceVideo
  duration_sec REAL NOT NULL,
  file_path    TEXT NOT NULL,
  thumb_path   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  meta_json    TEXT NOT NULL         -- JSON: ClipMeta
);
CREATE INDEX IF NOT EXISTS idx_clips_created ON clips (created_at DESC);

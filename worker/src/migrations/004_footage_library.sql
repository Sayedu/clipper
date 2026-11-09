-- Storyteller mode — a small persistent library of background gameplay footage
-- (populated with the existing YouTube search+download tooling) plus a
-- recently-used-slice log so back-to-back stories don't reuse the same segment.

CREATE TABLE IF NOT EXISTS footage_clips (
  id              TEXT PRIMARY KEY,
  path            TEXT NOT NULL,            -- local mp4 under data/footage/
  source_video_id TEXT NOT NULL,
  source_title    TEXT,
  source_channel  TEXT,
  duration_sec    REAL NOT NULL,
  added_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_footage_source ON footage_clips (source_video_id);

CREATE TABLE IF NOT EXISTS used_footage_slices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  footage_id TEXT NOT NULL REFERENCES footage_clips(id) ON DELETE CASCADE,
  start_sec  REAL NOT NULL,
  end_sec    REAL NOT NULL,
  used_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_used_slices_footage ON used_footage_slices (footage_id, used_at);

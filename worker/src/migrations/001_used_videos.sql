-- Every source video that has been downloaded / processed (not only saved ones),
-- so later runs can avoid repeating the same source.
CREATE TABLE IF NOT EXISTS used_videos (
  video_id      TEXT PRIMARY KEY,
  title         TEXT,
  channel       TEXT,
  first_used_at TEXT NOT NULL,
  last_used_at  TEXT NOT NULL,
  times_used    INTEGER NOT NULL DEFAULT 1,
  outcome       TEXT NOT NULL DEFAULT 'processing'  -- processing | saved | discarded | rejected | failed
);

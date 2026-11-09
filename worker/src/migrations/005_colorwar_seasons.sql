-- Color War Season Mode: a planned sequence of episode outcomes (who wins each
-- episode, the losing-streak/clinch story beats), plus the live status of each
-- episode's actual render job once the plan is confirmed. One row per season;
-- each episode's real video is an ordinary row in `jobs` (found via the jobId
-- stashed in episodes_json) — a season never duplicates job state, only tracks
-- which job belongs to which episode.

CREATE TABLE IF NOT EXISTS colorwar_seasons (
  id             TEXT PRIMARY KEY,
  season_number  INTEGER NOT NULL,
  total_episodes INTEGER NOT NULL,
  planning_seed  INTEGER NOT NULL,
  plan_json      TEXT NOT NULL,               -- JSON: EpisodePlan[]
  episodes_json  TEXT NOT NULL DEFAULT '[]',  -- JSON: SeasonEpisode[]
  status         TEXT NOT NULL DEFAULT 'planned',  -- planned | confirmed | done | canceled
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_colorwar_seasons_created ON colorwar_seasons (created_at DESC);

-- Twitch as a second source + a post-schedule queue over saved clips.

-- Which platform a used/attempted source came from (dedup + display).
ALTER TABLE used_videos ADD COLUMN provider TEXT NOT NULL DEFAULT 'youtube';

-- Post-schedule columns on saved clips. `scheduled_at` is a *suggestion* assigned
-- on save from the daily cap + spacing; the user can move it or mark it posted.
ALTER TABLE clips ADD COLUMN scheduled_at TEXT;
ALTER TABLE clips ADD COLUMN post_status  TEXT NOT NULL DEFAULT 'queued';  -- queued | posted
ALTER TABLE clips ADD COLUMN posted_at    TEXT;
CREATE INDEX IF NOT EXISTS idx_clips_schedule ON clips (scheduled_at);

-- App/OAuth tokens (Twitch app access token lasts ~60 days; refreshed on 401/expiry).
CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider     TEXT PRIMARY KEY,   -- 'twitch'
  access_token TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

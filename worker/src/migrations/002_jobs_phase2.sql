-- Phase 2 job fields: human-in-the-loop review, skipped-candidate log, drafted text,
-- and which reframe mode the winning clip used.
ALTER TABLE jobs ADD COLUMN pending_input_json  TEXT;
ALTER TABLE jobs ADD COLUMN skipped_json        TEXT NOT NULL DEFAULT '[]';
ALTER TABLE jobs ADD COLUMN draft_text_json     TEXT;
ALTER TABLE jobs ADD COLUMN chosen_reframe_mode TEXT;

-- db/migrations/003_thumbnail.sql
--
-- Adds a thumbnail column to trend_candidates.
-- Stores the first-frame cover image as a base64 data URI fetched from
-- TikTok's CDN at analysis time.
-- Kept as TEXT rather than BYTEA because the data URI includes the mime prefix
-- and is directly embeddable in <img src="..."> tags in the web UI.

ALTER TABLE trend_candidates
    ADD COLUMN thumbnail TEXT;   -- "data:image/jpeg;base64,..." or NULL

COMMENT ON COLUMN trend_candidates.thumbnail IS
    'First-frame cover image as a data URI (data:image/jpeg;base64,...). Null if unavailable.';

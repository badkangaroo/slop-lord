-- db/migrations/004_video_path.sql
--
-- Adds a video_path column to trend_candidates.
-- Stores the absolute local filesystem path to the transcoded 480p .mp4.
-- e.g. "/home/user/slop-lord/downloads/7412345678901234567.mp4"
-- NULL when download was skipped or failed.

ALTER TABLE trend_candidates
    ADD COLUMN video_path TEXT;

COMMENT ON COLUMN trend_candidates.video_path IS
    'Absolute path to the local 480p transcoded video file. Null if not downloaded.';

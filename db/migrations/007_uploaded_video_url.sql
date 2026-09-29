-- 007_uploaded_video_url.sql
-- Adds the TikTok video URL produced after uploading a generated video.
ALTER TABLE content_briefs
  ADD COLUMN IF NOT EXISTS uploaded_video_url TEXT;

-- db/migrations/005_generated_video.sql
--
-- Adds minimax_task_id and generated_path to content_briefs.
-- minimax_task_id: the task ID returned by MiniMax on submission
-- generated_path:  absolute local path to the downloaded MiniMax output .mp4
-- image_prompt:    the image generation prompt used for the first frame

ALTER TABLE content_briefs
    ADD COLUMN minimax_task_id TEXT,
    ADD COLUMN generated_path  TEXT,
    ADD COLUMN image_prompt    TEXT;

COMMENT ON COLUMN content_briefs.minimax_task_id IS 'MiniMax v2 task_id returned on submission';
COMMENT ON COLUMN content_briefs.generated_path  IS 'Absolute path to downloaded MiniMax output .mp4';
COMMENT ON COLUMN content_briefs.image_prompt    IS 'Image generation prompt for the first frame (ComfyUI / MiniMax)';

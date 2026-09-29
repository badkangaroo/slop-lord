-- db/migrations/006_edited_frame.sql
--
-- Adds edited_frame_path and edit_instruction to content_briefs.
-- edited_frame_path: local path to the Qwen-Image-Edit output PNG
--                    (this is the image actually fed to MiniMax H3, not the raw thumbnail)
-- edit_instruction:  the LLM-generated Qwen edit command that was used

ALTER TABLE content_briefs
    ADD COLUMN edited_frame_path TEXT,
    ADD COLUMN edit_instruction  TEXT;

COMMENT ON COLUMN content_briefs.edited_frame_path IS 'Path to Qwen-Image-Edit output PNG used as MiniMax first_frame';
COMMENT ON COLUMN content_briefs.edit_instruction  IS 'LLM-generated Qwen-Image-Edit instruction';

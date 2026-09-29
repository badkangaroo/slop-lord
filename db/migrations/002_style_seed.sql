-- db/migrations/002_style_seed.sql
--
-- Adds the style_seed JSONB column to content_briefs.
-- Stores the Style Studio configuration (character presets, negative prompts,
-- vibe overrides) that feeds into the ComfyUI workflow.
--
-- Runs after 001_initial.sql (Docker initdb sorts by filename).

ALTER TABLE content_briefs
    ADD COLUMN style_seed JSONB;

-- Example style_seed shape (stored but not enforced at DB level):
-- {
--   "character": "raccoon in a hoodie",
--   "negative_prompt": "realistic, photo, 3d render",
--   "vibe_override": "unhinged-chaos",
--   "aspect_ratio": "9:16",
--   "sampler": "dpm++2m_karras",
--   "steps": 25,
--   "cfg": 7.5
-- }

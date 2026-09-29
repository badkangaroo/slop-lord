-- db/migrations/001_initial.sql
--
-- Core schema for SLOP-LORD.
-- Runs automatically on first Postgres container start via
-- the docker-entrypoint-initdb.d volume mount.

-- ---------------------------------------------------------------------------
-- Tracked TikTok accounts (accounts the agent monitors)
-- ---------------------------------------------------------------------------
CREATE TABLE tiktok_accounts (
    id              SERIAL PRIMARY KEY,
    username        TEXT NOT NULL UNIQUE,
    display_name    TEXT,
    follower_count  INTEGER,
    is_target       BOOLEAN DEFAULT FALSE,   -- accounts we specifically watch
    first_seen_at   TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Raw trend candidates (before scoring / promotion)
-- ---------------------------------------------------------------------------
CREATE TABLE trend_candidates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    captured_at     TIMESTAMPTZ DEFAULT NOW(),
    layer           SMALLINT NOT NULL CHECK (layer IN (1,2,3)),
    raw_data        JSONB NOT NULL,          -- full scraped payload
    tss             NUMERIC(4,3),            -- Trend Signal Score (0.000–1.000)
    promoted        BOOLEAN DEFAULT FALSE    -- true once emitted as a Dossier
);

-- ---------------------------------------------------------------------------
-- Promoted trend dossiers (TSS >= threshold)
-- ---------------------------------------------------------------------------
CREATE TABLE trend_dossiers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id    UUID REFERENCES trend_candidates(id),
    captured_at     TIMESTAMPTZ DEFAULT NOW(),
    layer           SMALLINT NOT NULL,
    tss             NUMERIC(4,3) NOT NULL,
    hook            TEXT NOT NULL,
    template        JSONB NOT NULL,
    vibe            TEXT NOT NULL,
    stats           JSONB NOT NULL,
    source_metadata JSONB,
    processed       BOOLEAN DEFAULT FALSE    -- true once ContentBrief generated
);

-- ---------------------------------------------------------------------------
-- Content briefs generated from dossiers (LLM output → ComfyUI dispatch)
-- ---------------------------------------------------------------------------
CREATE TABLE content_briefs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dossier_id       UUID REFERENCES trend_dossiers(id),
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    premise          TEXT NOT NULL,
    character        TEXT NOT NULL,
    shots            JSONB NOT NULL,
    style_preset     TEXT,
    kokoro_voice_tag TEXT,
    dispatched       BOOLEAN DEFAULT FALSE,  -- true once sent to ComfyUI
    dispatch_job_id  TEXT                    -- ComfyUI prompt_id returned on dispatch
);

-- ---------------------------------------------------------------------------
-- Hashtags (cross-trend frequency tracking + deduplication)
-- ---------------------------------------------------------------------------
CREATE TABLE hashtags (
    id            SERIAL PRIMARY KEY,
    tag           TEXT NOT NULL UNIQUE,
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
    use_count     INTEGER DEFAULT 1
);

CREATE TABLE dossier_hashtags (
    dossier_id UUID    REFERENCES trend_dossiers(id),
    hashtag_id INTEGER REFERENCES hashtags(id),
    PRIMARY KEY (dossier_id, hashtag_id)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Dedup check: don't re-emit the same hook within configurable window
CREATE INDEX idx_dossiers_hook_time ON trend_dossiers (hook, captured_at DESC);

-- Quickly find dossiers awaiting ContentBrief generation
CREATE INDEX idx_dossiers_unprocessed ON trend_dossiers (processed)
    WHERE processed = FALSE;

-- Quickly find briefs not yet dispatched to ComfyUI
CREATE INDEX idx_briefs_undispatched ON content_briefs (dispatched)
    WHERE dispatched = FALSE;

# SLOP-LORD

> **Status:** Spec / Pre-implementation  
> **Working Title:** Slop-Lord — Automated Trend-Jacking & Content Synthesis Pipeline

---

## Overview

Slop-Lord is an end-to-end autonomous content pipeline. It continuously monitors TikTok for reproducible trend patterns, extracts structured "Trend Dossiers," seeds an absurdist content-generation engine, and outputs finished video assets via a ComfyUI instance running on the LAN.

The system is composed of five stages:

```
[ Agent Harness ]  →  [ Trend Scanner ]  →  [ Parody Engine (LM Studio) ]  →  [ Content Synthesis (ComfyUI) ]
       ↑                      ↓                          ↓                                   ↓
  Live Chrome browser    Trend Dossier (JSON)       ContentBrief (JSON)              finished assets
  (human login →         stored in Postgres          dispatched to ComfyUI
   agent takeover)               ↑
                        [ Web UI ]  ←── human reviews trends, selects them,
                                        seeds image styles, triggers generation
```

All runtime addresses (LM Studio, ComfyUI, database) are set via [`config/runtime.yaml`](config/runtime.yaml) and overridable by environment variables — no values are hardcoded.

---

## Stage 1 — Agent Harness

The agent harness is the execution environment that gives the Trend Scanner agent its eyes. It provides a layered set of web-access tools, tried in order of preference.

### 1.1 Tool Priority Stack

| Priority | Tool | Transport | Notes |
|----------|------|-----------|-------|
| 1 | **SearXNG** (local Docker) | REST API `localhost:8080` | Privacy-preserving meta-search; best for hashtag/topic discovery |
| 2 | **Firecrawl** (local Docker) | REST API `localhost:3002` | Structured page scraping & crawl; best for extracting video metadata pages |
| 3 | **Stagehand** | CDP over local browser | AI-driven browser automation; fallback for JS-heavy pages |
| 4 | **Playwright** | CDP over local browser | Direct DOM automation; final fallback when Stagehand is unavailable |

The harness wraps all four tools behind a single `WebAccessor` interface. The agent calls `WebAccessor.search()`, `WebAccessor.scrape()`, and `WebAccessor.browse()` — it never calls individual tool APIs directly. The harness selects the correct backend and retries down the stack on failure.

### 1.2 Local Docker Services

Both SearXNG and Firecrawl run as Docker containers on the local machine. They must be started before any agent run.

**SearXNG**

```yaml
# docker-compose.searxng.yml
services:
  searxng:
    image: searxng/searxng:latest
    ports:
      - "8080:8080"
    volumes:
      - ./config/searxng:/etc/searxng
    environment:
      - SEARXNG_BASE_URL=http://localhost:8080/
```

Key config (`settings.yml` inside `./config/searxng/`):
- Enable engines: `tiktok`, `youtube`, `reddit`, `google`
- Disable safe-search (`safe_search: 0`) for unfiltered trend data
- Set `request_timeout: 10`

**Firecrawl**

```yaml
# docker-compose.firecrawl.yml
services:
  firecrawl:
    image: ghcr.io/mendableai/firecrawl:latest
    ports:
      - "3002:3002"
    environment:
      - FIRECRAWL_API_KEY=local
      - PLAYWRIGHT_MICROSERVICE_URL=http://playwright:3000
  playwright:
    image: ghcr.io/mendableai/firecrawl-playwright-service:latest
    ports:
      - "3000:3000"
```

Firecrawl includes a bundled Playwright microservice for JS rendering — this satisfies the Playwright fallback requirement at the infrastructure level without needing a separate Playwright install for most cases.

### 1.3 Live Chrome Browser — Human Login + Agent Takeover

TikTok requires an authenticated session for full trend data (For You feed, sound metadata, creator stats). The model for this is:

1. **Human logs in once** — Chrome launches in visible (non-headless) mode. The human completes the TikTok login flow including any CAPTCHA or 2FA. The session cookies are persisted to a named Chrome profile directory.
2. **Agent takes over** — after login, the agent attaches to the same Chrome instance via CDP and begins navigating. The browser window remains visible at all times.
3. **Human can intervene at any time** — because the browser is never headless, the human can grab the mouse and keyboard. The agent polls for a `PAUSE` signal file (`/tmp/slop-lord.pause`) before each action; if the file exists, the agent idles and waits for it to be removed before continuing.

```
[ Human opens Chrome ]
        ↓
[ Logs in to TikTok — visible window ]
        ↓
[ Agent attaches via CDP on port 9222 ]
        ↓
[ Agent navigates / scrolls / extracts ]  ←──  Human can grab control at any time
        ↓
[ Session cookies persist to profile dir ]
```

**Chrome launch command (run once manually before starting the agent):**

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.slop-lord/chrome-profile" \
  --no-first-run
```

```bash
# Linux
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.slop-lord/chrome-profile" \
  --no-first-run
```

The `--user-data-dir` path is configurable in [`config/runtime.yaml`](config/runtime.yaml). The agent reads this value and connects to `localhost:9222` via CDP — it never launches its own browser process.

**Human intervention signals:**

| Signal | How | Effect |
|--------|-----|--------|
| Grab mouse / type | Physically move mouse into browser window | No automatic effect; agent notices cursor movement and idles for 5s |
| Pause agent | `touch /tmp/slop-lord.pause` | Agent stops before next action and polls every 2s |
| Resume agent | `rm /tmp/slop-lord.pause` | Agent resumes on next poll cycle |
| Emergency stop | `kill -SIGTERM <agent-pid>` | Graceful shutdown; saves state to DB before exit |

### 1.4 Stagehand (Agent Browser Automation)

Stagehand drives the live Chrome instance (connected via CDP) for all TikTok navigation. It handles:
- Scrolling the For You feed and trend pages
- Extracting video metadata from the DOM
- Dismissing modals and cookie banners
- Interacting with hashtag and sound pages

Because the browser is already running and authenticated, Stagehand connects to it rather than launching its own:

```typescript
// harness/stagehand.config.ts
export const stagehandConfig = {
  env: "LOCAL",
  cdpUrl: `http://localhost:${config.browser.cdpPort}`,  // default 9222, from runtime.yaml
  verbose: 1,
};
```

### 1.5 Playwright Fallback

Playwright is the final fallback — used only when Stagehand itself is unavailable or crashes. It connects to the same live Chrome instance via CDP, using hardcoded selectors. This layer is intentionally brittle and should trigger a log warning when it activates.

### 1.6 WebAccessor Interface Contract

```typescript
interface WebAccessor {
  /** Keyword / hashtag search. Returns list of result URLs + snippets. */
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;

  /** Fetch and parse a URL into clean markdown. */
  scrape(url: string, opts?: ScrapeOptions): Promise<ScrapeResult>;

  /** Full browser session for interactive pages. */
  browse(url: string, instructions: string): Promise<BrowseResult>;
}
```

---

## Stage 2 — Trend Scanner Agent (`@hermes`)

The scanner agent runs on a configurable interval (default: every hour). Its job is not to find "popular videos" — it is to find **clusters of similarity** that indicate a reproducible trend pattern.

### 2.1 The Three Layers of Trends

Every identified trend is classified into one of three layers before being scored:

| Layer | Name | What It Is | Parody Strategy |
|-------|------|------------|-----------------|
| **L1** | Sound / Audio Trend (Micro) | A specific song or audio clip goes viral — people lip-sync or use it as background music | Parody the *vibe* using Kokoro voiceover; the original sound is optional |
| **L2** | Format / Archetype Trend (Meso) | A repeatable video structure goes viral (e.g. "POV: You are...", GRWM, Unboxing) | Primary target — extract the format, apply it to an absurd character |
| **L3** | Cultural / Topic Trend (Macro) | A massive event or topic everyone is discussing (show release, scandal, news) | Create absurdist "news commentary" using established characters |

L2 (Format) trends are the engine's primary fuel. They are the most reproducible and the most automatable.

### 2.2 Quantitative Scoring — Trend Strength

Each candidate trend receives a **Trend Strength Score (TSS)** computed from three metrics:

| Metric | Symbol | Definition |
|--------|--------|------------|
| **Velocity** | $V$ | Rate of view-count growth; `views_now - views_1h_ago / 60` (views per minute) |
| **Density** | $D$ | Number of unique creators using the same hashtag or sound in the last 24h |
| **Participation Diversity** | $P$ | Gini coefficient of creator follower-counts using the trend; high diversity = mainstream crossover |

```
TSS = (V_normalized * 0.5) + (D_normalized * 0.3) + (P * 0.2)
```

The scanner only promotes a candidate to a **Trend Dossier** when `TSS >= 0.65`.

### 2.3 Scanner Checklist — Per Candidate

Before a candidate is emitted as a Trend Dossier, the scanner must resolve all of the following fields:

1. **The Core Hook** — What is actually happening in human terms?  
   *Example: "People are using dramatic orchestral music for mundane cooking fails."*

2. **The Structural Template** — Step-by-step video structure in order.  
   *Example: `[Dramatic Music Sting] → [Close-up face, dead serious] → [Cut to: bowl of cereal on fire] → [Caption: 'I followed the recipe']`*

3. **The Sentiment / Vibe** — Emotional register of the trend.  
   *Options: `funny` | `cringe` | `scary` | `inspirational` | `chaotic` | `absurd`*

### 2.4 Trend Dossier — JSON Schema

This is the canonical data contract between the Scanner and the Parody Engine.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema",
  "title": "TrendDossier",
  "type": "object",
  "required": ["id", "captured_at", "layer", "tss", "hook", "template", "vibe", "stats"],
  "properties": {
    "id": { "type": "string", "format": "uuid" },
    "captured_at": { "type": "string", "format": "date-time" },
    "layer": { "type": "integer", "enum": [1, 2, 3] },
    "tss": { "type": "number", "minimum": 0, "maximum": 1 },
    "hook": { "type": "string", "description": "Human-readable description of what is happening" },
    "template": {
      "type": "array",
      "description": "Ordered steps of the video structure",
      "items": {
        "type": "object",
        "required": ["step", "description"],
        "properties": {
          "step": { "type": "integer" },
          "description": { "type": "string" },
          "duration_hint_sec": { "type": "number" },
          "visual_cue": { "type": "string" },
          "audio_cue": { "type": "string" }
        }
      }
    },
    "vibe": {
      "type": "string",
      "enum": ["funny", "cringe", "scary", "inspirational", "chaotic", "absurd"]
    },
    "stats": {
      "type": "object",
      "properties": {
        "velocity_vpm": { "type": "number", "description": "Views per minute" },
        "unique_creators_24h": { "type": "integer" },
        "participation_diversity": { "type": "number", "minimum": 0, "maximum": 1 },
        "top_hashtags": { "type": "array", "items": { "type": "string" } },
        "sample_video_urls": { "type": "array", "items": { "type": "string", "format": "uri" } }
      }
    },
    "source_layer_metadata": {
      "type": "object",
      "description": "Layer-specific data (L1: audio_id; L2: format_name; L3: topic_keywords)"
    }
  }
}
```

---

## Stage 3 — Content Synthesis Pipeline (ComfyUI on LAN)

Once a Trend Dossier is emitted, the Parody Engine takes over. It transforms the structural template into a content brief, then dispatches generation jobs to a ComfyUI instance running on the local network.

### 3.1 LLM Backend — LM Studio

The Parody Engine uses a local **LM Studio** instance as its LLM backend. LM Studio exposes an OpenAI-compatible REST API, so the integration is a standard chat completion call with a configurable base URL and model name.

```typescript
// parody-engine/llm.ts
const llm = new OpenAI({
  baseURL: config.lmStudio.baseUrl,   // e.g. http://10.0.1.8:1234/v1
  apiKey:  "lm-studio",               // LM Studio ignores the key; required by SDK
  defaultModel: config.lmStudio.model // e.g. "lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF"
});
```

Both `baseUrl` and `model` are read from [`config/runtime.yaml`](config/runtime.yaml) and can be overridden by `LM_STUDIO_BASE_URL` and `LM_STUDIO_MODEL` environment variables. Changing the model requires no code change — just update the config and restart.

**Minimum model requirements for this pipeline:**
- Context window ≥ 8k tokens (the full Trend Dossier JSON + system prompt fits in ~2k)
- Instruction-following capability (any GGUF instruct model at Q4 or above works)
- Tool/function-calling support is not required for this step

### 3.2 Parody Engine — Brief Generation

The Parody Engine is an LLM-powered step that receives a `TrendDossier` and outputs a `ContentBrief`.

**Transformation rules:**
- **Hook** → becomes the absurdist premise (replace the subject with a ridiculous substitute character)
- **Template steps** → preserved as shot structure; visual/audio cues are replaced with in-universe equivalents
- **Vibe** → maps to a Kokoro voice tag and a ComfyUI style preset
- **Layer 2 trends** → the format is kept verbatim; only the subject is swapped (e.g. "GRWM" becomes "Get Ready With Me (trash can going to a board meeting)")

### 3.3 Content Brief — JSON Schema

```json
{
  "title": "ContentBrief",
  "type": "object",
  "properties": {
    "dossier_id": { "type": "string" },
    "premise": { "type": "string" },
    "character": { "type": "string" },
    "shots": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "shot_number": { "type": "integer" },
          "visual_prompt": { "type": "string", "description": "ComfyUI image/video generation prompt" },
          "audio_direction": { "type": "string", "description": "Kokoro TTS script + tone tag" },
          "duration_sec": { "type": "number" }
        }
      }
    },
    "style_preset": { "type": "string", "description": "ComfyUI workflow preset name" },
    "kokoro_voice_tag": { "type": "string" }
  }
}
```

### 3.4 ComfyUI Dispatch

The `ContentBrief` is submitted to the ComfyUI API endpoint on the LAN. The host and port are read from [`config/runtime.yaml`](config/runtime.yaml) and overridable via `COMFYUI_HOST` / `COMFYUI_PORT` environment variables.

```
POST http://<config.comfyui.host>:<config.comfyui.port>/api/prompt
Content-Type: application/json

{
  "prompt": { /* ComfyUI workflow JSON, populated from ContentBrief */ },
  "client_id": "slop-lord"
}
```

**Responsibilities:**
- `visual_prompt` per shot → ComfyUI image or AnimateDiff video node
- `audio_direction` → Kokoro TTS node (voice cloning / tag selection)
- Final assembly → FFmpeg concat step outside ComfyUI, or a ComfyUI video-assembly workflow

---

## Stage 5 — Web UI (Trend Dashboard + Style Studio)

A lightweight local web app sits on top of the Postgres database and the harness API. Its two jobs are:

1. **Trend Dashboard** — browse, filter, and approve incoming Trend Dossiers from the scanner
2. **Style Studio** — for each approved trend, configure the image style seed before dispatching to ComfyUI

The UI runs as a Docker service on the same compose stack. It is a local-only tool — no auth, no public exposure.

### 5.1 Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | **Next.js** (App Router) | File-based routing, server components hit Postgres directly — no separate API layer needed for simple reads |
| Styling | **Tailwind CSS** | Utility classes; no design system overhead |
| DB access | **Drizzle ORM** | Type-safe queries against the existing Postgres schema; schema defined once in `db/schema.ts` |
| Real-time | **Server-Sent Events** | Scanner pushes new dossiers to open dashboard tabs without polling |

### 5.2 Pages & Views

#### `/` — Trend Dashboard

The main view. Displays all `trend_dossiers` rows ordered by `captured_at DESC`, filterable by layer, vibe, and TSS range.

Each card shows:
- **Layer badge** (L1 / L2 / L3) + **Vibe tag**
- **TSS score** as a coloured bar
- **Hook** — the one-line human description
- **Template steps** — collapsed by default, expandable
- **Stats** — velocity, unique creators, top hashtags
- **Sample video thumbnails** (scraped URLs)
- Action buttons: **Approve → Style Studio** | **Dismiss**

Approved dossiers set `trend_dossiers.processed = TRUE` and navigate to the style studio for that dossier.

#### `/style/:dossierId` — Style Studio

The creative configuration screen for one dossier. Produces the `style_seed` that is merged into the `ContentBrief` before ComfyUI dispatch.

**Controls:**

| Control | Type | Maps to |
|---------|------|---------|
| Character | Text input (free-form) | `content_briefs.character` |
| Style Preset | Dropdown (populated from `config/runtime.yaml → comfyui.stylePresets`) | `content_briefs.style_preset` |
| Vibe Override | Segmented button (funny / cringe / chaotic / absurd / scary / inspirational) | overrides `trend_dossiers.vibe` |
| Kokoro Voice | Dropdown (populated from voice taxonomy) | `content_briefs.kokoro_voice_tag` |
| Negative Prompt | Textarea | appended to all `visual_prompt` fields in shots |
| Shot Review | Accordion list of template steps | each step shows the auto-generated `visual_prompt` from the Parody Engine; human can edit before dispatch |

A **Generate** button at the bottom sends the finalised `ContentBrief` to ComfyUI and writes the row to `content_briefs` with `dispatched = TRUE`.

#### `/jobs` — Generation Queue

Live view of all `content_briefs` rows. Shows dispatch status (`dispatched`, `dispatch_job_id`), links to ComfyUI job status endpoint for in-progress jobs, and displays completed output assets when done.

#### `/settings` — Runtime Config Editor

Read/write view of [`config/runtime.yaml`](config/runtime.yaml). Fields:

- LM Studio base URL + model name (text inputs)
- ComfyUI host + port (text inputs)
- Scanner interval + TSS threshold + dedup window (number inputs)
- Style presets list (editable list — add/remove/rename presets)

Changes write directly to `config/runtime.yaml` and emit a reload signal to the running agent process.

### 5.3 API Routes

The Next.js app exposes a small internal API consumed by its own frontend. No external consumers.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/dossiers` | Paginated list with filter params (`layer`, `vibe`, `min_tss`, `processed`) |
| `GET` | `/api/dossiers/:id` | Single dossier with full template |
| `POST` | `/api/dossiers/:id/approve` | Sets `processed = true`, triggers brief generation via LM Studio |
| `POST` | `/api/dossiers/:id/dismiss` | Soft-deletes candidate from view |
| `GET` | `/api/briefs/:id` | Single content brief |
| `POST` | `/api/briefs/:id/dispatch` | Sends brief to ComfyUI, writes `dispatch_job_id` |
| `GET` | `/api/briefs/:id/status` | Proxies ComfyUI job status |
| `GET` | `/api/config` | Returns current `runtime.yaml` as JSON |
| `POST` | `/api/config` | Writes updated config to `runtime.yaml` |
| `GET` | `/api/stream/dossiers` | SSE stream — emits new dossier events as scanner writes to DB |

### 5.4 Docker Service

```yaml
# docker-compose.yml (web section)
  web:
    build:
      context: ./web
      dockerfile: Dockerfile
    ports:
      - "0.0.0.0:3030:3030"
    environment:
      DATABASE_URL: postgres://slop:${DB_PASSWORD}@postgres:5432/slop_lord
      RUNTIME_CONFIG_PATH: /config/runtime.yaml
    volumes:
      - ./config:/config                # exposes runtime.yaml for the settings editor
    depends_on:
      - postgres
```

The app runs on port `3030`, bound to `0.0.0.0` — reachable from any machine on the LAN at `http://<host-ip>:3030`.

### 5.5 Style Seed — Schema Addition

The style configuration from the Style Studio is stored as a new column on `content_briefs` and also feeds back into `runtime.yaml` as a named preset if the user saves it.

```sql
-- db/migrations/002_style_seed.sql
ALTER TABLE content_briefs
  ADD COLUMN style_seed JSONB;   -- stores character, negative_prompt, vibe_override, etc.
```

---

## Stage 4 — Persistence (Dockerised Postgres)

All trend data, TikTok account metadata, and content briefs are stored in a **Postgres** container running in Docker alongside SearXNG and Firecrawl. This is the single source of truth — no flat JSON files in production.

### 4.1 Docker Service

```yaml
# docker-compose.yml (postgres section)
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB:       slop_lord
      POSTGRES_USER:     slop
      POSTGRES_PASSWORD: ${DB_PASSWORD}   # set in .env
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./db/migrations:/docker-entrypoint-initdb.d   # run on first start

volumes:
  postgres_data:
```

### 4.2 Database Schema

```sql
-- db/migrations/001_initial.sql

-- Tracked TikTok accounts (the ones the agent monitors)
CREATE TABLE tiktok_accounts (
    id              SERIAL PRIMARY KEY,
    username        TEXT NOT NULL UNIQUE,
    display_name    TEXT,
    follower_count  INTEGER,
    is_target       BOOLEAN DEFAULT FALSE,   -- accounts we specifically watch
    first_seen_at   TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Raw trend candidates before scoring
CREATE TABLE trend_candidates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    captured_at     TIMESTAMPTZ DEFAULT NOW(),
    layer           SMALLINT NOT NULL CHECK (layer IN (1,2,3)),
    raw_data        JSONB NOT NULL,          -- raw scraped payload
    tss             NUMERIC(4,3),
    promoted        BOOLEAN DEFAULT FALSE    -- true once emitted as a Dossier
);

-- Promoted trend dossiers (TSS >= threshold)
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

-- Content briefs generated from dossiers
CREATE TABLE content_briefs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dossier_id      UUID REFERENCES trend_dossiers(id),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    premise         TEXT NOT NULL,
    character       TEXT NOT NULL,
    shots           JSONB NOT NULL,
    style_preset    TEXT,
    kokoro_voice_tag TEXT,
    dispatched      BOOLEAN DEFAULT FALSE,   -- true once sent to ComfyUI
    dispatch_job_id TEXT                     -- ComfyUI prompt_id returned on dispatch
);

-- Hashtags seen across trends (for dedup and frequency tracking)
CREATE TABLE hashtags (
    id              SERIAL PRIMARY KEY,
    tag             TEXT NOT NULL UNIQUE,
    first_seen_at   TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ DEFAULT NOW(),
    use_count       INTEGER DEFAULT 1
);

CREATE TABLE dossier_hashtags (
    dossier_id  UUID REFERENCES trend_dossiers(id),
    hashtag_id  INTEGER REFERENCES hashtags(id),
    PRIMARY KEY (dossier_id, hashtag_id)
);

-- Index for dedup check: don't re-emit the same hook within 48h
CREATE INDEX idx_dossiers_hook_time ON trend_dossiers (hook, captured_at DESC);
-- Index for querying unprocessed dossiers
CREATE INDEX idx_dossiers_unprocessed ON trend_dossiers (processed) WHERE processed = FALSE;
```

### 4.3 Deduplication Logic

Before emitting a new Trend Dossier the scanner runs:

```sql
SELECT COUNT(*) FROM trend_dossiers
WHERE hook ILIKE $1           -- fuzzy match on hook text
  AND captured_at > NOW() - INTERVAL '48 hours';
```

If `COUNT > 0`, the candidate is suppressed. The 48-hour window is configurable via `DEDUP_WINDOW_HOURS` in [`config/runtime.yaml`](config/runtime.yaml).

---

## Runtime Configuration

All addresses, ports, credentials, and tuning parameters live in one place: [`config/runtime.yaml`](config/runtime.yaml). Environment variables with matching names override any value at runtime (useful for CI or deployment without editing the file).

```yaml
# config/runtime.yaml

browser:
  cdpPort: 9222                                      # Chrome remote debugging port
  profileDir: "~/.slop-lord/chrome-profile"          # persisted Chrome session

lmStudio:
  baseUrl: "http://10.0.1.8:1234/v1"                 # LM Studio OpenAI-compat endpoint
  model:   "lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF"  # change to any loaded model

comfyui:
  host: "10.0.1.3"                                   # LAN IP of ComfyUI machine
  port: 8188

database:
  host:     "localhost"
  port:     5432
  name:     "slop_lord"
  user:     "slop"
  # password comes from DB_PASSWORD env var only — never written to this file

searxng:
  url: "http://localhost:8080"

firecrawl:
  url:    "http://localhost:3002"
  apiKey: "local"

scanner:
  intervalMinutes: 60
  tssThreshold:    0.65
  dedupWindowHours: 48
```

**Environment variable overrides** (all optional — only needed to differ from `runtime.yaml`):

```env
# .env  (not committed — copy from .env.example)
DB_PASSWORD=changeme

# Override any runtime.yaml value:
LM_STUDIO_BASE_URL=http://10.0.1.8:1234/v1
LM_STUDIO_MODEL=eclipsed-phoenix-26b-a4b-heretic
COMFYUI_HOST=10.0.1.3
COMFYUI_PORT=8188
BROWSER_CDP_PORT=9222
SCANNER_INTERVAL_MINUTES=60
TSS_THRESHOLD=0.65
DEDUP_WINDOW_HOURS=48
```

---

## Project Structure

```
slop-lord/
├── README.md                           # full spec + decision log
├── .env.example                        # copy to .env; set DB_PASSWORD
├── .env                                # ← not committed
├── docker-compose.yml                  # SearXNG + Firecrawl + Postgres + Web UI
│
├── docs/                               # reference docs
│   ├── agents.md                       # ← agent continuity guide (START HERE each session)
│   ├── integrations.md                 # MCPs, plugins, npm packages, browser extensions
│   └── architecture.md                 # system diagram, data flow, port reference
│
├── config/
│   ├── runtime.yaml                    # ALL addresses, ports, model names, thresholds
│   └── searxng/
│       └── settings.yml                # SearXNG engine config
│
├── db/
│   ├── schema.ts                       # Drizzle ORM schema — source of truth for table shapes
│   ├── client.ts                       # Postgres connection pool (reads config/runtime.yaml)
│   └── migrations/
│       ├── 001_initial.sql             # core tables
│       └── 002_style_seed.sql          # adds style_seed JSONB to content_briefs
│
├── harness/
│   ├── WebAccessor.ts                  # unified interface: search() / scrape() / browse()
│   ├── searxng.ts                      # adapter → localhost:8080
│   ├── firecrawl.ts                    # adapter → localhost:3002
│   ├── stagehand.ts                    # adapter → CDP on live Chrome :9222
│   ├── playwright.ts                   # fallback adapter → CDP on live Chrome :9222
│   └── pause-guard.ts                  # polls /tmp/slop-lord.pause before every agent action
│
├── scanner/
│   ├── agent.ts                        # @hermes — main hourly scanner loop
│   ├── scorer.ts                       # TSS = (V×0.5)+(D×0.3)+(P×0.2); threshold 0.65
│   ├── classifier.ts                   # assigns L1/L2/L3 layer to each candidate
│   └── dossier.ts                      # builds TrendDossier, validates, writes to DB
│
├── parody-engine/
│   ├── llm.ts                          # LM Studio client (OpenAI-compat, 10.0.1.8:1234/v1)
│   ├── brief-generator.ts              # LLM step: TrendDossier → ContentBrief
│   └── comfyui-dispatch.ts             # POST ContentBrief shots → ComfyUI 10.0.1.3:8188
│
├── web/                                # Next.js app — served on 0.0.0.0:3030
│   ├── Dockerfile
│   ├── app/
│   │   ├── page.tsx                    # / — Trend Dashboard
│   │   ├── style/[dossierID]/page.tsx  # /style/:id — Style Studio
│   │   ├── jobs/page.tsx               # /jobs — Generation Queue
│   │   ├── settings/page.tsx           # /settings — Runtime Config Editor
│   │   └── api/
│   │       ├── dossiers/               # GET list+filters, GET :id, POST approve/dismiss
│   │       ├── briefs/                 # GET :id, POST dispatch, GET :id/status
│   │       ├── config/                 # GET + POST runtime.yaml
│   │       └── stream/dossiers/        # SSE — pushes new dossiers to open tabs
│   ├── components/
│   │   ├── DossierCard.tsx             # layer/vibe/TSS/hook/template/stats card
│   │   ├── StyleStudio.tsx             # character, preset, voice, negative prompt, shot editor
│   │   ├── JobRow.tsx                  # row in generation queue with ComfyUI job status
│   │   └── ConfigEditor.tsx            # read/write form for runtime.yaml
│   └── lib/
│       └── db.ts                       # Drizzle client for Next.js server components
│
├── schemas/
│   ├── TrendDossier.schema.json        # JSON Schema — validated on every DB write
│   └── ContentBrief.schema.json        # JSON Schema — validated before ComfyUI dispatch
│
└── scripts/
    └── launch-chrome.sh                # opens Chrome with --remote-debugging-port=9222
                                        # and --user-data-dir=~/.slop-lord/chrome-profile
```

---

## Quick Start (Development)

```bash
# 1. Copy config and set DB password
cp .env.example .env
# edit .env → set DB_PASSWORD

# 2. Edit config/runtime.yaml
#    → set lmStudio.baseUrl and lmStudio.model to match your loaded model
#    → set comfyui.host to your LAN ComfyUI machine's IP

# 3. Start Docker services (SearXNG + Firecrawl + Postgres + Web UI)
docker compose up -d

# 4. Launch Chrome with CDP enabled (run this once, then log in to TikTok)
./scripts/launch-chrome.sh
# → Chrome opens visibly; log in to TikTok manually; leave window open

# 5. Start the agent
npm run agent
# → Agent attaches to Chrome on port 9222 and begins scanning

# 6. Open the dashboard
open http://localhost:3030
# → Trend Dashboard loads; also reachable from any LAN device at http://<host-ip>:3030
```

---

## Open Questions / Next Steps

- [x] Choose LLM backend → **LM Studio** at `10.0.1.8:1234/v1`; model + URL in `config/runtime.yaml`
- [x] Decide on persistence layer → **Dockerised Postgres 16** with structured schema
- [x] Establish dedup logic → 48h window on hook text, configurable via `DEDUP_WINDOW_HOURS`
- [x] Resolve TikTok auth → human logs in once to live Chrome; agent attaches via CDP port 9222
- [x] Web UI → **Next.js on `0.0.0.0:3030`** — Trend Dashboard, Style Studio, Job Queue, Settings; LAN-accessible
- [x] Directory structure → scaffolded; `docs/` created with `agents.md`, `integrations.md`, `architecture.md`
- [ ] Write `config/runtime.yaml` file (template defined above in Runtime Configuration section)
- [ ] Write `docker-compose.yml` (all service definitions specified above)
- [ ] Extract SQL migrations from README into `db/migrations/001_initial.sql` + `002_style_seed.sql`
- [ ] Draft the full Kokoro voice-tag taxonomy (maps `vibe` values to voice parameters)
- [ ] Define ComfyUI style preset list in `config/runtime.yaml → comfyui.stylePresets`
- [ ] Implement `pause-guard.ts` — pause/resume signal file protocol
- [ ] Define `scripts/launch-chrome.sh` cross-platform behaviour (macOS vs. Linux paths)
- [ ] Decide on thumbnail extraction strategy for sample video URLs in `DossierCard`

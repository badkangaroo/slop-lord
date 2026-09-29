# SLOP-LORD — Architecture Reference

> Concise system overview. For full decision history and rationale see [`README.md`](../README.md). For agent-session setup see [`docs/agents.md`](agents.md).

---

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        HOST MACHINE (Docker)                        │
│                                                                     │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌───────────────────┐ │
│  │ SearXNG  │  │ Firecrawl │  │ Postgres │  │  Web UI (Next.js) │ │
│  │ :8080    │  │ :3002     │  │ :5432    │  │  0.0.0.0:3030     │ │
│  └────┬─────┘  └─────┬─────┘  └────┬─────┘  └────────┬──────────┘ │
│       │              │              │                  │            │
│  ┌────▼──────────────▼──────────────▼──────────────────▼─────────┐ │
│  │                    Agent Process (Node.js)                     │ │
│  │                                                                │ │
│  │  harness/WebAccessor  →  scanner/@hermes  →  parody-engine    │ │
│  │  (SearXNG/Firecrawl/      (TSS scorer,        (LLM brief      │ │
│  │   Stagehand/Playwright)    classifier,          generator,     │ │
│  │         ↑                  dossier writer)       dispatcher)   │ │
│  │         │                                            │         │ │
│  └─────────┼────────────────────────────────────────────┼─────────┘ │
│            │                                            │            │
│  ┌─────────▼──────────────────┐              ┌──────────▼─────────┐ │
│  │  Live Chrome Browser       │              │   LAN → ComfyUI    │ │
│  │  --remote-debugging-port   │              │   10.0.1.3:8188    │ │
│  │  =9222                     │              └────────────────────┘ │
│  │  (human logged in to       │                                     │
│  │   TikTok; agent attaches)  │                                     │
│  └────────────────────────────┘                                     │
└─────────────────────────────────────────────────────────────────────┘
                                         ▲
                              LAN Services (separate machines)
                              LM Studio @ 10.0.1.8:1234/v1
                              ComfyUI   @ 10.0.1.3:8188
```

---

## Data Flow

### 1. Discovery (hourly)

```
Chrome (TikTok session)
    │
    ├── Stagehand navigates For You feed + trending hashtag pages
    │
    ▼
WebAccessor.browse() / .scrape()
    │
    ├── Raw video metadata extracted per candidate
    │
    ▼
scanner/scorer.ts  →  TSS = (V×0.5) + (D×0.3) + (P×0.2)
    │
    ├── TSS < 0.65  →  written to trend_candidates (promoted=false), discarded
    │
    └── TSS ≥ 0.65  →  scanner/classifier.ts assigns L1/L2/L3
                            │
                            ▼
                       scanner/dossier.ts  →  validates against TrendDossier.schema.json
                            │
                            ▼
                       Postgres: trend_dossiers (processed=false)
                            │
                            ▼
                       SSE stream → Web UI dashboard (live push)
```

### 2. Human Review (web UI)

```
Web UI /  (Trend Dashboard)
    │
    ├── Human filters by layer / vibe / TSS
    ├── Reads hook + template + stats per card
    │
    ├── DISMISS  →  candidate hidden from view (not deleted)
    │
    └── APPROVE  →  navigates to /style/:id (Style Studio)
                        │
                        ├── Human sets: character, style_preset,
                        │   vibe_override, kokoro_voice_tag,
                        │   negative_prompt, per-shot prompt edits
                        │
                        └── GENERATE  →  /api/dossiers/:id/approve
```

### 3. Content Generation

```
POST /api/dossiers/:id/approve
    │
    ▼
parody-engine/brief-generator.ts
    │
    ├── Builds system prompt + dossier JSON
    ├── POST http://10.0.1.8:1234/v1/chat/completions
    │   model: config.lmStudio.model  temp: 0.8
    │
    ▼
ContentBrief (validated against ContentBrief.schema.json)
    │
    ├── Merged with style_seed from Style Studio
    │
    ▼
Postgres: content_briefs (dispatched=false)
    │
    ▼
parody-engine/comfyui-dispatch.ts
    │
    ├── Builds ComfyUI workflow JSON per shot
    ├── POST http://10.0.1.3:8188/api/prompt
    │
    ▼
Postgres: content_briefs.dispatch_job_id = <comfyui_prompt_id>
         content_briefs.dispatched = true
    │
    ▼
Web UI /jobs  →  polls GET /api/briefs/:id/status
               →  proxies GET http://10.0.1.3:8188/api/history/<job_id>
```

---

## Database Tables

| Table | Key Columns | Notes |
|-------|-------------|-------|
| `tiktok_accounts` | `username`, `follower_count`, `is_target` | Accounts the agent specifically monitors |
| `trend_candidates` | `layer`, `raw_data` (JSONB), `tss`, `promoted` | All raw scraped candidates; most never promoted |
| `trend_dossiers` | `layer`, `tss`, `hook`, `template` (JSONB), `vibe`, `stats` (JSONB), `processed` | Promoted candidates; `processed=true` once a brief exists |
| `content_briefs` | `dossier_id`, `shots` (JSONB), `style_seed` (JSONB), `dispatched`, `dispatch_job_id` | One per approved dossier; linked to ComfyUI job |
| `hashtags` | `tag`, `use_count` | Frequency tracking across all dossiers |
| `dossier_hashtags` | `dossier_id`, `hashtag_id` | Join table |

Full SQL: [`db/migrations/001_initial.sql`](../db/migrations/001_initial.sql), [`db/migrations/002_style_seed.sql`](../db/migrations/002_style_seed.sql)  
ORM schema: [`db/schema.ts`](../db/schema.ts)

---

## Configuration Hierarchy

```
config/runtime.yaml       ← primary; edit this for permanent changes
    ↑ overridden by
.env                      ← local overrides; not committed
    ↑ overridden by
environment variables     ← CI / deployment / docker compose env: block
```

All three layers are merged at startup in `db/client.ts` and `harness/WebAccessor.ts`. Code never reads addresses directly — always via the merged config object.

---

## Human ↔ Agent Boundary

The browser is **never headless**. The agent operates a window the human can see and grab at any time.

| Situation | What happens |
|-----------|-------------|
| Human moves mouse into Chrome | Agent detects idle; waits 5s before resuming |
| Human runs `touch /tmp/slop-lord.pause` | Agent idles at next `pause-guard.ts` checkpoint |
| Human runs `rm /tmp/slop-lord.pause` | Agent resumes within 2s |
| Human sends `SIGTERM` to agent PID | Agent saves state to DB, closes Stagehand session, exits cleanly |
| Human opens Web UI | No effect on agent; they run independently |
| Human clicks Approve in Web UI | Triggers brief generation in-process (same Node server as the API) |

---

## Port Reference

| Port | Binding | Service |
|------|---------|---------|
| `8080` | `localhost` | SearXNG |
| `3002` | `localhost` | Firecrawl |
| `3000` | internal Docker | Firecrawl Playwright sidecar |
| `5432` | `localhost` | Postgres |
| `3030` | `0.0.0.0` (LAN) | Web UI |
| `9222` | `localhost` | Chrome CDP (remote debugging) |
| `1234` | LAN `10.0.1.8` | LM Studio |
| `8188` | LAN `10.0.1.3` | ComfyUI |

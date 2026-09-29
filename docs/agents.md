# SLOP-LORD — Agent Continuity Guide

> **Read this first.** This document exists so that any agent (or human developer) starting a new session can immediately understand where everything lives, what has already been decided, and what still needs doing. Update this file whenever a significant decision is made or a module is implemented.

---

## What This Project Is

An automated TikTok trend-jacking pipeline. It:
1. Watches TikTok for reproducible trend patterns using a live Chrome browser
2. Scores and classifies them into structured Trend Dossiers stored in Postgres
3. A human reviews dossiers in a web UI, picks one, and configures an image style
4. An LLM (LM Studio) transforms the dossier into a ContentBrief
5. The brief is dispatched to ComfyUI on the LAN which generates the actual video assets

Full spec lives in [`README.md`](../README.md). Read it before touching anything.

---

## Repo Map — Where Everything Goes

```
slop-lord/
├── README.md               ← full spec; source of truth for decisions
├── docs/                   ← all reference docs (you are here)
│   ├── agents.md           ← THIS FILE — continuity guide for new sessions
│   ├── integrations.md     ← MCPs, plugins, tool setup instructions
│   └── architecture.md     ← system diagram + data flow narrative
├── config/
│   ├── runtime.yaml        ← ALL runtime addresses, ports, thresholds (edit this, not .env)
│   └── searxng/
│       └── settings.yml    ← SearXNG engine config
├── db/
│   ├── schema.ts           ← Drizzle ORM schema — single source of truth for table shapes
│   ├── client.ts           ← Postgres connection pool, reads config/runtime.yaml
│   └── migrations/
│       ├── 001_initial.sql ← core tables: tiktok_accounts, trend_candidates, trend_dossiers,
│       │                       content_briefs, hashtags, dossier_hashtags
│       └── 002_style_seed.sql ← adds style_seed JSONB column to content_briefs
├── harness/
│   ├── WebAccessor.ts      ← unified interface: search() / scrape() / browse()
│   ├── searxng.ts          ← adapter: REST → http://localhost:8080
│   ├── firecrawl.ts        ← adapter: REST → http://localhost:3002
│   ├── stagehand.ts        ← adapter: CDP → connects to live Chrome on port 9222
│   ├── playwright.ts       ← adapter: CDP fallback, hardcoded selectors
│   └── pause-guard.ts      ← checks /tmp/slop-lord.pause before every agent action
├── scanner/
│   ├── agent.ts            ← @hermes main loop; runs every SCANNER_INTERVAL_MINUTES
│   ├── scorer.ts           ← TSS = (V*0.5) + (D*0.3) + (P*0.2); promotes at >= 0.65
│   ├── classifier.ts       ← assigns L1/L2/L3 layer to each candidate
│   └── dossier.ts          ← builds TrendDossier, validates against schema, writes to DB
├── parody-engine/
│   ├── llm.ts              ← OpenAI-compat client pointed at LM Studio (10.0.1.8:1234/v1)
│   ├── brief-generator.ts  ← LLM prompt: TrendDossier → ContentBrief
│   └── comfyui-dispatch.ts ← POST to ComfyUI at 10.0.1.3:8188/api/prompt
├── web/                    ← Next.js app, runs on 0.0.0.0:3030
│   ├── app/page.tsx        ← / Trend Dashboard
│   ├── app/style/[id]/     ← /style/:id Style Studio
│   ├── app/jobs/           ← /jobs Generation Queue
│   ├── app/settings/       ← /settings Runtime Config Editor
│   ├── app/api/            ← internal API routes (dossiers, briefs, config, SSE stream)
│   ├── components/         ← DossierCard, StyleStudio, JobRow, ConfigEditor
│   └── lib/db.ts           ← Drizzle client for Next.js server components
├── schemas/
│   ├── TrendDossier.schema.json   ← JSON Schema for dossier validation
│   └── ContentBrief.schema.json   ← JSON Schema for brief validation
└── scripts/
    └── launch-chrome.sh    ← opens Chrome with --remote-debugging-port=9222
                               and --user-data-dir=~/.slop-lord/chrome-profile
```

---

## Decided — Do Not Re-Debate

| Topic | Decision |
|-------|----------|
| LLM backend | **LM Studio** at `10.0.1.8:1234/v1` — OpenAI-compat API; model set in `config/runtime.yaml` |
| Persistence | **Postgres 16** in Docker; schema in `db/migrations/`; Drizzle ORM in TypeScript |
| TikTok auth | Human logs in once to **live visible Chrome**; agent attaches via CDP; session persists in profile dir |
| Browser tool stack | SearXNG → Firecrawl → Stagehand → Playwright (in priority order; Stagehand/Playwright attach to live Chrome) |
| ComfyUI | At `10.0.1.3:8188`; host/port in `config/runtime.yaml` |
| Web UI port | `0.0.0.0:3030` — LAN-accessible; **not** localhost-only |
| Web UI framework | **Next.js** App Router + Tailwind + Drizzle |
| Config strategy | `config/runtime.yaml` is source of truth; env vars override; no hardcoded addresses anywhere |
| Dedup window | 48h on hook text (ILIKE match); configurable via `DEDUP_WINDOW_HOURS` |
| TSS threshold | 0.65 default; configurable via `TSS_THRESHOLD` |
| Human intervention | `/tmp/slop-lord.pause` signal file; agent polls before each action |

---

## Current Status

| Module | Status | Notes |
|--------|--------|-------|
| `README.md` spec | ✅ Complete | Full spec written; all major decisions documented |
| Directory structure | ✅ Scaffolded | All directories created |
| `docs/` | ✅ Complete | agents.md, integrations.md, architecture.md all written |
| `config/runtime.yaml` | ✅ Complete | Real file with LM Studio + ComfyUI addresses; stagehand model config |
| `config/index.ts` | ✅ Complete | YAML loader with env var overrides; single config object for all modules |
| `.env.example` | ✅ Complete | Documents all required and optional env vars |
| `package.json` / `tsconfig.json` | ✅ Complete | Node ESM workspace; `npm run test:login` wired |
| `scripts/launch-chrome.sh` | ✅ Complete | Cross-platform (macOS/Linux); reads config; detects Chrome binary |
| `scripts/test-login.ts` | ✅ Complete | 7-step interactive test: CDP check → login wait → session confirm → scrape |
| `harness/chrome-detect.ts` | ✅ Complete | Cross-platform Chrome binary detection (macOS + Linux) |
| `harness/browser.ts` | ✅ Complete | CDP health check, login page detection, wait-for-ready loop, reconnect backoff |
| `harness/pause-guard.ts` | ✅ Complete | Signal file poll, SIGTERM/SIGINT handler, shutdown handler registry |
| `harness/stagehand.ts` | ✅ Complete | Launches Chrome with profile (headless:false); initFromPage → act/extract |
| `harness/playwright.ts` | ✅ Complete | Fallback; connects to live Chrome via CDP; warns when active |
| `harness/WebAccessor.ts` | ✅ Complete | Unified interface; SearXNG→Firecrawl + Stagehand→Playwright chains |
| `docker-compose.yml` | ✅ Complete | postgres + searxng + firecrawl + firecrawl-playwright + web; healthchecks |
| `db/migrations/001_initial.sql` | ✅ Complete | All 6 tables + indexes; auto-runs on first `docker compose up` |
| `db/migrations/002_style_seed.sql` | ✅ Complete | `style_seed JSONB` column on content_briefs |
| `db/schema.ts` | ✅ Complete | Drizzle ORM; mirrors SQL exactly; type exports |
| `db/client.ts` | ✅ Complete | node-postgres pool; reads config; `closeDb()` for clean shutdown |
| `scanner/scorer.ts` | ✅ Complete | TSS formula; normalised V/D/P; batch scoring + sort |
| `scanner/classifier.ts` | ✅ Complete | Layer 1/2/3 + vibe label from content labels + keyword rules |
| `scanner/dossier.ts` | ✅ Complete | dedup check; candidate + dossier insert; hashtag upsert + join |
| `scanner/agent.ts` | ✅ Complete | @hermes main loop; single-run + `--loop` mode; pause-guard aware |
| `parody-engine/` | ⬜ Not implemented | llm.ts, brief-generator.ts, comfyui-dispatch.ts |
| `web/` | ⬜ Not implemented | Next.js dashboard; Dockerfile needed before `docker compose up` works |

---

## Key Data Contracts

### TrendDossier (scanner → DB → web UI → parody engine)
Fields: `id`, `captured_at`, `layer` (1/2/3), `tss`, `hook`, `template[]`, `vibe`, `stats`, `source_metadata`  
Full JSON Schema: [`schemas/TrendDossier.schema.json`](../schemas/TrendDossier.schema.json)

### ContentBrief (parody engine → ComfyUI dispatch)
Fields: `dossier_id`, `premise`, `character`, `shots[]`, `style_preset`, `kokoro_voice_tag`, `style_seed`  
Full JSON Schema: [`schemas/ContentBrief.schema.json`](../schemas/ContentBrief.schema.json)

### TSS Formula
```
TSS = (V_normalized * 0.5) + (D_normalized * 0.3) + (P * 0.2)

V = views per minute (velocity)
D = unique creators using hashtag/sound in last 24h (density)
P = participation diversity (Gini coefficient of follower counts)
```

---

## Things Still Needed (Open TODOs)

- [ ] **`parody-engine/llm.ts`** — OpenAI-compat client pointed at LM Studio (`10.0.1.8:1234/v1`)
- [ ] **`parody-engine/brief-generator.ts`** — LLM prompt: `TrendDossier` → `ContentBrief`
- [ ] **`parody-engine/comfyui-dispatch.ts`** — POST to ComfyUI at `10.0.1.3:8188/api/prompt`
- [ ] **`web/`** — Next.js app (Trend Dashboard, Style Studio, Job Queue, Settings) + `web/Dockerfile`
- [ ] Kokoro voice-tag taxonomy — map each `vibe` value to voice parameters
- [ ] ComfyUI style preset list — define named presets in `config/runtime.yaml → comfyui.stylePresets`
- [ ] Thumbnail extraction strategy for `DossierCard` sample video URLs
- [ ] `config/searxng/settings.yml` — SearXNG engine config file (tiktok, youtube, reddit, google engines)

---

## Starting a New Session — Checklist

1. Read [`README.md`](../README.md) — the full spec is there
2. Read this file (`docs/agents.md`) — confirms what's decided
3. Read [`docs/integrations.md`](integrations.md) — check which tools are available
4. Check the **Current Status** table above — find the first ⬜ and start there
5. When you finish a module, update the status table in this file
6. If you make a significant architectural decision, add it to the **Decided** table

# SLOP-LORD — Integrations, MCPs & Plugins

> This document lists every external tool, MCP server, browser extension, and plugin required or recommended to run and develop the Slop-Lord pipeline. Each entry includes what it does in this project, where to get it, and any configuration notes.

---

## MCP Servers

Model Context Protocol servers give the agent structured tool access at session time. Install these in your agent host (Bob / Claude Desktop / etc.) before running any agent sessions against this codebase.

### Required

| MCP Server | Purpose in this project | Install |
|------------|--------------------------|---------|
| **`@modelcontextprotocol/server-postgres`** | Query and write to the Postgres database directly from the agent — inspect trend dossiers, content briefs, account records | `npx @modelcontextprotocol/server-postgres postgresql://slop:<DB_PASSWORD>@localhost:5432/slop_lord` |
| **`@modelcontextprotocol/server-filesystem`** | Read/write `config/runtime.yaml`, migration files, and schema files without switching tools | `npx @modelcontextprotocol/server-filesystem /path/to/slop-lord` |
| **`@playwright/mcp`** | Give the agent direct Playwright browser control for the TikTok scraping fallback layer | `npx @playwright/mcp` |

### Recommended

| MCP Server | Purpose in this project | Install |
|------------|--------------------------|---------|
| **`firecrawl-mcp`** | Exposes Firecrawl scrape/crawl as MCP tools so the agent can call them natively during sessions | `npx firecrawl-mcp` — set `FIRECRAWL_URL=http://localhost:3002` |
| **`@modelcontextprotocol/server-github`** | Source control operations from within agent sessions — commit scaffolded files, open PRs | `npx @modelcontextprotocol/server-github` — requires `GITHUB_PERSONAL_ACCESS_TOKEN` |
| **`@modelcontextprotocol/server-memory`** | Persistent key-value memory across sessions — store agent observations about TikTok patterns between runs | `npx @modelcontextprotocol/server-memory` |

### Configuration block (Bob / Claude Desktop `mcp_servers.yaml`)

```yaml
mcpServers:
  postgres:
    command: npx
    args:
      - "@modelcontextprotocol/server-postgres"
      - "postgresql://slop:${DB_PASSWORD}@localhost:5432/slop_lord"

  filesystem:
    command: npx
    args:
      - "@modelcontextprotocol/server-filesystem"
      - "/path/to/slop-lord"           # ← replace with your absolute repo path

  playwright:
    command: npx
    args:
      - "@playwright/mcp"

  firecrawl:
    command: npx
    args:
      - "firecrawl-mcp"
    env:
      FIRECRAWL_URL: "http://localhost:3002"

  memory:
    command: npx
    args:
      - "@modelcontextprotocol/server-memory"
```

---

## Docker Services

All services run via `docker compose up -d` from the repo root. See `docker-compose.yml` for the full definitions.

| Service | Image | Port | Role |
|---------|-------|------|------|
| **SearXNG** | `searxng/searxng:latest` | `8080` | Meta-search for hashtag/topic discovery |
| **Firecrawl** | `ghcr.io/mendableai/firecrawl:latest` | `3002` | Structured page scraping + JS rendering |
| **Firecrawl Playwright sidecar** | `ghcr.io/mendableai/firecrawl-playwright-service:latest` | `3000` (internal) | JS rendering microservice for Firecrawl |
| **Postgres 16** | `postgres:16-alpine` | `5432` | Primary database — trends, briefs, accounts |
| **Web UI** | `./web` (local build) | `3030` (LAN) | Next.js dashboard — 0.0.0.0 bound |

---

## LAN Services (not in Docker)

These run on other machines on the network and are accessed over the LAN.

| Service | Address | Role |
|---------|---------|------|
| **LM Studio** | `http://10.0.1.8:1234/v1` | OpenAI-compatible LLM API — powers the Parody Engine brief generator |
| **ComfyUI** | `http://10.0.1.3:8188` | Image/video generation — receives ContentBrief shots as workflow prompts |

Both addresses are in `config/runtime.yaml` and can be changed there without touching code.

---

## Node / npm Packages

### Agent & Harness

| Package | Version | Purpose |
|---------|---------|---------|
| `@browserbasehq/stagehand` | latest | AI-driven browser automation; connects to live Chrome via CDP |
| `playwright` | latest | Fallback browser automation |
| `openai` | latest | LM Studio client (OpenAI-compat SDK) |
| `node-fetch` / native `fetch` | — | SearXNG + Firecrawl REST calls |
| `pg` | latest | Postgres client |
| `drizzle-orm` | latest | Type-safe ORM over Postgres |
| `drizzle-kit` | latest | Migration runner |
| `zod` | latest | Runtime schema validation for TrendDossier and ContentBrief |
| `js-yaml` | latest | Read/write `config/runtime.yaml` |
| `uuid` | latest | Generate dossier/brief IDs |
| `chokidar` | latest | Watch `/tmp/slop-lord.pause` signal file |

### Web UI (`web/`)

| Package | Version | Purpose |
|---------|---------|---------|
| `next` | 14+ | App Router framework |
| `tailwindcss` | latest | Utility CSS |
| `drizzle-orm` + `pg` | — | Server component DB access |
| `zod` | — | API request validation |
| `@radix-ui/react-*` | latest | Unstyled accessible UI primitives (dropdowns, accordion, segmented buttons) |

---

## Browser Extensions (for the live Chrome session)

These are installed in the Chrome profile at `~/.slop-lord/chrome-profile` to aid the agent's TikTok scraping session.

| Extension | Purpose |
|-----------|---------|
| **EditThisCookie** | Inspect and export TikTok session cookies if the agent needs to hand them off |
| **uBlock Origin** | Block tracker noise and ad iframes that interfere with DOM scraping |

> **Note:** Extensions must be installed manually in the Chrome profile after the first launch. Run `./scripts/launch-chrome.sh`, install extensions, then close Chrome — they will persist in the profile for all future agent sessions.

---

## Stagehand — Notes for Agents

Stagehand is the primary tool for all TikTok navigation. Key behaviours to know:

- **It connects to an already-running Chrome** — it does NOT launch its own. The agent must confirm Chrome is running on port 9222 before calling any Stagehand method.
- **Instruction-based**: Stagehand takes natural language instructions like `"scroll down until you see the next 5 videos"`. Prefer this over hardcoded selectors.
- **`act()` vs `extract()`**: use `act()` for navigation/clicks, `extract()` for pulling structured data from the current page.
- **Pause guard**: every call to `act()` or `extract()` must be preceded by a `pause-guard.ts` check. Do not bypass this.

---

## ComfyUI — Notes for Agents

- The API is at `http://10.0.1.3:8188`
- Submitting a job: `POST /api/prompt` with `{ prompt: <workflow_json>, client_id: "slop-lord" }`
- Polling job status: `GET /api/history/<prompt_id>`
- Available workflows (style presets) must be defined in `config/runtime.yaml → comfyui.stylePresets` — the agent should not invent workflow names that aren't in that list
- If ComfyUI is unreachable, log the error, set `content_briefs.dispatched = FALSE`, and do not retry automatically — let the web UI surface the failure

---

## LM Studio — Notes for Agents

- The API is OpenAI-compatible at `http://10.0.1.8:1234/v1`
- Use model name from `config/runtime.yaml → lmStudio.model` — do not hardcode
- If the model is not loaded, LM Studio returns a 503; the agent should surface this as a clear error rather than retrying in a loop
- Context window: any loaded model should have ≥ 8k tokens. The TrendDossier + system prompt fits in ~2k; full ContentBrief generation fits in ~4k
- Temperature for brief generation: `0.8` (creative but structured)
- Temperature for classification/scoring: `0.1` (deterministic)

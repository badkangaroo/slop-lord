/**
 * harness/stagehand.ts
 *
 * Stagehand adapter — AI-driven browser automation for TikTok navigation.
 *
 * ARCHITECTURE
 * ------------
 * The human runs scripts/launch-chrome.sh FIRST. That opens a real visible
 * Chrome window on a persistent profile. The human logs in to TikTok there.
 *
 * When this module initialises it:
 *   1. Confirms Chrome is reachable and TikTok is authenticated (blocks if not)
 *   2. Uses Playwright's chromium.connectOverCDP() to get the existing Page
 *   3. Calls stagehand.initFromPage(page) to wire Stagehand to that page
 *   4. All subsequent act()/extract() calls use the human's live session
 *
 * Stagehand NEVER launches its own browser. The window stays visible.
 *
 * LLM BACKEND FOR STAGEHAND
 * --------------------------
 * Stagehand uses OpenAI or Anthropic for DOM reasoning (act / extract).
 * Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env.
 * Default model: gpt-4o-mini. Override with STAGEHAND_MODEL env var.
 *
 * This is separate from the Parody Engine LLM (LM Studio at 10.0.1.8).
 * Stagehand's LLM only sees the DOM — it never sees trend data.
 */

import { Stagehand } from "@browserbasehq/stagehand";
import { chromium, type Browser } from "playwright";
import { z } from "zod";
import { config } from "../config/index.js";
import { waitForBrowser, withReconnect } from "./browser.js";
import { pauseGuard } from "./pause-guard.js";

// ---------------------------------------------------------------------------
// Types (shared with playwright.ts and WebAccessor.ts)
// ---------------------------------------------------------------------------

export interface VideoMetadata {
  url: string;
  description: string;
  author: string;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  plays: number | null;
  hashtags: string[];
  soundName: string | null;
  soundId: string | null;
  capturedAt: string;
}

export interface TrendPageResult {
  videos: VideoMetadata[];
  hashtag?: string;
}

// ---------------------------------------------------------------------------
// Zod schemas for Stagehand extract()
// ---------------------------------------------------------------------------

const VideoSchema = z.object({
  url: z.string(),
  description: z.string(),
  author: z.string(),
  likes: z.number().nullable(),
  comments: z.number().nullable(),
  shares: z.number().nullable(),
  plays: z.number().nullable(),
  hashtags: z.array(z.string()),
  soundName: z.string().nullable(),
  soundId: z.string().nullable(),
});

const VideoListSchema = z.object({
  videos: z.array(VideoSchema),
});

const TrendingHashtagsSchema = z.object({
  hashtags: z.array(
    z.object({
      tag: z.string(),
      viewCount: z.number().nullable(),
    })
  ),
});

// ---------------------------------------------------------------------------
// Session — Stagehand launched into the persistent Chrome profile
// ---------------------------------------------------------------------------

let _stagehand: Stagehand | null = null;

/**
 * Gets or creates the Stagehand session.
 *
 * Strategy:
 *   - Stagehand launches Chrome with localBrowserLaunchOptions pointing at
 *     the persistent profile dir (~/.slop-lord/chrome-profile).
 *   - headless: false — the window is always visible.
 *   - Because the profile dir is the same one used by launch-chrome.sh,
 *     Chrome will restore the existing session (TikTok cookies included).
 *   - waitForBrowser() runs BEFORE init() to confirm the human has already
 *     logged in. If not, we print guidance and block.
 *
 * NOTE: If Chrome was launched via launch-chrome.sh AND Stagehand tries to
 * open the same profile, Chrome will open a new window (profiles can't be
 * shared across processes). The intended flow is:
 *   a) Close the launch-chrome.sh window, OR
 *   b) Run npm run test:login directly (skipping launch-chrome.sh) —
 *      Stagehand opens the window, human logs in, agent takes over.
 *
 * The test-login script handles case (b): it checks if Chrome is already
 * running; if not, Stagehand opens it.
 */
async function getStagehand(): Promise<Stagehand> {
  if (_stagehand) return _stagehand;

  const { detectChromePath } = await import("./chrome-detect.js");
  const chromePath = await detectChromePath();
  const modelName =
    (process.env.STAGEHAND_MODEL as "gpt-4o-mini" | "gpt-4o") ?? "gpt-4o-mini";

  const sh = new Stagehand({
    env: "LOCAL",
    modelName,
    modelClientOptions: {
      apiKey: process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
    },
    logger: (msg) => {
      if ((msg.level ?? 0) >= 2 || msg.category === "error") {
        console.log(`[stagehand] ${msg.message}`);
      }
    },
    localBrowserLaunchOptions: {
      executablePath: chromePath,
      userDataDir: config.browser.profileDir,
      headless: false,
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate",
      ],
    },
  });

  await sh.init();
  _stagehand = sh;

  // Navigate to TikTok and wait for authenticated state
  await sh.page.goto("https://www.tiktok.com", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  // Block until TikTok session is confirmed (human may need to log in)
  await waitForBrowser();

  console.log(`[stagehand] Session ready — ${sh.page.url()}`);
  return _stagehand;
}

// Separate interface for the playwright-only attach path (used by browser.ts / WebAccessor)
interface Session {
  browser: Browser;
  stagehand: Stagehand;
}

let _cdpSession: Session | null = null;

/**
 * Attaches to an ALREADY-RUNNING Chrome via CDP and wires Stagehand to it.
 * Used when launch-chrome.sh has been run and the human is already logged in.
 * Preferred over getStagehand() when Chrome is already on port 9222.
 */
async function getSessionViaCdp(): Promise<Session> {
  if (_cdpSession) {
    try {
      _cdpSession.browser.contexts();
      return _cdpSession;
    } catch {
      console.warn("[stagehand] CDP session dropped. Reconnecting…");
      _cdpSession = null;
    }
  }

  await waitForBrowser();

  const cdpEndpoint = `http://${config.browser.cdpHost}:${config.browser.cdpPort}`;

  const browser = await withReconnect(
    () => chromium.connectOverCDP(cdpEndpoint),
    {
      maxAttempts: 5,
      onAttempt: (n, err) =>
        console.warn(`[stagehand] CDP connect attempt ${n} failed: ${(err as Error).message}`),
    }
  );

  const context = browser.contexts()[0];
  if (!context) throw new Error("[stagehand] No browser context. Is TikTok open?");

  const pages = context.pages();
  const pwPage = pages.find((p) => p.url().includes("tiktok.com")) ?? pages[0];
  if (!pwPage) throw new Error("[stagehand] No open page found in Chrome.");

  const modelName =
    (process.env.STAGEHAND_MODEL as "gpt-4o-mini" | "gpt-4o") ?? "gpt-4o-mini";

  const stagehand = new Stagehand({
    env: "LOCAL",
    modelName,
    modelClientOptions: {
      apiKey: process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
    },
    logger: (msg) => {
      if ((msg.level ?? 0) >= 2 || msg.category === "error") {
        console.log(`[stagehand] ${msg.message}`);
      }
    },
  });

  // Cast: Playwright Page → Stagehand's Page type (structurally compatible at runtime)
  await stagehand.initFromPage({ page: pwPage as unknown as Parameters<typeof stagehand.initFromPage>[0]["page"] });

  _cdpSession = { browser, stagehand };
  console.log(`[stagehand] Attached to live Chrome — ${pwPage.url()}`);
  return _cdpSession;
}

/**
 * Returns the appropriate session:
 * - If Chrome is already on the CDP port → attach via CDP (preserves login)
 * - Otherwise → launch Stagehand with persistent profile
 */
async function getSession(): Promise<{ stagehand: Stagehand }> {
  const { isChromeReachable } = await import("./browser.js");
  const alreadyRunning = await isChromeReachable();
  if (alreadyRunning) {
    return getSessionViaCdp();
  }
  return { stagehand: await getStagehand() };
}

export async function closeStagehand(): Promise<void> {
  _cdpSession = null;
  if (_stagehand) {
    try { await _stagehand.close(); } catch { /* ignore */ }
    _stagehand = null;
  }
}

// ---------------------------------------------------------------------------
// Navigation helper
// ---------------------------------------------------------------------------

async function navigateTo(sh: Stagehand, url: string): Promise<void> {
  await pauseGuard.check();
  const current = sh.page.url();
  if (current === url || current.startsWith(url)) return;

  await sh.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // Let TikTok's SPA hydrate
  await sh.page.waitForTimeout(2000);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrapes video metadata from the TikTok For You feed.
 */
export async function scrapeForYouFeed(
  scrollCount = 5
): Promise<VideoMetadata[]> {
  await pauseGuard.check();
  const { stagehand: sh } = await getSession();
  await navigateTo(sh, "https://www.tiktok.com/foryou");
  await dismissModalsInternal(sh);

  const allVideos: VideoMetadata[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < scrollCount; i++) {
    await pauseGuard.check();

    const result = await sh.page.extract({
      instruction:
        "Extract all visible TikTok video cards on this page. " +
        "For each video get: the full video URL, the description text, " +
        "the author username, like/comment/share/play counts as numbers (null if not visible), " +
        "all hashtags from the description (without #), " +
        "the sound/music name and sound ID if shown.",
      schema: VideoListSchema,
    });

    for (const v of result.videos) {
      if (v.url && !seen.has(v.url)) {
        seen.add(v.url);
        allVideos.push({ ...v, capturedAt: new Date().toISOString() });
      }
    }

    if (i < scrollCount - 1) {
      await pauseGuard.check();
      await sh.page.act({ action: "scroll down to reveal more videos" });
      await sh.page.waitForTimeout(1500);
    }
  }

  return allVideos;
}

/**
 * Scrapes video metadata from a specific TikTok hashtag page.
 */
export async function scrapeHashtagPage(
  hashtag: string,
  scrollCount = 3
): Promise<TrendPageResult> {
  await pauseGuard.check();
  const { stagehand: sh } = await getSession();
  const tag = hashtag.replace(/^#/, "");
  await navigateTo(sh, `https://www.tiktok.com/tag/${tag}`);
  await dismissModalsInternal(sh);

  const allVideos: VideoMetadata[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < scrollCount; i++) {
    await pauseGuard.check();

    const result = await sh.page.extract({
      instruction:
        `Extract all visible videos on the TikTok #${tag} hashtag page. ` +
        "For each video get: full URL, description, author username, " +
        "like/comment/share/play counts as numbers (null if not visible), " +
        "all hashtags (without #), sound name and sound ID.",
      schema: VideoListSchema,
    });

    for (const v of result.videos) {
      if (v.url && !seen.has(v.url)) {
        seen.add(v.url);
        allVideos.push({ ...v, capturedAt: new Date().toISOString() });
      }
    }

    if (i < scrollCount - 1) {
      await pauseGuard.check();
      await sh.page.act({ action: "scroll down to load more videos" });
      await sh.page.waitForTimeout(1500);
    }
  }

  return { videos: allVideos, hashtag: tag };
}

/**
 * Scrapes trending hashtags from the TikTok Discover page.
 */
export async function scrapeTrendingHashtags(): Promise<
  Array<{ tag: string; viewCount: number | null }>
> {
  await pauseGuard.check();
  const { stagehand: sh } = await getSession();
  await navigateTo(sh, "https://www.tiktok.com/discover");
  await dismissModalsInternal(sh);

  const result = await sh.page.extract({
    instruction:
      "Extract all trending hashtags shown on the TikTok Discover page. " +
      "For each hashtag get the tag name (without #) and the view count as a number (null if not shown).",
    schema: TrendingHashtagsSchema,
  });

  return result.hashtags;
}

/**
 * Dismisses common TikTok overlays.
 */
export async function dismissModals(): Promise<void> {
  await pauseGuard.check();
  const { stagehand: sh } = await getSession();
  await dismissModalsInternal(sh);
}

async function dismissModalsInternal(sh: Stagehand): Promise<void> {
  try {
    await sh.page.act({
      action:
        "If a cookie consent banner, notification permission dialog, or app download " +
        "prompt is visible, close or dismiss it. If nothing is blocking the page, do nothing.",
    });
  } catch {
    // Best-effort — don't fail the caller
  }
}

// Register cleanup handler
pauseGuard.onShutdown(closeStagehand);

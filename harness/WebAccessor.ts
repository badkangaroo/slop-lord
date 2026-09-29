/**
 * harness/WebAccessor.ts
 *
 * Unified interface for all web access in the scanner.
 *
 * The scanner only calls this module — it never calls Stagehand, Playwright,
 * SearXNG, or Firecrawl directly. This module decides which backend to use
 * and retries down the fallback chain on failure.
 *
 * BROWSER FALLBACK CHAIN (for browse/scrape)
 * -------------------------------------------
 *   1. Stagehand  — AI-driven, natural language instructions
 *   2. Playwright — hardcoded selectors, logs a warning when active
 *
 * SEARCH CHAIN
 * ------------
 *   1. SearXNG   — local meta-search (no auth, fast)
 *   2. Firecrawl — if SearXNG returns no results
 *
 * All methods call pauseGuard.check() before doing any work.
 */

import { config } from "../config/index.js";
import { pauseGuard } from "./pause-guard.js";
import type { VideoMetadata, TrendPageResult } from "./stagehand.js";

// Dynamically imported to avoid loading both adapters at startup
import * as Stagehand from "./stagehand.js";
import * as PlaywrightAdapter from "./playwright.js";

// ---------------------------------------------------------------------------
// Search types
// ---------------------------------------------------------------------------

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  source: "searxng" | "firecrawl";
}

export interface SearchOptions {
  engines?: string[];
  maxResults?: number;
}

// ---------------------------------------------------------------------------
// Scrape types
// ---------------------------------------------------------------------------

export interface ScrapeResult {
  url: string;
  markdown: string;
  title: string | null;
  source: "firecrawl";
}

export interface ScrapeOptions {
  waitForSelector?: string;
}

// ---------------------------------------------------------------------------
// SearXNG search
// ---------------------------------------------------------------------------

async function searchViaSearxng(
  query: string,
  opts: SearchOptions = {}
): Promise<SearchResult[]> {
  const url = new URL(`${config.searxng.url}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  if (opts.engines?.length) {
    url.searchParams.set("engines", opts.engines.join(","));
  }

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(config.searxng.timeoutMs),
  });

  if (!res.ok) throw new Error(`SearXNG returned ${res.status}`);

  const data = await res.json() as {
    results?: Array<{ url: string; title: string; content: string }>;
  };

  return (data.results ?? [])
    .slice(0, opts.maxResults ?? 20)
    .map((r) => ({
      url: r.url,
      title: r.title,
      snippet: r.content,
      source: "searxng" as const,
    }));
}

// ---------------------------------------------------------------------------
// Firecrawl search + scrape
// ---------------------------------------------------------------------------

async function searchViaFirecrawl(
  query: string,
  opts: SearchOptions = {}
): Promise<SearchResult[]> {
  const res = await fetch(`${config.firecrawl.url}/v1/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.firecrawl.apiKey}`,
    },
    body: JSON.stringify({ query, limit: opts.maxResults ?? 10 }),
    signal: AbortSignal.timeout(config.firecrawl.timeoutMs),
  });

  if (!res.ok) throw new Error(`Firecrawl search returned ${res.status}`);

  const data = await res.json() as {
    data?: Array<{ url: string; title: string; description: string }>;
  };

  return (data.data ?? []).map((r) => ({
    url: r.url,
    title: r.title,
    snippet: r.description,
    source: "firecrawl" as const,
  }));
}

async function scrapeViaFirecrawl(
  url: string,
  opts: ScrapeOptions = {}
): Promise<ScrapeResult> {
  const body: Record<string, unknown> = {
    url,
    formats: ["markdown"],
  };
  if (opts.waitForSelector) {
    body.waitFor = opts.waitForSelector;
  }

  const res = await fetch(`${config.firecrawl.url}/v1/scrape`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.firecrawl.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.firecrawl.timeoutMs),
  });

  if (!res.ok) throw new Error(`Firecrawl scrape returned ${res.status}`);

  const data = await res.json() as {
    data?: { markdown?: string; metadata?: { title?: string } };
  };

  return {
    url,
    markdown: data.data?.markdown ?? "",
    title: data.data?.metadata?.title ?? null,
    source: "firecrawl",
  };
}

// ---------------------------------------------------------------------------
// Browser operation fallback wrapper
// ---------------------------------------------------------------------------

type BrowserOp<T> = () => Promise<T>;

/**
 * Tries the Stagehand adapter first; falls back to Playwright on any error.
 * Playwright activation is always logged as a warning.
 */
async function withBrowserFallback<T>(
  stagehandOp: BrowserOp<T>,
  playwrightOp: BrowserOp<T>
): Promise<T> {
  try {
    return await stagehandOp();
  } catch (err) {
    console.warn(
      "[WebAccessor] Stagehand failed, falling back to Playwright:",
      (err as Error).message
    );
    return playwrightOp();
  }
}

// ---------------------------------------------------------------------------
// Public WebAccessor API
// ---------------------------------------------------------------------------

export const WebAccessor = {
  /**
   * Search for trending topics, hashtags, or TikTok content.
   * Tries SearXNG first; falls back to Firecrawl if no results.
   */
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    await pauseGuard.check();

    let results: SearchResult[] = [];

    try {
      results = await searchViaSearxng(query, opts);
    } catch (err) {
      console.warn(
        "[WebAccessor] SearXNG failed, trying Firecrawl:",
        (err as Error).message
      );
    }

    if (results.length === 0) {
      results = await searchViaFirecrawl(query, opts);
    }

    return results;
  },

  /**
   * Scrape a static page into clean markdown.
   * Uses Firecrawl (which has its own Playwright renderer for JS pages).
   */
  async scrape(url: string, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
    await pauseGuard.check();
    return scrapeViaFirecrawl(url, opts);
  },

  /**
   * Navigate and interact with TikTok using the live authenticated browser.
   * Stagehand (AI-driven) is tried first; Playwright fallback is automatic.
   */
  async browseForYouFeed(scrollCount = 5): Promise<VideoMetadata[]> {
    await pauseGuard.check();
    return withBrowserFallback(
      () => Stagehand.scrapeForYouFeed(scrollCount),
      () => PlaywrightAdapter.scrapeForYouFeed(scrollCount)
    );
  },

  async browseHashtag(hashtag: string, scrollCount = 3): Promise<TrendPageResult> {
    await pauseGuard.check();
    return withBrowserFallback(
      () => Stagehand.scrapeHashtagPage(hashtag, scrollCount),
      () => PlaywrightAdapter.scrapeHashtagPage(hashtag, scrollCount)
    );
  },

  async browseTrendingHashtags(): Promise<Array<{ tag: string; viewCount: number | null }>> {
    await pauseGuard.check();
    return withBrowserFallback(
      () => Stagehand.scrapeTrendingHashtags(),
      () => PlaywrightAdapter.scrapeTrendingHashtags()
    );
  },

  async dismissModals(): Promise<void> {
    await pauseGuard.check();
    return withBrowserFallback(
      () => Stagehand.dismissModals(),
      () => PlaywrightAdapter.dismissModals()
    );
  },
};

export type { VideoMetadata, TrendPageResult };

/**
 * harness/search-scraper.ts
 *
 * Navigates to TikTok search results for a given query, scrapes the visible
 * video cards, and returns them sorted by view count descending.
 *
 * SELECTORS (confirmed from live DOM, 2026-09-29)
 * ────────────────────────────────────────────────
 *   Card root : [class*="DivContainer"] that contains a[href*="/video/"]
 *   Views     : [data-e2e="video-views"]    e.g. "144.9K"
 *   Video URL : a[href*="/video/"]          full tiktok.com URL
 *   Author    : extracted from video URL    /@username/video/...
 *
 * Note: TikTok search does not expose like/share counts in the grid view.
 * Full stats are available by calling analyzeVideo() on the picked URL.
 *
 * USAGE
 * ─────
 *   const results = await searchTikTok("dance", { maxCards: 20 });
 *   // results[0] is the highest-view video in the search grid
 */

import { chromium, type Browser, type Page } from "playwright";
import { config } from "../config/index.js";
import { waitForBrowser } from "./browser.js";
import { pauseGuard } from "./pause-guard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  videoUrl: string;
  author: string;
  views: number;      // parsed from "144.9K" → 144900
  viewsRaw: string;   // original string from DOM
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTikTokCount(text: string | null | undefined): number {
  if (!text) return 0;
  const t = text.trim().toUpperCase();
  const match = t.match(/^([\d.]+)([KMB]?)$/);
  if (!match) return 0;
  const n = parseFloat(match[1]);
  const mult: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };
  return Math.round(n * (mult[match[2]] ?? 1));
}

// ---------------------------------------------------------------------------
// Browser singleton (separate from video-analyzer to avoid interference)
// ---------------------------------------------------------------------------

let _browser: Browser | null = null;
let _page: Page | null = null;

async function getPage(): Promise<Page> {
  // Re-use the open tab if it's still a search page; otherwise open a new tab.
  // We never reuse the FYF or video-detail tabs — those belong to video-analyzer.
  if (_page && !_page.isClosed() && _page.url().includes("tiktok.com/search")) {
    return _page;
  }

  await waitForBrowser();

  if (!_browser) {
    _browser = await chromium.connectOverCDP(
      `http://${config.browser.cdpHost}:${config.browser.cdpPort}`
    );
  }

  const ctx = _browser.contexts()[0];
  // Always open a fresh tab for search so we never clobber the feed/video tab
  _page = await ctx.newPage();
  return _page;
}

export async function closeSearchScraper(): Promise<void> {
  if (_page && !_page.isClosed()) {
    await _page.close().catch(() => {});
  }
  _browser = null;
  _page = null;
}

// ---------------------------------------------------------------------------
// Card extractor
// ---------------------------------------------------------------------------

async function extractCards(page: Page): Promise<Array<{ videoUrl: string; author: string; viewsRaw: string }>> {
  return page.evaluate(`(() => {
    const cards = [...document.querySelectorAll('[class*="DivContainer"]')]
      .filter(c => c.querySelector('a[href*="/video/"]'));

    return cards.map(card => {
      const link   = card.querySelector('a[href*="/video/"]');
      const href   = link?.href ?? '';
      const author = href.match(/@([^/]+)\\/video/)?.[1] ?? '';
      const viewEl = card.querySelector('[data-e2e="video-views"]');
      const viewsRaw = viewEl?.textContent?.trim() ?? '0';
      return { videoUrl: href, author, viewsRaw };
    }).filter(r => r.videoUrl && r.author);
  })()`) as Promise<Array<{ videoUrl: string; author: string; viewsRaw: string }>>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /**
   * Maximum number of cards to collect before picking.
   * More cards = more scrolling = better coverage but slower.
   * Default: 20
   */
  maxCards?: number;
  /**
   * How many times to scroll down to load more results.
   * Each scroll loads ~8–10 new cards.
   * Default: 3
   */
  scrollPasses?: number;
}

/**
 * Searches TikTok for `query`, scrapes the result grid, and returns cards
 * sorted by view count descending.
 *
 * @param query       Search term e.g. "dance", "cooking fail", "cat"
 * @param opts
 */
export async function searchTikTok(
  query: string,
  opts: SearchOptions = {}
): Promise<SearchResult[]> {
  const maxCards    = opts.maxCards    ?? 20;
  const scrollPasses = opts.scrollPasses ?? 3;

  await pauseGuard.check();
  const page = await getPage();

  const url = `https://www.tiktok.com/search/video?q=${encodeURIComponent(query)}`;
  console.log(`[search-scraper] Navigating to: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2500);

  const seen = new Set<string>();
  const all: SearchResult[] = [];

  const collect = async () => {
    const cards = await extractCards(page);
    for (const c of cards) {
      if (!seen.has(c.videoUrl)) {
        seen.add(c.videoUrl);
        all.push({
          videoUrl: c.videoUrl,
          author:   c.author,
          views:    parseTikTokCount(c.viewsRaw),
          viewsRaw: c.viewsRaw,
        });
      }
    }
  };

  // Initial collection
  await collect();
  console.log(`[search-scraper] Pass 0: ${all.length} cards`);

  // Scroll down to load more
  for (let i = 0; i < scrollPasses && all.length < maxCards; i++) {
    await pauseGuard.check();
    await page.evaluate(`window.scrollBy({ top: window.innerHeight * 3, behavior: 'smooth' })`);
    await page.waitForTimeout(1800);
    const before = all.length;
    await collect();
    console.log(`[search-scraper] Pass ${i + 1}: +${all.length - before} new → ${all.length} total`);
  }

  // Sort by views descending
  all.sort((a, b) => b.views - a.views);

  console.log(`[search-scraper] Top results for "${query}":`);
  all.slice(0, 5).forEach((r, i) =>
    console.log(`  [${i + 1}] @${r.author.padEnd(25)} ${r.viewsRaw.padStart(8)} views  ${r.videoUrl}`)
  );

  return all;
}

pauseGuard.onShutdown(closeSearchScraper);

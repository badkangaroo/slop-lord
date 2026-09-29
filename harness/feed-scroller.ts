/**
 * harness/feed-scroller.ts
 *
 * Direct Playwright-CDP feed traversal for the TikTok For You feed.
 *
 * SCROLL MECHANISM
 * ----------------
 * The TikTok FYF is a vertical snap-scroll container (DivColumnListContainer).
 * Each card is exactly clientHeight tall. We scroll by clientHeight per swipe.
 * The current card index is computed from scrollTop / clientHeight on every
 * iteration — we never maintain a local counter that can drift out of sync.
 *
 * STALL PREVENTION
 * ----------------
 * Common stall causes and how we handle them:
 *   1. Dialog/overlay open  → dismissed before each scroll attempt
 *   2. No new cards loading → hard timeout + retry with keyboard fallback
 *   3. scrollBy returns 0   → detected via scrollTop delta check after wait
 *   4. Infinite empty cards → skip blank cards (no author) rather than stalling
 *
 * EXTRACTED DATA (all from confirmed live data-e2e selectors)
 * -----------------------------------------------------------
 *   author      : href="/@username" on video-author-avatar link
 *   description : data-e2e="video-desc"
 *   hashtags    : data-e2e="search-common-link"
 *   likes       : data-e2e="like-count"
 *   comments    : data-e2e="comment-count"
 *   favorites   : data-e2e="favorite-count"
 *   shares      : data-e2e="share-count"
 *   sound       : data-e2e="video-music"
 *   videoUrl    : a[href*="/video/"]
 */

import { chromium, type Browser, type Page } from "playwright";
import { config } from "../config/index.js";
import { waitForBrowser } from "./browser.js";
import { pauseGuard } from "./pause-guard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeedVideo {
  author: string;
  authorUrl: string;
  description: string;
  hashtags: string[];
  soundName: string | null;
  soundUrl: string | null;
  videoUrl: string | null;
  likes: number | null;
  comments: number | null;
  favorites: number | null;
  shares: number | null;
  capturedAt: string;
}

export interface SwipeResult {
  video: FeedVideo;
  index: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Number parsing  ("1.6M" → 1600000, "7021" → 7021, "56.3K" → 56300)
// ---------------------------------------------------------------------------

function parseTikTokCount(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.trim().toUpperCase();
  const match = t.match(/^([\d.]+)([KMB]?)$/);
  if (!match) return null;
  const n = parseFloat(match[1]);
  const mult: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };
  return Math.round(n * (mult[match[2]] ?? 1));
}

// ---------------------------------------------------------------------------
// DOM helpers — all page.evaluate payloads passed as strings to avoid
// tsx/esbuild injecting __name helpers that break in the browser sandbox
// ---------------------------------------------------------------------------

interface RawCard {
  author: string;
  authorUrl: string;
  description: string;
  hashtags: string[];
  soundName: string | null;
  soundUrl: string | null;
  videoUrl: string | null;
  likes: string | null;
  comments: string | null;
  favorites: string | null;
  shares: string | null;
}

interface FeedState {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  /** Index of the card currently at the top of the viewport */
  currentCardIndex: number;
  itemCount: number;
}

/** Returns current scroll state of the feed container. */
async function getFeedState(page: Page): Promise<FeedState> {
  return page.evaluate(
    new Function(`return () => {
      const c = document.querySelector('[class*="DivColumnListContainer"]');
      if (!c) return { scrollTop:0, clientHeight:789, scrollHeight:789, currentCardIndex:0, itemCount:0 };
      const items = document.querySelectorAll('[data-e2e="recommend-list-item-container"]');
      const clientHeight = c.clientHeight || 789;
      return {
        scrollTop: c.scrollTop,
        clientHeight,
        scrollHeight: c.scrollHeight,
        currentCardIndex: Math.round(c.scrollTop / clientHeight),
        itemCount: items.length,
      };
    }`)()
  ) as Promise<FeedState>;
}

/** Extracts a single card's data by its DOM index. */
async function extractCard(page: Page, index: number): Promise<RawCard | null> {
  // Embed the index directly in the script string to avoid Playwright's typed
  // overload restrictions on Function objects with arguments
  const script = `
    (() => {
      const items = document.querySelectorAll('[data-e2e="recommend-list-item-container"]');
      const item = items[${index}];
      if (!item) return null;
      const avatarLink = item.querySelector('[data-e2e="video-author-avatar"]');
      const authorUrl = avatarLink ? avatarLink.href : '';
      const author = (authorUrl.match(/@([^/?]+)/) || [])[1] || '';
      const descEl = item.querySelector('[data-e2e="video-desc"]');
      const description = descEl ? descEl.textContent.trim() : '';
      const hashtagEls = Array.from(item.querySelectorAll('[data-e2e="search-common-link"]'));
      const hashtags = hashtagEls.map(a => a.textContent.replace(/^#/,'').trim()).filter(Boolean);
      const soundEl = item.querySelector('[data-e2e="video-music"]');
      const soundName = soundEl ? soundEl.textContent.trim() : null;
      const soundUrl  = soundEl ? soundEl.href || null : null;
      const videoLinkEl = item.querySelector('a[href*="/video/"]');
      const videoUrl = videoLinkEl ? videoLinkEl.href : null;
      const txt = (e2e) => { const el = item.querySelector('[data-e2e="'+e2e+'"]'); return el ? el.textContent.trim() : null; };
      return { author, authorUrl, description, hashtags, soundName, soundUrl: soundUrl||null, videoUrl: videoUrl||null,
               likes: txt('like-count'), comments: txt('comment-count'), favorites: txt('favorite-count'), shares: txt('share-count') };
    })()
  `;
  return page.evaluate(script) as Promise<RawCard | null>;
}

/** Dismisses any open dialog/overlay (notification panel, cookie banner, etc). */
async function dismissOverlays(page: Page): Promise<void> {
  await page.evaluate(
    new Function(`return () => {
      // Close notification panel via Escape key simulation
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs.length === 0) return;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      // Also try clicking a close button inside dialogs
      const closeBtn = document.querySelector('[role="dialog"] button[aria-label="Close"], [role="dialog"] [data-e2e*="close"]');
      if (closeBtn) closeBtn.click();
    }`)()
  );
  // Also try Playwright's keyboard Escape
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

/**
 * Scrolls the feed container down by exactly one card height.
 * Returns the new scrollTop after settling, or null if container not found.
 */
async function scrollOneCard(page: Page, clientHeight: number): Promise<number | null> {
  const script = `
    (() => {
      const c = document.querySelector('[class*="DivColumnListContainer"]');
      if (!c) return null;
      c.scrollBy({ top: ${clientHeight}, behavior: 'smooth' });
      return c.scrollTop;
    })()
  `;
  return page.evaluate(script) as Promise<number | null>;
}

// ---------------------------------------------------------------------------
// Browser singleton
// ---------------------------------------------------------------------------

let _browser: Browser | null = null;
let _page: Page | null = null;

async function getPage(): Promise<Page> {
  if (_page && !_page.isClosed()) return _page;

  await waitForBrowser();

  _browser = await chromium.connectOverCDP(
    `http://${config.browser.cdpHost}:${config.browser.cdpPort}`
  );
  const ctx = _browser.contexts()[0];
  const pages = ctx.pages();
  _page = pages.find((p) => p.url().includes("tiktok.com")) ?? pages[0] ?? null;
  if (!_page) throw new Error("[feed-scroller] No open page in Chrome.");
  return _page;
}

export async function closeFeedScroller(): Promise<void> {
  if (_browser) {
    try { await _browser.close(); } catch { /* ignore */ }
  }
  _page = null;
  _browser = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ScrollFeedOptions {
  count?: number;
  dwellMs?: number;
  onVideo?: (result: SwipeResult) => void | Promise<void>;
}

export async function scrollFeed(opts: ScrollFeedOptions = {}): Promise<FeedVideo[]> {
  const count = opts.count ?? 20;
  const dwellMs = opts.dwellMs ?? 1200;

  await pauseGuard.check();
  const page = await getPage();

  // Navigate to FYF if not already there
  if (!page.url().includes("tiktok.com/foryou")) {
    console.log("[feed-scroller] Navigating to For You feed…");
    await page.goto("https://www.tiktok.com/foryou", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForTimeout(2500);
  }

  // Dismiss any open overlays before starting
  await dismissOverlays(page);

  const captured: FeedVideo[] = [];
  const seenKeys = new Set<string>();
  let stallCount = 0;
  const MAX_STALLS = 5; // give up after 5 consecutive empty scrolls
  let lastScrollTop = -1;

  console.log(`[feed-scroller] Starting — collecting ${count} videos`);

  while (captured.length < count && stallCount < MAX_STALLS) {
    await pauseGuard.check();

    // Get current state from DOM (source of truth — no local counter)
    const state = await getFeedState(page);

    // Dismiss any overlay that may have appeared
    if (state.itemCount === 0) {
      await dismissOverlays(page);
      await page.waitForTimeout(500);
      stallCount++;
      continue;
    }

    // Extract the card currently at the top of the viewport
    const raw = await extractCard(page, state.currentCardIndex);

    if (raw && raw.author) {
      const key = raw.videoUrl ?? `${raw.author}::${raw.description.slice(0, 50)}`;

      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        stallCount = 0; // reset stall counter on new content

        const video: FeedVideo = {
          author: raw.author,
          authorUrl: raw.authorUrl,
          description: raw.description,
          hashtags: raw.hashtags,
          soundName: raw.soundName,
          soundUrl: raw.soundUrl,
          videoUrl: raw.videoUrl,
          likes: parseTikTokCount(raw.likes),
          comments: parseTikTokCount(raw.comments),
          favorites: parseTikTokCount(raw.favorites),
          shares: parseTikTokCount(raw.shares),
          capturedAt: new Date().toISOString(),
        };

        const likeStr =
          video.likes != null
            ? `${(video.likes / 1000).toFixed(1)}K likes`.padEnd(14)
            : "? likes".padEnd(14);
        const tagStr = video.hashtags.slice(0, 3).map((t) => `#${t}`).join(" ");
        console.log(
          `  [${(captured.length + 1).toString().padStart(3)}] @${video.author.padEnd(22)} ${likeStr} ${tagStr}`
        );

        const result: SwipeResult = {
          video,
          index: captured.length,
          hasMore: captured.length + 1 < count,
        };
        if (opts.onVideo) await opts.onVideo(result);
        captured.push(video);

        if (captured.length >= count) break;
      } else {
        // Already seen this card — we need to scroll
      }
    } else {
      // Empty/unloaded card — wait briefly for it to populate
      await page.waitForTimeout(400);
      const raw2 = await extractCard(page, state.currentCardIndex);
      if (!raw2 || !raw2.author) {
        stallCount++;
        console.log(`[feed-scroller] Empty card at index ${state.currentCardIndex} (stall ${stallCount}/${MAX_STALLS})`);
      }
    }

    // Dwell on current video
    await page.waitForTimeout(dwellMs);
    await pauseGuard.check();

    // Check for overlays before scrolling
    await dismissOverlays(page);

    // Scroll one card
    const prevScrollTop = state.scrollTop;
    await scrollOneCard(page, state.clientHeight);

    // Wait for scroll animation to settle
    await page.waitForTimeout(700);

    const newState = await getFeedState(page);

    // Scrolling didn't move — try keyboard ArrowDown as fallback
    if (newState.scrollTop === prevScrollTop) {
      console.log("[feed-scroller] scrollBy had no effect — trying ArrowDown…");
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(500);
      const afterKb = await getFeedState(page);
      if (afterKb.scrollTop === prevScrollTop) {
        stallCount++;
        console.log(`[feed-scroller] Stuck (stall ${stallCount}/${MAX_STALLS})`);
      }
    } else {
      lastScrollTop = newState.scrollTop;
    }

    // Proactively trigger TikTok lazy-load: if we're within 5 cards of the
    // buffer end, instantly scroll to the bottom and back. This puts the last
    // card into the viewport so TikTok's scroll-event listener fires a fetch,
    // then we snap back to where we were.
    if (newState.currentCardIndex >= newState.itemCount - 5) {
      const prevItemCount = newState.itemCount;
      console.log(`[feed-scroller] Triggering lazy-load (at card ${newState.currentCardIndex}/${newState.itemCount - 1})…`);

      // Jump to bottom → wait → jump back
      await page.evaluate(`(() => {
        const c = document.querySelector('[class*="DivColumnListContainer"]');
        if (c) c.scrollTop = c.scrollHeight;
      })()`);
      await page.waitForTimeout(1200);
      // Return to our actual position
      await page.evaluate(`(() => {
        const c = document.querySelector('[class*="DivColumnListContainer"]');
        if (c) c.scrollTop = ${newState.scrollTop + newState.clientHeight};
      })()`);
      await page.waitForTimeout(400);

      // Wait up to 6s for new cards to appear
      const loadDeadline = Date.now() + 6000;
      while (Date.now() < loadDeadline) {
        const s = await getFeedState(page);
        if (s.itemCount > prevItemCount) {
          console.log(`[feed-scroller] Loaded ${s.itemCount - prevItemCount} new cards.`);
          break;
        }
        await page.waitForTimeout(300);
      }

      // If still nothing after all that, reload the page
      const afterLoad = await getFeedState(page);
      if (afterLoad.itemCount === prevItemCount) {
        console.log("[feed-scroller] Feed frozen — reloading page…");
        await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
        await page.waitForTimeout(2500);
        await dismissOverlays(page);
        seenKeys.clear();
        console.log("[feed-scroller] Page reloaded — continuing from top of fresh feed.");
      }
    }
  }

  if (stallCount >= MAX_STALLS) {
    console.log(`[feed-scroller] Stopped after ${MAX_STALLS} consecutive stalls.`);
  }

  console.log(`[feed-scroller] Done — captured ${captured.length} videos`);
  return captured;
}

pauseGuard.onShutdown(closeFeedScroller);

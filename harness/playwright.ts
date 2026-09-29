/**
 * harness/playwright.ts
 *
 * Playwright fallback adapter — hardcoded selectors for TikTok.
 *
 * This layer is intentionally brittle. It activates ONLY when Stagehand
 * is unavailable or throws. A warning is logged every time it is used
 * because activation means the upper layers need attention.
 *
 * Like Stagehand, this adapter connects to the ALREADY-RUNNING visible
 * Chrome via CDP — it never launches a headless browser.
 */

import { chromium, type Browser, type Page } from "playwright";
import { config } from "../config/index.js";
import { waitForBrowser, withReconnect } from "./browser.js";
import { pauseGuard } from "./pause-guard.js";
import type { VideoMetadata, TrendPageResult } from "./stagehand.js";

// ---------------------------------------------------------------------------
// Selectors — TikTok's class names change frequently.
// Update these when they break rather than making the selectors clever.
// ---------------------------------------------------------------------------

const SELECTORS = {
  videoCard: '[data-e2e="recommend-list-item-container"]',
  videoLink: 'a[href*="/video/"]',
  description: '[data-e2e="video-desc"]',
  authorLink: '[data-e2e="video-author-uniqueid"]',
  likeCount: '[data-e2e="like-count"]',
  commentCount: '[data-e2e="comment-count"]',
  shareCount: '[data-e2e="share-count"]',
  playCount: '[data-e2e="video-views"]',
  soundLink: 'a[href*="/music/"]',
  hashtagLink: 'a[href*="/tag/"]',
  // Modals / overlays
  cookieBannerAccept: '[id="accept-btn"], button:has-text("Accept all")',
  modalClose: '[data-e2e="modal-close-inner-button"], button[aria-label="Close"]',
} as const;

// ---------------------------------------------------------------------------
// Browser singleton
// ---------------------------------------------------------------------------

let _browser: Browser | null = null;
let _page: Page | null = null;

async function getPage(): Promise<Page> {
  if (_page && !_page.isClosed()) return _page;

  await waitForBrowser();

  _browser = await withReconnect(
    () =>
      chromium.connectOverCDP(
        `http://${config.browser.cdpHost}:${config.browser.cdpPort}`
      ),
    {
      maxAttempts: 5,
      onAttempt: (attempt, err) => {
        console.warn(
          `[playwright-fallback] CDP connect attempt ${attempt} failed:`,
          (err as Error).message
        );
      },
    }
  );

  // Use first existing context (the human's session)
  const context =
    _browser.contexts()[0] ?? (await _browser.newContext());
  const pages = context.pages();
  _page = pages[0] ?? (await context.newPage());

  return _page;
}

export async function closePlaywright(): Promise<void> {
  // Don't close the browser — it belongs to the human.
  // Just drop our references.
  _page = null;
  _browser = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function warnFallbackActive(): void {
  console.warn(
    "[playwright-fallback] ⚠  Playwright fallback is active. " +
      "This means Stagehand failed. Check the Stagehand logs above."
  );
}

async function parseNumber(text: string | null | undefined): Promise<number | null> {
  if (!text) return null;
  const cleaned = text.replace(/[^\d.KMB]/gi, "");
  const multipliers: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };
  const match = cleaned.match(/^([\d.]+)([KMB]?)$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const multiplier = multipliers[match[2].toUpperCase()] ?? 1;
  return Math.round(value * multiplier);
}

async function extractVideoCards(page: Page): Promise<VideoMetadata[]> {
  const cards = page.locator(SELECTORS.videoCard);
  const count = await cards.count();
  const videos: VideoMetadata[] = [];

  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);

    const url =
      (await card.locator(SELECTORS.videoLink).first().getAttribute("href")) ??
      "";
    const description =
      (await card.locator(SELECTORS.description).first().textContent()) ?? "";

    const author =
      (await card
        .locator(SELECTORS.authorLink)
        .first()
        .textContent()) ?? "";

    const likesText = await card
      .locator(SELECTORS.likeCount)
      .first()
      .textContent()
      .catch(() => null);
    const commentsText = await card
      .locator(SELECTORS.commentCount)
      .first()
      .textContent()
      .catch(() => null);
    const sharesText = await card
      .locator(SELECTORS.shareCount)
      .first()
      .textContent()
      .catch(() => null);
    const playsText = await card
      .locator(SELECTORS.playCount)
      .first()
      .textContent()
      .catch(() => null);

    const soundHref = await card
      .locator(SELECTORS.soundLink)
      .first()
      .getAttribute("href")
      .catch(() => null);
    const soundName = await card
      .locator(SELECTORS.soundLink)
      .first()
      .textContent()
      .catch(() => null);

    // Extract sound ID from URL like /music/song-name-1234567890
    const soundId = soundHref?.match(/(\d{10,})$/)?.[1] ?? null;

    const hashtagEls = card.locator(SELECTORS.hashtagLink);
    const hashtagCount = await hashtagEls.count();
    const hashtags: string[] = [];
    for (let j = 0; j < hashtagCount; j++) {
      const tag = await hashtagEls.nth(j).textContent();
      if (tag) hashtags.push(tag.replace(/^#/, ""));
    }

    if (!url) continue;

    videos.push({
      url: url.startsWith("http") ? url : `https://www.tiktok.com${url}`,
      description,
      author,
      likes: await parseNumber(likesText),
      comments: await parseNumber(commentsText),
      shares: await parseNumber(sharesText),
      plays: await parseNumber(playsText),
      hashtags,
      soundName: soundName?.trim() ?? null,
      soundId,
      capturedAt: new Date().toISOString(),
    });
  }

  return videos;
}

// ---------------------------------------------------------------------------
// Public API — mirrors the stagehand adapter surface
// ---------------------------------------------------------------------------

export async function scrapeForYouFeed(
  scrollCount = 5
): Promise<VideoMetadata[]> {
  warnFallbackActive();
  await pauseGuard.check();

  const page = await getPage();
  await page.goto("https://www.tiktok.com/foryou", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(2000);

  // Dismiss any overlays
  await page.locator(SELECTORS.cookieBannerAccept).click().catch(() => {});
  await page.locator(SELECTORS.modalClose).click().catch(() => {});

  const allVideos: VideoMetadata[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < scrollCount; i++) {
    await pauseGuard.check();

    const batch = await extractVideoCards(page);
    for (const v of batch) {
      if (!seen.has(v.url)) {
        seen.add(v.url);
        allVideos.push(v);
      }
    }

    if (i < scrollCount - 1) {
      await pauseGuard.check();
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(1500);
    }
  }

  return allVideos;
}

export async function scrapeHashtagPage(
  hashtag: string,
  scrollCount = 3
): Promise<TrendPageResult> {
  warnFallbackActive();
  await pauseGuard.check();

  const page = await getPage();
  const tag = hashtag.replace(/^#/, "");

  await page.goto(`https://www.tiktok.com/tag/${tag}`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(2000);

  await page.locator(SELECTORS.cookieBannerAccept).click().catch(() => {});
  await page.locator(SELECTORS.modalClose).click().catch(() => {});

  const allVideos: VideoMetadata[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < scrollCount; i++) {
    await pauseGuard.check();

    const batch = await extractVideoCards(page);
    for (const v of batch) {
      if (!seen.has(v.url)) {
        seen.add(v.url);
        allVideos.push(v);
      }
    }

    if (i < scrollCount - 1) {
      await pauseGuard.check();
      await page.mouse.wheel(0, 1500);
      await page.waitForTimeout(1500);
    }
  }

  return { videos: allVideos, hashtag: tag };
}

export async function scrapeTrendingHashtags(): Promise<
  Array<{ tag: string; viewCount: number | null }>
> {
  warnFallbackActive();
  await pauseGuard.check();

  const page = await getPage();
  await page.goto("https://www.tiktok.com/discover", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(2000);

  // Best-effort extraction from the discover page grid
  const items = await page
    .locator('[data-e2e="search-tag-item"], a[href*="/tag/"]')
    .all();

  const results: Array<{ tag: string; viewCount: number | null }> = [];

  for (const item of items) {
    const text = (await item.textContent()) ?? "";
    const href = (await item.getAttribute("href")) ?? "";
    const tagMatch = href.match(/\/tag\/([^/?]+)/);
    if (!tagMatch) continue;

    const viewMatch = text.match(/([\d.]+[KMB]?\s*views?)/i);
    const viewCount = viewMatch
      ? await parseNumber(viewMatch[1])
      : null;

    results.push({ tag: tagMatch[1], viewCount });
  }

  return results;
}

export async function dismissModals(): Promise<void> {
  await pauseGuard.check();
  const page = await getPage();
  await page.locator(SELECTORS.cookieBannerAccept).click().catch(() => {});
  await page.locator(SELECTORS.modalClose).click().catch(() => {});
}

// Register cleanup
pauseGuard.onShutdown(closePlaywright);

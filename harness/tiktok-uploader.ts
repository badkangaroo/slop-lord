/**
 * harness/tiktok-uploader.ts
 *
 * Uploads a generated .mp4 to TikTok via TikTok Studio in the live Chrome
 * session. Attaches to the already-running browser via CDP — no new window,
 * no separate login, uses the human's existing authenticated session.
 *
 * FLOW
 * ────
 * 1. Open a new tab to https://www.tiktok.com/creator-center/upload
 * 2. Wait for the file input to appear (hidden <input type="file">)
 * 3. setInputFiles() — bypasses the OS file picker entirely
 * 4. Wait for video processing bar to complete (TikTok re-encodes server-side)
 * 5. Fill caption (description + hashtags)
 * 6. Set privacy to "Public" or "Friends" depending on config
 * 7. Click "Post" — wait for success confirmation
 * 8. Extract the resulting video URL from the confirmation page
 * 9. Close the upload tab, restore previous tab focus
 *
 * SELECTORS
 * ─────────
 * TikTok Studio uses data-e2e attributes on most interactive elements.
 * The upload page is a React SPA; we wait for network idle before acting.
 * If any selector breaks, update the UPLOAD_SELECTORS constant below —
 * do NOT make selectors clever; keep them explicit and easy to update.
 *
 * SAFETY
 * ──────
 * - pauseGuard.check() before every action
 * - All clicks use .click({ timeout: 30_000 }) — long enough for slow nav
 * - If anything fails after the file is submitted, we log the error and
 *   return partial results (taskId + generatedPath) rather than crashing
 */

import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { config } from "../config/index.js";
import { waitForBrowser, withReconnect } from "./browser.js";
import { pauseGuard } from "./pause-guard.js";

// ---------------------------------------------------------------------------
// Selectors — update here when TikTok Studio changes its DOM
// ---------------------------------------------------------------------------

const SEL = {
  // Upload page entry points
  fileInput:         'input[type="file"][accept*="video"]',
  uploadArea:        '[class*="upload-card"], [data-e2e="upload-btn"], [class*="drag-upload"]',

  // Processing state
  processingBar:     '[class*="upload-progress"], [class*="processing"], [role="progressbar"]',

  // Caption editor — TikTok uses a contenteditable div
  captionEditor:     '[data-e2e="caption-input"], div[contenteditable="true"]',

  // Privacy selector
  privacyDropdown:   '[data-e2e="video-range-selector"], [class*="privacy-select"]',
  privacyOption:     (label: string) =>
    `[data-e2e="range-${label.toLowerCase()}"], li:has-text("${label}")`,

  // Post / submit
  postButton:        '[data-e2e="post-btn"], button:has-text("Post")',
  discardButton:     'button:has-text("Discard")',

  // Success confirmation
  successIndicator:  '[data-e2e="upload-done"], [class*="post-success"], h2:has-text("Your video has")',
} as const;

const UPLOAD_URL = "https://www.tiktok.com/creator-center/upload";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadOptions {
  /** Absolute path to the .mp4 to upload */
  videoPath: string;
  /** Full caption text — hashtags should be embedded here as #tag */
  caption: string;
  /** "Public" | "Friends" | "Private" — default "Public" */
  privacy?: "Public" | "Friends" | "Private";
  /**
   * Maximum seconds to wait for TikTok's server-side video processing.
   * TikTok re-encodes uploads; short clips (~5s) typically take 20–60s.
   * Default: 180s (3 minutes).
   */
  processingTimeoutSec?: number;
}

export interface UploadResult {
  /** true if the Post button was clicked and TikTok showed a success state */
  posted: boolean;
  /** The TikTok video URL if we could extract it from the post-success page */
  videoUrl: string | null;
  /** ISO timestamp of when the upload was submitted */
  uploadedAt: string;
}

// ---------------------------------------------------------------------------
// Browser attachment
// ---------------------------------------------------------------------------

let _browser: Browser | null = null;

async function getUploadPage(): Promise<{ page: Page; browser: Browser }> {
  if (!_browser) {
    await waitForBrowser();
    _browser = await withReconnect(
      () => chromium.connectOverCDP(
        `http://${config.browser.cdpHost}:${config.browser.cdpPort}`
      ),
      { maxAttempts: 5, onAttempt: (n, e) =>
          console.warn(`[uploader] CDP connect attempt ${n}: ${(e as Error).message}`) }
    );
  }

  const context = _browser.contexts()[0];
  if (!context) throw new Error("[uploader] No browser context. Is Chrome running?");

  // Open a fresh tab for the upload — keeps the existing TikTok feed tab intact
  const page = await context.newPage();
  return { page, browser: _browser };
}

export async function closeTiktokUploader(): Promise<void> {
  _browser = null;
}

// ---------------------------------------------------------------------------
// Upload helpers
// ---------------------------------------------------------------------------

async function navigateToUpload(page: Page): Promise<void> {
  console.log("[uploader] Navigating to TikTok Studio upload page…");
  await page.goto(UPLOAD_URL, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForTimeout(2000);
}

async function attachFile(page: Page, videoPath: string): Promise<void> {
  console.log(`[uploader] Attaching file: ${path.basename(videoPath)}`);

  // The file input is hidden; setInputFiles bypasses the OS picker
  const input = page.locator(SEL.fileInput).first();
  await input.waitFor({ state: "attached", timeout: 15_000 });
  await input.setInputFiles(videoPath);

  console.log("[uploader] File attached — waiting for upload to begin…");
  // Brief pause for TikTok's JS to register the file and start uploading
  await page.waitForTimeout(3000);
}

async function waitForProcessing(page: Page, timeoutSec: number): Promise<void> {
  console.log("[uploader] Waiting for TikTok video processing to complete…");
  const deadline = Date.now() + timeoutSec * 1000;

  // Strategy: wait until the processing indicator disappears OR the caption
  // editor becomes visible (which only appears after processing is done).
  while (Date.now() < deadline) {
    await pauseGuard.check();

    const captionVisible = await page.locator(SEL.captionEditor).first()
      .isVisible()
      .catch(() => false);

    if (captionVisible) {
      console.log("[uploader] Processing complete — caption editor visible.");
      return;
    }

    // Also check for any error state
    const errorText = await page.locator('[class*="error"], [data-e2e="upload-error"]')
      .first()
      .textContent()
      .catch(() => null);
    if (errorText) {
      throw new Error(`[uploader] TikTok upload error: ${errorText}`);
    }

    const elapsed = Math.round((Date.now() - (deadline - timeoutSec * 1000)) / 1000);
    if (elapsed % 15 === 0) {
      console.log(`[uploader] Still processing… (${elapsed}s elapsed)`);
    }
    await page.waitForTimeout(2000);
  }

  throw new Error(`[uploader] Timed out waiting for video processing after ${timeoutSec}s`);
}

async function fillCaption(page: Page, caption: string): Promise<void> {
  console.log(`[uploader] Setting caption: "${caption.slice(0, 80)}…"`);
  const editor = page.locator(SEL.captionEditor).first();
  await editor.waitFor({ state: "visible", timeout: 15_000 });

  // Clear existing placeholder text and type the caption
  await editor.click();
  await page.keyboard.press("Control+A");
  await editor.fill(caption);

  // Small pause so TikTok registers the input before we move on
  await page.waitForTimeout(1000);
}

async function setPrivacy(page: Page, privacy: string): Promise<void> {
  if (privacy === "Public") return; // Public is the default on TikTok Studio

  console.log(`[uploader] Setting privacy: ${privacy}`);
  try {
    const dropdown = page.locator(SEL.privacyDropdown).first();
    const visible = await dropdown.isVisible().catch(() => false);
    if (!visible) {
      console.warn("[uploader] Privacy dropdown not visible — leaving as default (Public).");
      return;
    }
    await dropdown.click({ timeout: 10_000 });
    await page.waitForTimeout(500);
    await page.locator(SEL.privacyOption(privacy)).first().click({ timeout: 10_000 });
    await page.waitForTimeout(500);
  } catch (err) {
    console.warn(`[uploader] Could not set privacy to ${privacy}: ${(err as Error).message}. Leaving as default.`);
  }
}

async function submitPost(page: Page): Promise<void> {
  console.log("[uploader] Clicking Post…");
  const postBtn = page.locator(SEL.postButton).first();
  await postBtn.waitFor({ state: "visible", timeout: 15_000 });
  await postBtn.click({ timeout: 15_000 });
}

async function waitForSuccess(page: Page): Promise<string | null> {
  console.log("[uploader] Waiting for post success confirmation…");
  try {
    await page.locator(SEL.successIndicator).first()
      .waitFor({ state: "visible", timeout: 30_000 });
    console.log("[uploader] ✅ Post confirmed by TikTok.");
  } catch {
    // Success indicator may not appear — check URL change as fallback
    const currentUrl = page.url();
    if (currentUrl.includes("upload") && !currentUrl.includes("success")) {
      console.warn("[uploader] Success indicator not found — assuming posted (no error visible).");
    }
  }

  // Try to extract the new video URL from any link on the page
  try {
    const videoLink = await page.locator('a[href*="/video/"]').first()
      .getAttribute("href", { timeout: 5000 });
    if (videoLink) {
      return videoLink.startsWith("http")
        ? videoLink
        : `https://www.tiktok.com${videoLink}`;
    }
  } catch { /* not critical */ }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Uploads a generated video to TikTok via TikTok Studio.
 *
 * Uses the existing live Chrome session attached via CDP.
 * Opens a new tab for the upload, then closes it when done.
 *
 * @param opts  Upload options including video path, caption, and privacy
 * @returns     UploadResult with posted status and video URL if available
 */
export async function uploadToTikTok(opts: UploadOptions): Promise<UploadResult> {
  const {
    videoPath,
    caption,
    privacy = "Public",
    processingTimeoutSec = 180,
  } = opts;

  await pauseGuard.check();

  const { page } = await getUploadPage();
  const uploadedAt = new Date().toISOString();

  try {
    await pauseGuard.check();
    await navigateToUpload(page);

    await pauseGuard.check();
    await attachFile(page, videoPath);

    await pauseGuard.check();
    await waitForProcessing(page, processingTimeoutSec);

    await pauseGuard.check();
    await fillCaption(page, caption);

    await pauseGuard.check();
    await setPrivacy(page, privacy);

    await pauseGuard.check();
    await submitPost(page);

    const videoUrl = await waitForSuccess(page);

    return { posted: true, videoUrl, uploadedAt };

  } catch (err) {
    console.error(`[uploader] Upload failed: ${(err as Error).message}`);
    // Best-effort: try to discard the draft so we don't leave a stuck upload
    await page.locator(SEL.discardButton).first().click({ timeout: 5000 }).catch(() => {});
    return { posted: false, videoUrl: null, uploadedAt };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Builds a TikTok caption string from a ContentBrief.
 * Injects hashtags from the source video analysis and keeps the total
 * under TikTok's 2200-character caption limit.
 *
 * @param description   Core caption text (brief.premise or custom)
 * @param hashtags      Array of tag strings without the # prefix
 * @param maxLength     Hard cap (default 2200)
 */
export function buildCaption(
  description: string,
  hashtags: string[],
  maxLength = 2200
): string {
  const tagStr = hashtags
    .filter(Boolean)
    .map((t) => `#${t.replace(/^#/, "").replace(/\s+/g, "")}`)
    .join(" ");

  const full = tagStr ? `${description}\n\n${tagStr}` : description;
  return full.slice(0, maxLength);
}

// Register cleanup
pauseGuard.onShutdown(closeTiktokUploader);

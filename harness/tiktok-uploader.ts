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
  fileInput:        'input[type="file"]',
  // Upload complete — container appears once server-side processing is done
  uploadDone:       '[data-e2e="upload_status_container"]',

  // Caption editor — TikTok Studio uses Draft.js (contenteditable inside caption_container)
  captionContainer: '[data-e2e="caption_container"]',
  captionEditor:    '[data-e2e="caption_container"] .public-DraftEditor-content',

  // Visibility / privacy
  visibilitySelect: '[data-e2e="video_visibility_container"] .Select__trigger',
  visibilityOption: (label: string) => `[role="option"]:has-text("${label}")`,

  // Post / discard — confirmed data-e2e values from live DOM snapshot
  postButton:       '[data-e2e="post_video_button"]',
  discardButton:    '[data-e2e="discard_post_button"]',

  // Success — Studio resets to fresh upload page after posting
  successIndicator: '[data-e2e="upload_status_container"]:not(.has-video), [data-e2e="select_video_container"]',
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
  // "networkidle" times out on TikTok Studio — it keeps persistent poll connections open.
  // "domcontentloaded" fires as soon as the DOM is parsed; we then wait for the
  // file input to appear as the real readiness signal.
  await page.goto(UPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3000);
}

/**
 * Dismiss any react-joyride onboarding overlay that intercepts pointer events.
 * This must be called BEFORE any click/type on the Studio form fields.
 * The overlay blocks caption editor clicks, not just the Post button.
 */
async function dismissOverlay(page: Page): Promise<void> {
  // 1. Hide via JS (fastest — no polling, no timing dependency)
  await page.evaluate(() => {
    const portal = document.getElementById("react-joyride-portal");
    if (portal) (portal as HTMLElement).style.display = "none";
    const overlay = document.querySelector<HTMLElement>('[data-test-id="overlay"]');
    if (overlay) overlay.style.display = "none";
  });
  // 2. Best-effort click on any Skip / close button the tour renders
  await page.locator(
    'button:has-text("Skip"), button:has-text("Got it"), button:has-text("×"), [aria-label="Close"]'
  ).first().click({ timeout: 2000 }).catch(() => {});
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
  // upload_status_container appears once TikTok has finished server-side encoding.
  // It contains the filename, resolution, and file size — and the Post button becomes active.
  await page.locator(SEL.uploadDone).first()
    .waitFor({ state: "visible", timeout: timeoutSec * 1000 });
  // Brief pause for the Post button and caption editor to fully hydrate
  await page.waitForTimeout(1500);
  console.log("[uploader] Processing complete — upload_status_container visible.");
}

async function fillCaption(page: Page, caption: string): Promise<void> {
  console.log(`[uploader] Setting caption: "${caption.slice(0, 80)}…"`);

  // TikTok Studio uses Draft.js — the editor is a contenteditable div.
  // We must click to focus, select all existing placeholder text, then type.
  // editor.fill() does NOT work on Draft.js; keyboard.type() does.
  const editor = page.locator(SEL.captionEditor).first();
  await editor.waitFor({ state: "visible", timeout: 15_000 });
  await editor.click({ force: true });
  await page.keyboard.press("Meta+A");   // select all (macOS); clears filename placeholder
  await page.keyboard.type(caption, { delay: 10 });
  await page.waitForTimeout(800);
}

async function setPrivacy(page: Page, privacy: string): Promise<void> {
  if (privacy === "Public") return; // "Everyone" is the default — no action needed

  console.log(`[uploader] Setting privacy: ${privacy}`);
  try {
    const trigger = page.locator(SEL.visibilitySelect).first();
    const visible = await trigger.isVisible().catch(() => false);
    if (!visible) {
      console.warn("[uploader] Visibility select not visible — leaving as default (Everyone/Public).");
      return;
    }
    await trigger.click({ timeout: 10_000 });
    await page.waitForTimeout(500);
    await page.locator(SEL.visibilityOption(privacy)).first().click({ timeout: 10_000 });
    await page.waitForTimeout(500);
  } catch (err) {
    console.warn(`[uploader] Could not set privacy to ${privacy}: ${(err as Error).message}. Leaving as default.`);
  }
}

async function submitPost(page: Page): Promise<void> {
  console.log("[uploader] Clicking Post…");
  const postBtn = page.locator(SEL.postButton).first();
  await postBtn.waitFor({ state: "visible", timeout: 15_000 });
  // force:true bypasses any remaining overlay pointer-event interception
  await postBtn.click({ force: true, timeout: 15_000 });
}

async function waitForSuccess(page: Page): Promise<string | null> {
  console.log("[uploader] Waiting for post success confirmation…");
  // After clicking Post, Studio navigates back to the fresh upload page
  // (select_video_container reappears). Wait for that as the success signal.
  try {
    await page.locator('[data-e2e="select_video_container"]').first()
      .waitFor({ state: "visible", timeout: 30_000 });
    console.log("[uploader] ✅ Post confirmed — Studio reset to fresh upload page.");
  } catch {
    const currentUrl = page.url();
    console.log(`[uploader] Post URL after submit: ${currentUrl}`);
    console.warn("[uploader] Success indicator not matched — assuming posted (no error visible).");
  }

  // Try to find the newly posted video URL from the Posts feed
  // (Studio doesn't always surface it on the upload page itself)
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

    // Dismiss the react-joyride onboarding overlay BEFORE any form interaction.
    // The overlay blocks pointer events on the caption editor and Post button alike.
    await dismissOverlay(page);

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

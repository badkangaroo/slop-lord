/**
 * harness/video-downloader.ts
 *
 * Downloads a TikTok video via the live Chrome session (to carry cookies)
 * and transcodes it to 480p with ffmpeg.
 *
 * WHY THIS APPROACH
 * -----------------
 * TikTok's video CDN URLs require valid session tokens embedded in the URL
 * or browser cookies. Fetching directly with node-fetch will get a 403.
 * Instead we use page.evaluate(fetch(...)) to let the browser make the
 * request with its live session, then stream the bytes back as a base64
 * string which we write to a temp file.
 *
 * TRANSCODING
 * -----------
 * Input videos are typically 1080p or higher H.264 .mp4.
 * We scale to 480p (854×480 for 16:9, or scale2ref for portrait 9:16)
 * using ffmpeg's scale filter with the formula:
 *
 *   -vf "scale=-2:480"
 *
 * -2 means ffmpeg picks the width to maintain aspect ratio and rounds to
 * an even number (required by H.264). A 1080×1920 portrait video becomes
 * 270×480 — roughly ¼ the pixels, ~¼ the file size.
 *
 * OUTPUT
 * ------
 *   downloads/<videoId>.mp4   — transcoded 480p H.264 / AAC
 *
 * Returns the absolute path to the saved file, or null on failure.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Page } from "playwright";
import { config } from "../config/index.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ensure the downloads directory exists. */
function ensureDownloadsDir(): string {
  const dir = path.resolve(config.downloads.dir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Fetches a URL using Playwright's Node-side request API (bypasses CORS).
 * Injects Referer + User-Agent + browser cookies so TikTok CDN accepts the request.
 */
async function fetchViaPage(page: Page, url: string): Promise<Buffer | null> {
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
  const ua = await page.evaluate("navigator.userAgent") as string;

  try {
    const resp = await page.request.get(url, {
      headers: {
        "Referer":    "https://www.tiktok.com/",
        "User-Agent": ua,
        "Cookie":     cookieHeader,
      },
      timeout: 60_000,
    });
    if (!resp.ok()) {
      console.warn(`[downloader] CDN returned ${resp.status()} for ${url.slice(0, 80)}`);
      return null;
    }
    return await resp.body();
  } catch (err) {
    console.warn(`[downloader] fetch failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Runs ffmpeg to transcode a file to 480p H.264/AAC.
 * Removes the temp input file when done.
 *
 * Scale logic: -vf "scale=-2:480"
 *   - height locked to 480
 *   - width auto-computed to preserve aspect ratio, rounded to nearest even
 *   - works for both landscape (1920×1080 → 854×480) and
 *     portrait (1080×1920 → 270×480)
 */
async function transcodeToSD(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",                         // overwrite output without prompting
    "-i", inputPath,              // input: raw downloaded video
    "-vf", "scale=-2:480",        // scale height to 480, auto width (even)
    "-c:v", "libx264",            // H.264 video codec
    "-preset", "fast",            // encode speed vs compression trade-off
    "-crf", "23",                 // quality (18=near-lossless, 28=small, 23=default)
    "-c:a", "aac",                // AAC audio codec
    "-b:a", "128k",               // 128kbps audio — fine for spoken content
    "-movflags", "+faststart",    // move moov atom to front for streaming
    outputPath,
  ]);
  fs.rmSync(inputPath, { force: true });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DownloadResult {
  videoPath: string;    // absolute path to the 480p .mp4
  fileSizeBytes: number;
  originalUrl: string;  // the CDN URL that was downloaded
}

/**
 * Downloads and transcodes a TikTok video to 480p.
 *
 * @param page        Live Playwright page (must have active TikTok session)
 * @param videoId     TikTok video ID — used as the output filename
 * @param playAddr    Primary CDN stream URL (from SIGI blob item.video.playAddr)
 * @param downloadAddr No-watermark download URL (from item.video.downloadAddr), optional
 */
export async function downloadVideo(
  page: Page,
  videoId: string,
  playAddr: string,
  downloadAddr?: string
): Promise<DownloadResult | null> {
  const downloadsDir = ensureDownloadsDir();
  const outputPath = path.join(downloadsDir, `${videoId}.mp4`);

  // Skip if already downloaded (idempotent on re-runs)
  if (fs.existsSync(outputPath)) {
    const { size } = fs.statSync(outputPath);
    console.log(`[downloader] Already exists: ${videoId}.mp4 (${(size / 1024 / 1024).toFixed(1)} MB)`);
    return { videoPath: outputPath, fileSizeBytes: size, originalUrl: playAddr };
  }

  // Prefer downloadAddr (no watermark), fall back to playAddr
  const fetchUrl = downloadAddr || playAddr;
  console.log(`[downloader] Fetching video ${videoId} via browser session…`);

  const rawBytes = await fetchViaPage(page, fetchUrl);
  if (!rawBytes || rawBytes.length < 10_000) {
    console.warn(`[downloader] Fetch failed or returned too-small response for ${videoId}`);
    return null;
  }

  const rawSizeMB = (rawBytes.length / 1024 / 1024).toFixed(1);
  console.log(`[downloader] Downloaded ${rawSizeMB} MB raw — transcoding to 480p…`);

  // Write raw bytes to a temp file for ffmpeg input
  const tmpPath = path.join(os.tmpdir(), `slop-lord-${videoId}-raw.mp4`);
  fs.writeFileSync(tmpPath, rawBytes);

  try {
    await transcodeToSD(tmpPath, outputPath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    fs.rmSync(outputPath, { force: true });
    console.error(`[downloader] ffmpeg failed for ${videoId}: ${(err as Error).message}`);
    return null;
  }

  const { size } = fs.statSync(outputPath);
  console.log(
    `[downloader] Saved ${videoId}.mp4 — ` +
    `${rawSizeMB} MB raw → ${(size / 1024 / 1024).toFixed(1)} MB @ 480p`
  );

  return { videoPath: outputPath, fileSizeBytes: size, originalUrl: fetchUrl };
}

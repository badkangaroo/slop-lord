/**
 * harness/video-analyzer.ts
 *
 * Extracts structured metadata and captions from a TikTok video detail page.
 *
 * DATA SOURCES (confirmed via live DOM inspection)
 * ------------------------------------------------
 * 1. __UNIVERSAL_DATA_FOR_REHYDRATION__ script tag
 *    The richest source. Contains exact stats, hashtags, suggested words,
 *    TikTok's own content category labels (diversificationLabels), music
 *    info, author stats, and subtitle file URLs.
 *
 * 2. WebVTT subtitle files (when subtitleInfos is non-empty)
 *    Auto-generated captions (Source: "MT" = machine transcription).
 *    Fetched via page.evaluate(fetch(...)) to carry the session cookies.
 *    Parsed into plain timestamped lines.
 *    Present on: talking-head, interview, commentary videos.
 *    Absent on: music/pet/silent content (subtitleInfos = []).
 *
 * 3. og:description meta tag
 *    Fallback summary combining like count, description, and hashtags.
 *    Used when the SIGI state isn't available.
 *
 * USAGE
 * -----
 *    const analysis = await analyzeVideo(page, videoUrl);
 *    // analysis.transcript is the full spoken text, or null
 *    // analysis.stats has exact counts
 *    // analysis.contentLabels is TikTok's own category tags
 */

import { type Page } from "playwright";
import { chromium, type Browser } from "playwright";
import { config } from "../config/index.js";
import { waitForBrowser } from "./browser.js";
import { pauseGuard } from "./pause-guard.js";
import { downloadVideo } from "./video-downloader.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VideoStats {
  likes: number;
  comments: number;
  shares: number;
  plays: number;
  collects: number;
  reposts: number;
}

export interface SubtitleLine {
  startMs: number;
  endMs: number;
  text: string;
}

export interface VideoAnalysis {
  videoId: string;
  videoUrl: string;
  /** Full description text */
  description: string;
  /** Hashtags extracted from textExtra (more accurate than description parsing) */
  hashtags: string[];
  /** TikTok's suggested search words for this video */
  suggestedWords: string[];
  /** TikTok's own content category labels e.g. ["Sports News", "Sports"] */
  contentLabels: string[];
  /** Exact engagement stats from the page data */
  stats: VideoStats;
  /** Video duration in seconds */
  durationSec: number;
  /** Dimensions */
  width: number;
  height: number;
  music: {
    title: string;
    authorName: string;
    durationSec: number;
    isOriginalSound: boolean;
  } | null;
  author: {
    uniqueId: string;
    followerCount: number;
    videoCount: number;
    heartCount: number;
  } | null;
  /** WebVTT captions parsed to timestamped lines. null = no captions available. */
  subtitleLines: SubtitleLine[] | null;
  /** Full transcript as plain text (captions joined). null = no captions. */
  transcript: string | null;
  /** Caption language code e.g. "eng-US". null = no captions. */
  transcriptLanguage: string | null;
  /**
   * First-frame thumbnail as a base64 data URI ("data:image/jpeg;base64,…").
   * Fetched from TikTok's CDN through the page session so cookies are carried.
   * null if the cover URL was unavailable or the fetch failed.
   */
  thumbnailDataUri: string | null;
  /**
   * Absolute local path to the transcoded 480p video file.
   * e.g. "/Users/you/git_repos/slop-lord/downloads/7412345678901234567.mp4"
   * null if download was skipped or failed.
   */
  videoPath: string | null;
  capturedAt: string;
}

// ---------------------------------------------------------------------------
// WebVTT parser
// ---------------------------------------------------------------------------

function parseWebVTT(vttText: string): SubtitleLine[] {
  const lines: SubtitleLine[] = [];
  const blocks = vttText.split(/\n\n+/);

  for (const block of blocks) {
    const blockLines = block.trim().split("\n");
    // Find the timestamp line: "00:00:00.100 --> 00:00:03.280"
    const tsLine = blockLines.find((l) => l.includes("-->"));
    if (!tsLine) continue;

    const [startStr, endStr] = tsLine.split("-->").map((s) => s.trim());
    const toMs = (ts: string): number => {
      const parts = ts.split(":").map(Number);
      if (parts.length === 3) {
        return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
      }
      return 0;
    };

    const tsIdx = blockLines.indexOf(tsLine);
    const text = blockLines
      .slice(tsIdx + 1)
      .join(" ")
      .trim();

    if (text) {
      lines.push({ startMs: toMs(startStr), endMs: toMs(endStr), text });
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// SIGI data extractor (runs in browser context via page.evaluate string)
// ---------------------------------------------------------------------------

interface RawVideoData {
  id: string;
  desc: string;
  textExtra: Array<{ hashtagName?: string }>;
  suggestedWords: string[];
  diversificationLabels: string[];
  stats: {
    diggCount: number;
    shareCount: number;
    commentCount: number;
    playCount: number;
    collectCount: number | string;
    repostCount?: number | string;
  };
  video: {
    duration: number;
    width: number;
    height: number;
    /** Full-quality cover frame URL (CDN, requires session cookies to fetch) */
    originCoverUrl: string;
    /** Lower-res cover fallback */
    coverUrl: string;
    /** Direct stream URL — requires session cookies */
    playAddr: string;
    /** No-watermark download URL (not always present) */
    downloadAddr: string;
    subtitleInfos: Array<{
      Url: string;
      LanguageCodeName: string;
      Format: string;
      Source: string;
    }>;
  };
  music: {
    title: string;
    authorName: string;
    duration: number;
    original: boolean;
  };
  author: {
    uniqueId: string;
  };
  authorStats: {
    followerCount: number;
    videoCount: number;
    heartCount: number;
  };
}

async function extractRawVideoData(page: Page): Promise<RawVideoData | null> {
  return page.evaluate(`
    (() => {
      const el = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (!el) return null;
      try {
        const scope = JSON.parse(el.textContent).__DEFAULT_SCOPE__ || {};
        const vdKey = Object.keys(scope).find(k => k.includes('video-detail'));
        const item = vdKey ? scope[vdKey]?.itemInfo?.itemStruct : null;
        if (!item) return null;
        return {
          id: item.id || '',
          desc: item.desc || '',
          textExtra: item.textExtra || [],
          suggestedWords: item.suggestedWords || [],
          diversificationLabels: item.diversificationLabels || [],
          stats: item.stats || {},
          video: {
            duration: item.video?.duration || 0,
            width: item.video?.width || 0,
            height: item.video?.height || 0,
            originCoverUrl: item.video?.originCover || item.video?.dynamicCover || '',
            coverUrl: item.video?.cover || '',
            playAddr: item.video?.playAddr || '',
            downloadAddr: item.video?.downloadAddr || '',
            subtitleInfos: item.video?.subtitleInfos || [],
          },
          music: item.music ? {
            title: item.music.title || '',
            authorName: item.music.authorName || '',
            duration: item.music.duration || 0,
            original: !!item.music.original,
          } : null,
          author: { uniqueId: item.author?.uniqueId || '' },
          authorStats: {
            followerCount: item.authorStats?.followerCount || 0,
            videoCount: item.authorStats?.videoCount || 0,
            heartCount: item.authorStats?.heartCount || 0,
          },
        };
      } catch(e) { return null; }
    })()
  `) as Promise<RawVideoData | null>;
}

// ---------------------------------------------------------------------------
// Subtitle fetcher (uses page context to carry cookies)
// ---------------------------------------------------------------------------

async function fetchSubtitles(
  page: Page,
  subtitleInfos: RawVideoData["video"]["subtitleInfos"]
): Promise<{ lines: SubtitleLine[]; language: string } | null> {
  // Prefer English; fallback to first available
  const preferred = subtitleInfos.find((s) =>
    s.LanguageCodeName.startsWith("eng")
  ) ?? subtitleInfos[0];

  if (!preferred) return null;

  // Fetch using page context (carries TikTok session + CDN auth)
  const vttText = await page.evaluate(`
    fetch('${preferred.Url}')
      .then(r => r.ok ? r.text() : null)
      .catch(() => null)
  `) as string | null;

  if (!vttText || !vttText.includes("WEBVTT")) return null;

  const lines = parseWebVTT(vttText);
  return { lines, language: preferred.LanguageCodeName };
}

// ---------------------------------------------------------------------------
// Thumbnail fetcher — uses Playwright's Node-side request API (bypasses CORS)
// ---------------------------------------------------------------------------

async function fetchThumbnail(page: Page, originCoverUrl: string, coverUrl: string): Promise<string | null> {
  const urls = [originCoverUrl, coverUrl].filter(Boolean);
  if (urls.length === 0) return null;

  // Grab cookies from the browser context to authenticate CDN requests
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");

  for (const url of urls) {
    try {
      const resp = await page.request.get(url, {
        headers: {
          "Referer":    "https://www.tiktok.com/",
          "User-Agent": await page.evaluate("navigator.userAgent") as string,
          "Cookie":     cookieHeader,
        },
      });
      if (!resp.ok()) continue;
      const buf  = await resp.body();
      if (buf.length < 1000) continue;          // skip suspiciously small responses
      const mime = resp.headers()["content-type"]?.split(";")[0] ?? "image/jpeg";
      const b64  = buf.toString("base64");
      return `data:${mime};base64,${b64}`;
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Browser singleton for video page navigation
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
  if (!_page) throw new Error("[video-analyzer] No open TikTok page in Chrome.");
  return _page;
}

export async function closeVideoAnalyzer(): Promise<void> {
  if (_browser) {
    try { await _browser.close(); } catch { /* ignore */ }
  }
  _page = null;
  _browser = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Navigates to a TikTok video URL and extracts full metadata + captions.
 *
 * @param videoUrl  Full TikTok video URL e.g. https://www.tiktok.com/@user/video/123
 * @returns VideoAnalysis object, or null if the page data couldn't be extracted
 */
export async function analyzeVideo(videoUrl: string): Promise<VideoAnalysis | null> {
  await pauseGuard.check();

  const page = await getPage();

  // Navigate to the video page
  await page.goto(videoUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(1500);

  const raw = await extractRawVideoData(page);
  if (!raw) {
    console.warn(`[video-analyzer] Could not extract data from ${videoUrl}`);
    return null;
  }

  // Fetch subtitles/transcript if available
  let subtitleLines: SubtitleLine[] | null = null;
  let transcript: string | null = null;
  let transcriptLanguage: string | null = null;

  if (raw.video.subtitleInfos.length > 0) {
    const subs = await fetchSubtitles(page, raw.video.subtitleInfos);
    if (subs) {
      subtitleLines = subs.lines;
      transcript = subs.lines.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();
      transcriptLanguage = subs.language;
    }
  }

  // Fetch first-frame thumbnail from TikTok's CDN via the live session
  const thumbnailDataUri = await fetchThumbnail(
    page,
    raw.video.originCoverUrl,
    raw.video.coverUrl
  );
  if (thumbnailDataUri) {
    const kb = Math.round(thumbnailDataUri.length * 0.75 / 1024);
    console.log(`[video-analyzer] Thumbnail captured (~${kb}KB)`);
  } else {
    console.warn("[video-analyzer] Thumbnail unavailable for this video.");
  }

  // Download and transcode the video to 480p
  let videoPath: string | null = null;
  if (raw.id && raw.video.playAddr) {
    const result = await downloadVideo(
      page,
      raw.id,
      raw.video.playAddr,
      raw.video.downloadAddr || undefined
    );
    videoPath = result?.videoPath ?? null;
  } else {
    console.warn("[video-analyzer] No playAddr in SIGI data — skipping video download.");
  }

  const n = (v: number | string | undefined): number =>
    typeof v === "string" ? parseInt(v, 10) || 0 : v ?? 0;

  return {
    videoId: raw.id,
    videoUrl,
    description: raw.desc,
    hashtags: raw.textExtra
      .map((t) => t.hashtagName)
      .filter((h): h is string => !!h),
    suggestedWords: raw.suggestedWords,
    contentLabels: raw.diversificationLabels,
    stats: {
      likes: n(raw.stats.diggCount),
      comments: n(raw.stats.commentCount),
      shares: n(raw.stats.shareCount),
      plays: n(raw.stats.playCount),
      collects: n(raw.stats.collectCount),
      reposts: n(raw.stats.repostCount),
    },
    durationSec: raw.video.duration,
    width: raw.video.width,
    height: raw.video.height,
    music: raw.music
      ? {
          title: raw.music.title,
          authorName: raw.music.authorName,
          durationSec: raw.music.duration,
          isOriginalSound: raw.music.original,
        }
      : null,
    author: {
      uniqueId: raw.author.uniqueId,
      followerCount: raw.authorStats.followerCount,
      videoCount: raw.authorStats.videoCount,
      heartCount: raw.authorStats.heartCount,
    },
    subtitleLines,
    transcript,
    transcriptLanguage,
    thumbnailDataUri,
    videoPath,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Batch-analyzes a list of video URLs sequentially.
 * Calls onAnalysis for each result as it completes.
 */
export async function analyzeVideos(
  videoUrls: string[],
  opts: {
    delayMs?: number;
    onAnalysis?: (analysis: VideoAnalysis, index: number) => void | Promise<void>;
  } = {}
): Promise<VideoAnalysis[]> {
  const delayMs = opts.delayMs ?? 1000;
  const results: VideoAnalysis[] = [];

  for (let i = 0; i < videoUrls.length; i++) {
    await pauseGuard.check();
    const analysis = await analyzeVideo(videoUrls[i]);
    if (analysis) {
      results.push(analysis);
      if (opts.onAnalysis) await opts.onAnalysis(analysis, i);
    }
    if (i < videoUrls.length - 1) await new Promise((r) => setTimeout(r, delayMs));
  }

  return results;
}

pauseGuard.onShutdown(closeVideoAnalyzer);

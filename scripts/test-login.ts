#!/usr/bin/env tsx
/**
 * scripts/test-login.ts
 *
 * Interactive test for the browser harness and feed scroller.
 *
 * WHAT IT DOES
 * ------------
 * Step 1  — Check Chrome is reachable on the CDP port
 * Step 2  — Wait for TikTok login (blocks here until you log in)
 * Step 3  — Confirm authenticated session is visible
 * Step 4  — Scroll the For You feed (10 videos, no LLM needed)
 * Step 5  — Print a summary of what was found
 *
 * USAGE
 * -----
 *   # 1. Start Chrome
 *   ./scripts/launch-chrome.sh
 *
 *   # 2. Log in to TikTok in the browser window that opens
 *
 *   # 3. Run this test (in a separate terminal)
 *   npx tsx scripts/test-login.ts
 *
 *   No API key needed for the feed scroll step.
 *   Set OPENAI_API_KEY in .env to also run the Stagehand extraction steps.
 *
 * The browser window stays visible throughout. Ctrl+C stops cleanly.
 */

import "dotenv/config";
import { isChromeReachable, waitForBrowser, getBrowserStatus } from "../harness/browser.js";
import { pauseGuard } from "../harness/pause-guard.js";
import { scrollFeed, closeFeedScroller, type FeedVideo } from "../harness/feed-scroller.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TICK = "✓";
const CROSS = "✗";
const WAIT = "⏳";
const INFO = "ℹ";

function header(title: string): void {
  const bar = "─".repeat(60);
  console.log(`\n${bar}`);
  console.log(`  ${title}`);
  console.log(`${bar}`);
}

function step(n: number, label: string): void {
  console.log(`\nStep ${n}: ${label}`);
}

function ok(msg: string): void {
  console.log(`  ${TICK}  ${msg}`);
}

function fail(msg: string): void {
  console.log(`  ${CROSS}  ${msg}`);
}

function info(msg: string): void {
  console.log(`  ${INFO}  ${msg}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  header("SLOP-LORD — Browser Harness Test");
  console.log("  This test verifies the login flow and basic TikTok navigation.");
  console.log("  The browser window will remain visible throughout.");

  // -----------------------------------------------------------------------
  // Step 1: CDP reachability
  // -----------------------------------------------------------------------
  step(1, "Checking Chrome CDP port");

  const reachable = await isChromeReachable();
  if (!reachable) {
    fail("Chrome is NOT reachable on the configured CDP port.");
    console.log("\n  Run this first:\n    ./scripts/launch-chrome.sh\n");
    process.exit(1);
  }
  ok("Chrome is reachable via CDP.");

  // -----------------------------------------------------------------------
  // Step 2: Wait for TikTok login
  // -----------------------------------------------------------------------
  step(2, "Waiting for TikTok authenticated session");
  console.log(`  ${WAIT}  Checking browser state…`);

  // Show initial status before blocking
  const initialStatus = await getBrowserStatus();
  if (initialStatus.requiresLogin) {
    console.log("\n  TikTok login page is open.");
    console.log("  Please log in to TikTok in the browser window.");
    console.log("  This test will resume automatically after login.\n");
  } else if (!initialStatus.tiktokTarget) {
    console.log("\n  No TikTok tab found. Make sure tiktok.com is open.");
    console.log("  Waiting…\n");
  }

  // waitForBrowser() blocks until Chrome has an authenticated TikTok page
  const target = await waitForBrowser({ timeoutSec: 300, pollMs: 2000 });
  ok(`Authenticated TikTok tab confirmed: "${target.title}"`);
  info(`URL: ${target.url}`);

  // -----------------------------------------------------------------------
  // Step 3: Confirm session details
  // -----------------------------------------------------------------------
  step(3, "Session details");

  const status = await getBrowserStatus();
  info(`TikTok tab: ${status.tiktokTarget?.url ?? "unknown"}`);
  ok("Session confirmed — cookies are live in the Chrome profile.");

  // -----------------------------------------------------------------------
  // Step 4: Scroll the For You feed — 10 videos (no LLM required)
  // -----------------------------------------------------------------------
  step(4, "Scrolling the For You feed");
  info("Swiping through 10 videos using direct DOM extraction (no API key needed).");
  info("Watch the browser window — you will see it scrolling.");
  console.log();
  console.log("  #    Author                Likes        Hashtags");
  console.log("  ─────────────────────────────────────────────────────");

  let feedVideos: FeedVideo[] = [];
  try {
    feedVideos = await scrollFeed({
      count: 10,
      dwellMs: 1500,   // 1.5s per video so you can see it in the window
    });
    console.log();
    ok(`Captured ${feedVideos.length} video(s) from the For You feed.`);
  } catch (err) {
    console.log();
    fail(`Feed scroll failed: ${(err as Error).message}`);
    info("Check that tiktok.com/foryou is loaded in the browser window.");
  }

  // -----------------------------------------------------------------------
  // Step 5: Summary
  // -----------------------------------------------------------------------
  printSummary(feedVideos);
}

function printSummary(videos: FeedVideo[]): void {
  header("Test Summary");

  const allHashtags = videos.flatMap((v) => v.hashtags);
  const hashtagFreq: Record<string, number> = {};
  for (const tag of allHashtags) {
    hashtagFreq[tag] = (hashtagFreq[tag] ?? 0) + 1;
  }
  const topTags = Object.entries(hashtagFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  console.log(`  ${TICK}  Chrome CDP connection: OK`);
  console.log(`  ${TICK}  TikTok session: authenticated`);
  console.log(`  ${videos.length > 0 ? TICK : CROSS}  Feed scroll: ${videos.length} videos captured`);

  if (topTags.length > 0) {
    console.log("\n  Most common hashtags in this feed session:");
    topTags.forEach(([tag, count]) => {
      console.log(`    #${tag} (${count}x)`);
    });
  }

  if (videos.length > 0) {
    const totalLikes = videos.reduce((s, v) => s + (v.likes ?? 0), 0);
    const avgLikes = Math.round(totalLikes / videos.length);
    console.log(`\n  Average likes per video: ${avgLikes.toLocaleString()}`);
  }

  console.log(`
  NEXT STEPS
  ──────────
  • Feed scroller working → scanner loop is next (scanner/agent.ts)
  • Chrome stays open — the agent will reuse this session
  • For Stagehand DOM extraction, set OPENAI_API_KEY in .env

  Pause at any time:   touch /tmp/slop-lord.pause
  Resume:              rm /tmp/slop-lord.pause
`);
}

// Run — always close the CDP connection so Node exits cleanly
main()
  .catch((err) => {
    console.error("\n  Fatal error:", err);
  })
  .finally(async () => {
    await closeFeedScroller();
    process.exit(0);
  });

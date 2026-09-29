/**
 * scanner/agent.ts  (@hermes)
 *
 * Main scanner loop. Runs every SCANNER_INTERVAL_MINUTES (default 60).
 *
 * ONE CYCLE:
 *   1. scrollFeed()        — collect N videos from the For You feed
 *   2. analyzeVideo()      — extract full stats + transcript for each
 *   3. scoreBatch()        — compute TSS for the batch
 *   4. filter by threshold — drop candidates below config.scanner.tssThreshold
 *   5. classify()          — assign layer + vibe
 *   6. writeDossier()      — dedup check + write to Postgres
 *
 * CONTROLS
 *   touch /tmp/slop-lord.pause   → agent pauses before next action
 *   rm    /tmp/slop-lord.pause   → resumes
 *   SIGTERM / SIGINT             → graceful shutdown
 *
 * USAGE
 *   npx tsx scanner/agent.ts          # run once then exit
 *   npx tsx scanner/agent.ts --loop   # run continuously on interval
 */

import "dotenv/config";
import { config } from "../config/index.js";
import { pauseGuard } from "../harness/pause-guard.js";
import { scrollFeed, closeFeedScroller } from "../harness/feed-scroller.js";
import { analyzeVideo, closeVideoAnalyzer } from "../harness/video-analyzer.js";
import { scoreBatch } from "./scorer.js";
import { classify } from "./classifier.js";
import { writeCandidate, writeDossier, closeDb } from "./dossier.js";
import { runParodyPipeline } from "../parody-engine/index.js";
import { db } from "../db/client.js";
import { trendDossiers } from "../db/schema.js";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FEED_SCROLL_COUNT   = 100;   // videos per scan cycle
const DWELL_PER_VIDEO_MS  = 2 * 60 * 1000;  // 2 minutes total per video (analysis + wait)
const TSS_THRESHOLD       = config.scanner.tssThreshold ?? 0.65;
const INTERVAL_MINUTES    = config.scanner.intervalMinutes ?? 60;
const LOOP                = process.argv.includes("--loop");

// ---------------------------------------------------------------------------
// One scan cycle
// ---------------------------------------------------------------------------

/**
 * Analyze a single video and wait out the remainder of the 2-minute dwell window.
 * Called inside scrollFeed's onVideo callback so analysis happens while we're
 * still on the card — scroll doesn't happen until this resolves.
 */
async function analyzeAndDwell(
  video: import("../harness/feed-scroller.js").FeedVideo,
  index: number,
  total: number,
  pairs: Array<{ video: import("../harness/feed-scroller.js").FeedVideo; analysis: Awaited<ReturnType<typeof analyzeVideo>> }>
): Promise<void> {
  const windowStart = Date.now();
  const label = `  [${(index + 1).toString().padStart(3)}/${total}] @${video.author.padEnd(22)}`;

  if (!video.videoUrl) {
    console.log(`${label} — skipped (no video URL in feed card)`);
    pairs.push({ video, analysis: null });
  } else {
    try {
      const analysis = await analyzeVideo(video.videoUrl);
      const playsStr = analysis?.stats.plays
        ? `${(analysis.stats.plays / 1_000_000).toFixed(2)}M plays`
        : "no play count";
      const txStr    = analysis?.transcript ? " [transcript✓]" : "";
      const labStr   = analysis?.contentLabels?.slice(0, 2).join(", ") ?? "";
      console.log(`${label} — ${playsStr}${txStr}${labStr ? `  [${labStr}]` : ""}`);
      pairs.push({ video, analysis });
    } catch (err) {
      console.warn(`${label} — analysis failed: ${(err as Error).message}`);
      pairs.push({ video, analysis: null });
    }
  }

  // Wait out whatever is left of the 2-minute window
  const elapsed = Date.now() - windowStart;
  const remaining = DWELL_PER_VIDEO_MS - elapsed;
  if (remaining > 0) {
    const remSec = (remaining / 1000).toFixed(0);
    console.log(`${label.trimEnd()} — dwelling ${remSec}s more…`);
    await new Promise((r) => setTimeout(r, remaining));
  }
}

async function runCycle(): Promise<void> {
  const cycleStart = Date.now();
  console.log(`\n[@hermes] ── Scan cycle starting at ${new Date().toISOString()} ──`);
  console.log(`[@hermes] TSS threshold: ${TSS_THRESHOLD} | Videos: ${FEED_SCROLL_COUNT} | Dwell: ${DWELL_PER_VIDEO_MS / 1000}s each`);
  console.log(`[@hermes] Estimated cycle time: ~${Math.round(FEED_SCROLL_COUNT * DWELL_PER_VIDEO_MS / 60_000)} minutes`);

  // ------------------------------------------------------------------
  // Step 1+2 combined: Scroll feed + analyze each video inline.
  // onVideo fires immediately when a card is captured; we analyze and
  // dwell for the full 2-minute window before scrollFeed moves on.
  // dwellMs is set to 0 because the dwell is managed inside onVideo.
  // ------------------------------------------------------------------
  await pauseGuard.check();
  console.log(`\n[@hermes] Step 1/3 — Scrolling + analyzing ${FEED_SCROLL_COUNT} videos (2 min each)…\n`);
  console.log("  #    Author                 Stats                    Labels");
  console.log("  ────────────────────────────────────────────────────────────────");

  const pairs: Array<{ video: import("../harness/feed-scroller.js").FeedVideo; analysis: Awaited<ReturnType<typeof analyzeVideo>> }> = [];

  const feedVideos = await scrollFeed({
    count:   FEED_SCROLL_COUNT,
    dwellMs: 0,   // dwell is handled inside onVideo; scroller scrolls immediately after callback
    onVideo: async ({ video, index }) => {
      await analyzeAndDwell(video, index, FEED_SCROLL_COUNT, pairs);
    },
  });

  console.log(`\n[@hermes] Collected and analyzed ${pairs.length} videos.`);

  if (pairs.length === 0) {
    console.warn("[@hermes] No videos collected — aborting cycle.");
    return;
  }

  // ------------------------------------------------------------------
  // Step 2: Score ALL candidates + write every one to trend_candidates
  // ------------------------------------------------------------------
  await pauseGuard.check();
  console.log(`\n[@hermes] Step 2/3 — Scoring + persisting all ${pairs.length} candidates…`);

  const scored = scoreBatch(pairs);

  // Write every video to trend_candidates (full raw log, promoted=false for now)
  for (const candidate of scored) {
    await pauseGuard.check();
    const classification = classify(candidate);
    await writeCandidate(candidate, classification.layer);
  }
  console.log(`[@hermes] Wrote ${scored.length} raw candidates to trend_candidates.`);

  // Identify which ones clear the promotion threshold
  const promoted = scored.filter((c) => c.tss >= TSS_THRESHOLD);
  console.log(`[@hermes] ${promoted.length} above TSS threshold (>= ${TSS_THRESHOLD}) → promoting to trend_dossiers`);
  for (const c of promoted) {
    console.log(`  TSS=${c.tss.toFixed(3)}  @${c.video.author}  "${c.video.description.slice(0, 60)}"`);
  }

  // ------------------------------------------------------------------
  // Step 3: Promote high-scorers to trend_dossiers
  // ------------------------------------------------------------------
  await pauseGuard.check();
  console.log(`\n[@hermes] Step 3/3 — Writing dossiers for promoted candidates…`);

  let written = 0;
  let suppressed = 0;

  for (const candidate of promoted) {
    await pauseGuard.check();
    const classification = classify(candidate);
    const result = await writeDossier(candidate, classification);
    if (result.suppressed) suppressed++;
    else written++;
  }

  // ------------------------------------------------------------------
  // Step 4: Run parody pipeline for each newly written dossier
  // ------------------------------------------------------------------
  if (written > 0) {
    await pauseGuard.check();
    console.log(`\n[@hermes] Step 4 — Running parody pipeline for ${written} new dossier(s)…`);

    // Fetch the dossiers we just wrote (unprocessed ones created this cycle)
    const newDossiers = await db
      .select()
      .from(trendDossiers)
      .where(eq(trendDossiers.processed, false));

    let generated = 0;
    for (const dossier of newDossiers) {
      await pauseGuard.check();
      const result = await runParodyPipeline(dossier).catch((err) => {
        console.error(`[@hermes] Parody pipeline error for dossier ${dossier.id}: ${(err as Error).message}`);
        return null;
      });
      if (result) generated++;
    }
    console.log(`[@hermes]   ${generated}/${written} parody videos generated.`);
  }

  const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
  console.log(`\n[@hermes] Cycle complete in ${elapsed}s`);
  console.log(`[@hermes]   ${scored.length} videos catalogued in trend_candidates`);
  console.log(`[@hermes]   ${written} dossiers written to trend_dossiers`);
  console.log(`[@hermes]   ${suppressed} suppressed (48h dedup)`);
}

// ---------------------------------------------------------------------------
// Shutdown helpers
// ---------------------------------------------------------------------------

async function shutdown(): Promise<void> {
  console.log("\n[@hermes] Shutting down…");
  await closeFeedScroller();
  await closeVideoAnalyzer();
  await closeDb();
}

pauseGuard.onShutdown(shutdown);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[@hermes] SLOP-LORD scanner starting.");
  console.log(`[@hermes] Mode: ${LOOP ? `loop every ${INTERVAL_MINUTES}min` : "single run"}`);
  console.log(`[@hermes] Pause: touch /tmp/slop-lord.pause  |  Resume: rm /tmp/slop-lord.pause\n`);

  if (LOOP) {
    while (true) {
      await runCycle().catch((err) =>
        console.error("[@hermes] Cycle error:", (err as Error).message)
      );
      console.log(`[@hermes] Sleeping ${INTERVAL_MINUTES} minutes until next cycle…`);
      await new Promise((r) => setTimeout(r, INTERVAL_MINUTES * 60 * 1000));
    }
  } else {
    await runCycle();
  }
}

main()
  .catch((err) => console.error("[@hermes] Fatal:", err))
  .finally(async () => {
    await shutdown();
    process.exit(0);
  });

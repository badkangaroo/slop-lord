#!/usr/bin/env tsx
/**
 * scripts/pick-target.ts
 *
 * Scans a short window of the For You feed, scores the candidates, sends
 * the top results to the LLM to pick the single best target for parody,
 * then kicks off the full parody pipeline (Qwen edit → MiniMax I2V) on
 * the winner.
 *
 * USAGE
 *   npx tsx scripts/pick-target.ts              # scan 20 videos, LLM picks
 *   npx tsx scripts/pick-target.ts --count=40   # scan more cards
 *   npx tsx scripts/pick-target.ts --top=10     # show top N to LLM (default 8)
 *   npx tsx scripts/pick-target.ts --dry-run    # pick only, skip pipeline
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { scrollFeed, closeFeedScroller } from "../harness/feed-scroller.js";
import { analyzeVideo, closeVideoAnalyzer } from "../harness/video-analyzer.js";
import { scoreBatch, type ScoredCandidate } from "../scanner/scorer.js";
import { complete } from "../parody-engine/llm.js";
import { generateBriefFromAnalysis } from "../parody-engine/brief-generator.js";
import { editFrame } from "../parody-engine/qwen-image-edit.js";
import { dispatchToMinimax } from "../parody-engine/minimax-dispatch.js";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const SCAN_COUNT = parseInt(
  process.argv.find((a) => a.startsWith("--count="))?.split("=")[1] ?? "20",
  10
);
const TOP_N = parseInt(
  process.argv.find((a) => a.startsWith("--top="))?.split("=")[1] ?? "8",
  10
);
const DRY_RUN = process.argv.includes("--dry-run");
const OUTPUT_DIR = path.resolve("./smoke-output");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bar(title: string) {
  console.log(`\n${"─".repeat(62)}\n  ${title}\n${"─".repeat(62)}`);
}

// ---------------------------------------------------------------------------
// Step 1: scan feed + analyze
// ---------------------------------------------------------------------------

async function scanAndAnalyze(): Promise<ScoredCandidate[]> {
  bar(`Scanning ${SCAN_COUNT} feed cards…`);

  const pairs: Array<{
    video: import("../harness/feed-scroller.js").FeedVideo;
    analysis: Awaited<ReturnType<typeof analyzeVideo>>;
  }> = [];

  await scrollFeed({
    count:   SCAN_COUNT,
    dwellMs: 800,
    onVideo: async ({ video, index }) => {
      if (!video.videoUrl) {
        pairs.push({ video, analysis: null });
        return;
      }
      try {
        const analysis = await analyzeVideo(video.videoUrl);
        const plays = analysis?.stats.plays
          ? `${(analysis.stats.plays / 1e6).toFixed(1)}M`
          : "?";
        console.log(
          `  [${String(index + 1).padStart(2)}/${SCAN_COUNT}]` +
          ` @${video.author.padEnd(20)} ${plays.padStart(6)} plays` +
          `${analysis?.transcript ? " [tx]" : ""}`
        );
        pairs.push({ video, analysis });
      } catch {
        pairs.push({ video, analysis: null });
      }
    },
  });

  const scored = scoreBatch(pairs);
  console.log(`\n  Scored ${scored.length} candidates.`);
  return scored;
}

// ---------------------------------------------------------------------------
// Step 2: LLM picks the best target
// ---------------------------------------------------------------------------

const PICKER_SYSTEM = `You are a viral content strategist selecting the single best TikTok video to parody.

You will receive a numbered list of trending videos with their stats, transcript snippets, and content labels.
Pick the ONE video with the highest parody potential based on:
  1. Inherently absurd or relatable premise that can be made funnier with a visual swap
  2. Strong transcript or implied audio that makes the joke land
  3. Clear visual subject that Qwen-Image-Edit can replace with something bizarre
  4. High play count relative to the batch (viral momentum)

Respond with ONLY a JSON object:
{ "pick": <number>, "reason": "<one sentence why this is the best target>" }`;

async function llmPick(candidates: ScoredCandidate[]): Promise<{ pick: number; reason: string }> {
  bar("LLM picking best parody target…");

  const lines = candidates.slice(0, TOP_N).map((c, i) => {
    const plays  = c.analysis?.stats.plays  ?? 0;
    const likes  = c.analysis?.stats.likes  ?? c.video.likes ?? 0;
    const shares = c.analysis?.stats.shares ?? c.video.shares ?? 0;
    const tx     = (c.analysis?.transcript ?? "").slice(0, 150);
    const labels = (c.analysis?.contentLabels ?? []).slice(0, 3).join(", ");
    const words  = (c.analysis?.suggestedWords ?? []).slice(0, 4).join(", ");
    const desc   = (c.video.description ?? "").slice(0, 100);
    const playsStr = plays > 0 ? `${(plays / 1e6).toFixed(2)}M plays` : `${(likes / 1e3).toFixed(1)}k likes`;
    return [
      `${i + 1}. @${c.video.author} — "${desc}"`,
      `   ${playsStr}  shares=${(shares / 1e3).toFixed(1)}k  TSS=${c.tss.toFixed(2)}`,
      labels ? `   labels: ${labels}` : "",
      words  ? `   keywords: ${words}` : "",
      tx     ? `   transcript: "${tx}"` : "   (no transcript)",
    ].filter(Boolean).join("\n");
  });

  const userPrompt = `Here are the top ${lines.length} trending videos from the current For You feed:\n\n${lines.join("\n\n")}\n\nPick the single best one to parody.`;
  console.log(userPrompt);

  const raw = await complete(PICKER_SYSTEM, userPrompt, { temperature: 0.3, maxTokens: 3000 });
  if (!raw) throw new Error("LLM returned null for pick");

  // Find the LAST valid { "pick": N, "reason": "..." } in the output —
  // reasoning models emit chain-of-thought then a final JSON answer.
  const matches = [...raw.matchAll(/\{\s*"pick"\s*:\s*(\d+)[^}]*"reason"\s*:\s*"([^"]{1,300})"\s*\}/g)];
  if (matches.length === 0) {
    // Fallback: any JSON object with a "pick" key
    const fallback = raw.match(/\{[\s\S]*?"pick"[\s\S]*?\}/);
    if (!fallback) throw new Error(`Could not parse LLM pick response:\n${raw.slice(-300)}`);
    const parsed = JSON.parse(fallback[0]) as { pick: number; reason: string };
    return parsed;
  }
  const last = matches[matches.length - 1];
  return { pick: parseInt(last[1], 10), reason: last[2] };
}

// ---------------------------------------------------------------------------
// Step 3: Run pipeline on winner
// ---------------------------------------------------------------------------

async function runPipeline(winner: ScoredCandidate): Promise<void> {
  bar("Running parody pipeline on selected target…");

  const videoId = winner.analysis?.videoId ?? winner.video.author.replace(/\W/g, "") + "_" + Date.now();
  const firstFrameUri = winner.analysis?.thumbnailDataUri ?? null;

  if (!firstFrameUri) {
    console.log("  ❌ No thumbnail available — cannot run Qwen edit or MiniMax.");
    return;
  }

  // Generate brief
  console.log("  Generating content brief…");
  const brief = await generateBriefFromAnalysis(winner.analysis!, videoId);
  if (!brief) throw new Error("Brief generation failed");

  console.log(`  ✅ Brief: "${brief.premise}"`);
  console.log(`  Character: ${brief.character}`);
  console.log(`  Edit instruction: "${brief.editInstruction.slice(0, 120)}"`);
  fs.writeFileSync(path.join(OUTPUT_DIR, `brief_${videoId}.json`), JSON.stringify(brief, null, 2));

  if (DRY_RUN) {
    console.log("  --dry-run: skipping Qwen + MiniMax.");
    return;
  }

  // Qwen edit
  console.log("\n  Running Qwen-Image-Edit…");
  let firstFrameForMinimax = firstFrameUri;
  try {
    const edit = await editFrame(firstFrameUri, brief.editInstruction, videoId);
    console.log(`  ✅ Edited frame: ${edit.editedImagePath}`);
    firstFrameForMinimax = edit.editedDataUri;
    const buf = fs.readFileSync(edit.editedImagePath);
    fs.writeFileSync(path.join(OUTPUT_DIR, `edited_frame_${videoId}.png`), buf);
  } catch (err) {
    console.log(`  ⚠  Qwen edit failed (${(err as Error).message}) — using raw thumbnail.`);
  }

  // MiniMax I2V
  console.log("\n  Submitting to MiniMax H3 I2V…");
  const result = await dispatchToMinimax(brief, firstFrameForMinimax);
  console.log(`  ✅ Video generated: ${result.generatedPath} (${result.durationSec}s)`);
  const buf = fs.readFileSync(result.generatedPath);
  fs.writeFileSync(path.join(OUTPUT_DIR, `generated_${videoId}.mp4`), buf);
  console.log(`  Copy: ${path.join(OUTPUT_DIR, `generated_${videoId}.mp4`)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  bar("pick-target — SLOP-LORD source selection");
  console.log(`  Scan: ${SCAN_COUNT} cards | Top N to LLM: ${TOP_N} | Dry run: ${DRY_RUN}`);

  const scored = await scanAndAnalyze();
  if (scored.length === 0) throw new Error("No candidates collected from feed scan.");

  const { pick, reason } = await llmPick(scored);
  const idx = Math.max(0, Math.min(pick - 1, scored.length - 1));
  const winner = scored[idx];

  bar(`Winner: #${pick} — @${winner.video.author}`);
  console.log(`  Reason: ${reason}`);
  console.log(`  Video:  ${winner.video.videoUrl ?? "(no URL)"}`);
  console.log(`  TSS:    ${winner.tss.toFixed(3)}`);
  console.log(`  Desc:   "${(winner.video.description ?? "").slice(0, 100)}"`);
  if (winner.analysis?.transcript) {
    console.log(`  Transcript: "${winner.analysis.transcript.slice(0, 150)}…"`);
  }

  await runPipeline(winner);

  bar("Done");
  console.log(`  Output files: ${OUTPUT_DIR}`);
}

main()
  .catch((err) => {
    console.error("\nFatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    await closeFeedScroller();
    await closeVideoAnalyzer();
    process.exit(0);
  });

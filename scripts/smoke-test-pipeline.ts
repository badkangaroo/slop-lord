#!/usr/bin/env tsx
/**
 * scripts/smoke-test-pipeline.ts
 *
 * End-to-end smoke test for the full content pipeline.
 * Does NOT require Postgres — runs everything in memory.
 *
 * WHAT IT TESTS (in order):
 *   Stage 1 — Chrome CDP reachability
 *   Stage 2 — analyzeVideo(): thumbnail + transcript + stats from a live TikTok URL
 *   Stage 3 — LM Studio reachability + generateBriefFromAnalysis() (vision + brief)
 *   Stage 4 — Qwen-Image-Edit via ComfyUI (10.0.1.3:8188): edit the first frame
 *   Stage 5 — MiniMax H3 via ComfyUI (10.0.1.3:8188): generate the video
 *
 * USAGE:
 *   # 1. Start Chrome with a TikTok session already logged in
 *   ./scripts/launch-chrome.sh
 *
 *   # 2. Run the smoke test (optionally pass a specific video URL)
 *   npx tsx scripts/smoke-test-pipeline.ts
 *   npx tsx scripts/smoke-test-pipeline.ts https://www.tiktok.com/@user/video/123
 *
 * FLAGS:
 *   --skip-minimax   Run through Qwen edit but skip MiniMax generation (faster smoke)
 *   --skip-qwen      Skip Qwen edit, send raw thumbnail directly to MiniMax
 *   --skip-video     Skip MiniMax entirely (only tests analysis + LM Studio)
 *
 * All generated files are saved under ./smoke-output/
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { isChromeReachable, waitForBrowser } from "../harness/browser.js";
import { analyzeVideo, closeVideoAnalyzer } from "../harness/video-analyzer.js";
import { listModels } from "../parody-engine/llm.js";
import { generateBriefFromAnalysis } from "../parody-engine/brief-generator.js";
import { editFrame } from "../parody-engine/qwen-image-edit.js";
import { dispatchToMinimax } from "../parody-engine/minimax-dispatch.js";
import type { VideoAnalysis } from "../harness/video-analyzer.js";
import type { ContentBrief } from "../parody-engine/brief-generator.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OUTPUT_DIR    = path.resolve("./smoke-output");
const SKIP_MINIMAX  = process.argv.includes("--skip-minimax");
const SKIP_QWEN     = process.argv.includes("--skip-qwen");
const SKIP_VIDEO    = process.argv.includes("--skip-video");

// --duration=<N>  override video duration (seconds) sent to MiniMax; may be repeated
// e.g. --duration=3 --duration=5  runs two back-to-back generation jobs
const DURATIONS: number[] = process.argv
  .filter((a) => a.startsWith("--duration="))
  .map((a) => parseFloat(a.split("=")[1]))
  .filter((n) => Number.isFinite(n) && n > 0);
// Default: single run at the config value (5s)
if (DURATIONS.length === 0) DURATIONS.push(0);  // 0 = use config default

// Grab a video URL from args, or use a known public TikTok URL as default
const VIDEO_URL = process.argv.find((a) => a.startsWith("https://www.tiktok.com/"))
  ?? "https://www.tiktok.com/trending";  // fallback — will redirect to a real video

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const PASS  = "  ✅ PASS";
const FAIL  = "  ❌ FAIL";
const SKIP  = "  ⏭  SKIP";
const INFO  = "  ℹ ";
const ARROW = "  →  ";

function bar(title: string) {
  console.log(`\n${"─".repeat(62)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(62));
}

function save(filename: string, content: string | Buffer): string {
  const p = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(p, content);
  return p;
}

// ---------------------------------------------------------------------------
// Stage runners
// ---------------------------------------------------------------------------

async function stage1_chrome(): Promise<boolean> {
  bar("Stage 1 — Chrome CDP");
  const ok = await isChromeReachable();
  if (!ok) {
    console.log(`${FAIL}  Chrome not reachable.`);
    console.log(`${ARROW}Run:  ./scripts/launch-chrome.sh`);
    return false;
  }
  console.log(`${PASS}  Chrome CDP reachable.`);

  console.log(`${INFO}Waiting for authenticated TikTok session…`);
  try {
    const t = await waitForBrowser({ timeoutSec: 60, pollMs: 2000 });
    console.log(`${PASS}  TikTok session confirmed: "${t.title}"`);
  } catch {
    console.log(`${FAIL}  No authenticated TikTok session found within 60s.`);
    console.log(`${ARROW}Log in to TikTok in the browser, then re-run.`);
    return false;
  }
  return true;
}

async function stage2_analyze(videoUrl: string): Promise<VideoAnalysis | null> {
  bar(`Stage 2 — Video Analysis`);
  console.log(`${INFO}Analyzing: ${videoUrl}`);

  let analysis: VideoAnalysis | null = null;
  try {
    analysis = await analyzeVideo(videoUrl);
  } catch (err) {
    console.log(`${FAIL}  analyzeVideo threw: ${(err as Error).message}`);
    return null;
  }

  if (!analysis) {
    console.log(`${FAIL}  analyzeVideo returned null (SIGI data not found).`);
    return null;
  }

  // Print everything collected
  console.log(`${PASS}  Analysis complete.\n`);
  console.log(`${ARROW}Video ID:       ${analysis.videoId}`);
  console.log(`${ARROW}Author:         @${analysis.author?.uniqueId ?? "?"}  (${(analysis.author?.followerCount ?? 0).toLocaleString()} followers)`);
  console.log(`${ARROW}Description:    ${analysis.description.slice(0, 80)}`);
  console.log(`${ARROW}Content labels: ${analysis.contentLabels.join(", ") || "(none)"}`);
  console.log(`${ARROW}Suggested words:${analysis.suggestedWords.join(", ") || "(none)"}`);
  console.log(`${ARROW}Hashtags:       ${analysis.hashtags.map(h => "#" + h).join(" ") || "(none)"}`);
  console.log(`${ARROW}Stats:          ${analysis.stats.plays.toLocaleString()} plays  ${analysis.stats.likes.toLocaleString()} likes  ${analysis.stats.shares.toLocaleString()} shares`);
  console.log(`${ARROW}Duration:       ${analysis.durationSec}s  ${analysis.width}×${analysis.height}`);
  console.log(`${ARROW}Music:          "${analysis.music?.title ?? "?"}" by ${analysis.music?.authorName ?? "?"}`);
  console.log(`${ARROW}Transcript:     ${analysis.transcript ? `${analysis.transcript.slice(0, 120)}…` : "(none)"}`);

  // Check thumbnail
  if (analysis.thumbnailDataUri) {
    const kb = Math.round(analysis.thumbnailDataUri.length * 0.75 / 1024);
    console.log(`${PASS}  Thumbnail captured (~${kb}KB)`);
    // Save thumbnail for inspection
    const b64 = analysis.thumbnailDataUri.split(",")[1];
    const thumbPath = save(`thumbnail_${analysis.videoId}.jpg`, Buffer.from(b64, "base64"));
    console.log(`${ARROW}Saved: ${thumbPath}`);
  } else {
    console.log(`${FAIL}  No thumbnail captured — Qwen edit will be skipped.`);
  }

  // Check video download
  if (analysis.videoPath) {
    console.log(`${PASS}  Video downloaded: ${analysis.videoPath}`);
  } else {
    console.log(`${INFO}  No video downloaded (no playAddr in SIGI data, or download failed).`);
  }

  // Save full analysis JSON for inspection
  const analysisPath = save(
    `analysis_${analysis.videoId}.json`,
    JSON.stringify(analysis, (k, v) => k === "thumbnailDataUri" ? `<${Math.round((v?.length ?? 0) * 0.75 / 1024)}KB data URI>` : v, 2)
  );
  console.log(`${ARROW}Full analysis: ${analysisPath}`);

  return analysis;
}

async function stage3_brief(analysis: VideoAnalysis): Promise<ContentBrief | null> {
  bar("Stage 3 — LM Studio Brief Generation");

  // Health check
  console.log(`${INFO}Checking LM Studio at ${process.env.LM_STUDIO_BASE_URL || "http://10.0.1.8:1234/v1"}…`);
  const models = await listModels();
  if (models.length === 0) {
    console.log(`${FAIL}  LM Studio unreachable or no models loaded.`);
    console.log(`${ARROW}Make sure LM Studio is running at 10.0.1.8:1234 with a model loaded.`);
    return null;
  }
  console.log(`${PASS}  LM Studio reachable. Loaded: ${models.join(", ")}`);

  if (analysis.thumbnailDataUri) {
    console.log(`${INFO}Vision call: sending thumbnail for first-frame description…`);
  } else {
    console.log(`${INFO}No thumbnail — using text-only context.`);
  }

  let brief: ContentBrief | null = null;
  try {
    brief = await generateBriefFromAnalysis(analysis, analysis.videoId);
  } catch (err) {
    console.log(`${FAIL}  generateBriefFromAnalysis threw: ${(err as Error).message}`);
    return null;
  }

  if (!brief) {
    console.log(`${FAIL}  Brief generation returned null.`);
    return null;
  }

  console.log(`${PASS}  ContentBrief generated.\n`);
  console.log(`${ARROW}Premise:          "${brief.premise}"`);
  console.log(`${ARROW}Character:        "${brief.character}"`);
  console.log(`${ARROW}Vibe:             ${brief.vibe}`);
  console.log(`${ARROW}Edit instruction: "${brief.editInstruction}"`);
  console.log(`${ARROW}Image prompt:     "${brief.imagePrompt.slice(0, 100)}…"`);
  console.log(`${ARROW}Video prompt:     "${brief.videoPrompt.slice(0, 100)}…"`);
  console.log(`${ARROW}Shots:            ${brief.shots.length} defined`);

  const briefPath = save(`brief_${analysis.videoId}.json`, JSON.stringify(brief, null, 2));
  console.log(`${ARROW}Saved: ${briefPath}`);

  return brief;
}

async function stage4_qwen(
  analysis: VideoAnalysis,
  brief: ContentBrief
): Promise<{ editedDataUri: string; editedImagePath: string } | null> {
  bar("Stage 4 — Qwen-Image-Edit (ComfyUI @ 10.0.1.3:8188)");

  if (SKIP_QWEN || SKIP_VIDEO) {
    console.log(`${SKIP}  --skip-qwen or --skip-video flag set.`);
    return null;
  }

  if (!analysis.thumbnailDataUri) {
    console.log(`${FAIL}  No thumbnail available — cannot run Qwen edit.`);
    return null;
  }

  console.log(`${INFO}Instruction: "${brief.editInstruction}"`);
  console.log(`${INFO}Uploading frame to ComfyUI and queueing Qwen-Image-Edit-2509…`);

  try {
    const result = await editFrame(
      analysis.thumbnailDataUri,
      brief.editInstruction,
      `smoke_${analysis.videoId}`
    );

    console.log(`${PASS}  Qwen edit complete.`);
    console.log(`${ARROW}Saved: ${result.editedImagePath}`);

    // Also save a copy into smoke-output for easy inspection
    const buf = fs.readFileSync(result.editedImagePath);
    const copyPath = save(`edited_frame_${analysis.videoId}.png`, buf);
    console.log(`${ARROW}Copy: ${copyPath}`);

    return result;
  } catch (err) {
    console.log(`${FAIL}  Qwen-Image-Edit failed: ${(err as Error).message}`);
    return null;
  }
}

async function stage5_minimax(
  analysis: VideoAnalysis,
  brief: ContentBrief,
  editResult: { editedDataUri: string } | null
): Promise<void> {
  bar("Stage 5 — MiniMax H3 I2V (ComfyUI @ 10.0.1.3:8188)");

  if (SKIP_MINIMAX || SKIP_VIDEO) {
    console.log(`${SKIP}  --skip-minimax or --skip-video flag set.`);
    return;
  }

  const firstFrameUri = editResult?.editedDataUri ?? analysis.thumbnailDataUri;
  if (!firstFrameUri) {
    console.log(`${FAIL}  No frame available for MiniMax (no thumbnail, no edited frame).`);
    return;
  }

  const frameSource = editResult ? "Qwen-edited frame" : "raw thumbnail (Qwen edit skipped/failed)";
  console.log(`${INFO}First frame source: ${frameSource}`);
  console.log(`${INFO}Video prompt: "${brief.videoPrompt.slice(0, 120)}…"`);

  for (const dur of DURATIONS) {
    const overrides = dur > 0 ? { durationSec: dur } : undefined;
    const label = dur > 0 ? `${dur}s` : "default";
    console.log(`\n${INFO}Submitting ${label} job to ComfyUI MiniMax H3 workflow…`);
    try {
      const result = await dispatchToMinimax(brief, firstFrameUri, overrides);
      console.log(`${PASS}  MiniMax H3 ${result.durationSec}s generation complete.`);
      console.log(`${ARROW}prompt_id: ${result.taskId}`);
      console.log(`${ARROW}Duration:  ${result.durationSec}s`);
      console.log(`${ARROW}Saved:     ${result.generatedPath}`);

      // Copy into smoke-output with duration suffix when multiple runs
      const copySuffix = DURATIONS.length > 1 ? `_${result.durationSec}s` : "";
      const buf = fs.readFileSync(result.generatedPath);
      const copyPath = save(`generated_${analysis.videoId}${copySuffix}.mp4`, buf);
      console.log(`${ARROW}Copy:      ${copyPath}`);
    } catch (err) {
      console.log(`${FAIL}  MiniMax H3 ${label} dispatch failed: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary(
  passed: string[],
  failed: string[],
  skipped: string[]
): void {
  bar("Smoke Test Summary");
  if (passed.length)  console.log(`  Passed (${passed.length}):   ${passed.join(", ")}`);
  if (failed.length)  console.log(`  Failed (${failed.length}):   ${failed.join(", ")}`);
  if (skipped.length) console.log(`  Skipped (${skipped.length}): ${skipped.join(", ")}`);
  console.log(`\n  Output files: ${OUTPUT_DIR}`);
  console.log(failed.length === 0
    ? "\n  ✅ All stages passed — pipeline is healthy.\n"
    : `\n  ❌ ${failed.length} stage(s) failed — check output above.\n`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  bar("SLOP-LORD Pipeline Smoke Test");
  console.log(`  Video URL: ${VIDEO_URL}`);
  console.log(`  Output:    ${OUTPUT_DIR}`);
  if (SKIP_MINIMAX) console.log("  Mode: --skip-minimax");
  if (SKIP_QWEN)    console.log("  Mode: --skip-qwen");
  if (SKIP_VIDEO)   console.log("  Mode: --skip-video (Stages 4+5 skipped)");

  const passed:  string[] = [];
  const failed:  string[] = [];
  const skipped: string[] = [];

  // Stage 1: Chrome
  const chromeOk = await stage1_chrome();
  chromeOk ? passed.push("Stage 1 Chrome") : failed.push("Stage 1 Chrome");
  if (!chromeOk) {
    printSummary(passed, failed, skipped);
    return;
  }

  // Stage 2: Video analysis
  const analysis = await stage2_analyze(VIDEO_URL);
  analysis ? passed.push("Stage 2 Analysis") : failed.push("Stage 2 Analysis");
  if (!analysis) {
    printSummary(passed, failed, skipped);
    return;
  }

  // Stage 3: LM Studio brief
  const brief = await stage3_brief(analysis);
  brief ? passed.push("Stage 3 LM Studio") : failed.push("Stage 3 LM Studio");
  if (!brief) {
    printSummary(passed, failed, skipped);
    return;
  }

  // Stage 4: Qwen edit
  let editResult: { editedDataUri: string; editedImagePath: string } | null = null;
  if (SKIP_QWEN || SKIP_VIDEO) {
    skipped.push("Stage 4 Qwen Edit");
  } else {
    editResult = await stage4_qwen(analysis, brief);
    editResult ? passed.push("Stage 4 Qwen Edit") : failed.push("Stage 4 Qwen Edit");
  }

  // Stage 5: MiniMax
  if (SKIP_MINIMAX || SKIP_VIDEO) {
    skipped.push("Stage 5 MiniMax H3");
  } else {
    try {
      await stage5_minimax(analysis, brief, editResult);
      passed.push("Stage 5 MiniMax H3");
    } catch {
      failed.push("Stage 5 MiniMax H3");
    }
  }

  printSummary(passed, failed, skipped);
}

main()
  .catch((err) => {
    console.error("\nFatal error:", err);
  })
  .finally(async () => {
    await closeVideoAnalyzer();
    process.exit(0);
  });

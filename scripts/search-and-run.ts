#!/usr/bin/env tsx
/**
 * scripts/search-and-run.ts
 *
 * Search TikTok for a topic, pick the top video by view count, then run
 * the full smoke-test pipeline against it (analysis → brief → Qwen edit
 * → MiniMax H3 → upload).
 *
 * USAGE
 *   npx tsx scripts/search-and-run.ts dance
 *   npx tsx scripts/search-and-run.ts "cooking fail" --top=3 --skip-upload
 *   npx tsx scripts/search-and-run.ts skateboarding --max-cards=30 --scrolls=5
 *
 * FLAGS
 *   --top=N          Pick the Nth highest-view result instead of #1 (default: 1)
 *   --max-cards=N    How many search cards to collect (default: 20)
 *   --scrolls=N      How many scroll passes on the search page (default: 3)
 *   --skip-upload    Run through MiniMax but do not post to TikTok
 *   --skip-minimax   Run through Qwen edit only, skip MiniMax + upload
 *   --skip-qwen      Skip Qwen edit, send raw thumbnail to MiniMax
 *   --duration=N     Video duration in seconds (default: 5)
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import { searchTikTok, closeSearchScraper }    from "../harness/search-scraper.js";
import { analyzeVideo, closeVideoAnalyzer }    from "../harness/video-analyzer.js";
import { listModels }                          from "../parody-engine/llm.js";
import { generateBriefFromAnalysis }           from "../parody-engine/brief-generator.js";
import { editFrame }                           from "../parody-engine/qwen-image-edit.js";
import { dispatchToMinimax }                   from "../parody-engine/minimax-dispatch.js";
import { uploadToTikTok, buildCaption }        from "../harness/tiktok-uploader.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const query = args.find(a => !a.startsWith("--")) ?? "dance";

function argVal(name: string): string | undefined {
  const flag = args.find(a => a.startsWith(`--${name}=`));
  return flag?.split("=").slice(1).join("=");
}
function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const topN        = parseInt(argVal("top")       ?? "1", 10);
const maxCards    = parseInt(argVal("max-cards") ?? "20", 10);
const scrolls     = parseInt(argVal("scrolls")   ?? "3", 10);
const durationSec = parseFloat(argVal("duration") ?? "0");
const SKIP_UPLOAD  = hasFlag("skip-upload");
const SKIP_MINIMAX = hasFlag("skip-minimax");
const SKIP_QWEN    = hasFlag("skip-qwen");

const OUTPUT_DIR = path.resolve("./smoke-output");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const bar = (title: string) => {
  console.log(`\n${"─".repeat(62)}\n  ${title}\n${"─".repeat(62)}`);
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  bar(`Search-and-Run: "${query}"`);
  console.log(`  Top pick:    #${topN}`);
  console.log(`  Max cards:   ${maxCards}  Scroll passes: ${scrolls}`);
  if (SKIP_UPLOAD)  console.log("  --skip-upload");
  if (SKIP_MINIMAX) console.log("  --skip-minimax");
  if (SKIP_QWEN)    console.log("  --skip-qwen");

  // ── Step 1: Search ────────────────────────────────────────────────────────
  bar("Step 1 — TikTok Search");
  const results = await searchTikTok(query, { maxCards, scrollPasses: scrolls });

  if (results.length === 0) {
    console.error("  ❌  No results found for query. Exiting.");
    process.exit(1);
  }

  const pick = results[topN - 1] ?? results[0];
  console.log(`\n  ✅ Picked #${topN}: @${pick.author}  (${pick.viewsRaw} views)`);
  console.log(`     ${pick.videoUrl}`);

  // Close the search tab before analysis navigates the shared browser context
  await closeSearchScraper();

  // ── Step 2: Analyze ───────────────────────────────────────────────────────
  bar("Step 2 — Video Analysis");
  const analysis = await analyzeVideo(pick.videoUrl);
  if (!analysis) {
    console.error("  ❌  analyzeVideo returned null. Exiting.");
    process.exit(1);
  }
  console.log(`  ✅ @${analysis.author?.uniqueId}  ${analysis.stats.plays.toLocaleString()} plays`);
  console.log(`     "${analysis.description.slice(0, 80)}"`);
  console.log(`     ${analysis.durationSec}s  ${analysis.width}×${analysis.height}`);
  if (analysis.thumbnailDataUri) {
    const kb = Math.round(analysis.thumbnailDataUri.length * 0.75 / 1024);
    console.log(`     Thumbnail: ~${kb}KB`);
    const b64 = analysis.thumbnailDataUri.split(",")[1];
    fs.writeFileSync(path.join(OUTPUT_DIR, `search_thumb_${analysis.videoId}.jpg`), Buffer.from(b64, "base64"));
  }

  // ── Step 3: Brief ─────────────────────────────────────────────────────────
  bar("Step 3 — Brief Generation");
  const models = await listModels();
  console.log(`  LM Studio: ${models.join(", ")}`);

  const brief = await generateBriefFromAnalysis(analysis, analysis.videoId);
  if (!brief) {
    console.error("  ❌  Brief generation failed. Exiting.");
    process.exit(1);
  }
  console.log(`  ✅ Brief generated.`);
  console.log(`     Premise:     "${brief.premise}"`);
  console.log(`     Character:   "${brief.character}"`);
  console.log(`     Edit instr:  "${brief.editInstruction.slice(0, 100)}"`);
  console.log(`     Video prompt:"${brief.videoPrompt.slice(0, 100)}"`);
  fs.writeFileSync(
    path.join(OUTPUT_DIR, `search_brief_${analysis.videoId}.json`),
    JSON.stringify(brief, null, 2)
  );

  // ── Step 4: Qwen Edit ─────────────────────────────────────────────────────
  let editedDataUri: string | null = analysis.thumbnailDataUri;

  if (!SKIP_QWEN && !SKIP_MINIMAX) {
    bar("Step 4 — Qwen-Image-Edit + SGLang Verification");
    if (!analysis.thumbnailDataUri) {
      console.warn("  ⚠  No thumbnail — skipping Qwen edit.");
    } else {
      try {
        console.log(`  Instruction: "${brief.editInstruction.slice(0, 100)}"`);
        const result = await editFrame(
          analysis.thumbnailDataUri,
          brief.editInstruction,
          `search_${analysis.videoId}`,
        );
        editedDataUri = result.editedDataUri;
        console.log(`  ✅ Edit complete → ${result.editedImagePath}`);
        fs.copyFileSync(result.editedImagePath, path.join(OUTPUT_DIR, `search_edited_${analysis.videoId}.png`));
      } catch (err) {
        console.error(`  ❌  Qwen edit failed: ${(err as Error).message}`);
        console.warn("  Falling back to raw thumbnail.");
      }
    }
  } else {
    console.log(`  ⏭  Qwen edit skipped.`);
  }

  // ── Step 5: MiniMax ───────────────────────────────────────────────────────
  if (SKIP_MINIMAX) {
    console.log("\n  ⏭  MiniMax skipped (--skip-minimax).");
    return;
  }

  bar("Step 5 — MiniMax H3 I2V");
  if (!editedDataUri) {
    console.error("  ❌  No frame available for MiniMax. Exiting.");
    process.exit(1);
  }

  const overrides = durationSec > 0 ? { durationSec } : undefined;
  let generatedPath: string;
  let taskId: string;

  try {
    console.log(`  Prompt: "${brief.videoPrompt.slice(0, 100)}"`);
    const result = await dispatchToMinimax(brief, editedDataUri, overrides);
    generatedPath = result.generatedPath;
    taskId = result.taskId;
    console.log(`  ✅ Generated: ${generatedPath}  (${result.durationSec}s, prompt_id=${taskId})`);
    fs.copyFileSync(generatedPath, path.join(OUTPUT_DIR, `search_video_${analysis.videoId}.mp4`));
  } catch (err) {
    console.error(`  ❌  MiniMax dispatch failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // ── Step 6: Upload ────────────────────────────────────────────────────────
  if (SKIP_UPLOAD) {
    console.log("\n  ⏭  Upload skipped (--skip-upload).");
    console.log(`  Video saved: ${generatedPath}`);
    return;
  }

  bar("Step 6 — TikTok Upload");
  const hashtags = [
    ...analysis.hashtags.slice(0, 3),
    ...analysis.suggestedWords.slice(0, 2).map(w => w.replace(/\s+/g, "")),
    "fyp", "viral", "parody",
  ];
  const caption = buildCaption(brief.premise, [...new Set(hashtags)]);
  console.log(`  Caption: "${caption.slice(0, 100)}"`);

  try {
    const upload = await uploadToTikTok({ videoPath: generatedPath, caption, privacy: "Public" });
    if (upload.posted) {
      console.log(`  ✅ Posted!${upload.videoUrl ? `  → ${upload.videoUrl}` : ""}`);
    } else {
      console.warn("  ⚠  Upload did not confirm success — check TikTok Studio.");
    }
  } catch (err) {
    console.error(`  ❌  Upload failed: ${(err as Error).message}`);
  }
}

main()
  .catch(err => { console.error("\nFatal:", err); process.exit(1); })
  .finally(async () => { await closeSearchScraper(); await closeVideoAnalyzer(); process.exit(0); });

#!/usr/bin/env tsx
/**
 * scripts/upload-video.ts
 *
 * Upload a generated .mp4 to TikTok via TikTok Studio.
 * Uses the existing live Chrome session attached via CDP.
 *
 * USAGE
 *   npx tsx scripts/upload-video.ts \
 *     --video=generated/7676965869003492.mp4 \
 *     --caption="My caption text" \
 *     --tags="fyp,viral,parody,funny" \
 *     [--privacy=Public|Friends|Private]
 */

import "dotenv/config";
import path from "node:path";
import { uploadToTikTok, buildCaption } from "../harness/tiktok-uploader.js";
import { closeVideoAnalyzer } from "../harness/video-analyzer.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag?.split("=").slice(1).join("=");
}

const videoPath = arg("video");
const captionText = arg("caption") ?? "";
const tagsRaw = arg("tags") ?? "";
const privacy = (arg("privacy") ?? "Public") as "Public" | "Friends" | "Private";

if (!videoPath) {
  console.error("Usage: npx tsx scripts/upload-video.ts --video=<path> [--caption=<text>] [--tags=<t1,t2>] [--privacy=Public]");
  process.exit(1);
}

const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];
const caption = buildCaption(captionText, tags);
const absPath = path.resolve(videoPath);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log("─".repeat(60));
console.log("  TikTok Upload");
console.log("─".repeat(60));
console.log(`  Video:   ${absPath}`);
console.log(`  Caption: ${caption.slice(0, 100)}${caption.length > 100 ? "…" : ""}`);
console.log(`  Privacy: ${privacy}`);
console.log("");

const result = await uploadToTikTok({
  videoPath: absPath,
  caption,
  privacy,
  processingTimeoutSec: 180,
});

console.log("\n" + "─".repeat(60));
if (result.posted) {
  console.log("  ✅  Posted successfully");
  if (result.videoUrl) console.log(`  URL: ${result.videoUrl}`);
} else {
  console.log("  ❌  Upload did not confirm — check TikTok Studio manually");
}
console.log(`  uploadedAt: ${result.uploadedAt}`);
console.log("─".repeat(60));

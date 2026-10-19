/**
 * First-frame cartoon pass.
 *   ffmpeg grabs frame 0, then Qwen-Image-Edit on ComfyUI replaces people
 *   with cartoon versions of themselves.
 *
 *   npx tsx scripts/edit-first-frame.ts downloads/<id>.mp4
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { extractFirstFrame } from "../harness/video-downloader.js";
import { editFrame } from "../parody-engine/qwen-image-edit.js";

const videoPath = path.resolve(process.argv[2] ?? "./downloads/7686308126450093326.mp4");
const videoId = path.basename(videoPath, ".mp4");

const instruction = [
  "Replace every person with a cartoon version of that same person.",
  "Keep the same pose, clothing colors, background, and framing.",
  "Do not add or remove people.",
].join(" ");

const framePath = await extractFirstFrame(videoPath);
const frame = fs.readFileSync(framePath);
const dataUri = `data:image/png;base64,${frame.toString("base64")}`;
console.log(`[frame] ${framePath} (${(frame.length / 1024).toFixed(0)} KB)`);

const edited = await editFrame(dataUri, instruction, videoId);
console.log(`[frame] cartoon first frame: ${edited.editedImagePath}`);

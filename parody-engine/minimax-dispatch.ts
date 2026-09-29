/**
 * parody-engine/minimax-dispatch.ts
 *
 * Submits a MiniMax H3 Image-to-Video job to ComfyUI running on the
 * DGX Spark at 10.0.1.3:8188, polls for completion, and saves the video.
 *
 * EVERYTHING RUNS LOCALLY — no cloud API key required.
 * Both Qwen-Image-Edit and MiniMax H3 share the same ComfyUI instance.
 *
 * WORKFLOW STRUCTURE (flat /prompt graph — Phase 5 spec)
 * ────────────────────────────────────────────────────────────
 * Node "1"   — LoadImage               (uploaded first frame)
 * Node "2"   — UNETLoader              (minimax_h3_fl2va_pruned_int8_convrot.safetensors)
 * Node "3"   — CLIPLoader              (qwen3vl_32b_minimax_h3_nvfp4_awq, type: minimax)
 * Node "4"   — VAELoader               (minimax_h3_video_vae_fp16.safetensors)
 * Node "5"   — VAELoader               (minimax_h3_audio_vae_fp32.safetensors)
 * Node "6"   — MiniMaxH3ImageToVideo   → slot0: CONDITIONING, slot1: AV latent
 * Node "7"   — RandomNoise
 * Node "8"   — KSamplerSelect          (res_multistep)
 * Node "9"   — BasicScheduler          (simple, 20 steps, denoise 1.0)
 * Node "10"  — BasicGuider             (model + conditioning; no CFG, no negative)
 * Node "11"  — SamplerCustomAdvanced   → slot0: video latent, slot1: audio latent
 * Node "12"  — VAEDecode               (video latent → IMAGE batch)
 * Node "13"  — VAEDecodeAudio          (audio latent → AUDIO)
 * Node "14"  — CreateVideo             (IMAGE batch + AUDIO → VIDEO at 24fps)
 * Node "15"  — SaveVideo               (saves mp4 to output/video/)
 *
 * RETRIEVAL
 * SaveVideo outputs appear as { filename, subfolder, type } dicts in history outputs.
 * The video is retrieved via /view?filename=…&subfolder=…&type=output.
 *
 * FRAME GRID
 * MiniMax H3 requires frame count on the 17k+5 grid (5, 22, 39, 56, …, 125, …).
 * 5 seconds × 24fps = 120; nearest grid point = 125.
 * Formula: n = raw_frames; length = n + (5 - (n % 17)) % 17
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "../config/index.js";
import type { ContentBrief } from "./brief-generator.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DispatchResult {
  taskId:         string;    // ComfyUI prompt_id
  generatedPath:  string;    // absolute local path to the saved .mp4
  durationSec:    number;
}

// ---------------------------------------------------------------------------
// Shared ComfyUI helpers
// ---------------------------------------------------------------------------

function comfyUrl(p: string): string {
  return `http://${config.comfyui.host}:${config.comfyui.port}${p}`;
}

function ensureOutputDir(): string {
  const dir = path.resolve(config.minimax.outputDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Step 1: Upload the edited frame to ComfyUI /upload/image
// ---------------------------------------------------------------------------

async function uploadFrame(imageDataUri: string, stem: string): Promise<string> {
  const [header, b64] = imageDataUri.split(",", 2);
  const mime = header.match(/data:([^;]+)/)?.[1] ?? "image/png";
  const ext  = mime.split("/")[1] ?? "png";
  const filename = `slop_h3_${stem}.${ext}`;

  const form = new FormData();
  form.append("image", new Blob([Buffer.from(b64, "base64")], { type: mime }), filename);
  form.append("type", "input");
  form.append("overwrite", "true");

  const resp = await fetch(comfyUrl("/upload/image"), { method: "POST", body: form });
  if (!resp.ok) {
    throw new Error(`[minimax] Upload failed (${resp.status}): ${await resp.text().catch(() => "")}`);
  }
  const json = await resp.json() as { name?: string };
  if (!json.name) throw new Error(`[minimax] Upload response missing name`);
  return json.name;
}

// ---------------------------------------------------------------------------
// Step 2: Build the H3 I2V workflow using native ComfyUI nodes
// ---------------------------------------------------------------------------

/**
 * Compute frame count snapped to the MiniMax H3 17k+5 grid.
 * Valid counts: 5, 22, 39, 56, 73, 90, 107, 125, …
 * The grid ensures the temporal attention pattern divides evenly.
 */
function snapToH3Grid(seconds: number, fps = 24): number {
  const raw = Math.max(5, Math.round(seconds * fps));
  return raw + (5 - (raw % 17)) % 17;
}

function buildWorkflow(
  uploadedFilename: string,
  videoPrompt: string,
  seed: number,
  durationSec?: number
): Record<string, unknown> {
  const cfg    = config.minimax;
  const length = snapToH3Grid(durationSec ?? cfg.duration);

  return {
    // ── Source first frame ────────────────────────────────────────────────
    "1": {
      class_type: "LoadImage",
      inputs: { image: uploadedFilename },
    },

    // ── Model loaders ─────────────────────────────────────────────────────
    "2": {
      class_type: "UNETLoader",
      inputs: { unet_name: cfg.unetName, weight_dtype: "default" },
    },
    "3": {
      class_type: "CLIPLoader",
      inputs: { clip_name: cfg.clipName, type: "minimax" },
    },
    "4": {
      class_type: "VAELoader",
      inputs: { vae_name: cfg.vaeName },        // video VAE
    },
    "5": {
      class_type: "VAELoader",
      inputs: { vae_name: cfg.audioVaeName },   // audio VAE
    },

    // ── Conditioning + latent seed ─────────────────────────────────────────
    // slot 0 → CONDITIONING, slot 1 → AV latent (feeds SamplerCustomAdvanced)
    "6": {
      class_type: "MiniMaxH3ImageToVideo",
      inputs: {
        clip:        ["3", 0],
        vae:         ["4", 0],
        prompt:      videoPrompt,
        width:       cfg.width,
        height:      cfg.height,
        length,
        first_frame: ["1", 0],
        // last_frame intentionally omitted (I2V, not I2V with end anchor)
      },
    },

    // ── Sampling chain ────────────────────────────────────────────────────
    "7": {
      class_type: "RandomNoise",
      inputs: { noise_seed: seed },
    },
    "8": {
      class_type: "KSamplerSelect",
      inputs: { sampler_name: "res_multistep" },
    },
    "9": {
      class_type: "BasicScheduler",
      inputs: {
        model:     ["2", 0],
        scheduler: "simple",
        steps:     cfg.turboSteps,   // 20 in non-turbo config
        denoise:   1.0,
      },
    },
    // BasicGuider: no negative prompt, no CFG scale — conditioning path only
    "10": {
      class_type: "BasicGuider",
      inputs: {
        model:        ["2", 0],
        conditioning: ["6", 0],   // slot 0 of MiniMaxH3ImageToVideo
      },
    },
    "11": {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise:        ["7",  0],
        guider:       ["10", 0],
        sampler:      ["8",  0],
        sigmas:       ["9",  0],
        latent_image: ["6",  1],  // slot 1 of MiniMaxH3ImageToVideo = AV latent
      },
    },

    // ── Decode ────────────────────────────────────────────────────────────
    "12": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["11", 0],   // video latent (slot 0)
        vae:     ["4",  0],
      },
    },
    "13": {
      class_type: "VAEDecodeAudio",
      inputs: {
        samples: ["11", 1],   // audio latent (slot 1)
        vae:     ["5",  0],
      },
    },

    // ── Mux + save ────────────────────────────────────────────────────────
    "14": {
      class_type: "CreateVideo",
      inputs: {
        images: ["12", 0],
        audio:  ["13", 0],
        fps:    24.0,
      },
    },
    "15": {
      class_type: "SaveVideo",
      inputs: {
        video:           ["14", 0],
        filename_prefix: "video/MiniMax_H3",
        format:          "auto",
        codec:           "auto",
      },
    },
  };
}

async function queuePrompt(workflow: Record<string, unknown>): Promise<string> {
  const resp = await fetch(comfyUrl("/prompt"), {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ prompt: workflow, client_id: "slop-lord-h3" }),
  });
  if (!resp.ok) {
    throw new Error(`[minimax] /prompt failed (${resp.status}): ${await resp.text().catch(() => "")}`);
  }
  const json = await resp.json() as { prompt_id?: string; error?: unknown };
  if (json.error) throw new Error(`[minimax] Workflow error: ${JSON.stringify(json.error)}`);
  if (!json.prompt_id) throw new Error(`[minimax] No prompt_id in response`);
  return json.prompt_id;
}

// ---------------------------------------------------------------------------
// Step 3: Poll /history until complete, extract video filename
// VHS_VideoCombine writes to history output as { gifs: [{filename, ...}] }
// ---------------------------------------------------------------------------

// Item shape written by SaveVideo into /history outputs
interface SavedItem {
  filename:  string;
  subfolder?: string;
  type?:      string;
}

async function pollHistory(promptId: string): Promise<SavedItem> {
  const deadline = Date.now() + config.minimax.pollTimeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    await new Promise((r) => setTimeout(r, config.minimax.pollIntervalMs));

    const resp = await fetch(comfyUrl(`/history/${promptId}`));
    if (!resp.ok) continue;

    const history = await resp.json() as Record<string, {
      status?: { completed?: boolean; status_str?: string; messages?: Array<[string, Record<string, unknown>]> };
      outputs?: Record<string, Record<string, unknown>>;
    }>;

    const entry = history[promptId];
    if (!entry) continue;

    if (entry.status?.status_str === "error") {
      const errMsg = entry.status.messages
        ?.find(([t]) => t === "execution_error")
        ?.[1]?.exception_message as string | undefined;
      throw new Error(`[minimax] ComfyUI execution error for ${promptId}: ${errMsg ?? "(no message)"}`);
    }

    if (entry.status?.completed) {
      // SaveVideo writes each saved file as a { filename, subfolder, type } dict
      // inside an array value in the node's output bucket.
      for (const nodeOut of Object.values(entry.outputs ?? {})) {
        for (const bucket of Object.values(nodeOut)) {
          if (!Array.isArray(bucket)) continue;
          for (const item of bucket) {
            if (item && typeof item === "object" && "filename" in item) {
              const saved = item as SavedItem;
              console.log(`[minimax] Poll ${attempt}: complete → ${saved.subfolder ? saved.subfolder + "/" : ""}${saved.filename}`);
              return saved;
            }
          }
        }
      }
    }

    if (attempt % 6 === 0) {
      const elapsed = Math.round((Date.now() - (deadline - config.minimax.pollTimeoutMs)) / 1000);
      console.log(`[minimax] Poll ${attempt}: generating… (${elapsed}s elapsed)`);
    }
  }

  throw new Error(`[minimax] Timed out after ${config.minimax.pollTimeoutMs / 60_000}min`);
}

// ---------------------------------------------------------------------------
// Step 4: Retrieve generated video from /view and save locally
// ---------------------------------------------------------------------------

async function retrieveVideo(item: SavedItem, outputPath: string): Promise<void> {
  const params = new URLSearchParams({
    filename:  item.filename,
    subfolder: item.subfolder ?? "",
    type:      item.type ?? "output",
  });
  const url  = comfyUrl(`/view?${params.toString()}`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`[minimax] /view failed (${resp.status}) for ${item.filename}`);

  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outputPath, buf);

  const mb = (buf.length / 1024 / 1024).toFixed(1);
  console.log(`[minimax] Saved ${path.basename(outputPath)} (${mb} MB)`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs MiniMax H3 I2V on the DGX Spark via ComfyUI.
 * Uses the Qwen-edited frame as the first frame anchor.
 *
 * @param brief           ContentBrief with videoPrompt
 * @param firstFrameUri   The Qwen-edited frame as a data URI (or raw thumbnail fallback)
 */
export async function dispatchToMinimax(
  brief: ContentBrief,
  firstFrameUri: string,
  overrides?: { durationSec?: number }
): Promise<DispatchResult> {
  const durationSec = overrides?.durationSec ?? config.minimax.duration;
  const stem = brief.dossierId.replace(/-/g, "").slice(0, 16);
  const outputDir  = ensureOutputDir();
  // Include duration in filename so 3s and 5s outputs don't collide
  const suffix = durationSec !== config.minimax.duration ? `_${durationSec}s` : "";
  const outputPath = path.join(outputDir, `${stem}${suffix}.mp4`);

  if (fs.existsSync(outputPath)) {
    console.log(`[minimax] Already generated: ${path.basename(outputPath)}`);
    return { taskId: "cached", generatedPath: outputPath, durationSec };
  }

  console.log(`\n[minimax] Submitting H3 I2V to ComfyUI at ${config.comfyui.host}:${config.comfyui.port}`);
  console.log(`[minimax] Turbo: ${config.minimax.enableTurbo} | ${config.minimax.width}×${config.minimax.height} | ${durationSec}s`);
  console.log(`[minimax] Prompt: "${brief.videoPrompt.slice(0, 100)}…"`);

  // 1. Upload edited frame
  const uploadedName = await uploadFrame(firstFrameUri, stem);
  console.log(`[minimax] Uploaded frame → ${uploadedName}`);

  // 2. Queue workflow
  const seed = Math.floor(Math.random() * 2 ** 32);
  const workflow  = buildWorkflow(uploadedName, brief.videoPrompt, seed, durationSec);
  const promptId  = await queuePrompt(workflow);
  console.log(`[minimax] Queued → prompt_id=${promptId}`);

  // 3. Poll
  console.log(`[minimax] Polling every ${config.minimax.pollIntervalMs / 1000}s (timeout ${config.minimax.pollTimeoutMs / 60_000}min)…`);
  const savedItem = await pollHistory(promptId);

  // 4. Retrieve + save
  await retrieveVideo(savedItem, outputPath);

  return { taskId: promptId, generatedPath: outputPath, durationSec };
}

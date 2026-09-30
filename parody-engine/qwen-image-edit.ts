/**
 * parody-engine/qwen-image-edit.ts
 *
 * Sends a frame + edit instruction to Qwen-Image-Edit running inside
 * ComfyUI on the LAN, polls for completion, retrieves the edited image,
 * and saves it to ./edited-frames/<videoId>_edited.png.
 *
 * VERIFICATION LOOP
 * ─────────────────
 * After each Qwen edit pass, the result is sent to the SGLang multimodal
 * server (qwen3.8-27b @ 10.0.1.3:8888) alongside the original frame.
 * The verifier is asked whether the edit instruction was actually applied.
 * If not, the edit is retried with the verifier's feedback appended to the
 * instruction, up to config.sglang.verifyMaxPasses times.
 * Images sent to the verifier are downscaled to 135×240 (1/4 of 540×960)
 * for fast inference — full-res is preserved for the actual Qwen edit.
 *
 * WORKFLOW STRUCTURE (native ComfyUI nodes on ComfyUI 0.37.0)
 * ────────────────────────────────────────────────────────────
 * Node "10"  — UNETLoader          (qwen_image_edit_2511_bf16.safetensors)
 * Node "11"  — CLIPLoader          (qwen_2.5_vl_7b_fp8_scaled.safetensors, type: qwen_image)
 * Node "12"  — VAELoader           (qwen_image_vae.safetensors)
 * Node "13"  — LoraLoaderModelOnly (Lightning 4-step LoRA, optional turbo)
 * Node "20"  — LoadImage           (uploaded source frame)
 * Node "30"  — TextEncodeQwenImageEdit  (prompt + image conditioning)
 * Node "31"  — TextEncodeQwenImageEdit  (negative conditioning, empty)
 * Node "40"  — EmptyQwenImageLayeredLatentImage  (latent canvas)
 * Node "50"  — KSamplerAdvanced    (sampler)
 * Node "60"  — VAEDecode           (latent → pixel)
 * Node "70"  — SaveImage           (save to ComfyUI output dir)
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { config } from "../config/index.js";
import { visionComplete } from "./sglang.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QwenEditResult {
  editedImagePath: string;   // absolute local path to the edited PNG
  editedDataUri:   string;   // "data:image/png;base64,..." for MiniMax first_frame
  promptId:        string;   // ComfyUI prompt_id
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function comfyUrl(path_: string): string {
  return `http://${config.comfyui.host}:${config.comfyui.port}${path_}`;
}

function ensureOutputDir(): string {
  const dir = path.resolve(config.qwen.outputDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Step 1: Upload the source frame to ComfyUI /upload/image
// Returns the filename ComfyUI assigned it.
// ---------------------------------------------------------------------------

async function uploadImage(imageDataUri: string, suggestedName: string): Promise<string> {
  const [header, b64] = imageDataUri.split(",", 2);
  const mimeMatch = header.match(/data:([^;]+)/);
  const mime = mimeMatch?.[1] ?? "image/jpeg";
  const ext  = mime.split("/")[1] ?? "jpg";
  const filename = `${suggestedName}.${ext}`;
  const imageBytes = Buffer.from(b64, "base64");

  const form = new FormData();
  form.append("image", new Blob([imageBytes], { type: mime }), filename);
  form.append("type", "input");
  form.append("overwrite", "true");

  const resp = await fetch(comfyUrl("/upload/image"), { method: "POST", body: form });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`[qwen-edit] Upload failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  const json = await resp.json() as { name?: string };
  if (!json.name) throw new Error(`[qwen-edit] Upload response had no name: ${JSON.stringify(json)}`);
  return json.name;
}

// ---------------------------------------------------------------------------
// Step 2: Build the Qwen-Image-Edit workflow using native ComfyUI nodes
//
// Full graph:
//   UNETLoader → (optionally) LoraLoaderModelOnly → KSamplerAdvanced
//   CLIPLoader + LoadImage → TextEncodeQwenImageEdit (positive + negative)
//   VAELoader → EmptyQwenImageLayeredLatentImage
//   KSamplerAdvanced → VAEDecode → SaveImageAdvanced
// ---------------------------------------------------------------------------

/**
 * Snap a dimension to the nearest multiple of 64 (Qwen's latent grid requirement).
 * Always rounds up to avoid going below the minimum.
 */
function snapTo64(n: number): number {
  return Math.ceil(n / 64) * 64;
}

/**
 * Given a target aspect ratio (e.g. 768×1344), fit it inside Qwen's
 * recommended max (1024 on the long edge) while preserving the ratio
 * and snapping both axes to multiples of 64.
 */
function qwenCanvasSize(targetW: number, targetH: number): { width: number; height: number } {
  // Scale so the long edge is ≤ 1024, then snap both to 64
  const maxEdge = 1024;
  const scale   = Math.min(1, maxEdge / Math.max(targetW, targetH));
  return {
    width:  snapTo64(Math.round(targetW * scale)),
    height: snapTo64(Math.round(targetH * scale)),
  };
}

function buildWorkflow(
  uploadedFilename: string,
  editPrompt: string,
  seed: number,
  canvasWidth: number,
  canvasHeight: number,
): Record<string, unknown> {
  const cfg = config.qwen;
  // Use 4-step Lightning config when turbo is enabled; otherwise use standard steps
  const steps   = cfg.enableTurbo ? 4 : cfg.steps;
  const unetNode = cfg.enableTurbo ? "13" : "10";  // with LoRA vs without

  const nodes: Record<string, unknown> = {
    // ── Model loaders ─────────────────────────────────────────────────────
    "10": {
      class_type: "UNETLoader",
      inputs: {
        unet_name:    cfg.unetName,
        weight_dtype: "default",
      },
    },
    "11": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: cfg.clipName,
        type:      "qwen_image",
      },
    },
    "12": {
      class_type: "VAELoader",
      inputs: { vae_name: cfg.vaeName },
    },

    // ── Source image ───────────────────────────────────────────────────────
    "20": {
      class_type: "LoadImage",
      inputs: {
        image:  uploadedFilename,
        upload: "image",
      },
    },

    // ── Text conditioning (positive = edit instruction + source image) ─────
    "30": {
      class_type: "TextEncodeQwenImageEdit",
      inputs: {
        clip:   ["11", 0],
        prompt: editPrompt,
        vae:    ["12", 0],
        image:  ["20", 0],
      },
    },

    // ── Text conditioning (negative = empty) ──────────────────────────────
    "31": {
      class_type: "TextEncodeQwenImageEdit",
      inputs: {
        clip:   ["11", 0],
        prompt: " ",
        vae:    ["12", 0],
      },
    },

    // ── Latent canvas — sized to match the video output aspect ratio ───────
    "40": {
      class_type: "EmptyQwenImageLayeredLatentImage",
      inputs: {
        width:      canvasWidth,
        height:     canvasHeight,
        layers:     1,
        batch_size: 1,
      },
    },

    // ── Sampler ───────────────────────────────────────────────────────────
    "50": {
      class_type: "KSamplerAdvanced",
      inputs: {
        model:                     [unetNode, 0],
        add_noise:                 "enable",
        noise_seed:                seed,
        steps:                     steps,
        cfg:                       1.0,
        sampler_name:              "euler",
        scheduler:                 "simple",
        positive:                  ["30", 0],
        negative:                  ["31", 0],
        latent_image:              ["40", 0],
        start_at_step:             0,
        end_at_step:               steps,
        return_with_leftover_noise: "disable",
      },
    },

    // ── Decode + save ─────────────────────────────────────────────────────
    "60": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["50", 0],
        vae:     ["12", 0],
      },
    },
    "70": {
      class_type: "SaveImage",
      inputs: {
        images:          ["60", 0],
        filename_prefix: "slop_lord_qwen",
      },
    },
  };

  // Optionally inject the Lightning LoRA for 4-step turbo
  if (cfg.enableTurbo && cfg.loraName && cfg.loraName !== "") {
    nodes["13"] = {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model:          ["10", 0],
        lora_name:      cfg.loraName,
        strength_model: 1.0,
      },
    };
  }

  return nodes;
}

async function queuePrompt(workflow: Record<string, unknown>): Promise<string> {
  const body = { prompt: workflow, client_id: "slop-lord" };
  const resp = await fetch(comfyUrl("/prompt"), {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`[qwen-edit] /prompt failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  const json = await resp.json() as { prompt_id?: string; error?: unknown };
  if (json.error) throw new Error(`[qwen-edit] Workflow error: ${JSON.stringify(json.error)}`);
  if (!json.prompt_id) throw new Error(`[qwen-edit] No prompt_id in response`);
  return json.prompt_id;
}

// ---------------------------------------------------------------------------
// Step 3: Poll /history/{prompt_id} until outputs appear
// ---------------------------------------------------------------------------

async function pollHistory(promptId: string, timeoutMs = 600_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    await new Promise((r) => setTimeout(r, 4000));

    const resp = await fetch(comfyUrl(`/history/${promptId}`));
    if (!resp.ok) continue;

    const history = await resp.json() as Record<string, {
      status?: { completed?: boolean; status_str?: string };
      outputs?: Record<string, { images?: Array<{ filename: string; type: string }> }>;
    }>;

    const entry = history[promptId];
    if (!entry) continue;

    if (entry.status?.status_str === "error") {
      throw new Error(`[qwen-edit] ComfyUI execution error for prompt ${promptId}`);
    }

    if (entry.status?.completed) {
      for (const nodeOutputs of Object.values(entry.outputs ?? {})) {
        const images = nodeOutputs.images ?? [];
        const img = images.find((i) => i.type === "output");
        if (img) {
          console.log(`[qwen-edit] Poll ${attempt}: complete → ${img.filename}`);
          return img.filename;
        }
      }
    }

    if (attempt % 5 === 0) {
      const elapsed = Math.round((Date.now() - (deadline - timeoutMs)) / 1000);
      console.log(`[qwen-edit] Poll ${attempt}: generating… (${elapsed}s elapsed)`);
    }
  }

  throw new Error(`[qwen-edit] Timed out waiting for prompt ${promptId} after ${timeoutMs / 1000}s`);
}

// ---------------------------------------------------------------------------
// Step 4: Retrieve the generated image from /view and save locally
// ---------------------------------------------------------------------------

async function retrieveImage(filename: string, outputPath: string): Promise<string> {
  const url = comfyUrl(`/view?filename=${encodeURIComponent(filename)}&type=output`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`[qwen-edit] /view failed (${resp.status}) for ${filename}`);

  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outputPath, buf);

  const kb = Math.round(buf.length / 1024);
  console.log(`[qwen-edit] Saved edited frame (${kb}KB) → ${outputPath}`);

  const b64 = buf.toString("base64");
  return `data:image/png;base64,${b64}`;
}

// ---------------------------------------------------------------------------
// Step 5: Verification — ask SGLang (qwen3.8-27b) whether the edit landed
// ---------------------------------------------------------------------------

/**
 * Downscale a data URI to a small thumbnail for fast vision inference.
 * Target: 1/4 of the source long-edge, capped at 270px wide to keep the
 * payload tiny (~10–20 KB) without losing enough detail for edit verification.
 */
async function shrinkForVision(dataUri: string): Promise<string> {
  const b64 = dataUri.split(",", 2)[1];
  const buf = Buffer.from(b64, "base64");

  const resized = await sharp(buf)
    .resize({ width: 270, withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toBuffer();

  return `data:image/jpeg;base64,${resized.toString("base64")}`;
}

interface VerifyResult {
  passed: boolean;
  confidence: number;
  feedback: string;
}

async function verifyEdit(
  originalUri: string,
  editedUri: string,
  instruction: string,
): Promise<VerifyResult> {
  const [origSmall, editSmall] = await Promise.all([
    shrinkForVision(originalUri),
    shrinkForVision(editedUri),
  ]);

  const prompt = `You are a strict image edit verifier.
Edit instruction: "${instruction}"

First image = ORIGINAL. Second image = EDITED result.
Reply with JSON only, no prose:
{"passed": true|false, "confidence": 0.0-1.0, "feedback": "one sentence"}
"passed" is true only if the PRIMARY subject replacement is clearly visible. Did the edit succeed?`;

  const raw = await visionComplete(prompt, [origSmall, editSmall], {
    maxTokens: 150,
    temperature: 0,
  });

  if (!raw) return { passed: false, confidence: 0, feedback: "Verifier returned no response." };

  // Parse JSON — strip any accidental markdown fences
  const jsonStr = raw.replace(/```(?:json)?/g, "").trim();
  try {
    const parsed = JSON.parse(jsonStr) as Partial<VerifyResult>;
    return {
      passed:     !!parsed.passed,
      confidence: Number(parsed.confidence ?? 0),
      feedback:   String(parsed.feedback ?? ""),
    };
  } catch {
    // If parsing fails, do a simple keyword check on the raw text
    const passedHeuristic = /\bpassed\b.*true|\btrue\b.*passed/i.test(raw);
    return {
      passed:     passedHeuristic,
      confidence: 0.5,
      feedback:   raw.slice(0, 200),
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs Qwen-Image-Edit on a single frame via ComfyUI, with SGLang verification.
 *
 * After each edit pass the result is sent to qwen3.8-27b (SGLang) alongside
 * the original to check whether the instruction was actually applied.
 * If verification fails, the edit is retried with the verifier's feedback
 * appended to the instruction, up to config.sglang.verifyMaxPasses times.
 * The best-passing result is returned; if all passes fail verification the
 * last result is returned anyway (with a warning) so the pipeline continues.
 *
 * @param sourceDataUri   The original frame as a data URI (from thumbnailDataUri)
 * @param editInstruction The LLM-generated edit instruction
 * @param videoId         Used as the output filename stem
 * @param targetWidth     Desired output width (defaults to config.minimax.width)
 * @param targetHeight    Desired output height (defaults to config.minimax.height)
 */
export async function editFrame(
  sourceDataUri: string,
  editInstruction: string,
  videoId: string,
  targetWidth?: number,
  targetHeight?: number,
): Promise<QwenEditResult> {
  const outputDir = ensureOutputDir();
  const outputPath = path.join(outputDir, `${videoId}_edited.png`);

  // Idempotent: skip if already done
  if (fs.existsSync(outputPath)) {
    console.log(`[qwen-edit] Already edited: ${videoId}_edited.png`);
    const buf  = fs.readFileSync(outputPath);
    const b64  = buf.toString("base64");
    return {
      editedImagePath: outputPath,
      editedDataUri:   `data:image/png;base64,${b64}`,
      promptId:        "cached",
    };
  }

  // Derive canvas size from the video output dimensions (preserves aspect ratio,
  // long edge capped at 1024, both axes snapped to multiples of 64).
  const tW = targetWidth  ?? config.minimax.width;
  const tH = targetHeight ?? config.minimax.height;
  const { width: canvasW, height: canvasH } = qwenCanvasSize(tW, tH);

  console.log(`\n[qwen-edit] Editing frame for video ${videoId}`);
  console.log(`[qwen-edit] Canvas: ${canvasW}×${canvasH} (from target ${tW}×${tH})`);

  const maxPasses = config.sglang.verifyMaxPasses;
  let currentInstruction = editInstruction;
  let lastDataUri: string | null = null;
  let lastPromptId = "";
  let lastOutputPath = outputPath;

  for (let pass = 1; pass <= maxPasses; pass++) {
    console.log(`[qwen-edit] Pass ${pass}/${maxPasses} — instruction: "${currentInstruction.slice(0, 100)}"`);

    // Use a per-pass filename so we don't collide; promote the winner at the end
    const passPath = pass === 1
      ? outputPath.replace(/\.png$/, `_pass1.png`)
      : outputPath.replace(/\.png$/, `_pass${pass}.png`);

    // 1. Upload source frame
    const uploadedName = await uploadImage(sourceDataUri, `slop_src_${videoId}_p${pass}`);

    // 2. Queue workflow
    const seed     = config.qwen.seed === -1
      ? Math.floor(Math.random() * 2 ** 32)
      : config.qwen.seed;
    const workflow = buildWorkflow(uploadedName, currentInstruction, seed, canvasW, canvasH);
    const promptId = await queuePrompt(workflow);
    console.log(`[qwen-edit] Queued → prompt_id=${promptId}`);

    // 3. Poll + retrieve
    const outputFilename = await pollHistory(promptId);
    const editedDataUri  = await retrieveImage(outputFilename, passPath);

    lastDataUri   = editedDataUri;
    lastPromptId  = promptId;
    lastOutputPath = passPath;

    // 4. Verify with SGLang
    console.log(`[qwen-edit] Verifying pass ${pass} with SGLang…`);
    const verify = await verifyEdit(sourceDataUri, editedDataUri, editInstruction);
    console.log(`[qwen-edit] Verify pass ${pass}: passed=${verify.passed} conf=${verify.confidence.toFixed(2)} — "${verify.feedback}"`);

    if (verify.passed) {
      // Promote to canonical output path
      fs.copyFileSync(passPath, outputPath);
      console.log(`[qwen-edit] ✓ Verification passed on pass ${pass} → ${path.basename(outputPath)}`);
      return { editedImagePath: outputPath, editedDataUri, promptId };
    }

    if (pass < maxPasses) {
      // Augment the instruction with the verifier's feedback for the next pass
      currentInstruction = `${editInstruction}\n\nPrevious attempt failed: ${verify.feedback}. Make the change MORE obvious and dramatic.`;
    }
  }

  // All passes exhausted — use the last result and warn
  console.warn(`[qwen-edit] ⚠ Verification failed after ${maxPasses} passes — using last result anyway.`);
  fs.copyFileSync(lastOutputPath, outputPath);
  return {
    editedImagePath: outputPath,
    editedDataUri:   lastDataUri!,
    promptId:        lastPromptId,
  };
}

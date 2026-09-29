/**
 * parody-engine/qwen-image-edit.ts
 *
 * Sends a frame + edit instruction to Qwen-Image-Edit running inside
 * ComfyUI on the LAN, polls for completion, retrieves the edited image,
 * and saves it to ./edited-frames/<videoId>_edited.png.
 *
 * HOW IT WORKS
 * ────────────
 * ComfyUI exposes a REST API at http://<host>:8188:
 *
 *   POST /prompt          — queues a workflow; returns { prompt_id }
 *   GET  /history/{id}    — returns execution state + output filenames
 *   GET  /view?filename=… — retrieves a saved image by filename
 *   POST /upload/image    — uploads an image into ComfyUI's input directory
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
 * Node "70"  — SaveImageAdvanced   (save to ComfyUI output dir)
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "../config/index.js";

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

function buildWorkflow(uploadedFilename: string, editPrompt: string, seed: number): Record<string, unknown> {
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

    // ── Latent canvas (1024×1024, 1 layer, batch 1) ───────────────────────
    "40": {
      class_type: "EmptyQwenImageLayeredLatentImage",
      inputs: {
        width:      1024,
        height:     1024,
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
  if (cfg.enableTurbo && cfg.loraName && cfg.loraName !== "None") {
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

async function pollHistory(promptId: string, timeoutMs = 300_000): Promise<string> {
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs Qwen-Image-Edit on a single frame via ComfyUI.
 *
 * @param sourceDataUri   The original frame as a data URI (from thumbnailDataUri)
 * @param editInstruction The LLM-generated edit instruction
 * @param videoId         Used as the output filename stem
 */
export async function editFrame(
  sourceDataUri: string,
  editInstruction: string,
  videoId: string
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

  console.log(`\n[qwen-edit] Editing frame for video ${videoId}`);
  console.log(`[qwen-edit] Instruction: "${editInstruction.slice(0, 100)}"`);

  // 1. Upload source frame
  const uploadedName = await uploadImage(sourceDataUri, `slop_src_${videoId}`);
  console.log(`[qwen-edit] Uploaded source frame → ${uploadedName}`);

  // 2. Build workflow + queue prompt
  const seed     = config.qwen.seed === -1
    ? Math.floor(Math.random() * 2 ** 32)
    : config.qwen.seed;
  const workflow = buildWorkflow(uploadedName, editInstruction, seed);
  const promptId = await queuePrompt(workflow);
  console.log(`[qwen-edit] Queued → prompt_id=${promptId}`);

  // 3. Poll history
  const outputFilename = await pollHistory(promptId);

  // 4. Retrieve + save
  const editedDataUri = await retrieveImage(outputFilename, outputPath);

  return { editedImagePath: outputPath, editedDataUri, promptId };
}

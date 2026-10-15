/**
 * parody-engine/sglang.ts
 *
 * Vision inference client — routes to the correct backend based on
 * config.inference.vision / config.inference.verify.
 *
 * Two exported functions:
 *   visionComplete()  — thumbnail analysis, brief image context (inference.vision)
 *   verifyComplete()  — Qwen-edit pass/fail judge (inference.verify)
 *
 * Both accept image_url arrays. The backend is expected to respond in
 * choices[0].message.content (enable_thinking: false where supported).
 */

import { config } from "../config/index.js";
import type { InferenceBackend } from "../config/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VisionOptions {
  temperature?: number;
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Core — shared by both roles
// ---------------------------------------------------------------------------

async function callVisionBackend(
  backend: InferenceBackend,
  userText: string,
  imageUris: string[],
  opts: VisionOptions = {}
): Promise<string | null> {
  const content: Array<
    | { type: "image_url"; image_url: { url: string } }
    | { type: "text"; text: string }
  > = [
    ...imageUris.map((uri) => ({
      type: "image_url" as const,
      image_url: { url: uri },
    })),
    { type: "text" as const, text: userText },
  ];

  const body: Record<string, unknown> = {
    model:       backend.model,
    messages:    [{ role: "user", content }],
    // Reasoning models need headroom for the <think>...</think> block before the answer.
    // 1024 covers ~200 tokens of reasoning + the actual response.
    max_tokens:  opts.maxTokens  ?? 1024,
    temperature: opts.temperature ?? 0,
  };

  // SGLang / Qwen3: disable chain-of-thought for fast direct answers
  if (backend.enableThinking === false) {
    body.chat_template_kwargs = { enable_thinking: false };
  }

  const label = `[sglang:${backend.model.split("-")[0]}]`;

  let resp: Response;
  try {
    resp = await fetch(`${backend.baseUrl}/chat/completions`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    console.error(`${label} Network error: ${(err as Error).message}`);
    return null;
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error(`${label} ${resp.status}: ${text.slice(0, 200)}`);
    return null;
  }

  const json = await resp.json() as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    error?: { message?: string };
  };

  if (json.error) {
    console.error(`${label} Error: ${json.error.message}`);
    return null;
  }

  const msg = json.choices?.[0]?.message;
  // Prefer content; fall back to reasoning_content for models that think first
  return msg?.content?.trim() || msg?.reasoning_content?.trim() || null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Vision completion for thumbnail analysis and brief image context.
 * Uses config.inference.vision backend.
 *
 * @param userText   The text prompt
 * @param imageUris  One or more data URIs
 */
export async function visionComplete(
  userText: string,
  imageUris: string[],
  opts: VisionOptions = {}
): Promise<string | null> {
  return callVisionBackend(config.inference.vision, userText, imageUris, opts);
}

/**
 * Verification completion for Qwen-edit pass/fail judging.
 * Uses config.inference.verify backend (may be same endpoint as vision).
 *
 * @param userText   The verification prompt (includes instruction + JSON format request)
 * @param imageUris  [original, edited] data URIs
 */
export async function verifyComplete(
  userText: string,
  imageUris: string[],
  opts: VisionOptions = {}
): Promise<string | null> {
  return callVisionBackend(config.inference.verify, userText, imageUris, opts);
}

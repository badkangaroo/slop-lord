/**
 * parody-engine/sglang.ts
 *
 * Thin client for the SGLang multimodal server on the DGX Spark (10.0.1.3:8888).
 * Model: qwen3.8-27b-sglang — accepts image_url inputs, responds in content
 * (not reasoning_content) when enable_thinking is false.
 *
 * Used exclusively for vision verification tasks — not for text generation.
 */

import { config } from "../config/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SglangOptions {
  temperature?: number;
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Send a vision prompt to SGLang with one or two images.
 * Returns the text response, or null on error.
 *
 * @param userText     The text part of the prompt
 * @param imageUris    Array of data URIs (1 or 2 images)
 * @param opts
 */
export async function visionComplete(
  userText: string,
  imageUris: string[],
  opts: SglangOptions = {}
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

  const body = {
    model:       config.sglang.model,
    messages:    [{ role: "user", content }],
    max_tokens:  opts.maxTokens  ?? 256,
    temperature: opts.temperature ?? 0,
    // Disable chain-of-thought — we want fast direct answers, not reasoning traces
    chat_template_kwargs: { enable_thinking: false },
  };

  let resp: Response;
  try {
    resp = await fetch(`${config.sglang.baseUrl}/chat/completions`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[sglang] Network error: ${(err as Error).message}`);
    return null;
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error(`[sglang] ${resp.status}: ${text.slice(0, 200)}`);
    return null;
  }

  const json = await resp.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (json.error) {
    console.error(`[sglang] Error: ${json.error.message}`);
    return null;
  }

  return json.choices?.[0]?.message?.content?.trim() ?? null;
}

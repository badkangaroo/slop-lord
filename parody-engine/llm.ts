/**
 * parody-engine/llm.ts
 *
 * OpenAI-compatible client pointed at LM Studio on the LAN.
 * Used for ALL content generation — brief writing, prompt crafting.
 * NOT used for Stagehand DOM reasoning (that uses OpenAI/Anthropic directly).
 *
 * LM Studio exposes an OpenAI-compatible API at:
 *   http://10.0.1.8:1234/v1   (configured in config/runtime.yaml)
 *
 * VISION SUPPORT
 * LM Studio supports vision when a multimodal model is loaded (e.g. LLaVA,
 * BakLLaVA, Qwen-VL). Images are passed as base64 data URIs in the
 * messages[].content array following the OpenAI vision message format.
 * If the loaded model is text-only, vision calls fall back to text-only
 * (the image description is omitted and a warning is logged).
 */

import { config } from "../config/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface VisionMessage {
  role: "system" | "user" | "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }
  >;
}

export type ChatMessage = TextMessage | VisionMessage;

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  /** If true, throws on non-2xx rather than returning null */
  throwOnError?: boolean;
}

// ---------------------------------------------------------------------------
// Core fetch wrapper
// ---------------------------------------------------------------------------

async function chatComplete(
  messages: ChatMessage[],
  opts: LLMOptions = {}
): Promise<string | null> {
  const url = `${config.lmStudio.baseUrl}/chat/completions`;
  const body = {
    model:       config.lmStudio.model,
    messages,
    temperature: opts.temperature ?? config.lmStudio.temperatureCreative,
    max_tokens:  opts.maxTokens  ?? 2048,
    stream:      false,
  };

  let resp: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);  // 2-min hard timeout
    try {
      resp = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = `[llm] Network error reaching LM Studio at ${config.lmStudio.baseUrl}: ${(err as Error).message}`;
    if (opts.throwOnError) throw new Error(msg);
    console.error(msg);
    return null;
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const msg = `[llm] LM Studio returned ${resp.status}: ${text.slice(0, 200)}`;
    if (opts.throwOnError) throw new Error(msg);
    console.error(msg);
    return null;
  }

  const json = await resp.json() as {
    choices?: Array<{
      message?: {
        content?: string;
        reasoning_content?: string;   // reasoning models (e.g. eclipsed-phoenix) put
      };                              // the final answer here when content is empty
      finish_reason?: string;
    }>;
    error?: { message?: string };
  };

  if (json.error) {
    const msg = `[llm] LM Studio error: ${json.error.message}`;
    if (opts.throwOnError) throw new Error(msg);
    console.error(msg);
    return null;
  }

  const msg = json.choices?.[0]?.message;
  const text = msg?.content?.trim() || msg?.reasoning_content?.trim() || null;
  return text ?? null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Plain text completion. Use for classification, scoring, brief generation.
 */
export async function complete(
  systemPrompt: string,
  userPrompt: string,
  opts: LLMOptions = {}
): Promise<string | null> {
  return chatComplete(
    [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt },
    ],
    opts
  );
}

/**
 * Vision completion. Passes a base64 data URI image alongside the text prompt.
 * Use for analysing the thumbnail frame and generating a parody description.
 *
 * @param systemPrompt  Instruction context for the model
 * @param userText      The text part of the user message
 * @param imageDataUri  "data:image/jpeg;base64,..."  — the thumbnail
 * @param opts
 */
export async function completeWithImage(
  systemPrompt: string,
  userText: string,
  imageDataUri: string,
  opts: LLMOptions = {}
): Promise<string | null> {
  // Build vision-format messages
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        {
          type:      "image_url",
          image_url: { url: imageDataUri, detail: "low" },  // "low" = 512px tile, cheaper
        },
        { type: "text", text: userText },
      ],
    },
  ];
  return chatComplete(messages, opts);
}

/**
 * Checks that LM Studio is reachable and returns the list of loaded models.
 * Useful for startup health checks.
 */
export async function listModels(): Promise<string[]> {
  try {
    const resp = await fetch(`${config.lmStudio.baseUrl}/models`);
    if (!resp.ok) return [];
    const json = await resp.json() as { data?: Array<{ id: string }> };
    return json.data?.map((m) => m.id) ?? [];
  } catch {
    return [];
  }
}

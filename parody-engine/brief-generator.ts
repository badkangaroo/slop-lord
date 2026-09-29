/**
 * parody-engine/brief-generator.ts
 *
 * Takes a TrendDossier + thumbnail and asks LM Studio to produce a
 * ContentBrief: a structured description of what to generate.
 *
 * TWO STEPS
 * ---------
 * 1. Vision call (if thumbnail available):
 *    Feed the thumbnail to the model with a system prompt instructing it
 *    to describe what it sees in maximally unhinged, bizarre terms.
 *
 * 2. Brief generation call:
 *    Combine the visual description + dossier metadata to produce a
 *    structured ContentBrief JSON: image_prompt, video_prompt, vibe,
 *    character, premise.
 *
 * The image_prompt feeds directly into ComfyUI (if used) or becomes
 * the first_frame description for MiniMax H3.
 * The video_prompt is the full MiniMax generation prompt.
 */

import { complete, completeWithImage } from "./llm.js";
import { config } from "../config/index.js";
import type { TrendDossier } from "../db/schema.js";
import type { VideoAnalysis } from "../harness/video-analyzer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContentBrief {
  dossierId:       string;
  premise:         string;       // one-sentence "what is this video about" (parody version)
  character:       string;       // the protagonist / entity in the video
  /**
   * Instruction for Qwen-Image-Edit.
   * Written as a direct editing command, e.g.:
   *   "Replace the person in the video with a giant sentient baguette wearing sunglasses
   *    and a backwards cap. Keep the background exactly the same."
   */
  editInstruction: string;
  imagePrompt:     string;       // image generation prompt (Stable Diffusion style, for reference)
  videoPrompt:     string;       // full video generation prompt for MiniMax H3
  vibe:            string;       // e.g. "unhinged-chaos", "dark-absurd"
  shots:           ShotNote[];   // suggested camera directions
  kokoroVoiceTag:  string | null;
}

export interface ShotNote {
  order:       number;
  description: string;
  cameraCommand?: string;    // MiniMax camera syntax e.g. "[Push in]"
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const VISION_SYSTEM = `You are a deranged creative director who looks at TikTok frames and invents the most visually jarring, physically impossible, wrong-scale parody replacements imaginable.

Rules:
- One sentence: describe exactly what you SEE (subject, setting, lighting, what they're doing).
- Then propose a replacement subject that is: the wrong material (e.g. made of food, jelly, chrome, raw meat, cardboard), the wrong scale (enormous or microscopic), doing the action with complete earnestness despite being absurd.
- The replacement must look VISUALLY WRONG — a deliberate uncanny mismatch with the setting.
- Be hyper-specific: name the exact material, texture, size, expression, and what body part or feature is most incongruous.
- Stay safe-for-work. Output plain text, 3-5 sentences maximum.`;

const BRIEF_SYSTEM = `You are a content brief generator for a TikTok parody pipeline.
Given metadata about a trending TikTok video and a creative reimagining of its thumbnail,
output a structured JSON content brief.

RULES:
- "editInstruction" is the MOST IMPORTANT field. It is a direct image editing command
  for Qwen-Image-Edit that transforms the first frame into a visually jarring parody.

  The replacement MUST have ALL THREE of these properties:
    1. WRONG MATERIAL — made of something it shouldn't be (raw chicken, wet cardboard,
       melting wax, cheap plastic, stained glass, raw dough, shag carpet, tinfoil, jelly)
    2. WRONG SCALE — either comically oversized (fills the frame) or absurdly tiny
    3. WRONG EXPRESSION — doing the action with intense sincere focus despite being ridiculous

  Format: "Replace [subject] with [specific absurd replacement with material + scale + expression].
  Keep the [background/setting] exactly the same. [One specific texture or lighting detail to preserve]."

  Bad example (too tame): "Replace the person with a giant sentient wheel of cheese."
  Good example: "Replace the person with a 7-foot-tall raw chicken wearing tiny sunglasses,
    posed heroically at the edge of the pool with one wing outstretched. The chicken's skin
    is visibly wet and glistening. Keep the suburban backyard and blue water exactly as-is."

  Another good example: "Replace the dog with a single large boiled egg the size of a
    microwave, balanced upright on the sofa cushions with two toothpick arms reaching
    forward. Keep all furniture and room lighting unchanged."

- "imagePrompt" is a Stable Diffusion style description of the RESULT after the edit —
  describe what the edited first frame will look like, including the absurd replacement in full detail.
- "videoPrompt" describes the full video action, max 500 characters.
  Include 1-2 MiniMax camera commands like [Push in] or [Tracking shot].
  The subject must match the editInstruction replacement. Lean into the physical wrongness.
- "character" is the absurd replacement — be hyper-specific (material, size, key visual detail).
- "premise" is a 1-sentence logline of the parody.
- "vibe" must be one of: unhinged-chaos, cringe-sincere, dry-deadpan, hype-energy,
  wholesome-silly, dark-absurd, tutorial-parody, roast-callout.
- "shots" is an array of 2-3 suggested visual moments with camera commands.
- "kokoroVoiceTag" is a voice style tag string or null.

Respond with ONLY valid JSON matching this exact shape:
{
  "premise": "...",
  "character": "...",
  "editInstruction": "Replace the person with ...",
  "imagePrompt": "...",
  "videoPrompt": "...",
  "vibe": "...",
  "shots": [
    { "order": 1, "description": "...", "cameraCommand": "[Static shot]" }
  ],
  "kokoroVoiceTag": null
}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildUserPrompt(
  dossier: TrendDossier,
  visualDescription: string | null
): string {
  const meta = dossier.sourceMetadata as Record<string, string> | null;
  const stats = dossier.stats as Record<string, number> | null;
  const template = dossier.template as Record<string, unknown> | null;

  return `TRENDING VIDEO METADATA:
Hook: ${dossier.hook}
Vibe detected: ${dossier.vibe}
Content labels: ${(template?.contentLabels as string[] | undefined)?.join(", ") ?? "unknown"}
Suggested search words: ${(template?.suggestedWords as string[] | undefined)?.join(", ") ?? "none"}
Author: @${meta?.author ?? "unknown"}
Plays: ${stats?.plays?.toLocaleString() ?? "?"}  Likes: ${stats?.likes?.toLocaleString() ?? "?"}
Music: ${(template?.music as { title?: string } | null | undefined)?.title ?? "unknown"}
Transcript snippet: ${((template?.transcript as string | undefined) ?? "").slice(0, 300) || "(no transcript)"}

${visualDescription ? `VISUAL REIMAGINING OF FIRST FRAME:\n${visualDescription}` : "No thumbnail available — invent a visual from the metadata above."}

Generate a parody content brief for this trend. Make it ridiculous, weird, and unexpected while keeping the core viral hook recognisable.`;
}

function extractJson(text: string): Record<string, unknown> | null {
  // Try fenced block first, then the largest raw JSON object
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const rawMatch = text.match(/\{[\s\S]*\}/);
  const candidate = fenced?.[1]?.trim() ?? rawMatch?.[0]?.trim();
  if (!candidate) return null;

  // Tier 1: direct parse
  try { return JSON.parse(candidate); } catch { /* fall through */ }

  // Tier 2: repair truncated JSON
  // Handles the common case where the model cuts off mid-string value.
  // a) Remove any trailing incomplete key+value ("key": partial...)
  // b) Remove trailing commas
  // c) Balance open [ and { with matching ] and }
  let repaired = candidate;
  // Remove a truncated string value at the very end (no closing quote)
  repaired = repaired.replace(/,?\s*"[^"]+"\s*:\s*"[^"]*$/, "");
  // Remove trailing comma left by the above
  repaired = repaired.replace(/,\s*$/, "");
  // Count and balance brackets
  const openBraces    = (repaired.match(/\{/g) ?? []).length;
  const closeBraces   = (repaired.match(/\}/g) ?? []).length;
  const openBrackets  = (repaired.match(/\[/g) ?? []).length;
  const closeBrackets = (repaired.match(/\]/g) ?? []).length;
  repaired += "]".repeat(Math.max(0, openBrackets - closeBrackets));
  repaired += "}".repeat(Math.max(0, openBraces  - closeBraces));
  try { return JSON.parse(repaired); } catch { /* fall through */ }

  // Tier 3: field-by-field regex extraction
  // Last resort when the JSON is too mangled to fix structurally.
  const extract = (key: string) =>
    text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]{1,1000})"`))?.[1] ?? null;
  const premise = extract("premise");
  if (!premise) return null;   // nothing salvageable
  return {
    premise:         premise,
    character:       extract("character")       ?? "(no character)",
    editInstruction: extract("editInstruction") ?? "Replace the main subject with a bizarre unexpected version.",
    imagePrompt:     extract("imagePrompt")     ?? "",
    videoPrompt:     extract("videoPrompt")     ?? `${premise} [Push in]`,
    vibe:            extract("vibe")            ?? "unhinged-chaos",
    shots:           [],
    kokoroVoiceTag:  null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a ContentBrief from a TrendDossier.
 *
 * @param dossier         The promoted trend dossier
 * @param thumbnailDataUri  Base64 data URI of the first frame (or null)
 */
export async function generateBrief(
  dossier: TrendDossier,
  thumbnailDataUri: string | null
): Promise<ContentBrief | null> {
  console.log(`[brief-generator] Generating brief for dossier ${dossier.id}…`);

  // Step 1: Visual analysis of thumbnail (if available)
  let visualDescription: string | null = null;
  if (thumbnailDataUri) {
    console.log("[brief-generator] Sending thumbnail to LM Studio for visual analysis…");
    visualDescription = await completeWithImage(
      VISION_SYSTEM,
      "Describe this TikTok frame and propose a bizarre parody reimagining.",
      thumbnailDataUri,
      { temperature: 0.9, maxTokens: 512 }
    );
    if (visualDescription) {
      console.log(`[brief-generator] Visual description: ${visualDescription.slice(0, 100)}…`);
    } else {
      console.warn("[brief-generator] Vision call returned null — proceeding without image context.");
    }
  }

  // Step 2: Generate the full brief
  const userPrompt = buildUserPrompt(dossier, visualDescription);
  const rawBrief = await complete(BRIEF_SYSTEM, userPrompt, {
    temperature: config_temperature_creative(),
    maxTokens:   2048,
  });

  if (!rawBrief) {
    console.error("[brief-generator] LM Studio returned null for brief generation.");
    return null;
  }

  const parsed = extractJson(rawBrief);
  if (!parsed) {
    console.error("[brief-generator] Could not parse JSON from LM Studio response:");
    console.error(rawBrief.slice(0, 500));
    return null;
  }

  return {
    dossierId:       dossier.id,
    premise:         String(parsed.premise         ?? "(no premise)"),
    character:       String(parsed.character       ?? "(no character)"),
    editInstruction: String(parsed.editInstruction ?? `Replace the main subject with a bizarre unexpected version. Keep the background the same.`),
    imagePrompt:     String(parsed.imagePrompt     ?? ""),
    videoPrompt:     String(parsed.videoPrompt     ?? ""),
    vibe:            String(parsed.vibe            ?? dossier.vibe),
    shots:           (parsed.shots as ShotNote[])  ?? [],
    kokoroVoiceTag:  parsed.kokoroVoiceTag ? String(parsed.kokoroVoiceTag) : null,
  };
}

function config_temperature_creative(): number {
  return config.lmStudio.temperatureCreative;
}

/**
 * Generates a ContentBrief directly from a VideoAnalysis object.
 * Used by the smoke test and any path that doesn't go through the DB dossier flow.
 * Builds the same context prompt as generateBrief() but sources all fields
 * from the live VideoAnalysis instead of a stored TrendDossier.
 *
 * @param analysis  The VideoAnalysis returned by analyzeVideo()
 * @param videoId   Stable ID string used as the dossierId placeholder in the brief
 */
export async function generateBriefFromAnalysis(
  analysis: VideoAnalysis,
  videoId: string
): Promise<ContentBrief | null> {
  console.log(`[brief-generator] Generating brief from live analysis for ${videoId}…`);

  // Step 1: Vision call on the thumbnail
  let visualDescription: string | null = null;
  if (analysis.thumbnailDataUri) {
    console.log("[brief-generator] Sending thumbnail to LM Studio for visual analysis…");
    visualDescription = await completeWithImage(
      VISION_SYSTEM,
      "Describe this TikTok frame and propose a bizarre parody reimagining.",
      analysis.thumbnailDataUri,
      { temperature: 0.9, maxTokens: 512 }
    );
    if (visualDescription) {
      console.log(`[brief-generator] Visual description: ${visualDescription.slice(0, 120)}…`);
    } else {
      console.warn("[brief-generator] Vision call returned null — proceeding without image context.");
    }
  }

  // Step 2: Build context from VideoAnalysis fields directly
  const contextPrompt = `TRENDING VIDEO METADATA:
Hook: ${analysis.description || "(no description)"}
Content labels: ${analysis.contentLabels.join(", ") || "unknown"}
Suggested search words: ${analysis.suggestedWords.join(", ") || "none"}
Hashtags: ${analysis.hashtags.map(h => "#" + h).join(" ") || "none"}
Author: @${analysis.author?.uniqueId ?? "unknown"}  (${(analysis.author?.followerCount ?? 0).toLocaleString()} followers)
Plays: ${analysis.stats.plays.toLocaleString()}  Likes: ${analysis.stats.likes.toLocaleString()}  Shares: ${analysis.stats.shares.toLocaleString()}
Duration: ${analysis.durationSec}s
Music: ${analysis.music?.title ?? "unknown"} by ${analysis.music?.authorName ?? "unknown"}${analysis.music?.isOriginalSound ? " (original sound)" : ""}
Transcript snippet: ${(analysis.transcript ?? "").slice(0, 400) || "(no transcript — silent/music/pet content)"}

${visualDescription
    ? `VISUAL REIMAGINING OF FIRST FRAME:\n${visualDescription}`
    : "No thumbnail available — invent a visual from the metadata above."}

Generate a parody content brief for this trend. Make it ridiculous, weird, and unexpected while keeping the core viral hook recognisable.`;

  const rawBrief = await complete(BRIEF_SYSTEM, contextPrompt, {
    temperature: config_temperature_creative(),
    maxTokens:   2048,
  });

  if (!rawBrief) {
    console.error("[brief-generator] LM Studio returned null for brief generation.");
    return null;
  }

  const parsed = extractJson(rawBrief);
  if (!parsed) {
    console.error("[brief-generator] Could not parse JSON from LM Studio response:");
    console.error(rawBrief.slice(0, 800));
    return null;
  }

  return {
    dossierId:       videoId,
    premise:         String(parsed.premise         ?? "(no premise)"),
    character:       String(parsed.character       ?? "(no character)"),
    editInstruction: String(parsed.editInstruction ?? "Replace the main subject with a bizarre unexpected version. Keep the background the same."),
    imagePrompt:     String(parsed.imagePrompt     ?? ""),
    videoPrompt:     String(parsed.videoPrompt     ?? ""),
    vibe:            String(parsed.vibe            ?? "unhinged-chaos"),
    shots:           (parsed.shots as ShotNote[])  ?? [],
    kokoroVoiceTag:  parsed.kokoroVoiceTag ? String(parsed.kokoroVoiceTag) : null,
  };
}

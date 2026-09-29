/**
 * parody-engine/index.ts
 *
 * Orchestrator: takes a promoted TrendDossier + its source thumbnail,
 * runs the full parody pipeline, and writes results to Postgres.
 *
 * PIPELINE
 * ────────
 *  TrendDossier + raw thumbnail (data URI from trend_candidates)
 *       ↓
 *  LM Studio vision call    ← "what is this frame? describe a parody version"
 *       ↓
 *  LM Studio brief call     ← produce ContentBrief JSON with editInstruction
 *       ↓
 *  Qwen-Image-Edit-2509     ← POST frame + editInstruction to ComfyUI
 *    (via ComfyUI /prompt)  ← "Replace the person with a giant sentient baguette…"
 *       ↓
 *  Edited frame PNG         ← retrieved from ComfyUI /view, saved locally
 *       ↓
 *  MiniMax H3 I2V           ← submit EDITED frame + video_prompt → task_id
 *       ↓
 *  Poll MiniMax             ← wait for "succeeded", get download URL
 *       ↓
 *  Download .mp4            ← save to ./generated/<task_id>.mp4
 *       ↓
 *  Write content_briefs     ← persist brief + all paths to Postgres
 */

import { db } from "../db/client.js";
import { contentBriefs, trendDossiers, trendCandidates } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { generateBrief } from "./brief-generator.js";
import { editFrame } from "./qwen-image-edit.js";
import { dispatchToMinimax } from "./minimax-dispatch.js";
import type { TrendDossier } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParodyResult {
  dossierId:     string;
  briefId:       string;
  minimaxTaskId: string;
  generatedPath: string;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/** Fetch the thumbnail from the source candidate for a dossier. */
async function getThumbnailForDossier(dossier: TrendDossier): Promise<string | null> {
  if (!dossier.candidateId) return null;
  const rows = await db
    .select({ thumbnail: trendCandidates.thumbnail })
    .from(trendCandidates)
    .where(eq(trendCandidates.id, dossier.candidateId))
    .limit(1);
  return rows[0]?.thumbnail ?? null;
}

/** Write the completed ContentBrief + dispatch results to Postgres. */
async function persistBrief(
  brief: import("./brief-generator.js").ContentBrief,
  editedFramePath: string,
  taskId: string,
  generatedPath: string
): Promise<string> {
  const [row] = await db
    .insert(contentBriefs)
    .values({
      dossierId:       brief.dossierId,
      premise:         brief.premise,
      character:       brief.character,
      shots:           brief.shots,
      kokoroVoiceTag:  brief.kokoroVoiceTag,
      imagePrompt:     brief.imagePrompt,
      editInstruction: brief.editInstruction,
      editedFramePath,
      minimaxTaskId:   taskId,
      generatedPath,
      dispatched:      true,
      dispatchJobId:   taskId,
    })
    .returning({ id: contentBriefs.id });

  // Mark the dossier as processed
  await db
    .update(trendDossiers)
    .set({ processed: true })
    .where(eq(trendDossiers.id, brief.dossierId));

  return row.id;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full parody pipeline for a single dossier.
 * Safe to call in parallel for multiple dossiers.
 */
export async function runParodyPipeline(dossier: TrendDossier): Promise<ParodyResult | null> {
  console.log(`\n[parody] ── Pipeline start for dossier ${dossier.id} ──`);
  console.log(`[parody] Hook: "${dossier.hook.slice(0, 80)}"`);
  console.log(`[parody] Vibe: ${dossier.vibe} | Layer: ${dossier.layer} | TSS: ${dossier.tss}`);

  // Fetch thumbnail from source candidate
  const thumbnailDataUri = await getThumbnailForDossier(dossier);
  if (!thumbnailDataUri) {
    console.error("[parody] No thumbnail found — cannot proceed without a source frame.");
    return null;
  }

  // Derive a stable videoId for filename stems (use dossier id, trimmed)
  const videoId = dossier.id.replace(/-/g, "").slice(0, 16);

  // Step 1+2: LM Studio vision + brief → ContentBrief with editInstruction
  const brief = await generateBrief(dossier, thumbnailDataUri);
  if (!brief) {
    console.error("[parody] Brief generation failed — aborting pipeline.");
    return null;
  }
  console.log(`[parody] Brief generated: "${brief.premise.slice(0, 100)}"`);
  console.log(`[parody] Edit instruction: "${brief.editInstruction.slice(0, 100)}"`);

  // Step 3: Qwen-Image-Edit — apply the edit instruction to the raw thumbnail
  // The edited frame is what we actually send to MiniMax as the first_frame.
  let editResult;
  try {
    editResult = await editFrame(thumbnailDataUri, brief.editInstruction, videoId);
    console.log(`[parody] Qwen edit complete → ${editResult.editedImagePath}`);
  } catch (err) {
    console.error(`[parody] Qwen-Image-Edit failed: ${(err as Error).message}`);
    console.warn("[parody] Falling back to raw thumbnail for MiniMax.");
    editResult = null;
  }

  // Use edited frame if available, otherwise fall back to raw thumbnail
  const firstFrameUri = editResult?.editedDataUri ?? thumbnailDataUri;
  const editedPath    = editResult?.editedImagePath ?? "thumbnail_fallback";

  // Step 4+5+6: MiniMax H3 I2V — edited frame + video_prompt → generated video
  let dispatchResult;
  try {
    dispatchResult = await dispatchToMinimax(brief, firstFrameUri);
  } catch (err) {
    console.error(`[parody] MiniMax dispatch failed: ${(err as Error).message}`);
    return null;
  }

  // Step 7: Persist everything to DB
  const briefId = await persistBrief(brief, editedPath, dispatchResult.taskId, dispatchResult.generatedPath);
  console.log(`[parody] ✓ Complete — brief_id=${briefId} | video=${dispatchResult.generatedPath}`);

  return {
    dossierId:     dossier.id,
    briefId,
    minimaxTaskId: dispatchResult.taskId,
    generatedPath: dispatchResult.generatedPath,
  };
}

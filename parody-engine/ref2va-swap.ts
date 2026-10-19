/**
 * MiniMax H3 Ref2VA character swap.
 *
 * A cartoon still (Picture 1) plus a short source clip (Video 1) replace the
 * person and keep the source motion, camera, background, and lighting.
 * This is not the FL2VA first-frame path in minimax-dispatch.ts.
 *
 * Graph: parody-engine/workflows/minimax_h3_ref2va_character_swap_api.json
 * Notes: the Spark workflow of the same name, tested 2026-10-15.
 * Do not queue this while ComfyUI is being updated.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workflowPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "workflows",
  "minimax_h3_ref2va_character_swap_api.json",
);

export interface CharacterSwapRequest {
  /** Filename already uploaded to ComfyUI input/. */
  characterImage: string;
  /** Filename already uploaded to ComfyUI input/. */
  sourceVideo: string;
  /** Six-section prompt from characterSwapPrompt(). */
  prompt: string;
  seed?: number;
  /** Vertical TikTok default. Both axes must be multiples of 32, and the LoRA is 544p. */
  width?: number;
  height?: number;
  /** Frames on the 17n+5 grid. Default is about 7 seconds. */
  length?: number;
}

/** Snap a frame count onto the 17n+5 grid MiniMax H3 requires. */
export function ref2vaLength(frames: number): number {
  const n = Math.max(5, Math.round(frames));
  const adjust = (5 - (n % 17)) % 17;
  return n + (adjust < 0 ? adjust + 17 : adjust);
}

/** About 7 seconds at 24 fps, snapped onto the frame grid (175 frames, 7.3s). */
export const REF2VA_CLIP_FRAMES = ref2vaLength(7 * 24);

export function characterSwapPrompt(opts: {
  character: string;
  source: string;
  motion: string;
  soundscape: string;
  music: string;
}): string {
  return [
    "subject_definitions:",
    `<Subject 1> is the cartoon character from <Picture 1>: ${opts.character}`,
    `<Video 1> is the original video to edit: ${opts.source}`,
    "summary:",
    "Edit <Video 1> by replacing the person with <Subject 1>. Everything else in <Video 1> stays the same.",
    "retention_analysis:",
    `<Subject 1> fully replaces the person in <Video 1> for the whole clip and keeps their appearance from <Picture 1>. ${opts.motion}`,
    "detailed_description:",
    `[Shot 1] The same framing as <Video 1>. <Subject 1> performs the motion from <Video 1> and is rendered as a cartoon composited into the real scene. No other people appear.`,
    "overall_soundscape:",
    opts.soundscape,
    "non_diegetic_music:",
    opts.music,
  ].join("\n");
}

export function buildCharacterSwapGraph(req: CharacterSwapRequest): Record<string, unknown> {
  const graph = JSON.parse(fs.readFileSync(workflowPath, "utf8")) as Record<string, { inputs: Record<string, unknown> }>;
  graph["7"].inputs.image = req.characterImage;
  graph["8"].inputs.file = req.sourceVideo;
  graph["10"].inputs.prompt = req.prompt;
  graph["10"].inputs.width = req.width ?? 544;
  graph["10"].inputs.height = req.height ?? 960;
  graph["10"].inputs.length = req.length ?? REF2VA_CLIP_FRAMES;
  graph["14"].inputs.noise_seed = req.seed ?? 42;
  return graph;
}

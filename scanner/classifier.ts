/**
 * scanner/classifier.ts
 *
 * Assigns a layer (1/2/3) and vibe label to a scored candidate.
 *
 * LAYERS
 * ------
 * Layer 1 — Hyper-viral  (TSS >= 0.80): Act fast — peak trend already in progress
 * Layer 2 — Rising       (TSS >= 0.65): Sweet spot — trend is building
 * Layer 3 — Emerging     (TSS >= 0.40): Early signal — watch or act speculatively
 *
 * VIBE LABELS
 * -----------
 * Derived from TikTok's own diversificationLabels + hashtag patterns.
 * Feeds into the LLM brief-generator and the Kokoro voice-tag selector.
 */

import type { ScoredCandidate } from "./scorer.js";
import type { VideoAnalysis } from "../harness/video-analyzer.js";

export type Layer = 1 | 2 | 3;

export type Vibe =
  | "unhinged-chaos"
  | "cringe-sincere"
  | "dry-deadpan"
  | "hype-energy"
  | "wholesome-silly"
  | "dark-absurd"
  | "tutorial-parody"
  | "roast-callout"
  | "unknown";

export interface Classification {
  layer: Layer;
  vibe: Vibe;
  /** Human-readable reason for the vibe assignment */
  vibeReason: string;
}

// ---------------------------------------------------------------------------
// Vibe detector — keyword/label heuristics
// ---------------------------------------------------------------------------

const VIBE_RULES: Array<{ vibe: Vibe; keywords: string[]; labels: string[] }> = [
  { vibe: "unhinged-chaos",   keywords: ["unhinged","chaotic","what","brain","feral"],          labels: [] },
  { vibe: "hype-energy",      keywords: ["hype","energy","fire","lit","banger","dance","trend"], labels: ["Music","Dance"] },
  { vibe: "wholesome-silly",  keywords: ["cute","wholesome","adorable","funny","lol","lmao"],    labels: ["Pets","Comedy"] },
  { vibe: "dark-absurd",      keywords: ["cursed","disturbing","wrong","cursed","unsettling"],   labels: [] },
  { vibe: "cringe-sincere",   keywords: ["real","honest","vulnerable","feelings","cry"],         labels: ["Lifestyle"] },
  { vibe: "tutorial-parody",  keywords: ["how to","tutorial","step","tips","learn"],             labels: ["Education"] },
  { vibe: "roast-callout",    keywords: ["roast","callout","expose","ratio","dragged"],          labels: [] },
  { vibe: "dry-deadpan",      keywords: ["deadpan","no reaction","stare","blink","silent"],      labels: [] },
];

function detectVibe(analysis: VideoAnalysis | null, hashtags: string[]): { vibe: Vibe; reason: string } {
  const text = [
    ...(analysis?.contentLabels ?? []),
    ...(analysis?.suggestedWords ?? []),
    ...(analysis?.description ? [analysis.description] : []),
    ...hashtags,
    ...(analysis?.transcript ? [analysis.transcript] : []),
  ]
    .join(" ")
    .toLowerCase();

  const labels = analysis?.contentLabels ?? [];

  for (const rule of VIBE_RULES) {
    const hitKeyword = rule.keywords.some((kw) => text.includes(kw));
    const hitLabel   = rule.labels.some((lb) => labels.some((l) => l.toLowerCase().includes(lb.toLowerCase())));
    if (hitKeyword || hitLabel) {
      return {
        vibe:   rule.vibe,
        reason: hitLabel
          ? `TikTok label match: ${labels.join(", ")}`
          : `Keyword match in content`,
      };
    }
  }
  return { vibe: "unknown", reason: "No matching pattern" };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function classify(candidate: ScoredCandidate): Classification {
  const layer: Layer =
    candidate.tss >= 0.80 ? 1 :
    candidate.tss >= 0.65 ? 2 : 3;

  const { vibe, reason } = detectVibe(candidate.analysis, candidate.video.hashtags);

  return { layer, vibe, vibeReason: reason };
}

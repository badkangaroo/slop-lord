/**
 * scanner/scorer.ts
 *
 * Trend Signal Score (TSS) calculator.
 *
 * Formula:
 *   TSS = (V_norm * 0.5) + (D_norm * 0.3) + (P * 0.2)
 *
 *   V = velocity  — plays per minute since capture
 *   D = density   — unique hashtag uses across collected videos (proxy for creator density)
 *   P = diversity — participation spread (higher = more diverse creator sizes)
 *
 * All components are normalised to [0, 1] against the batch before scoring.
 * The batch is the current set of FeedVideos from one scrollFeed() run.
 */

import type { FeedVideo } from "../harness/feed-scroller.js";
import type { VideoAnalysis } from "../harness/video-analyzer.js";

export interface ScoredCandidate {
  video: FeedVideo;
  analysis: VideoAnalysis | null;
  /** Velocity: plays / minute (0 when unavailable) */
  velocity: number;
  /** Density: unique users sharing the video's top hashtag in this batch */
  density: number;
  /** Participation diversity [0,1] */
  participation: number;
  /** Final Trend Signal Score [0,1] */
  tss: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalise(values: number[]): number[] {
  const max = Math.max(...values, 1);
  return values.map((v) => v / max);
}

/** Simple Gini coefficient for an array of positive numbers. */
function gini(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((s, v) => s + v, 0);
  if (sum === 0) return 0;
  let numerator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (2 * (i + 1) - n - 1) * sorted[i];
  }
  return numerator / (n * sum);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scores a batch of (video, analysis) pairs.
 * Returns them sorted by TSS descending.
 */
export function scoreBatch(
  pairs: Array<{ video: FeedVideo; analysis: VideoAnalysis | null }>
): ScoredCandidate[] {
  // Raw component values per candidate
  const velocities  = pairs.map(({ analysis }) => analysis?.stats.plays ?? 0);
  const durations   = pairs.map(({ analysis }) => Math.max(analysis?.durationSec ?? 1, 1));
  const rawVelocity = velocities.map((p, i) => p / durations[i]); // plays per sec as proxy

  // Density: count how many videos share each hashtag across the batch
  const tagFreq: Record<string, number> = {};
  for (const { video } of pairs) {
    for (const tag of video.hashtags) {
      tagFreq[tag] = (tagFreq[tag] ?? 0) + 1;
    }
  }
  const rawDensity = pairs.map(({ video }) => {
    const max = Math.max(0, ...video.hashtags.map((t) => tagFreq[t] ?? 0));
    return max;
  });

  // Participation diversity: Gini of follower counts in the batch
  const followerCounts = pairs
    .map(({ analysis }) => analysis?.author?.followerCount ?? 0)
    .filter((v) => v > 0);
  const batchGini = gini(followerCounts);
  // Higher Gini = more unequal distribution = lower participation diversity
  const participation = 1 - batchGini;

  const normV = normalise(rawVelocity);
  const normD = normalise(rawDensity);

  return pairs
    .map(({ video, analysis }, i) => {
      const tss =
        normV[i] * 0.5 +
        normD[i] * 0.3 +
        participation * 0.2;
      return {
        video,
        analysis,
        velocity:      rawVelocity[i],
        density:       rawDensity[i],
        participation,
        tss:           Math.min(1, Math.max(0, tss)),
      };
    })
    .sort((a, b) => b.tss - a.tss);
}

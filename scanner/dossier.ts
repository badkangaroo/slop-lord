/**
 * scanner/dossier.ts
 *
 * Builds a TrendDossier from a scored + classified candidate and writes it
 * to Postgres. Also upserts hashtag frequency records and the join table.
 *
 * Deduplication: before inserting, checks if the same hook text has been
 * seen within the configured dedup window (default 48h). Suppresses the
 * dossier if a match is found.
 */

import { eq, sql, gt, ilike, and } from "drizzle-orm";
import { db, closeDb } from "../db/client.js";
import {
  trendCandidates,
  trendDossiers,
  contentBriefs,
  hashtags,
  dossierHashtags,
  type NewTrendCandidate,
  type NewTrendDossier,
} from "../db/schema.js";
import { config } from "../config/index.js";
import type { ScoredCandidate } from "./scorer.js";
import type { Classification } from "./classifier.js";

export interface DossierResult {
  suppressed: boolean;       // true if dedup matched
  dossierId:  string | null; // UUID of inserted dossier (null if suppressed)
}

// ---------------------------------------------------------------------------
// Dedup check
// ---------------------------------------------------------------------------

async function isDuplicate(hook: string, windowHours: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const rows = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(trendDossiers)
    .where(
      and(
        ilike(trendDossiers.hook, `%${hook.slice(0, 60)}%`),
        gt(trendDossiers.capturedAt, cutoff)
      )
    );
  return (rows[0]?.count ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Hashtag upsert
// ---------------------------------------------------------------------------

async function upsertHashtags(tags: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const tag of tags) {
    const existing = await db
      .select({ id: hashtags.id })
      .from(hashtags)
      .where(eq(hashtags.tag, tag))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(hashtags)
        .set({
          lastSeenAt: new Date(),
          useCount: sql`${hashtags.useCount} + 1`,
        })
        .where(eq(hashtags.tag, tag));
      ids.push(existing[0].id);
    } else {
      const inserted = await db
        .insert(hashtags)
        .values({ tag })
        .returning({ id: hashtags.id });
      ids.push(inserted[0].id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Writes a raw scored candidate to trend_candidates regardless of TSS.
 * Every video the agent sees is recorded here — use this as the full log.
 * promoted=false until writeDossier() is called for this candidate.
 * Returns the inserted row's UUID.
 */
export async function writeCandidate(
  candidate: ScoredCandidate,
  layer: import("./classifier.js").Layer
): Promise<string> {
  const row: NewTrendCandidate = {
    layer,
    rawData: {
      video:    candidate.video,
      analysis: candidate.analysis ? {
        ...candidate.analysis,
        // Don't double-store the data URI in JSONB — it's in its own column
        thumbnailDataUri: undefined,
      } : null,
      velocity: candidate.velocity,
      density:  candidate.density,
    },
    tss:       candidate.tss.toFixed(3),
    promoted:  false,
    thumbnail: candidate.analysis?.thumbnailDataUri ?? null,
    videoPath: candidate.analysis?.videoPath ?? null,
  };
  const [inserted] = await db
    .insert(trendCandidates)
    .values(row)
    .returning({ id: trendCandidates.id });
  return inserted.id;
}

/**
 * Persists a scored+classified candidate as a TrendDossier.
 * Returns suppressed=true if the dedup window matched.
 */
export async function writeDossier(
  candidate: ScoredCandidate,
  classification: Classification
): Promise<DossierResult> {
  const dedupHours = config.scanner.dedupWindowHours ?? 48;
  const hook = candidate.video.description.slice(0, 200).trim() || "(no description)";

  // Dedup check
  if (await isDuplicate(hook, dedupHours)) {
    console.log(`[dossier] Suppressed (duplicate within ${dedupHours}h): "${hook.slice(0, 60)}…"`);
    return { suppressed: true, dossierId: null };
  }

  // Insert raw candidate first
  const rawData: NewTrendCandidate = {
    layer: classification.layer,
    rawData: {
      video:    candidate.video,
      analysis: candidate.analysis,
      velocity: candidate.velocity,
      density:  candidate.density,
    },
    tss:      candidate.tss.toFixed(3),
    promoted: true,
  };
  const [insertedCandidate] = await db
    .insert(trendCandidates)
    .values(rawData)
    .returning({ id: trendCandidates.id });

  // Build template from analysis data
  const template = {
    hook,
    suggestedWords: candidate.analysis?.suggestedWords ?? [],
    contentLabels:  candidate.analysis?.contentLabels ?? [],
    transcript:     candidate.analysis?.transcript ?? null,
    music:          candidate.analysis?.music ?? null,
    exampleVideoUrl: candidate.video.videoUrl ?? null,
  };

  // Build stats blob
  const stats = candidate.analysis
    ? {
        plays:    candidate.analysis.stats.plays,
        likes:    candidate.analysis.stats.likes,
        comments: candidate.analysis.stats.comments,
        shares:   candidate.analysis.stats.shares,
        velocity: candidate.velocity,
        density:  candidate.density,
      }
    : {
        likes:    candidate.video.likes,
        comments: candidate.video.comments,
        shares:   candidate.video.shares,
        velocity: candidate.velocity,
        density:  candidate.density,
      };

  const dossierData: NewTrendDossier = {
    candidateId:    insertedCandidate.id,
    layer:          classification.layer,
    tss:            candidate.tss.toFixed(3),
    hook,
    template,
    vibe:           classification.vibe,
    stats,
    sourceMetadata: {
      author:   candidate.video.author,
      authorUrl: candidate.video.authorUrl,
      videoUrl: candidate.video.videoUrl,
      soundName: candidate.video.soundName,
      capturedAt: candidate.video.capturedAt,
    },
    processed: false,
  };

  const [insertedDossier] = await db
    .insert(trendDossiers)
    .values(dossierData)
    .returning({ id: trendDossiers.id });

  const dossierId = insertedDossier.id;
  console.log(`[dossier] Written — id=${dossierId} layer=${classification.layer} TSS=${candidate.tss.toFixed(3)} vibe=${classification.vibe}`);

  // Upsert hashtags and link to dossier
  const allTags = [
    ...candidate.video.hashtags,
    ...(candidate.analysis?.hashtags ?? []),
  ].filter((t, i, arr) => arr.indexOf(t) === i); // deduplicate

  if (allTags.length > 0) {
    const hashtagIds = await upsertHashtags(allTags);
    await db.insert(dossierHashtags).values(
      hashtagIds.map((hashtagId) => ({ dossierId, hashtagId }))
    );
  }

  return { suppressed: false, dossierId };
}

export { closeDb };

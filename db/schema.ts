/**
 * db/schema.ts
 *
 * Drizzle ORM schema — single source of truth for all table shapes.
 * Mirrors db/migrations/001_initial.sql + 002_style_seed.sql exactly.
 *
 * Usage:
 *   import { db } from './client.js'
 *   import { trendDossiers } from './schema.js'
 *   const rows = await db.select().from(trendDossiers).where(eq(trendDossiers.processed, false))
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  uuid,
  numeric,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// tiktok_accounts
// ---------------------------------------------------------------------------

export const tiktokAccounts = pgTable("tiktok_accounts", {
  id:            serial("id").primaryKey(),
  username:      text("username").notNull().unique(),
  displayName:   text("display_name"),
  followerCount: integer("follower_count"),
  isTarget:      boolean("is_target").default(false),
  firstSeenAt:   timestamp("first_seen_at", { withTimezone: true }).defaultNow(),
  lastSeenAt:    timestamp("last_seen_at",  { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// trend_candidates
// ---------------------------------------------------------------------------

export const trendCandidates = pgTable("trend_candidates", {
  id:          uuid("id").primaryKey().defaultRandom(),
  capturedAt:  timestamp("captured_at",  { withTimezone: true }).defaultNow(),
  layer:       smallint("layer").notNull(),
  rawData:     jsonb("raw_data").notNull(),
  tss:         numeric("tss", { precision: 4, scale: 3 }),
  promoted:    boolean("promoted").default(false),
  /** First-frame cover image as a data URI. Added by 003_thumbnail.sql. */
  thumbnail:   text("thumbnail"),
  /** Absolute path to local 480p transcoded video. Added by 004_video_path.sql. */
  videoPath:   text("video_path"),
});

// ---------------------------------------------------------------------------
// trend_dossiers
// ---------------------------------------------------------------------------

export const trendDossiers = pgTable(
  "trend_dossiers",
  {
    id:             uuid("id").primaryKey().defaultRandom(),
    candidateId:    uuid("candidate_id").references(() => trendCandidates.id),
    capturedAt:     timestamp("captured_at",  { withTimezone: true }).defaultNow(),
    layer:          smallint("layer").notNull(),
    tss:            numeric("tss", { precision: 4, scale: 3 }).notNull(),
    hook:           text("hook").notNull(),
    template:       jsonb("template").notNull(),
    vibe:           text("vibe").notNull(),
    stats:          jsonb("stats").notNull(),
    sourceMetadata: jsonb("source_metadata"),
    processed:      boolean("processed").default(false),
  },
  (table) => [
    index("idx_dossiers_hook_time").on(table.hook, table.capturedAt),
    // idx_dossiers_unprocessed is a partial index (WHERE processed = FALSE)
    // — defined in 001_initial.sql; no Drizzle equivalent needed here.
  ]
);

// ---------------------------------------------------------------------------
// content_briefs
// ---------------------------------------------------------------------------

export const contentBriefs = pgTable("content_briefs", {
  id:             uuid("id").primaryKey().defaultRandom(),
  dossierId:      uuid("dossier_id").references(() => trendDossiers.id),
  createdAt:      timestamp("created_at",  { withTimezone: true }).defaultNow(),
  premise:        text("premise").notNull(),
  character:      text("character").notNull(),
  shots:          jsonb("shots").notNull(),
  stylePreset:    text("style_preset"),
  kokoroVoiceTag: text("kokoro_voice_tag"),
  dispatched:     boolean("dispatched").default(false),
  dispatchJobId:  text("dispatch_job_id"),
  styleSeed:      jsonb("style_seed"),            // added by 002_style_seed.sql
  /** Prompt sent to image generator for first-frame. Added by 005_generated_video.sql */
  imagePrompt:      text("image_prompt"),
  /** MiniMax v2 task_id. Added by 005_generated_video.sql */
  minimaxTaskId:    text("minimax_task_id"),
  /** Absolute local path to downloaded MiniMax output. Added by 005_generated_video.sql */
  generatedPath:    text("generated_path"),
  /** LLM-generated Qwen edit instruction. Added by 006_edited_frame.sql */
  editInstruction:  text("edit_instruction"),
  /** Path to Qwen-Image-Edit output PNG fed to MiniMax. Added by 006_edited_frame.sql */
  editedFramePath:  text("edited_frame_path"),
});

// ---------------------------------------------------------------------------
// hashtags
// ---------------------------------------------------------------------------

export const hashtags = pgTable("hashtags", {
  id:          serial("id").primaryKey(),
  tag:         text("tag").notNull().unique(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow(),
  lastSeenAt:  timestamp("last_seen_at",  { withTimezone: true }).defaultNow(),
  useCount:    integer("use_count").default(1),
});

// ---------------------------------------------------------------------------
// dossier_hashtags  (many-to-many join)
// ---------------------------------------------------------------------------

export const dossierHashtags = pgTable(
  "dossier_hashtags",
  {
    dossierId: uuid("dossier_id").references(() => trendDossiers.id),
    hashtagId: integer("hashtag_id").references(() => hashtags.id),
  },
  (table) => [primaryKey({ columns: [table.dossierId, table.hashtagId] })]
);

// ---------------------------------------------------------------------------
// Convenience type exports
// ---------------------------------------------------------------------------

export type TiktokAccount   = typeof tiktokAccounts.$inferSelect;
export type TrendCandidate  = typeof trendCandidates.$inferSelect;
export type TrendDossier    = typeof trendDossiers.$inferSelect;
export type ContentBrief    = typeof contentBriefs.$inferSelect;
export type Hashtag         = typeof hashtags.$inferSelect;
export type DossierHashtag  = typeof dossierHashtags.$inferSelect;

export type NewTrendCandidate = typeof trendCandidates.$inferInsert;
export type NewTrendDossier   = typeof trendDossiers.$inferInsert;
export type NewContentBrief   = typeof contentBriefs.$inferInsert;
export type NewHashtag        = typeof hashtags.$inferInsert;

/**
 * db/client.ts
 *
 * Drizzle + node-postgres connection pool.
 * Reads connection details from config/runtime.yaml (+ env var overrides).
 *
 * Usage:
 *   import { db } from '../db/client.js'
 *   const rows = await db.select().from(trendDossiers)
 */

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../config/index.js";
import * as schema from "./schema.js";

const { Pool } = pg;

// Build the connection string from config (env var DATABASE_URL overrides all).
function buildConnectionString(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const { host, port, name, user } = config.database;
  const password = process.env.DB_PASSWORD;
  if (!password) {
    throw new Error(
      "[db/client] DB_PASSWORD env var is required. Set it in .env or the environment."
    );
  }
  return `postgres://${user}:${password}@${host}:${port}/${name}`;
}

const pool = new Pool({
  connectionString: buildConnectionString(),
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  console.error("[db/client] Unexpected pool error:", err.message);
});

export const db = drizzle(pool, { schema });

/**
 * Call this on process shutdown to drain the connection pool cleanly.
 * Prevents the Node event loop from hanging after your main work is done.
 */
export async function closeDb(): Promise<void> {
  await pool.end();
}

/**
 * harness/pause-guard.ts
 *
 * Cooperative pause/resume mechanism between the human operator and the agent.
 *
 * HOW IT WORKS
 * ------------
 * Before every agent action, call `pauseGuard.check()`. If a pause signal
 * is active it will block until the signal is cleared, then return.
 *
 * PAUSE SIGNALS (checked in priority order)
 * ------------------------------------------
 * 1. SIGNAL FILE  — `touch /tmp/slop-lord.pause`
 *    Human creates this file to pause the agent at the next checkpoint.
 *    `rm /tmp/slop-lord.pause` resumes it.
 *
 * 2. SIGTERM / SIGINT — graceful shutdown
 *    Agent saves state and exits cleanly. The scanner must register its
 *    own cleanup logic via `pauseGuard.onShutdown(fn)`.
 *
 * USAGE
 * -----
 *   import { pauseGuard } from "./pause-guard.js";
 *
 *   pauseGuard.onShutdown(async () => {
 *     await db.saveState();
 *   });
 *
 *   // In any agent loop:
 *   await pauseGuard.check();   // blocks if paused; throws if shutting down
 *   await stagehand.act("scroll down");
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PAUSE_FILE = process.env.PAUSE_FILE ?? "/tmp/slop-lord.pause";
const POLL_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------------
// Shutdown registry
// ---------------------------------------------------------------------------

type ShutdownFn = () => Promise<void>;
const shutdownHandlers: ShutdownFn[] = [];
let shuttingDown = false;
let shutdownSignal: "SIGTERM" | "SIGINT" | null = null;

async function runShutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(
    `\n[pause-guard] Received ${shutdownSignal}. Running shutdown handlers…`
  );

  for (const fn of shutdownHandlers) {
    try {
      await fn();
    } catch (err) {
      console.error("[pause-guard] Error in shutdown handler:", err);
    }
  }

  console.log("[pause-guard] Shutdown complete.");
  process.exit(0);
}

process.on("SIGTERM", () => {
  shutdownSignal = "SIGTERM";
  runShutdown().catch(console.error);
});

process.on("SIGINT", () => {
  shutdownSignal = "SIGINT";
  runShutdown().catch(console.error);
});

// ---------------------------------------------------------------------------
// Pause file detection
// ---------------------------------------------------------------------------

function isPaused(): boolean {
  try {
    fs.accessSync(PAUSE_FILE, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class ShutdownRequestedError extends Error {
  constructor(signal: string) {
    super(`Shutdown requested via ${signal}`);
    this.name = "ShutdownRequestedError";
  }
}

const pauseGuard = {
  /**
   * Register a function to run when SIGTERM/SIGINT is received.
   * Handlers run in registration order.
   */
  onShutdown(fn: ShutdownFn): void {
    shutdownHandlers.push(fn);
  },

  /**
   * Check whether the agent should pause or stop.
   *
   * - Returns immediately when neither signal is active.
   * - Blocks (polls every 2s) while the pause file exists.
   * - Throws ShutdownRequestedError if SIGTERM/SIGINT has been received.
   *
   * Call this before every agent action.
   */
  async check(): Promise<void> {
    if (shuttingDown) {
      throw new ShutdownRequestedError(shutdownSignal ?? "signal");
    }

    if (!isPaused()) return;

    const pauseFilePath = path.resolve(PAUSE_FILE);
    console.log(
      `[pause-guard] ⏸  Pause file detected: ${pauseFilePath}\n` +
        `              Agent is paused. Remove the file to resume:\n` +
        `              rm ${pauseFilePath}`
    );

    // Poll until unpaused or shutdown
    while (isPaused()) {
      if (shuttingDown) {
        throw new ShutdownRequestedError(shutdownSignal ?? "signal");
      }
      await sleep(POLL_INTERVAL_MS);
    }

    console.log("[pause-guard] ▶  Resumed.");
  },

  /**
   * Returns true if a pause is currently active.
   * Non-blocking — useful for status reporting.
   */
  get paused(): boolean {
    return isPaused();
  },

  /**
   * Returns true if a shutdown has been signalled.
   */
  get shutdownRequested(): boolean {
    return shuttingDown;
  },

  /**
   * The path of the pause signal file (for display in UIs / logs).
   */
  get pauseFilePath(): string {
    return PAUSE_FILE;
  },
};

export { pauseGuard };

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

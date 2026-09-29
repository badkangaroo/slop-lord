/**
 * harness/browser.ts
 *
 * Manages the connection to the live (non-headless) Chrome instance.
 *
 * DESIGN PRINCIPLES
 * -----------------
 * 1. We NEVER launch Chrome ourselves. The human starts it manually via
 *    scripts/launch-chrome.sh so they can log in to TikTok and remain in
 *    control of the visible window at all times.
 *
 * 2. We ONLY attach to an already-running Chrome via CDP (Chrome DevTools
 *    Protocol) on the configured port (default: 9222).
 *
 * 3. If Chrome is not running, we tell the operator clearly and wait — we
 *    do NOT start a headless fallback. The session cookies only exist in
 *    the visible profile.
 *
 * 4. We verify that the browser is actually on TikTok (or can navigate
 *    there) before handing control to the agent.
 *
 * FAILURE MODES HANDLED
 * ---------------------
 * - Chrome not running at all          → clear error + instructions
 * - Chrome running but CDP not open    → check --remote-debugging-port flag
 * - CDP reachable but no pages         → open a new tab to tiktok.com
 * - TikTok session expired / logged out → detect login page, pause for human
 * - CDP connection drops mid-session   → reconnect with exponential backoff
 * - Human grabs mouse                  → pause-guard handles this separately
 */

import { config } from "../config/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowserTarget {
  /** Raw CDP target descriptor */
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface BrowserStatus {
  reachable: boolean;
  targets: BrowserTarget[];
  tiktokTarget: BrowserTarget | null;
  /** true when the TikTok page shows the login/auth wall */
  requiresLogin: boolean;
}

// ---------------------------------------------------------------------------
// CDP endpoint helpers
// ---------------------------------------------------------------------------

const cdpBase = (): string =>
  `http://${config.browser.cdpHost}:${config.browser.cdpPort}`;

/**
 * Fetches /json/list from the CDP HTTP endpoint.
 * Returns null if Chrome is not reachable.
 */
export async function fetchCdpTargets(): Promise<BrowserTarget[] | null> {
  try {
    const res = await fetch(`${cdpBase()}/json/list`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return (await res.json()) as BrowserTarget[];
  } catch {
    return null;
  }
}

/**
 * Checks whether Chrome is alive by hitting /json/version.
 */
export async function isChromeReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${cdpBase()}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Login detection
// ---------------------------------------------------------------------------

/** URL patterns that indicate TikTok is showing a login wall */
const LOGIN_URL_PATTERNS = [
  /tiktok\.com\/login/,
  /tiktok\.com\/signup/,
  /accounts\.tiktok\.com/,
];

function urlLooksLikeLoginPage(url: string): boolean {
  return LOGIN_URL_PATTERNS.some((re) => re.test(url));
}

// ---------------------------------------------------------------------------
// Status check
// ---------------------------------------------------------------------------

export async function getBrowserStatus(): Promise<BrowserStatus> {
  const targets = await fetchCdpTargets();

  if (targets === null) {
    return {
      reachable: false,
      targets: [],
      tiktokTarget: null,
      requiresLogin: false,
    };
  }

  // Find any page-type target that is on tiktok.com
  const tiktokTarget =
    targets.find(
      (t) =>
        t.type === "page" &&
        t.url.includes("tiktok.com") &&
        !urlLooksLikeLoginPage(t.url)
    ) ?? null;

  const loginTarget = targets.find(
    (t) => t.type === "page" && urlLooksLikeLoginPage(t.url)
  );

  return {
    reachable: true,
    targets,
    tiktokTarget,
    requiresLogin: !!loginTarget,
  };
}

// ---------------------------------------------------------------------------
// Wait-for-ready — blocks until Chrome is up and TikTok is authenticated
// ---------------------------------------------------------------------------

export interface WaitOptions {
  /** Total seconds to wait before giving up (default: from config) */
  timeoutSec?: number;
  /** Poll interval in ms */
  pollMs?: number;
  /** Called on each poll with current status — useful for logging */
  onStatus?: (status: BrowserStatus, elapsed: number) => void;
}

export class BrowserNotReadyError extends Error {
  constructor(
    message: string,
    public readonly status: BrowserStatus
  ) {
    super(message);
    this.name = "BrowserNotReadyError";
  }
}

/**
 * Waits until Chrome is reachable AND has an authenticated TikTok page open.
 *
 * Prints human-readable guidance when waiting so the operator knows exactly
 * what to do. Throws BrowserNotReadyError if the timeout is exceeded.
 */
export async function waitForBrowser(opts: WaitOptions = {}): Promise<BrowserTarget> {
  const timeoutSec = opts.timeoutSec ?? config.browser.cdpReadyTimeoutSec;
  const pollMs = opts.pollMs ?? 2000;
  const deadline = Date.now() + timeoutSec * 1000;

  let lastLogPhase = "";

  while (Date.now() < deadline) {
    const status = await getBrowserStatus();
    const elapsed = Math.round((Date.now() - (deadline - timeoutSec * 1000)) / 1000);

    opts.onStatus?.(status, elapsed);

    if (!status.reachable) {
      if (lastLogPhase !== "unreachable") {
        console.warn(
          [
            "",
            "╔══════════════════════════════════════════════════════════════╗",
            "║  Chrome not detected on port " +
              String(config.browser.cdpPort).padEnd(34) +
              "║",
            "║                                                              ║",
            "║  Start Chrome with CDP enabled:                              ║",
            "║    ./scripts/launch-chrome.sh                                ║",
            "║                                                              ║",
            "║  Then log in to TikTok in the browser window.               ║",
            "║  The agent will take over automatically after login.         ║",
            "╚══════════════════════════════════════════════════════════════╝",
            "",
          ].join("\n")
        );
        lastLogPhase = "unreachable";
      }
      await sleep(pollMs);
      continue;
    }

    if (status.requiresLogin) {
      if (lastLogPhase !== "login") {
        console.warn(
          [
            "",
            "╔══════════════════════════════════════════════════════════════╗",
            "║  TikTok login page detected.                                 ║",
            "║                                                              ║",
            "║  Please log in to TikTok in the Chrome window.              ║",
            "║  The agent is paused and will resume automatically           ║",
            "║  once the login is complete.                                 ║",
            "╚══════════════════════════════════════════════════════════════╝",
            "",
          ].join("\n")
        );
        lastLogPhase = "login";
      }
      await sleep(pollMs);
      continue;
    }

    if (!status.tiktokTarget) {
      if (lastLogPhase !== "notiktok") {
        console.log(
          "Chrome is open but no TikTok tab found. " +
            "Waiting for TikTok to be open in the browser..."
        );
        lastLogPhase = "notiktok";
      }
      await sleep(pollMs);
      continue;
    }

    // All good — Chrome is up, TikTok tab exists, not on login page
    console.log(
      `✓ Browser ready — connected to TikTok tab: "${status.tiktokTarget.title}"`
    );
    return status.tiktokTarget;
  }

  const finalStatus = await getBrowserStatus();
  throw new BrowserNotReadyError(
    `Chrome / TikTok not ready after ${timeoutSec}s. ` +
      `Run ./scripts/launch-chrome.sh and log in to TikTok.`,
    finalStatus
  );
}

// ---------------------------------------------------------------------------
// Reconnect helper — used by Stagehand/Playwright adapters after a CDP drop
// ---------------------------------------------------------------------------

export interface ReconnectOptions {
  maxAttempts?: number;
  backoffBaseMs?: number;
  onAttempt?: (attempt: number, error: unknown) => void;
}

/**
 * Retries a factory function with exponential backoff.
 * Intended for CDP connection creation that may fail transiently.
 */
export async function withReconnect<T>(
  factory: () => Promise<T>,
  opts: ReconnectOptions = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const backoffBaseMs = opts.backoffBaseMs ?? 500;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await factory();
    } catch (err) {
      lastError = err;
      opts.onAttempt?.(attempt, err);

      if (attempt < maxAttempts) {
        const delay = backoffBaseMs * 2 ** (attempt - 1);
        console.warn(`CDP connect attempt ${attempt}/${maxAttempts} failed. Retrying in ${delay}ms…`);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

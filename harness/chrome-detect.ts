/**
 * harness/chrome-detect.ts
 *
 * Detects the path to the Google Chrome (or Chromium) executable
 * on the current platform. Used by Stagehand's localBrowserLaunchOptions.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";

const MACOS_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

const LINUX_CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium-browser",
  "chromium",
];

const LINUX_FIXED_PATHS = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

function which(bin: string): string | null {
  try {
    return execSync(`which ${bin}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export async function detectChromePath(): Promise<string> {
  const platform = process.platform;

  if (platform === "darwin") {
    for (const p of MACOS_PATHS) {
      if (fs.existsSync(p)) return p;
    }
    // Also try PATH
    const found = which("google-chrome") ?? which("chromium");
    if (found) return found;
  }

  if (platform === "linux") {
    for (const bin of LINUX_CANDIDATES) {
      const found = which(bin);
      if (found) return found;
    }
    for (const p of LINUX_FIXED_PATHS) {
      if (fs.existsSync(p)) return p;
    }
  }

  throw new Error(
    `Could not find Chrome or Chromium on ${platform}.\n` +
      "macOS: Install from https://www.google.com/chrome/\n" +
      "Linux: sudo apt install google-chrome-stable"
  );
}

/**
 * config/index.ts
 *
 * Loads config/runtime.yaml and applies environment variable overrides.
 * Every module reads from this — no raw process.env or hardcoded addresses.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, "runtime.yaml");

// ---------------------------------------------------------------------------
// Raw shape from YAML
// ---------------------------------------------------------------------------

export interface InferenceBackend {
  baseUrl: string;
  model: string;
  isReasoningModel?: boolean;
  enableThinking?: boolean;
  temperatureCreative?: number;
  temperatureDeterministic?: number;
  maxPasses?: number;
}

interface RuntimeYaml {
  browser: {
    cdpPort: number;
    cdpHost: string;
    profileDir: string;
    cdpReadyTimeoutSec: number;
    humanIdleSec: number;
  };
  inference: {
    text:   InferenceBackend;
    vision: InferenceBackend;
    verify: InferenceBackend;
  };
  // Legacy — kept until all callers migrate to inference.*
  lmStudio: {
    baseUrl: string;
    model: string;
    temperatureCreative: number;
    temperatureDeterministic: number;
  };
  sglang: {
    baseUrl: string;
    model: string;
    verifyMaxPasses: number;
  };
  comfyui: {
    host: string;
    port: number;
    stylePresets: Array<{ name: string; description: string }>;
  };
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    poolMin: number;
    poolMax: number;
  };
  searxng: { url: string; timeoutMs: number };
  firecrawl: { url: string; apiKey: string; timeoutMs: number };
  scanner: {
    intervalMinutes: number;
    tssThreshold: number;
    dedupWindowHours: number;
    maxCandidatesPerRun: number;
  };
  qwen: {
    unetName: string;
    clipName: string;
    vaeName: string;
    loraName: string;
    enableTurbo: boolean;
    steps: number;
    seed: number;
    outputDir: string;
  };
  minimax: {
    unetName: string;
    turboUnetName: string;
    clipName: string;
    vaeName: string;
    audioVaeName: string;
    loraName: string;
    enableTurbo: boolean;
    steps: number;
    turboSteps: number;
    turboStrength: number;
    width: number;
    height: number;
    duration: number;
    pollIntervalMs: number;
    pollTimeoutMs: number;
    outputDir: string;
  };
  web: { port: number; host: string };
  downloads: { dir: string };
}

// ---------------------------------------------------------------------------
// Load + merge env overrides
// ---------------------------------------------------------------------------
function load(): RuntimeYaml {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const base = yaml.load(raw) as RuntimeYaml;

  // Expand ~ in profileDir
  base.browser.profileDir = base.browser.profileDir.replace(
    /^~/,
    process.env.HOME ?? "~"
  );

  // Env overrides — only apply when the variable is actually set
  const env = process.env;

  if (env.BROWSER_CDP_PORT) base.browser.cdpPort = parseInt(env.BROWSER_CDP_PORT, 10);
  if (env.BROWSER_CDP_HOST) base.browser.cdpHost = env.BROWSER_CDP_HOST;
  if (env.CHROME_PROFILE_DIR) base.browser.profileDir = env.CHROME_PROFILE_DIR;

  // inference.* overrides — each role has independent URL + model overrides
  if (env.INFERENCE_TEXT_URL)    base.inference.text.baseUrl = env.INFERENCE_TEXT_URL;
  if (env.INFERENCE_TEXT_MODEL)  base.inference.text.model   = env.INFERENCE_TEXT_MODEL;
  if (env.INFERENCE_VISION_URL)  base.inference.vision.baseUrl = env.INFERENCE_VISION_URL;
  if (env.INFERENCE_VISION_MODEL) base.inference.vision.model  = env.INFERENCE_VISION_MODEL;
  if (env.INFERENCE_VERIFY_URL)  base.inference.verify.baseUrl = env.INFERENCE_VERIFY_URL;
  if (env.INFERENCE_VERIFY_MODEL) base.inference.verify.model  = env.INFERENCE_VERIFY_MODEL;

  // Legacy lmStudio overrides — also mirror into inference.text so both paths see the change
  if (env.LM_STUDIO_BASE_URL) {
    base.lmStudio.baseUrl       = env.LM_STUDIO_BASE_URL;
    base.inference.text.baseUrl = env.LM_STUDIO_BASE_URL;
  }
  if (env.LM_STUDIO_MODEL) {
    base.lmStudio.model       = env.LM_STUDIO_MODEL;
    base.inference.text.model = env.LM_STUDIO_MODEL;
  }

  if (env.COMFYUI_HOST) base.comfyui.host = env.COMFYUI_HOST;
  if (env.COMFYUI_PORT) base.comfyui.port = parseInt(env.COMFYUI_PORT, 10);

  if (env.SCANNER_INTERVAL_MINUTES)
    base.scanner.intervalMinutes = parseInt(env.SCANNER_INTERVAL_MINUTES, 10);
  if (env.TSS_THRESHOLD)
    base.scanner.tssThreshold = parseFloat(env.TSS_THRESHOLD);
  if (env.DEDUP_WINDOW_HOURS)
    base.scanner.dedupWindowHours = parseInt(env.DEDUP_WINDOW_HOURS, 10);

  if (env.DOWNLOADS_DIR) base.downloads.dir = env.DOWNLOADS_DIR;
  base.downloads.dir = base.downloads.dir.replace(/^~/, process.env.HOME ?? "~");

  base.qwen.outputDir = base.qwen.outputDir.replace(/^~/, process.env.HOME ?? "~");
  if (env.QWEN_OUTPUT_DIR) base.qwen.outputDir = env.QWEN_OUTPUT_DIR;

  if (env.MINIMAX_OUTPUT_DIR) base.minimax.outputDir = env.MINIMAX_OUTPUT_DIR;
  base.minimax.outputDir = base.minimax.outputDir.replace(/^~/, process.env.HOME ?? "~");

  return base;
}

export const config = load();
export type Config = RuntimeYaml;

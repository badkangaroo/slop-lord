/**
 * harness/open-browser.ts
 *
 * Drives the already logged-in Chrome through open-browser-use.
 * The public SDK is locked inside `obu mcp stdio` (it will not import
 * into this process), so this module speaks MCP over that CLI.
 *
 * Install once: https://github.com/open-browser-use/open-browser-use#install-current-preview
 * Load the extension into the same Chrome profile you use for TikTok, then
 * open the popup until it says Connected.
 *
 * If the CLI or the extension is missing, callers should keep using CDP.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import { config } from "../config/index.js";

interface JsonRpc {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

let child: ChildProcessWithoutNullStreams | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let lineBuf = "";
let jsArgName = "code";
const sideChannel: string[] = [];

export function obuBin(): string {
  return config.openBrowser.bin;
}

export function isObuInstalled(): boolean {
  return config.openBrowser.enabled && fs.existsSync(obuBin());
}

function send(msg: JsonRpc): void {
  if (!child?.stdin.writable) throw new Error("[obu] MCP process is not running");
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function onData(chunk: Buffer): void {
  lineBuf += chunk.toString("utf8");
  while (true) {
    const nl = lineBuf.indexOf("\n");
    if (nl === -1) return;
    const raw = lineBuf.slice(0, nl).trim();
    lineBuf = lineBuf.slice(nl + 1);
    if (!raw) continue;
    let msg: JsonRpc;
    try {
      msg = JSON.parse(raw) as JsonRpc;
    } catch {
      continue;
    }
    if (msg.id == null || !pending.has(msg.id)) {
      if (msg.method) sideChannel.push(JSON.stringify(msg));
      continue;
    }
    const waiter = pending.get(msg.id)!;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(`[obu] ${msg.error.message}`));
    else waiter.resolve(msg.result);
  }
}

async function ensureSession(): Promise<void> {
  if (child && !child.killed) return;
  if (!isObuInstalled()) {
    throw new Error(`[obu] CLI not found at ${obuBin()}. Install open-browser-use first.`);
  }

  child = spawn(obuBin(), ["mcp", "stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", onData);
  child.stderr.on("data", (chunk: Buffer) => {
    const line = chunk.toString("utf8").trim();
    if (line) console.warn(`[obu] ${line}`);
  });
  child.on("exit", () => {
    child = null;
    for (const waiter of pending.values()) waiter.reject(new Error("[obu] MCP process exited"));
    pending.clear();
  });

  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "slop-lord", version: "0.1.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const listed = (await request("tools/list", {})) as {
    tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>;
  };
  const jsTool = listed.tools?.find((t) => t.name === "js");
  const props = Object.keys(jsTool?.inputSchema?.properties ?? {});
  jsArgName = props.find((p) => /code|source|script|javascript/i.test(p)) ?? props[0] ?? "code";
}

/** Returns the browser_status tool payload, or null when the CLI is absent. */
export async function browserStatus(): Promise<unknown | null> {
  if (!isObuInstalled()) return null;
  await ensureSession();
  const result = (await request("tools/call", {
    name: "browser_status",
    arguments: {},
  })) as { content?: Array<{ type: string; text?: string }> };
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * JavaScript preamble. `tab` is the browser's current tab.
 * A missing tab is an error. This does not open a new one.
 * The caller should `goto` on `tab` and end with `browser.turnEnded()`,
 * which keeps the tab. `finishTurn({ keep: [] })` closes it.
 */
export const activeTabPreamble = `
var browser = await agent.browsers.get("chrome");
var tab = null;
var __owned = await browser.tabs.list().catch(() => []);
if (__owned.length) tab = __owned[0];
if (!tab) {
  var __selected = await browser.tabs.selected().catch(() => null);
  if (__selected && typeof __selected.attach === "function") tab = __selected;
  else if (__selected) {
    var __sid = __selected.id ?? __selected.tabId ?? __selected.tab_id;
    if (__sid != null) tab = await browser.user.claimTab(__sid);
  }
}
if (!tab) {
  var __found = await browser.user.discoverTabs().catch(() => []);
  var __pick = __found[0];
  if (__pick) tab = await browser.user.claimTab(__pick.id ?? __pick.tabId ?? __pick.tab_id);
}
if (!tab) throw new Error("No open tab to reuse. Refusing to open a new one.");
await tab.attach();
`;

/**
 * Run `body` against the already open tab. `body` may use `browser` and `tab`.
 */
export async function runOnActiveTab(body: string): Promise<string> {
  return runBrowserJs(`${activeTabPreamble}\n${body}`);
}

/**
 * Run one turn of JavaScript inside the open-browser-use kernel.
 * `agent` is already bound. End the turn with `browser.turnEnded()`
 * when the script should keep the logged-in session.
 */
export async function runBrowserJs(code: string): Promise<string> {
  await ensureSession();
  sideChannel.length = 0;
  const result = (await request("tools/call", {
    name: "js",
    arguments: { [jsArgName]: code },
  })) as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: { displays?: Array<{ type?: string; value?: unknown }>; error?: string | null };
  };
  const displays = result.structuredContent?.displays
    ?.map((d) => {
      if (d.value == null) return "";
      return typeof d.value === "string" ? d.value : JSON.stringify(d.value);
    })
    .filter(Boolean)
    .join("\n") ?? "";
  const text = result.content?.map((c) => c.text ?? "").filter(Boolean).join("\n") ?? "";
  if (result.isError || result.structuredContent?.error) {
    throw new Error(`[obu] ${result.structuredContent?.error || displays || text || "js tool failed"}`);
  }
  return displays || text;
}

export async function closeOpenBrowser(): Promise<void> {
  if (!child) return;
  child.kill("SIGTERM");
  child = null;
}

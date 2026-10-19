/**
 * Download one TikTok video through the logged-in open-browser-use session.
 * Usage: npx tsx scripts/demo-download.ts <videoUrl>
 */
import fs from "node:fs";
import path from "node:path";
import { closeOpenBrowser, runBrowserJs } from "../harness/open-browser.js";

const pageUrl = process.argv[2];
if (!pageUrl) throw new Error("pass a TikTok video URL");
const step = 60_000;

const loadCode = `
const browser = await agent.browsers.get("chrome");
const tab = await browser.tabs.create(${JSON.stringify(pageUrl)});
await tab.attach();
await tab.waitForLoadState("domcontentloaded").catch(() => {});
await new Promise((r) => setTimeout(r, 6000));
const meta = await tab.evaluate(() => {
  const el = document.querySelector("#__UNIVERSAL_DATA_FOR_REHYDRATION__");
  if (!el) return { error: "no blob", title: document.title, url: location.href };
  const scope = JSON.parse(el.textContent).__DEFAULT_SCOPE__ || {};
  const vdKey = Object.keys(scope).find((k) => k.includes("video-detail"));
  const item = vdKey ? scope[vdKey]?.itemInfo?.itemStruct : null;
  if (!item) return { error: "no item", title: document.title, keys: Object.keys(scope).slice(0, 20) };
  return {
    id: item.id,
    desc: item.desc || "",
    author: item.author?.uniqueId || "",
    plays: item.stats?.playCount,
    likes: item.stats?.diggCount,
    url: item.video.downloadAddr || item.video.playAddr,
  };
});
if (meta.error || !meta.url) {
  display(JSON.stringify(meta));
  await browser.finishTurn({ keep: [] });
} else {
const cookieResult = await tab.dev.cdp("Network.getCookies", { urls: ["https://www.tiktok.com/"] });
const resp = await fetch(meta.url, { headers: { Referer: "https://www.tiktok.com/", Cookie: (cookieResult.cookies || []).map((c) => c.name + "=" + c.value).join("; ") } });
const buf = Buffer.from(await resp.arrayBuffer());
globalThis.__slopB64 = buf.toString("base64");
globalThis.__i = 0;
display(JSON.stringify({ id: meta.id, desc: meta.desc, author: meta.author, plays: meta.plays, likes: meta.likes, bytes: buf.length, status: resp.status, b64Length: globalThis.__slopB64.length }));
await browser.turnEnded();
}
`;

const sliceCode = `
globalThis.__end = Math.min(globalThis.__i + ${step}, globalThis.__slopB64.length);
display(JSON.stringify({ start: globalThis.__i, end: globalThis.__end, data: globalThis.__slopB64.slice(globalThis.__i, globalThis.__end) }));
globalThis.__i = globalThis.__end;
await agent.browsers.get("chrome").then((b) => b.turnEnded());
`;

async function main() {
  const summary = JSON.parse(await runBrowserJs(loadCode));
  console.log(JSON.stringify({ id: summary.id, author: summary.author, plays: summary.plays, likes: summary.likes, desc: summary.desc, bytes: summary.bytes }));
  if (summary.status !== 200) throw new Error("download failed");
  let b64 = "";
  while (b64.length < summary.b64Length) {
    const part = JSON.parse(await runBrowserJs(sliceCode));
    b64 += part.data;
    process.stdout.write(`\r${b64.length}/${summary.b64Length}`);
  }
  process.stdout.write("\n");
  const buf = Buffer.from(b64, "base64");
  const dest = path.resolve("downloads", `${summary.id}.mp4`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  fs.writeFileSync(path.resolve("downloads", `${summary.id}.json`), JSON.stringify(summary, null, 2));
  console.log(dest);
}

main()
  .catch((err) => {
    console.error(String(err).slice(0, 800));
    process.exitCode = 1;
  })
  .finally(() => closeOpenBrowser());

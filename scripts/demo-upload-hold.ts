import path from "node:path";
import { closeOpenBrowser, runOnActiveTab } from "../harness/open-browser.js";

const videoPath = path.resolve("generated/ref2va_swap_00003_.mp4");
const caption = "Cartoon version of the stereo love funk dance #parody";

const code = `
const found = await browser.user.discoverTabs().catch(() => []);
const rows = found.map((t) => ({
  id: t.id ?? t.tabId ?? t.tab_id,
  url: t.metadata?.url || t.url || "",
}));
const pick = rows.find((r) => r.url.includes("tiktokstudio/upload"))
  || rows.find((r) => r.url.includes("tiktok.com") && !r.url.includes("/login"));
tab = await browser.user.claimTab(pick.id);
await tab.attach();
await tab.goto("https://www.tiktok.com/tiktokstudio/upload");
await tab.waitForLoadState("domcontentloaded").catch(() => {});
await new Promise((r) => setTimeout(r, 4000));
let attached = "cdp";
try {
  await tab.dev.cdp("DOM.enable", {});
  const doc = await tab.dev.cdp("DOM.getDocument", { depth: -1, pierce: true });
  const root = doc.root?.nodeId ?? doc.result?.root?.nodeId;
  const foundNode = await tab.dev.cdp("DOM.querySelector", { nodeId: root, selector: 'input[type="file"]' });
  const nodeId = foundNode.nodeId ?? foundNode.result?.nodeId;
  if (!nodeId) throw new Error("file input node " + JSON.stringify(foundNode).slice(0, 200));
  await tab.dev.cdp("DOM.setFileInputFiles", { nodeId, files: [${JSON.stringify(videoPath)}] });
} catch (err) {
  attached = String(err).slice(0, 400);
}
await new Promise((r) => setTimeout(r, 4000));
try {
  const editor = tab.locator('[data-e2e="caption_container"] .public-DraftEditor-content');
  if (await editor.isVisible().catch(() => false)) {
    await editor.click({ force: true });
    await editor.type(${JSON.stringify(caption)}, { delay: 8 });
    attached += "+caption";
  }
} catch (err) {
  attached += " caption:" + String(err).slice(0, 160);
}
const page = await tab.evaluate(() => ({
  url: location.href,
  title: document.title,
  post: !!document.querySelector('[data-e2e="post_video_button"]'),
  text: (document.body.innerText || "").slice(0, 180),
}));
display(JSON.stringify({ attached, page }));
await browser.turnEnded();
`;

try {
  console.log(await runOnActiveTab(code));
} finally {
  await closeOpenBrowser();
}

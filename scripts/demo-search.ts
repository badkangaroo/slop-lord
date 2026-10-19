import { closeOpenBrowser, runBrowserJs } from "../harness/open-browser.js";

const code = `
const browser = await agent.browsers.get("chrome");
const tab = await browser.tabs.create("https://www.tiktok.com/search/video?q=dance");
await tab.attach();
await tab.waitForLoadState("domcontentloaded").catch(() => {});
await new Promise((r) => setTimeout(r, 5000));
const videos = await tab.evaluate(() => {
  const anchors = Array.from(document.querySelectorAll('a[href*="/video/"]'));
  const seen = new Set();
  const out = [];
  for (const a of anchors) {
    const href = a.href.split("?")[0];
    const id = href.split("/video/")[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, url: href });
    if (out.length >= 6) break;
  }
  return out;
});
display(JSON.stringify(videos));
await browser.finishTurn({ keep: [] });
`;

try {
  console.log(await runBrowserJs(code));
} finally {
  await closeOpenBrowser();
}

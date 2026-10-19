import { closeOpenBrowser, runBrowserJs, runOnActiveTab } from "../harness/open-browser.js";

const list = (label: string) => `
var __src = await browser.user.discoverTabs().catch(() => []);
var rows = __src.map((t) => ({
  id: String(t.id ?? t.tabId ?? t.tab_id),
  url: t.metadata?.url || t.url || "",
}));
display(JSON.stringify({ ${JSON.stringify(label)}: rows }));
await browser.turnEnded();
`;

try {
  const before = await runBrowserJs(`
var browser = await agent.browsers.get("chrome");
${list("before")}
`);
  const used = await runOnActiveTab(`
var page = await tab.evaluate(() => ({ url: location.href, title: document.title }));
display(JSON.stringify({ usedId: String(tab.id), page }));
await browser.turnEnded();
`);
  const after = await runBrowserJs(`
var browser = await agent.browsers.get("chrome");
${list("after")}
`);
  const a = JSON.parse(before).before as Array<{ id: string; url: string }>;
  const b = JSON.parse(after).after as Array<{ id: string; url: string }>;
  const usedInfo = JSON.parse(used);
  const beforeIds = new Set(a.map((t) => t.id));
  const created = b.filter((t) => !beforeIds.has(t.id));
  console.log(JSON.stringify({
    beforeCount: a.length,
    afterCount: b.length,
    created: created.map((t) => t.url),
    usedId: usedInfo.usedId,
    usedUrl: usedInfo.page?.url,
    urls: b.map((t) => t.url),
  }, null, 2));
} finally {
  await closeOpenBrowser();
}

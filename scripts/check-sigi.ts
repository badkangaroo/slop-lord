import { chromium } from "playwright";

const b = await chromium.connectOverCDP("http://localhost:9222");
const ctx = b.contexts()[0];
const page = ctx.pages().find(p => p.url().includes("tiktok.com")) ?? ctx.pages()[0];

await page.goto("https://www.tiktok.com/@phatcorner/video/7676965869003492638", {
  waitUntil: "domcontentloaded", timeout: 20000
});
await page.waitForTimeout(2000);

const data = await page.evaluate(`
  (() => {
    const el = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
    if (!el) return null;
    try {
      const scope = JSON.parse(el.textContent).__DEFAULT_SCOPE__ || {};
      const vdKey = Object.keys(scope).find(k => k.includes('video-detail'));
      const item = vdKey ? scope[vdKey]?.itemInfo?.itemStruct : null;
      if (!item) return { error: 'no itemStruct', keys: Object.keys(scope) };
      return {
        id: item.id,
        desc: item.desc,
        playAddr: item.video?.playAddr?.slice(0, 80),
        downloadAddr: item.video?.downloadAddr?.slice(0, 80),
        originCover: item.video?.originCover?.slice(0, 80),
        cover: item.video?.cover?.slice(0, 80),
        duration: item.video?.duration,
        plays: item.stats?.playCount,
        subtitleCount: item.video?.subtitleInfos?.length ?? 0,
      };
    } catch(e) { return { error: String(e) }; }
  })()
`);

console.log(JSON.stringify(data, null, 2));
await b.close();

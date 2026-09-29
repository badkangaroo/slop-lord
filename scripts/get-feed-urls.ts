import { chromium } from "playwright";

const b = await chromium.connectOverCDP("http://localhost:9222");
const ctx = b.contexts()[0];
const page = ctx.pages().find(p => p.url().includes("tiktok.com/foryou")) ?? ctx.pages()[0];

const cards = await page.evaluate(`
  (() => {
    const items = document.querySelectorAll('[data-e2e="recommend-list-item-container"]');
    const out = [];
    for (const item of items) {
      const avatarLink = item.querySelector('[data-e2e="video-author-avatar"]');
      const videoLink  = item.querySelector('a[href*="/video/"]');
      const desc       = item.querySelector('[data-e2e="video-desc"]');
      const likes      = item.querySelector('[data-e2e="like-count"]');
      const authorUrl  = avatarLink?.href ?? '';
      const author     = (authorUrl.match(/@([^/?]+)/) || [])[1] ?? '';
      if (author) out.push({
        author,
        authorUrl,
        videoUrl: videoLink?.href ?? null,
        desc: (desc?.textContent ?? '').trim().slice(0, 80),
        likes: (likes?.textContent ?? '?').trim()
      });
      if (out.length >= 5) break;
    }
    return { itemCount: items.length, cards: out };
  })()
`);

console.log(JSON.stringify(cards, null, 2));
await b.close();

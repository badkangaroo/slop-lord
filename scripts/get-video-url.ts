import { chromium } from "playwright";

// Navigate to the top card author's profile page and grab their latest video URL
const b = await chromium.connectOverCDP("http://localhost:9222");
const ctx = b.contexts()[0];
const page = ctx.pages().find(p => p.url().includes("tiktok.com")) ?? ctx.pages()[0];

// Pick the first card's author
const author = "phatcorner";
console.log(`Navigating to @${author} profile…`);
await page.goto(`https://www.tiktok.com/@${author}`, { waitUntil: "domcontentloaded", timeout: 15000 });
await page.waitForTimeout(2000);

// Grab the first video link from their grid
const videoUrl = await page.evaluate(`
  (() => {
    const a = document.querySelector('a[href*="/video/"]');
    return a ? a.href : null;
  })()
`);

console.log("Video URL:", videoUrl);
await b.close();

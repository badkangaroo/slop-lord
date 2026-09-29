import { chromium } from "playwright";

const b = await chromium.connectOverCDP("http://localhost:9222");
const ctx = b.contexts()[0];
const page = ctx.pages().find(p => p.url().includes("tiktok.com")) ?? ctx.pages()[0];

// Test the exact fetch path the thumbnail fetcher uses
const result = await page.evaluate(`
  (async () => {
    const url = 'https://p19-common-sign.tiktokcdn-us.com/tos-useast8-p-0068-tx2/oAGEqDq9IzxIq4FC';
    try {
      const r = await fetch(url, { credentials: 'include' });
      const status = r.status;
      const ct = r.headers.get('content-type');
      const buf = await r.arrayBuffer();
      return { status, ct, bytes: buf.byteLength, ok: r.ok };
    } catch(e) { return { error: String(e) }; }
  })()
`);

console.log("Fetch result:", JSON.stringify(result, null, 2));

// Also test playAddr fetch
const result2 = await page.evaluate(`
  (async () => {
    const url = 'https://v16-webapp-prime.us.tiktok.com/video/tos/useast8/tos-useast8-ve-0068c002';
    try {
      const r = await fetch(url, { credentials: 'include' });
      return { status: r.status, ok: r.ok, ct: r.headers.get('content-type') };
    } catch(e) { return { error: String(e) }; }
  })()
`);

console.log("PlayAddr fetch:", JSON.stringify(result2, null, 2));
await b.close();

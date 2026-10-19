import { closeOpenBrowser, runBrowserJs } from "../harness/open-browser.js";

const text = await runBrowserJs(`
var browser = await agent.browsers.get("chrome");
var ready = null;
try { ready = await browser.ensureReady(); } catch (e) { ready = { error: String(e).slice(0, 300) }; }
var diag = browser.diagnostics || {};
var life = browser.lifecycleDiagnostics || {};
display(JSON.stringify({
  type: browser.info && browser.info.type,
  backend: browser.backend,
  ready,
  diagKeys: Object.keys(diag).slice(0, 20),
  extension: diag.extension ? {
    tabs: diag.extension.tabs,
    sessions: diag.extension.sessions,
    stale_tabs: diag.extension.stale_tabs,
  } : null,
}));
await browser.turnEnded();
`);
console.log(text);
await closeOpenBrowser();

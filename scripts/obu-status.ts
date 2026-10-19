/**
 * Check whether the pipeline can see the logged-in Chrome through
 * open-browser-use. Does not launch a browser.
 */
import "dotenv/config";
import { browserStatus, closeOpenBrowser, isObuInstalled, obuBin } from "../harness/open-browser.js";

if (!isObuInstalled()) {
  console.log(`[obu] CLI missing at ${obuBin()}`);
  console.log("[obu] Install the preview, load the extension, then rerun npm run obu:status");
  process.exit(1);
}

const status = await browserStatus();
console.log(JSON.stringify(status, null, 2));
await closeOpenBrowser();

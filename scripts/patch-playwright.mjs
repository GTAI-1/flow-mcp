// Chrome 156 rejects Browser.setDownloadBehavior for the default browser context ("Browser context management is
// not supported"), and Playwright sends exactly that while attaching in connectOverCDP, so every tool failed before
// flow-mcp ran a line (issue #22). This makes Playwright tolerate that one error. Run on every npm install
// (postinstall); applying it twice is a no-op.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const file = join(dirname(require.resolve("playwright-core/package.json")), "lib", "coreBundle.js");
const MARK = "Browser context management is not supported";
const src = readFileSync(file, "utf8");

if (src.includes(MARK)) {
  console.log("patch-playwright: already applied");
} else {
  const call = /(promises2\.push\(this\._browser\._session\.send\("Browser\.setDownloadBehavior", \{[^}]*\}\))\);/;
  if (!call.test(src)) {
    console.warn("patch-playwright: setDownloadBehavior call not found; Playwright changed, check issue #22 before using Chrome 156+");
  } else {
    const patched = src.replace(
      call,
      `$1.catch((e) => { if (!String(e && e.message).includes("${MARK}")) throw e; }));`,
    );
    writeFileSync(file, patched);
    console.log("patch-playwright: applied");
  }
}

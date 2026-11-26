// Checks the tile-menu steps (Download, Rename) against a stand-in page whose menus open a moment after the click,
// as Flow's did on a Windows PC on 2026-11-25. No Flow, no Google account, no credits: it runs its own headless Chrome
// on a throwaway profile, never the Flow profile, and its downloads land in a scratch folder (never ~/Downloads, which
// a running flow-mcp watches).
//   npm run build && node scripts/check-tile-menus.mjs
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "flow-menus-"));
process.env.FLOW_MCP_HOME = home; // read when dist/chrome.js loads: downloads go to <home>/downloads
const { chromium } = await import("playwright-core");
const flow = await import("../dist/flow.js");

const ID = "0b9f3c2e-1111-4a2b-9c3d-123456789abc";

// One grid tile with Flow's names: a hover bar holding "More options" (shown only while the pointer is over the tile), a
// menu (Download, Rename) and Download's size submenu. Every menu appears `delay` ms after the click that opens it, over
// an invisible full-page backdrop that closes it when clicked, as Angular's cdk overlay does in Flow; Escape closes it too.
// The backdrop matters: without it, a menu that opened late stays usable for the next attempt and hides the bug.
const standIn = (delay) => `<!doctype html><html><body style="margin:0">
<div class="page-container" style="height:700px;overflow:auto">
  <flow-grid-tile-container aria-label="Old title" style="display:block;position:relative;width:300px;height:300px">
    <flow-image-tile><img data-media-id="${ID}" alt="" style="display:block;width:300px;height:300px;background:#ccc"></flow-image-tile>
    <div class="bar" style="display:none;position:absolute;top:6px;right:6px"><button aria-label="More options">...</button></div>
  </flow-grid-tile-container>
</div>
<script>
const DELAY = ${delay};
const tile = document.querySelector("flow-grid-tile-container");
const bar = tile.querySelector(".bar");
tile.addEventListener("mouseenter", () => (bar.style.display = "block"));
tile.addEventListener("mouseleave", () => (bar.style.display = "none"));
const closeMenus = () => document.querySelectorAll('[role="menu"], .cdk-overlay-backdrop').forEach((m) => m.remove());
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });
function openMenu(items) {
  setTimeout(() => {
    closeMenus();
    const backdrop = document.createElement("div");
    backdrop.className = "cdk-overlay-backdrop cdk-overlay-backdrop-showing";
    backdrop.style.cssText = "position:fixed;inset:0;z-index:10";
    backdrop.addEventListener("click", closeMenus);
    document.body.appendChild(backdrop);
    const m = document.createElement("div");
    m.setAttribute("role", "menu");
    m.style.cssText = "position:fixed;top:40px;left:360px;z-index:11;background:#fff;border:1px solid #888";
    for (const [label, act] of items) {
      const it = document.createElement("div");
      it.setAttribute("role", "menuitem");
      it.tabIndex = 0;
      it.textContent = label;
      it.style.cssText = "padding:8px 16px";
      it.onclick = () => { closeMenus(); act(); };
      m.appendChild(it);
    }
    document.body.appendChild(m);
  }, DELAY);
}
function saveStill() {
  const bytes = new Uint8Array(64);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
  a.download = "still.jpg";
  document.body.appendChild(a);
  a.click();
}
function startRename() {
  const input = document.createElement("input");
  input.value = tile.getAttribute("aria-label");
  tile.appendChild(input);
  input.focus();
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    tile.setAttribute("aria-label", input.value);
    input.remove();
  });
}
tile.querySelector('[aria-label="More options"]').onclick = () =>
  openMenu([
    ["Download", () => openMenu([["1K Original size", saveStill], ["2K Upscaled", () => {}]])],
    ["Rename", startRename],
  ]);
</script></body></html>`;

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, why: String(err?.message ?? err).split("\n")[0] });
  }
}

// A persistent context is Chrome's default context, the one Browser.setDownloadBehavior (sent without a context id,
// as the driver does over CDP) applies to.
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "flow-menus-profile-")), {
  channel: "chrome",
  headless: true,
  viewport: { width: 900, height: 700 },
});
try {
  for (const delay of [0, 400]) {
    await check(`download, menus open after ${delay} ms`, async () => {
      const page = await context.newPage();
      page.setDefaultTimeout(5000); // a click the backdrop swallows fails in 5 s here, not Playwright's 30
      await page.setContent(standIn(delay));
      const files = await flow.downloadMedia(page, ID, join(home, `still-${delay}`), "original");
      const head = readFileSync(files[0]).subarray(0, 3);
      if (!(head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)) throw new Error(`not a JPEG: ${files[0]}`);
      await page.close();
    });
    await check(`rename, menu opens after ${delay} ms`, async () => {
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      await page.setContent(standIn(delay));
      const tile = page.locator("flow-grid-tile-container").first();
      const done = await flow.renameTile(page, tile, `Renamed-${delay}`);
      const title = await tile.getAttribute("aria-label");
      if (!done || title !== `Renamed-${delay}`) throw new Error(`renameTile answered ${done}, the title is "${title}"`);
      await page.close();
    });
  }
} finally {
  await context.close();
}
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${r.why}`}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);

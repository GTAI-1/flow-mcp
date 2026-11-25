// Checks how a job reads Flow's failed tiles, on a stand-in grid in its own headless Chrome (never the Flow profile,
// no Google account, no credits). Since 2026-11 Flow titles a failed tile with the prompt, so a failed tile looked like
// a finished id-less still, and a new failure whose prompt matched an older failure looked already known.
//   npm run build && node scripts/check-error-tiles.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOW_MCP_HOME = mkdtempSync(join(tmpdir(), "flow-errors-"));
const { chromium } = await import("playwright-core");
const flow = await import("../dist/flow.js");

const FLAGGED = "We noticed some unusual activity. Note that browser extensions that modify the page may cause issues. Please visit the Help Center for more information.";
const PLAIN = "Sorry, this image failed to generate.";

// Flow's grid as the driver sees it: newest tile first; a finished still carries data-media-id, a failed one holds a
// flow-error-tile (Failed / reason / "You have not been charged" / Retry, Reuse prompt, Delete) and the prompt as title.
const GRID = `<!doctype html><html><body style="margin:0"><div class="page-container" style="height:900px;overflow:auto"></div>
<script>
const grid = document.querySelector(".page-container");
function container(title) {
  const t = document.createElement("flow-grid-tile-container");
  t.setAttribute("role", "group");
  t.setAttribute("aria-label", title);
  t.style.cssText = "display:block;width:280px;height:120px;margin:4px;position:relative";
  return t;
}
window.still = (title, id) => {
  const t = container(title);
  t.innerHTML = '<flow-tile-container><flow-image-tile><img data-media-id="' + id + '" alt="" style="width:120px;height:110px;background:#ccc"></flow-image-tile></flow-tile-container>';
  return t;
};
window.busy = (prompt, pct) => {
  const t = container(prompt);
  t.innerHTML = "<flow-tile-container><flow-image-tile><div>" + pct + "%</div></flow-image-tile></flow-tile-container>";
  return t;
};
window.failed = (prompt, message, onRetry) => {
  const t = container(prompt);
  t.innerHTML = '<flow-tile-container><flow-image-tile><flow-error-tile><div class="error-tile"><div class="error-message">' +
    '<div class="error-title">Failed</div><div class="error-subtitle"><span class="error-message-text"> ' + message + ' </span>' +
    '<span class="disclaimer-message">You have not been charged for this generation.</span></div></div>' +
    '<button aria-label="Retry">refresh</button><button aria-label="Reuse prompt">undo</button><button aria-label="Delete">delete</button>' +
    "</div></flow-error-tile></flow-image-tile></flow-tile-container>";
  t.querySelector('[aria-label="Retry"]').onclick = () => onRetry && onRetry(t);
  return t;
};
window.atTop = (tile) => grid.prepend(tile);
window.later = (ms, fn) => setTimeout(fn, ms);
</script></body></html>`;

const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, s: (Date.now() - started) / 1000 });
  } catch (err) {
    results.push({ name, ok: false, s: (Date.now() - started) / 1000, why: String(err?.message ?? err).split("\n")[0] });
  }
}
const expectRejection = async (promise, pattern) => {
  const outcome = await promise.then((v) => ({ value: v }), (e) => ({ error: e }));
  if (!outcome.error) throw new Error(`expected a refusal, got finished media ${JSON.stringify(outcome.value)}`);
  if (!pattern.test(outcome.error.message)) throw new Error(`wrong error: ${outcome.error.message}`);
};

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "flow-errors-profile-")), {
  channel: "chrome",
  headless: true,
  viewport: { width: 900, height: 900 },
});
const grid = async (setup) => {
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.setContent(GRID);
  await page.evaluate(setup);
  return page;
};

try {
  await check("a failed tile is never taken for a finished still", async () => {
    const page = await grid(() => {
      atTop(still("Catalogo-b-scene-04", "aaaaaaaa-1111-4111-8111-000000000001"));
      atTop(still("Catalogo-b-scene-03", "aaaaaaaa-1111-4111-8111-000000000002"));
    });
    const before = await flow.mediaIds(page);
    await page.evaluate((m) => later(500, () => atTop(failed("Close-up beauty photo of a woman wearing it", m))), FLAGGED);
    await expectRejection(flow.waitForNewMedia(page, before, 1, 15_000, undefined, "image"), /unusual activity/);
    await page.close();
  });

  await check("a new failure with the same prompt as an old one is seen", async () => {
    const page = await grid((m) => {
      atTop(still("Catalogo-a-scene-01", "aaaaaaaa-1111-4111-8111-000000000003"));
      atTop(failed("Luxury jewelry photo on marble", m));
    }, FLAGGED);
    const before = await flow.mediaIds(page);
    await page.evaluate((m) => later(500, () => atTop(failed("Luxury jewelry photo on marble", m))), FLAGGED);
    await expectRejection(flow.waitForNewMedia(page, before, 1, 12_000, undefined, "image"), /unusual activity/);
    await page.close();
  });

  await check("old failures at the top of the grid raise no alarm", async () => {
    const page = await grid((m) => {
      atTop(still("Catalogo-a-scene-01", "aaaaaaaa-1111-4111-8111-000000000004"));
      atTop(failed("Close-up beauty photo of a woman wearing it", m));
      atTop(failed("Luxury jewelry photo on marble", m));
    }, FLAGGED);
    const before = await flow.mediaIds(page);
    // The first poll (2 s) sees no new tile at all, as right after Start generation; then progress, then the still.
    await page.evaluate(() => {
      later(2500, () => atTop(busy("Gift box photo", 12)));
      later(5000, () => document.querySelector(".page-container").firstElementChild.replaceWith(still("Gift box photo", "aaaaaaaa-1111-4111-8111-000000000009")));
    });
    const got = await flow.waitForNewMedia(page, before, 1, 15_000, undefined, "image");
    if (got.join() !== "aaaaaaaa-1111-4111-8111-000000000009") throw new Error(`picked ${JSON.stringify(got)}`);
    await page.close();
  });

  await check("a plain failure is retried with Flow's Retry", async () => {
    const page = await grid(() => atTop(still("Catalogo-a-scene-01", "aaaaaaaa-1111-4111-8111-000000000005")));
    const before = await flow.mediaIds(page);
    await page.evaluate((m) => {
      later(500, () =>
        atTop(
          failed("Editorial photo", m, (t) => {
            const progress = busy("Editorial photo", 40);
            t.replaceWith(progress);
            later(1500, () => progress.replaceWith(still("Editorial photo", "aaaaaaaa-1111-4111-8111-000000000007")));
          }),
        ),
      );
    }, PLAIN);
    const got = await flow.waitForNewMedia(page, before, 1, 20_000, undefined, "image");
    if (got.join() !== "aaaaaaaa-1111-4111-8111-000000000007") throw new Error(`picked ${JSON.stringify(got)}`);
    await page.close();
  });
} finally {
  await context.close();
}
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name} (${r.s.toFixed(1)} s)${r.ok ? "" : `  -> ${r.why}`}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);

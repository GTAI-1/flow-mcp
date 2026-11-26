// Checks how an upload answers Flow's "Rights to use this image" dialog (Cancel / I agree, shown since 2026-11 once the
// file is chosen), on a stand-in page in its own headless Chrome (never the Flow profile, no Google account).
// Agreeing is a statement about the user's rights to the picture, so flow-mcp only agrees when its process was started
// with FLOW_MCP_AGREE_UPLOAD_RIGHTS=1; otherwise the question waits for the user and, unanswered, is declined.
//   npm run build && node scripts/check-upload-rights.mjs
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOW_MCP_HOME = mkdtempSync(join(tmpdir(), "flow-rights-"));
const { chromium } = await import("playwright-core");
const flow = await import("../dist/flow.js");

// Flow's upload path as the driver sees it: "Add media menu" -> menu item "Upload" -> file chooser -> the rights
// dialog in the cdk overlay -> after "I agree", a grid tile named after the file that gets a media id when processed.
const PAGE = `<!doctype html><html><body>
<button aria-label="Add media menu">add</button>
<div role="menu" id="menu" hidden><div role="menuitem" id="up" tabindex="0">Upload</div></div>
<input type="file" id="file" style="display:none">
<div class="page-container"></div>
<div class="cdk-overlay-container"></div>
<script>
window.answer = null;
document.querySelector('[aria-label="Add media menu"]').onclick = () => (document.getElementById("menu").hidden = false);
document.getElementById("up").onclick = () => document.getElementById("file").click();
document.getElementById("file").onchange = (e) => {
  const name = e.target.files[0].name;
  const overlay = document.querySelector(".cdk-overlay-container");
  overlay.innerHTML = '<div role="dialog" aria-label="Rights to use this image"><p>Rights to use this image</p>' +
    '<button>Cancel</button><button>I agree</button></div>';
  const [cancel, agree] = overlay.querySelectorAll("button");
  cancel.onclick = () => { overlay.innerHTML = ""; window.answer = "cancel"; };
  agree.onclick = () => {
    overlay.innerHTML = "";
    window.answer = "agree";
    setTimeout(() => {
      const t = document.createElement("flow-grid-tile-container");
      t.setAttribute("aria-label", name);
      t.innerHTML = '<img data-media-id="aaaaaaaa-1111-4111-8111-00000000000a">';
      document.querySelector(".page-container").prepend(t);
    }, 300);
  };
};
</script></body></html>`;

const photo = join(mkdtempSync(join(tmpdir(), "flow-rights-photo-")), "peca.jpg");
writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, why: String(err?.message ?? err).split("\n")[0] });
  }
}

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "flow-rights-profile-")), {
  channel: "chrome",
  headless: true,
});
const standIn = async () => {
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.setContent(PAGE);
  return page;
};
const job = (id) => ({ id, status: "running", params: {}, files: [], attempts: 1, createdAt: new Date().toISOString() });

try {
  await check("without FLOW_MCP_AGREE_UPLOAD_RIGHTS it never agrees, declines when nobody answers, and says why", async () => {
    delete process.env.FLOW_MCP_AGREE_UPLOAD_RIGHTS;
    const page = await standIn();
    const outcome = await flow.uploadAsset(page, job("job00001"), photo, "ref1", 3000).then((v) => ({ value: v }), (e) => ({ error: e }));
    const answer = await page.evaluate(() => window.answer);
    if (answer !== "cancel") throw new Error(`the dialog was answered ${JSON.stringify(answer)}`);
    if (!outcome.error) throw new Error(`the upload went through as ${outcome.value}`);
    if (!/Rights to use this image/.test(outcome.error.message) || !/FLOW_MCP_AGREE_UPLOAD_RIGHTS/.test(outcome.error.message))
      throw new Error(`wrong error: ${outcome.error.message}`);
    await page.close();
  });

  await check("with FLOW_MCP_AGREE_UPLOAD_RIGHTS=1 it agrees and the upload goes through", async () => {
    process.env.FLOW_MCP_AGREE_UPLOAD_RIGHTS = "1";
    const page = await standIn();
    const name = await flow.uploadAsset(page, job("job00002"), photo, "ref1", 5000);
    const answer = await page.evaluate(() => window.answer);
    if (answer !== "agree" || name !== "fm-job00002-ref1.jpg") throw new Error(`answer ${answer}, name ${name}`);
    await page.close();
  });
} finally {
  await context.close();
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : ` - ${r.why}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);

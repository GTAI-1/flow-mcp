// Checks the prompt flow_generate queues for reference images given as "asset:<name>". A character ("asset:Pip") gets
// the CHARACTER LOCK; a picture flow-mcp uploaded itself ("asset:fm-<job>-ref1.jpg", reused by the Aurora catalog for
// styles 02-05) or any other file name is a picture, not a character, and must leave the prompt as written - the lock
// talks about a face, eyes and hair, which a jewelry photo does not have. No Chrome, no Flow: the queue is a stand-in.
//   npm run build && node scripts/check-prompts.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOW_MCP_HOME = mkdtempSync(join(tmpdir(), "flow-prompts-home-"));
process.env.FLOW_MCP_OUTPUT = mkdtempSync(join(tmpdir(), "flow-prompts-out-"));
const { LocalCore } = await import("../dist/core.js");

const core = new LocalCore();
const queued = [];
core.queue = {
  add(params) {
    const job = { id: `job${queued.length + 1}`, status: "queued", params, files: [], attempts: 0, createdAt: new Date().toISOString() };
    queued.push(job);
    return job;
  },
  list: () => queued,
  get: (id) => queued.find((j) => j.id === id),
};

const PROMPT = "Luxury jewelry catalog photo of the earrings on white";
const promptFor = async (ref) => {
  queued.length = 0;
  await core.generate({
    project: "PromptCheck",
    scenes: [{ type: "image", aspect_ratio: "1:1", max_credits: 0, reference_images: [ref], prompt: PROMPT }],
  });
  return queued[0].params.prompt;
};

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` - ${detail}`}`);
  if (!ok) failed++;
}

const lucia = await promptFor("asset:Dona Lúcia");
check("asset:Dona Lúcia (accented name) is a character", /CHARACTER LOCK — Dona Lúcia must match/.test(lucia), JSON.stringify(lucia));
for (const ref of ["asset:fm-ab12cd34-ref1.jpg", "asset:IMG_5143.HEIC", "asset:peca.png", "asset:Woman packs Santa Claus figurine"]) {
  const prompt = await promptFor(ref);
  check(`${ref} is a picture: the prompt stays as written`, prompt === `${PROMPT}.`, JSON.stringify(prompt));
}
const pip = await promptFor("asset:Pip");
check("asset:Pip is a character: the prompt carries the CHARACTER LOCK", /CHARACTER LOCK — Pip must match/.test(pip), JSON.stringify(pip));

console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);

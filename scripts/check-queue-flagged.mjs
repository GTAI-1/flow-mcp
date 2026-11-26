// Checks that the queue stops sending jobs once Flow has flagged unusual activity (its check for automated traffic):
// the jobs still waiting are cancelled, not started one by one into the same refusal. A plain failure stops nothing.
// No Chrome, no Flow: a stand-in runner.
//   npm run build && node scripts/check-queue-flagged.mjs
// Also: the refusal starts a cooldown shared by every process (a file beside the tab lock), and a job that meets it is
// not started at all. The lock lives in a scratch folder here, never ~/.flow-mcp, or the check would hold up real work.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const scratch = mkdtempSync(join(tmpdir(), "fm-flagged-"));
process.env.FLOW_MCP_TAB_LOCK = join(scratch, "tab.lock");
process.env.FLOW_MCP_PAUSE_MIN_S = "0";
process.env.FLOW_MCP_PAUSE_MAX_S = "0";
const { JobQueue } = await import("../dist/queue.js");
const { flowTabGate, flagCooldownLeft } = await import("../dist/tablock.js");

const FLAGGED =
  'Flow refused this generation: "We noticed some unusual activity. Note that browser extensions that modify the page may cause issues." Nothing was charged.';
const PLAIN = 'Flow reported a failure: "Sorry, this image failed to generate."';

async function run(firstError, gate) {
  const started = [];
  const queue = new JobQueue(async (job) => {
    started.push(job.params.file_stem);
    await new Promise((r) => setTimeout(r, 20));
    if (job.params.file_stem === "scene-01" && firstError) throw new Error(firstError);
    return [`${job.params.file_stem}.jpg`];
  }, gate);
  const scene = (n) => ({ prompt: `scene ${n}`, type: "image", max_credits: 0, output_dir: ".", file_stem: `scene-0${n}` });
  const jobs = [1, 2, 3].map((n) => queue.add(scene(n)));
  for (let i = 0; i < 200 && jobs.some((j) => j.status === "queued" || j.status === "running"); i++)
    await new Promise((r) => setTimeout(r, 10));
  return { started, statuses: jobs.map((j) => j.status), errors: jobs.map((j) => j.error ?? "") };
}

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` - ${detail}`}`);
  if (!ok) failed++;
}

const flagged = await run(FLAGGED);
check(
  "flagged: only the flagged job ran, the waiting ones were cancelled",
  JSON.stringify(flagged.started) === '["scene-01"]' && flagged.statuses.join() === "failed,cancelled,cancelled",
  JSON.stringify(flagged),
);
check(
  "flagged: a cancelled job says why, in Flow's words",
  flagged.errors.slice(1).every((e) => /unusual activity/i.test(e) && /flow_retry/.test(e)),
  JSON.stringify(flagged.errors),
);

check("flagged: the refusal starts the shared cooldown", flagCooldownLeft() > 55 * 60_000, String(flagCooldownLeft()));
const cooled = await run(null, flowTabGate);
check(
  "cooldown: a gated queue starts nothing and says until when",
  cooled.started.length === 0 && cooled.statuses.every((s) => s === "cancelled") && /Not started/.test(cooled.errors[0]),
  JSON.stringify(cooled),
);
rmSync(scratch, { recursive: true, force: true });
check("cooldown: with the file gone, nothing is held", flagCooldownLeft() === 0, String(flagCooldownLeft()));

const plain = await run(PLAIN);
check(
  "plain failure: the rest of the queue still runs",
  plain.started.length === 3 && plain.statuses.join() === "failed,done,done",
  JSON.stringify(plain),
);

console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);

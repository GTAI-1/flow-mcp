// Checks that the queue stops sending jobs once Flow has flagged unusual activity (its check for automated traffic):
// the jobs still waiting are cancelled, not started one by one into the same refusal. A plain failure stops nothing.
// No Chrome, no Flow: a stand-in runner.
//   npm run build && node scripts/check-queue-flagged.mjs
process.env.FLOW_MCP_PAUSE_MIN_S = "0";
process.env.FLOW_MCP_PAUSE_MAX_S = "0";
const { JobQueue } = await import("../dist/queue.js");

const FLAGGED =
  'Flow refused this generation: "We noticed some unusual activity. Note that browser extensions that modify the page may cause issues." Nothing was charged.';
const PLAIN = 'Flow reported a failure: "Sorry, this image failed to generate."';

async function run(firstError) {
  const started = [];
  const queue = new JobQueue(async (job) => {
    started.push(job.params.file_stem);
    await new Promise((r) => setTimeout(r, 20));
    if (job.params.file_stem === "scene-01") throw new Error(firstError);
    return [`${job.params.file_stem}.jpg`];
  });
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

const plain = await run(PLAIN);
check(
  "plain failure: the rest of the queue still runs",
  plain.started.length === 3 && plain.statuses.join() === "failed,done,done",
  JSON.stringify(plain),
);

console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);

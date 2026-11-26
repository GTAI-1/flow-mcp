// Checks the lock that keeps two flow-mcp processes (Claude Desktop's own on 8787 and a watcher's on 8799, both on the
// Chrome at CDP 9333) from driving the one Flow tab at the same time. Real processes, a lock file in a temp folder,
// no Chrome and no Flow.
//   npm run build && node scripts/check-tab-lock.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "flow-tablock-"));
process.env.FLOW_MCP_TAB_LOCK = join(dir, "tab.lock");
process.env.FLOW_MCP_HOME = join(dir, "home");
process.env.FLOW_MCP_PAUSE_MIN_S = "0";
process.env.FLOW_MCP_PAUSE_MAX_S = "0";
const tablockUrl = pathToFileURL(join(import.meta.dirname, "..", "dist", "tablock.js")).href;
const { withFlowTab, flowTabGate } = await import(tablockUrl);
const { JobQueue } = await import("../dist/queue.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Another flow-mcp holding the window for `ms`, in its own process. Resolves once it holds the lock.
async function otherProcess(ms, gapMs = 0) {
  const code = `const t = await import(${JSON.stringify(tablockUrl)}); await t.withFlowTab("job other (image)", () => new Promise((r) => setTimeout(r, ${ms})), { gapMs: ${gapMs} });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: process.env, stdio: "ignore" });
  const exited = new Promise((r) => child.on("exit", () => r(Date.now())));
  for (let i = 0; i < 100 && !existsSync(process.env.FLOW_MCP_TAB_LOCK); i++) await sleep(20);
  return { child, exited };
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, why: String(err?.message ?? err).split("\n")[0] });
  }
}

await check("a job waits while another process uses the window, then runs", async () => {
  const other = await otherProcess(1500);
  const t0 = Date.now();
  let started = 0;
  await withFlowTab("job mine (image)", async () => (started = Date.now()), { waitMs: 10_000 });
  const released = await other.exited;
  if (started - t0 < 1200) throw new Error(`started after ${started - t0} ms, while the other still held the window`);
  if (started + 50 < released - 200) throw new Error("started before the other process let go");
});

await check("a direct call does not wait: it says who is using the window", async () => {
  const other = await otherProcess(3000);
  const outcome = await withFlowTab("flow_assets", async () => "ran", { waitMs: 0 }).then((v) => ({ v }), (e) => ({ e }));
  other.child.kill();
  await other.exited;
  if (!outcome.e) throw new Error(`it ran (${outcome.v})`);
  if (!/Another flow-mcp process \(pid \d+/.test(outcome.e.message)) throw new Error(`wrong error: ${outcome.e.message}`);
});

await check("a lock left by a process that died is taken over", async () => {
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => dead.on("exit", r));
  writeFileSync(process.env.FLOW_MCP_TAB_LOCK, JSON.stringify({ pid: dead.pid, at: Date.now(), what: "job gone" }));
  const t0 = Date.now();
  await withFlowTab("job mine", async () => {}, { waitMs: 5000 });
  if (Date.now() - t0 > 1500) throw new Error(`took ${Date.now() - t0} ms`);
});

await check("the lock is let go when the work fails", async () => {
  await withFlowTab("job fails", async () => { throw new Error("boom"); }).catch(() => {});
  if (existsSync(process.env.FLOW_MCP_TAB_LOCK)) throw new Error("the lock file is still there");
});

await check("back to back across processes, generations keep the pause between them", async () => {
  const other = await otherProcess(200, 1500);
  const released = await other.exited;
  let started = 0;
  await withFlowTab("job mine (image)", async () => (started = Date.now()), { waitMs: 10_000, gapMs: 1500 });
  if (started - released < 1200) throw new Error(`started ${started - released} ms after the other generation ended`);
});

await check("the queue waits for the window, says so on the job, then runs it", async () => {
  const other = await otherProcess(2500);
  let ran = 0;
  const queue = new JobQueue(async () => { ran++; return ["a.jpg"]; }, flowTabGate);
  const job = queue.add({ prompt: "p", type: "image", max_credits: 0, output_dir: dir, file_stem: "scene-01" });
  await sleep(800);
  if (ran || job.status !== "running" || !/waiting for another flow-mcp/i.test(job.progress ?? ""))
    throw new Error(`while held: ran ${ran}, status ${job.status}, progress ${JSON.stringify(job.progress)}`);
  await other.exited;
  for (let i = 0; i < 100 && job.status === "running"; i++) await sleep(50);
  if (ran !== 1 || job.status !== "done") throw new Error(`after: ran ${ran}, status ${job.status}, error ${job.error}`);
});

await check("flow_assets in this process refuses while another process has the window (and never touches it)", async () => {
  process.env.FLOW_MCP_OUTPUT = join(dir, "out");
  const { LocalCore } = await import("../dist/core.js");
  const other = await otherProcess(3000);
  const outcome = await new LocalCore().assets({}).then((v) => ({ v }), (e) => ({ e }));
  other.child.kill();
  await other.exited;
  if (!outcome.e || !/Another flow-mcp process/.test(outcome.e.message)) throw new Error(`got ${JSON.stringify(outcome.v ?? outcome.e?.message)}`);
});

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : ` - ${r.why}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);

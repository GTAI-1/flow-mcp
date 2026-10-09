// Checks the whole life of a background Flow Studio: start, status, stop, free ports, config.json, and that only
// Flow Studio's own Chrome is ever controlled or closed.
// Run after `npm run build`:  node scripts/lifecycle.mjs
// It works in a temporary folder on ports 18787 and 19333, so it never touches ~/.flow-mcp, your Flow sign-in, or a
// Flow Studio already running on 8787. It opens and closes real Chrome windows a few times. Nothing costs credits.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "dist", "cli.js");
const PORT = 18787;
const CDP = 19333;
const TMP = mkdtempSync(join(tmpdir(), "flow-studio-lifecycle-"));
const HOME = join(TMP, "home");
const ENV = { ...process.env, FLOW_MCP_HOME: HOME, FLOW_MCP_PORT: String(PORT), FLOW_MCP_CDP_PORT: String(CDP), FLOW_MCP_OUTPUT: join(TMP, "out") };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Not spawnSync: this script also plays "another program" on a port, and has to keep answering while the command runs.
const run = (file, args, options) =>
  new Promise((done) => {
    const child = spawn(file, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, out });
    });
  });
const cli = (args, env = ENV) => run(process.execPath, [CLI, ...args], { env });
const status = async (env = ENV) => JSON.parse((await cli(["status", "--json"], env)).out);
const get = (url, timeout = 2000) => fetch(url, { signal: AbortSignal.timeout(timeout) }).then((r) => r, () => null);
const health = async (port) => (await get(`http://127.0.0.1:${port}/api/health`))?.json().catch(() => null) ?? null;
const cdpUp = async (port) => Boolean((await get(`http://127.0.0.1:${port}/json/version`))?.ok);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (test, ms = 20_000) => {
  for (let waited = 0; waited < ms; waited += 250) {
    if (await test()) return true;
    await sleep(250);
  }
  return false;
};

let passed = 0;
let failed = 0;
const cleanup = [];
async function check(name, run) {
  try {
    const problem = await run();
    if (problem) throw new Error(problem);
    passed++;
    console.log(`ok ${passed + failed} - ${name}`);
  } catch (err) {
    failed++;
    console.log(`NOT OK ${passed + failed} - ${name}\n     ${err instanceof Error ? err.message : err}`);
  }
}

let pid;
try {
  await check("status on a computer that never ran it: not running, and nothing is created", async () => {
    const s = await status();
    if (s.running || s.chrome.open) return `reported ${JSON.stringify(s)}`;
    if (existsSync(HOME)) return "status created the folder";
  });

  await check("start runs the panel in the background and returns", async () => {
    const r = await cli(["start"]);
    if (r.code !== 0) return r.out;
    const h = await health(PORT);
    if (h?.name !== "flow-mcp" || h.kind !== "daemon") return `health answered ${JSON.stringify(h)}`;
    pid = h.pid;
    if (!r.out.includes(`http://127.0.0.1:${PORT}`)) return `the address was not printed: ${r.out}`;
  });

  await check("start writes config.json with the defaults, in the local folder", async () => {
    const c = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"));
    if (c.port !== 8787 || c.cdpPort !== 9333 || typeof c.output !== "string") return JSON.stringify(c);
  });

  await check("status reports the address, the process and who started it", async () => {
    const s = await status();
    if (!s.running || s.url !== `http://127.0.0.1:${PORT}` || s.pid !== pid || s.started_by !== "daemon") return JSON.stringify(s);
  });

  await check("a second start does not start a second copy", async () => {
    const r = await cli(["start"]);
    if (r.code !== 0 || !r.out.includes("already running")) return r.out;
    if ((await health(PORT))?.pid !== pid) return "the process changed";
    if (await health(PORT + 1)) return "a second copy is answering on the next port";
  });

  await check("the panel page is served, and its controls refuse a caller without the token", async () => {
    const page = await get(`http://127.0.0.1:${PORT}/`);
    if (page?.status !== 200 || !(await page.text()).includes("<html")) return "the page did not load";
    const api = await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, { method: "POST" });
    if (api.status !== 401) return `shutdown without a token answered ${api.status}`;
    if (!alive(pid)) return "it stopped anyway";
  });

  await check("stop ends the background process and leaves nothing behind", async () => {
    const r = await cli(["stop"]);
    if (r.code !== 0) return r.out;
    if (alive(pid)) return `process ${pid} is still alive`;
    if (existsSync(join(HOME, "studio.json"))) return "studio.json was left behind";
    if (await health(PORT)) return "the port still answers";
  });

  await check("stop when nothing is running is harmless", async () => {
    const r = await cli(["stop"]);
    if (r.code !== 0 || !r.out.includes("not running")) return r.out;
  });

  // Another program on the wanted port.
  const other = createServer((_, res) => res.end(JSON.stringify({ name: "something-else" })));
  await new Promise((r) => other.listen(PORT, "127.0.0.1", r));
  cleanup.push(() => other.close());

  await check("a port taken by another program: the next free one is used", async () => {
    const r = await cli(["start"]);
    if (r.code !== 0) return r.out;
    const s = await status();
    if (s.url !== `http://127.0.0.1:${PORT + 1}`) return `running at ${s.url}`;
    if ((await health(PORT + 1))?.kind !== "daemon") return "nothing of ours on the next port";
    pid = s.pid;
  });

  await check("stop ends ours and leaves the other program alone", async () => {
    const r = await cli(["stop"]);
    if (r.code !== 0 || alive(pid)) return r.out;
    if ((await health(PORT))?.name !== "something-else") return "the other program stopped answering";
  });

  await check("the port written in config.json is the one used", async () => {
    writeFileSync(join(HOME, "config.json"), JSON.stringify({ port: PORT + 5, cdpPort: CDP }));
    const { FLOW_MCP_PORT, FLOW_MCP_CDP_PORT, ...env } = ENV;
    const r = await cli(["start"], env);
    if (r.code !== 0) return r.out;
    const s = await status(env);
    const stopped = await cli(["stop"], env);
    if (s.url !== `http://127.0.0.1:${PORT + 5}`) return `running at ${s.url}`;
    if (stopped.code !== 0 || alive(s.pid)) return stopped.out;
  });

  // A Chrome that is not Flow Studio's, sitting on the very port Flow Studio wants.
  const chromePath = [process.env.FLOW_MCP_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find((p) => p && existsSync(p));
  if (!chromePath) throw new Error("Google Chrome not found; set FLOW_MCP_CHROME.");
  const foreign = spawn(chromePath, [`--user-data-dir=${join(TMP, "someone-elses-chrome")}`, `--remote-debugging-port=${CDP}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  cleanup.push(() => foreign.kill());
  if (!(await until(() => cdpUp(CDP)))) throw new Error("The test's own Chrome did not start.");

  await check("a Chrome that is not Flow Studio's is not treated as ours, even on our port", async () => {
    const s = await status();
    if (s.chrome.open) return `status says Flow Chrome is open on ${s.chrome.port}`;
  });

  let ours;
  await check("Flow Studio opens its own Chrome on the next free port instead of taking that one over", async () => {
    const script = "const m = await import('./dist/chrome.js'); await m.getBrowser(); console.log(await m.ownChrome()); process.exit(0);";
    const r = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, env: ENV });
    ours = Number(r.out.trim());
    if (r.code !== 0 || ours !== CDP + 1) return `got "${r.out.trim()}"`;
    const s = await status();
    if (!s.chrome.open || s.chrome.port !== ours) return JSON.stringify(s.chrome);
  });

  await check("stop closes Flow Studio's Chrome and leaves the other Chrome open", async () => {
    const r = await cli(["stop"]);
    if (r.code !== 0 || !r.out.includes("Chrome window closed")) return r.out;
    if (await cdpUp(ours)) return "Flow Studio's Chrome is still open";
    if (!(await cdpUp(CDP))) return "the other Chrome was closed";
    if ((await status()).chrome.open) return "status still says it is open";
  });
  foreign.kill();
  other.close();
  await until(async () => !(await health(PORT)), 5000);

  // The panel as an AI assistant starts it (the MCP server, talking over stdin/stdout).
  const assistant = spawn(process.execPath, [join(ROOT, "dist", "index.js")], { env: ENV, stdio: ["pipe", "ignore", "ignore"] });
  cleanup.push(() => assistant.kill());
  await until(async () => (await health(PORT))?.kind === "mcp");

  await check("stop refuses to end a Flow Studio that an AI assistant is running", async () => {
    const h = await health(PORT);
    if (h?.kind !== "mcp") return `the assistant's copy did not start: ${JSON.stringify(h)}`;
    const started = await cli(["start"]);
    if (started.code !== 0 || !started.out.includes("already running")) return `start: ${started.out}`;
    const r = await cli(["stop"]);
    if (r.code === 0) return `stop reported success: ${r.out}`;
    await sleep(1000);
    if (!alive(h.pid) || (await health(PORT))?.pid !== h.pid) return "the assistant's process was stopped";
  });
} catch (err) {
  failed++;
  console.log(`NOT OK - the run could not continue\n     ${err instanceof Error ? err.message : err}`);
} finally {
  for (const undo of cleanup.reverse()) {
    try {
      undo();
    } catch {
      // Already gone.
    }
  }
  await cli(["stop", "--force"]);
  await sleep(500);
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

console.log(`\n${passed} of ${passed + failed} checks passed.`);
process.exit(failed ? 1 : 0);

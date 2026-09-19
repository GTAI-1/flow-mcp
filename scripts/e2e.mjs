// Manual end-to-end check: node scripts/e2e.mjs <project> '<scenes json>'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [project, scenesJson] = process.argv.slice(2);
const client = new Client({ name: "e2e", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: process.env }));
const call = async (name, args = {}) =>
  JSON.parse((await client.callTool({ name, arguments: args }, undefined, { timeout: 960_000 })).content[0].text);

console.log("STATUS", JSON.stringify((await call("flow_status")).flow));
const gen = await call("flow_generate", { project, scenes: JSON.parse(scenesJson) });
console.log("QUEUED", gen.jobs.map((j) => j.id), gen.output_dir);
let done;
do {
  done = await call("flow_wait", { timeout_seconds: 60 });
  console.log(new Date().toISOString().slice(11, 19), done.pacing ?? "", done.jobs.map((j) => `${j.id}:${j.status}${j.progress ? ` ${j.progress}` : ""}`).join("  "));
} while (!done.finished);
console.log("RESULT", JSON.stringify(done.jobs, null, 1));
await client.close();
process.exit(0);

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "rerun", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: process.env }));
const call = async (n, a = {}) => JSON.parse((await c.callTool({ name: n, arguments: a }, undefined, { timeout: 2400000 })).content[0].text);
const log = (...m) => console.log(new Date().toLocaleTimeString("en-GB"), ...m);
const scenes = [
  "A weathered fishing boat moored at a stone harbour at sunrise",
  "Close-up of coiled rope on the boat's deck, salt crusted",
  "An old fisherman mending a net with quick practised hands",
  "Seagulls circling above a crate of silver fish",
  "The harbour market at dawn, crates and ice, cold blue light",
  "A cat sitting on a bollard watching the fish crates",
  "Wide shot of the breakwater with waves breaking over it",
  "A lighthouse at the end of the pier under heavy grey cloud",
  "Rain starting to fall on the harbour water, ring ripples",
  "The fisherman pulling on yellow oilskins in the rain",
  "The boat leaving the harbour mouth into choppy water",
  "View from the wheelhouse, rain streaked glass, grey horizon",
  "Nets going over the side into dark green water",
  "A storm petrel skimming the wave tops",
  "The sun breaking through cloud over the open sea",
  "The catch coming up, silver fish spilling onto the deck",
  "The fisherman's hands sorting the catch, scales and water",
  "The boat returning, harbour lights coming on at dusk",
  "Crates unloaded on the quay under a sodium lamp",
  "The empty harbour at night, the boat still, stars above",
];
const t0 = Date.now();
log("queueing", scenes.length, "scenes");
const a = await call("flow_agent_images", { project: "Harbour20", scenes, aspect_ratio: "16:9" });
let w; do { w = await call("flow_wait", { job_ids: [a.jobs[0].id], timeout_seconds: 60 }); const j = w.jobs[0]; log(j.status, "|", j.progress ?? "-", "|", j.files.length, "files"); } while (!w.finished);
const j = w.jobs[0];
log("RESULT:", j.status, "|", Math.round((Date.now() - t0) / 1000) + "s", "| note:", j.note ?? "-", "| error:", j.error ?? "-");
log("files:", JSON.stringify(j.files.map(f => f.split("/").pop())));
log("credits:", (await call("flow_status")).flow.credits_remaining);
await c.close(); process.exit(0);

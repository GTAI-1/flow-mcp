#!/usr/bin/env node
// Standalone Studio: runs the panel without Claude. If Claude's MCP process already serves it, just opens that.
// `flow-studio start` runs this same file in the background with --daemon: nothing is printed for a person to read
// and no browser is opened, because the command that started it does both.
import { LocalCore } from "./core.js";
import { PORT, startServer } from "./server.js";
import { openUrl } from "./platform.js";

const daemon = process.argv.includes("--daemon");
const wanted = PORT;
const role = await startServer(new LocalCore(), daemon ? "daemon" : "studio");
const url = `http://127.0.0.1:${PORT}`;
if (role === "none") {
  console.error(`Ports ${wanted} to ${wanted + 19} are all used by other programs. Set FLOW_MCP_PORT to a free port.`);
  process.exit(1);
}
if (daemon) {
  console.log(`${new Date().toISOString()} ${role === "owner" ? `Flow Studio running at ${url}` : `Flow Studio is already served at ${url}; nothing to start`}`);
  if (role === "client") process.exit(0);
} else {
  console.log(role === "owner" ? `Flow Studio running at ${url} (Ctrl+C to stop)` : `Flow Studio is already served by another flow-mcp at ${url}`);
  openUrl(url);
  if (role === "client") process.exit(0);
}

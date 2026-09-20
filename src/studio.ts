#!/usr/bin/env node
// Standalone Studio: runs the panel without Claude. If Claude's MCP process already serves it, just opens that.
import { spawn } from "node:child_process";
import { LocalCore } from "./core.js";
import { PORT, startServer } from "./server.js";

const role = await startServer(new LocalCore());
const url = `http://127.0.0.1:${PORT}`;
if (role === "none") {
  console.error(`Port ${PORT} is used by another program. Set FLOW_MCP_PORT to a free port.`);
  process.exit(1);
}
console.log(role === "owner" ? `Flow Studio running at ${url} (Ctrl+C to stop)` : `Flow Studio is already served by Claude's flow-mcp at ${url}`);
if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
if (role === "client") process.exit(0);

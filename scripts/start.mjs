// Plugin launcher: installs dependencies and builds on first start (dist/ is not in git), then runs the server.
// Everything it prints goes to stderr, because stdout belongs to the MCP protocol.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const step = (args) => {
  const r = spawnSync(npm, args, { cwd: root, stdio: ["ignore", process.stderr, process.stderr], shell: process.platform === "win32" });
  if (r.status !== 0) {
    console.error(`flow-mcp: "npm ${args.join(" ")}" failed`);
    process.exit(1);
  }
};

if (!existsSync(join(root, "node_modules"))) step(["install", "--no-audit", "--no-fund"]);
if (!existsSync(join(root, "dist", "index.js"))) step(["run", "build"]);

await import(join(root, "dist", "index.js").replace(/^/, process.platform === "win32" ? "file:///" : "file://"));

// Starts the web connector with the Mac and keeps it running (a per-user LaunchAgent).
// Usage: npm run web:service -- install | uninstall | restart
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("The service installer is for macOS. Elsewhere, run `npm run web`.");

const LABEL = "local.flow-mcp.web";
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const logDir = join(homedir(), ".flow-mcp", "web");
const domain = `gui/${process.getuid()}`;
const launchctl = (...args) => execFileSync("launchctl", args, { stdio: "pipe" });
const xml = (s) => s.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);

const stop = () => {
  try {
    launchctl("bootout", `${domain}/${LABEL}`);
  } catch {
    // not loaded
  }
};

const action = process.argv[2];
if (action === "install") {
  const entry = join(repo, "dist", "web.js");
  if (!existsSync(entry)) throw new Error("Run `npm run build` first.");
  // launchd starts with a bare PATH, so ffmpeg and node are named explicitly.
  const path = [...new Set([dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  mkdirSync(logDir, { recursive: true });
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(entry)}</string></array>
  <key>WorkingDirectory</key><string>${xml(repo)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(join(logDir, "web.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDir, "web.log"))}</string>
</dict></plist>
`,
  );
  stop();
  launchctl("bootstrap", domain, plist);
  console.log(`Installed. Log: ${join(logDir, "web.log")}`);
} else if (action === "uninstall") {
  stop();
  rmSync(plist, { force: true });
  console.log("Removed.");
} else if (action === "restart") {
  launchctl("kickstart", "-k", `${domain}/${LABEL}`);
  console.log("Restarted.");
} else {
  console.log("Usage: npm run web:service -- install | uninstall | restart");
  process.exit(1);
}

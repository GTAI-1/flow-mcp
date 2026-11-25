// A second flow-mcp with its own FLOW_MCP_HOME (the Aurora catalog watcher on port 8799) must still open the
// signed-in Chrome profile if it ever has to launch Chrome itself; FLOW_MCP_PROFILE names that profile. Without it the
// profile stays HOME/chrome-profile, as before.
//   npm run build && node scripts/check-profile.mjs
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const chrome = pathToFileURL(join(import.meta.dirname, "..", "dist", "chrome.js")).href;
const profileWith = (env) =>
  execFileSync(process.execPath, ["--input-type=module", "-e", `const c = await import(${JSON.stringify(chrome)}); console.log(c.PROFILE_DIR);`], {
    env: { ...process.env, FLOW_MCP_PROFILE: "", ...env },
    encoding: "utf8",
  }).trim();

let failed = 0;
function check(name, got, want) {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` - got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) failed++;
}

const home = join(import.meta.dirname, "watcher-home");
const signedIn = join(import.meta.dirname, "signed-in-profile");
check("FLOW_MCP_PROFILE names the profile", profileWith({ FLOW_MCP_HOME: home, FLOW_MCP_PROFILE: signedIn }), signedIn);
check("without it, the profile is HOME/chrome-profile", profileWith({ FLOW_MCP_HOME: home }), join(home, "chrome-profile"));

console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);

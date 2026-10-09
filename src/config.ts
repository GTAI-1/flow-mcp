import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Everything Flow Studio keeps on this computer lives in one folder: settings, the Chrome profile, logs, and the note
// saying which process is serving the panel right now.
export const HOME_DIR = process.env.FLOW_MCP_HOME ?? join(homedir(), ".flow-mcp");
export const CONFIG_FILE = join(HOME_DIR, "config.json");
export const STATE_FILE = join(HOME_DIR, "studio.json");
export const TOKEN_FILE = join(HOME_DIR, "token");
export const LOG_DIR = join(HOME_DIR, "logs");
export const LOG_FILE = join(LOG_DIR, "studio.log");

export interface Config {
  port: number;
  cdpPort: number;
  output: string;
  chrome?: string;
}

export const DEFAULTS: Config = { port: 8787, cdpPort: 9333, output: join(homedir(), "flow-mcp-out") };

const validPort = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1024 && (n as number) <= 65535;

// config.json holds the user's own choices. A bad file never stops the tools from starting: the broken setting falls
// back to its default and the problem is reported, so `flow-studio status` can show it.
export function readConfig(): { config: Config; problems: string[] } {
  const config = { ...DEFAULTS };
  const problems: string[] = [];
  if (!existsSync(CONFIG_FILE)) return { config, problems };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("it must be a JSON object");
  } catch (err) {
    return { config, problems: [`${CONFIG_FILE} could not be read (${err instanceof Error ? err.message : err}); using the defaults.`] };
  }
  for (const key of ["port", "cdpPort"] as const) {
    if (raw[key] === undefined) continue;
    if (validPort(raw[key])) config[key] = raw[key];
    else problems.push(`${CONFIG_FILE}: "${key}" must be a whole number from 1024 to 65535; using ${config[key]}.`);
  }
  for (const key of ["output", "chrome"] as const) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (typeof raw[key] === "string" && raw[key]) config[key] = raw[key];
    else problems.push(`${CONFIG_FILE}: "${key}" must be a folder or file path.`);
  }
  return { config, problems };
}

// Environment variables win over config.json, which wins over the defaults.
const read = readConfig();
for (const p of read.problems) console.error(`flow-mcp: ${p}`);
const envPort = (name: string) => (validPort(Number(process.env[name])) ? Number(process.env[name]) : undefined);
export const CONFIG: Config = {
  port: envPort("FLOW_MCP_PORT") ?? read.config.port,
  cdpPort: envPort("FLOW_MCP_CDP_PORT") ?? read.config.cdpPort,
  output: process.env.FLOW_MCP_OUTPUT ?? read.config.output,
  chrome: process.env.FLOW_MCP_CHROME ?? read.config.chrome,
};
export const OUTPUT_ROOT = CONFIG.output;

// Writes config.json with the defaults the first time, so there is a file to edit.
export function ensureConfig(): boolean {
  if (existsSync(CONFIG_FILE)) return false;
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({ port: DEFAULTS.port, cdpPort: DEFAULTS.cdpPort, output: DEFAULTS.output }, null, 2) + "\n");
  return true;
}

// "daemon" was started by `flow-studio start`, "studio" by `npm run studio` in a terminal, "mcp" by an AI assistant.
export type OwnerKind = "daemon" | "studio" | "mcp";
export interface OwnerState {
  pid: number;
  port: number;
  kind: OwnerKind;
  started: string;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// The process that says it is serving the panel, or null when there is no note or its process is gone.
export function readState(): OwnerState | null {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as OwnerState;
    return Number.isInteger(s.pid) && validPort(s.port) && pidAlive(s.pid) ? s : null;
  } catch {
    return null;
  }
}

// Claims the note for this process. Creating the file fails if another process got there first, so two that start
// together cannot both believe they are the owner. Returns the other live owner when there is one.
export function claimState(state: OwnerState): OwnerState | null {
  mkdirSync(HOME_DIR, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const other = readState();
    if (other && other.pid !== state.pid) return other;
    rmSync(STATE_FILE, { force: true });
    try {
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      return null;
    } catch {
      // Someone else wrote it between the check and the write; look again.
    }
  }
  return readState();
}

export function writeState(state: OwnerState): void {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

// Removes the note only if it still names the given process.
export function clearState(pid: number): void {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as OwnerState;
    if (s.pid === pid) rmSync(STATE_FILE, { force: true });
  } catch {
    // No note to remove.
  }
}

export interface Health {
  name?: string;
  pid?: number;
  kind?: OwnerKind;
  busy?: boolean;
}

export async function health(port: number, timeoutMs = 3000): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}

// One Flow window, sometimes several flow-mcp processes: Claude Desktop's own (port 8787) and a watcher's (8799, with
// its own HOME) both drive the Chrome on the same CDP port. Two of them typing into one tab at once mix up prompts,
// "before" snapshots and downloads (one job can take the other's picture). So whoever drives the page holds a lock file
// that every process finds at the same place; the others wait their turn, and generations keep their pause across
// processes too, since Flow's check for automated traffic sees the account, not the process.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Job } from "./queue.js";

const CDP_PORT = Number(process.env.FLOW_MCP_CDP_PORT ?? 9333);
const LOCK = process.env.FLOW_MCP_TAB_LOCK || join(homedir(), ".flow-mcp", `tab-${CDP_PORT}.lock`);
const LAST = `${LOCK}.last`;
const HEARTBEAT_MS = 20_000;
// No heartbeat for this long and the holder is gone (crashed, killed, or its pid now belongs to something else).
const STALE_MS = 2 * 60_000;

interface Holder {
  pid: number;
  at: number;
  what: string;
  port?: string;
}

const readHolder = (): Holder | null => {
  try {
    return JSON.parse(readFileSync(LOCK, "utf8")) as Holder;
  } catch {
    return null;
  }
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};
const age = (path: string): number => {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

function tryTake(what: string): boolean {
  mkdirSync(dirname(LOCK), { recursive: true });
  let fd: number;
  try {
    fd = openSync(LOCK, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), what, port: process.env.FLOW_MCP_PORT ?? "8787" }));
  } finally {
    closeSync(fd);
  }
  return true;
}

// Who holds the window now, or null when the lock was stale and has been cleared. A lock that cannot be read yet is
// being written by its new holder, unless it has been unreadable for a while.
function currentHolder(): Holder | null {
  const h = readHolder();
  const stale = h ? !alive(h.pid) || Date.now() - h.at > STALE_MS : age(LOCK) > 10_000;
  if (!stale) return h ?? { pid: 0, at: Date.now(), what: "starting" };
  try {
    unlinkSync(LOCK);
  } catch {
    // someone else cleared it first
  }
  return null;
}

/** Whether some flow-mcp process (this one included) is driving the Flow window right now. */
export function flowTabInUse(): boolean {
  return existsSync(LOCK) && currentHolder() !== null;
}

const who = (h: Holder) => `pid ${h.pid}${h.port ? `, port ${h.port}` : ""}${h.what ? `: ${h.what}` : ""}`;

export class FlowTabBusy extends Error {}

/**
 * Runs `fn` while holding the Flow window. Waits up to `waitMs` (default 30 min) for another process to let go; with
 * waitMs 0 it refuses at once, naming who has it. `gapMs` keeps at least that long between the end of the last
 * generation (in any process) and the start of this one.
 */
export async function withFlowTab<T>(
  what: string,
  fn: () => Promise<T>,
  { waitMs = 30 * 60_000, gapMs = 0, onWait }: { waitMs?: number; gapMs?: number; onWait?: (holder: string) => void } = {},
): Promise<T> {
  const started = Date.now();
  while (!tryTake(what)) {
    const h = currentHolder();
    if (!h) continue;
    if (Date.now() - started >= waitMs) {
      throw new FlowTabBusy(
        `Another flow-mcp process (${who(h)}) is using the Flow window${waitMs ? ` and has been for over ${Math.round(waitMs / 60_000)} min` : ""}. ` +
          `Two of them driving one Flow tab at once mix up prompts and downloads, so try again when it is done.`,
      );
    }
    onWait?.(who(h));
    await new Promise((r) => setTimeout(r, 1000));
  }
  const beat = setInterval(() => {
    const h = readHolder();
    if (h?.pid === process.pid) writeFileSync(LOCK, JSON.stringify({ ...h, at: Date.now() }));
  }, HEARTBEAT_MS);
  beat.unref();
  try {
    if (gapMs > 0) {
      const last = Number(readFileSafe(LAST)) || 0;
      const wait = last + gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    return await fn();
  } finally {
    clearInterval(beat);
    if (gapMs > 0) writeFileSync(LAST, String(Date.now()));
    if (readHolder()?.pid === process.pid) {
      try {
        unlinkSync(LOCK);
      } catch {
        // already gone
      }
    }
  }
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// The pause between two generations, in ANY flow-mcp process (Flow's check for automated traffic sees the account).
// 25-70 s was flagged on 2026-11-25 after a day of catalog runs, so the default is now 60-150 s, closer to a person
// looking at each result before asking for the next. FLOW_MCP_PAUSE_MIN_S / _MAX_S override it.
export const PAUSE_MIN_MS = Number(process.env.FLOW_MCP_PAUSE_MIN_S ?? 60) * 1000;
export const PAUSE_MAX_MS = Math.max(PAUSE_MIN_MS, Number(process.env.FLOW_MCP_PAUSE_MAX_S ?? 150) * 1000);
export const randomPause = (): number => PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS);

// After Flow says "unusual activity", the advice is to stop for a while. That used to be per process: another session
// kept sending into the same refusal an hour later. The time of the last refusal is now shared through a file next to
// the lock, and no process starts a generation until the cooldown (FLOW_MCP_FLAG_COOLDOWN_MIN, default 60) is over.
const FLAGGED_AT = `${LOCK}.flagged`;
const COOLDOWN_MS = Number(process.env.FLOW_MCP_FLAG_COOLDOWN_MIN ?? 60) * 60_000;
export class FlagCooldown extends Error {}
export function recordFlag(): void {
  mkdirSync(dirname(FLAGGED_AT), { recursive: true });
  writeFileSync(FLAGGED_AT, String(Date.now()));
}
/** Milliseconds left before generations may start again after Flow's refusal (0 when none is pending). */
export function flagCooldownLeft(): number {
  const at = Number(readFileSafe(FLAGGED_AT)) || 0;
  return Math.max(0, at + COOLDOWN_MS - Date.now());
}
function checkCooldown(): void {
  const left = flagCooldownLeft();
  if (!left) return;
  const until = new Date(Date.now() + left).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  throw new FlagCooldown(
    `Not started: Flow refused a generation as automated traffic ${Math.round((COOLDOWN_MS - left) / 60_000)} min ago, ` +
      `so no flow-mcp process sends anything before ${until} (${Math.ceil(left / 60_000)} min). Retry this job after that.`,
  );
}

// The gate every queued job goes through (LocalCore's queue): it waits its turn for the window, says so on the job
// while it waits, keeps the generation pause across processes, and holds off while a flag cooldown runs.
const WAITING = "waiting for another flow-mcp process";
export const flowTabGate = (job: Job, run: () => Promise<string[]>): Promise<string[]> => {
  checkCooldown();
  return withFlowTab(
    `job ${job.id} (${job.params.type})`,
    () => {
      if (job.progress?.startsWith(WAITING)) job.progress = undefined;
      // Checked again: a refusal may have landed in another process while this one waited for the window.
      checkCooldown();
      return run();
    },
    { gapMs: randomPause(), onWait: (holder) => (job.progress = `${WAITING} (${holder}) to finish with the Flow window`) },
  );
};

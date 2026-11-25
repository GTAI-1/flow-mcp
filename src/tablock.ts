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

// The gate every queued job goes through (LocalCore's queue): it waits its turn for the window, says so on the job
// while it waits, and keeps the generation pause across processes.
const PAUSE_MIN_MS = Number(process.env.FLOW_MCP_PAUSE_MIN_S ?? 25) * 1000;
const WAITING = "waiting for another flow-mcp process";
export const flowTabGate = (job: Job, run: () => Promise<string[]>): Promise<string[]> =>
  withFlowTab(
    `job ${job.id} (${job.params.type})`,
    () => {
      if (job.progress?.startsWith(WAITING)) job.progress = undefined;
      return run();
    },
    { gapMs: PAUSE_MIN_MS, onWait: (holder) => (job.progress = `${WAITING} (${holder}) to finish with the Flow window`) },
  );

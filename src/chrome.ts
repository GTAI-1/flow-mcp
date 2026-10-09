import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { CONFIG, HOME_DIR } from "./config.js";

export { HOME_DIR };
export const FLOW_URL = "https://flow.google.com/";
const FLOW_HOSTS = /^https:\/\/(flow\.google\.com|labs\.google\/fx)/;
export const PROFILE_DIR = join(HOME_DIR, "chrome-profile");
// The port asked for. The one actually in use can differ when that one was taken; ownChrome() returns the real one.
export const CDP_PORT = CONFIG.cdpPort;
const CHROME_FILE = join(HOME_DIR, "chrome.json");

const CHROME_PATHS = [
  CONFIG.chrome,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  // Windows also installs Chrome here: 32-bit builds, and per-user installs made without admin rights.
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
].filter((p): p is string => Boolean(p));

let browser: Browser | null = null;

// Which browser answers on a port, as the path of its remote-control address (it ends in an id that is new every
// time Chrome starts). Null when nothing answers.
async function browserIdAt(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl?: string };
    return webSocketDebuggerUrl ? new URL(webSocketDebuggerUrl).pathname : null;
  } catch {
    return null;
  }
}

// The remote-control port of Flow Studio's own Chrome, or null when it is not running. When Flow Studio starts Chrome
// it notes the port and that browser's id in its own folder, so a browser is ours only if the one answering on that
// port still carries the noted id. Any other Chrome - the user's everyday one started with remote debugging, or
// another tool's - fails that test and is never attached to, even if it sits on the port we would have used.
export async function ownChrome(): Promise<number | null> {
  let note: { port?: number; id?: string };
  try {
    note = JSON.parse(readFileSync(CHROME_FILE, "utf8"));
  } catch {
    return null;
  }
  if (!Number.isInteger(note.port) || !note.id) return null;
  return (await browserIdAt(note.port!)) === note.id ? note.port! : null;
}

const portFree = (port: number) =>
  new Promise<boolean>((ok) => {
    const probe = createServer();
    probe.once("error", () => ok(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => ok(true)));
  });

// The wanted port, or the next free one after it.
export async function freePort(wanted: number, tries = 20): Promise<number> {
  for (let port = wanted; port < wanted + tries && port <= 65535; port++) {
    if (await portFree(port)) return port;
  }
  throw new Error(`No free port from ${wanted} to ${wanted + tries - 1}.`);
}

// Real Chrome with a dedicated profile: Google sign-in works normally and the
// session persists, while the user's everyday profile is never touched.
async function launchChrome(): Promise<number> {
  const chromePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!chromePath) {
    throw new Error("Google Chrome not found. Set FLOW_MCP_CHROME to the Chrome executable path.");
  }
  mkdirSync(PROFILE_DIR, { recursive: true });
  const port = await freePort(CDP_PORT);
  const child = spawn(
    chromePath,
    [
      `--user-data-dir=${PROFILE_DIR}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      FLOW_URL,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  // The port was free a moment ago and this Chrome was told to use it, so the browser that appears there is ours.
  for (let i = 0; i < 40; i++) {
    const id = await browserIdAt(port);
    if (id) {
      writeFileSync(CHROME_FILE, JSON.stringify({ port, id, started: new Date().toISOString() }, null, 2) + "\n");
      return port;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Chrome started but could not be reached on port ${port}. If a Flow Studio Chrome window is already open, close it and try again.`,
  );
}

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  const port = (await ownChrome()) ?? (await launchChrome());
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return browser;
}

// Closes Flow Studio's own Chrome window, and only that one. Returns false when it was not running.
export async function closeChrome(): Promise<boolean> {
  const port = await ownChrome();
  if (!port) return false;
  const b = browser?.isConnected() ? browser : await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  browser = null;
  try {
    const session = await b.newBrowserCDPSession();
    await session.send("Browser.close");
  } catch {
    // Chrome drops the connection as it closes, which is the result we want.
  }
  for (let i = 0; i < 40; i++) {
    if (!(await browserIdAt(port))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Flow Studio's Chrome window did not close.");
}

export async function getFlowPage(): Promise<Page> {
  const b = await getBrowser();
  const context = b.contexts()[0];
  if (!context) throw new Error("Chrome has no browser context; restart the Flow Chrome window.");
  const existing = context.pages().find((p) => FLOW_HOSTS.test(p.url()));
  if (existing) return existing;
  const page = await context.newPage();
  await page.goto(FLOW_URL, { waitUntil: "domcontentloaded" });
  return page;
}

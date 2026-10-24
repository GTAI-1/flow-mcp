import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { currentAccount, downloadDir, HOME_DIR, MAIN, profileDir, type Account } from "./accounts.js";

export { HOME_DIR };

export const FLOW_URL = "https://flow.google.com/";
// Flow's buttons are found by their English names ("Start generation", "Download"...), so Flow has to show in English
// whatever language the Google account uses. `hl=en` on the address does that: `hl=es` turned every label Spanish on
// an English account (2026-10-13), the choice holds through Flow's in-app navigation, and the browser's own language
// changes nothing. It only lasts until the next full page load, so every load adds it and ensureEnglish re-checks.
export const inEnglish = (url: string): string => {
  const u = new URL(url);
  u.searchParams.set("hl", "en");
  return u.toString();
};
const FLOW_HOSTS = /^https:\/\/(flow\.google\.com|labs\.google\/fx)/;
const cdpUrl = (a: Account) => `http://127.0.0.1:${a.port}`;

const CHROME_PATHS = [
  process.env.FLOW_MCP_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  // Windows also installs Chrome here: 32-bit builds, and per-user installs made without admin rights.
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
].filter((p): p is string => Boolean(p));

// One connection per account: each account is its own Chrome, reached on its own debugging port.
const browsers = new Map<string, Browser>();

async function cdpUp(a: Account): Promise<boolean> {
  try {
    const res = await fetch(`${cdpUrl(a)}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Real Chrome with a dedicated profile: Google sign-in works normally and the
// session persists, while the user's everyday profile is never touched.
export function chromeExecutable(): string {
  const chromePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!chromePath) throw new Error("Google Chrome not found. Set FLOW_MCP_CHROME to the Chrome executable path.");
  return chromePath;
}

async function launchChrome(a: Account): Promise<void> {
  const chromePath = chromeExecutable();
  const profile = profileDir(a);
  if (a.name !== MAIN && !existsSync(profile)) {
    // A new account's Chrome saves to its own folder, not ~/Downloads: that folder is the fallback every account's
    // download watcher reads, so two accounts writing there at once could pick up each other's files.
    mkdirSync(join(profile, "Default"), { recursive: true });
    mkdirSync(downloadDir(a), { recursive: true });
    writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: downloadDir(a), prompt_for_download: false } }));
  }
  mkdirSync(profile, { recursive: true });
  const child = spawn(
    chromePath,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${a.port}`,
      "--no-first-run",
      "--no-default-browser-check",
      inEnglish(FLOW_URL),
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await cdpUp(a)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome for account "${a.name}" started but CDP port ${a.port} never came up.`);
}

// Connecting is shared per account, so two calls arriving together never launch the same Chrome twice.
const connecting = new Map<string, Promise<Browser>>();

export async function getBrowser(account: Account = currentAccount()): Promise<Browser> {
  const open = browsers.get(account.name);
  if (open?.isConnected()) return open;
  let pending = connecting.get(account.name);
  if (!pending) {
    pending = (async () => {
      if (!(await cdpUp(account))) await launchChrome(account);
      const b = await chromium.connectOverCDP(cdpUrl(account));
      browsers.set(account.name, b);
      return b;
    })().finally(() => connecting.delete(account.name));
    connecting.set(account.name, pending);
  }
  return pending;
}

export async function getFlowPage(account: Account = currentAccount()): Promise<Page> {
  const b = await getBrowser(account);
  const context = b.contexts()[0];
  if (!context) throw new Error(`Chrome for account "${account.name}" has no browser context; restart that Flow Chrome window.`);
  const existing = context.pages().find((p) => FLOW_HOSTS.test(p.url()));
  if (existing) {
    await ensureEnglish(existing);
    return existing;
  }
  const page = await context.newPage();
  await page.goto(inEnglish(FLOW_URL), { waitUntil: "domcontentloaded" });
  await ensureEnglish(page);
  return page;
}

// Reloads Flow in English when it is showing in another language (a page the user opened by hand, or Flow redirecting
// to an address without hl). Sign-in pages are left alone.
export async function ensureEnglish(page: Page): Promise<void> {
  if (!/^https:\/\/flow\.google\.com\//.test(page.url())) return;
  const lang = () => page.evaluate(() => document.documentElement.lang).catch(() => "");
  const now = await lang();
  if (!now || /^en\b/i.test(now)) return;
  await page.goto(inEnglish(page.url()), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.lang, null, { timeout: 15_000 }).catch(() => {});
  const after = await lang();
  if (after && !/^en\b/i.test(after)) {
    throw new Error(
      `Flow is showing in "${after}" and would not switch to English. flow-mcp finds Flow's buttons by their English names. ` +
        `Add ?hl=en to the end of Flow's address in the Flow Chrome window, or set your Google account's language to English (myaccount.google.com/language).`,
    );
  }
}

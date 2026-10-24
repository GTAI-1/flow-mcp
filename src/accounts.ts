import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME_DIR = process.env.FLOW_MCP_HOME ?? join(homedir(), ".flow-mcp");
const ACCOUNTS_FILE = join(HOME_DIR, "accounts.json");
const SETTINGS_FILE = join(HOME_DIR, "settings.json");

// Every Google account is its own Chrome profile with its own debugging port, Flow project, download folder and queue
// worker, so several accounts generate at the same time. "main" is the profile flow-mcp always had (same folder, same
// port), so a single-account setup is unchanged. The user signs each one in by hand; nothing here touches passwords.
export const MAIN = "main";
const MAIN_PORT = Number(process.env.FLOW_MCP_CDP_PORT ?? 9333);

export interface Account {
  name: string;
  port: number;
  enabled: boolean;
}

type Stored = { accounts?: Account[] };

const read = <T>(file: string, fallback: T): T => {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
};

const write = (file: string, data: unknown) => {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
};

export function listAccounts(): Account[] {
  const stored = read<Stored>(ACCOUNTS_FILE, {}).accounts ?? [];
  const main = stored.find((a) => a.name === MAIN);
  return [{ name: MAIN, port: MAIN_PORT, enabled: main?.enabled ?? true }, ...stored.filter((a) => a.name !== MAIN)];
}

export const enabledAccounts = (): Account[] => listAccounts().filter((a) => a.enabled);

export function accountByName(name: string): Account {
  const found = listAccounts().find((a) => a.name.toLowerCase() === name.trim().toLowerCase());
  if (!found) throw new Error(`No Flow account called "${name}". Known: ${listAccounts().map((a) => a.name).join(", ")}. Add one with flow_accounts.`);
  return found;
}

// Where account-bound work goes when the caller names no account: the first enabled one.
export const defaultAccount = (): Account => enabledAccounts()[0] ?? listAccounts()[0];

export const profileDir = (a: Account) => (a.name === MAIN ? join(HOME_DIR, "chrome-profile") : join(HOME_DIR, "accounts", a.name, "chrome-profile"));
export const downloadDir = (a: Account) => (a.name === MAIN ? join(HOME_DIR, "downloads") : join(HOME_DIR, "accounts", a.name, "downloads"));

export function addAccount(name: string): Account {
  const clean = name.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,30}$/i.test(clean)) throw new Error("Account names are 1-31 letters, digits, - or _ (e.g. 'work', 'acc2').");
  const all = listAccounts();
  if (all.some((a) => a.name.toLowerCase() === clean.toLowerCase())) throw new Error(`There is already an account called "${clean}".`);
  const account = { name: clean, port: Math.max(...all.map((a) => a.port)) + 1, enabled: true };
  write(ACCOUNTS_FILE, { accounts: [...all, account] });
  return account;
}

export function setAccountEnabled(name: string, enabled: boolean): Account {
  const all = listAccounts();
  const target = accountByName(name);
  if (!enabled && all.filter((a) => a.enabled && a.name !== target.name).length === 0) throw new Error("At least one account has to stay enabled.");
  const next = all.map((a) => (a.name === target.name ? { ...a, enabled } : a));
  write(ACCOUNTS_FILE, { accounts: next });
  return { ...target, enabled };
}

// The account the current piece of work belongs to. Each queue worker and each direct call runs inside onAccount, so
// getFlowPage() and the download folder follow it without every driver function taking an account argument.
const current = new AsyncLocalStorage<Account>();
export const currentAccount = (): Account => current.getStore() ?? defaultAccount();
export const onAccount = <T>(account: Account | string, work: () => Promise<T>): Promise<T> =>
  current.run(typeof account === "string" ? accountByName(account) : account, work);

// Settings the user chooses once and keeps: for now the image model used whenever a job names none.
interface Settings {
  default_image_model?: string;
}
export const loadSettings = (): Settings => read<Settings>(SETTINGS_FILE, {});
export const saveSettings = (s: Settings) => write(SETTINGS_FILE, s);
export const defaultImageModel = (): string | undefined => loadSettings().default_image_model;

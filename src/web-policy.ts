import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { IS_MAC } from "./platform.js";
import { readJson, WEB_DIR, writeJson } from "./web-auth.js";

// What the web connector may do. These limits live here, on this computer: nothing sent from Claude can change them.

const run = promisify(execFile);
const CONFIG_FILE = join(WEB_DIR, "config.json");
const LEDGER_FILE = join(WEB_DIR, "ledger.json");
const RESULTS_FILE = join(WEB_DIR, "results.json");
const PREP_DIR = join(WEB_DIR, "prepared");

export const GREEN = "#00B140";

export interface WebConfig {
  public_url?: string;
  // The only folders whose images the connector can see.
  folders: string[];
  max_per_clip: number;
  max_per_day: number;
}
export const config = (): WebConfig => ({ folders: [], max_per_clip: 25, max_per_day: 100, ...readJson<Partial<WebConfig>>(CONFIG_FILE, {}) });
export const saveConfig = (c: WebConfig) => writeJson(CONFIG_FILE, c);

// Omni 1.2 Flash's price, as measured on 2026-11-21. It is used as the scene's max_credits, so if Flow ever quotes more,
// nothing is generated.
export function videoCost(seconds: number, resolution: "360p" | "720p"): number {
  const at360 = Math.min(seconds, 10) + Math.max(0, seconds - 10) * 2;
  return resolution === "720p" ? at360 * 3 : at360;
}

type Spend = { day: string; job_id: string; credits: number };
const today = () => new Date().toLocaleDateString("en-CA");
const ledger = () => readJson<Spend[]>(LEDGER_FILE, []);
export const spentToday = () => ledger().reduce((n, s) => n + (s.day === today() ? s.credits : 0), 0);
export const record = (job_id: string, credits: number) => writeJson(LEDGER_FILE, [...ledger(), { day: today(), job_id, credits }].slice(-1000));
// A finished job reports what it really cost; one stopped before generating cost nothing.
export function settle(job_id: string, credits: number): void {
  const all = ledger();
  const entry = all.find((s) => s.job_id === job_id);
  if (!entry || entry.credits === credits) return;
  entry.credits = credits;
  writeJson(LEDGER_FILE, all);
}

// Going over a limit takes a click on this computer. A "yes" typed in the chat is not enough: the model passes that on,
// so it could not be told apart from the model deciding for itself.
export async function confirmOnComputer(message: string): Promise<boolean> {
  if (!IS_MAC) return false;
  const script = `on run argv
  set r to display dialog (item 1 of argv) with title "flow-mcp" buttons {"Deny", "Allow"} default button "Deny" cancel button "Deny" with icon caution giving up after 90
  if gave up of r then return "no"
  return button returned of r
end run`;
  try {
    const { stdout } = await run("osascript", ["-e", script, message], { timeout: 100_000 });
    return stdout.trim() === "Allow";
  } catch {
    return false;
  }
}

const IMAGE = /\.(png|jpe?g|webp)$/i;
const rootName = (dir: string, all: string[]) => {
  const name = basename(dir);
  const twins = all.filter((d) => basename(d) === name);
  return twins.length > 1 ? `${name}-${twins.indexOf(dir) + 1}` : name;
};

export function listReferences(): string[] {
  const { folders } = config();
  const out: string[] = [];
  for (const folder of folders.filter(existsSync)) {
    const walk = (dir: string, depth: number) => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.name.startsWith(".")) continue;
        if (f.isDirectory() && depth < 6) walk(join(dir, f.name), depth + 1);
        else if (f.isFile() && IMAGE.test(f.name)) out.push(`ref:${rootName(folder, folders)}/${relative(folder, join(dir, f.name)).split(sep).join("/")}`);
      }
    };
    walk(folder, 0);
  }
  return out.sort();
}

// Files the connector produced, by id, so Claude never names a path on this computer.
type Results = Record<string, string>;
export function rememberResults(job_id: string, files: string[]): string[] {
  const all = readJson<Results>(RESULTS_FILE, {});
  const ids = files.map((file, i) => {
    const id = `result:${job_id}/${i + 1}`;
    all[id] = file;
    return id;
  });
  if (ids.length) writeJson(RESULTS_FILE, all);
  return ids;
}
export const recentResults = (n = 30) => Object.keys(readJson<Results>(RESULTS_FILE, {})).slice(-n).reverse();

// Turns an id the connector handed out into a file, and nothing else: no paths, no climbing out of an allowed folder,
// not even through a symlink.
export function resolveId(id: string): string {
  if (id.startsWith("result:")) {
    const file = readJson<Results>(RESULTS_FILE, {})[id];
    if (file && existsSync(file)) return file;
  } else if (id.startsWith("ref:") && listReferences().includes(id)) {
    const { folders } = config();
    const [name, ...rest] = id.slice(4).split("/");
    const folder = folders.find((d) => rootName(d, folders) === name)!;
    const file = realpathSync(join(folder, ...rest));
    if (file.startsWith(realpathSync(folder) + sep) && statSync(file).isFile()) return file;
  }
  throw new Error(`Unknown file "${id}". Use an id from flow_library or from a finished job.`);
}

const SIZES = { "9:16": [1080, 1920], "16:9": [1920, 1080], "1:1": [1440, 1440], "4:3": [1600, 1200], "3:4": [1200, 1600] } as const;

// Lays a still with transparency onto flat green, centred, without redrawing anything. On 9:16 the character takes 80%
// of the width, a framing that keeps room for the animation's movement.
export async function onGreen(still: string, aspect: keyof typeof SIZES): Promise<string> {
  const [w, h] = SIZES[aspect];
  mkdirSync(PREP_DIR, { recursive: true });
  const key = createHash("sha256").update(`${still}:${statSync(still).mtimeMs}:${aspect}`).digest("hex").slice(0, 16);
  const out = join(PREP_DIR, `green-${key}.png`);
  const fit = aspect === "9:16" ? `${Math.round(w * 0.8)}:${Math.round(h * 0.9)}` : `${Math.round(w * 0.8)}:${Math.round(h * 0.85)}`;
  await run("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", `color=c=0x${GREEN.slice(1)}:s=${w}x${h}`, "-i", still,
    "-filter_complex", `[1:v]scale=${fit}:force_original_aspect_ratio=decrease:flags=lanczos[r];[0:v][r]overlay=(W-w)/2:(H-h)/2:format=auto`,
    "-frames:v", "1", "-y", out,
  ]);
  return out;
}

// A smaller JPEG of an image, or a sheet of nine frames from a video, so Claude can look at a result cheaply.
export async function preview(file: string): Promise<Buffer> {
  const video = /\.(mp4|mov|webm)$/i.test(extname(file));
  let filter = "scale='min(640,iw)':-2";
  if (video) {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    filter = `fps=${(9 / Math.max(0.5, Number(stdout.trim()))).toFixed(4)},scale=240:-2,tile=3x3`;
  }
  const { stdout } = await run("ffmpeg", ["-v", "error", "-i", file, "-vf", filter, "-frames:v", "1", "-q:v", "6", "-f", "image2pipe", "-vcodec", "mjpeg", "-"], {
    encoding: "buffer",
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

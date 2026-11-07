// Kokoro: a free voice that runs on this computer (Kokoro-82M, Apache 2.0, through kokoro-js). No key, no quota, no
// length limit, same on a Mac and a PC. The model (326 MB) downloads itself into ~/.flow-mcp/models/kokoro the first
// time a line is spoken; every take after that starts in well under a second.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HOME_DIR } from "./chrome.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLOW_MCP_FFPROBE ?? "ffprobe";
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const CACHE = join(HOME_DIR, "models", "kokoro");
const WORKER = join(dirname(fileURLToPath(import.meta.url)), "kokoro-worker.js");

export const KOKORO_MB = 326;
export const KOKORO_DEFAULT_VOICE = "am_michael";

// Kokoro's English voices, best first by the model card's own grades. The letter in the id is the accent
// (a American, b British) and the second the speaker (f female, m male).
const GRADED: [string, string, string][] = [
  ["af_heart", "Heart", "A"], ["af_bella", "Bella", "A-"], ["af_nicole", "Nicole", "B-"], ["bf_emma", "Emma", "B-"],
  ["am_michael", "Michael", "C+"], ["am_fenrir", "Fenrir", "C+"], ["am_puck", "Puck", "C+"], ["af_aoede", "Aoede", "C+"],
  ["af_kore", "Kore", "C+"], ["af_sarah", "Sarah", "C+"], ["bm_george", "George", "C"], ["bm_fable", "Fable", "C"],
  ["bf_isabella", "Isabella", "C"], ["af_alloy", "Alloy", "C"], ["af_nova", "Nova", "C"], ["af_sky", "Sky", "C-"],
  ["bm_lewis", "Lewis", "D+"], ["am_echo", "Echo", "D"], ["am_eric", "Eric", "D"], ["am_liam", "Liam", "D"],
  ["am_onyx", "Onyx", "D"], ["bm_daniel", "Daniel", "D"], ["bf_alice", "Alice", "D"], ["bf_lily", "Lily", "D"],
  ["af_jessica", "Jessica", "D"], ["af_river", "River", "D"], ["am_santa", "Santa", "D-"], ["am_adam", "Adam", "F+"],
];
export const KOKORO_VOICES = GRADED.map(([name, label, grade]) => ({
  name,
  label,
  description: `${name[0] === "b" ? "British" : "American"}, ${name[1] === "m" ? "male" : "female"} · grade ${grade}`,
}));

export const kokoroReady = () => existsSync(join(CACHE, MODEL, "onnx", "model.onnx"));

// One take at a time: two first-time takes at once would download the model twice into the same folder.
let queue: Promise<unknown> = Promise.resolve();

export function speakWithKokoro(text: string, voice: string, target: string, speed = 1): Promise<{ output: string; duration: number }> {
  if (!KOKORO_VOICES.some((v) => v.name === voice))
    throw new Error(`Kokoro has no voice "${voice}". Pick one of: ${KOKORO_VOICES.map((v) => v.name).join(", ")}.`);
  const take = queue.then(async () => {
    const stem = target.replace(/\.\w+$/, "");
    const jobFile = stem + ".kokoro.json";
    const raw = stem + ".kokoro.wav";
    const firstTime = !kokoroReady();
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(jobFile, JSON.stringify({ text, voice, speed, out: raw, cache: CACHE, model: MODEL }), "utf8");
    try {
      await run(process.execPath, [WORKER, jobFile], { timeout: firstTime ? 20 * 60_000 : 5 * 60_000, maxBuffer: 16 * 1024 * 1024 }).catch(
        (err: Error & { stderr?: string }) => {
          const detail = String(err.stderr || err.message).trim().split("\n").filter(Boolean).at(-1) ?? "no detail";
          throw new Error(
            firstTime
              ? `Kokoro needs its voice model the first time (${KOKORO_MB} MB, downloaded once) and that failed: ${detail}. Check the internet connection and try again.`
              : `Kokoro could not record this line: ${detail}`,
          );
        },
      );
      await run(FFMPEG, ["-y", "-i", raw, "-af", "highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-ac", "2", target]);
    } finally {
      rmSync(jobFile, { force: true });
      rmSync(raw, { force: true });
    }
    const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", target]);
    return { output: target, duration: Number(stdout.trim()) };
  });
  queue = take.catch(() => undefined);
  return take;
}

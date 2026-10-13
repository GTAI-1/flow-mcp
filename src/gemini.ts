import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { HOME_DIR } from "./chrome.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLOW_MCP_FFPROBE ?? "ffprobe";
const KEY_FILE = join(HOME_DIR, "gemini-key");
const MODEL = process.env.FLOW_MCP_GEMINI_TTS ?? "gemini-2.5-flash-preview-tts";

// Gemini's prebuilt voices. Flow draws on the same set, so a narration made here matches one made in Flow.
export const GEMINI_VOICES = [
  { name: "Zephyr", description: "bright" }, { name: "Puck", description: "upbeat" },
  { name: "Charon", description: "informative" }, { name: "Kore", description: "firm" },
  { name: "Fenrir", description: "excitable" }, { name: "Leda", description: "youthful" },
  { name: "Orus", description: "firm" }, { name: "Aoede", description: "breezy" },
  { name: "Callirrhoe", description: "easy-going" }, { name: "Autonoe", description: "bright" },
  { name: "Enceladus", description: "breathy" }, { name: "Iapetus", description: "clear" },
  { name: "Umbriel", description: "easy-going" }, { name: "Algieba", description: "smooth" },
  { name: "Despina", description: "smooth" }, { name: "Erinome", description: "clear" },
  { name: "Algenib", description: "gravelly" }, { name: "Rasalgethi", description: "informative" },
  { name: "Laomedeia", description: "upbeat" }, { name: "Achernar", description: "soft" },
  { name: "Alnilam", description: "firm" }, { name: "Schedar", description: "even" },
  { name: "Gacrux", description: "mature" }, { name: "Pulcherrima", description: "forward" },
  { name: "Achird", description: "friendly" }, { name: "Zubenelgenubi", description: "casual" },
  { name: "Vindemiatrix", description: "gentle" }, { name: "Sadachbia", description: "lively" },
  { name: "Sadaltager", description: "knowledgeable" }, { name: "Sulafat", description: "warm" },
];

// AI Studio hands out two shapes of key: the classic "AIza" + 35 characters, and since 2026 "AQ." + about 50 characters
// (dots, dashes, underscores). Both work on the Gemini API; refusing the newer one locked users out (2026-10-13).
const KEY_SHAPE = /^(AIza[0-9A-Za-z_-]{30,}|AQ\.[0-9A-Za-z._-]{30,})$/;

// Anything shorter or still holding template text is not a key.
export const geminiKey = (): string | undefined => {
  const key = (process.env.GEMINI_API_KEY ?? (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8") : "")).trim();
  if (!key || key.length < 20 || /^(YOUR|PASTE|<|\$)/i.test(key) || /_KEY|KEY_HERE|EXAMPLE/i.test(key)) return undefined;
  return key;
};

// Saves the user's key from the panel straight to a file only they can read. It never passes through Claude - that is
// why there is no MCP tool for it. The key is checked with Google BEFORE anything is written, so a mistyped or
// placeholder key can never replace one that works. The check lists models with the key in a header (never in the URL)
// and spends no text-to-speech quota.
export async function saveGeminiKey(raw: string): Promise<{ saved: true; ending: string }> {
  const key = raw.trim();
  if (!KEY_SHAPE.test(key)) {
    throw new Error("That doesn't look like a Google AI Studio key. Keys start with AIza (about 39 characters) or AQ. (about 53 characters), with no spaces.");
  }
  const res = await askGoogle(key);
  if (!res) throw new Error("Couldn't reach Google to check the key. Check your internet connection and try again.");
  if (!res.ok) throw new Error("Google didn't accept that key. Copy it again from aistudio.google.com/apikey. Your previous key, if any, is unchanged.");
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  writeFileSync(KEY_FILE, key, { mode: 0o600 });
  chmodSync(KEY_FILE, 0o600);
  return { saved: true, ending: key.slice(-4) };
}

// Lists one model with the key in a header (never in the URL): proves the key works and spends no speech quota.
const askGoogle = (key: string) =>
  fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(15_000) }).catch(
    () => null,
  );

// The panel used to say "a key is saved" whenever the file existed, so a deleted or restricted key only showed up as
// a failed narration. This asks Google about the saved key; like saving, it is panel-only and returns just the ending.
export async function checkGeminiKey(): Promise<{ ok: boolean; ending?: string; error?: string }> {
  const key = geminiKey();
  if (!key) return { ok: false, error: "No key is saved yet." };
  const ending = key.slice(-4);
  const res = await askGoogle(key);
  if (!res) return { ok: false, ending, error: "Couldn't reach Google to check the key. Check your internet connection and try again." };
  if (!res.ok) {
    return { ok: false, ending, error: `Google refused the saved key (HTTP ${res.status}). It may have been deleted or restricted: paste a new one from aistudio.google.com/apikey.` };
  }
  return { ok: true, ending };
}

interface TtsPart {
  inlineData?: { mimeType?: string; data?: string };
}

// Speaks a line with Gemini's TTS. Free tier, no Flow credits, no length cap, and the same voices Flow uses.
export async function speakWithGemini(text: string, voice: string, target: string, style?: string): Promise<{ output: string; duration: number }> {
  const key = geminiKey();
  if (!key) {
    const placeholder = existsSync(KEY_FILE) && readFileSync(KEY_FILE, "utf8").trim().length > 0;
    throw new Error(
      (placeholder
        ? `The key file still holds placeholder text, not a key.\n\n`
        : `No Gemini key yet.\n\n`) +
        `1. Open aistudio.google.com/apikey and click "Create API key".\n` +
        `2. Copy it — it starts with AIza or AQ.\n` +
        `3. Paste it into Flow Studio: Voice tab -> Google AI Studio key -> Save key. It is checked with Google and saved\n` +
        `   only on this computer - never paste it into a chat.`,
    );
  }
  const prompt = style ? `Say ${style}: ${text}` : text;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    }),
  });
  const body = (await res.json()) as { error?: { message?: string }; candidates?: { content?: { parts?: TtsPart[] } }[] };
  if (!res.ok) throw new Error(`Gemini TTS refused this take (${res.status}): ${body.error?.message ?? "no detail"}`);
  const part = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) throw new Error("Gemini returned no audio for this line.");

  // The audio comes back as raw signed 16-bit PCM, so the sample rate has to come from the mime type.
  const rate = Number(part.inlineData.mimeType?.match(/rate=(\d+)/)?.[1] ?? 24000);
  const raw = target.replace(/\.\w+$/, "") + ".pcm";
  writeFileSync(raw, Buffer.from(part.inlineData.data, "base64"));
  await run(FFMPEG, [
    "-y", "-f", "s16le", "-ar", String(rate), "-ac", "1", "-i", raw,
    "-af", "highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-ac", "2", target,
  ]);
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", target]);
  const duration = Number(stdout.trim());
  // There is no `rm` on Windows; that left an empty .pcm beside every narration.
  rmSync(raw, { force: true });
  return { output: target, duration };
}

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { HOME_DIR } from "./chrome.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";
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

// Real keys look like "AIza..." and are ~39 chars; anything shorter or still holding template text is not a key.
export const geminiKey = (): string | undefined => {
  const key = (process.env.GEMINI_API_KEY ?? (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8") : "")).trim();
  if (!key || key.length < 20 || /^(YOUR|PASTE|<|\$)/i.test(key) || /_KEY|KEY_HERE|EXAMPLE/i.test(key)) return undefined;
  return key;
};

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
        `1. Open aistudio.google.com and click "Get API key", then "Create API key".\n` +
        `2. Copy it — it starts with AIza and is about 39 characters.\n` +
        `3. In your terminal, with your own key in place of the quoted text:\n` +
        `   printf '%s' 'AIza…your real key…' > ${KEY_FILE} && chmod 600 ${KEY_FILE}`,
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
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", target]);
  const duration = Number(stdout.trim());
  writeFileSync(raw, "");
  await run("rm", ["-f", raw]).catch(() => {});
  return { output: target, duration };
}

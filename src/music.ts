import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { geminiKey } from "./gemini.js";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

type MusicModel = "lyria-3.5" | "lyria-3-clip-preview";
type AudioFormat = "mp3" | "wav";

type InlineData = { mimeType?: string; mime_type?: string; data?: string };
type MusicPart = { text?: string; inlineData?: InlineData; inline_data?: InlineData };
type MusicResponse = {
  error?: { message?: string };
  candidates?: { content?: { parts?: MusicPart[] } }[];
};

const imageMime = (file: string): string => {
  switch (extname(file).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      throw new Error(`Unsupported music reference image: ${file}. Use JPEG, PNG or WebP.`);
  }
};

const safeName = (name: string): string => {
  const cleaned = name.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error("output_name must contain at least one safe filename character.");
  return cleaned;
};

const nextMusicName = (dir: string): string => {
  const used = readdirSync(dir)
    .map((file) => Number(file.match(/^music-(\d+)/)?.[1] ?? 0))
    .filter(Number.isFinite);
  return `music-${String(Math.max(0, ...used) + 1).padStart(2, "0")}`;
};

/** Generate music with Google's official Lyria Gemini API, never with Flow credits. */
export async function generateMusic(options: {
  project: string;
  prompt: string;
  model?: MusicModel;
  output_format?: AudioFormat;
  output_name?: string;
  duration_seconds?: number;
  instrumental?: boolean;
  image_paths?: string[];
}): Promise<{
  output: string;
  metadata: string;
  provider: string;
  model: MusicModel;
  mime_type: string;
  bytes: number;
  lyrics?: string;
  billing: string;
}> {
  const key = geminiKey();
  if (!key) {
    throw new Error(
      "Music generation needs a Google AI Studio API key. Set GEMINI_API_KEY or save a verified key as the flow-mcp Gemini key; this is separate from Google Flow credits and is billed by the Gemini API.",
    );
  }

  const model = options.model ?? "lyria-3.5";
  const format = options.output_format ?? "mp3";
  if (format === "wav" && model !== "lyria-3.5") {
    throw new Error("WAV output is supported for lyria-3.5; use MP3 for the 30-second clip model.");
  }
  const images = options.image_paths ?? [];
  if (images.length > 10) throw new Error("Lyria accepts at most 10 reference images.");
  const parts: MusicPart[] = [{ text: options.prompt.trim() }];
  if (options.duration_seconds !== undefined) {
    parts[0].text += `\nTarget duration: approximately ${options.duration_seconds} seconds (the model may vary the exact length).`;
  }
  if (options.instrumental) parts[0].text += "\nInstrumental only; no vocals.";
  for (const image of images) {
    if (!existsSync(image)) throw new Error(`Music reference image not found: ${image}`);
    if (statSync(image).size > MAX_IMAGE_BYTES) throw new Error(`Music reference image is larger than 20 MB: ${image}`);
    parts.push({ inlineData: { mimeType: imageMime(image), data: readFileSync(image).toString("base64") } });
  }

  const generationConfig: Record<string, unknown> = { responseModalities: ["AUDIO", "TEXT"] };
  if (format === "wav") generationConfig.responseFormat = { audio: { mimeType: "AUDIO_WAV" } };
  const response = await fetch(`${API_ROOT}/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ parts }], generationConfig }),
  });
  const body = (await response.json()) as MusicResponse;
  if (!response.ok) throw new Error(`Lyria refused music generation (${response.status}): ${body.error?.message ?? "no detail"}`);

  const text: string[] = [];
  let audio: { mimeType?: string; data?: string } | undefined;
  for (const part of body.candidates?.flatMap((candidate) => candidate.content?.parts ?? []) ?? []) {
    if (part.text) text.push(part.text);
    const inline = part.inlineData ?? part.inline_data;
    if (inline?.data && !audio) audio = inline;
  }
  if (!audio?.data) throw new Error("Lyria returned no audio data.");

  const outputDir = join(process.env.FLOW_MCP_OUTPUT ?? join(process.env.HOME ?? ".", "flow-mcp-out"), safeName(options.project));
  mkdirSync(outputDir, { recursive: true });
  const base = safeName(options.output_name ?? nextMusicName(outputDir));
  const mime = audio.mimeType ?? (format === "wav" ? "audio/wav" : "audio/mpeg");
  const extension = /wav/i.test(mime) ? "wav" : "mp3";
  const output = join(outputDir, `${base}.${extension}`);
  const metadata = output.replace(/\.[^.]+$/, ".json");
  const bytes = Buffer.from(audio.data, "base64");
  if (!bytes.length) throw new Error("Lyria returned an empty audio payload.");
  writeFileSync(output, bytes, { mode: 0o600 });
  writeFileSync(
    metadata,
    JSON.stringify(
      {
        provider: "google-gemini-api",
        model,
        prompt: options.prompt,
        instrumental: Boolean(options.instrumental),
        duration_seconds_requested: options.duration_seconds ?? null,
        reference_images: images,
        output,
        mime_type: mime,
        bytes: bytes.length,
        lyrics: text.join("\n") || null,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  return {
    output,
    metadata,
    provider: "google-gemini-api",
    model,
    mime_type: mime,
    bytes: bytes.length,
    ...(text.length ? { lyrics: text.join("\n") } : {}),
    billing: "Gemini API billing; no Google Flow credits used",
  };
}

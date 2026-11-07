import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type Page } from "playwright-core";

import { chromeExecutable, HOME_DIR } from "./chrome.js";
import { FFMPEG_HINT, IS_MAC, IS_WIN } from "./platform.js";

// Captions in the style short-form apps use, burned into the picture. The words and their timings come from
// whisper.cpp on this computer; the lettering is drawn by headless Chrome and laid over the video by ffmpeg. Chrome
// does the drawing because Homebrew's ffmpeg is built without any text filter (no ass, subtitles or drawtext), and
// Chrome is already a requirement - so the same code runs on a Mac and on Windows with nothing extra to install.

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLOW_MCP_FFPROBE ?? "ffprobe";
const WHISPER = process.env.FLOW_MCP_WHISPER ?? "whisper-cli";
// Transcripts and preview stills; the panel is allowed to show pictures from here.
export const CACHE_DIR = join(HOME_DIR, "captions");
const MODEL_DIR = join(HOME_DIR, "models");
// Speech models fetched the first time they are needed, from whisper.cpp's own collection on Hugging Face
// (FLOW_MCP_MODEL_BASE points at a mirror folder holding the same files). The sizes are what the panel tells the user.
const SPEECH_MODELS = {
  // English: base.en, an English-only model; those time words best (see PREFERENCE).
  english: { file: "ggml-base.en.bin", mb: 148, purpose: "for English" },
  // Every other language. Measured on Spanish, German, Japanese and Chinese lines (2026-10-13): large-v3-turbo heard
  // every Spanish and German word where small misheard several ("ni un solo" -> "guión solo", "listos" -> "vistos"),
  // placed words as well, and still runs at about ten times real time. q5_0 is its compressed form: the same words at
  // a third of the size.
  other: { file: "ggml-large-v3-turbo-q5_0.bin", mb: 574, purpose: "for this language" },
  // Only names the spoken language, for "auto": right on all 8 test languages in 0.2 s, so an English speaker who never
  // picks a language is not sent the 574 MB model.
  detect: { file: "ggml-base-q5_1.bin", mb: 60, purpose: "that recognises the language" },
  // Silero voice-activity detection (0.9 MB): finds where people actually speak, so each stretch can be heard on its
  // own (see speechSpans). Lives in ggml-org's own collection, not whisper.cpp's.
  vad: { file: "ggml-silero-v5.1.2.bin", mb: 0.8, purpose: "that finds where the speech is", base: "https://huggingface.co/ggml-org/whisper-vad/resolve/main" },
} as const;
type SpeechModel = keyof typeof SPEECH_MODELS;
const MODEL_BASE = (process.env.FLOW_MCP_MODEL_BASE ?? "https://huggingface.co/ggerganov/whisper.cpp/resolve/main").replace(/\/+$/, "");
const BIG = { maxBuffer: 64 * 1024 * 1024 };
const THREADS = String(Math.max(2, Math.min(8, cpus().length - 1)));
type RunError = NodeJS.ErrnoException & { stderr?: string };

export interface Word {
  text: string;
  start: number;
  end: number;
  // A line break typed before this word in the panel: start a new caption here.
  br?: boolean;
}

export interface Transcript {
  words: Word[];
  text: string;
  language: string;
  model: string;
}

export const CAPTION_STYLES = {
  bold: { label: "Bold pop", blurb: "Big capitals, a few words at a time; the word being said lights up", maxWords: 3, highlight: true, pop: true, color: "#FFE135", letters: "capitals" },
  highlight: { label: "Highlight", blurb: "The word being said sits on a coloured block", maxWords: 4, highlight: true, pop: false, color: "#7C3AED", letters: "as_said" },
  reveal: { label: "Word by word", blurb: "Each word appears the moment it is said", maxWords: 5, highlight: true, pop: false, color: "#FFFFFF", letters: "as_said" },
  clean: { label: "Clean", blurb: "Classic subtitles: easy to read, nothing moves", maxWords: 8, highlight: false, pop: false, color: "#FFFFFF", letters: "as_said" },
  boxed: { label: "Boxed", blurb: "White words on a dark band, readable over anything", maxWords: 7, highlight: false, pop: false, color: "#FFFFFF", letters: "as_said" },
} as const;
export type CaptionStyle = keyof typeof CAPTION_STYLES;
// A preset, or how far down the frame the middle of the caption sits: 0 = top edge, 100 = bottom edge.
export type CaptionPosition = "bottom" | "middle" | "top" | number;
// A preset, or a percentage of the style's normal size (100 = medium).
export type CaptionSize = "small" | "medium" | "large" | number;
// as_said keeps whisper's own capitals (sentence starts, names); capitals and lowercase are looks, and both drop
// trailing commas and full stops the way short-form captions do.
export type CaptionLetters = "as_said" | "capitals" | "lowercase";

export interface CaptionOptions {
  style: CaptionStyle;
  position: CaptionPosition;
  size: CaptionSize;
  color?: string;
  letters?: CaptionLetters;
  // Names that keep their capitals in lowercase captions even where they start a sentence ("Juno"); names in the
  // middle of a sentence are found by themselves.
  names?: string[];
  // Seconds the highlight runs ahead of the voice (see LEAD).
  lead?: number;
  text?: string;
  language?: string;
  // Word timings measured elsewhere, used instead of hearing the whole film. A film joined from separate takes is
  // better timed from each take heard on its own: heard whole, Last Train's train noise stretched "second date" over
  // 7 s and squeezed "Go. You'll miss" onto one instant, while each clip on its own was timed right.
  words?: Word[];
}

// The languages the panel offers, by their own names. whisper.cpp knows about 100; any other code works through the MCP.
export const CAPTION_LANGUAGES = [
  ["en", "English"], ["es", "Español"], ["pt", "Português"], ["fr", "Français"], ["de", "Deutsch"], ["it", "Italiano"],
  ["nl", "Nederlands"], ["tr", "Türkçe"], ["pl", "Polski"], ["ru", "Русский"], ["uk", "Українська"], ["ar", "العربية"],
  ["he", "עברית"], ["fa", "فارسی"], ["hi", "हिन्दी"], ["ur", "اردو"], ["bn", "বাংলা"], ["ta", "தமிழ்"], ["id", "Bahasa Indonesia"],
  ["ms", "Bahasa Melayu"], ["tl", "Filipino"], ["vi", "Tiếng Việt"], ["th", "ไทย"], ["ja", "日本語"], ["zh", "中文"], ["yue", "粵語"],
  ["ko", "한국어"], ["sv", "Svenska"], ["da", "Dansk"], ["no", "Norsk"], ["fi", "Suomi"], ["el", "Ελληνικά"], ["cs", "Čeština"],
  ["ro", "Română"], ["hu", "Magyar"], ["ca", "Català"], ["sw", "Kiswahili"],
].map(([code, name]) => ({ code, name }));
// Written without spaces between words: whisper's tokens are then pieces of words, so words come from the language's
// own word breaker, and they are drawn side by side with no space between them.
const UNSPACED = new Set(["ja", "zh", "yue", "th", "lo", "km", "my", "bo"]);
// Letters about one em wide, far wider than the Latin letters CHAR_EM is measured on.
const FULL_WIDTH = new Set(["ja", "zh", "yue", "ko"]);
const RTL = new Set(["ar", "he", "fa", "ur", "yi", "ps", "sd", "ug"]);
const joiner = (lang: string) => (UNSPACED.has(lang) ? "" : " ");
// Punctuation that opens a word (¿Qué, «Hola, 「はい) and punctuation that ends one or a sentence, in many scripts.
const OPENER = /^[¿¡«“„‘‚(\[{「『（《〈]+$/;
const CLOSER = /^[.,!?;:%)\]}"'»…\-。、，！？；：）」』》〉”’،؛؟।]/;
const SENTENCE_END = /[.!?…。！？؟।]["')\]」』）”’]*$/;
const CLAUSE_END = /[,;:，、；：،؛]$/;

const lettersOf = (o: { style: CaptionStyle; letters?: CaptionLetters }): CaptionLetters => o.letters ?? CAPTION_STYLES[o.style].letters;

// Letter size as a share of the frame's short side, so a 9:16 phone video and a 16:9 landscape one read the same.
const FONT = { bold: 7.2, highlight: 6.2, reveal: 6.4, clean: 4.6, boxed: 4.6 };
const CHAR_EM = { bold: 0.74, highlight: 0.56, reveal: 0.56, clean: 0.52, boxed: 0.52 };
const SIZE = { small: 0.82, medium: 1, large: 1.2 };
const scaleOf = (size: CaptionSize) => (typeof size === "number" ? Math.min(2.5, Math.max(0.4, size / 100)) : SIZE[size]);

// Measured on the First Ascent narration (2026-10-11): against where each word really starts in the sound, whisper
// put about half the words on time and the other half 0.13-0.18 s late - and a late highlight shows. People notice a
// picture that lags its sound from about 0.05 s, but not one that runs up to about 0.12 s ahead (ITU-R BT.1359),
// so every caption moves 0.12 s earlier: the late words land almost exactly, the on-time ones stay unnoticeably early.
const LEAD = 0.12;

/* ---------- hearing the words ---------- */

const MODEL_DIRS = [MODEL_DIR, join(homedir(), ".cache", "whisper-models"), join(homedir(), ".cache", "whisper.cpp")];
const PREFERENCE: Record<SpeechModel, string[]> = {
  // English-only models time words best. large-v3-turbo is the most accurate listener but placed "picks" 0.6 s early
  // in an English test where small.en was 30 ms out, so for English it is only a fallback.
  english: ["ggml-small.en.bin", "ggml-base.en.bin", "ggml-medium.en.bin"],
  // For other languages hearing the words right matters most. base and the compressed small are left out on purpose:
  // they mishear too much to caption with, even when present (the language detector is one of them).
  other: ["ggml-large-v3-turbo.bin", "ggml-large-v3-turbo-q5_0.bin", "ggml-large-v3.bin", "ggml-medium.bin", "ggml-small.bin"],
  // Any multilingual model can name the language; the fastest goes first.
  detect: ["ggml-base-q5_1.bin", "ggml-base.bin", "ggml-small-q5_1.bin", "ggml-small.bin", "ggml-large-v3-turbo-q5_0.bin", "ggml-large-v3-turbo.bin", "ggml-medium.bin", "ggml-large-v3.bin"],
  vad: ["ggml-silero-v5.1.2.bin"],
};
const installed = (kind: SpeechModel): string | undefined => PREFERENCE[kind].flatMap((name) => MODEL_DIRS.map((d) => join(d, name))).find((p) => existsSync(p));

// The model that hears one language, downloaded the first time it is needed. English gets its own model even when a
// multilingual one is there, for the timing; a multilingual model only stands in when that download fails.
async function modelFor(lang: string): Promise<string> {
  if (process.env.FLOW_MCP_WHISPER_MODEL) return process.env.FLOW_MCP_WHISPER_MODEL;
  if (lang !== "en") return installed("other") ?? fetchModel("other");
  const english = installed("english");
  if (english) return english;
  const other = installed("other");
  return fetchModel("english").catch((err: Error) => {
    if (other) return other;
    throw err;
  });
}

const WHISPER_HINT = IS_MAC
  ? "brew install whisper-cpp"
  : IS_WIN
    ? "download whisper-cli from github.com/ggml-org/whisper.cpp/releases and put it on your PATH (or set FLOW_MCP_WHISPER)"
    : "install whisper.cpp so whisper-cli is on your PATH";

// What the panel needs to know before offering captions, and the fix for whatever is missing.
export async function captionSetup(): Promise<{
  ready: boolean;
  whisper: boolean;
  whisper_hint?: string;
  models: Record<SpeechModel, boolean>;
  download_mb: Record<SpeechModel, number>;
  languages: typeof CAPTION_LANGUAGES;
  models_dir: string;
}> {
  const whisper = await run(WHISPER, ["--help"]).then(
    () => true,
    (err: RunError) => err.code !== "ENOENT",
  );
  const forced = Boolean(process.env.FLOW_MCP_WHISPER_MODEL);
  // The models are not a precondition: each downloads itself the first time it is needed. The panel uses these to say
  // how big the wait will be.
  const models = { english: forced || Boolean(installed("english")), other: forced || Boolean(installed("other")), detect: forced || Boolean(installed("detect")), vad: Boolean(installed("vad")) };
  const download_mb = { english: SPEECH_MODELS.english.mb, other: SPEECH_MODELS.other.mb, detect: SPEECH_MODELS.detect.mb, vad: SPEECH_MODELS.vad.mb };
  return { ready: whisper, whisper, whisper_hint: whisper ? undefined : WHISPER_HINT, models, download_mb, languages: CAPTION_LANGUAGES, models_dir: MODEL_DIR };
}

// Fetched by itself the first time captions are needed (the user chose this over a button, 2026-10-09). One download
// at a time even if the panel and an assistant ask together; written to .part and renamed, so a cut-off download is
// never mistaken for a model.
const fetching = new Map<SpeechModel, Promise<string>>();
function fetchModel(kind: SpeechModel): Promise<string> {
  const { file, mb, purpose } = SPEECH_MODELS[kind];
  const pending = fetching.get(kind);
  if (pending) return pending;
  const job = (async () => {
    const dest = join(MODEL_DIR, file);
    if (existsSync(dest)) return dest;
    mkdirSync(MODEL_DIR, { recursive: true });
    // curl, not fetch: Node's built-in fetch can crash the whole process on an assertion (undici, "assert(!this.paused)")
    // when a server closes the connection mid-stream - seen while testing this, and here that process is the panel or
    // Claude's connector. curl ships with macOS and Windows 10+, follows the redirect to the download host, and can
    // only fail itself.
    const part = `${dest}.part`;
    await run("curl", ["-L", "--fail", "--silent", "--show-error", "--connect-timeout", "20", "--retry", "2", "-o", part, `${process.env.FLOW_MCP_MODEL_BASE || !("base" in SPEECH_MODELS[kind]) ? MODEL_BASE : (SPEECH_MODELS[kind] as { base: string }).base}/${file}`], BIG).catch((err: RunError) => {
      rmSync(part, { force: true });
      throw new Error(err.code === "ENOENT" ? "curl is not installed" : String(err.stderr || err.message).trim().split("\n").at(-1));
    });
    if (statSync(part).size < mb * 0.9e6) {
      rmSync(part, { force: true });
      throw new Error("it arrived incomplete");
    }
    renameSync(part, dest);
    return dest;
  })()
    .catch((e: Error) => {
      throw new Error(
        `Captions need a speech model ${purpose}, downloaded once (${mb} MB), and the download failed: ${e.message}. Check the internet connection and try again, or put ${file} in ${MODEL_DIR} yourself.`,
      );
    })
    .finally(() => fetching.delete(kind));
  fetching.set(kind, job);
  return job;
}

async function probe(file: string, needPicture = true): Promise<{ width: number; height: number; duration: number; audio?: string }> {
  if (!existsSync(file)) throw new Error(`No video at ${file}.`);
  const { stdout } = await run(
    FFPROBE,
    ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:stream_side_data=rotation:stream_tags=rotate:format=duration", "-of", "json", file],
    BIG,
  ).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") throw new Error(`ffmpeg is not installed. Install it with: ${FFMPEG_HINT}`);
    throw new Error(`"${basename(file)}" isn't a playable video.`);
  });
  const data = JSON.parse(stdout) as {
    streams: { codec_type: string; codec_name?: string; width?: number; height?: number; side_data_list?: { rotation?: number }[]; tags?: { rotate?: string } }[];
    format: { duration?: string };
  };
  const v = data.streams.find((s) => s.codec_type === "video");
  if (!needPicture && !v) return { width: 0, height: 0, duration: Number(data.format.duration ?? 0), audio: data.streams.find((s) => s.codec_type === "audio")?.codec_name };
  if (!v?.width || !v.height) throw new Error(`"${basename(file)}" has no picture to put captions on.`);
  // Phone videos are often stored sideways with a rotation flag; ffmpeg turns them upright, so measure them upright.
  const rotation = Math.abs(Number(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0)) % 180;
  const [width, height] = rotation === 90 ? [v.height, v.width] : [v.width, v.height];
  return { width, height, duration: Number(data.format.duration ?? 0), audio: data.streams.find((s) => s.codec_type === "audio")?.codec_name };
}

interface WhisperJson {
  transcription: { offsets: { from: number; to: number }; tokens?: { text: string; offsets: { from: number; to: number } }[] }[];
  result?: { language?: string };
}

// whisper.cpp's word-sized segments (-ml 1) run each word into the next, hiding every pause. Its tokens keep the real
// gaps, so words are rebuilt from those: a token that starts with a space starts a new word, anything else (", 't")
// belongs to the word before it, and a lone opening mark (¿, «) belongs to the word after it.
function wordsFromTokens(json: WhisperJson, lang: string): Word[] {
  const words: Word[] = [];
  if (UNSPACED.has(lang)) {
    // Here tokens are pieces of words (人 / 工 / 知 / 能), so each character takes its time from its token and words
    // come from the language's own word breaker: 今日 / は / 人工 / 知能 / を.
    let text = "";
    const at: { start: number; end: number }[] = [];
    for (const seg of json.transcription) {
      for (const t of seg.tokens ?? []) {
        if (/^\s*\[_/.test(t.text)) continue;
        const [from, to] = [t.offsets.from / 1000, t.offsets.to / 1000];
        const chars = [...t.text];
        chars.forEach((c, i) => {
          text += c;
          for (let k = 0; k < c.length; k++) at.push({ start: from + ((to - from) * i) / chars.length, end: from + ((to - from) * (i + 1)) / chars.length });
        });
      }
      text += " ";
      at.push(at.at(-1) ?? { start: 0, end: 0 });
    }
    for (const w of segmentWords(text, lang)) words.push({ text: w.text, start: at[w.from].start, end: at[w.to - 1].end });
  } else {
    let opener = "";
    for (const seg of json.transcription) {
      for (const t of seg.tokens ?? []) {
        if (/^\s*\[_/.test(t.text)) continue;
        const clean = t.text.trim();
        if (!clean) continue;
        const last = words.at(-1);
        if (OPENER.test(clean)) opener += clean;
        else if (last && !opener && (!/^\s/.test(t.text) || CLOSER.test(clean))) {
          last.text += clean;
          last.end = t.offsets.to / 1000;
        } else {
          words.push({ text: opener + clean, start: t.offsets.from / 1000, end: t.offsets.to / 1000 });
          opener = "";
        }
      }
    }
  }
  // Drop what whisper writes for non-speech: [MUSIC], (laughs), ♪.
  return words.filter((w) => !/^[[(♪*（].*[\])♪*）]$|^♪+$/.test(w.text));
}

// Splits text written without spaces into words (Intl.Segmenter knows each language's dictionary), keeping punctuation
// with its word. from/to are positions in the text.
function segmentWords(text: string, lang: string): { text: string; from: number; to: number }[] {
  const out: { text: string; from: number; to: number }[] = [];
  let open: { text: string; from: number } | undefined;
  for (const s of new Intl.Segmenter(lang, { granularity: "word" }).segment(text)) {
    const piece = s.segment.trim();
    if (!piece) continue;
    const to = s.index + s.segment.length;
    const last = out.at(-1);
    if (!s.isWordLike && OPENER.test(piece)) open = { text: (open?.text ?? "") + piece, from: open?.from ?? s.index };
    else if (!s.isWordLike && last && !open) {
      last.text += piece;
      last.to = to;
    } else {
      out.push({ text: (open?.text ?? "") + piece, from: open?.from ?? s.index, to });
      open = undefined;
    }
  }
  return out;
}

// Which language is spoken, from the first 30 seconds.
async function detectLanguage(wav: string): Promise<string> {
  const model = installed("detect") ?? (await fetchModel("detect"));
  const { stdout, stderr } = await run(WHISPER, ["-m", model, "-f", wav, "-l", "auto", "-dl", "-t", THREADS], BIG).catch(whisperFailed);
  const lang = /auto-detected language: ([a-z]+)/.exec(`${stderr}${stdout}`)?.[1];
  if (!lang) throw new Error("Couldn't tell which language is spoken. Pick the language and try again.");
  return lang;
}

function whisperFailed(err: RunError): never {
  if (err.code === "ENOENT") throw new Error(`Captions need whisper.cpp to hear the words. Install it: ${WHISPER_HINT}.`);
  throw new Error(`whisper.cpp could not read the sound: ${String(err.stderr ?? err.message).trim().split("\n").at(-1)}`);
}

// language: a whisper code (en, es, ja...) or "auto", which detects it first.
// Where people speak in a mixed sound track (dialogue over engine noise, narration over crashes), from whisper.cpp's
// own voice-activity detector (whisper-vad-speech-segments, installed with whisper-cpp). Measured on First Lesson
// against the loudness: "See?" 15.39 s and "You were braver" 23.78 s, where hearing the whole track had them 0.5 and
// 0.9 s early. Whisper's own segments are no substitute: they run on through seconds of engine noise, and a long tail
// mis-times words just as a long lead does. Stretches closer than 0.4 s are heard together; a first stretch that
// starts within 2 s keeps the opening, where a shout over a sound effect can slip past the detector.
const VAD_SEGMENTS = process.env.FLOW_MCP_WHISPER_VAD ?? WHISPER.replace(/whisper-cli(\.exe)?$/, "whisper-vad-speech-segments$1");
async function voiceSpans(wav: string): Promise<[number, number, number][]> {
  const vad = installed("vad") ?? (await fetchModel("vad"));
  const { stdout, stderr } = await run(VAD_SEGMENTS, ["-vm", vad, "-f", wav], BIG);
  // The list is printed once, on stdout or stderr depending on the build, in centiseconds.
  const pick = (t: string) => [...t.matchAll(/start = ([\d.]+), end = ([\d.]+)/g)].map((m) => [Number(m[1]) / 100, Number(m[2]) / 100]);
  const found = (pick(stdout).length ? pick(stdout) : pick(stderr)).filter(([a, b], i, all) => b > a && (i === 0 || a >= all[i - 1][0]));
  // Each stretch: [window start, window end, where the speech itself starts].
  const spans: [number, number, number][] = [];
  for (const [from, to] of found) {
    const last = spans[spans.length - 1];
    if (last && from - last[1] < 0.4) last[1] = to + 0.3;
    else spans.push([Math.max(last ? last[1] : 0, from - 0.3), to + 0.3, from]);
  }
  // The opening stretch is heard from 0:00, because the detector can miss a first shout over a sound effect ("Dad!" over
  // the stall in First Lesson). Its floor is the first loud spike well above the background (18 dB over the quietest
  // fifth), or the detector's onset if that comes first: without a floor, Theo's line at 1.3 s in Last Train was
  // bunched at 0:00, with "fifteen" lit before it was said.
  if (spans.length && spans[0][0] < 2) {
    const level = loudness(wav);
    const quiet = [...level].sort((x, y) => x - y)[Math.floor(level.length / 5)] ?? -60;
    const onset = spans[0][2];
    let spike = level.findIndex((v) => v > quiet + 18) * FRAME;
    if (spike < 0 || spike > onset) spike = onset;
    // Heard from just before that spike, not from 0:00: a second of footsteps ahead of the first word was enough for
    // whisper to bunch the whole line onto one instant.
    spans[0] = [Math.max(0, spike - 0.2), spans[0][1], Math.max(0, spike - 0.05)];
  }
  return spans;
}

// Loudness of a 16 kHz mono 16-bit WAV in 50 ms frames, in dB.
const FRAME = 0.05;
function loudness(wav: string): number[] {
  const buf = readFileSync(wav);
  const data = buf.indexOf("data") + 8;
  const step = Math.round(16000 * FRAME);
  const out: number[] = [];
  for (let at = data; at + step * 2 <= buf.length; at += step * 2) {
    let sum = 0;
    for (let i = 0; i < step; i++) sum += buf.readInt16LE(at + i * 2) ** 2;
    out.push(10 * Math.log10(sum / step / 32768 ** 2 + 1e-12));
  }
  return out;
}

// The stretches of a clean narration track that hold speech: everything between silences of 0.6 s or more, with a
// little air kept either side so no word is clipped.
async function speechSpans(wav: string): Promise<[number, number][]> {
  const { stderr } = await run(FFMPEG, ["-v", "info", "-i", wav, "-af", "silencedetect=noise=-40dB:d=0.6", "-f", "null", "-"], BIG);
  const total = Number(stderr.match(/Duration: (\d+):(\d+):([\d.]+)/)?.slice(1).reduce((t, v) => t * 60 + Number(v), 0) ?? 0);
  const quiet = [...stderr.matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const spans: [number, number][] = [];
  let at = 0;
  for (const [a, b] of quiet) {
    if (a - at > 0.2) spans.push([Math.max(0, at - 0.15), a + 0.15]);
    at = b;
  }
  if (total - at > 0.2) spans.push([Math.max(0, at - 0.15), total]);
  return spans.length ? spans : [[0, total]];
}

export async function transcribe(video: string, language = "auto"): Promise<Transcript> {
  const info = await probe(video, false);
  if (!info.audio) throw new Error(`"${basename(video)}" has no sound, so there are no words to caption.`);
  const asked = language.trim().toLowerCase() || "auto";
  if (!/^(auto|[a-z]{2,3})$/.test(asked)) throw new Error(`"${language}" isn't a language code. Use a code such as en, es or ja, or auto.`);
  const st = statSync(video);
  // flow_assemble keeps the narration it laid over a film as <film>-voice.wav, on the film's own timeline. Words are
  // timed from that clean track when it is there: under the clips' crashes and music, whisper squeezed every word
  // after a pause onto one instant (five words at 10.18 s, zero length) and dropped the punctuation.
  const voice = video.replace(/\.\w+$/, "") + "-voice.wav";
  // It starts at 0:00 like the film and ends with the last line, so it may be shorter, never longer.
  const voiceLength = existsSync(voice) ? (await probe(voice, false).catch(() => ({ duration: 0 }))).duration : 0;
  const clean = voiceLength > 0 && voiceLength <= info.duration + 1 ? voice : undefined;
  const vst = clean ? statSync(clean) : undefined;
  const cacheFile = (...parts: string[]) =>
    join(CACHE_DIR, `${createHash("sha1").update([video, st.size, st.mtimeMs, ...(vst ? [clean!, vst.size, vst.mtimeMs] : []), "spans-v7", ...parts].join("|")).digest("hex").slice(0, 16)}.json`);
  const keep = (t: Transcript, ...files: (string | undefined)[]) => {
    mkdirSync(CACHE_DIR, { recursive: true });
    for (const f of files) if (f) writeFileSync(f, JSON.stringify(t));
    return t;
  };
  // "auto" is remembered on its own, so the language is detected once per video, not on every preview.
  const autoFile = asked === "auto" ? cacheFile("auto") : undefined;
  if (autoFile && existsSync(autoFile)) return JSON.parse(readFileSync(autoFile, "utf8")) as Transcript;

  const work = mkdtempSync(join(tmpdir(), "flow-captions-"));
  const wav = join(work, "audio.wav");
  const extract = () => run(FFMPEG, ["-v", "error", "-y", "-i", clean ?? video, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], BIG);
  try {
    let lang = asked;
    if (lang === "auto" && !process.env.FLOW_MCP_WHISPER_MODEL) {
      await extract();
      lang = await detectLanguage(wav);
    }
    const model = await modelFor(lang);
    if (basename(model).includes(".en.")) lang = "en";
    const cached = cacheFile(basename(model), lang);
    if (existsSync(cached)) return keep(JSON.parse(readFileSync(cached, "utf8")) as Transcript, autoFile);
    if (!existsSync(wav)) await extract();
    const listen = async (file: string, out: string) => {
      await run(WHISPER, ["-m", model, "-f", file, "-l", lang, "-t", THREADS, "-ojf", "-of", out, "-np"], BIG).catch(whisperFailed);
      // whisper-cli exits 0 even when it cannot read the audio, and simply writes nothing.
      if (!existsSync(out + ".json")) throw new Error(`whisper.cpp could not read the sound in "${basename(video)}".`);
      return JSON.parse(readFileSync(out + ".json", "utf8")) as WhisperJson;
    };
    let heard = lang;
    let words: Word[] = [];
    // Heard as one piece, whisper squeezes the first words after every pause onto one instant (measured: "Why risk it
    // all for one" all at 20.24 s, five words at 10.18 s with zero length) and can lose the punctuation. Each spoken
    // stretch is therefore heard on its own, starting on speech, where token times land within ~50 ms, and shifted back
    // onto the film's timeline. The clean narration track finds its stretches by silence; a mixed track asks whisper's
    // voice-activity detection. If neither works, the whole track is heard at once, as before.
    const spans = clean ? await speechSpans(wav) : await voiceSpans(wav).catch(() => undefined);
    if (spans?.length) {
      for (const [i, [from, to, onset]] of spans.entries()) {
        const part = join(work, `part-${i}.wav`);
        await run(FFMPEG, ["-v", "error", "-y", "-ss", from.toFixed(3), "-t", (to - from).toFixed(3), "-i", wav, "-c:a", "pcm_s16le", part], BIG);
        const json = await listen(part, join(work, `part-${i}`));
        heard = json.result?.language ?? heard;
        // whisper tends to start the first word right at the window's edge, in the air before the speech; the detector
        // knows when the speech begins, so no word starts earlier than that (measured: 0.3 s early without this).
        const floor = onset ?? 0;
        words.push(...wordsFromTokens(json, heard).map((w) => ({ ...w, start: Math.max(w.start + from, floor), end: Math.max(w.end + from, floor + 0.05) })));
      }
    } else {
      const json = await listen(wav, join(work, "words"));
      heard = json.result?.language ?? lang;
      words = wordsFromTokens(json, heard);
    }
    if (!words.length) throw new Error(`No speech was heard in "${basename(video)}".`);
    return keep({ words, text: words.map((w) => w.text).join(joiner(heard)), language: heard, model: basename(model) }, cached, autoFile);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/* ---------- fixing the words ---------- */

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

// Lines up a corrected transcript with the timed one. Every word that still matches keeps its timing; new or changed
// words are spread evenly over the gap they fill, so fixing "flo" to "Flow" or adding a missed word just works.
export function alignText(timed: Word[], text: string, lang = "en"): Word[] {
  const toks: { text: string; br: boolean }[] = [];
  text.split("\n").forEach((line, li) =>
    (UNSPACED.has(lang) ? segmentWords(line, lang).map((w) => w.text) : line.split(/\s+/).filter(Boolean)).forEach((t, i) => toks.push({ text: t, br: li > 0 && i === 0 })),
  );
  if (!toks.length) return [];
  const a = timed.map((w) => norm(w.text));
  const b = toks.map((t) => norm(t.text));
  const n = a.length;
  const m = b.length;
  const match = new Array<number>(m).fill(-1);
  if (n * m <= 25_000_000) {
    // Longest common subsequence; 25 M cells is roughly an hour of speech on either side.
    const W = m + 1;
    const L = new Uint16Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) L[i * W + j] = a[i] && a[i] === b[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    for (let i = 0, j = 0; i < n && j < m; ) {
      if (a[i] && a[i] === b[j]) match[j++] = i++;
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++;
      else j++;
    }
  } else {
    // Very long texts: match greedily, looking a little way ahead.
    for (let i = 0, j = 0; j < m; j++) {
      const k = a.slice(i, i + 40).indexOf(b[j]);
      if (b[j] && k >= 0) {
        match[j] = i + k;
        i += k + 1;
      }
    }
  }
  const out: Word[] = toks.map((t, k) => (match[k] >= 0 ? { ...t, start: timed[match[k]].start, end: timed[match[k]].end } : { ...t, start: NaN, end: NaN }));
  for (let k = 0; k < m; ) {
    if (!Number.isNaN(out[k].start)) {
      k++;
      continue;
    }
    let e = k;
    while (e < m && Number.isNaN(out[e].start)) e++;
    // The heard words in the same gap are what these replace ("Pym" for "Pim", "12" for "twelve"). Same count: each
    // takes its counterpart's time. Otherwise they share that stretch. Spreading over the whole gap instead put "Pim"
    // straight after the previous line, 4.6 s before it was said.
    // Only real words count: whisper prints a dash between speakers as a token of its own, and pairing "fifty" with
    // it gave a caption of zero length.
    const heard: number[] = [];
    for (let i = k > 0 ? match[k - 1] + 1 : 0; i < (e < m ? match[e] : n); i++) if (a[i]) heard.push(i);
    if (heard.length === e - k) {
      for (let q = k; q < e; q++) {
        out[q].start = timed[heard[q - k]].start;
        out[q].end = timed[heard[q - k]].end;
      }
      k = e;
      continue;
    }
    let from = heard.length ? timed[heard[0]].start : k > 0 ? out[k - 1].end : (timed[0]?.start ?? 0);
    const to = heard.length ? timed[heard[heard.length - 1]].end : e < m ? out[e].start : Math.max(from + 0.35 * (e - k), timed.at(-1)?.end ?? 0);
    // Words the listener missed altogether ("That was the nine forty-nine" heard as "was the 949") were swallowed just
    // before the next word, not somewhere in the pause before them: spread over a 2 s pause, "That" showed 2 s early.
    if (!heard.length && e < m) from = Math.max(from, to - 0.3 * (e - k));
    const step = Math.max(0.05, (to - from) / (e - k));
    for (let q = k; q < e; q++) {
      out[q].start = from + step * (q - k);
      out[q].end = from + step * (q - k + 1);
    }
    k = e;
  }
  return out;
}

/* ---------- laying out captions ---------- */

interface State {
  words: string[];
  active: number;
  scale: number;
  from: number;
  to: number;
}

function paginate(words: Word[], maxWords: number, maxChars: number, sep: string): Word[][] {
  const pages: Word[][] = [];
  let cur: Word[] = [];
  let chars = 0;
  for (const w of words) {
    const prev = cur.at(-1);
    const brk =
      prev !== undefined &&
      (w.br ||
        cur.length >= maxWords ||
        chars + w.text.length > maxChars ||
        SENTENCE_END.test(prev.text) ||
        CLAUSE_END.test(prev.text) ||
        w.start - prev.end > 0.6);
    if (brk) {
      pages.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(w);
    chars += w.text.length + sep.length;
  }
  if (cur.length) pages.push(cur);
  return pages;
}

function layout(heard: Word[], style: CaptionStyle, width: number, height: number, size: CaptionSize, letters: CaptionLetters, lead: number, lang: string): { pages: Word[][]; states: State[] } {
  // A word's end is capped by its length: the speech model lets the last word of a line run on through laughter or a
  // train arriving, which kept "Adventurous!" and "To a second date." on screen for 7 s (Last Train).
  const longest = (t: string) => Math.min(1.4, 0.35 + 0.075 * t.replace(/[^\p{L}\p{N}]/gu, "").length);
  const words = heard.map((w) => {
    const start = Math.max(0, w.start - lead);
    return { ...w, start, end: Math.max(start, Math.min(w.end - lead, start + longest(w.text))) };
  });
  const s = CAPTION_STYLES[style];
  const u = (Math.min(width, height) / 100) * scaleOf(size);
  // Capitals are wider than small letters, so fewer of them fit on a line.
  const wide = FULL_WIDTH.has(lang) ? 1 : CHAR_EM[style] * (letters === "capitals" && style !== "bold" ? 1.2 : letters !== "capitals" && style === "bold" ? 0.85 : 1);
  const perLine = Math.max(8, Math.floor(boxWidth(style, width, height) / (FONT[style] * u * wide)));
  // Words written without spaces are short (は, を, 的), so a caption holds more of them.
  const pages = paginate(words, s.maxWords * (UNSPACED.has(lang) ? 3 : 1), perLine * 2, joiner(lang));
  // Capitals and lowercase read better without commas and full stops; question and exclamation marks stay.
  const shown = (t: string) => (letters === "as_said" ? t : t.replace(/[.,;:。、，；：،؛]+$/, ""));
  const states: State[] = [];
  let clock = 0;
  const push = (st: State) => {
    st.from = Math.max(st.from, clock);
    if (st.to - st.from < 0.02) return;
    states.push(st);
    clock = st.to;
  };
  pages.forEach((p, pi) => {
    const start = p[0].start;
    const next = pages[pi + 1]?.[0].start;
    let end = p[p.length - 1].end + 0.25;
    // Close a short gap to the next caption instead of flashing an empty frame; never overlap it.
    if (next !== undefined) end = next - end < 0.5 ? next : Math.min(end, next);
    const texts = p.map((w) => shown(w.text));
    const first = states.length;
    if (!s.highlight) push({ words: texts, active: -1, scale: 1, from: start, to: end });
    else p.forEach((w, i) => push({ words: texts, active: i, scale: 1, from: i === 0 ? start : w.start, to: i < p.length - 1 ? p[i + 1].start : end }));
    // A quick grow-in for each new caption: three frames, then still.
    const lead = states[first];
    if (s.pop && lead && lead.to - lead.from > 0.2) {
      const t = lead.from;
      states.splice(
        first,
        1,
        { ...lead, scale: 0.78, from: t, to: t + 0.05 },
        { ...lead, scale: 0.94, from: t + 0.05, to: t + 0.1 },
        { ...lead, scale: 1.05, from: t + 0.1, to: t + 0.15 },
        { ...lead, from: t + 0.15 },
      );
    }
  });
  return { pages, states };
}

const boxWidth = (style: CaptionStyle, width: number, height: number) =>
  width * (height > width ? 0.86 : style === "clean" || style === "boxed" ? 0.8 : 0.72);

function textOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? "#111111" : "#FFFFFF";
}

// Names keep their capitals in lowercase captions (the user's rule, 2026-10-18: "always capitalize names even if lower
// case selected"). A name is a word written with a capital where no sentence starts - the speech model and the user's
// corrections both capitalise names - and every other time that word appears, plus any names passed in. "I" is not a
// name. Captions in capitals or as said need nothing: names are already right there.
function namesIn(words: Word[], extra: string[] = []): string[] {
  const names = new Set(extra.map(norm).filter(Boolean));
  words.forEach((w, i) => {
    const bare = w.text.replace(/^[^\p{L}\p{N}]+/u, "");
    const startsSentence = i === 0 || w.br || SENTENCE_END.test(words[i - 1].text);
    if (!startsSentence && /^\p{Lu}/u.test(bare) && !/^I(['’]|$)/u.test(bare)) names.add(norm(w.text));
  });
  return [...names];
}

function pageHtml(style: CaptionStyle, o: { width: number; height: number; position: CaptionPosition; size: CaptionSize; color: string; letters: CaptionLetters; lang: string; names?: string[]; background?: string }): string {
  const { width: W, height: H } = o;
  const vertical = H > W;
  const font = FONT[style] * (Math.min(W, H) / 100) * scaleOf(o.size);
  const place =
    typeof o.position === "number"
      ? `top:${Math.min(96, Math.max(4, o.position))}%;transform:translate(-50%,-50%)`
      : o.position === "middle"
      ? "top:50%;transform:translate(-50%,-50%)"
      : o.position === "top"
        ? `top:${vertical ? 13 : 7}%;transform:translateX(-50%)`
        : `bottom:${vertical ? 21 : 8}%;transform:translateX(-50%)`;
  const sans = `system-ui,-apple-system,"Segoe UI","Helvetica Neue",Arial,sans-serif`;
  // The outline is a copy of each word drawn underneath with a thick stroke, so it never eats into the letters.
  const outline = (w: string) => `.w{position:relative;display:inline-block}.w::before{content:attr(data-t);position:absolute;left:0;top:0;z-index:-1;-webkit-text-stroke:${w} #000;color:#000}`;
  const css = {
    bold: `.cap{font:900 ${font}px/1.12 "Arial Black","Arial Bold",Impact,${sans};text-transform:uppercase;letter-spacing:.01em;color:#fff}
      ${outline(".17em")}.w::before{text-shadow:0 .07em 0 rgba(0,0,0,.55)}.w{margin:0 .07em}.w.on{color:var(--hl);transform:scale(1.06)}`,
    highlight: `.cap{font:800 ${font}px/1.32 ${sans};color:#fff}
      .w{display:inline-block;padding:.02em .13em .07em;margin:0 -.04em;border-radius:.2em;text-shadow:0 .05em .2em rgba(0,0,0,.75)}.w.on{background:var(--hl);color:var(--on);text-shadow:none}`,
    reveal: `.cap{font:800 ${font}px/1.2 ${sans};color:#fff}${outline(".13em")}.later{visibility:hidden}.w.on{color:var(--hl)}`,
    clean: `.cap{font:700 ${font}px/1.25 ${sans};color:#fff;text-shadow:0 .04em .12em rgba(0,0,0,.9),0 0 .35em rgba(0,0,0,.55)}`,
    boxed: `.cap{font:700 ${font}px/1.55 ${sans};color:#fff}.inner{display:inline;background:rgba(0,0,0,.74);padding:.12em .45em;border-radius:.28em;-webkit-box-decoration-break:clone;box-decoration-break:clone}`,
  }[style];
  // The language tag makes capitals right for the language (Turkish i -> İ, not I); right-to-left scripts read that way.
  const lang = /^[a-z]{2,3}$/.test(o.lang) ? o.lang : "en";
  return `<!doctype html><html lang="${lang}"${RTL.has(lang) ? ' dir="rtl"' : ""}><head><meta charset="utf-8"><style>
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:${o.background ? `#000 url(${o.background}) center/100% 100% no-repeat` : "transparent"}}
.cap{position:absolute;left:50%;width:${boxWidth(style, W, H)}px;text-align:center;text-wrap:balance;--hl:${o.color};--on:${textOn(o.color)};${place};-webkit-font-smoothing:antialiased}
.inner{display:block;transform-origin:50% 60%}
${css}
.cap{text-transform:${{ as_said: "none", capitals: "uppercase", lowercase: "lowercase" }[o.letters]}}
.w.name{text-transform:none}
${UNSPACED.has(lang) ? ".w{margin-left:.03em;margin-right:.03em}" + (style === "highlight" ? ".w{margin-left:-.07em;margin-right:-.07em}" : "") : ""}
</style></head><body><div class="cap"><div class="inner" id="inner"></div></div><script>
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const NAMES = new Set(${JSON.stringify(o.letters === "lowercase" ? (o.names ?? []) : [])});
const isName = (w) => NAMES.has(w.toLowerCase().replace(/[^\\p{L}\\p{N}']+/gu, ""));
window.paint = (s) => {
  const el = document.getElementById("inner");
  el.style.transform = s.scale === 1 ? "" : "scale(" + s.scale + ")";
  el.innerHTML = s.words.map((w, i) => '<span class="w' + (i === s.active ? " on" : "") + (isName(w) ? " name" : "") + (${style === "reveal"} && i > s.active ? " later" : "") + '" data-t="' + esc(w) + '">' + esc(w) + "</span>").join(${JSON.stringify(joiner(lang))});
};
</script></body></html>`;
}

/* ---------- drawing ---------- */

let browser: Promise<Browser> | null = null;
let idle: NodeJS.Timeout | undefined;

// One headless Chrome, with its own throwaway profile, kept warm for a minute and a half so previews are quick.
async function drawingBrowser(): Promise<Browser> {
  clearTimeout(idle);
  browser ??= chromium.launch({ executablePath: chromeExecutable(), headless: true, args: ["--hide-scrollbars", "--force-color-profile=srgb"] }).catch((err) => {
    browser = null;
    throw err;
  });
  return browser;
}
function releaseBrowser(): void {
  clearTimeout(idle);
  idle = setTimeout(async () => {
    const b = await browser?.catch(() => null);
    browser = null;
    await b?.close().catch(() => {});
  }, 90_000);
  idle.unref?.();
}

async function withPage<T>(width: number, height: number, html: string, use: (page: Page) => Promise<T>): Promise<T> {
  const b = await drawingBrowser();
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    return await use(page);
  } finally {
    await ctx.close().catch(() => {});
    releaseBrowser();
  }
}

/* ---------- putting it together ---------- */

const pickColor = (o: CaptionOptions) => (o.color && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : CAPTION_STYLES[o.style].color);

async function timedWords(video: string, o: CaptionOptions): Promise<{ transcript: Transcript; words: Word[] }> {
  const given = o.words?.filter((w) => w.text.trim() && Number.isFinite(w.start) && Number.isFinite(w.end)).sort((p, q) => p.start - q.start);
  const transcript: Transcript = given?.length
    ? { words: given, text: given.map((w) => w.text).join(" "), language: o.language && o.language !== "auto" ? o.language : "en", model: "given timings" }
    : await transcribe(video, o.language ?? "auto");
  const edited = o.text?.trim();
  // "Unchanged" is judged word by word. Comparing with every space removed made "your iced" equal the misheard
  // "youriced", so a correction that only splits a run-together word was silently thrown away. Only the languages
  // written without spaces compare that way.
  const flat = (s: string) =>
    UNSPACED.has(transcript.language) ? norm(s.replace(/\s+/g, "")) : s.split(/\s+/).map(norm).filter(Boolean).join(" ");
  const same = edited !== undefined && flat(edited) === flat(transcript.text) && !edited.includes("\n");
  return { transcript, words: edited && !same ? alignText(transcript.words, edited, transcript.language) : transcript.words };
}

// One still of the real video with the real captions on it, so the panel shows exactly what will be made.
export async function previewCaptions(video: string, opts: CaptionOptions): Promise<{ image: string; at: number }> {
  const o = withDefaults(opts);
  const info = await probe(video);
  const { transcript, words } = await timedWords(video, o);
  const lang = transcript.language;
  const { pages, states } = layout(words, o.style, info.width, info.height, o.size, lettersOf(o), o.lead ?? LEAD, lang);
  // A caption of a few words, about a third of the way in, mid-sentence.
  const want = (pages[0]?.[0].start ?? 0) + ((pages.at(-1)?.at(-1)?.end ?? 0) - (pages[0]?.[0].start ?? 0)) * 0.33;
  const page = pages.filter((p) => p.length >= Math.min(2, CAPTION_STYLES[o.style].maxWords)).sort((p, q) => Math.abs(p[0].start - want) - Math.abs(q[0].start - want))[0] ?? pages[0];
  const mid = page ? page[Math.floor((page.length - 1) / 2)] : undefined;
  const state = states.find((s) => mid && s.from <= mid.start + 0.01 && s.to > mid.start && s.scale === 1) ?? states.find((s) => s.scale === 1);
  const at = state ? (state.from + state.to) / 2 : Math.min(1, info.duration / 2);

  mkdirSync(CACHE_DIR, { recursive: true });
  const key = createHash("sha1").update(video).digest("hex").slice(0, 12);
  const frame = join(CACHE_DIR, `frame-${key}.jpg`);
  await run(FFMPEG, ["-v", "error", "-y", "-ss", at.toFixed(3), "-i", video, "-frames:v", "1", "-q:v", "3", frame], BIG);
  const background = `data:image/jpeg;base64,${readFileSync(frame).toString("base64")}`;
  const image = join(CACHE_DIR, `preview-${key}.jpg`);
  await withPage(info.width, info.height, pageHtml(o.style, { ...info, position: o.position, size: o.size, color: pickColor(o), letters: lettersOf(o), lang, names: namesIn(words, o.names), background }), async (p) => {
    if (state) await p.evaluate((s) => (window as unknown as { paint: (s: unknown) => void }).paint(s), state);
    await p.screenshot({ path: image, type: "jpeg", quality: 85 });
  });
  rmSync(frame, { force: true });
  return { image, at };
}

const stamp = (t: number) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

export interface CaptionResult {
  output: string;
  srt: string;
  captions: number;
  words: number;
  duration: number;
  transcript: string;
  language: string;
  model: string;
}

// The tool and the panel always pass a size and position, but a direct caller may not: without them the page got no
// font size, fell back to the browser's tiny serif default and drew captions nobody could read.
const withDefaults = (o: CaptionOptions): CaptionOptions => ({ ...o, size: o.size ?? "medium", position: o.position ?? "bottom" });

export async function burnCaptions(video: string, opts: CaptionOptions, output: string): Promise<CaptionResult> {
  const o = withDefaults(opts);
  const info = await probe(video);
  const { transcript, words } = await timedWords(video, o);
  const lang = transcript.language;
  const sep = joiner(lang);
  const { pages, states } = layout(words, o.style, info.width, info.height, o.size, lettersOf(o), o.lead ?? LEAD, lang);
  if (!states.length) throw new Error("There are no words to put on screen.");

  const work = mkdtempSync(join(tmpdir(), "flow-captions-"));
  try {
    // Draw every distinct caption once, as a transparent picture the size of the video.
    const files = new Map<string, string>();
    await withPage(info.width, info.height, pageHtml(o.style, { ...info, position: o.position, size: o.size, color: pickColor(o), letters: lettersOf(o), lang, names: namesIn(words, o.names) }), async (p) => {
      await p.screenshot({ path: join(work, "blank.png"), omitBackground: true });
      for (const s of states) {
        const id = JSON.stringify([s.words, s.active, s.scale]);
        if (files.has(id)) continue;
        const name = `c${String(files.size + 1).padStart(5, "0")}.png`;
        await p.evaluate((st) => (window as unknown as { paint: (s: unknown) => void }).paint(st), s);
        await p.screenshot({ path: join(work, name), omitBackground: true });
        files.set(id, name);
      }
    });

    // Play those pictures as a second video track with exact timings, and lay it over the original.
    const lines = ["ffconcat version 1.0"];
    let t = 0;
    const add = (file: string, dur: number) => lines.push(`file '${file}'`, `duration ${dur.toFixed(3)}`);
    for (const s of states) {
      if (s.from - t > 0.0005) add("blank.png", s.from - t);
      add(files.get(JSON.stringify([s.words, s.active, s.scale]))!, s.to - s.from);
      t = s.to;
    }
    add("blank.png", Math.max(0.05, info.duration - t + 1));
    lines.push("file 'blank.png'");
    writeFileSync(join(work, "captions.ffconcat"), lines.join("\n") + "\n");

    await run(
      FFMPEG,
      [
        "-v", "error", "-y",
        "-i", video,
        "-f", "concat", "-safe", "0", "-i", join(work, "captions.ffconcat"),
        "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto:eof_action=pass[v]",
        "-map", "[v]", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", info.audio === "aac" ? "copy" : "aac", ...(info.audio === "aac" ? [] : ["-b:a", "192k"]),
        "-movflags", "+faststart",
        output,
      ],
      BIG,
    ).catch((err: RunError) => {
      throw new Error(`ffmpeg could not add the captions: ${String(err.stderr ?? err.message).trim().split("\n").at(-1)}`);
    });

    // The same words as a subtitle file, for YouTube and other players that show their own captions.
    const srt = output.replace(/\.[^.]+$/, ".srt");
    writeFileSync(
      srt,
      pages
        .map((p, i) => {
          const next = pages[i + 1]?.[0].start;
          const end = next !== undefined ? Math.min(p[p.length - 1].end + 0.25, next) : p[p.length - 1].end + 0.25;
          return `${i + 1}\n${stamp(p[0].start)} --> ${stamp(end)}\n${p.map((w) => w.text).join(sep)}\n`;
        })
        .join("\n"),
    );
    return { output, srt, captions: pages.length, words: words.length, duration: info.duration, transcript: words.map((w) => w.text).join(sep), language: lang, model: transcript.model };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// "clip.mp4" -> "<dir>/clip-captions.mp4", then -captions-2 and so on, so nothing is ever overwritten.
export function captionedName(dir: string, video: string): string {
  const stem = basename(video, extname(video)).replace(/[^\w.-]+/g, "_");
  for (let i = 1; ; i++) {
    const out = join(dir, `${stem}-captions${i > 1 ? `-${i}` : ""}.mp4`);
    if (!existsSync(out)) return out;
  }
}

// A closing card for an ad or a film: big centred words over the film's own last frame, blurred and darkened, so the
// card belongs to the film instead of cutting to a flat colour. Drawn by the same headless Chrome as the captions
// (ffmpeg here has no text filters). Type is sized from the frame's short side, so a vertical 9:16 card reads on a phone.
export async function renderEndCard(text: string, width: number, height: number, background: string | undefined, out: string): Promise<string> {
  const bg = background && existsSync(background) ? `data:image/jpeg;base64,${readFileSync(background).toString("base64")}` : "";
  const size = Math.round(Math.min(width, height) * (text.length > 40 ? 0.085 : 0.12));
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#111}
    .bg{position:absolute;inset:-40px;background:${bg ? `url(${bg}) center/cover` : "#111"};filter:blur(28px) brightness(.42)}
    .t{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 8%;
       font:900 ${size}px/1.12 "Arial Black","Helvetica Neue",Arial,sans-serif;color:#fff;text-wrap:balance;
       text-shadow:0 ${Math.round(size / 12)}px ${Math.round(size / 3)}px rgba(0,0,0,.55);white-space:pre-line}
  </style></head><body><div class="bg"></div><div class="t">${esc(text.trim())}</div></body></html>`;
  try {
    await withPage(width, height, html, (page) => page.screenshot({ path: out, type: "png" }));
  } finally {
    releaseBrowser();
  }
  return out;
}

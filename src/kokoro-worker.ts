// Runs one Kokoro take in its own process, so the 300 MB model and Hugging Face's download code never live inside the
// panel or Claude's connector: a crash here ends this take only. Input is a JSON file (the line never goes on a command
// line); output is a 16-bit mono WAV at 24 kHz, and one line of JSON on stdout.
import { readFileSync, writeFileSync } from "node:fs";
import { env } from "@huggingface/transformers";
import { KokoroTTS, TextSplitterStream } from "kokoro-js";

interface Job {
  text: string;
  voice: string;
  speed: number;
  out: string;
  cache: string;
  model: string;
}

const job = JSON.parse(readFileSync(process.argv[2], "utf8")) as Job;
env.cacheDir = job.cache;

// Kokoro reads at most 510 phoneme tokens per pass and silently drops the rest, so a long narration is cut into
// sentences and packed into chunks well under that (roughly one token per character of English).
const CHUNK = 300;
function chunks(text: string): string[] {
  const splitter = new TextSplitterStream();
  splitter.push(text);
  splitter.close();
  const out: string[] = [];
  for (const sentence of splitter) {
    const pieces = sentence.length > CHUNK ? sentence.split(/(?<=[,;:])\s+/) : [sentence];
    for (const piece of pieces) {
      if (out.length && out[out.length - 1].length + piece.length + 1 <= CHUNK) out[out.length - 1] += " " + piece;
      else out.push(piece);
    }
  }
  return out;
}

// Every pass starts with about half a second of silence and ends with some more, so chunks joined as they come leave
// a gap of over a second (measured). Each is trimmed to its speech and joined with an ordinary sentence pause.
const RATE = 24000;
function trim(a: Float32Array): Float32Array {
  const loud = (x: number) => Math.abs(x) > 0.01;
  let start = a.findIndex(loud);
  if (start < 0) return a.subarray(0, 0);
  let end = a.length - 1;
  while (end > start && !loud(a[end])) end--;
  const margin = Math.round(RATE * 0.04);
  return a.subarray(Math.max(0, start - margin), Math.min(a.length, end + 1 + margin));
}

const tts = await KokoroTTS.from_pretrained(job.model, { dtype: "fp32", device: "cpu" });
const pause = new Float32Array(Math.round(RATE * 0.4));
const parts: Float32Array[] = [];
for (const [i, chunk] of chunks(job.text).entries()) {
  if (i) parts.push(pause);
  const audio = await tts.generate(chunk, { voice: job.voice as never, speed: job.speed });
  parts.push(trim(audio.audio as Float32Array));
}

const samples = parts.reduce((n, p) => n + p.length, 0);
const wav = Buffer.alloc(44 + samples * 2);
wav.write("RIFF", 0);
wav.writeUInt32LE(36 + samples * 2, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(RATE, 24);
wav.writeUInt32LE(RATE * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(samples * 2, 40);
let at = 44;
for (const part of parts)
  for (const s of part) {
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), at);
    at += 2;
  }
writeFileSync(job.out, wav);
console.log(JSON.stringify({ seconds: samples / RATE }));

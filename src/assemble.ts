import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { FFMPEG_HINT, IS_LINUX, IS_MAC, IS_WIN, powershell, psQuote } from "./platform.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLOW_MCP_FFPROBE ?? "ffprobe";

export interface AssembleOptions {
  dir: string;
  clips?: string[];
  music?: string;
  music_volume: number;
  clip_volume?: number;
  voiceover?: string;
  output_name: string;
  hold_last_frame?: boolean;
}

interface ClipInfo {
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
}

async function probe(file: string): Promise<ClipInfo> {
  // A raw ffprobe dump ("moov atom not found") told the user nothing. Say which file and what to do about it.
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", file]).catch(() => {
    throw new Error(`"${basename(file)}" isn't a playable video - it may be an unfinished download or a ZIP of several clips. Remove it, or pick other clips.`);
  });
  const data = JSON.parse(stdout) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
  const video = data.streams.find((s) => s.codec_type === "video");
  if (!video?.width || !video.height) throw new Error(`${file} has no video stream.`);
  return {
    width: video.width,
    height: video.height,
    duration: Number(data.format.duration),
    hasAudio: data.streams.some((s) => s.codec_type === "audio"),
  };
}

// Clips are normally scene-NN.mp4, but a film can also be cut from clips pulled out of Flow (clip-NN) or restyled
// ones (edit-NN). Narration takes and previously assembled films are never treated as footage.
function defaultClips(dir: string): string[] {
  if (!existsSync(dir)) {
    throw new Error(`There's no "${basename(dir)}" folder in your films yet. Add clips with "Upload a video" or "From my films", or type the name of a folder that already has clips in it.`);
  }
  const files = readdirSync(dir).filter((f) => /\.mp4$/i.test(f) && !/^narration-/i.test(f));
  const numbered = new Map<string, string>();
  for (const f of files.sort()) {
    const key = f.match(/^((?:scene|clip|edit)-\d+)(-v\d+)?\.mp4$/i)?.[1];
    if (key && !numbered.has(key)) numbered.set(key, join(dir, f));
  }
  if (numbered.size) return [...numbered.values()];
  // Nothing follows the naming scheme: fall back to every other mp4, oldest first, so a hand-named clip still works.
  return files
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => a.t - b.t)
    .map((x) => join(dir, x.f));
}

// Pulls the spoken track out of a generated clip so Flow's voices can be used as narration.
export async function extractAudio(video: string, target: string): Promise<{ output: string; duration: number }> {
  await run(FFMPEG, ["-y", "-i", video, "-vn", "-af", "highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=5:release=120,loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-ac", "2", target]);
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", target]);
  return { output: target, duration: Number(stdout.trim()) };
}

const SAY = process.env.FLOW_MCP_SAY ?? "say";
// Linux ships no speech engine of its own, so there are two to look for: piper (neural, genuinely usable for
// narration, needs a .onnx voice downloaded once) and espeak-ng (in every distro's repo, tiny, robotic). piper wins
// when a voice model is there. Both are also available as `sudo apt install piper espeak-ng` on Debian, Ubuntu and Kali.
const ESPEAK = process.env.FLOW_MCP_ESPEAK ?? "espeak-ng";
const PIPER = process.env.FLOW_MCP_PIPER ?? "piper";
const PIPER_VOICES = process.env.FLOW_MCP_PIPER_VOICES ?? join(process.env.FLOW_MCP_HOME ?? join(homedir(), ".flow-mcp"), "voices");
const shortPath = (p: string) => (p.startsWith(homedir() + "/") ? "~" + p.slice(homedir().length) : p);
export const LINUX_VOICE_HINT =
  "espeak-ng is tiny but robotic (sudo apt install espeak-ng); piper sounds far better - pipx install piper-tts (NOT apt's `piper`, which is a gaming-mouse tool), then put a .onnx voice and its .onnx.json from huggingface.co/rhasspy/piper-voices in " +
  shortPath(PIPER_VOICES);

// Present counts as "runs without ENOENT": a program that answers --help with a non-zero exit is still installed
// (the same test captions.ts uses for whisper-cli).
const installedBin = (bin: string, args = ["--help"]) =>
  run(bin, args).then(
    () => true,
    (err: NodeJS.ErrnoException) => err.code !== "ENOENT",
  );

type LinuxEngine = { kind: "piper"; models: string[] } | { kind: "espeak" } | { kind: "none" };

// Debian, Ubuntu and Kali all ship a package called `piper` that is a GTK tool for configuring gaming mice, not the
// text-to-speech program (checked 2026-11-04: `piper --help` there prints GTK options). Spawning that instead of a
// voice would hang a narration on a window that never opens, so the name is never trusted: its --help has to look
// like the TTS. Checked once per process - the GUI is slow to start.
let piperIsTts: Promise<boolean> | undefined;
function piperSpeaks(): Promise<boolean> {
  piperIsTts ??= run(PIPER, ["--help"], { timeout: 8000 }).then(
    ({ stdout, stderr }) => {
      const help = `${stdout}${stderr}`.toLowerCase();
      return /gapplication|--help-gtk|gaming/.test(help) ? false : /--model|onnx|-m\s+file/.test(help);
    },
    (err: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
      if (err.code === "ENOENT") return false;
      const help = `${err.stdout ?? ""}${err.stderr ?? ""}`.toLowerCase();
      return /gapplication|--help-gtk|gaming/.test(help) ? false : /--model|onnx|-m\s+file/.test(help);
    },
  );
  return piperIsTts;
}

async function linuxEngine(): Promise<LinuxEngine> {
  const models = existsSync(PIPER_VOICES) ? readdirSync(PIPER_VOICES).filter((f) => f.endsWith(".onnx")).sort() : [];
  if (models.length && (await piperSpeaks())) return { kind: "piper", models };
  if (await installedBin(ESPEAK)) return { kind: "espeak" };
  return { kind: "none" };
}

// `espeak-ng --voices=en` prints a table: priority, language, age/gender, voice name, file. -v takes the LANGUAGE
// code (column 2), not the voice name: `-v English_(Received_Pronunciation)` answers "the specified espeak-ng voice
// does not exist" (checked on 1.52.0). Rows whose file sits under mb/ are MBROLA voices, which need voice data that
// is not installed with espeak-ng and fail at speaking time, so they are left out, as are variant rows (!v/). If the table cannot be read,
// en-us and en-gb are offered anyway: espeak-ng always ships both.
async function espeakVoices(): Promise<{ name: string; description: string }[]> {
  const { stdout } = await run(ESPEAK, ["--voices=en"]).catch(() => ({ stdout: "" }));
  const seen = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*\d+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/);
    // mb/ = MBROLA (voice data not installed, fails at speaking time); !v/ = a variant row ("variant Storm"), which
    // is a modifier like en-us+Storm, not a voice -v accepts on its own.
    if (!m || m[4].startsWith("mb/") || m[4].startsWith("!v/") || m[1] === "variant" || seen.has(m[1])) continue;
    seen.set(m[1], `${m[3].replace(/_/g, " ")} · espeak-ng, free`);
  }
  if (!seen.size) return [
    { name: "en-us", description: "en-us · espeak-ng, free" },
    { name: "en-gb", description: "en-gb · espeak-ng, free" },
  ];
  return [...seen].map(([name, description]) => ({ name, description }));
}

// piper takes the line on stdin, and promisify(execFile) cannot write stdin, so this one gets a spawn of its own.
function runPiper(model: string, text: string, wav: string): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(PIPER, ["-m", model, "-f", wav], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? ok() : fail(new Error(`piper exited ${code}: ${err.trim().split("\n").pop() ?? "no output"}`))));
    child.stdin.end(text, "utf8");
  });
}

// What the panel calls this computer's narration engine, so a Linux box never reads "macOS voice".
export async function localEngineLabel(): Promise<string> {
  if (IS_MAC) return "macOS voice";
  if (IS_WIN) return "Windows voice";
  const engine = await linuxEngine();
  return engine.kind === "piper" ? "piper voice" : engine.kind === "espeak" ? "espeak-ng voice" : "computer voice";
}

// The voices this computer has installed. On a Mac that is `say` (Premium voices appear as soon as the user downloads
// them in System Settings); on Windows it is the built-in speech engine, the voices under Settings > Time & language >
// Speech; on Linux it is whichever of piper or espeak-ng is installed, since the system has no voice of its own.
// The Windows branch is written to the documented System.Speech API but has not been run on a real PC yet.
export async function localVoices(): Promise<{ name: string; description: string }[]> {
  if (IS_WIN) {
    try {
      const out = powershell(
        "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }",
      );
      return out
        .split(/\r?\n/)
        .map((l) => l.trim().split("|"))
        .filter(([name, culture]) => name && /^en-/i.test(culture ?? ""))
        .map(([name, culture]) => ({ name, description: `${culture} · Windows, free` }));
    } catch {
      return [];
    }
  }
  if (IS_LINUX) {
    const engine = await linuxEngine();
    if (engine.kind === "piper") return engine.models.map((f) => ({ name: basename(f, ".onnx"), description: "piper, free" }));
    if (engine.kind === "espeak") return espeakVoices();
    return [];
  }
  const { stdout } = await run(SAY, ["-v", "?"], { maxBuffer: 4 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
  return stdout
    .split("\n")
    .map((line) => line.match(/^(.+?)\s{2,}(\w{2}_\w{2})\s+#\s*(.*)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m) && /^en_/.test(m![2]))
    .map((m) => ({ name: m[1].trim(), description: `${m[2].replace("_", "-")} · macOS, free` }))
    .filter((v) => !/^(Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Albert|Fred|Grandma|Grandpa|Junior|Kathy|Princess|Ralph|Rocko|Shelley|Sandy|Eddy|Flo|Reed|Rishi)/.test(v.name));
}

// Speaks a line with this computer's own voice: `say` on a Mac, System.Speech on Windows, piper or espeak-ng on
// Linux. Free and instant, but only as good as the installed voice. Every engine is normalised through the same
// ffmpeg pass below, so the output is the same shape whatever spoke it.
export async function speakLocally(text: string, voice: string, target: string): Promise<{ output: string; duration: number }> {
  const stem = target.replace(/\.\w+$/, "");
  const raw = stem + (IS_MAC ? ".aiff" : ".wav");
  if (IS_WIN) {
    // The line goes through a file, never the command line, so quotes or symbols in it cannot break the script.
    const lineFile = stem + ".line.txt";
    writeFileSync(lineFile, text, "utf8");
    try {
      powershell(
        `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice(${psQuote(voice)}); $s.SetOutputToWaveFile(${psQuote(raw)}); $s.Speak([System.IO.File]::ReadAllText(${psQuote(lineFile)}, [System.Text.Encoding]::UTF8)); $s.Dispose()`,
        300_000,
      );
    } finally {
      rmSync(lineFile, { force: true });
    }
  } else if (IS_LINUX) {
    const engine = await linuxEngine();
    if (engine.kind === "none") {
      throw new Error(
        `No speech engine is installed on this computer, so there is no voice to speak with. ${LINUX_VOICE_HINT}. ` +
          `Or use engine "gemini", which needs only a free Google AI Studio key.`,
      );
    }
    if (engine.kind === "piper") {
      const model = engine.models.find((f) => basename(f, ".onnx").toLowerCase() === voice.toLowerCase()) ?? engine.models[0];
      await runPiper(join(PIPER_VOICES, model), text, raw);
    } else {
      // The line goes through a file, as on Windows: a prompt that starts with a dash would otherwise look like a flag.
      const lineFile = stem + ".line.txt";
      writeFileSync(lineFile, text, "utf8");
      try {
        await run(ESPEAK, ["-v", voice, "-s", "168", "-w", raw, "-f", lineFile]).catch((err: Error) => {
          throw new Error(`espeak-ng could not speak with voice "${voice}": ${err.message.split("\n").pop()?.trim()}. Pick one of the voices flow_voices lists.`);
        });
      } finally {
        rmSync(lineFile, { force: true });
      }
    }
  } else {
    await run(SAY, ["-v", voice, "-r", "168", "-o", raw, text]);
  }
  await run(FFMPEG, ["-y", "-i", raw, "-af", "highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=5:release=120,loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-ac", "2", target]);
  rmSync(raw, { force: true });
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", target]);
  return { output: target, duration: Number(stdout.trim()) };
}

export interface VoiceLine {
  file: string;
  from?: number;
  to?: number;
  at: number;
  max_seconds?: number;
}

// Builds one voiceover track from separate lines, each cut from a take (audio or video, from..to), placed at its own
// moment in the film, and sped up slightly (at most 1.25x) when it would overrun max_seconds. Flow speaks a whole
// take at its own pace and cannot time a word to an on-screen title, so the timing is done here instead: 2026-10-12,
// a narration in the user's own Flow voice had to land each line on the kinetic text it describes.
export async function voiceTrack(lines: VoiceLine[], out: string): Promise<{ file: string; lines: { at: number; seconds: number; speed: number }[]; warnings: string[] }> {
  if (!lines.length) throw new Error("No voice lines given.");
  const work = mkdtempSync(join(tmpdir(), "flow-voice-"));
  try {
    // Pass 1: cut each line and trim the silence at both ends, so a line is only sped up when the SPEECH is too long.
    // On the first real run a cut kept 0.4 s of room tone after "Blender", was pushed to the 1.25x limit and still ran
    // into the next line.
    const quiet = (keep: number) => `silenceremove=start_periods=1:start_threshold=-42dB:start_silence=${keep}`;
    const cuts: { file: string; seconds: number }[] = [];
    for (const [i, l] of lines.entries()) {
      if (!existsSync(l.file)) throw new Error(`File not found: ${l.file}`);
      const from = Math.max(0, l.from ?? 0);
      const trim = `atrim=start=${from.toFixed(3)}${l.to !== undefined ? `:end=${l.to.toFixed(3)}` : ""}`;
      const cut = join(work, `line-${i + 1}.wav`);
      await run(FFMPEG, ["-v", "error", "-y", "-i", l.file, "-vn", "-af", `${trim},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,${quiet(0.04)},areverse,${quiet(0.08)},areverse`, "-c:a", "pcm_s16le", cut]).catch(
        (err: NodeJS.ErrnoException & { stderr?: string }) => {
          throw new Error(err.code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT}).` : `Could not cut voice line ${i + 1}: ${(err.stderr ?? String(err)).slice(-300)}`);
        },
      );
      const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", cut]);
      const seconds = Number(stdout.trim());
      if (!(seconds > 0.05)) throw new Error(`Voice line ${i + 1} has no speech in it (from ${from}${l.to !== undefined ? ` to ${l.to}` : ""}).`);
      cuts.push({ file: cut, seconds });
    }
    // Pass 2: speed each line to its slot only if it must, level it, and place it.
    const args: string[] = ["-y"];
    const filters: string[] = [];
    const placed: { at: number; seconds: number; speed: number }[] = [];
    for (const [i, l] of lines.entries()) {
      const speed = l.max_seconds && cuts[i].seconds > l.max_seconds ? Math.min(1.25, cuts[i].seconds / l.max_seconds) : 1;
      const seconds = cuts[i].seconds / speed;
      const delay = Math.round(Math.max(0, l.at) * 1000);
      args.push("-i", cuts[i].file);
      // Each line is levelled on its own: separate takes come back at different loudness.
      filters.push(
        `[${i}:a]${speed > 1.001 ? `atempo=${speed.toFixed(3)},` : ""}loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000` +
          `,afade=t=in:d=0.02,afade=t=out:st=${Math.max(0, seconds - 0.04).toFixed(3)}:d=0.04,adelay=${delay}|${delay}[l${i}]`,
      );
      placed.push({ at: l.at, seconds: Number(seconds.toFixed(2)), speed: Number(speed.toFixed(3)) });
    }
    const warnings: string[] = [];
    placed.forEach((p, i) => {
      const next = placed[i + 1];
      if (next && p.at + p.seconds > next.at + 0.02) warnings.push(`Line ${i + 1} runs ${(p.at + p.seconds - next.at).toFixed(2)} s into line ${i + 2}.`);
      if (lines[i].max_seconds && p.seconds > lines[i].max_seconds! + 0.02) warnings.push(`Line ${i + 1} still needs ${p.seconds} s after speeding up as far as sounds natural (1.25x).`);
    });
    filters.push(lines.length > 1 ? `${lines.map((_, i) => `[l${i}]`).join("")}amix=inputs=${lines.length}:duration=longest:dropout_transition=0:normalize=0[a]` : "[l0]anull[a]");
    // Plain PCM: an AAC .m4a written from delayed, mixed lines came out unreadable ("Cannot calculate dts entry length"),
    // and this file is only a step on the way to the film.
    args.push("-filter_complex", filters.join(";"), "-map", "[a]", "-c:a", "pcm_s16le", out);
    try {
      await run(FFMPEG, args, { maxBuffer: 32 * 1024 * 1024 });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      throw new Error(e.code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT}).` : `ffmpeg could not build the voice track: ${(e.stderr ?? String(e)).slice(-400)}`);
    }
    return { file: out, lines: placed, warnings };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Joins the scene clips into one film, keeping their own sound and laying music / voiceover on top.
export async function assemble(o: AssembleOptions): Promise<{ output: string; clips: string[]; duration: number; held_last_frame: number }> {
  // Clips can now come from anywhere, so the project folder the film is saved into may not exist yet.
  if (o.clips?.length) mkdirSync(o.dir, { recursive: true });
  const out = join(o.dir, o.output_name.replace(/[^\w.-]+/g, "_").replace(/(\.mp4)?$/, ".mp4"));
  const clips = (o.clips?.length ? o.clips : defaultClips(o.dir)).filter((c) => c !== out);
  if (!clips.length) throw new Error(`No clips found in ${o.dir}. Generate or download a clip first, or pass clips explicitly.`);
  for (const f of [...clips, o.music, o.voiceover]) if (f && !existsSync(f)) throw new Error(`File not found: ${f}`);

  let infos = await Promise.all(clips.map(probe));
  // A narration longer than the footage would be cut off, so the last frame is held until the voice finishes.
  let hold = 0;
  if (o.hold_last_frame !== false && o.voiceover) {
    const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", o.voiceover]);
    hold = Math.max(0, Number(stdout.trim()) + 0.6 - infos.reduce((sum, i) => sum + i.duration, 0));
  }
  // Size the film to the biggest clip so a 720p opener cannot pull a 1080p clip down with it.
  const { width, height } = infos.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  const args: string[] = ["-y"];
  for (const clip of clips) args.push("-i", clip);
  const filters: string[] = [];
  // The clips' own sound used to play at full volume no matter what, drowning a narration laid on top. Music already
  // had its own level; the clips now do too.
  const clipVolume = Math.min(1, Math.max(0, o.clip_volume ?? 1));
  infos.forEach((info, i) => {
    const freeze = hold > 0.05 && i === infos.length - 1 ? `,tpad=stop_mode=clone:stop_duration=${hold.toFixed(2)}` : "";
    filters.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24${freeze}[v${i}]`,
    );
    filters.push(
      info.hasAudio
        ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${clipVolume}${hold > 0.05 && i === infos.length - 1 ? `,apad=pad_dur=${hold.toFixed(2)}` : ""}[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${(info.duration + (i === infos.length - 1 ? hold : 0)).toFixed(2)}[a${i}]`,
    );
  });
  filters.push(`${infos.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${clips.length}:v=1:a=1[v][clipaudio]`);

  const mix = ["[clipaudio]"];
  let input = clips.length;
  if (o.music) {
    args.push("-stream_loop", "-1", "-i", o.music);
    filters.push(`[${input}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${o.music_volume}[music]`);
    mix.push("[music]");
    input++;
  }
  if (o.voiceover) {
    args.push("-i", o.voiceover);
    filters.push(`[${input}:a]aresample=48000,aformat=channel_layouts=stereo[vo]`);
    mix.push("[vo]");
  }
  filters.push(mix.length > 1 ? `${mix.join("")}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0[a]` : "[clipaudio]anull[a]");

  const output = out;
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
    output,
  );
  try {
    await run(FFMPEG, args, { maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    throw new Error(e.code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT}).` : `ffmpeg failed: ${(e.stderr ?? String(e)).slice(-600)}`);
  }
  return { output, clips, duration: infos.reduce((sum, i) => sum + i.duration, 0) + hold, held_last_frame: Number(hold.toFixed(2)) };
}

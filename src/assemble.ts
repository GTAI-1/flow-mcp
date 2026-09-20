import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLOW_MCP_FFPROBE ?? "ffprobe";

export interface AssembleOptions {
  dir: string;
  clips?: string[];
  music?: string;
  music_volume: number;
  voiceover?: string;
  output_name: string;
}

interface ClipInfo {
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
}

async function probe(file: string): Promise<ClipInfo> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", file]);
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

// Scene clips are scene-NN.mp4 or scene-NN-vK.mp4; with several variants the first one is used.
function defaultClips(dir: string): string[] {
  const byScene = new Map<string, string>();
  for (const f of readdirSync(dir).sort()) {
    const scene = f.match(/^(scene-\d+)(-v\d+)?\.mp4$/)?.[1];
    if (scene && !byScene.has(scene)) byScene.set(scene, join(dir, f));
  }
  return [...byScene.values()];
}

// Joins the scene clips into one film, keeping their own sound and laying music / voiceover on top.
export async function assemble(o: AssembleOptions): Promise<{ output: string; clips: string[]; duration: number }> {
  const clips = o.clips?.length ? o.clips : defaultClips(o.dir);
  if (!clips.length) throw new Error(`No scene clips found in ${o.dir}. Pass clips explicitly or generate scenes first.`);
  for (const f of [...clips, o.music, o.voiceover]) if (f && !existsSync(f)) throw new Error(`File not found: ${f}`);

  const infos = await Promise.all(clips.map(probe));
  // Size the film to the biggest clip so a 720p opener cannot pull a 1080p clip down with it.
  const { width, height } = infos.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  const args: string[] = ["-y"];
  for (const clip of clips) args.push("-i", clip);
  const filters: string[] = [];
  infos.forEach((info, i) => {
    filters.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v${i}]`,
    );
    filters.push(
      info.hasAudio
        ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${info.duration}[a${i}]`,
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

  const output = join(o.dir, o.output_name.replace(/[^\w.-]+/g, "_").replace(/(\.mp4)?$/, ".mp4"));
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
    throw new Error(e.code === "ENOENT" ? "ffmpeg is not installed (brew install ffmpeg)." : `ffmpeg failed: ${(e.stderr ?? String(e)).slice(-600)}`);
  }
  return { output, clips, duration: infos.reduce((sum, i) => sum + i.duration, 0) };
}

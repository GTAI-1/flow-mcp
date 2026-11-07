import { execFile } from "node:child_process";
import { FFMPEG_HINT } from "./platform.js";
import { promisify } from "node:util";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";

// Saves the final frame of a clip so the next scene can start exactly where this one ended.
export async function extractLastFrame(video: string): Promise<string> {
  const out = video.replace(/\.\w+$/, "") + "-lastframe.jpg";
  try {
    await run(FFMPEG, ["-y", "-sseof", "-0.2", "-i", video, "-update", "1", "-q:v", "2", out]);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT})` : String(err);
    throw new Error(`chain_previous needs ffmpeg to grab the previous clip's last frame: ${reason}`);
  }
  return out;
}

// Saves the first frame of a clip, so a new clip can be made to end exactly where that one begins (redoing a middle
// clip with both of its cuts kept invisible).
export async function extractFirstFrame(video: string): Promise<string> {
  const out = video.replace(/\.\w+$/, "") + "-firstframe.jpg";
  try {
    await run(FFMPEG, ["-y", "-i", video, "-frames:v", "1", "-q:v", "2", out]);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT})` : String(err);
    throw new Error(`last_frame needs ffmpeg to grab that clip's first frame: ${reason}`);
  }
  return out;
}

// Saves the frame at a chosen second of a clip - where the speech ends, say - so the next clip can start from there
// instead of from dead time at the end. flow_assemble's `trims` then cuts the earlier clip at the same second.
export async function extractFrameAt(video: string, seconds: number): Promise<string> {
  const out = `${video.replace(/\.\w+$/, "")}-frame-${seconds.toFixed(2)}s.jpg`;
  try {
    await run(FFMPEG, ["-y", "-ss", seconds.toFixed(3), "-i", video, "-frames:v", "1", "-q:v", "2", out]);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT})` : String(err);
    throw new Error(`first_frame_at needs ffmpeg to grab that frame: ${reason}`);
  }
  return out;
}

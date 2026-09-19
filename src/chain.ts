import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";

// Saves the final frame of a clip so the next scene can start exactly where this one ended.
export async function extractLastFrame(video: string): Promise<string> {
  const out = video.replace(/\.\w+$/, "") + "-lastframe.jpg";
  try {
    await run(FFMPEG, ["-y", "-sseof", "-0.2", "-i", video, "-update", "1", "-q:v", "2", out]);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? "ffmpeg is not installed (brew install ffmpeg)" : String(err);
    throw new Error(`chain_previous needs ffmpeg to grab the previous clip's last frame: ${reason}`);
  }
  return out;
}

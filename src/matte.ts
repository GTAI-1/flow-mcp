import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { FFMPEG_HINT } from "./platform.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLOW_MCP_FFPROBE ?? "ffprobe";

// Difference matting: the same picture drawn once on white and once on black. A fully opaque pixel looks the same on
// both, a fully clear one is exactly the background on each, and anything in between (hair, glass, soft shadows) sits
// partway. Per channel: onWhite - onBlack = (1 - alpha) * (white - black), so alpha falls straight out of the
// difference and the true colour out of either take.
//
// The image model never paints a perfect #FFFFFF / #000000 and saves as JPEG, so the real background levels are
// measured from the picture's border and small differences near 0 or 1 are treated as compression noise.
const NOISE = 0.04;
const MAX_PIXELS = 4096 * 4096;

async function size(file: string): Promise<{ width: number; height: number }> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]).catch(
    (err: NodeJS.ErrnoException) => {
      throw new Error(err.code === "ENOENT" ? `Cutouts need ffmpeg (${FFMPEG_HINT}).` : `Could not read the image ${file}.`);
    },
  );
  const [width, height] = stdout.trim().split(",").map(Number);
  if (!width || !height) throw new Error(`Could not read the size of ${file}.`);
  return { width, height };
}

// Both takes are decoded at the white take's size, so a model that hands back a slightly different resolution
// still lines up pixel for pixel.
async function pixels(file: string, width: number, height: number): Promise<Buffer> {
  const { stdout } = await run(
    FFMPEG,
    ["-v", "error", "-i", file, "-vf", `scale=${width}:${height}:flags=lanczos`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { encoding: "buffer", maxBuffer: MAX_PIXELS * 3 + 1024 },
  );
  if (stdout.length !== width * height * 3) throw new Error(`Could not decode ${file}.`);
  return stdout;
}

function writePng(rgba: Buffer, width: number, height: number, out: string): Promise<void> {
  return new Promise((ok, fail) => {
    const ff = spawn(FFMPEG, ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-i", "pipe:0", "-frames:v", "1", "-pix_fmt", "rgba", out]);
    let err = "";
    ff.stderr.on("data", (d: Buffer) => (err += d));
    ff.on("error", fail);
    ff.on("close", (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg could not write ${out}: ${err.trim()}`))));
    ff.stdin.end(rgba);
  });
}

// Median of each channel over a thin ring along the edges: mostly background even when the subject touches a side.
function borderColour(px: Buffer, width: number, height: number): [number, number, number] {
  const ring = Math.max(2, Math.round(Math.min(width, height) * 0.02));
  const ch: number[][] = [[], [], []];
  const take = (x: number, y: number) => {
    const o = (y * width + x) * 3;
    for (let c = 0; c < 3; c++) ch[c].push(px[o + c]);
  };
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (x < ring || y < ring || x >= width - ring || y >= height - ring) take(x, y);
    }
  }
  return ch.map((v) => v.sort((a, b) => a - b)[v.length >> 1]) as [number, number, number];
}

export interface MatteResult {
  file: string;
  width: number;
  height: number;
  background_white: string;
  background_black: string;
  opaque_share: number;
  clear_share: number;
  // Share of the subject where the black take is BRIGHTER than the white one. That cannot happen with a real
  // background swap, so it measures how much the model changed the subject itself between the two takes.
  mismatch_share: number;
  warning?: string;
}

const hex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

export async function differenceMatte(onWhite: string, onBlack: string, out: string): Promise<MatteResult> {
  const { width, height } = await size(onWhite);
  if (width * height > MAX_PIXELS) throw new Error(`${width}x${height} is too large for a cutout.`);
  const [w, b] = await Promise.all([pixels(onWhite, width, height), pixels(onBlack, width, height)]);

  const bgW = borderColour(w, width, height);
  const bgB = borderColour(b, width, height);
  const span = bgW.map((v, c) => v - bgB[c]);
  if (Math.min(...bgW) < 170 || Math.max(...bgB) > 85 || Math.min(...span) < 120) {
    throw new Error(
      `The backgrounds did not come out white and black (measured ${hex(bgW)} and ${hex(bgB)}), so there is nothing to tell the subject apart by. Try again with a simpler subject or a plainer prompt.`,
    );
  }

  const rgba = Buffer.alloc(width * height * 4);
  let opaque = 0;
  let clear = 0;
  let subject = 0;
  let mismatch = 0;
  for (let i = 0, p = 0, q = 0; i < width * height; i++, p += 3, q += 4) {
    let sum = 0;
    let brighterOnBlack = false;
    for (let c = 0; c < 3; c++) {
      const d = w[p + c] - b[p + c];
      sum += 1 - d / span[c];
      if (d < -24) brighterOnBlack = true;
    }
    let a = (sum / 3 - NOISE) / (1 - 2 * NOISE);
    a = a <= 0 ? 0 : a >= 1 ? 1 : a;
    if (a > 0.05) {
      subject++;
      if (brighterOnBlack) mismatch++;
    }
    if (a === 1) opaque++;
    else if (a === 0) clear++;

    if (a > 0) {
      // Un-premultiply from both takes and average them: each one alone carries its own JPEG noise.
      for (let c = 0; c < 3; c++) {
        const fromBlack = (b[p + c] - (1 - a) * bgB[c]) / a;
        const fromWhite = (w[p + c] - (1 - a) * bgW[c]) / a;
        const v = Math.round((fromBlack + fromWhite) / 2);
        rgba[q + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    rgba[q + 3] = Math.round(a * 255);
  }
  await writePng(rgba, width, height, out);

  const total = width * height;
  const mismatch_share = subject ? mismatch / subject : 0;
  const round = (n: number) => Number(n.toFixed(3));
  const warning =
    subject / total < 0.005
      ? "Almost nothing was kept: the two takes look the same as their backgrounds, so the subject may have been lost."
      : mismatch_share > 0.03
        ? `The model changed the subject between the white and black takes (${(mismatch_share * 100).toFixed(1)}% of it), so edges or patches may be see-through. Try again, or ask for a simpler subject.`
        : undefined;
  return {
    file: out,
    width,
    height,
    background_white: hex(bgW),
    background_black: hex(bgB),
    opaque_share: round(opaque / total),
    clear_share: round(clear / total),
    mismatch_share: round(mismatch_share),
    ...(warning ? { warning } : {}),
  };
}

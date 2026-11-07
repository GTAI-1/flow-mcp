import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { renderEndCard } from "./captions.js";
import { FFMPEG_HINT } from "./platform.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLOW_MCP_FFPROBE ?? "ffprobe";

export interface AssembleOptions {
  dir: string;
  clips?: string[];
  music?: string;
  music_volume: number;
  clip_volume?: number;
  // Music volume over time, on top of music_volume: {at: seconds in the film, volume: 0-2}, straight lines between points.
  music_curve?: { at: number; volume: number }[];
  // Pull the music down automatically while the voiceover speaks, and let it back up in the gaps.
  duck_music?: boolean;
  voiceover?: string;
  output_name: string;
  hold_last_frame?: boolean;
  // One entry per clip, in play order: seconds to keep from each clip (null or missing keeps it whole).
  trims?: ({ from?: number; to?: number; volume?: number; fade_in?: number; fade_out?: number; soften_in?: number; saturation?: number; crop?: { x?: number; y?: number; w: number; h?: number } } | null)[];
  // Words for a closing card over the film's blurred last frame.
  end_card?: { text: string; seconds?: number };
  // Cutaways laid over part of a clip; the covered clip's own sound carries on underneath.
  inserts?: { clip: string; over: number; at: number; seconds?: number; from?: number; volume?: number; crop?: { x?: number; y?: number; w: number; h?: number } }[];
  // Target loudness of the finished film in LUFS; Flow's takes come out near -24, social video sits around -14.
  loudness?: number;
  // Paint out the generator's corner mark (Vids'/Flow's sparkle), found automatically from where it never moves.
  remove_watermark?: boolean;
  // A long Extend chain redraws the mark each hop, until it has a thick outline and a fatter diamond shape that the normal
  // star mask misses (The Last Delivery, 2026-11-01: an outline stayed at 72 and 88 s). Pixels added around a diamond mask.
  watermark_margin?: number;
  // Hold the last frame this long at the end, fading to black over its last `fade` seconds.
  end_hold?: { seconds: number; fade?: number };
  size?: string;
}

interface ClipInfo {
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
}

type Crop = { x?: number; y?: number; w: number; h?: number };
function cropFilter(c: Crop | undefined): { crop: string; cw: number; ch: number } {
  if (!c) return { crop: "", cw: 1, ch: 1 };
  const cw = Math.min(1, Math.max(0.1, c.w));
  const ch = Math.min(1, Math.max(0.1, c.h ?? c.w));
  const x = Math.min(1 - cw, Math.max(0, c.x ?? (1 - cw) / 2));
  const y = Math.min(1 - ch, Math.max(0, c.y ?? (1 - ch) / 2));
  return { crop: `crop=iw*${cw.toFixed(4)}:ih*${ch.toFixed(4)}:iw*${x.toFixed(4)}:ih*${y.toFixed(4)},`, cw, ch };
}

// Fine detail in one frame (variance of a Laplacian over a 480x270 grey copy). Comparable between clips, not absolute.
async function sharpness(file: string, at: number, sigma = 0): Promise<number> {
  const { stdout } = await run(FFMPEG, [
    "-v", "error", "-ss", Math.max(0, at).toFixed(3), "-i", file, "-frames:v", "1",
    "-vf", `${sigma > 0 ? `gblur=sigma=${sigma.toFixed(2)},` : ""}scale=480:270,format=gray`, "-f", "rawvideo", "-",
  ], { encoding: "buffer", maxBuffer: 1 << 22 });
  const g = stdout as unknown as Buffer;
  const w = 480, h = 270;
  let sum = 0, sq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
    sum += l; sq += l * l; n++;
  }
  return n ? sq / n - (sum / n) ** 2 : 0;
}

// A clip that continues another from its last frame often starts much SHARPER than that clip ends (Vids/Omni clips
// soften over their 10 s; a continuation is drawn from a crisp still), so the join pops even though the picture is the
// same (Three Tiers, 2026-10-31: 190 -> 330, the user saw "a skip frame"). soften_in starts the clip blurred to the
// previous clip's sharpness and lets it sharpen over that many seconds. Returns the blur to start from (0 = none).
async function matchSoftness(prev: string, prevEnd: number, clip: string, from: number): Promise<number> {
  const target = await sharpness(prev, prevEnd - 0.05);
  if ((await sharpness(clip, from)) < target * 1.15) return 0;
  let best = 0, gap = Infinity;
  for (const sigma of [0.3, 0.45, 0.6, 0.8, 1.0, 1.3, 1.7, 2.2]) {
    const d = Math.abs((await sharpness(clip, from, sigma)) - target);
    if (d < gap) { gap = d; best = sigma; }
  }
  return best;
}

// The mark Google's video models put in the bottom-right corner (a four-point sparkle, 71 px at 1080p) sits in the
// same place in every frame while the picture moves under it. Sample frames from every clip at the film's size, keep
// each pixel's darkest value (a low percentile, so a clip without the mark cannot erase it), and the mark is what stays
// brighter than its surroundings. It is masked as a filled four-point star (its centre is see-through and barely
// differs from the background) and painted out with removelogo, which fills it from the pixels around it.
export async function watermarkMask(samples: { file: string; at: number; vf: string }[], width: number, height: number, out: string, margin = 0): Promise<{ cx: number; cy: number; r: number } | null> {
  const x0 = Math.floor(width * 0.7), y0 = Math.floor(height * 0.65);
  const w = width - x0, h = height - y0;
  const frames: Buffer[] = [];
  for (const sm of samples) {
    const { stdout } = await run(FFMPEG, [
      "-v", "error", "-ss", Math.max(0, sm.at).toFixed(3), "-i", sm.file, "-frames:v", "1",
      "-vf", `${sm.vf},crop=${w}:${h}:${x0}:${y0},format=gray`, "-f", "rawvideo", "-",
    ], { encoding: "buffer", maxBuffer: 1 << 24 }).catch(() => ({ stdout: Buffer.alloc(0) }));
    const b = stdout as unknown as Buffer;
    if (b.length === w * h) frames.push(b);
  }
  if (frames.length < 8) return null;
  const k = Math.floor(frames.length * 0.05);
  const low = new Float64Array(w * h);
  const col = new Array<number>(frames.length);
  for (let i = 0; i < w * h; i++) {
    for (let f = 0; f < frames.length; f++) col[f] = frames[f][i];
    col.sort((p, q) => p - q);
    low[i] = col[k];
  }
  // Brighter than the local average of that darkest-value picture by a clear margin.
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sat[(y + 1) * (w + 1) + x + 1] = low[y * w + x] + sat[y * (w + 1) + x + 1] + sat[(y + 1) * (w + 1) + x] - sat[y * (w + 1) + x];
  const box = (x: number, y: number, r: number) => {
    const a = Math.max(0, x - r), b = Math.max(0, y - r), c = Math.min(w, x + r + 1), d = Math.min(h, y + r + 1);
    return (sat[d * (w + 1) + c] - sat[b * (w + 1) + c] - sat[d * (w + 1) + a] + sat[b * (w + 1) + a]) / ((c - a) * (d - b));
  };
  // Other bright, steady things in the corner (a white wall that several clips share) pass too, so the mark is taken
  // as the densest cluster: the window of about its size holding the most such pixels.
  const hit = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (low[y * w + x] - box(x, y, 15) > 45) hit[y * w + x] = 1;
  // By the SHORT side: on a vertical film height / 1080 made the window 178 px, spurious bright points widened the box,
  // and part of the mark stayed behind.
  const scale = Math.min(width, height) / 1080;
  const win = Math.round(100 * scale);
  const hs = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) hs[(y + 1) * (w + 1) + x + 1] = hit[y * w + x] + hs[y * (w + 1) + x + 1] + hs[(y + 1) * (w + 1) + x] - hs[y * (w + 1) + x];
  let best = 0, bx = 0, by = 0;
  for (let y = 0; y + win <= h; y += 2) for (let x = 0; x + win <= w; x += 2) {
    const c = hs[(y + win) * (w + 1) + x + win] - hs[y * (w + 1) + x + win] - hs[(y + win) * (w + 1) + x] + hs[y * (w + 1) + x];
    if (c > best) { best = c; bx = x; by = y; }
  }
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = by; y < by + win; y++) for (let x = bx; x < bx + win; x++) {
    if (hit[y * w + x]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  if (process.env.FLOW_MCP_DEBUG) console.error("watermark", { frames: frames.length, best, box: [x0 + minX, x0 + maxX, y0 + minY, y0 + maxY] });
  if (best < 30 * scale * scale || maxX < 0 || bw < 20 * scale || bw > 160 * scale || Math.abs(bw - bh) > 0.3 * Math.max(bw, bh)) return null;
  const cx = x0 + (minX + maxX) / 2, cy = y0 + (minY + maxY) / 2, r = Math.max(bw, bh) / 2 + 3 + 3 * scale + margin * scale;
  const mask = Buffer.alloc(width * height);
  for (let y = Math.floor(cy - r - 2); y <= Math.ceil(cy + r + 2); y++) for (let x = Math.floor(cx - r - 2); x <= Math.ceil(cx + r + 2); x++) {
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    // A slightly fattened astroid (|x|^2/3 + |y|^2/3 <= 1): the sparkle's shape with its concave sides.
    const ax = Math.abs(x - cx) / r, ay = Math.abs(y - cy) / r;
    if (margin > 0 ? ax + ay <= 1 : Math.cbrt(ax * ax) + Math.cbrt(ay * ay) <= 1.15) mask[y * width + x] = 255;
  }
  writeFileSync(out, Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), mask]));
  return { cx, cy, r };
}

// A clip animated from the last frame of the one before can carry a SECOND, drifting copy of the mark for a moment
// (Last Train, 2026-11-06: beside the real one at 12.0-12.5 s and 20.0 s, up to 60 px to its right), which the fixed
// mask misses while the note says "painted out". After painting, the mark's own band is scanned every frame for
// anything still much brighter than its surroundings, and only those moments get the mark-shaped fill over the leftover.
// Floor reflections sit below the band, so they are not mistaken for marks.
async function ghostMarks(file: string, width: number, height: number, mark: { cx: number; cy: number; r: number }): Promise<{ at: number; to: number; x: number; y: number }[]> {
  const scale = Math.min(width, height) / 1080;
  const pad = Math.round(90 * scale);
  const x0 = Math.max(0, Math.round(mark.cx - mark.r - pad)), x1 = Math.min(width, Math.round(mark.cx + mark.r + pad));
  const y0 = Math.max(0, Math.round(mark.cy - mark.r)), y1 = Math.min(height, Math.round(mark.cy + mark.r));
  const w = x1 - x0, h = y1 - y0, fps = 24;
  const { stdout } = await run(FFMPEG, ["-v", "error", "-i", file, "-vf", `fps=${fps},crop=${w}:${h}:${x0}:${y0},format=gray`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 30 })
    .catch(() => ({ stdout: Buffer.alloc(0) }));
  const all = stdout as unknown as Buffer;
  const n = Math.floor(all.length / (w * h));
  const r = Math.round(15 * scale);
  const hits: { t: number; x: number; y: number }[] = [];
  for (let f = 0; f < n; f++) {
    const fr = all.subarray(f * w * h, (f + 1) * w * h);
    const sat = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sat[(y + 1) * (w + 1) + x + 1] = fr[y * w + x] + sat[y * (w + 1) + x + 1] + sat[(y + 1) * (w + 1) + x] - sat[y * (w + 1) + x];
    let count = 0, sx = 0, sy = 0, minX = w, maxX = -1, minY = h, maxY = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - r), b = Math.max(0, y - r), c = Math.min(w, x + r + 1), d = Math.min(h, y + r + 1);
      const mean = (sat[d * (w + 1) + c] - sat[b * (w + 1) + c] - sat[d * (w + 1) + a] + sat[b * (w + 1) + a]) / ((c - a) * (d - b));
      if (fr[y * w + x] - mean > 38) { count++; sx += x; sy += y; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    // Only something shaped like the mark counts: about square and about its size. A lamp's reflection on wet ground is
    // a long thin streak and passes the brightness test (Last Train, 0.5 s).
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const markLike = bw >= mark.r * 0.8 && bh >= mark.r * 0.8 && bw <= mark.r * 3.2 && Math.abs(bw - bh) <= 0.5 * Math.max(bw, bh);
    // A copy sits level with the real mark; reflections lie lower, at the band's bottom edge.
    const level = Math.abs(y0 + sy / Math.max(1, count) - mark.cy) < mark.r * 0.5;
    if (count > 150 * scale * scale && markLike && level) hits.push({ t: f / fps, x: x0 + sx / count, y: y0 + sy / count });
  }
  // The copy drifts while it shows (12.0-12.8 s moved it about 40 px), so a span only lasts while it stays within a few
  // pixels, and each is painted where it averages.
  const near = 8 * scale;
  const spans: { at: number; to: number; x: number; y: number; n: number }[] = [];
  for (const h2 of hits) {
    const last = spans.at(-1);
    if (last && h2.t - last.to <= 0.3 && Math.hypot(h2.x - last.x / last.n, h2.y - last.y / last.n) < near) {
      last.to = h2.t; last.x += h2.x; last.y += h2.y; last.n++;
      continue;
    }
    spans.push({ at: h2.t, to: h2.t, x: h2.x, y: h2.y, n: 1 });
  }
  return spans.map((sp) => ({ at: Math.max(0, sp.at - 0.07), to: sp.to + 1 / fps + 0.07, x: sp.x / sp.n, y: sp.y / sp.n }));
}

async function probe(file: string): Promise<ClipInfo> {
  // A raw ffprobe dump ("moov atom not found") told the user nothing. Say which file and what to do about it.
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,width,height,duration:format=duration", "-of", "json", file]).catch(() => {
    throw new Error(`"${basename(file)}" isn't a playable video - it may be an unfinished download or a ZIP of several clips. Remove it, or pick other clips.`);
  });
  const data = JSON.parse(stdout) as { streams: { codec_type: string; width?: number; height?: number; duration?: string }[]; format: { duration: string } };
  const video = data.streams.find((s) => s.codec_type === "video");
  if (!video?.width || !video.height) throw new Error(`${file} has no video stream.`);
  // A clip lasts as long as its PICTURE. AI clips carry 0.03-0.05 s more sound than picture, and the file's duration is
  // the longer of the two, so each join padded the picture with repeated frames: a visible hitch at every cut.
  const picture = Number(video.duration);
  return {
    width: video.width,
    height: video.height,
    duration: picture > 0 ? picture : Number(data.format.duration),
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

// A music level that changes over the film, as one ffmpeg volume expression of straight lines between the given points.
function musicCurve(points?: { at: number; volume: number }[]): string {
  if (!points?.length) return "";
  const p = [...points].sort((a, b) => a.at - b.at);
  let expr = p[p.length - 1].volume.toFixed(3);
  for (let i = p.length - 2; i >= 0; i--) {
    const [a, b] = [p[i], p[i + 1]];
    const line = `${a.volume.toFixed(3)}+(${(b.volume - a.volume).toFixed(3)})*(t-${a.at.toFixed(3)})/${Math.max(0.001, b.at - a.at).toFixed(3)}`;
    expr = `if(lt(t,${b.at.toFixed(3)}),${line},${expr})`;
  }
  return `,volume='if(lt(t,${p[0].at.toFixed(3)}),${p[0].volume.toFixed(3)},${expr})':eval=frame`;
}

// Joins the scene clips into one film, keeping their own sound and laying music / voiceover on top.
export async function assemble(o: AssembleOptions): Promise<{ output: string; clips: string[]; duration: number; held_last_frame: number; loudness?: number }> {
  // Clips can now come from anywhere, so the project folder the film is saved into may not exist yet.
  if (o.clips?.length) mkdirSync(o.dir, { recursive: true });
  const out = join(o.dir, o.output_name.replace(/[^\w.-]+/g, "_").replace(/(\.mp4)?$/, ".mp4"));
  const clips = (o.clips?.length ? o.clips : defaultClips(o.dir)).filter((c) => c !== out);
  if (!clips.length) throw new Error(`No clips found in ${o.dir}. Generate or download a clip first, or pass clips explicitly.`);
  for (const f of [...clips, o.music, o.voiceover, ...(o.inserts ?? []).map((x) => x.clip)]) if (f && !existsSync(f)) throw new Error(`File not found: ${f}`);

  // Trimming lives here, so a dead second at the start of a take or an awkward pause at its end never needs a
  // separate editor. The window is clamped to the clip, so a slightly long "to" is harmless.
  let infos = await Promise.all(clips.map(probe));
  const windows = clips.map((_, i) => {
    const t = o.trims?.[i];
    const from = Math.min(Math.max(0, t?.from ?? 0), Math.max(0, infos[i].duration - 0.2));
    const to = Math.min(infos[i].duration, Math.max(from + 0.2, t?.to ?? infos[i].duration));
    const trimmed = from > 0.01 || to < infos[i].duration - 0.01;
    // A take's background noise can sit several dB above the clip before it, so the room "jumps" at the cut: volume
    // levels it, and fades ease it in. Trimmed edges always get a 15 ms fade so a cut never clicks.
    const fade = (s: number | undefined, cut: boolean) => Math.min(2, Math.max(cut ? 0.015 : 0, s ?? 0));
    // A crop is a punch-in on part of the frame, in fractions of its width and height (h defaults to w, which keeps the
    // shape): it hides something the model put at an edge, like a phone on a stand in the corner of a take.
    const { crop, cw, ch } = cropFilter(t?.crop);
    return {
      from, to, trimmed, crop, cw, ch,
      volume: Math.min(2, Math.max(0, t?.volume ?? 1)),
      fadeIn: fade(t?.fade_in, from > 0.01), fadeOut: fade(t?.fade_out, to < infos[i].duration - 0.01),
      soften: Math.min(3, Math.max(0, t?.soften_in ?? 0)),
      // A clip animated from the one before's last frame starts on the same picture but can come back paler (Last Train,
      // 2026-11-06: colour 6.8 -> 5.7, so the join showed): saturation scales its colour to match its neighbours.
      saturation: Math.min(2, Math.max(0.5, t?.saturation ?? 1)),
    };
  });
  // A cropped clip is only as big as what is kept, so a vertical picture cut out of a 16:9 export sizes the film as
  // vertical, not as the landscape canvas it came in.
  infos = infos.map((info, i) => ({
    ...info,
    duration: windows[i].to - windows[i].from,
    width: Math.round(info.width * windows[i].cw),
    height: Math.round(info.height * windows[i].ch),
  }));
  // A cutaway is placed in the covered clip's own kept time and clamped to it, so it can never run into the next clip.
  const userClips = clips.length;
  const inserts = await Promise.all(
    (o.inserts ?? []).map(async (x) => {
      if (x.over < 1 || x.over > userClips) throw new Error(`Insert "${basename(x.clip)}" covers clip ${x.over}, but the film has ${userClips} clip(s).`);
      const k = x.over - 1;
      const info = await probe(x.clip);
      const from = Math.min(Math.max(0, x.from ?? 0), Math.max(0, info.duration - 0.2));
      const at = Math.min(Math.max(0, x.at), Math.max(0, infos[k].duration - 0.2));
      const seconds = Math.min(x.seconds ?? Infinity, info.duration - from, infos[k].duration - at);
      return { k, file: x.clip, from, at, seconds, volume: x.volume ?? 0.3, hasAudio: info.hasAudio, crop: cropFilter(x.crop).crop };
    }),
  );
  if (o.end_card?.text.trim()) {
    // The card is made at the film's size from the last kept frame of the last clip, then joined like any other clip.
    const work = mkdtempSync(join(tmpdir(), "flow-card-"));
    const last = clips.length - 1;
    const { width: w, height: h } = infos.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    const still = join(work, "last.jpg");
    await run(FFMPEG, ["-y", "-ss", Math.max(0, windows[last].to - 0.1).toFixed(3), "-i", clips[last], "-frames:v", "1", "-q:v", "2", still]).catch(() => undefined);
    const png = await renderEndCard(o.end_card.text, w, h, still, join(work, "card.png"));
    const seconds = Math.min(10, Math.max(1, o.end_card.seconds ?? 2.5));
    const card = join(o.dir, `${o.output_name.replace(/[^\w.-]+/g, "_").replace(/\.mp4$/, "")}-endcard.mp4`);
    await run(FFMPEG, [
      "-y", "-loop", "1", "-t", seconds.toFixed(2), "-i", png, "-f", "lavfi", "-t", seconds.toFixed(2), "-i", "anullsrc=r=48000:cl=stereo",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "24", "-c:a", "aac", "-shortest", card,
    ]);
    rmSync(work, { recursive: true, force: true });
    clips.push(card);
    windows.push({ from: 0, to: seconds, trimmed: false, crop: "", cw: 1, ch: 1, volume: 1, fadeIn: 0, fadeOut: 0, soften: 0, saturation: 1 });
    infos.push({ width: w, height: h, duration: seconds, hasAudio: true });
  }
  // A narration longer than the footage would be cut off, so the last frame is held until the voice finishes.
  let hold = 0;
  if (o.hold_last_frame !== false && o.voiceover) {
    const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", o.voiceover]);
    hold = Math.max(0, Number(stdout.trim()) + 0.6 - infos.reduce((sum, i) => sum + i.duration, 0));
  }
  if (o.end_hold) hold = Math.max(hold, o.end_hold.seconds);
  // Size the film to the biggest clip so a 720p opener cannot pull a 1080p clip down with it, or to `size` when given
  // ("1080x1920" for a phone-ready master). Always even, which the encoder needs.
  const biggest = infos.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  const asked = o.size?.match(/^(\d{2,4})x(\d{2,4})$/);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const width = even(asked ? Number(asked[1]) : biggest.width);
  const height = even(asked ? Number(asked[2]) : biggest.height);
  const args: string[] = ["-y"];
  clips.forEach((clip, i) => {
    const win = windows[i];
    if (win.trimmed) args.push("-ss", win.from.toFixed(3), "-t", (win.to - win.from).toFixed(3));
    args.push("-i", clip);
  });
  const filters: string[] = [];
  // The clips' own sound used to play at full volume no matter what, drowning a narration laid on top. Music already
  // had its own level; the clips now do too.
  const clipVolume = Math.min(1, Math.max(0, o.clip_volume ?? 1));
  const edges = (i: number) => {
    const { fadeIn, fadeOut } = windows[i];
    return (fadeIn > 0 ? `,afade=t=in:d=${fadeIn.toFixed(3)}` : "") +
      (fadeOut > 0 ? `,afade=t=out:st=${Math.max(0, infos[i].duration - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}` : "");
  };
  const blurs = await Promise.all(
    clips.map((clip, i) => (i > 0 && windows[i].soften > 0 ? matchSoftness(clips[i - 1], windows[i - 1].to, clip, windows[i].from) : Promise.resolve(0))),
  );
  infos.forEach((info, i) => {
    const freeze = hold > 0.05 && i === infos.length - 1 ? `,tpad=stop_mode=clone:stop_duration=${hold.toFixed(2)}` : "";
    const base = `[${i}:v]${windows[i].crop}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,setpts=PTS-STARTPTS${Math.abs(windows[i].saturation - 1) > 0.005 ? `,hue=s=${windows[i].saturation.toFixed(3)}` : ""}`;
    const end = `${freeze}[v${i}]`;
    if (blurs[i] > 0) {
      // Blurred copy on top, fading out over soften seconds: the clip opens as soft as the one before ends.
      const d = windows[i].soften.toFixed(2);
      filters.push(
        `${base},split[sh${i}][so${i}]`,
        `[so${i}]gblur=sigma=${blurs[i].toFixed(2)}[bl${i}]`,
        `[bl${i}][sh${i}]blend=all_expr='A*(1-min(1,T/${d}))+B*min(1,T/${d})'${end}`,
      );
    } else {
      filters.push(`${base}${end}`);
    }
    filters.push(
      info.hasAudio
        ? `[${i}:a]atrim=end=${info.duration.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${(clipVolume * windows[i].volume).toFixed(3)}${edges(i)}${hold > 0.05 && i === infos.length - 1 ? `,apad=pad_dur=${hold.toFixed(2)}` : ""}[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${(info.duration + (i === infos.length - 1 ? hold : 0)).toFixed(2)}[a${i}]`,
    );
  });
  let input = clips.length;
  const vOut = infos.map((_, i) => `[v${i}]`);
  const aOut = infos.map((_, i) => `[a${i}]`);
  inserts.forEach((x, j) => {
    args.push("-i", x.file);
    const end = (x.at + x.seconds).toFixed(3);
    filters.push(
      `[${input}:v]trim=start=${x.from.toFixed(3)}:duration=${x.seconds.toFixed(3)},setpts=PTS-STARTPTS+${x.at.toFixed(3)}/TB,${x.crop}` +
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[iv${j}]`,
      `${vOut[x.k]}[iv${j}]overlay=enable='between(t,${x.at.toFixed(3)},${end})':eof_action=pass[ov${j}]`,
    );
    vOut[x.k] = `[ov${j}]`;
    if (x.hasAudio && x.volume > 0) {
      const ms = Math.round(x.at * 1000);
      filters.push(
        `[${input}:a]atrim=start=${x.from.toFixed(3)}:duration=${x.seconds.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${x.volume},adelay=${ms}|${ms}[ia${j}]`,
        `${aOut[x.k]}[ia${j}]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[oa${j}]`,
      );
      aOut[x.k] = `[oa${j}]`;
    }
    input++;
  });
  let watermarkNote: string | undefined;
  let markDir = "";
  let markBox: { cx: number; cy: number; r: number } | null = null;
  if (o.remove_watermark) {
    markDir = mkdtempSync(join(tmpdir(), "flow-mark-"));
    const mask = join(markDir, "mark.pgm");
    const samples = clips.slice(0, userClips).flatMap((file, i) => {
      const vf = `${windows[i].crop}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
      const span = windows[i].to - windows[i].from;
      const n = Math.max(6, Math.min(24, Math.round(span * 1.5)));
      return Array.from({ length: n }, (_, j) => ({ file, at: windows[i].from + (span * (j + 0.5)) / n, vf }));
    });
    markBox = await watermarkMask(samples, width, height, mask, o.watermark_margin ?? 0);
    if (markBox) {
      filters.push(`${infos.map((_, i) => `${vOut[i]}${aOut[i]}`).join("")}concat=n=${clips.length}:v=1:a=1[vraw][clipaudio]`);
      filters.push(`[vraw]removelogo=filename=${mask.replace(/[\\:']/g, "\\$&")}[v]`);
      watermarkNote = "watermark painted out";
    } else {
      filters.push(`${infos.map((_, i) => `${vOut[i]}${aOut[i]}`).join("")}concat=n=${clips.length}:v=1:a=1[v][clipaudio]`);
      watermarkNote = "no corner watermark found; nothing painted out";
    }
  } else {
    filters.push(`${infos.map((_, i) => `${vOut[i]}${aOut[i]}`).join("")}concat=n=${clips.length}:v=1:a=1[v][clipaudio]`);
  }

  let picture = "[v]";
  if (o.end_hold?.fade) {
    const total = infos.reduce((sum, i) => sum + i.duration, 0) + hold;
    filters.push(`[v]fade=t=out:st=${(total - o.end_hold.fade).toFixed(3)}:d=${o.end_hold.fade.toFixed(3)}[vfade]`);
    picture = "[vfade]";
  }
  const mix = ["[clipaudio]"];
  if (o.music) {
    args.push("-stream_loop", "-1", "-i", o.music);
    const curve = musicCurve(o.music_curve);
    filters.push(`[${input}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${o.music_volume}${curve}[music]`);
    mix.push("[music]");
    input++;
  }
  if (o.voiceover) {
    args.push("-i", o.voiceover);
    if (o.music && o.duck_music) {
      filters.push(
        `[${input}:a]aresample=48000,aformat=channel_layouts=stereo,asplit=2[vo][side]`,
        `[music][side]sidechaincompress=threshold=0.02:ratio=6:attack=60:release=500[ducked]`,
      );
      mix[mix.indexOf("[music]")] = "[ducked]";
    } else {
      filters.push(`[${input}:a]aresample=48000,aformat=channel_layouts=stereo[vo]`);
    }
    mix.push("[vo]");
  }
  const level = o.loudness !== undefined ? `loudnorm=I=${Math.min(-9, Math.max(-30, o.loudness))}:TP=-1.5:LRA=11,aresample=48000` : "anull";
  filters.push(mix.length > 1 ? `${mix.join("")}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0,${level}[a]` : `[clipaudio]${level}[a]`);

  const output = out;
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", picture, "-map", "[a]",
    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
    output,
  );
  try {
    await run(FFMPEG, args, { maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    throw new Error(e.code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT}).` : `ffmpeg failed: ${(e.stderr ?? String(e)).slice(-600)}`);
  } finally {
    if (markDir) rmSync(markDir, { recursive: true, force: true });
  }
  if (markBox) {
    const ghosts = await ghostMarks(output, width, height, markBox);
    if (ghosts.length) {
      // The same filled-sparkle fill as the main mark, moved onto each copy and switched on only while it shows: a box
      // fill (delogo) left a visible smudged rectangle on the wet floor.
      const dir = mkdtempSync(join(tmpdir(), "flow-ghost-"));
      const R = markBox.r + 6 * (Math.min(width, height) / 1080);
      const steps = ghosts.map((g, n) => {
        const mask = Buffer.alloc(width * height);
        for (let y = Math.floor(g.y - R - 2); y <= Math.ceil(g.y + R + 2); y++) for (let x = Math.floor(g.x - R - 2); x <= Math.ceil(g.x + R + 2); x++) {
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          const ax = Math.abs(x - g.x) / R, ay = Math.abs(y - g.y) / R;
          if (Math.cbrt(ax * ax) + Math.cbrt(ay * ay) <= 1.15) mask[y * width + x] = 255;
        }
        const file = join(dir, `ghost-${n}.pgm`);
        writeFileSync(file, Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), mask]));
        return `removelogo=filename=${file.replace(/[\\:']/g, "\\$&")}:enable='between(t,${g.at.toFixed(2)},${g.to.toFixed(2)})'`;
      });
      const fixed = output.replace(/\.mp4$/, "") + "-ghosts.mp4";
      try {
        await run(FFMPEG, ["-y", "-v", "error", "-i", output, "-vf", steps.join(","), "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", fixed], { maxBuffer: 32 * 1024 * 1024 });
        renameSync(fixed, output);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      watermarkNote = `watermark painted out, plus ${ghosts.length} brief second cop${ghosts.length === 1 ? "y" : "ies"} at ${ghosts.map((g) => `${g.at.toFixed(1)}-${g.to.toFixed(1)} s`).join(", ")}`;
    }
  }
  // One loudnorm pass is held back by its true-peak ceiling: Three Tiers asked for -14 and came out at -14.9. Measure
  // the film and close the gap with plain gain, a limiter keeping the peaks under -1.5 dB.
  let lufs: number | undefined;
  if (o.loudness !== undefined) {
    const target = Math.min(-9, Math.max(-30, o.loudness));
    lufs = await integratedLoudness(output);
    if (lufs !== undefined && Math.abs(lufs - target) > 0.3) {
      const fixed = output.replace(/\.mp4$/, "") + "-level.mp4";
      await run(FFMPEG, [
        "-y", "-i", output, "-c:v", "copy",
        "-af", `volume=${(target - lufs).toFixed(2)}dB,alimiter=limit=0.84:level=false:attack=2:release=50`,
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", fixed,
      ], { maxBuffer: 32 * 1024 * 1024 });
      renameSync(fixed, output);
      lufs = await integratedLoudness(output);
    }
  }
  return {
    output, clips, duration: infos.reduce((sum, i) => sum + i.duration, 0) + hold, held_last_frame: Number(hold.toFixed(2)),
    ...(lufs !== undefined ? { loudness: Number(lufs.toFixed(1)) } : {}),
    ...(watermarkNote ? { watermark: watermarkNote } : {}),
  };
}

async function integratedLoudness(file: string): Promise<number | undefined> {
  const { stderr } = await run(FFMPEG, ["-hide_banner", "-i", file, "-vn", "-af", "loudnorm=print_format=json", "-f", "null", "-"], { maxBuffer: 32 * 1024 * 1024 });
  const m = String(stderr).match(/"input_i"\s*:\s*"(-?[\d.]+)"/);
  return m ? Number(m[1]) : undefined;
}

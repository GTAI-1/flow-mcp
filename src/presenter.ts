import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { FFMPEG_HINT } from "./platform.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLOW_MCP_FFPROBE ?? "ffprobe";

// A talking presenter over footage, built from one recording of them: each stretch of the recording is shown full
// frame (optionally with a slow zoom) or in a circle in a corner over another clip. The sound is always the presenter's.
export interface PresenterSegment {
  from: number;
  to: number;
  layout: "full" | "corner";
  /** Full frame only: 1 shows the whole picture, 1.15 is 15% closer. Goes from `from` to `to` over the stretch. */
  zoom?: { from?: number; to?: number; x?: number; y?: number };
  /** Corner only: the clip behind the presenter. `from` is measured after any retime. */
  background?: { clip: string; from?: number; retime?: { from: number; to: number; speed: number }[] };
  /** Corner only: animate from full frame into the circle over this many seconds at the start of the stretch. */
  shrink?: number;
}

export interface PresenterOptions {
  presenter: string;
  segments: PresenterSegment[];
  dir: string;
  output_name?: string;
  size?: string;
  corner?: {
    position?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
    /** Circle diameter as a fraction of the frame's height. */
    size?: number;
    /** Square taken from the recording for the circle: centre x, centre y, and width, as fractions of the recording. */
    face?: { x: number; y: number; w: number };
    margin?: number;
    ring_color?: string;
  };
}

const even = (n: number) => Math.round(n / 2) * 2;

async function probe(file: string): Promise<{ width: number; height: number; fps: number; duration: number }> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", file]).catch(() => {
    throw new Error(`Could not read ${file}. ${FFMPEG_HINT}`);
  });
  const j = JSON.parse(stdout);
  const [n, d] = String(j.streams[0].r_frame_rate).split("/").map(Number);
  return { width: j.streams[0].width, height: j.streams[0].height, fps: n / (d || 1), duration: Number(j.format.duration) };
}

// Plays parts of a clip faster or slower, so its action lands on the presenter's words. Picture only: the presenter's
// sound is the film's sound. Anything not named plays at normal speed.
async function retimeClip(file: string, stretches: { from: number; to: number; speed: number }[], fps: number, out: string): Promise<void> {
  const { duration } = await probe(file);
  const sorted = [...stretches].sort((a, b) => a.from - b.from);
  const parts: { from: number; to: number; speed: number }[] = [];
  let at = 0;
  for (const r of sorted) {
    if (r.from < at - 0.001 || r.to <= r.from || r.speed <= 0) throw new Error(`Retime stretches must be in order and not overlap (${r.from} to ${r.to}).`);
    if (r.from > at) parts.push({ from: at, to: r.from, speed: 1 });
    parts.push({ from: r.from, to: Math.min(r.to, duration), speed: r.speed });
    at = r.to;
  }
  if (at < duration) parts.push({ from: at, to: duration, speed: 1 });
  const filters = parts.map((p, i) => `[0:v]trim=start=${p.from}:end=${p.to},setpts=(PTS-STARTPTS)/${p.speed}[p${i}]`);
  filters.push(`${parts.map((_, i) => `[p${i}]`).join("")}concat=n=${parts.length}:v=1:a=0,fps=${fps},format=yuv420p[v]`);
  await run(FFMPEG, ["-v", "error", "-y", "-i", file, "-filter_complex", filters.join(";"), "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "15", out]);
}

// The presenter shrinking from full frame into the circle, one frame at a time: the framing, the size, the place and
// the corner radius all ease together. ffmpeg's scale and overlay round to whole pixels, so a filter-graph move shakes.
async function shrinkClip(o: {
  presenter: string; from: number; seconds: number; background: string; backgroundFrom: number; fps: number; W: number; H: number;
  crop: { x: number; y: number; w: number }; info: { width: number; height: number }; target: { x: number; y: number; d: number }; ringColor: string; ring: number; dir: string; out: string;
}): Promise<void> {
  const frames = Math.max(2, Math.round(o.seconds * o.fps));
  const ease = (t: number) => t * t * (3 - 2 * t);
  for (let i = 0; i < frames; i++) {
    const t = ease(i / (frames - 1));
    const at = o.from + i / o.fps;
    const lerp = (a: number, b: number) => a + (b - a) * t;
    const outW = even(lerp(o.W, o.target.d));
    const outH = even(lerp(o.H, o.target.d));
    const x = Math.round(lerp(0, o.target.x));
    const y = Math.round(lerp(0, o.target.y));
    // Keep the source's shape for this frame's box, moving from the whole picture to the face square.
    const shapeW = lerp(o.info.width, o.crop.w);
    const shapeH = Math.min(o.info.height, shapeW * (outH / outW));
    const sx = Math.max(0, Math.round(lerp(0, o.crop.x)));
    const sy = Math.max(0, Math.min(o.info.height - shapeH, Math.round(lerp(0, o.crop.y))));
    const radius = lerp(0, o.target.d / 2);
    const inside = `if(gt(abs(X-${outW / 2})\\,${outW / 2 - radius})*gt(abs(Y-${outH / 2})\\,${outH / 2 - radius})\\,hypot(abs(X-${outW / 2})-${outW / 2 - radius}\\,abs(Y-${outH / 2})-${outH / 2 - radius})\\,${radius - 1})`;
    const alpha = radius < 1 ? "255" : `255*clip(${radius}-(${inside})+0.5\\,0\\,1)`;
    const ringOn = t > 0.02;
    const graph = [
      `[0:v]scale=${o.W}:${o.H}:flags=lanczos,format=rgba[bg]`,
      `[1:v]crop=${even(shapeW)}:${even(shapeH)}:${sx}:${Math.round(sy)},scale=${outW}:${outH}:flags=lanczos,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}'[fg]`,
      ringOn
        ? `color=${o.ringColor}:s=${outW + o.ring * 2}x${outH + o.ring * 2},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${radius < 1 ? "255" : `255*clip(${radius + o.ring}-(if(gt(abs(X-${outW / 2 + o.ring})\\,${outW / 2 - radius})*gt(abs(Y-${outH / 2 + o.ring})\\,${outH / 2 - radius})\\,hypot(abs(X-${outW / 2 + o.ring})-${outW / 2 - radius}\\,abs(Y-${outH / 2 + o.ring})-${outH / 2 - radius})\\,${radius + o.ring - 1}))+0.5\\,0\\,1)`}'[r];[bg][r]overlay=${x - o.ring}:${y - o.ring}[b2];[b2][fg]overlay=${x}:${y},format=rgb24[out]`
        : `[bg][fg]overlay=${x}:${y},format=rgb24[out]`,
    ].join(";");
    await run(FFMPEG, ["-v", "error", "-y", "-ss", (o.backgroundFrom + i / o.fps).toFixed(3), "-i", o.background, "-ss", at.toFixed(3), "-i", o.presenter, "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", join(o.dir, `f${String(i).padStart(4, "0")}.png`)]);
  }
  await run(FFMPEG, ["-v", "error", "-y", "-framerate", String(o.fps), "-i", join(o.dir, "f%04d.png"), "-c:v", "libx264", "-preset", "veryfast", "-crf", "15", "-pix_fmt", "yuv420p", o.out]);
}

const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export async function presenter(o: PresenterOptions): Promise<{ output: string; duration: number; segments: number }> {
  if (!o.segments.length) throw new Error("Give at least one segment.");
  for (const f of [o.presenter, ...o.segments.map((s) => s.background?.clip)]) if (f && !existsSync(f)) throw new Error(`File not found: ${f}`);
  const info = await probe(o.presenter);
  for (const [i, s] of o.segments.entries()) {
    if (s.to <= s.from) throw new Error(`Segment ${i + 1} ends before it starts.`);
    if (s.to > info.duration + 0.05) throw new Error(`Segment ${i + 1} runs to ${s.to} s, but the recording is ${info.duration.toFixed(2)} s long.`);
    if (s.layout === "corner" && !s.background) throw new Error(`Segment ${i + 1} is in the corner but has no background clip.`);
  }
  const asked = o.size?.match(/^(\d{2,4})x(\d{2,4})$/);
  const W = even(asked ? Number(asked[1]) : 1920);
  const H = even(asked ? Number(asked[2]) : 1080);
  const fps = Math.round(info.fps) || 24;

  const D = even(H * (o.corner?.size ?? 0.36));
  const ring = even(H * 0.006);
  const margin = Math.round(H * (o.corner?.margin ?? 0.045));
  const R = D + ring * 2;
  const pos = o.corner?.position ?? "bottom-right";
  const X = pos.endsWith("right") ? W - R - margin : margin;
  const Y = pos.startsWith("bottom") ? H - R - margin : margin;
  const face = o.corner?.face ?? { x: 0.5, y: 0.42, w: 0.45 };
  const cw = even(info.width * face.w);
  const cx = Math.max(0, Math.min(info.width - cw, Math.round(info.width * face.x - cw / 2)));
  const cy = Math.max(0, Math.min(info.height - cw, Math.round(info.height * face.y - cw / 2)));

  const work = mkdtempSync(join(tmpdir(), "flow-presenter-"));
  try {
    const circle = (size: number) => `255*clip(${size / 2}-hypot(X-${size / 2}+0.5\\,Y-${size / 2}+0.5)+0.5\\,0\\,1)`;
    const mask = join(work, "mask.png");
    const ringPng = join(work, "ring.png");
    await run(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=black:s=${D}x${D}`, "-frames:v", "1", "-vf", `format=gray,geq=lum='${circle(D)}'`, mask]);
    const c = o.corner?.ring_color ?? "white";
    await run(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=${c}:s=${R}x${R}`, "-frames:v", "1", "-vf", `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${circle(R)}'`, ringPng]);

    const total = o.segments.reduce((sum, s) => sum + (s.to - s.from), 0);
    // Retime first, once per clip: everything below reads the retimed copy.
    const retimed = new Map<string, string>();
    for (const s of o.segments) {
      const b = s.background;
      if (!b?.retime?.length) continue;
      const key = `${b.clip}|${JSON.stringify(b.retime)}`;
      if (!retimed.has(key)) {
        const out = join(work, `retimed-${retimed.size}.mp4`);
        await retimeClip(b.clip, b.retime, fps, out);
        retimed.set(key, out);
      }
      s.background = { ...b, clip: retimed.get(key)! };
    }
    const backgrounds = [...new Set(o.segments.flatMap((s) => (s.background ? [s.background.clip] : [])))];
    // The shrink is rendered ahead of time and cut in as its own stretch.
    const shrinks = new Map<number, string>();
    for (const [i, s] of o.segments.entries()) {
      if (s.layout !== "corner" || !s.shrink) continue;
      const out = join(work, `shrink-${i}.mp4`);
      const frames = join(work, `frames-${i}`);
      mkdirSync(frames);
      await shrinkClip({ presenter: o.presenter, from: s.from, seconds: s.shrink, background: s.background!.clip, backgroundFrom: s.background!.from ?? 0, fps, W, H, crop: { x: cx, y: cy, w: cw }, info, target: { x: X + ring, y: Y + ring, d: D }, ringColor: c, ring, dir: frames, out });
      shrinks.set(i, out);
    }
    const args = ["-v", "error", "-y", "-i", o.presenter];
    for (const b of backgrounds) args.push("-i", b);
    const shrinkInputs = new Map<number, number>();
    for (const [i, file] of shrinks) {
      args.push("-i", file);
      shrinkInputs.set(i, backgrounds.length + 1 + shrinkInputs.size);
    }
    const maskIn = backgrounds.length + 1 + shrinkInputs.size;
    args.push("-loop", "1", "-framerate", String(fps), "-t", (total + 1).toFixed(3), "-i", mask);
    args.push("-loop", "1", "-framerate", String(fps), "-t", (total + 1).toFixed(3), "-i", ringPng);

    const filters: string[] = [];
    const parts: string[] = [];
    o.segments.forEach((s, i) => {
      const dur = (s.to - s.from).toFixed(3);
      const take = `[0:v]trim=start=${s.from}:end=${s.to},setpts=PTS-STARTPTS,fps=${fps},format=yuv420p`;
      if (s.layout === "full") {
        const z0 = s.zoom?.from ?? 1;
        const z1 = s.zoom?.to ?? z0;
        const scaled = `${take},scale=${W}:${H}:flags=lanczos,setsar=1`;
        if (z0 === 1 && z1 === 1) filters.push(`${scaled}[s${i}]`);
        else {
          // perspective samples between pixels, so a slow zoom does not stair-step the way zoompan and crop do.
          const frames = Math.max(1, Math.round((s.to - s.from) * fps) - 1);
          const zt = `(${z0}+(${z1 - z0})*min(in/${frames}\\,1))`;
          const fx = (s.zoom?.x ?? 0.5) * W;
          const fy = (s.zoom?.y ?? 0.45) * H;
          const hw = `(W/2/${zt})`;
          const hh = `(H/2/${zt})`;
          const left = `max(0\\,min(W-2*${hw}\\,${fx}-${hw}))`;
          const top = `max(0\\,min(H-2*${hh}\\,${fy}-${hh}))`;
          const p = `perspective=x0='${left}':y0='${top}':x1='${left}+2*${hw}':y1='${top}':x2='${left}':y2='${top}+2*${hh}':x3='${left}+2*${hw}':y3='${top}+2*${hh}':interpolation=cubic:sense=source:eval=frame`;
          filters.push(`${scaled},${p}[s${i}]`);
        }
      } else {
        const b = s.background!;
        const input = backgrounds.indexOf(b.clip) + 1;
        const lead = s.shrink ?? 0;
        const start = (b.from ?? 0) + lead;
        const rest = (s.to - s.from - lead).toFixed(3);
        filters.push(`[${input}:v]trim=start=${start}:duration=${rest},setpts=PTS-STARTPTS,fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1,format=yuv420p[bg${i}]`);
        filters.push(`[0:v]trim=start=${s.from + lead}:end=${s.to},setpts=PTS-STARTPTS,fps=${fps},format=yuv420p,crop=${cw}:${cw}:${cx}:${cy},scale=${D}:${D}:flags=lanczos,setsar=1[f${i}]`);
        filters.push(`[${maskIn}:v]trim=duration=${rest},setpts=PTS-STARTPTS,format=gray[m${i}]`);
        filters.push(`[f${i}][m${i}]alphamerge[fa${i}]`);
        filters.push(`[${maskIn + 1}:v]trim=duration=${rest},setpts=PTS-STARTPTS,format=rgba[r${i}]`);
        filters.push(`[bg${i}][r${i}]overlay=${X}:${Y}:shortest=1[br${i}]`);
        if (shrinkInputs.has(i)) {
          filters.push(`[br${i}][fa${i}]overlay=${X + ring}:${Y + ring}:shortest=1,format=yuv420p[c${i}]`);
          filters.push(`[${shrinkInputs.get(i)}:v]fps=${fps},setsar=1,format=yuv420p[h${i}]`);
          filters.push(`[h${i}][c${i}]concat=n=2:v=1:a=0[s${i}]`);
        } else filters.push(`[br${i}][fa${i}]overlay=${X + ring}:${Y + ring}:shortest=1,format=yuv420p[s${i}]`);
      }
      filters.push(`[0:a]atrim=start=${s.from}:end=${s.to},asetpts=PTS-STARTPTS[a${i}]`);
      parts.push(`[s${i}][a${i}]`);
    });
    filters.push(`${parts.join("")}concat=n=${o.segments.length}:v=1:a=1[v][a]`);

    mkdirSync(o.dir, { recursive: true });
    const output = join(o.dir, `${(o.output_name ?? "presenter").replace(/[^\w.-]+/g, "_").replace(/\.mp4$/i, "")}.mp4`);
    args.push("-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]", "-r", String(fps), "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output);
    await run(FFMPEG, args, { maxBuffer: 1 << 24 }).catch((e: { stderr?: string; message: string }) => {
      throw new Error(`The presenter video could not be made: ${q(String(e.stderr ?? e.message)).slice(-800)}`);
    });
    return { output, duration: (await probe(output)).duration, segments: o.segments.length };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

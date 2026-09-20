#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assemble } from "./assemble.js";
import { extractLastFrame } from "./chain.js";
import { downloadAsset, getFlowState, listAssets, runGeneration } from "./flow.js";
import { PLAYBOOK } from "./playbook.js";
import { JobQueue, type Job } from "./queue.js";
import { TECHNIQUES, techniqueById } from "./techniques.js";

const OUTPUT_ROOT = process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out");

const queue: JobQueue = new JobQueue(async (job) => {
  const { chain_from } = job.params;
  if (chain_from) {
    const previous = queue.get(chain_from);
    const clip = previous?.files.find((f) => /\.(mp4|webm|mov)$/i.test(f));
    if (!clip) throw new Error(`chain_previous: the previous scene (${chain_from}) produced no video, so this scene was skipped.`);
    job.params.first_frame = await extractLastFrame(clip);
  }
  return runGeneration(job);
});
const server = new McpServer({ name: "flow-mcp", version: "0.1.0" });

const projectDir = (project: string) => resolve(OUTPUT_ROOT, project.replace(/[^\w.-]+/g, "_"));

const result = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const jobView = ({ id, status, params, files, credits, progress, error }: Job) => ({
  id,
  status,
  prompt: params.prompt,
  credits,
  progress,
  files,
  error,
});

server.registerTool(
  "flow_status",
  {
    title: "Flow status",
    description:
      "Check the Flow Chrome session (signed in, project open) and the generation queue. Call this first; it says what the user must fix before generating.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    const flow = await getFlowState(!queue.busy);
    return result({ flow, pacing: queue.pausedReason, output_root: OUTPUT_ROOT, jobs: queue.list().map(jobView), playbook: PLAYBOOK });
  },
);

const sceneSchema = z.object({
  prompt: z.string().min(1).describe("Full English prompt for one clip: action, shot and camera move, location, style, light, sound."),
  type: z.enum(["video", "image"]).default("video"),
  model: z
    .string()
    .optional()
    .describe("Model label as shown in Flow, e.g. 'Omni 1.1 Flash', 'Veo 3.1 - Fast', 'Veo 3.1 - Quality', 'Nano Banana 2'. Omit to keep Flow's current model."),
  aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).optional().describe("Video supports 16:9 and 9:16 only."),
  duration: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).optional().describe("Video length in seconds. Omni models only; Veo 3.1 clips are fixed at 8s."),
  resolution: z.enum(["360p", "720p"]).optional().describe("Video resolution. Omni models only."),
  max_credits: z
    .number()
    .int()
    .min(0)
    .default(25)
    .describe("Safety cap: the scene is skipped (nothing spent) if Flow quotes more credits than this."),
  variants: z.number().int().min(1).max(4).optional().describe("Outputs per prompt (each one spends credits). Default 1."),
  first_frame: z.string().optional().describe("First frame: absolute image path, or 'asset:<title>' for an image already in the Flow project."),
  last_frame: z.string().optional().describe("Last frame: absolute image path, or 'asset:<title>'."),
  reference_images: z
    .array(z.string())
    .max(3)
    .optional()
    .describe("Ingredient/reference media: absolute image paths, or 'asset:<title>' for media or characters already in the Flow project."),
  download_quality: z.enum(["original", "upscaled"]).optional().describe("'upscaled' fetches 1080p video / 2K image and takes longer. Default original."),
  technique: z
    .string()
    .optional()
    .describe("Id from flow_techniques (e.g. 'orbit-360'); its exact phrase is appended to the prompt. One per scene."),
  chain_previous: z
    .boolean()
    .optional()
    .describe("Continue the previous scene in this call: its last frame becomes this scene's first frame. Not valid on the first scene or together with first_frame."),
});

server.registerTool(
  "flow_generate",
  {
    title: "Queue Flow generations",
    description:
      "Queue one clip or image per scene in the open Flow project. Runs one at a time with human-like pauses and spends the user's Google AI credits (approx. per video: Omni 1.1 Flash 7-12, Veo 3.1 Lite 10, Fast 20, Quality 100; images 0). Each scene is checked against max_credits using Flow's own quote before anything is spent. Returns job ids immediately; use flow_wait for results.",
    inputSchema: {
      project: z.string().min(1).describe("Folder name for the downloaded clips, e.g. 'HotelPromo'."),
      scenes: z.array(sceneSchema).min(1).max(30),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ project, scenes }) => {
    const output_dir = projectDir(project);
    const offset = queue.list().filter((j) => j.params.output_dir === output_dir).length;
    const invalid = scenes.findIndex((s, i) => s.chain_previous && (i === 0 || s.first_frame || s.type === "image"));
    if (invalid >= 0) {
      return {
        ...result({ error: `Scene ${invalid + 1}: chain_previous needs a preceding video scene in the same call and cannot be combined with first_frame.` }),
        isError: true,
      };
    }
    const unknown = scenes.find((s) => s.technique && !techniqueById(s.technique));
    if (unknown) {
      return { ...result({ error: `Unknown technique "${unknown.technique}". Call flow_techniques for valid ids.` }), isError: true };
    }
    const jobs: Job[] = [];
    for (const [i, { chain_previous, technique, ...scene }] of scenes.entries()) {
      const phrase = technique ? techniqueById(technique)!.phrase : "";
      jobs.push(
        queue.add({
          ...scene,
          prompt: phrase ? `${scene.prompt.trim().replace(/\.?$/, ".")} ${phrase}` : scene.prompt,
          chain_from: chain_previous ? jobs[i - 1].id : undefined,
          output_dir,
          file_stem: `scene-${String(offset + i + 1).padStart(2, "0")}`,
        }),
      );
    }
    return result({ output_dir, jobs: jobs.map(jobView) });
  },
);

const BUSY = "A generation is running in the Flow tab. Call flow_wait first, then retry.";
const failure = (err: unknown) => ({ ...result({ error: err instanceof Error ? err.message : String(err) }), isError: true });

server.registerTool(
  "flow_assets",
  {
    title: "List project media",
    description: "List the images and videos in the open Flow project (title and kind). Titles can be used as 'asset:<title>' in flow_generate or with flow_download.",
    inputSchema: { kind: z.enum(["image", "video"]).optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ kind }) => {
    if (queue.busy) return failure(BUSY);
    try {
      const assets = await listAssets();
      return result(assets.filter((a) => !kind || a.kind === kind).map(({ name, kind }) => ({ name, kind })));
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  "flow_download",
  {
    title: "Download existing project media",
    description: "Download media that already exists in the Flow project, without regenerating it (no credits). Matches by the start of the title.",
    inputSchema: {
      project: z.string().min(1).describe("Local folder name under the output root."),
      assets: z.array(z.string().min(1)).min(1).max(30).describe("Titles (or title prefixes) from flow_assets, in the order they should be numbered."),
      quality: z.enum(["original", "upscaled"]).default("original"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ project, assets, quality }) => {
    if (queue.busy) return failure(BUSY);
    const dir = projectDir(project);
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    try {
      for (const [i, name] of assets.entries()) {
        files.push(await downloadAsset(name, join(dir, `clip-${String(i + 1).padStart(2, "0")}`), quality));
      }
      return result({ dir, files });
    } catch (err) {
      return failure(new Error(`${err instanceof Error ? err.message : err} (downloaded so far: ${files.length})`));
    }
  },
);

server.registerTool(
  "flow_techniques",
  {
    title: "Film technique presets",
    description:
      "List ready-made prompt phrases for camera moves, product shots, first→last-frame transitions and image commands. Pass an id as a scene's `technique` in flow_generate.",
    inputSchema: { category: z.enum(["camera", "product", "transition", "image"]).optional() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ category }) => result(TECHNIQUES.filter((t) => !category || t.category === category)),
);

server.registerTool(
  "flow_assemble",
  {
    title: "Assemble clips into one video",
    description:
      "Join a project's downloaded scene clips in order into one MP4 (local ffmpeg, no credits). Keeps each clip's own sound and can lay a music track and a voiceover on top.",
    inputSchema: {
      project: z.string().min(1).describe("Same project name used in flow_generate."),
      clips: z.array(z.string()).optional().describe("Absolute clip paths in play order. Default: every scene-NN.mp4 in the project folder (first variant of each)."),
      music: z.string().optional().describe("Absolute path to a music file; looped and trimmed to the film length."),
      music_volume: z.number().min(0).max(1).default(0.25),
      voiceover: z.string().optional().describe("Absolute path to a voiceover audio file, starts at 0:00."),
      output_name: z.string().default("final"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ project, ...rest }) => {
    try {
      return result(await assemble({ dir: projectDir(project), ...rest }));
    } catch (err) {
      return { ...result({ error: err instanceof Error ? err.message : String(err) }), isError: true };
    }
  },
);

server.registerTool(
  "flow_wait",
  {
    title: "Wait for Flow jobs",
    description: "Block until the given jobs (default: all) finish or the timeout passes, then return their status and file paths.",
    inputSchema: {
      job_ids: z.array(z.string()).optional(),
      timeout_seconds: z.number().int().min(5).max(900).default(240),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ job_ids, timeout_seconds }) => {
    const pick = () => (job_ids ? job_ids.map((id) => queue.get(id)).filter((j): j is Job => Boolean(j)) : queue.list());
    const deadline = Date.now() + timeout_seconds * 1000;
    while (Date.now() < deadline && pick().some((j) => j.status === "queued" || j.status === "running")) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    const jobs = pick();
    return result({
      finished: jobs.every((j) => j.status !== "queued" && j.status !== "running"),
      pacing: queue.pausedReason,
      jobs: jobs.map(jobView),
    });
  },
);

server.registerTool(
  "flow_cancel",
  {
    title: "Cancel a queued Flow job",
    description: "Cancel a job that has not started yet. A running generation cannot be cancelled.",
    inputSchema: { job_id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ job_id }) => {
    const job = queue.cancel(job_id);
    if (!job) return { ...result({ error: `No job with id ${job_id}. Use flow_status to list jobs.` }), isError: true };
    return result(jobView(job));
  },
);

await server.connect(new StdioServerTransport());

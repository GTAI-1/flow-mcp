#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { extractLastFrame } from "./chain.js";
import { getFlowState, runGeneration } from "./flow.js";
import { PLAYBOOK } from "./playbook.js";
import { JobQueue, type Job } from "./queue.js";

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
    const flow = await getFlowState();
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
  first_frame: z.string().optional().describe("Absolute path to an image used as the first frame."),
  last_frame: z.string().optional().describe("Absolute path to an image used as the last frame."),
  reference_images: z.array(z.string()).max(3).optional().describe("Absolute paths to ingredient/reference images."),
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
    const output_dir = resolve(OUTPUT_ROOT, project.replace(/[^\w.-]+/g, "_"));
    const offset = queue.list().filter((j) => j.params.output_dir === output_dir).length;
    const invalid = scenes.findIndex((s, i) => s.chain_previous && (i === 0 || s.first_frame || s.type === "image"));
    if (invalid >= 0) {
      return {
        ...result({ error: `Scene ${invalid + 1}: chain_previous needs a preceding video scene in the same call and cannot be combined with first_frame.` }),
        isError: true,
      };
    }
    const jobs: Job[] = [];
    for (const [i, { chain_previous, ...scene }] of scenes.entries()) {
      jobs.push(
        queue.add({
          ...scene,
          chain_from: chain_previous ? jobs[i - 1].id : undefined,
          output_dir,
          file_stem: `scene-${String(offset + i + 1).padStart(2, "0")}`,
        }),
      );
    }
    return result({ output_dir, jobs: jobs.map(jobView) });
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

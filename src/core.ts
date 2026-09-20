import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { assemble } from "./assemble.js";
import { extractLastFrame } from "./chain.js";
import { createCharacter, downloadAsset, getFlowState, listAssets, runAgentBatch, runEdit, runGeneration } from "./flow.js";
import { JobQueue, type Job } from "./queue.js";
import { TECHNIQUES, techniqueById } from "./techniques.js";

export const OUTPUT_ROOT = process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out");
export const projectDir = (project: string) => resolve(OUTPUT_ROOT, project.replace(/[^\w.-]+/g, "_"));

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
  max_credits: z.number().int().min(0).default(25).describe("Safety cap: the scene is skipped (nothing spent) if Flow quotes more credits than this."),
  variants: z.number().int().min(1).max(4).optional().describe("Outputs per prompt (each one spends credits). Default 1."),
  first_frame: z.string().optional().describe("First frame: absolute image path, or 'asset:<title>' for an image already in the Flow project."),
  last_frame: z.string().optional().describe("Last frame: absolute image path, or 'asset:<title>'."),
  reference_images: z
    .array(z.string())
    .max(3)
    .optional()
    .describe("Ingredient/reference media: absolute image paths, or 'asset:<title>' for media or characters already in the Flow project."),
  download_quality: z.enum(["original", "upscaled"]).optional().describe("'upscaled' fetches 1080p video / 2K image (free, slower). Default original."),
  technique: z.string().optional().describe("Id from flow_techniques (e.g. 'orbit-360'); its exact phrase is appended to the prompt. One per scene."),
  chain_previous: z
    .boolean()
    .optional()
    .describe("Continue the previous scene in this call: its last frame becomes this scene's first frame. Not valid on the first scene or together with first_frame."),
});

// Raw shapes double as MCP input schemas and, wrapped in z.object, as HTTP body validators.
export const shapes = {
  status: { detailed: z.boolean().default(true).describe("false skips the plan/credits readout, which briefly opens Flow's account panel.") },
  generate: {
    project: z.string().min(1).describe("Folder name for the downloaded clips, e.g. 'HotelPromo'."),
    scenes: z.array(sceneSchema).min(1).max(30),
  },
  wait: {
    job_ids: z.array(z.string()).optional(),
    timeout_seconds: z.number().int().min(5).max(900).default(240),
  },
  cancel: { job_id: z.string() },
  assets: { kind: z.enum(["image", "video"]).optional() },
  download: {
    project: z.string().min(1).describe("Local folder name under the output root."),
    assets: z.array(z.string().min(1)).min(1).max(30).describe("Titles (or title prefixes) from flow_assets, in the order they should be numbered."),
    quality: z.enum(["original", "upscaled"]).default("original"),
  },
  assemble: {
    project: z.string().min(1).describe("Same project name used in flow_generate."),
    clips: z.array(z.string()).optional().describe("Absolute clip paths in play order. Default: every scene-NN.mp4 in the project folder (first variant of each)."),
    music: z.string().optional().describe("Absolute path to a music file; looped and trimmed to the film length."),
    music_volume: z.number().min(0).max(1).default(0.25),
    voiceover: z.string().optional().describe("Absolute path to a voiceover audio file, starts at 0:00."),
    output_name: z.string().default("final"),
  },
  agent: {
    project: z.string().min(1).describe("Folder name for the downloaded images."),
    scenes: z.array(z.string().min(1)).min(1).max(50).describe("One image description per scene, in order."),
    aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).default("16:9"),
    download_quality: z.enum(["original", "upscaled"]).optional(),
  },
  edit: {
    project: z.string().min(1).describe("Local folder for the edited clip."),
    asset: z.string().min(1).describe("Title (or title prefix) of a video already in the Flow project; see flow_assets."),
    prompt: z.string().min(1).describe("What to change, e.g. 'change the time of day to golden hour', 'remove the cup', 'make it snow'."),
    acknowledge_cost: z
      .literal(true)
      .describe("Must be true. Flow shows no quote for edits, so max_credits cannot protect you: a 4 s clip cost 20 credits when measured. The real cost is reported on the finished job."),
    download_quality: z.enum(["original", "upscaled"]).optional(),
  },
  outputs: {},
  character: {
    name: z.string().min(1).max(60).describe("Character name; scenes then reference it as 'asset:<name>' in reference_images."),
    image: z.string().min(1).describe("Portrait or product image: absolute path, or 'asset:<title>' of an image already in the Flow project. Generate one first with a free image scene if needed."),
    personality: z.string().max(500).optional().describe("How the character acts; Flow uses it when crafting scenes."),
    voice: z.string().optional().describe("Flow voice name, e.g. 'Charon' (male, informative) or 'Aoede' (female, breezy)."),
  },
  techniques: { category: z.enum(["camera", "product", "transition", "image"]).optional() },
};

type Args<K extends keyof typeof shapes> = z.infer<z.ZodObject<(typeof shapes)[K]>>;

export const jobView = ({ id, status, params, files, credits, progress, note, error }: Job) => ({
  id,
  status,
  project: params.output_dir,
  scene: params.file_stem,
  prompt: params.prompt,
  credits,
  progress,
  files,
  note,
  error,
});

// One implementation runs in whichever process owns the Flow tab; the other process talks to it over HTTP (remote.ts).
export interface Core {
  status(a: Args<"status">): Promise<unknown>;
  generate(a: Args<"generate">): Promise<unknown>;
  wait(a: Args<"wait">): Promise<unknown>;
  cancel(a: Args<"cancel">): Promise<unknown>;
  assets(a: Args<"assets">): Promise<unknown>;
  download(a: Args<"download">): Promise<unknown>;
  assemble(a: Args<"assemble">): Promise<unknown>;
  techniques(a: Args<"techniques">): Promise<unknown>;
  character(a: Args<"character">): Promise<unknown>;
  edit(a: Args<"edit">): Promise<unknown>;
  agent(a: Args<"agent">): Promise<unknown>;
  outputs(): Promise<unknown>;
}

const BUSY = "A generation is running in the Flow tab. Wait for it to finish (flow_wait), then retry.";

export class LocalCore implements Core {
  private queue: JobQueue = new JobQueue(async (job) => {
    const { chain_from } = job.params;
    if (chain_from) {
      const clip = this.queue.get(chain_from)?.files.find((f) => /\.(mp4|webm|mov)$/i.test(f));
      if (!clip) throw new Error(`chain_previous: the previous scene (${chain_from}) produced no video, so this scene was skipped.`);
      job.params.first_frame = await extractLastFrame(clip);
    }
    if (job.params.agent_scenes) return runAgentBatch(job);
    return job.params.edit_asset ? runEdit(job) : runGeneration(job);
  });

  async status({ detailed }: Args<"status">) {
    const flow = await getFlowState(detailed && !this.queue.busy);
    return { flow, pacing: this.queue.pausedReason, output_root: OUTPUT_ROOT, jobs: this.queue.list().map(jobView) };
  }

  async generate({ project, scenes }: Args<"generate">) {
    const invalid = scenes.findIndex((s, i) => s.chain_previous && (i === 0 || s.first_frame || s.type === "image"));
    if (invalid >= 0) {
      throw new Error(`Scene ${invalid + 1}: chain_previous needs a preceding video scene in the same call and cannot be combined with first_frame.`);
    }
    const unknown = scenes.find((s) => s.technique && !techniqueById(s.technique));
    if (unknown) throw new Error(`Unknown technique "${unknown.technique}". Call flow_techniques for valid ids.`);

    const output_dir = projectDir(project);
    // Continue numbering after whatever is already on disk or queued, so reruns never overwrite earlier scenes.
    const onDisk = existsSync(output_dir) ? readdirSync(output_dir).map((f) => Number(f.match(/^scene-(\d+)/)?.[1] ?? 0)) : [];
    const queued = this.queue.list().filter((j) => j.params.output_dir === output_dir).map((j) => Number(j.params.file_stem.match(/\d+/)?.[0] ?? 0));
    const offset = Math.max(0, ...onDisk, ...queued);
    const jobs: Job[] = [];
    for (const [i, { chain_previous, technique, ...scene }] of scenes.entries()) {
      const phrase = technique ? techniqueById(technique)!.phrase : "";
      jobs.push(
        this.queue.add({
          ...scene,
          prompt: phrase ? `${scene.prompt.trim().replace(/\.?$/, ".")} ${phrase}` : scene.prompt,
          chain_from: chain_previous ? jobs[i - 1].id : undefined,
          output_dir,
          file_stem: `scene-${String(offset + i + 1).padStart(2, "0")}`,
        }),
      );
    }
    return { output_dir, jobs: jobs.map(jobView) };
  }

  async wait({ job_ids, timeout_seconds }: Args<"wait">) {
    const pick = () => (job_ids ? job_ids.map((id) => this.queue.get(id)).filter((j): j is Job => Boolean(j)) : this.queue.list());
    const deadline = Date.now() + timeout_seconds * 1000;
    while (Date.now() < deadline && pick().some((j) => j.status === "queued" || j.status === "running")) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    const jobs = pick();
    return {
      finished: jobs.every((j) => j.status !== "queued" && j.status !== "running"),
      pacing: this.queue.pausedReason,
      jobs: jobs.map(jobView),
    };
  }

  async cancel({ job_id }: Args<"cancel">) {
    const job = this.queue.cancel(job_id);
    if (!job) throw new Error(`No job with id ${job_id}. Use flow_status to list jobs.`);
    return jobView(job);
  }

  async assets({ kind }: Args<"assets">) {
    if (this.queue.busy) throw new Error(BUSY);
    return (await listAssets()).filter((a) => !kind || a.kind === kind).map(({ name, kind }) => ({ name, kind }));
  }

  async download({ project, assets, quality }: Args<"download">) {
    if (this.queue.busy) throw new Error(BUSY);
    const dir = projectDir(project);
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    for (const [i, name] of assets.entries()) {
      try {
        files.push(await downloadAsset(name, join(dir, `clip-${String(i + 1).padStart(2, "0")}`), quality));
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : err} (downloaded so far: ${files.length})`);
      }
    }
    return { dir, files };
  }

  async assemble({ project, ...rest }: Args<"assemble">) {
    return assemble({ dir: projectDir(project), ...rest });
  }

  // Everything already downloaded, newest project first, so the panel can show past work after a restart.
  async outputs() {
    if (!existsSync(OUTPUT_ROOT)) return { root: OUTPUT_ROOT, projects: [] };
    const media = /\.(mp4|webm|mov|gif|jpe?g|png|webp)$/i;
    const projects = readdirSync(OUTPUT_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const dir = join(OUTPUT_ROOT, d.name);
        const files = readdirSync(dir)
          .filter((f) => media.test(f) && !f.endsWith("-lastframe.jpg"))
          .map((f) => ({ name: f, path: join(dir, f), kind: /\.(mp4|webm|mov)$/i.test(f) ? "video" : "image", mtime: statSync(join(dir, f)).mtimeMs }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { name: d.name, dir, files, mtime: Math.max(0, ...files.map((f) => f.mtime)) };
      })
      .filter((p) => p.files.length)
      .sort((a, b) => b.mtime - a.mtime);
    return { root: OUTPUT_ROOT, projects };
  }

  private nextStem(output_dir: string, prefix: string): string {
    const onDisk = existsSync(output_dir) ? readdirSync(output_dir).map((f) => Number(f.match(new RegExp(`^${prefix}-(\\d+)`))?.[1] ?? 0)) : [];
    const queued = this.queue.list().filter((j) => j.params.output_dir === output_dir && j.params.file_stem.startsWith(prefix)).map((j) => Number(j.params.file_stem.match(/\d+/)?.[0] ?? 0));
    return `${prefix}-${String(Math.max(0, ...onDisk, ...queued) + 1).padStart(2, "0")}`;
  }

  async agent({ project, scenes, aspect_ratio, download_quality }: Args<"agent">) {
    const output_dir = projectDir(project);
    const job = this.queue.add({
      prompt: `Agent batch: ${scenes.length} images`,
      type: "image",
      max_credits: 0,
      aspect_ratio,
      download_quality,
      agent_scenes: scenes,
      output_dir,
      file_stem: this.nextStem(output_dir, "scene"),
    });
    return { output_dir, jobs: [jobView(job)] };
  }

  async edit({ project, asset, prompt, download_quality }: Args<"edit">) {
    const output_dir = projectDir(project);
    const job = this.queue.add({ prompt, type: "video", max_credits: 0, edit_asset: asset, download_quality, output_dir, file_stem: this.nextStem(output_dir, "edit") });
    return { output_dir, jobs: [jobView(job)] };
  }

  async character(a: Args<"character">) {
    if (this.queue.busy) throw new Error(BUSY);
    return { ...(await createCharacter(a)), use_as: `asset:${a.name}` };
  }

  async techniques({ category }: Args<"techniques">) {
    return TECHNIQUES.filter((t) => !category || t.category === category);
  }
}

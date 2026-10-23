import { randomUUID } from "node:crypto";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface SceneParams {
  prompt: string;
  type: "video" | "image";
  max_credits: number;
  duration?: 4 | 6 | 8 | 10;
  resolution?: "360p" | "720p";
  model?: string;
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  variants?: number;
  first_frame?: string;
  last_frame?: string;
  reference_images?: string[];
  chain_from?: string;
  reference_from?: string;
  edit_asset?: string;
  agent_scenes?: string[];
  // The scene number each agent scene is saved as. A retry of scenes 7 and 12 keeps scene-07 and scene-12; without it
  // the numbers run on from file_stem.
  agent_numbers?: number[];
  // Reference images for an agent batch: attached once as ingredients in the agent composer (absolute paths, uploaded
  // once, or "asset:<title>"), with a short name each, plus which of them every scene uses (names, per scene).
  agent_refs?: { image: string; name: string }[];
  agent_scene_refs?: string[][];
  // Flow asset names of agent_refs after upload, so a retry round re-attaches without uploading again.
  agent_ref_assets?: string[];
  continue_from?: string;
  attach?: string[];
  continue_mode?: "exact" | "likeness";
  retries?: number;
  // Image scene sent with the queued ones after it without waiting for each to finish (flow_generate parallel_images).
  parallel?: boolean;
  download_quality?: "original" | "upscaled";
  output_dir: string;
  file_stem: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  params: SceneParams;
  files: string[];
  attempts: number;
  credits?: number;
  progress?: string;
  note?: string;
  error?: string;
  // Scene numbers a batch still could not make after all its own retries; flow_retry redoes just these.
  failed_scenes?: number[];
  createdAt: string;
  finishedAt?: string;
}

export type JobRunner = (job: Job) => Promise<string[]>;
// Sends several image scenes one after another without waiting for each, then collects them; one result per job.
export type BatchRunner = (jobs: Job[]) => Promise<(string[] | Error)[]>;

// Flow is driven like a careful person would: one generation at a time, with a
// randomised pause between them. Image scenes marked parallel go out together, as a person does by hand (the pause
// between their sends lives in the driver), and the pause below then comes before the next batch.
const PAUSE_MIN_MS = Number(process.env.FLOW_MCP_PAUSE_MIN_S ?? 25) * 1000;
const PAUSE_MAX_MS = Number(process.env.FLOW_MCP_PAUSE_MAX_S ?? 70) * 1000;
// shortcut: a batch counts on its new tiles staying in the part of the grid Flow keeps mounted at the top (30+ tiles
// seen); a bigger batch would need a scrolling walk to find them all.
const BATCH_MAX = 6;

export class JobQueue {
  private jobs = new Map<string, Job>();
  private working = false;
  private lastFinished = 0;
  pausedReason: string | null = null;

  constructor(
    private runner: JobRunner,
    private batchRunner?: BatchRunner,
  ) {}

  add(params: SceneParams): Job {
    const job: Job = {
      id: randomUUID().slice(0, 8),
      status: "queued",
      params,
      files: [],
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    // Started on the next turn of the event loop, once the caller has queued the rest of its scenes: started at once,
    // the first scene ran alone and a parallel batch never formed (2026-10-23).
    setImmediate(() => void this.work());
    return job;
  }

  get busy(): boolean {
    return this.list().some((j) => j.status === "running");
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  // Puts a failed or cancelled job back in line with the same settings and file name.
  retry(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job && (job.status === "failed" || job.status === "cancelled")) {
      job.status = "queued";
      job.error = undefined;
      job.finishedAt = undefined;
      void this.work();
    }
    return job;
  }

  cancel(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job && job.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
    }
    return job;
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        const job = this.list().find((j) => j.status === "queued");
        if (!job) return;
        if (this.lastFinished) {
          const pause = PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS);
          const remaining = this.lastFinished + pause - Date.now();
          if (remaining > 0) {
            this.pausedReason = `pacing: next generation in ${Math.ceil(remaining / 1000)}s`;
            await new Promise((r) => setTimeout(r, remaining));
            this.pausedReason = null;
          }
        }
        if (job.status !== "queued") continue;
        const batch = this.together();
        if (batch.length > 1) {
          for (const j of batch) {
            j.status = "running";
            j.attempts++;
          }
          // A whole-batch failure may come after some images were sent: those are in Flow (free), not lost.
          const results = await this.batchRunner!(batch).catch((err: unknown) => batch.map(() => (err instanceof Error ? err : new Error(String(err)))));
          for (const [i, j] of batch.entries()) {
            const r = results[i];
            if (r instanceof Error) {
              j.error = r.message;
              j.status = "failed";
            } else {
              j.files = r;
              j.error = undefined;
              j.status = "done";
            }
            j.finishedAt = new Date().toISOString();
          }
          this.lastFinished = Date.now();
          continue;
        }
        job.status = "running";
        job.attempts++;
        try {
          job.files = await this.runner(job);
          job.status = "done";
          job.error = undefined;
        } catch (err) {
          job.error = err instanceof Error ? err.message : String(err);
          // Failed tiles are already retried inside Flow (its own Retry button); only an agent that produced nothing
          // is re-queued here. Timeouts are never retried automatically: they may still have spent credits.
          const retryable = /agent finished without creating/i.test(job.error);
          job.status = retryable && job.attempts <= (job.params.retries ?? 1) ? "queued" : "failed";
        }
        job.finishedAt = new Date().toISOString();
        this.lastFinished = Date.now();
      }
    } finally {
      this.working = false;
    }
  }

  // The run of queued parallel image scenes that starts with the next job in line (just that job otherwise).
  private together(): Job[] {
    const queued = this.list().filter((j) => j.status === "queued");
    if (!this.batchRunner || !queued[0]?.params.parallel) return queued.slice(0, 1);
    const end = queued.findIndex((j) => !j.params.parallel);
    return queued.slice(0, end < 0 ? BATCH_MAX : Math.min(end, BATCH_MAX));
  }
}

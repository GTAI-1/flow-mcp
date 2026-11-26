import { randomUUID } from "node:crypto";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface SceneParams {
  prompt: string;
  type: "video" | "image";
  max_credits: number;
  duration?: number;
  resolution?: "360p" | "720p";
  model?: string;
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  variants?: number;
  first_frame?: string;
  first_frame_at?: number;
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
  download_quality?: "original" | "720p" | "1080p" | "upscaled";
  concurrency?: number;
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
export type BatchRunner = (jobs: Job[], concurrency: number) => Promise<void>;

// Flow is driven like a careful person would: by default one generation at a time, with a
// randomised pause between them. Opt-in concurrency (2-4) overlaps independent scenes in Flow's
// normal composer (Agent off), while chained scenes remain strictly serial.
const PAUSE_MIN_MS = Number(process.env.FLOW_MCP_PAUSE_MIN_S ?? 25) * 1000;
const PAUSE_MAX_MS = Number(process.env.FLOW_MCP_PAUSE_MAX_S ?? 70) * 1000;
export const DEFAULT_CONCURRENCY = Math.max(1, Math.min(4, Math.floor(Number(process.env.FLOW_MCP_CONCURRENCY ?? 1)) || 1));

function effectiveConcurrency(job: Job): number {
  const n = job.params.concurrency ?? DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(4, Math.floor(n) || 1));
}

function isParallelEligible(job: Job): boolean {
  const p = job.params;
  return (
    effectiveConcurrency(job) > 1 &&
    !p.chain_from &&
    !p.reference_from &&
    !p.continue_from &&
    !p.agent_scenes &&
    !p.edit_asset
  );
}

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
    // Defer starting the worker to a microtask so a synchronous loop of add() calls (like flow_generate) finishes
    // enqueuing the whole batch before work() inspects the queue for parallel grouping.
    queueMicrotask(() => void this.work());
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
      queueMicrotask(() => void this.work());
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
        const queued = this.list().filter((j) => j.status === "queued");
        const job = queued[0];
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

        // Collect a contiguous run of independent parallel-eligible jobs so one coordinator drives Flow's composer
        // with up to `concurrency` renders in flight while respecting chained/serial barriers.
        if (this.batchRunner && isParallelEligible(job)) {
          const run: Job[] = [];
          const cap = effectiveConcurrency(job);
          for (const candidate of this.list()) {
            if (candidate.status !== "queued") continue;
            if (!isParallelEligible(candidate)) {
              if (run.length) break;
              continue;
            }
            if (effectiveConcurrency(candidate) !== cap) break;
            run.push(candidate);
          }
          if (run.length >= 2) {
            try {
              await this.batchRunner(run, cap);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const now = new Date().toISOString();
              for (const j of run) {
                if (j.status === "queued" || j.status === "running") {
                  j.status = "failed";
                  j.progress = undefined;
                  j.error = msg;
                  j.finishedAt = now;
                }
              }
            }
            this.lastFinished = Date.now();
            continue;
          }
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
}

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
  // Cutouts: this job redraws the white take of job <matte_from> on black, then both become one transparent PNG.
  matte_from?: string;
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
  // The account whose project holds those uploads.
  agent_ref_account?: string;
  continue_from?: string;
  attach?: string[];
  continue_mode?: "exact" | "likeness";
  retries?: number;
  download_quality?: "original" | "upscaled";
  output_dir: string;
  file_stem: string;
  // Run on this account only. Unset: whichever enabled account is free first.
  account?: string;
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
  // The account that took the job, set when it starts.
  account?: string;
  createdAt: string;
  finishedAt?: string;
}

export type JobRunner = (job: Job, account: string) => Promise<string[]>;

export interface QueueHooks {
  // The accounts that may take work, in order of preference.
  accounts: () => string[];
  // undefined when the account can generate now, otherwise what the user must do first (sign in, open a project).
  ready: (account: string) => Promise<string | undefined>;
}

// Flow is driven like a careful person would: one generation at a time PER ACCOUNT, with a randomised pause between
// them. Several accounts are several people, each at their own Chrome, all working at once from one shared line.
const PAUSE_MIN_MS = Number(process.env.FLOW_MCP_PAUSE_MIN_S ?? 25) * 1000;
const PAUSE_MAX_MS = Number(process.env.FLOW_MCP_PAUSE_MAX_S ?? 70) * 1000;
// An account found not ready (signed out, no project open) is left alone this long before it is checked again.
const RECHECK_MS = 60_000;

interface Worker {
  account: string;
  working: boolean;
  lastFinished: number;
  pausedReason: string | null;
  notReady?: { hint: string; at: number };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class JobQueue {
  private jobs = new Map<string, Job>();
  private workers = new Map<string, Worker>();
  // Jobs a worker has taken but not started yet (it is still in its pause): no other worker may take them.
  private claimed = new Set<string>();

  constructor(
    private runner: JobRunner,
    private hooks: QueueHooks,
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
    this.kick();
    return job;
  }

  get busy(): boolean {
    return this.list().some((j) => j.status === "running");
  }

  // Whether this account's Chrome is in the middle of a job: direct calls (assets, characters...) must wait for it.
  busyOn(account: string): boolean {
    return this.list().some((j) => j.status === "running" && j.account !== undefined && same(j.account, account));
  }

  get pausedReason(): string | null {
    const several = this.hooks.accounts().length > 1;
    const waits = [...this.workers.values()].filter((w) => w.pausedReason).map((w) => (several ? `${w.account}: ${w.pausedReason}` : w.pausedReason));
    return waits.length ? waits.join(" · ") : null;
  }

  // What one account is doing, for flow_status and flow_accounts.
  workerView(account: string): { busy: boolean; pacing: string | null; not_ready?: string } {
    const w = this.workers.get(account);
    return { busy: this.busyOn(account), pacing: w?.pausedReason ?? null, ...(w?.notReady ? { not_ready: w.notReady.hint } : {}) };
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
      job.account = undefined;
      this.kick();
    }
    return job;
  }

  cancel(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job && job.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      this.kick();
    }
    return job;
  }

  // Wakes a worker for every enabled account; each stops by itself when there is nothing it can take.
  kick(): void {
    for (const account of this.hooks.accounts()) {
      let w = this.workers.get(account);
      if (!w) this.workers.set(account, (w = { account, working: false, lastFinished: 0, pausedReason: null }));
      if (!w.working) void this.work(w);
    }
  }

  // A job that builds on another (chain_previous, reference_previous, the black take of a cutout) waits for it: with
  // several accounts the earlier job may still be running on another one. If that one failed, this one fails with it.
  private waitingOn(job: Job): "ready" | "wait" | Job {
    const { chain_from, reference_from, matte_from } = job.params;
    for (const id of [chain_from, reference_from, matte_from]) {
      const dep = id ? this.jobs.get(id) : undefined;
      if (!dep) continue;
      if (dep.status === "failed" || dep.status === "cancelled") return dep;
      if (dep.status !== "done") return "wait";
    }
    return "ready";
  }

  // Queued jobs that can never start are failed with the reason, instead of sitting in the line forever.
  private failStuck(): void {
    const accounts = this.hooks.accounts();
    for (const job of this.list()) {
      if (job.status !== "queued" || this.claimed.has(job.id)) continue;
      const dep = this.waitingOn(job);
      const pin = job.params.account;
      let why: string | undefined;
      if (typeof dep === "object") {
        why = `It builds on job ${dep.id} (${dep.params.file_stem}), which ${dep.status === "cancelled" ? "was cancelled" : "failed"}, so it never ran. Retry that job first, then this one.`;
      } else if (pin && !accounts.some((a) => same(a, pin))) {
        why = `It is set to run on account "${pin}", which is disabled. Enable it with flow_accounts, then retry.`;
      }
      if (why) {
        job.status = "failed";
        job.error = why;
        job.finishedAt = new Date().toISOString();
      }
    }
  }

  // The next job this worker may take: one pinned to it, or an unpinned one. An account that is not ready leaves
  // unpinned work to the others - unless none is ready, when the first account takes it and fails it with the reason.
  private next(w: Worker): Job | undefined {
    const accounts = this.hooks.accounts();
    const anyReady = accounts.some((a) => !this.workers.get(a)?.notReady);
    const takesUnpinned = !w.notReady || (!anyReady && accounts[0] === w.account);
    return this.list().find((j) => {
      if (j.status !== "queued" || this.claimed.has(j.id) || this.waitingOn(j) !== "ready") return false;
      return j.params.account ? same(j.params.account, w.account) : takesUnpinned;
    });
  }

  private async work(w: Worker): Promise<void> {
    if (w.working) return;
    w.working = true;
    try {
      for (;;) {
        if (!this.hooks.accounts().includes(w.account)) return; // disabled meanwhile
        this.failStuck();
        // An account that was not ready is checked again now and then: the user may have signed it in since.
        if (w.notReady && Date.now() - w.notReady.at > RECHECK_MS) w.notReady = undefined;
        if (!w.notReady && this.list().some((j) => j.status === "queued" && !this.claimed.has(j.id))) {
          const hint = await this.hooks.ready(w.account).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
          if (hint) {
            w.notReady = { hint, at: Date.now() };
            this.kick(); // the other accounts take over what this one cannot do
          }
        }
        const job = this.next(w);
        if (!job) return;
        this.claimed.add(job.id);
        try {
          if (w.lastFinished) {
            const pause = PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS);
            const remaining = w.lastFinished + pause - Date.now();
            if (remaining > 0) {
              w.pausedReason = `pacing: next generation in ${Math.ceil(remaining / 1000)}s`;
              await new Promise((r) => setTimeout(r, remaining));
              w.pausedReason = null;
            }
          }
          if (job.status !== "queued") continue; // cancelled during the pause
          job.status = "running";
          job.account = w.account;
          job.attempts++;
        } finally {
          this.claimed.delete(job.id);
        }
        try {
          job.files = await this.runner(job, w.account);
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
        w.lastFinished = Date.now();
        this.kick(); // jobs that waited on this one may now be ready, on any account
      }
    } finally {
      w.working = false;
      w.pausedReason = null;
    }
  }
}

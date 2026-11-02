#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LocalCore, shapes, type Core } from "./core.js";
import { PLAYBOOK } from "./playbook.js";
import { RemoteCore } from "./remote.js";
import { PORT, startServer } from "./server.js";

const local = new LocalCore();
const role = await startServer(local);
const core: Core = role === "client" ? new RemoteCore() : local;
const studio = role === "none" ? undefined : `http://127.0.0.1:${PORT}`;

const server = new McpServer({ name: "flow-mcp", version: "0.2.0" });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const reply = async (work: Promise<unknown>, extra: object = {}): Promise<ToolResult> => {
  try {
    const data = await work;
    const body = Array.isArray(data) ? data : { ...(data as object), ...extra };
    return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2) }], isError: true };
  }
};

// Most AI apps stop waiting on a tool after about a minute (the MCP default, and Codex's), but Flow is often slower: a
// character edit takes one to two minutes. The work carried on while the app reported "Request timed out", so finished
// work looked failed - and a shot was once paid for twice. No call holds on longer than this now; anything slower hands
// back a task id and keeps going, and flow_wait collects the answer.
// FLOW_MCP_PATIENCE_MS lowers it for an app with a shorter limit (and lets a test reach the slow path quickly).
const PATIENCE_MS = Number(process.env.FLOW_MCP_PATIENCE_MS ?? 45_000);
const WAIT_MS = Math.max(5_000, PATIENCE_MS - 5_000);
type Task = { task_id: string; tool: string; started: string; status: "running" | "done" | "failed"; result?: unknown; error?: string };
const tasks = new Map<string, Task>();

const patient = async (tool: string, work: Promise<unknown>): Promise<unknown> => {
  const task: Task = { task_id: `task-${randomUUID().slice(0, 8)}`, tool, started: new Date().toISOString(), status: "running" };
  const settled = work.then(
    (result) => {
      task.status = "done";
      task.result = result;
    },
    (err) => {
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
    },
  );
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), PATIENCE_MS)));
  const first = await Promise.race([settled.then(() => "settled" as const), late]);
  clearTimeout(timer);
  if (first === "settled") return work;
  tasks.set(task.task_id, task);
  return {
    still_working: true,
    task_id: task.task_id,
    note: `Flow is still on it - this is not a failure. Call flow_wait with job_ids ["${task.task_id}"] for the result, and do not call ${tool} again: the work has not stopped.`,
  };
};

// Task ids are answered from here, queued job ids by the queue; either way the call comes back inside the app's limit.
async function waitFor({ job_ids, timeout_seconds }: { job_ids?: string[]; timeout_seconds: number }): Promise<unknown> {
  const deadline = Date.now() + Math.min(timeout_seconds * 1000, WAIT_MS);
  const isTask = (id: string) => tasks.has(id) || id.startsWith("task-");
  const mine = (job_ids ?? []).filter(isTask);
  const jobs = job_ids?.filter((id) => !isTask(id));
  while (Date.now() < deadline && mine.some((id) => tasks.get(id)?.status === "running")) await new Promise((r) => setTimeout(r, 1000));
  // A task id this process never issued belongs to a tool process that has since restarted: its answer is gone, but the
  // work may well have happened, so say that instead of reporting it finished.
  const done = mine.map(
    (id) =>
      tasks.get(id) ?? {
        task_id: id,
        status: "unknown",
        note: "This tool restarted since that call, so its answer is lost. Check Flow (flow_assets, flow_characters) for what it did before running it again.",
      },
  );
  const tasksFinished = done.every((t) => t.status !== "running");
  if (mine.length && !jobs?.length) return { finished: tasksFinished, tasks: done };
  const left = Math.max(5, Math.floor((deadline - Date.now()) / 1000));
  const queued = (await core.wait({ job_ids: jobs, timeout_seconds: left })) as { finished: boolean };
  return mine.length ? { ...queued, finished: queued.finished && tasksFinished, tasks: done } : queued;
}

server.registerTool(
  "flow_status",
  {
    title: "Flow status",
    description:
      "Check the Flow Chrome session (signed in, project open, plan, credits left) and the generation queue. Call this first; it says what the user must fix before generating, and returns the prompt playbook.",
    inputSchema: shapes.status,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(core.status(args), { studio, playbook: PLAYBOOK, ...(tasks.size ? { slow_calls: [...tasks.values()].map(({ result, ...t }) => t) } : {}) }),
);

server.registerTool(
  "flow_generate",
  {
    title: "Queue Flow generations",
    description:
      "Queue one clip or image per scene in the open Flow project. Runs one at a time with human-like pauses and spends the user's Google AI credits (approx. per video: Omni 1.1 Flash 7-12, Veo 3.1 Lite 10, Fast 20, Quality 100; images 0). Each scene is checked against max_credits using Flow's own quote before anything is spent. Returns job ids immediately; use flow_wait for results.",
    inputSchema: shapes.generate,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.generate(args)),
);

server.registerTool(
  "flow_wait",
  {
    title: "Wait for Flow jobs",
    description:
      "Wait for queued jobs (default: all), or for the task_id of a call that answered still_working, then return their status, results and file paths. Comes back within about 40 s even when they are still running: call again until finished is true.",
    inputSchema: shapes.wait,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(waitFor(args)),
);

server.registerTool(
  "flow_cancel",
  {
    title: "Cancel a queued Flow job",
    description: "Cancel a job that has not started yet. A running generation cannot be cancelled.",
    inputSchema: shapes.cancel,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  (args) => reply(core.cancel(args)),
);

server.registerTool(
  "flow_retry",
  {
    title: "Retry failed Flow jobs",
    description: "Put failed jobs back in the queue with the same settings and file names (default: all failed jobs). Scenes already retry once on their own when Flow reports a failure. An image batch that finished with some images still failed (its job lists failed_scenes) is not run again whole: only those images are made again, saved under their own scene numbers.",
    inputSchema: shapes.retry,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.retry(args)),
);

server.registerTool(
  "flow_assets",
  {
    title: "List project media",
    description: "List the images and videos in the open Flow project (title and kind). Titles can be used as 'asset:<title>' in flow_generate or with flow_download.",
    inputSchema: shapes.assets,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_assets", core.assets(args))),
);

server.registerTool(
  "flow_download",
  {
    title: "Download existing project media",
    description:
      "Download media that already exists in the Flow project, without regenerating it (no credits, including 1080p/2K upscales). Matches by the start of the title.",
    inputSchema: shapes.download,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_download", core.download(args))),
);

server.registerTool(
  "flow_agent_images",
  {
    title: "Fast image batch via Flow's agent",
    description:
      "Hand up to 50 image scenes to Flow's own Agent mode, which renders them all in parallel (minutes for a whole batch instead of one paced job per scene) and enriches each prompt itself. Images only, 0 credits. Pass `references` (characters, places, objects, each with a short name) to attach them once in the agent's composer, the way its + button does, and `scene_references` to say which scenes use which, so a whole story stays on-model. Scenes the agent drops are asked for again, then made one by one with their references. Less exact than flow_generate: the agent picks the wording, no techniques, and each image is matched back to its scene by its stored prompt. Returns a job id; use flow_wait.",
    inputSchema: shapes.agent,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.agent(args)),
);

server.registerTool(
  "flow_edit",
  {
    title: "Edit an existing video",
    description:
      "Video-to-video edit of a clip already in the Flow project (relight, change weather/background, remove or restyle objects) using Flow's edit view. Queued like a generation; use flow_wait for the file. Spends credits without a prior quote (about 20 for a 4 s clip), so ask the user before calling.",
    inputSchema: shapes.edit,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.edit(args)),
);

server.registerTool(
  "flow_continue",
  {
    title: "Continue a clip, keeping a character attached",
    description:
      "Start a new clip from the last frame of one already in the project, for a continuous take across a cut. It saves the source clip's real final frame, animates it through Flow's agent mode, and downloads the result. mode 'exact' (default) gives an invisible join - the clip opens on the actual last frame - but attached characters are ignored, so the likeness must come from that frame; mode 'likeness' keeps a character or your avatar locked at the cost of an only-approximate opening frame. Flow cannot do both at once. Agent mode shows no credit quote beforehand, so ask the user before calling. Queued like a generation; use flow_wait for the file.",
    inputSchema: shapes.continue_shot,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_continue", core.continue_shot(args))),
);

server.registerTool(
  "flow_trash",
  {
    title: "Move an item to Flow's Trash",
    description:
      "Move one image, video or scene in the open Flow project to Flow's Trash, by its exact title from flow_assets. Recoverable: Flow keeps it in Trash with a Restore button. Never deletes permanently. Flow asks no confirmation of its own, so confirm with the user before calling. Refuses if two items share the title.",
    inputSchema: shapes.trash,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_trash", core.trash(args))),
);

server.registerTool(
  "flow_rename",
  {
    title: "Rename an item in the Flow project",
    description:
      "Rename one image, video or scene in the open Flow project, by its exact current title from flow_assets. Use it to put a name back when something ended up mislabelled. Refuses if two items share the current title, or if the new title is already taken.",
    inputSchema: shapes.rename,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_rename", core.rename(args))),
);

server.registerTool(
  "flow_character",
  {
    title: "Create a reusable character",
    description:
      "Create a reusable Flow character (person, mascot, product) so it looks the same in every scene. Free. Give `describe` and Flow draws the portrait first, or `image` to use a picture you already have; optionally a personality and a stock voice. Afterwards pass 'asset:<name>' in a scene's reference_images.",
    inputSchema: shapes.character,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_character", core.character(args))),
);

server.registerTool(
  "flow_character_edit",
  {
    title: "Restyle an existing character",
    description:
      "Change how an existing character looks without creating a new one (Flow redraws the portrait in place, free), and save the new portrait to <films>/_cast. The character keeps its name, personality and voice, so every scene that references it picks up the new look. Pass `look` with the full updated description so scene prompts stop quoting the old one. With no `change` it only saves the current portrait.",
    inputSchema: shapes.character_edit,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_character_edit", core.character_edit(args))),
);

server.registerTool(
  "flow_characters",
  {
    title: "List characters",
    description: "List the reusable characters in the open Flow project. Each can be used in a scene as 'asset:<name>'.",
    inputSchema: shapes.characters,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  () => reply(patient("flow_characters", core.characters())),
);

server.registerTool(
  "flow_techniques",
  {
    title: "Film technique presets",
    description:
      "List ready-made prompt phrases for camera moves, product shots, first→last-frame transitions and image commands. Pass an id as a scene's `technique` in flow_generate.",
    inputSchema: shapes.techniques,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  (args) => reply(core.techniques(args)),
);

server.registerTool(
  "flow_narrate",
  {
    title: "Record narration in a Flow voice",
    description:
      "Record narration as an .m4a, free and instantly. `engine: \"gemini\"` uses Google AI Studio's text-to-speech (the same voices Flow has, needs a free key in ~/.flow-mcp/gemini-key, and takes a `style` note like 'warmly, like a documentary narrator'); `engine: \"mac\"` uses a voice installed on this computer (macOS, or Windows' built-in speech voices). Neither costs credits or caps the length. flow_assemble can lay the result over a film.",
    inputSchema: shapes.narrate,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_narrate", core.narrate(args))),
);

server.registerTool(
  "flow_voices",
  {
    title: "List Flow voices",
    description: "Narrator voices available for flow_narrate: Google AI Studio's (with whether a key is set up) and the English voices installed on this computer.",
    inputSchema: shapes.voices,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  () => reply(core.voices()),
);

server.registerTool(
  "flow_assemble",
  {
    title: "Assemble clips into one video",
    description:
      "Join a project's downloaded scene clips in order into one MP4 (local ffmpeg, no credits). Keeps each clip's own sound and can lay a music track and a voiceover on top.",
    inputSchema: shapes.assemble,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  (args) => reply(patient("flow_assemble", core.assemble(args))),
);

server.registerTool(
  "flow_transcribe",
  {
    title: "Hear the words in a video or audio file",
    description:
      "Transcribe a video or audio file on this computer with every word's start and end time (whisper.cpp, local and free, about 100 languages; pass `language` when you know it. The first call in English downloads a 148 MB speech model once, in any other language a 574 MB one). Use the times to check a take said the right words and to cut lines out of it for flow_assemble's voice_lines.",
    inputSchema: shapes.transcribe,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  (args) => reply(patient("flow_transcribe", core.transcribe(args))),
);

server.registerTool(
  "flow_captions",
  {
    title: "Add captions to a video",
    description:
      "Burn spoken-word captions into a video, in the style short-form apps use, for landscape or vertical footage (local and free: whisper.cpp hears the words on this computer, nothing is uploaded). Styles: bold (big capitals, the spoken word lights up), highlight, reveal, clean, boxed. Works in about 100 languages, including ones written without spaces (Japanese, Chinese, Thai) and right to left (Arabic, Hebrew); pass `language` (en, es, tr, ja...) whenever you know it. The first call downloads a speech model once: 148 MB for English, 574 MB for other languages. Saves <name>-captions.mp4 plus an .srt. Before calling this, call flow_transcribe, show the user the words with any likely mishearings fixed, and get their OK: then pass the agreed words as `text` (matching words keep their timing), so the video is made once, right.",
    inputSchema: shapes.captions,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  (args) => reply(patient("flow_captions", core.captions(args))),
);

await server.connect(new StdioServerTransport());

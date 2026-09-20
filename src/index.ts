#!/usr/bin/env node
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

server.registerTool(
  "flow_status",
  {
    title: "Flow status",
    description:
      "Check the Flow Chrome session (signed in, project open, plan, credits left) and the generation queue. Call this first; it says what the user must fix before generating, and returns the prompt playbook.",
    inputSchema: shapes.status,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(core.status(args), { studio, playbook: PLAYBOOK }),
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
    description: "Block until the given jobs (default: all) finish or the timeout passes, then return their status and file paths.",
    inputSchema: shapes.wait,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(core.wait(args)),
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
  "flow_assets",
  {
    title: "List project media",
    description: "List the images and videos in the open Flow project (title and kind). Titles can be used as 'asset:<title>' in flow_generate or with flow_download.",
    inputSchema: shapes.assets,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(core.assets(args)),
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
  (args) => reply(core.download(args)),
);

server.registerTool(
  "flow_agent_images",
  {
    title: "Fast image batch via Flow's agent",
    description:
      "Hand up to 50 image scenes to Flow's own Agent mode, which renders them all in parallel (about a minute for a whole batch) and enriches each prompt itself. Images only, 0 credits. Less exact than flow_generate: the agent picks the wording, no techniques/reference images, and file order is best-effort. Use flow_generate when every scene needs exact settings. Returns a job id; use flow_wait.",
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
  "flow_character",
  {
    title: "Create a reusable character",
    description:
      "Create a Flow character (person, mascot or product) from one image, optionally with a personality and a voice, so it stays consistent across scenes. Free. Afterwards pass 'asset:<name>' in a scene's reference_images.",
    inputSchema: shapes.character,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.character(args)),
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
  "flow_assemble",
  {
    title: "Assemble clips into one video",
    description:
      "Join a project's downloaded scene clips in order into one MP4 (local ffmpeg, no credits). Keeps each clip's own sound and can lay a music track and a voiceover on top.",
    inputSchema: shapes.assemble,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  (args) => reply(core.assemble(args)),
);

await server.connect(new StdioServerTransport());

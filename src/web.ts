#!/usr/bin/env node
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { LocalCore, shapes, type Core } from "./core.js";
import { RemoteCore } from "./remote.js";
import { startServer } from "./server.js";
import { createPairingCode, PairingProvider, signOutAll } from "./web-auth.js";
import {
  config, confirmOnComputer, GREEN, listReferences, onGreen, preview, recentResults, record, rememberResults, resolveId, saveConfig, settle, spentToday, videoCost,
} from "./web-policy.js";

// The web connector: a deliberately small set of Flow tools over Streamable HTTP, for Claude on the web (Claude Design
// included). It listens on this computer only; a tunnel such as Tailscale Funnel gives it its public https address.

const WEB_PORT = Number(process.env.FLOW_WEB_PORT ?? 8790);

const [command, ...rest] = process.argv.slice(2);
if (command === "pair") {
  console.log(`\nAccess code (valid for 10 minutes, one use):\n\n    ${createPairingCode()}\n`);
  process.exit(0);
}
if (command === "logout") {
  signOutAll();
  console.log("Todos os acessos ao conector foram removidos.");
  process.exit(0);
}
if (command === "setup") {
  const c = config();
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (flag === "--url" && value) c.public_url = new URL(value).origin;
    else if (flag === "--folder" && value && existsSync(value)) c.folders = [...new Set([...c.folders, value])];
    else throw new Error(`Unknown option or missing folder: ${flag} ${value ?? ""}`);
  }
  saveConfig(c);
  console.log(JSON.stringify(c, null, 2));
  process.exit(0);
}

const publicUrl = new URL(process.env.FLOW_WEB_URL ?? config().public_url ?? `http://127.0.0.1:${WEB_PORT}`);
const resourceUrl = new URL("/mcp", publicUrl);
const provider = new PairingProvider(resourceUrl.href);

let core: Core | undefined;
const flow = async (): Promise<Core> => {
  if (!core) {
    const local = new LocalCore();
    core = (await startServer(local)) === "client" ? new RemoteCore() : local;
  }
  return core;
};

// Links to a result's file: signed, for one id, and short-lived. The key changes on every restart.
const linkKey = randomBytes(32);
const sign = (id: string, exp: number) => createHmac("sha256", linkKey).update(`${id}|${exp}`).digest("base64url");
const linkFor = (id: string) => {
  const exp = Date.now() + 60 * 60_000;
  return new URL(`/files?${new URLSearchParams({ id, exp: String(exp), sig: sign(id, exp) })}`, publicUrl).href;
};
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };
const text = (data: unknown): Content => ({ type: "text", text: JSON.stringify(data, null, 2) });
const answer = async (work: () => Promise<Content[]>) => {
  try {
    return { content: await work() };
  } catch (err) {
    return { content: [text({ error: err instanceof Error ? err.message : String(err) })], isError: true };
  }
};

type JobView = { id: string; status: string; credits?: number; files: string[]; error?: string; note?: string; progress?: string; prompt: string };
// What Claude gets to see of a job: ids instead of paths, and the day's spending brought up to date.
const publicJob = ({ id, status, credits, files, error, note, progress, prompt }: JobView) => {
  if (status === "done" && credits !== undefined) settle(id, credits);
  if (status === "cancelled" || (status === "failed" && /Nothing was generated/i.test(error ?? ""))) settle(id, 0);
  const hide = (s?: string) => s?.replace(/(\/Users|\/home|[A-Z]:\\)[^\s"']+/g, "<local file>");
  return { id, status, credits, progress, note: hide(note), error: hide(error), prompt: prompt.slice(0, 200), files: status === "done" ? rememberResults(id, files) : [] };
};

const project = z.string().regex(/^[\w .-]{1,60}$/).describe("Short folder name for the results, e.g. 'RippyPoses'.");
const refs = z.array(z.string()).max(3).optional().describe("Reference pictures: 'ref:...' or 'result:...' ids from flow_library, or 'asset:<title>' for something already in the Flow project.");
const reference = (r: string) => (r.startsWith("asset:") ? r : resolveId(r));
const greenRule = `The background is one flat, solid, uniform chroma green (${GREEN}) filling the whole frame, with no floor, shadow, gradient, scenery or props that are not asked for, and no green anywhere on the character.`;

// Over-limit requests are asked one at a time, and the budget is checked and taken in one step.
let turn: Promise<unknown> = Promise.resolve();
const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
  const next = turn.then(work, work);
  turn = next.catch(() => {});
  return next;
};

function build(): McpServer {
  const server = new McpServer({ name: "flow", version: "0.1.0" });

  server.registerTool(
    "flow_status",
    { title: "Flow status", description: "Check that Google Flow is signed in with a project open, and see the queue and the credit limits. Call this first.", inputSchema: {}, annotations: { readOnlyHint: true } },
    () =>
      answer(async () => {
        const s = (await (await flow()).status({ detailed: false })) as { flow: unknown; pacing: string | null; jobs: JobView[] };
        const c = config();
        return [text({ flow: s.flow, pacing: s.pacing, jobs: s.jobs.slice(-10).map(publicJob), credits: { per_clip_limit: c.max_per_clip, daily_limit: c.max_per_day, used_today_through_this_connector: spentToday() } })];
      }),
  );

  server.registerTool(
    "flow_library",
    {
      title: "Reference pictures and results",
      description: "List the reference pictures the owner shared with this connector (ids starting 'ref:', e.g. the canonical mascot stills) and the most recent results ('result:'). Use these ids as references and start images.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => answer(async () => [text({ references: listReferences(), recent_results: recentResults() })]),
  );

  server.registerTool(
    "flow_image",
    {
      title: "Make an image (free)",
      description:
        "Generate a still with Google Flow's Nano Banana (0 credits). To draw an existing character, pass its still in `references` and say in the prompt to keep it identical. Set green_screen for cut-outs. Returns a job id: call flow_wait, then flow_get for the picture.",
      inputSchema: {
        project,
        prompt: z.string().min(1).max(4000).describe("In English."),
        references: refs,
        aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).default("1:1"),
        green_screen: z.boolean().default(false).describe("Flat chroma-green background, for removing it afterwards."),
        variants: z.number().int().min(1).max(4).default(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ project, prompt, references, aspect_ratio, green_screen, variants }) =>
      answer(async () => {
        const args = z.object(shapes.generate).parse({
          project,
          scenes: [{ type: "image", prompt: green_screen ? `${prompt}\n\n${greenRule}` : prompt, aspect_ratio, variants, max_credits: 0, retries: 0, reference_images: references?.map(reference) }],
        });
        const out = (await (await flow()).generate(args)) as { jobs: JobView[] };
        return [text({ jobs: out.jobs.map(publicJob) })];
      }),
  );

  server.registerTool(
    "flow_video",
    {
      title: "Animate or make a video (spends credits)",
      description:
        "Generate a clip with Omni 1.2 Flash. Costs Google AI credits: 720p is 3 a second up to 10 s and 6 a second after; 360p is a third (use it for drafts). Tell the user the cost and get their OK before calling. Above the per-clip or daily limit, a dialog on the owner's computer must be approved. To animate a character, pass its still as start_image with green_screen and loop. A clip with a start image cannot also take references. Returns a job id: call flow_wait until finished.",
      inputSchema: {
        project,
        prompt: z.string().min(1).max(4000).describe("In English. Describe the motion as one continuous sentence, and say what you want to see rather than what to avoid."),
        start_image: z.string().optional().describe("'ref:' or 'result:' id of the first frame."),
        loop: z.boolean().default(false).describe("End on the start image too, for a looping animation."),
        references: refs,
        green_screen: z.boolean().default(false).describe("Lays the start image on flat chroma green first (its transparency is kept as drawn) and asks for a green background."),
        duration: z.number().int().min(3).max(15).default(4),
        resolution: z.enum(["360p", "720p"]).default("720p"),
        aspect_ratio: z.enum(["16:9", "9:16"]).default("9:16"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (a) =>
      answer(async () => {
        if (a.loop && !a.start_image) throw new Error("loop needs a start_image.");
        if (a.start_image && a.references?.length) throw new Error("Flow takes a start image or references on one clip, not both.");
        let first = a.start_image ? resolveId(a.start_image) : undefined;
        if (first && !/\.(png|jpe?g|webp)$/i.test(first)) throw new Error("start_image must be a picture.");
        if (first && a.green_screen) first = await onGreen(first, a.aspect_ratio);
        const cost = videoCost(a.duration, a.resolution);
        const scene = {
          type: "video" as const,
          model: "Omni 1.2 Flash",
          prompt: a.green_screen ? `${a.prompt}\n\n${greenRule}` : a.prompt,
          duration: a.duration,
          resolution: a.resolution,
          aspect_ratio: a.aspect_ratio,
          max_credits: cost,
          retries: 0,
          first_frame: first,
          last_frame: a.loop ? first : undefined,
          reference_images: a.references?.map(reference),
        };
        const args = z.object(shapes.generate).parse({ project: a.project, scenes: [scene] });
        const target = await flow();
        return oneAtATime(async () => {
          const c = config();
          const used = spentToday();
          const over = [cost > c.max_per_clip && `above the limit of ${c.max_per_clip} per clip`, used + cost > c.max_per_day && `over the limit of ${c.max_per_day} per day (already used: ${used})`].filter(Boolean);
          if (over.length && !(await confirmOnComputer(`Claude (web connector) wants to spend ${cost} Flow credits, ${over.join(" and ")}.\n\n${a.duration} s, ${a.resolution}:\n${a.prompt.slice(0, 300)}`))) {
            throw new Error(`Not generated, nothing spent: ${cost} credits is over the limit (${c.max_per_clip} per clip, ${c.max_per_day} per day, ${used} used today) and it was not approved on the owner's computer. Offer a shorter or 360p clip, or ask the owner to click Allow when the dialog appears and call again.`);
          }
          const out = (await target.generate(args)) as { jobs: JobView[] };
          for (const j of out.jobs) record(j.id, cost);
          return [text({ expected_credits: cost, jobs: out.jobs.map(publicJob) })];
        });
      }),
  );

  server.registerTool(
    "flow_wait",
    { title: "Wait for a job", description: "Wait up to 40 s for jobs and report them. Call again until finished is true. Never start the same generation again because a job is slow.", inputSchema: { job_ids: z.array(z.string()).min(1) }, annotations: { readOnlyHint: true } },
    ({ job_ids }) =>
      answer(async () => {
        const out = (await (await flow()).wait({ job_ids, timeout_seconds: 40 })) as { finished: boolean; pacing: string | null; jobs: JobView[] };
        const missing = job_ids.filter((id) => !out.jobs.some((j) => j.id === id));
        return [text({ finished: out.finished && !missing.length, pacing: out.pacing, jobs: out.jobs.map(publicJob), ...(missing.length ? { unknown_jobs: missing, warning: "These jobs are not in the queue (it may have restarted). They may still have run and spent credits: check flow_assets before generating again." } : {}) })];
      }),
  );

  server.registerTool(
    "flow_get",
    {
      title: "Fetch a picture or video",
      description:
        "Get a reference or result by id. as='preview' (default) is a small picture to look at: for a video, nine frames in a grid. as='file' returns the original file itself, to save as a design asset: save the returned bytes, never redraw the picture. A temporary download link is included too.",
      inputSchema: { id: z.string(), as: z.enum(["preview", "file"]).default("preview") },
      annotations: { readOnlyHint: true },
    },
    ({ id, as }) =>
      answer(async () => {
        const file = resolveId(id);
        const mimeType = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
        const info = { id, name: basename(file), mimeType, bytes: statSync(file).size, download_url: linkFor(id) };
        if (as === "preview") return [{ type: "image", data: (await preview(file)).toString("base64"), mimeType: "image/jpeg" }, text(info)];
        if (info.bytes > 20 * 1024 * 1024) return [text({ ...info, note: "Too large to send inline; use download_url." })];
        const blob = readFileSync(file).toString("base64");
        return [mimeType.startsWith("image/") ? { type: "image", data: blob, mimeType } : { type: "resource", resource: { uri: `flow://${id}`, mimeType, blob } }, text(info)];
      }),
  );

  server.registerTool(
    "flow_assets",
    { title: "List Flow project media", description: "Titles of the images and videos in the open Flow project. Fails while a job is running.", inputSchema: { kind: z.enum(["image", "video", "scene"]).optional() }, annotations: { readOnlyHint: true } },
    ({ kind }) => answer(async () => [text(await (await flow()).assets({ kind }))]),
  );

  return server;
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback");

const allowedHosts = new Set([publicUrl.host, `127.0.0.1:${WEB_PORT}`, `localhost:${WEB_PORT}`]);
app.use((req, res, next) => (allowedHosts.has(req.headers.host ?? "") ? next() : void res.status(403).end()));

app.use(mcpAuthRouter({ provider, issuerUrl: new URL(publicUrl.origin), resourceServerUrl: resourceUrl, resourceName: "flow-mcp" }));

app.post("/approve", rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }), express.urlencoded({ extended: false }), (req, res) =>
  provider.approve(String(req.body?.request ?? ""), String(req.body?.code ?? ""), res),
);

app.get("/files", (req, res) => {
  const id = String(req.query.id ?? "");
  const exp = Number(req.query.exp);
  const given = Buffer.from(String(req.query.sig ?? ""));
  const good = Buffer.from(sign(id, exp));
  if (!(exp > Date.now()) || given.length !== good.length || !timingSafeEqual(given, good)) return void res.status(403).end();
  try {
    const file = resolveId(id);
    res.type(MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
    res.sendFile(file, { dotfiles: "allow" });
  } catch {
    res.status(404).end();
  }
});

const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl), expectedResource: resourceUrl });
app.all("/mcp", bearer, express.json({ limit: "1mb" }), async (req, res) => {
  if (req.method !== "POST") return void res.status(405).end();
  const server = build();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(WEB_PORT, "127.0.0.1", (err?: Error) => {
  if (err) {
    console.error(`flow-mcp web: ${err.message}`);
    process.exit(1);
  }
  console.log(`flow-mcp web: listening on 127.0.0.1:${WEB_PORT}, public address ${resourceUrl.href}`);
});

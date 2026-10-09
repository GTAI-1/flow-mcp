import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { freePort } from "./chrome.js";
import { CONFIG, HOME_DIR, TOKEN_FILE, claimState, clearState, health, readState, writeState, type OwnerKind, type OwnerState } from "./config.js";
import { OUTPUT_ROOT, shapes, type Core } from "./core.js";

export { TOKEN_FILE };
// The port the panel is on. It starts as the one asked for and is updated by startServer() to the one really in use:
// the next free port when the wanted one belongs to another program, or the owner's port when this process is a client.
export let PORT = CONFIG.port;
const UPLOAD_DIR = join(HOME_DIR, "uploads");
const STUDIO_HTML = fileURLToPath(new URL("../studio/index.html", import.meta.url));
const MAX_UPLOAD = 200 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".gif": "image/gif",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
};

const json = (res: ServerResponse, code: number, data: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
};

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new Error("Body too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

const inside = (file: string, dir: string) => resolve(file).startsWith(resolve(dir) + sep);

function sendMedia(req: IncomingMessage, res: ServerResponse, file: string) {
  if (!(inside(file, OUTPUT_ROOT) || inside(file, UPLOAD_DIR)) || !existsSync(file)) return json(res, 404, { error: "Not found." });
  const { size } = statSync(file);
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
  createReadStream(file).pipe(res);
}

export type ServerRole = "owner" | "client" | "none";

// Who holds a port: another flow-mcp, an unrelated program, or something that never answered.
// Who has it matters enormously: becoming a second LOCAL core means two processes drive the same Flow tab with separate
// queues, which is how a shot got generated and charged twice while flow_status reported an empty queue (2026-09-20).
// Claude Desktop starts several of these at once and the owner is often still booting, or busy inside a Playwright
// call, so one 2 s health check timing out proves nothing.
async function holderOf(port: number): Promise<"flow-mcp" | "other" | "unknown"> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const other = await health(port);
    if (other?.name === "flow-mcp") return "flow-mcp";
    // A valid answer from something that is NOT us means the port belongs to an unrelated program.
    if (other) return "other";
    await new Promise((r) => setTimeout(r, 1500));
  }
  return "unknown";
}

// Serves the Studio panel and a JSON API on localhost. Returns "client" when another flow-mcp process is already
// serving it (that process owns the Flow tab and the queue). When the wanted port belongs to an unrelated program the
// next free one is used instead; "none" means no port could be had at all.
export async function startServer(core: Core, kind: OwnerKind = "mcp"): Promise<ServerRole> {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const token = randomBytes(24).toString("hex");
  const busy = () => Boolean((core as { busy?: boolean }).busy);

  // A flow-mcp that is already serving this folder is the owner, whichever port it ended up on.
  // Its process is alive, so only a clear "that port is someone else's, or nobody's" says otherwise; an owner too busy
  // to answer is still the owner.
  const serving = async (s: OwnerState | null) => {
    if (!s || s.pid === process.pid) return false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const answer = await health(s.port);
      if (answer) return answer.pid === s.pid;
      if (await freePort(s.port, 1).then(() => true, () => false)) return false;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return true;
  };
  const running = readState();
  if (await serving(running)) {
    PORT = running!.port;
    return "client";
  }

  const server = createServer(async (req, res) => {
    try {
      // The Host check blocks DNS-rebinding; the token blocks other local pages from driving the queue.
      if (req.headers.host !== `127.0.0.1:${PORT}` && req.headers.host !== `localhost:${PORT}`) return json(res, 403, { error: "Bad host." });
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { name: "flow-mcp", pid: process.pid, kind, busy: busy() });
      if (url.pathname === "/favicon.ico") return void res.writeHead(204).end();
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(readFileSync(STUDIO_HTML, "utf8").replace("__FLOW_TOKEN__", token));
      }

      const given = req.headers["x-flow-token"] ?? url.searchParams.get("token");
      if (given !== token) return json(res, 401, { error: "Missing or wrong token." });

      if (req.method === "GET" && url.pathname === "/media") return sendMedia(req, res, url.searchParams.get("path") ?? "");

      if (req.method === "POST" && url.pathname === "/api/upload") {
        const name = basename(url.searchParams.get("name") ?? "upload").replace(/[^\w.-]+/g, "_");
        const path = join(UPLOAD_DIR, `${randomBytes(4).toString("hex")}-${name}`);
        writeFileSync(path, await readBody(req, MAX_UPLOAD));
        return json(res, 200, { path });
      }

      // `flow-studio stop` ends a panel it or the user started. One that belongs to an assistant is never stopped from
      // outside: the assistant started it and is still using it.
      if (req.method === "POST" && url.pathname === "/api/shutdown") {
        if (kind === "mcp") return json(res, 403, { error: "This Flow Studio belongs to an AI assistant. Quit the assistant to stop it." });
        json(res, 200, { stopping: true });
        return void setTimeout(() => process.exit(0), 100);
      }

      const method = url.pathname.match(/^\/api\/(\w+)$/)?.[1] as keyof Core | undefined;
      if (req.method === "POST" && method && typeof core[method] === "function") {
        const raw = (await readBody(req, 1024 * 1024)).toString() || "{}";
        const shape = (shapes as Record<string, z.ZodRawShape>)[method];
        const args = shape ? z.object(shape).parse(JSON.parse(raw)) : undefined;
        return json(res, 200, await (core[method] as (a: unknown) => Promise<unknown>)(args));
      }
      json(res, 404, { error: "Not found." });
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err instanceof Error ? err.message : String(err);
      json(res, 400, { error: message });
    }
  });

  const listen = (port: number) =>
    new Promise<boolean>((ok) => {
      server.once("error", () => ok(false));
      server.listen(port, "127.0.0.1", () => {
        server.removeAllListeners("error");
        ok(true);
      });
    });

  const wanted = PORT;
  for (let port = wanted; port < wanted + 20 && port <= 65535; port++) {
    PORT = port;
    if (await listen(port)) {
      const me: OwnerState = { pid: process.pid, port, kind, started: new Date().toISOString() };
      const other = claimState(me);
      if (other) {
        // Another process claimed the folder in the same instant. If it really is serving, step back and use it.
        if (await serving(other)) {
          await new Promise((r) => server.close(r));
          PORT = other.port;
          return "client";
        }
        writeState(me);
      }
      writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
      // Leave no note behind saying this process is still serving.
      process.on("exit", () => clearState(process.pid));
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => process.exit(0));
      return "owner";
    }
    const holder = await holderOf(port);
    if (holder === "flow-mcp") return "client";
    // Never confirmed, but something holds the port and it is most likely a busy sibling. Defer to it: a client whose
    // calls fail loudly is far better than a second process silently spending the user's credits.
    if (holder === "unknown") return "client";
  }
  PORT = wanted;
  return "none";
}

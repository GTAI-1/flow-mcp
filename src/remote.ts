import { readFileSync } from "node:fs";
import type { Core } from "./core.js";
import { PORT, TOKEN_FILE } from "./server.js";

// Used when another flow-mcp process (Studio or a second Claude client) already owns the Flow tab and queue.
async function call(method: string, args: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-flow-token": readFileSync(TOKEN_FILE, "utf8").trim() },
    body: JSON.stringify(args ?? {}),
  });
  const data = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `flow-mcp owner process answered ${res.status}`);
  return data;
}

export class RemoteCore implements Core {
  status = (a: unknown) => call("status", a);
  generate = (a: unknown) => call("generate", a);
  cancel = (a: unknown) => call("cancel", a);
  retry = (a: unknown) => call("retry", a);
  assets = (a: unknown) => call("assets", a);
  download = (a: unknown) => call("download", a);
  assemble = (a: unknown) => call("assemble", a);
  techniques = (a: unknown) => call("techniques", a);
  character = (a: unknown) => call("character", a);
  characters = () => call("characters", {});
  character_edit = (a: unknown) => call("character_edit", a);
  edit = (a: unknown) => call("edit", a);
  agent = (a: unknown) => call("agent", a);
  outputs = () => call("outputs", {});

  // Long waits are split up so no single HTTP request outlives fetch's header timeout.
  async wait(a: { job_ids?: string[]; timeout_seconds: number }): Promise<unknown> {
    const deadline = Date.now() + a.timeout_seconds * 1000;
    for (;;) {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      const out = (await call("wait", { ...a, timeout_seconds: Math.max(5, Math.min(120, left)) })) as { finished: boolean };
      if (out.finished || left <= 120) return out;
    }
  }
}

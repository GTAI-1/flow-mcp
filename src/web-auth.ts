import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidTargetError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { HOME_DIR } from "./chrome.js";

// OAuth for the web connector. Anyone on the internet can reach these endpoints, so registering a client gets nobody
// anything: access is only granted after the person types a one-time code that is printed on this computer
// (`npm run web:pair`). Tokens are stored as hashes.

export const WEB_DIR = join(HOME_DIR, "web");
const AUTH_FILE = join(WEB_DIR, "auth.json");
const PAIR_FILE = join(WEB_DIR, "pair.json");

// Where the authorization code may be sent. Claude's hosted apps (claude.ai, desktop, mobile) use this one.
const REDIRECTS = new Set(["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"]);

const ACCESS_S = 60 * 60;
const REFRESH_S = 90 * 24 * 60 * 60;
const CODE_MS = 5 * 60_000;
const PENDING_MS = 10 * 60_000;
const PAIR_MS = 10 * 60_000;
const PAIR_TRIES = 5;
const MAX_CLIENTS = 50;

const now = () => Math.floor(Date.now() / 1000);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

export function readJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
}
export function writeJson(file: string, data: unknown): void {
  mkdirSync(WEB_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

type Grant = { client_id: string; expires: number; resource: string };
type Store = { clients: Record<string, OAuthClientInformationFull>; access: Record<string, Grant>; refresh: Record<string, Grant> };
const load = () => readJson<Store>(AUTH_FILE, { clients: {}, access: {}, refresh: {} });
const save = (s: Store) => {
  for (const table of [s.access, s.refresh]) for (const [k, g] of Object.entries(table)) if (g.expires < now()) delete table[k];
  writeJson(AUTH_FILE, s);
};

type Pairing = { hash: string; expires: number; tries: number };

// Letters and digits that cannot be mistaken for each other.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function createPairingCode(): string {
  const code = [...randomBytes(10)].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  writeJson(PAIR_FILE, { hash: sha(code), expires: Date.now() + PAIR_MS, tries: 0 } satisfies Pairing);
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

// One code, one use, a few attempts. Wrong guesses use it up, so it cannot be brute-forced.
function usePairingCode(given: string): boolean {
  const p = readJson<Pairing | null>(PAIR_FILE, null);
  if (!p || p.expires < Date.now() || p.tries >= PAIR_TRIES) return false;
  const typed = given.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const ok = timingSafeEqual(Buffer.from(sha(typed)), Buffer.from(p.hash));
  writeJson(PAIR_FILE, ok ? { ...p, expires: 0 } : { ...p, tries: p.tries + 1 });
  return ok;
}

export const signOutAll = () => save({ clients: {}, access: {}, refresh: {} });

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (body: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>flow-mcp</title>
<style>body{font:16px/1.5 system-ui;max-width:26rem;margin:10vh auto;padding:0 1rem}input,button{font:inherit;padding:.6rem;width:100%;box-sizing:border-box;margin-top:.6rem}code{background:#8882;padding:.1rem .3rem}</style>${body}</html>`;

export class PairingProvider implements OAuthServerProvider {
  private pending = new Map<string, { client_id: string; params: AuthorizationParams; expires: number }>();
  private codes = new Map<string, { client_id: string; params: AuthorizationParams; expires: number }>();

  constructor(private resource: string) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => load().clients[id],
      registerClient: (client) => {
        if (!client.redirect_uris.length || !client.redirect_uris.every((u) => REDIRECTS.has(String(u)))) {
          throw new InvalidClientMetadataError("This server only accepts Claude's redirect URI.");
        }
        const full = { client_id: randomUUID(), client_id_issued_at: now(), ...client } as OAuthClientInformationFull;
        const s = load();
        // Registration is open by design, so the list is capped: the oldest client nobody signed in with goes first.
        const signedIn = new Set(Object.values(s.refresh).map((g) => g.client_id));
        const ids = Object.keys(s.clients);
        if (ids.length >= MAX_CLIENTS) for (const id of ids.filter((i) => !signedIn.has(i)).slice(0, ids.length - MAX_CLIENTS + 1)) delete s.clients[id];
        s.clients[full.client_id] = full;
        save(s);
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && params.resource.href.replace(/\/$/, "") !== this.resource) throw new InvalidTargetError("Unknown resource.");
    for (const [k, v] of this.pending) if (v.expires < Date.now()) this.pending.delete(k);
    if (this.pending.size >= 100) this.pending.delete(this.pending.keys().next().value!);
    const id = secret();
    this.pending.set(id, { client_id: client.client_id, params, expires: Date.now() + PENDING_MS });
    res.type("html").send(this.form(id));
  }

  private form(id: string, error = ""): string {
    return page(`<h1>Connect Claude to flow-mcp</h1>
<p>Whoever gets in here can generate in your Google Flow. On the computer running flow-mcp, run <code>npm run web:pair</code> and type the code.</p>
<p><strong>Only continue if you just added the connector yourself.</strong></p>${error ? `<p role="alert">${escape(error)}</p>` : ""}
<form method="post" action="/approve"><input type="hidden" name="request" value="${escape(id)}"><input name="code" autocomplete="off" autofocus required placeholder="XXXXX-XXXXX" aria-label="Code"><button>Allow access</button></form>`);
  }

  // The form's target: the only step that turns a request into an authorization code.
  approve(id: string, typed: string, res: Response): void {
    const req = this.pending.get(id);
    res.setHeader("Cache-Control", "no-store");
    if (!req || req.expires < Date.now()) {
      res.status(400).type("html").send(page("<p>This request has expired. Go back to Claude and connect again.</p>"));
      return;
    }
    if (!usePairingCode(typed)) {
      res.status(401).type("html").send(this.form(id, "Wrong, used or expired code. Generate another with npm run web:pair."));
      return;
    }
    this.pending.delete(id);
    const code = secret();
    this.codes.set(sha(code), { ...req, expires: Date.now() + CODE_MS });
    const url = new URL(req.params.redirectUri);
    url.searchParams.set("code", code);
    if (req.params.state) url.searchParams.set("state", req.params.state);
    res.redirect(302, url.href);
  }

  private grantFor(client: OAuthClientInformationFull, code: string) {
    const c = this.codes.get(sha(code));
    if (!c || c.expires < Date.now() || c.client_id !== client.client_id) throw new InvalidGrantError("Invalid or expired code.");
    return c;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.grantFor(client, code).params.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const c = this.grantFor(client, code);
    this.codes.delete(sha(code));
    if (redirectUri && redirectUri !== c.params.redirectUri) throw new InvalidGrantError("redirect_uri does not match.");
    return this.issue(load(), client.client_id);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, token: string): Promise<OAuthTokens> {
    const s = load();
    const g = s.refresh[sha(token)];
    if (!g || g.expires < now() || g.client_id !== client.client_id || g.resource !== this.resource) throw new InvalidGrantError("Invalid refresh token.");
    delete s.refresh[sha(token)];
    return this.issue(s, client.client_id);
  }

  private issue(s: Store, client_id: string): OAuthTokens {
    const access = secret();
    const refresh = secret();
    s.access[sha(access)] = { client_id, expires: now() + ACCESS_S, resource: this.resource };
    s.refresh[sha(refresh)] = { client_id, expires: now() + REFRESH_S, resource: this.resource };
    save(s);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_S, refresh_token: refresh };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const g = load().access[sha(token)];
    if (!g || g.expires < now()) throw new InvalidTokenError("Invalid or expired token.");
    return { token, clientId: g.client_id, scopes: [], expiresAt: g.expires, resource: new URL(g.resource) };
  }

  async revokeToken(client: OAuthClientInformationFull, { token }: OAuthTokenRevocationRequest): Promise<void> {
    const s = load();
    for (const table of [s.access, s.refresh]) if (table[sha(token)]?.client_id === client.client_id) delete table[sha(token)];
    save(s);
  }
}

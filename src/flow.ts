import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { getFlowPage } from "./chrome.js";
import type { Job } from "./queue.js";

export interface FlowState {
  url: string;
  signedIn: boolean;
  inProject: boolean;
  plan?: string;
  credits_remaining?: number;
  composer?: string;
  hint?: string;
}

const IMAGE_TIMEOUT_MS = 3 * 60_000;
const VIDEO_TIMEOUT_MS = 12 * 60_000;
const FAILURE_TEXT = /failed|couldn.t|unable/i;

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

// `detailed` opens the account panel to read the balance, so it must not run while a generation is driving the page.
export async function getFlowState(detailed = false): Promise<FlowState> {
  const page = await getFlowPage();
  const url = page.url();
  // Signed-out visitors are bounced to the marketing page or Google's sign-in.
  const signedIn = !/\/about|accounts\.google\.com/.test(url);
  const inProject = /\/project\//.test(url);
  const state: FlowState = { url, signedIn, inProject };
  if (!signedIn) state.hint = "Not signed in. Run `npm run login` and sign in to Google in the Flow Chrome window.";
  else if (!inProject) state.hint = "Signed in, but no project is open. Open or create a project in the Flow Chrome window.";
  else if (detailed) {
    state.plan = await page.getByRole("button", { name: "Account details" }).innerText().then((t) => t.trim().split("\n")[0], () => undefined);
    state.credits_remaining = await readCredits(page).catch(() => undefined);
    state.composer = await settingsTrigger(page).innerText().then((t) => t.replace(/\s+/g, " ").trim(), () => undefined);
  }
  return state;
}

// Menus close on Escape; the account panel does not and needs its own close button.
async function dismissOverlays(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  const closePanel = page.getByRole("button", { name: "Close account panel" });
  if (await closePanel.isVisible().catch(() => false)) await closePanel.click({ timeout: 5000 }).catch(() => {});
}

// The balance only shows inside the account panel. That panel also holds "Sign out": never touch anything else in it.
async function readCredits(page: Page): Promise<number | undefined> {
  await dismissOverlays(page);
  await scrollToTop(page);
  await page.getByRole("button", { name: "Account details" }).click({ timeout: 5000 });
  const link = page.getByRole("link", { name: /Google Flow credits/ });
  try {
    await link.waitFor({ state: "visible", timeout: 5000 });
    const n = Number((await link.innerText()).replace(/[^\d]/g, ""));
    return Number.isNaN(n) ? undefined : n;
  } finally {
    await dismissOverlays(page);
    await pause(page, 300);
  }
}

const settingsTrigger = (page: Page) => page.getByRole("button", { name: "Settings trigger" });

// Every finished tile carries its media id in data-media-id; some thumbnails also have it in the URL, but Flow
// serves signed /asb/ links with no uuid, so the attribute comes first and the URL is only a fallback.
// Video tiles at rest expose neither: their signed thumbnail URL is unique per clip, so it serves as the handle.
const TILE_ID_JS = `(tile) => {
  const media = tile.querySelector("img[data-media-id], video[data-media-id], img[src], video[src]");
  if (!media) return undefined;
  const src = media.getAttribute("src") || "";
  return media.getAttribute("data-media-id") || src.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0] || src || undefined;
}`;

export async function mediaIds(page: Page): Promise<string[]> {
  return page.evaluate(
    (js) => [...document.querySelectorAll("flow-grid-tile-container")].map(eval(js)).filter(Boolean) as string[],
    TILE_ID_JS,
  );
}

// The grid is virtualised and the top bar hides once it is scrolled, so every step starts from the top,
// where new tiles appear.
async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelectorAll(".page-container").forEach((e) => (e.scrollTop = 0)));
  await pause(page, 400);
}

// Titles survive re-scans; the signed thumbnail URL used as a fallback handle does not (Flow re-signs it), so
// anything that has to find the same tile again should go through here.
const tileOf = (page: Page, asset: FlowAsset) =>
  asset.name
    ? page.locator(`flow-grid-tile-container[aria-label="${asset.name.replace(/"/g, '\\"')}"]`).first()
    : mediaTile(page, asset.id!);

const mediaTile = (page: Page, id: string) =>
  page
    .locator(
      id.startsWith("http")
        ? `flow-grid-tile-container:has([src="${id}"])`
        : `flow-grid-tile-container:has([data-media-id="${id}"]), flow-grid-tile-container:has([src*="${id}"])`,
    )
    .first();

// A failed generation becomes a <flow-error-tile> ("Failed ... You have not been charged") with Flow's own Retry
// button. Old failures can sit anywhere in the grid, so only error tiles above the first already-known tile count.
export async function newErrorTiles(page: Page, known: Iterable<string>): Promise<number> {
  return page.evaluate(([ids, js]: [string[], string]) => {
    const seen = new Set(ids);
    let errors = 0;
    for (const tile of document.querySelectorAll("flow-grid-tile-container")) {
      const id = (eval(js) as (t: Element) => string | undefined)(tile);
      if (id && seen.has(id)) break;
      if (tile.querySelector("flow-error-tile")) errors++;
    }
    return errors;
  }, [[...known], TILE_ID_JS] as [string[], string]);
}

// Flow's Retry replaces the failed tile with a fresh render of the same prompt and settings, free of charge.
// Tiles produced by Agent mode only offer Delete, so the button may not be there at all.
async function retryErrorTile(page: Page, tile: Locator): Promise<boolean> {
  await tile.scrollIntoViewIfNeeded();
  await tile.hover();
  const retry = tile.getByRole("button", { name: "Retry" });
  if (!(await retry.isVisible({ timeout: 2000 }).catch(() => false))) return false;
  await retry.click({ timeout: 10_000 });
  await pause(page, 1500);
  await scrollToTop(page);
  return true;
}

// Big batches put more new tiles in the grid than Flow renders at once, so this walks down from the top, pressing
// Retry on every failed tile it meets, until it reaches a tile that existed before the job (or the end of the grid).
// Agent-mode failures offer no Retry button; the walk then stops and reports what it counted.
export async function retryNewErrorTiles(
  page: Page,
  known: Iterable<string>,
  dryRun = false,
): Promise<{ errors: number; reachedKnown: boolean; retried: number }> {
  const ids = [...known];
  let errors = 0;
  let retried = 0;
  let reachedKnown = false;
  let retryable = true;
  for (let pass = 0; pass < 80; pass++) {
    await scrollToTop(page);
    let found = false;
    for (let step = 0; step < 60 && !found && !reachedKnown; step++) {
      const state = await page.evaluate(([known, js]: [string[], string]) => {
        const seen = new Set(known);
        for (const tile of document.querySelectorAll("flow-grid-tile-container")) {
          const id = (eval(js) as (t: Element) => string | undefined)(tile);
          const name = tile.getAttribute("aria-label");
          if ((id && seen.has(id)) || (name && seen.has(name))) return "known";
          if (tile.querySelector("flow-error-tile")) return "error";
        }
        return "none";
      }, [ids, TILE_ID_JS] as [string[], string]);
      if (state === "known") reachedKnown = true;
      else if (state === "error") {
        found = true;
        errors++;
        if (dryRun) break;
        retryable = await retryErrorTile(page, page.locator("flow-grid-tile-container:has(flow-error-tile)").first());
        if (!retryable) break;
        retried++;
      } else {
        const moved = await page.evaluate(() => {
          const el = document.querySelector(".page-container");
          if (!el) return false;
          const top = el.scrollTop;
          el.scrollTop = top + el.clientHeight * 0.8;
          return el.scrollTop > top;
        });
        if (!moved) reachedKnown = true;
        await pause(page, 400);
      }
    }
    // A successful Retry reshuffles the grid (the new render jumps to the top), so the walk starts again.
    if (!found || dryRun || !retryable) break;
  }
  await scrollToTop(page);
  return { errors, reachedKnown, retried };
}

async function waitForNewMedia(page: Page, before: string[], count: number, timeoutMs: number, job?: Job): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let retriesLeft = job?.params.retries ?? 1;
  let failures = 0;
  while (Date.now() < deadline) {
    await pause(page, 2000);
    const fresh = [...new Set((await mediaIds(page)).filter((id) => !before.includes(id)))];
    // New tiles are listed first, so anything beyond the requested count is not ours.
    if (fresh.length >= count) return fresh.slice(0, count);
    const progress = await page.evaluate(() =>
      [...document.querySelectorAll("flow-grid-tile-container")].slice(0, 8).map((t) => (t as HTMLElement).innerText.match(/\d+%/)?.[0]).filter(Boolean),
    );
    if (job) job.progress = progress.join(", ") || undefined;
    const errors = progress.length ? 0 : await newErrorTiles(page, before);
    if (!errors) continue;
    failures += errors;
    if (retriesLeft > 0) {
      retriesLeft--;
      if (job) job.progress = "Flow failed, retrying";
      const retried = await retryErrorTile(page, page.locator("flow-grid-tile-container:has(flow-error-tile)").first());
      if (retried) continue;
    }
    if (fresh.length) return fresh;
    throw new Error(`Flow failed this generation ${failures} time(s) ("Sorry, this image/video failed to generate"). Nothing was charged. Try again later or reword the prompt.`);
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Flow to finish.`);
}

async function openSettings(page: Page): Promise<void> {
  const probe = page.getByRole("radio", { name: "Image", exact: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await probe.isVisible().catch(() => false)) return;
    await settingsTrigger(page).click();
    await probe.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  }
  if (!(await probe.isVisible().catch(() => false))) throw new Error("Could not open Flow's generation settings popover.");
}

async function pickRadio(page: Page, name: string | RegExp): Promise<void> {
  const radio = page.getByRole("radio", { name, exact: typeof name === "string" }).first();
  if (!(await radio.isVisible().catch(() => false))) {
    throw new Error(`Flow has no "${name}" option for the current mode/model.`);
  }
  if (!(await radio.isChecked())) {
    await radio.click();
    await pause(page, 500);
  }
}

async function pickModel(page: Page, model: string): Promise<void> {
  const button = page.getByRole("button", { name: "Select model family" });
  if ((await button.innerText()).toLowerCase().includes(model.toLowerCase())) return;
  await button.click();
  const items = page.getByRole("menuitem");
  await items.first().waitFor({ state: "visible", timeout: 5000 });
  const names = (await items.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  const index = names.findIndex((n) => n.toLowerCase().includes(model.toLowerCase()));
  if (index < 0) {
    await page.keyboard.press("Escape");
    throw new Error(`Model "${model}" not found. Available here: ${names.join(", ")}`);
  }
  await items.nth(index).click();
  await pause(page, 700);
}

// Applies the scene settings and returns the credit cost Flow quotes for them.
async function applySettings(page: Page, job: Job): Promise<number> {
  const s = job.params;
  const framesMode = Boolean(s.first_frame || s.last_frame);
  await openSettings(page);
  await pickRadio(page, s.type === "image" ? "Image" : "Video");
  if (s.type === "video") await pickRadio(page, framesMode ? "Frames" : "Ingredients");
  if (s.aspect_ratio) await pickRadio(page, s.aspect_ratio);
  if (s.model) await pickModel(page, s.model);
  if (s.type === "video" && s.resolution) await pickRadio(page, new RegExp(`^${s.resolution}`));
  if (s.type === "video" && s.duration) await pickRadio(page, `${s.duration}s`);
  await pickRadio(page, `x${s.variants ?? 1}`);
  await pause(page, 600);
  const costText = await page.getByRole("link", { name: /credits?$/ }).innerText();
  const cost = Number(costText.match(/\d+/)?.[0] ?? NaN);
  await page.keyboard.press("Escape");
  await pause(page, 400);
  if (Number.isNaN(cost)) throw new Error(`Could not read the credit cost from Flow ("${costText}").`);
  return cost;
}

const ASSET_PREFIX = "asset:";

// Uploads under a unique filename so the asset can be picked unambiguously afterwards.
// "asset:<name>" refers to something already in the Flow project (image, video, character) and skips the upload.
async function uploadAsset(page: Page, job: Job, file: string, label: string): Promise<string> {
  if (file.startsWith(ASSET_PREFIX)) return file.slice(ASSET_PREFIX.length).trim();
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  const name = `fm-${job.id}-${label}${extname(file).toLowerCase()}`;
  const staged = join(mkdtempSync(join(tmpdir(), "flow-mcp-")), name);
  copyFileSync(file, staged);
  await scrollToTop(page);
  const before = await mediaIds(page);
  await page.getByRole("button", { name: "Add media menu" }).click();
  const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
  await page.getByRole("menuitem", { name: "Upload", exact: true }).click();
  await (await chooser).setFiles(staged);
  await waitForNewMedia(page, before, 1, 90_000);
  return name;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Options read "<name>", "<name> Image|Video|Avatar" or "<voice> <description>", so match on the leading name.
const optionByName = (list: Locator, name: string) =>
  list.getByRole("option", { name: new RegExp(`^${escapeRe(name)}`, "i") }).first();

// The frame pickers attach on click; the ingredients picker only previews and needs "Add to prompt".
// Option names are "<asset name>" or "<asset name> Image|Video", so match on the prefix.
async function attachAsset(page: Page, opener: Locator, assetName: string): Promise<void> {
  await opener.click();
  const list = page.getByRole("listbox", { name: "Asset list" });
  await list.waitFor({ state: "visible", timeout: 10_000 });
  const option = optionByName(list, assetName);
  await option.waitFor({ state: "visible", timeout: 10_000 });
  await option.click();
  const add = page.getByRole("button", { name: "Add to prompt", exact: true });
  if (await add.waitFor({ state: "visible", timeout: 1500 }).then(() => true, () => false)) await add.click().catch(() => {});
  await list.waitFor({ state: "hidden", timeout: 10_000 });
  await pause(page, 500);
}

async function typePrompt(page: Page, prompt: string): Promise<void> {
  const box = page.locator(".ProseMirror");
  await box.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  // Enter submits in Flow, so the prompt goes in as a single line.
  await page.keyboard.type(prompt.replace(/\s*\n+\s*/g, " ").trim(), { delay: 8 });
  await pause(page, 500);
}

export type DownloadQuality = "original" | "upscaled";

export async function downloadMedia(page: Page, mediaId: string, targetStem: string, quality: DownloadQuality = "original"): Promise<string> {
  return downloadTile(page, mediaTile(page, mediaId), targetStem, quality);
}

async function downloadTile(page: Page, tile: Locator, targetStem: string, quality: DownloadQuality): Promise<string> {
  await tile.scrollIntoViewIfNeeded();
  // Upscales are rendered on demand, so they can take minutes before the file arrives.
  const download = page.waitForEvent("download", { timeout: quality === "upscaled" ? 600_000 : 120_000 });
  download.catch(() => {});
  await tile.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Download", exact: true }).click();
  // Size submenu: "720p Original size" / "1K Original size", or the first upscale the plan allows (1080p / 2K).
  const original = page.getByRole("menuitem", { name: /original/i }).first();
  if (await original.waitFor({ state: "visible", timeout: 2500 }).then(() => true, () => false)) {
    const upscaled = page.locator('[role="menuitem"]:not([aria-disabled="true"]):not([disabled])').filter({ hasText: /upscaled/i }).first();
    const wanted = quality === "upscaled" && (await upscaled.isVisible().catch(() => false)) ? upscaled : original;
    await wanted.click();
  }
  const file = await download;
  const target = `${targetStem}${extname(file.suggestedFilename()) || ".bin"}`;
  try {
    await file.saveAs(target);
  } catch (err) {
    // Chrome keeps the bytes in a temp file that belongs to this connection; another flow-mcp process attaching to
    // the same Chrome can sweep it away mid-save. Copy straight from the temp path as a fallback.
    const temp = await file.path().catch(() => null);
    if (!temp || !existsSync(temp)) throw err;
    copyFileSync(temp, target);
  }
  await page.keyboard.press("Escape");
  await scrollToTop(page);
  return target;
}

// Earlier steps (or the user) may have left Flow in a character/edit page or a filtered view.
async function ensureProjectGrid(page: Page): Promise<void> {
  await dismissOverlays(page);
  const root = page.url().match(/^https:\/\/[^/]+\/project\/[0-9a-f-]{36}/)?.[0];
  if (root && page.url() !== root) {
    await page.goto(root, { waitUntil: "domcontentloaded" });
    await pause(page, 2500);
  }
  await page.getByRole("navigation", { name: "Project navigation" }).getByText("All media", { exact: true }).click().catch(() => {});
  await pause(page, 800);
  await scrollToTop(page);
}

// Drives one generation in the Flow tab and returns the downloaded file paths.
export async function runGeneration(job: Job): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  const s = job.params;

  await ensureProjectGrid(page);
  const agent = page.getByRole("button", { name: "Agent", exact: true });
  if ((await agent.getAttribute("aria-pressed")) === "true") await agent.click();
  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();

  job.credits = await applySettings(page, job);
  if (job.credits > s.max_credits) {
    throw new Error(
      `Flow quotes ${job.credits} credits for this scene, above max_credits=${s.max_credits}. Nothing was generated. Raise max_credits or pick a cheaper model/duration/variants.`,
    );
  }

  if (s.first_frame) {
    await attachAsset(page, page.getByRole("button", { name: "Start", exact: true }), await uploadAsset(page, job, s.first_frame, "start"));
  }
  if (s.last_frame) {
    await attachAsset(page, page.getByRole("button", { name: "End", exact: true }), await uploadAsset(page, job, s.last_frame, "end"));
  }
  for (const [i, ref] of (s.reference_images ?? []).entries()) {
    const name = await uploadAsset(page, job, ref, `ref${i + 1}`);
    await attachAsset(page, page.getByRole("button", { name: "Add ingredients to the prompt box" }), name);
  }

  await typePrompt(page, s.prompt);
  const start = page.getByRole("button", { name: "Start generation" });
  if (!(await start.isEnabled())) throw new Error("Flow's Start generation button is disabled; the prompt or inputs were not accepted.");
  await scrollToTop(page);
  const before = await mediaIds(page);
  await start.click();

  const variants = s.variants ?? 1;
  const fresh = await waitForNewMedia(page, before, variants, s.type === "image" ? IMAGE_TIMEOUT_MS : VIDEO_TIMEOUT_MS, job);
  job.progress = undefined;

  mkdirSync(s.output_dir, { recursive: true });
  const files: string[] = [];
  for (const [i, id] of fresh.entries()) {
    const stem = join(s.output_dir, fresh.length > 1 ? `${s.file_stem}-v${i + 1}` : s.file_stem);
    files.push(await downloadMedia(page, id, stem, s.download_quality));
    await pause(page, 1500);
  }
  return files;
}

export interface FlowAsset {
  name: string;
  kind: "image" | "video";
  id?: string;
}

// Walks the virtualised grid from the top and collects every tile it passes. Recycled tiles sometimes have no
// media id yet, so entries are keyed by title and the id is filled in from whichever pass saw it.
async function scanGrid(page: Page, stopAt?: (assets: FlowAsset[]) => boolean): Promise<FlowAsset[]> {
  await dismissOverlays(page);
  await page.getByRole("navigation", { name: "Project navigation" }).getByText("All media", { exact: true }).click().catch(() => {});
  await pause(page, 600);
  await scrollToTop(page);
  const seen = new Map<string, FlowAsset>();
  for (let step = 0; step < 200; step++) {
    const batch = await page.evaluate(
      (js) =>
        [...document.querySelectorAll("flow-grid-tile-container")].map((t) => ({
          name: t.getAttribute("aria-label") ?? "",
          kind: t.querySelector("flow-video-tile") ? ("video" as const) : ("image" as const),
          id: (eval(js) as (t: Element) => string | undefined)(t),
        })),
      TILE_ID_JS,
    );
    for (const a of batch) {
      if (!a.name) continue;
      const known = seen.get(a.name);
      if (!known) seen.set(a.name, a);
      else if (!known.id && a.id) known.id = a.id;
    }
    if (stopAt?.([...seen.values()])) break;
    const moved = await page.evaluate(() => {
      const el = document.querySelector(".page-container");
      if (!el) return false;
      const before = el.scrollTop;
      el.scrollTop = before + el.clientHeight * 0.8;
      return el.scrollTop > before;
    });
    if (!moved) break;
    await pause(page, 700);
  }
  return [...seen.values()];
}

// Characters live in their own left-nav section. With none yet, Flow shows a template chooser instead, so only
// entries that actually carry a character thumbnail count.
export async function listCharacters(): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  await dismissOverlays(page);
  await page.getByRole("navigation", { name: "Project navigation" }).getByText("Characters", { exact: true }).click();
  await pause(page, 2500);
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('img[alt="Character thumbnail"], img[alt="Me"]')]
      .map((img) => {
        let el: Element | null = img;
        for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
          const text = (el as HTMLElement).innerText?.replace(/\s+/g, " ").trim();
          if (text) return text;
        }
        return "";
      })
      .filter(Boolean),
  );
  await ensureProjectGrid(page).catch(() => {});
  // Strip Material icon ligatures Flow renders as text ("accessibility_new", "person") and its own avatar.
  return [...new Set(names.map((n) => n.replace(/\b(accessibility_new|person|movie|image|videocam|mic)\b/g, "").replace(/\s+/g, " ").trim()))].filter(
    (n) => n && n !== "Me",
  );
}

export async function listAssets(): Promise<FlowAsset[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  const assets = await scanGrid(page);
  await scrollToTop(page);
  return assets;
}

// Downloads media that already exists in the project, matched by (the start of) its title.
export async function downloadAsset(name: string, targetStem: string, quality: DownloadQuality): Promise<string> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  const matches = (a: FlowAsset) => a.name.toLowerCase().startsWith(name.toLowerCase());
  const found = (await scanGrid(page, (assets) => assets.some(matches))).find(matches);
  if (!found) throw new Error(`No asset whose title starts with "${name}". Use flow_assets to list titles.`);
  return downloadTile(page, tileOf(page, found), targetStem, quality);
}

export interface CharacterParams {
  name: string;
  image?: string;
  describe?: string;
  aspect_ratio?: string;
  personality?: string;
  voice?: string;
}

// Creates a reusable Flow character from an image (local file, or "asset:<title>" already in the project).
// Afterwards it can be attached to any scene as reference "asset:<character name>".
export async function createCharacter(c: CharacterParams, job?: Job): Promise<{ name: string; url: string; portrait?: string }> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  // A description generates the portrait first (free image), then the character is built from that picture.
  let portrait: string | undefined;
  if (!c.image) {
    if (!c.describe) throw new Error("Pass either an image or a description for the character.");
    if (job) job.progress = "drawing the character";
    const dir = join(process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out"), "_cast");
    const made = await runGeneration({
      ...(job ?? ({ id: "char", status: "running", files: [], attempts: 1, createdAt: "" } as unknown as Job)),
      files: [],
      params: {
        prompt: c.describe,
        type: "image",
        max_credits: 0,
        aspect_ratio: (c.aspect_ratio as "3:4") ?? "3:4",
        output_dir: dir,
        file_stem: c.name.replace(/[^\w.-]+/g, "_"),
      },
    } as Job);
    portrait = made[0];
    c = { ...c, image: portrait };
  }
  const image = c.image!;
  const projectUrl = page.url();
  await dismissOverlays(page);
  await scrollToTop(page);

  await page.getByRole("navigation", { name: "Project navigation" }).getByText("Characters", { exact: true }).click();
  await pause(page, 1500);
  // With no characters yet Flow jumps straight to the creation page.
  const create = page.getByRole("button", { name: "New character" });
  if (await create.isVisible().catch(() => false)) await create.click();
  await page.waitForURL(/\/character$/, { timeout: 15_000 });

  if (image.startsWith(ASSET_PREFIX)) {
    const title = image.slice(ASSET_PREFIX.length).trim();
    await page.getByRole("button", { name: "Add from project", exact: true }).click();
    const list = page.getByRole("listbox", { name: "Asset list" });
    await list.waitFor({ state: "visible", timeout: 10_000 });
    let option = optionByName(list, title);
    if (!(await option.isVisible().catch(() => false))) {
      await page.getByRole("tab", { name: "Uploads" }).click();
      await pause(page, 1000);
      option = optionByName(list, title);
    }
    if (!(await option.isVisible().catch(() => false))) {
      await page.keyboard.press("Escape");
      throw new Error(`No image titled "${title}" in the Flow project. Use flow_assets to list titles.`);
    }
    await option.click();
    await page.getByRole("button", { name: "Add media", exact: true }).click();
  } else {
    if (!existsSync(image)) throw new Error(`File not found: ${image}`);
    const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await (await chooser).setFiles(image);
  }
  await page.waitForURL(/\/character\/[0-9a-f-]{36}/, { timeout: 90_000 });
  const url = page.url();

  const name = page.getByRole("textbox", { name: "Character name" });
  await name.waitFor({ state: "visible", timeout: 15_000 });
  await name.fill(c.name);
  await name.press("Enter");
  if (c.personality) await page.getByRole("textbox", { name: "Character personality" }).fill(c.personality);

  if (c.voice) {
    await page.getByRole("button", { name: "Select a voice" }).click();
    const voices = page.getByRole("listbox", { name: "Asset list" });
    await voices.waitFor({ state: "visible", timeout: 10_000 });
    const option = optionByName(voices, c.voice);
    if (!(await option.isVisible().catch(() => false))) {
      const available = (await voices.getByRole("option").allInnerTexts()).map((t) => t.split("\n").filter((l) => l && l !== "voice_selection").join(" - "));
      await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
      throw new Error(`Voice "${c.voice}" not found. Character was created without a voice. Available: ${available.join("; ")}`);
    }
    await option.click();
    // "Customize performance" would turn this into generating a new voice (preview + save); stock voices only.
    await page.getByRole("button", { name: "Add to character", exact: true }).click();
    await pause(page, 1000);
  }

  // Flow labels this "Done editing" or just "Done" depending on the panel state.
  await page.getByRole("button", { name: /^Done( editing)?$/ }).first().click();
  await page.waitForURL((u) => !/\/character/.test(u.pathname), { timeout: 15_000 }).catch(() => page.goto(projectUrl));
  await pause(page, 1000);
  // Flow drops the new character into the composer; leave the composer empty for the next job.
  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();
  await page.getByRole("navigation", { name: "Project navigation" }).getByText("All media", { exact: true }).click().catch(() => {});
  return { name: c.name, url, portrait };
}

const EDIT_TIMEOUT_MS = 10 * 60_000;

// Video-to-video edit in Flow's edit view ("make it sunset", "remove the cup"). Flow shows no quote here, so the
// cost is measured from the balance instead (a 4 s Omni clip cost 20 credits). The result is a new tile.
export async function runEdit(job: Job): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  const s = job.params;
  const title = s.edit_asset!;

  await ensureProjectGrid(page);
  const balance = await readCredits(page).catch(() => undefined);
  // New tiles always appear at the top, so the "before" snapshot is taken there, ahead of the search: scrolling
  // back to the top after the scan would unmount the tile we are about to click (the grid is virtualised).
  const before = await mediaIds(page);
  const matches = (a: FlowAsset) => a.kind === "video" && a.name.toLowerCase().startsWith(title.toLowerCase());
  const found = (await scanGrid(page, (assets) => assets.some(matches))).find(matches);
  if (!found) throw new Error(`No video whose title starts with "${title}". Use flow_assets to list titles.`);

  const tile = tileOf(page, found);
  await tile.scrollIntoViewIfNeeded();
  await tile.click();
  await page.waitForURL(/\/edit\//, { timeout: 20_000 });
  await pause(page, 2500);

  const box = page.locator(".ProseMirror").last();
  await box.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  const prompt = s.prompt.replace(/\s*\n+\s*/g, " ").trim();
  await page.keyboard.type(prompt, { delay: 8 });
  await pause(page, 600);
  const start = page.getByRole("button", { name: "Start generation" });
  if (!(await start.isEnabled())) throw new Error("Flow did not accept the edit prompt (Start generation stayed disabled).");
  await start.click();

  // Progress shows as "NN% <prompt>" inside the edit view and disappears when the edit is ready.
  const deadline = Date.now() + EDIT_TIMEOUT_MS;
  let seenProgress = false;
  for (;;) {
    await pause(page, 3000);
    const text = await page.locator("main").first().innerText();
    const pct = text.match(/(\d+)%/)?.[0];
    job.progress = pct;
    if (pct) seenProgress = true;
    else if (seenProgress) break;
    const failure = text.split("\n").find((l) => FAILURE_TEXT.test(l) && !l.includes(prompt));
    if (!pct && failure && Date.now() > deadline - EDIT_TIMEOUT_MS + 15_000) throw new Error(`Flow reported a failed edit: ${failure.slice(0, 300)}`);
    if (Date.now() > deadline) throw new Error("Timed out waiting for Flow to finish the edit.");
  }
  job.progress = undefined;

  await page.getByRole("button", { name: "Back button to go to previous page" }).click();
  await pause(page, 2500);
  await ensureProjectGrid(page);
  const fresh = await waitForNewMedia(page, before, 1, 90_000);
  mkdirSync(s.output_dir, { recursive: true });
  const file = await downloadMedia(page, fresh[0], join(s.output_dir, s.file_stem), s.download_quality);
  const after = await readCredits(page).catch(() => undefined);
  if (balance !== undefined && after !== undefined) job.credits = balance - after;
  return [file];
}

async function setAgentMode(page: Page, on: boolean): Promise<void> {
  const agent = page.getByRole("button", { name: "Agent", exact: true });
  if (((await agent.getAttribute("aria-pressed")) === "true") !== on) {
    await agent.click();
    await pause(page, 1200);
  }
}

// "Never" lets the agent generate without asking; it is switched back to "Always" as soon as the batch ends.
async function setAgentSettings(page: Page, confirm: "Always" | "Never", imageAspect?: string): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Agent settings" }).waitFor({ state: "visible", timeout: 8000 });
  await page.getByRole("radio", { name: new RegExp(`^${confirm}`) }).click();
  if (imageAspect) {
    await page.getByRole("radio", { name: imageAspect, exact: true }).first().click();
    await page.getByRole("radio", { name: "x1", exact: true }).first().click();
  }
  await pause(page, 300);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await pause(page, 1200);
}

// "Reuse prompt" on an agent-made tile opens the agent's session panel, which hides the normal composer.
async function closeAgentSession(page: Page): Promise<void> {
  const panel = page.getByRole("button", { name: "Start new session" });
  if (await panel.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await pause(page, 1000);
  }
  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();
  else {
    await page.locator(".ProseMirror").first().click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
  }
  await pause(page, 400);
}

const STOP_WORDS = new Set("the and with from into over under that this then than are was for her his its their onto next near across wide shot close scene image".split(" "));
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9']{3,}/g)?.filter((w) => !STOP_WORDS.has(w)) ?? []);

// Returns, per scene, the indexes of the tiles that belong to it (best match first). A tile counts when at least
// half of the scene's meaningful words appear in the prompt Flow stored for that tile.
export function matchScenes(scenes: string[], prompts: string[]): number[][] {
  const sceneWords = scenes.map(words);
  const pairs: { scene: number; tile: number; score: number }[] = [];
  prompts.forEach((prompt, tile) => {
    const have = words(prompt);
    sceneWords.forEach((want, scene) => {
      const hit = [...want].filter((w) => have.has(w)).length;
      pairs.push({ scene, tile, score: want.size ? hit / want.size : 0 });
    });
  });
  pairs.sort((x, y) => y.score - x.score);
  const out: number[][] = scenes.map(() => []);
  const usedTiles = new Set<number>();
  // First give every scene its single best tile, then hand leftover tiles to their best scene as extra takes.
  for (const firstPass of [true, false]) {
    for (const { scene, tile, score } of pairs) {
      if (score < 0.5 || usedTiles.has(tile) || (firstPass && out[scene].length)) continue;
      out[scene].push(tile);
      usedTiles.add(tile);
    }
  }
  return out;
}

interface RoundOutcome {
  produced: number;
  timedOut: boolean;
  failedTiles: number;
}

// One pass through Flow's agent for the given scene numbers: ask, wait, match the new tiles back to those scenes
// and download them. Returns how many scenes it actually delivered.
async function agentRound(
  page: Page,
  job: Job,
  scenes: string[],
  indexes: number[],
  retry: boolean,
  files: string[],
  done: Set<number>,
): Promise<RoundOutcome> {
  const s = job.params;
  const aspect = s.aspect_ratio ?? "16:9";
  await ensureProjectGrid(page);
  const seenBefore = await scanGrid(page);
  // Ids are unique per generation; titles are not (the agent reuses wording), so only id-less tiles fall back to a name.
  const before = new Set<string>(seenBefore.map((a) => a.id).filter((v): v is string => Boolean(v)));
  const beforeNames = new Set<string>(seenBefore.filter((a) => !a.id).map((a) => a.name));
  await scrollToTop(page);

  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();
  const script = indexes.map((i) => `Scene ${i + 1}: ${scenes[i].replace(/\s*\n+\s*/g, " ").trim()}`).join(" ");
  const lead = retry
    ? `${indexes.length} image(s) from the last batch failed to generate. Generate them again now, one image per scene`
    : `Generate exactly ${indexes.length} separate images, one image per scene, in scene order`;
  const ask = `${lead}. Images only, never video. ${aspect} aspect ratio. Do not ask questions, generate them now. ${script}`;
  await page.locator(".ProseMirror").first().click();
  await page.keyboard.insertText(ask);
  await pause(page, 800);
  const start = page.getByRole("button", { name: "Start generation" });
  if (!(await start.isEnabled())) throw new Error("Flow's agent did not accept the script (Start generation stayed disabled).");
  await start.click();

  // The agent shows a Stop button while it works and "NN%" on every tile it is rendering.
  const deadline = Date.now() + (3 * 60_000 + indexes.length * 30_000);
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  let idleSince = 0;
  let timedOut = false;
  for (;;) {
    await pause(page, 3000);
    const main = await page.locator("main").first().innerText();
    const pending = main.match(/\d+%/g) ?? [];
    const working = pending.length > 0 || (await stop.isVisible().catch(() => false));
    job.progress = working ? `${pending.length} rendering` : undefined;
    if (working) idleSince = 0;
    else if (!idleSince) idleSince = Date.now();
    else if (Date.now() - idleSince > 8000) break;
    if (Date.now() > deadline) {
      // A tile that hangs must not sink the batch: stop the agent and keep whatever finished.
      timedOut = true;
      if (await stop.isVisible().catch(() => false)) await stop.click().catch(() => {});
      await pause(page, 2000);
      break;
    }
  }

  const failedTiles = await retryNewErrorTiles(page, before, true)
    .then((r) => r.errors)
    .catch(() => 0);
  const fresh = (await scanGrid(page)).filter((t) => t.id && !before.has(t.id) && !beforeNames.has(t.name) && t.kind === "image");

  // Tiles finish in any order and the agent rewords prompts, so each image is matched back to its scene by the
  // prompt Flow stored for it ("Reuse prompt" puts that text in the composer).
  const prompts: string[] = [];
  for (const tile of fresh) {
    await scanGrid(page, (seen) => seen.some((x) => x.id === tile.id));
    const el = mediaTile(page, tile.id!);
    await el.scrollIntoViewIfNeeded();
    await el.hover();
    await el.getByRole("button", { name: "Reuse prompt" }).click();
    await pause(page, 900);
    prompts.push(await page.locator(".ProseMirror").first().innerText());
  }
  await closeAgentSession(page);

  const assigned = matchScenes(
    indexes.map((i) => scenes[i]),
    prompts,
  );
  const drop = Number(process.env.FLOW_MCP_SIMULATE_MISSING ?? 0); // test hook: pretend this scene number failed
  mkdirSync(s.output_dir, { recursive: true });
  const base = Number(s.file_stem.match(/\d+/)?.[0] ?? 1);
  let produced = 0;
  for (const [n, tileIndexes] of assigned.entries()) {
    const sceneIndex = indexes[n];
    if (!tileIndexes.length || sceneIndex + 1 === drop) continue;
    for (const [v, tileIndex] of tileIndexes.entries()) {
      const id = fresh[tileIndex].id!;
      await scanGrid(page, (seen) => seen.some((x) => x.id === id));
      const stem = join(s.output_dir, `scene-${String(base + sceneIndex).padStart(2, "0")}${v ? `-v${v + 1}` : ""}`);
      files.push(await downloadTile(page, mediaTile(page, id), stem, s.download_quality ?? "original"));
      await pause(page, 800);
    }
    done.add(sceneIndex);
    produced++;
  }
  return { produced, timedOut, failedTiles };
}

// Hands a whole multi-scene script to Flow's own agent, which generates every image in parallel (seconds instead
// of one paced job per scene). Scenes the agent drops are asked for again, then re-run one by one as a last resort.
export async function runAgentBatch(job: Job): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  const s = job.params;
  const scenes = s.agent_scenes!;

  await ensureProjectGrid(page);
  const balance = await readCredits(page).catch(() => undefined);

  const files: string[] = [];
  const done = new Set<number>();
  let agentTimedOut = false;
  let failedTiles = 0;
  let agentRetries = 0;
  try {
    await setAgentMode(page, true);
    await setAgentSettings(page, "Never", s.aspect_ratio ?? "16:9");
    for (let round = 0; round < 3; round++) {
      const todo = scenes.map((_, i) => i).filter((i) => !done.has(i));
      if (!todo.length) break;
      if (round) {
        agentRetries += todo.length;
        job.progress = `asking the agent again for ${todo.length} scene(s)`;
      }
      const out = await agentRound(page, job, scenes, todo, round > 0, files, done);
      agentTimedOut ||= out.timedOut;
      failedTiles = out.failedTiles;
      if (!out.produced) break; // the agent delivered nothing this round: stop asking it
    }
  } finally {
    await ensureProjectGrid(page).catch(() => {});
    await closeAgentSession(page).catch(() => {});
    await setAgentMode(page, true).catch(() => {});
    await setAgentSettings(page, "Always").catch(() => {});
    await setAgentMode(page, false).catch(() => {});
  }

  // Anything the agent still has not delivered is generated one by one, which is slower but exact.
  const missing = scenes.map((_, i) => i).filter((i) => !done.has(i));
  const failed: number[] = [];
  const base = Number(s.file_stem.match(/\d+/)?.[0] ?? 1);
  for (const [n, i] of missing.entries()) {
    job.progress = `re-running scene ${i + 1} one by one (${n + 1}/${missing.length})`;
    const single: Job = {
      ...job,
      files: [],
      params: {
        prompt: scenes[i],
        type: "image",
        max_credits: 0,
        aspect_ratio: s.aspect_ratio,
        download_quality: s.download_quality,
        output_dir: s.output_dir,
        file_stem: `scene-${String(base + i).padStart(2, "0")}`,
      },
    };
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      if (attempt || n) await pause(page, 8000);
      try {
        files.push(...(await runGeneration(single)));
        ok = true;
      } catch {
        /* one more attempt, then give up on this scene */
      }
    }
    if (!ok) failed.push(i + 1);
  }
  job.progress = undefined;
  files.sort();
  job.note = [
    agentTimedOut ? "the agent stalled and was stopped" : "",
    `${done.size} of ${scenes.length} scenes came from the agent`,
    agentRetries ? `${agentRetries} asked again` : "",
    failedTiles ? `${failedTiles} tile(s) failed in Flow` : "",
    missing.length ? `${missing.length - failed.length} re-run one by one` : "",
    failed.length ? `still failed: scene ${failed.join(", ")} (use Retry)` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (!files.length) throw new Error("No image could be generated for any scene. Open the Flow tab to see what Flow reported.");

  const left = await readCredits(page).catch(() => undefined);
  if (balance !== undefined && left !== undefined) job.credits = balance - left;
  return files;
}

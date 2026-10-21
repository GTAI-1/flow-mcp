import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { HOME_DIR, getFlowPage, inEnglish } from "./chrome.js";
import type { Job } from "./queue.js";
import { extractZip } from "./platform.js";

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
  await leaveSideMenu(page);
  await page.keyboard.press("Escape");
  const closePanel = page.getByRole("button", { name: "Close account panel" });
  if (await closePanel.isVisible().catch(() => false)) await closePanel.click({ timeout: 5000 }).catch(() => {});
  await clearBackdrops(page);
}

// Some of Flow's menus ignore Escape (the agent's model menu did, 2026-10-13), and the invisible backdrop behind an
// open menu ("cdk-overlay-backdrop settings-menu-backdrop") then swallows every click on the page: that is how an agent
// batch failed with "Could not switch Agent mode on". Clicking the backdrop is how such a menu closes, picking nothing.
async function clearBackdrops(page: Page): Promise<void> {
  const showing = page.locator(".cdk-overlay-backdrop.cdk-overlay-backdrop-showing");
  for (let i = 0; i < 4 && (await showing.count().catch(() => 0)); i++) {
    await showing.last().click({ force: true, timeout: 4000 }).catch(() => {});
    await pause(page, 500);
  }
}

// The agent's own image model, set to the newest Nano Banana like single images. Best effort: a batch never fails over it.
async function pickAgentImageModel(page: Page): Promise<void> {
  const button = page.locator("flow-agent-panel").getByRole("button", { name: "Image generation default model" });
  if (!(await button.isVisible().catch(() => false))) return;
  await button.click({ timeout: 5000 }).catch(() => {});
  const items = page.getByRole("menuitem");
  if (!(await items.first().isVisible().catch(() => false))) await items.first().waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
  const names = (await items.allInnerTexts().catch(() => [] as string[])).map((t) => t.replace(/\s+/g, " ").trim());
  const index = newestNanoBanana(names);
  const shown = (await button.innerText().catch(() => "")).replace(/\s+/g, " ");
  if (index >= 0 && !shown.includes(names[index])) await items.nth(index).click({ timeout: 4000 }).catch(() => {});
  else await page.keyboard.press("Escape");
  await pause(page, 400);
  await clearBackdrops(page);
}

// The agent settings panel replaces the composer, hiding the Agent button; Back closes it without saving.
async function closeAgentSettings(page: Page): Promise<void> {
  const back = page.locator("flow-agent-panel").getByRole("button", { name: "Back", exact: true });
  if (await back.isVisible().catch(() => false)) {
    await clearBackdrops(page);
    await back.click({ timeout: 5000 }).catch(() => {});
    await pause(page, 800);
  }
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

// A tile's identity is the uuid of the media inside it, and nothing else. Images carry it in data-media-id;
// everything else carries it in the media URL, which Flow now serves as flow-content.google/<kind>/<uuid>
// (re-mapped 2026-10-21 - the old signed /asb/ links without a uuid are only left on older video thumbnails).
// A rendering tile already carries its final title (2026-10-09) and an error tile carries one too (2026-10-11),
// so neither counts as media until it is done.
//
// There used to be a fallback: an id-less tile was identified by its TITLE. That cost real work on 2026-10-21.
// Flow reuses its own auto titles, so two portraits of one batch both came back "Man posing for portrait" and
// shared one identity; the second looked like a tile we already knew, and the job went on to rename and download
// two unrelated frames from another clip instead. A tile with no uuid is now simply not identifiable, and the job
// says so rather than guessing.
const TILE_ID_JS = `(tile) => {
  if (tile.querySelector("flow-pending-tile, flow-error-tile")) return undefined;
  const withId = tile.querySelector("[data-media-id]");
  if (withId) return withId.getAttribute("data-media-id") || undefined;
  // Order matters: a video tile at rest holds only its thumbnail <img>, and gains a <video> with a DIFFERENT uuid
  // once it plays, so the thumbnail is read first and the tile keeps one id either way.
  const media = tile.querySelector("img[src]") || tile.querySelector("video[src]");
  return media?.getAttribute("src")?.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0] || undefined;
}`;

// What the grid looked like before a job started: the media uuids of the tiles mounted at the top, plus the titles
// of the few older video tiles that still have no uuid at all. The titles are only ever used to recognise a tile
// that was already there - never to identify a new one.
export async function mediaIds(page: Page): Promise<string[]> {
  return page.evaluate(
    (js) =>
      [...document.querySelectorAll("flow-grid-tile-container")].flatMap((t) => {
        const id = (eval(js) as (t: Element) => string | undefined)(t);
        if (id) return [id];
        const name = t.getAttribute("aria-label");
        return name ? ["title:" + name] : [];
      }),
    TILE_ID_JS,
  );
}

// One walk down from the top of the grid, shared by everything that asks "what is new?". The grid is VIRTUALISED -
// a 97-tile project mounts about 33 tiles at the top - so "an id that was not in my snapshot" proves nothing: a
// download that scrolls mounts old tiles, and they then look fresh. Measured on 2026-10-21 with nothing generated
// at all, that rule reported 31 fresh tiles. What is reliable is the ORDER: Flow puts a new tile first. So the walk
// stops at the first tile we already knew, and only what is above it is new.
//
// Each candidate carries what freshMedia needs to throw it out again: three things have looked "new" here without
// being it (2026-10-09: 31 finished clips reported failed with "tile menu has no Download item. It offered: Delete")
// - our OWN uploads (named fm-<job>-...), a tile of the wrong kind such as the still "Save frame" makes on the way
// to a continuation, and a tile still rendering. A busy tile neither counts nor ends the walk: it is just not ready.
const WALK_JS = `([known, idJs]) => {
  const seen = new Set(known);
  const idOf = eval(idJs);
  const fresh = [];
  const pending = [];
  let errors = 0;
  for (const tile of document.querySelectorAll("flow-grid-tile-container")) {
    const id = idOf(tile);
    if (id && seen.has(id)) return { fresh, pending, errors, sawKnown: true };
    if (tile.querySelector("flow-error-tile")) { errors++; continue; }
    const text = tile.innerText || "";
    const pct = text.match(/\d+%/);
    // For the first seconds after Start generation, before any "NN%" shows, a new video tile is titled with the
    // prompt itself and has no thumbnail; then it takes a short title of Flow's own and counts up; finished, it has
    // its thumbnail (watched live 2026-10-16, a 4 s clip: prompt title at 9 s, "0%" at 12 s, 100% at 34 s, thumbnail
    // at 35 s). "No NN% means done" took the tile in those first seconds and lost a user's clip.
    const isVideo = !!tile.querySelector("flow-video-tile");
    const busy = !!pct || (isVideo && !tile.querySelector('img[alt="Generated video thumbnail"], video'));
    if (busy) { if (pct) pending.push(pct[0]); continue; }
    if (id) {
      fresh.push({ id, kind: isVideo ? "video" : tile.querySelector("flow-image-tile") ? "image" : "other", label: tile.getAttribute("aria-label") || "" });
      continue;
    }
    // No uuid and not rendering: one of Flow's older /asb/ video thumbnails. Nothing Flow makes today looks like
    // that, so it cannot be new - if we knew its title it ends the walk, otherwise it is simply stepped over.
    const name = tile.getAttribute("aria-label");
    if (name && seen.has("title:" + name)) return { fresh, pending, errors, sawKnown: true };
  }
  return { fresh, pending, errors, sawKnown: false };
}`;

type MediaKind = "image" | "video";

interface GridWalk {
  fresh: { id: string; kind: string; label: string }[];
  pending: string[];
  errors: number;
  sawKnown: boolean;
}

async function walkNewTiles(page: Page, known: Iterable<string>): Promise<GridWalk> {
  return page.evaluate(
    ([ids, idJs, walkJs]: [string[], string, string]) => (eval(walkJs) as (a: [string[], string]) => GridWalk)([ids, idJs]),
    [[...known], TILE_ID_JS, WALK_JS] as [string[], string, string],
  );
}

// The ids of tiles above the snapshot that really are this job's output: not one of our own uploads, and of the
// kind asked for.
function ownTiles(walk: GridWalk, kind?: MediaKind): string[] {
  return [...new Set(walk.fresh.filter((t) => !t.label.startsWith("fm-") && (!kind || t.kind === kind)).map((t) => t.id))];
}

export async function freshMedia(page: Page, before: string[], kind?: MediaKind): Promise<string[]> {
  return ownTiles(await walkNewTiles(page, before), kind);
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

// A media uuid, and only a media uuid: whatever this returns is the tile that actually holds that piece of media.
const mediaTile = (page: Page, id: string) =>
  page.locator(`flow-grid-tile-container:has([data-media-id="${id}"]), flow-grid-tile-container:has([src*="${id}"])`).first();

// A failed generation becomes a <flow-error-tile> ("Failed ... You have not been charged") with Flow's own Retry
// button. Old failures can sit anywhere in the grid, so only error tiles above the first already-known tile count.
export async function newErrorTiles(page: Page, known: Iterable<string>): Promise<number> {
  return (await walkNewTiles(page, known)).errors;
}

// Flow's Retry replaces the failed tile with a fresh render of the same prompt and settings, free of charge.
// Tiles produced by Agent mode only offer Delete, so the button may not be there at all.
async function retryErrorTile(page: Page, tile: Locator): Promise<boolean> {
  await hoverTile(page, tile);
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
          // "title:<name>" is how a snapshot records a tile with no uuid; a bare name is what the agent batch passes.
          if ((id && seen.has(id)) || (name && (seen.has(name) || seen.has("title:" + name)))) return "known";
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

// Returns the media uuids of the tiles this job just made - nothing else. A tile only counts when it sits ABOVE a
// tile that was already in the snapshot, so a stranger the virtualised grid happened to mount can never be mistaken
// for ours. If no such tile ever appears, this times out and says so, which is the honest answer: on 2026-10-21 the
// old rule instead handed back two frames from another clip, which were then renamed and downloaded over the job's
// real output.
async function waitForNewMedia(page: Page, before: string[], count: number, timeoutMs: number, job?: Job, kind?: MediaKind): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  const emptyGrid = before.length === 0;
  let retriesLeft = job?.params.retries ?? 1;
  let failures = 0;
  let seen = "";
  while (Date.now() < deadline) {
    await pause(page, 2000);
    // The walk only means anything read from the top: scrolled down, the first tile in the DOM is an old one, and
    // one that was outside the snapshot's window would be taken for new. Re-asserting the top costs nothing.
    await scrollToTop(page);
    const walk = await walkNewTiles(page, before);
    const fresh = ownTiles(walk, kind);
    // Without a known tile below them there is no proof these are new - unless the project really was empty.
    const trustworthy = walk.sawKnown || emptyGrid;
    if (trustworthy && fresh.length >= count) return fresh.slice(0, count);
    if (job) job.progress = walk.pending.join(", ") || undefined;
    const errors = walk.pending.length ? 0 : walk.errors;
    if (!errors) continue;
    failures += errors;
    if (retriesLeft > 0) {
      retriesLeft--;
      if (job) job.progress = "Flow failed, retrying";
      const retried = await retryErrorTile(page, page.locator("flow-grid-tile-container:has(flow-error-tile)").first());
      if (retried) continue;
    }
    if (trustworthy && fresh.length) return fresh;
    throw new Error(`Flow failed this generation ${failures} time(s) ("Sorry, this image/video failed to generate"). Nothing was charged. Try again later or reword the prompt.`);
  }
  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Flow to finish. Nothing was renamed or downloaded. ` +
      `If Flow did produce it, the media is in the project under Flow's own title and flow_download fetches it without spending credits again.`,
  );
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

// Image jobs use the newest Nano Banana unless another model is named (the user's call, 2026-10-13: "should always
// default to latest"). The menu then held Nano Banana Pro, 2 Lite and 2.1 - the plain "Nano Banana 2" was gone, and
// asking for it by name picked whichever came first. The newest is the highest version number that is not a Lite model,
// read from Flow's own menu, so a later 2.2 or 3 is picked with no code change.
export const LATEST_IMAGE_MODEL = "latest";
const LEGACY_IMAGE_MODEL = /^\s*(nano banana( 2)?|latest)?\s*$/i;
export function newestNanoBanana(names: string[]): number {
  const version = (n: string) => /nano banana\s+(\d+(?:\.\d+)*)/i.exec(n)?.[1]?.split(".").map(Number);
  let best = -1;
  names.forEach((n, i) => {
    const v = version(n);
    if (!v || /\blite\b/i.test(n)) return;
    const b = best < 0 ? undefined : version(names[best])!;
    const newer = !b || v.some((x, k) => x !== (b[k] ?? 0) && v.slice(0, k).every((y, j) => y === (b[j] ?? 0)) && x > (b[k] ?? 0));
    if (newer) best = i;
  });
  return best;
}

async function pickModel(page: Page, model: string): Promise<void> {
  const button = page.getByRole("button", { name: "Select model family" });
  const latest = model === LATEST_IMAGE_MODEL;
  if (!latest && (await button.innerText()).toLowerCase().includes(model.toLowerCase())) return;
  await button.click();
  const items = page.getByRole("menuitem");
  await items.first().waitFor({ state: "visible", timeout: 5000 });
  const names = (await items.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  const index = latest ? newestNanoBanana(names) : names.findIndex((n) => n.toLowerCase().includes(model.toLowerCase()));
  const shown = (await button.innerText()).replace(/\s+/g, " ");
  if (index < 0 || (latest && shown.includes(names[index]))) {
    // Nothing to change (already the newest, or no numbered Nano Banana here at all): close the menu, pick nothing.
    await page.keyboard.press("Escape");
    await clearBackdrops(page);
    if (index < 0 && !latest) throw new Error(`Model "${model}" not found. Available here: ${names.join(", ")}`);
    return;
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
  const model = s.type === "image" && LEGACY_IMAGE_MODEL.test(s.model ?? "") ? LATEST_IMAGE_MODEL : s.model;
  if (model) await pickModel(page, model);
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

// Waits for THIS upload by its own name until Flow has finished processing it (its picture carries a media id), so
// a half-processed upload can never be taken for the next generation's result.
async function waitForUpload(page: Page, name: string, timeoutMs: number): Promise<void> {
  const tile = page.locator(`flow-grid-tile-container[aria-label="${name.replace(/"/g, '\\"')}"]:has([data-media-id])`);
  await tile
    .first()
    .waitFor({ state: "attached", timeout: timeoutMs })
    .catch(() => {
      throw new Error(`Flow did not finish processing the upload "${name}" within ${Math.round(timeoutMs / 1000)}s.`);
    });
  await pause(page, 1000);
}

// Uploads under a unique filename so the asset can be picked unambiguously afterwards.
// "asset:<name>" refers to something already in the Flow project (image, video, character) and skips the upload.
async function uploadAsset(page: Page, job: Job, file: string, label: string): Promise<string> {
  if (file.startsWith(ASSET_PREFIX)) return file.slice(ASSET_PREFIX.length).trim();
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  const name = `fm-${job.id}-${label}${extname(file).toLowerCase()}`;
  const staged = join(mkdtempSync(join(tmpdir(), "flow-mcp-")), name);
  copyFileSync(file, staged);
  await scrollToTop(page);
  await page.getByRole("button", { name: "Add media menu" }).click();
  const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
  await page.getByRole("menuitem", { name: "Upload", exact: true }).click();
  await (await chooser).setFiles(staged);
  await waitForUpload(page, name, 90_000);
  return name;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Options read "<name>", "<name> Image|Video|Avatar" or "<voice> <description>", so match on the leading name.
const optionByName = (list: Locator, name: string) =>
  list.getByRole("option", { name: new RegExp(`^${escapeRe(name)}`, "i") }).first();

// The asset list is a cdk-virtual-scroll-viewport ("asset-list-viewport"): it holds about 15 of the project's
// assets in the DOM at a time out of a 3504px-tall list (mapped 2026-10-21). Waiting for an option that is simply
// not mounted yet is how three animations died on a 10 s timeout, while two frames with titles of exactly the same
// shape attached first time - the difference was only that they were among the newest.
const assetViewport = "cdk-virtual-scroll-viewport.asset-list-viewport";

// Finds the option wherever it is in the list: what is already mounted, then the panel's own "Search assets" box
// (it filters the whole project, not just the mounted window), then the viewport scrolled to the end.
async function findAssetOption(page: Page, list: Locator, assetName: string): Promise<Locator | null> {
  const option = optionByName(list, assetName);
  const visible = () => option.isVisible().catch(() => false);
  if (await visible()) return option;

  const search = page.getByPlaceholder("Search assets");
  if (await search.isVisible().catch(() => false)) {
    await search.fill(assetName);
    await pause(page, 1500);
    if (await visible()) return option;
    await search.fill("");
    await pause(page, 1000);
  }

  await page.evaluate((sel) => document.querySelector(sel)?.scrollTo({ top: 0 }), assetViewport);
  await pause(page, 500);
  for (let step = 0; step < 80; step++) {
    const moved = await page.evaluate((sel) => {
      const vp = document.querySelector(sel);
      if (!vp) return false;
      const top = vp.scrollTop;
      vp.scrollTop = top + vp.clientHeight * 0.8;
      return vp.scrollTop > top;
    }, assetViewport);
    await pause(page, 400);
    if (await visible()) return option;
    if (!moved) break;
  }
  return null;
}

// The frame pickers attach on click; the ingredients picker only previews and needs "Add to prompt".
// Option names are "<asset name>" or "<asset name> Image|Video", so match on the prefix.
export async function attachAsset(page: Page, opener: Locator, assetName: string): Promise<void> {
  const list = page.getByRole("listbox", { name: "Asset list" });
  const all = page.getByRole("tab", { name: "All", exact: true });
  const shows = (l: Locator, ms: number) => l.waitFor({ state: "visible", timeout: ms }).then(() => true, () => false);
  // Twice on 2026-10-09 (a character, then an uploaded still) the click on the opener produced no picker at all, and
  // the job died waiting for it. It never reproduced when replayed, so it was something transient in the way - most
  // likely the upload menu still closing. Like the settings popover, the picker gets three tries, with Escape in
  // between to clear whatever caught the click. The Start/End frame pickers have no tabs, hence list OR All tab.
  let opened = false;
  for (let attempt = 0; attempt < 3 && !opened; attempt++) {
    if (attempt) {
      await page.keyboard.press("Escape");
      await pause(page, 800);
    }
    await opener.click();
    opened = await Promise.race([shows(list, 5000), shows(all, 5000)]);
  }
  if (!opened) throw new Error(`Flow's media picker did not open (three tries) while attaching "${assetName}". Nothing was generated.`);
  // The picker reopens on whichever tab was used last (Characters, after a character), so start from All each time.
  if ((await all.isVisible().catch(() => false)) && (await all.getAttribute("aria-selected")) !== "true") {
    await all.click();
    await pause(page, 1000);
  }
  await list.waitFor({ state: "visible", timeout: 10_000 });
  // A search left over from a previous attach would hide everything, so the panel always starts unfiltered.
  // Short timeout on purpose: a picker without a search box must not cost 30 s of Playwright's default wait.
  const search = page.getByPlaceholder("Search assets");
  if (await search.inputValue({ timeout: 1500 }).catch(() => "")) {
    await search.fill("");
    await pause(page, 800);
  }
  let option = await findAssetOption(page, list, assetName);
  // Voices, characters and avatars live behind their own tabs, so look there when "All" does not have it.
  if (!option) {
    for (const tab of ["Voices", "Characters", "Avatars", "Uploads"]) {
      const t = page.getByRole("tab", { name: tab, exact: true });
      if (!(await t.isVisible().catch(() => false))) continue;
      await t.click();
      await pause(page, 1200);
      option = await findAssetOption(page, list, assetName);
      if (option) break;
    }
  }
  if (!option) {
    // The ingredients picker leaves aria-label EMPTY and names its options through their text, so both are read.
    const offered = await list.getByRole("option").evaluateAll((os) => os.slice(0, 8).map((o) => (o.getAttribute("aria-label") || o.textContent || "").replace(/\s+/g, " ").trim()));
    await page.keyboard.press("Escape").catch(() => {});
    throw new Error(
      `Flow's asset list has nothing starting with "${assetName}", after searching it and scrolling it to the end. Nothing was generated. Check the title with flow_assets, or pass an absolute file path instead. The list showed: ${offered.join(" | ") || "(empty)"}`,
    );
  }
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

export async function downloadMedia(page: Page, mediaId: string, targetStem: string, quality: DownloadQuality = "original"): Promise<string[]> {
  // A tile that has just finished rendering is still settling and the grid re-renders around it, so give it a moment.
  await scrollToTop(page);
  await pause(page, 2500);
  const tile = mediaTile(page, mediaId);
  await tile.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {
    throw new Error(
      `The finished file is in Flow but could not be found again in the grid${mediaId.startsWith("title:") ? ` (looked for "${mediaId.slice(6)}")` : ""}. ` +
        `Nothing is lost: flow_download fetches it by its title without spending credits again.`,
    );
  });
  // Grab the title NOW, while the id still resolves, so the download can re-find this exact tile later even if the
  // virtualised grid unmounts and remounts it between steps.
  const title = (await tile.getAttribute("aria-label").catch(() => null)) ?? undefined;
  return downloadTile(page, tileByIdOrTitle(page, mediaId, title), targetStem, quality);
}

type TileResolver = () => Promise<Locator>;

// Re-finds the tile on every attempt instead of trusting one handle that may have been unmounted by the virtual grid:
// by id first, then by title. NOT a confirmed root cause for the post-generation download failures - the failure has
// never reproduced on a settled tile - but it removes one whole class of staleness, and the menu dump below is what
// will actually explain the next one. An empty "Untitled Scene" placeholder holds no media and its menu has no
// Download, so :has([src]) makes sure we never grab one by title.
function tileByIdOrTitle(page: Page, id: string, title?: string): TileResolver {
  return async () => {
    const byId = mediaTile(page, id);
    if (await byId.count()) return byId;
    if (title) {
      const byTitle = page.locator(`flow-grid-tile-container[aria-label="${title.replace(/"/g, '\\"')}"]:has([src])`).first();
      if (await byTitle.count()) return byTitle;
    }
    throw new Error(
      `The finished tile is no longer in the grid${title ? ` ("${title}")` : ""}. The media is still in Flow: flow_download fetches it without spending credits again.`,
    );
  };
}

const DOWNLOAD_DIR = join(HOME_DIR, "downloads");
let downloadsReady = false;

// Playwright keeps a download in a per-connection temp file it can delete from under us; pointing Chrome itself at a
// directory we own makes the bytes ours the moment they land.
async function useOwnDownloadDir(page: Page): Promise<void> {
  // Setting this once per process was not enough: another CDP client attaching resets it browser-wide, and Chrome
  // quietly goes back to ~/Downloads. Every file we "could not download" tonight was sitting there the whole time,
  // so this is re-asserted before every single download rather than cached behind a flag.
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: DOWNLOAD_DIR, eventsEnabled: true }).catch(() => {});
  downloadsReady = true;
}

// Chrome's own Downloads folder, where files land whenever the override above has been reset out from under us.
const SYSTEM_DOWNLOADS = join(homedir(), "Downloads");

// Everything already sitting in either folder, so a new arrival can be told apart from what was there before.
function downloadsNow(): Set<string> {
  const seen = new Set<string>();
  for (const dir of [DOWNLOAD_DIR, SYSTEM_DOWNLOADS]) if (existsSync(dir)) for (const f of readdirSync(dir)) seen.add(`${dir}/${f}`);
  return seen;
}

// Waits for a file to finish arriving in our download directory and returns it.
async function waitForDownloadedFile(page: Page, before: Set<string>, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let stable: { path: string; size: number } | undefined;
  while (Date.now() < deadline) {
    // Every quarter second: an image is there in well under a second, and a size that held still across two checks
    // still proves Chrome has finished writing it.
    await pause(page, 250);
    // Both places: ours, and Chrome's own folder for when the override has been reset behind our back.
    const candidates: string[] = [];
    for (const dir of [DOWNLOAD_DIR, SYSTEM_DOWNLOADS]) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (before.has(`${dir}/${f}`) || f.endsWith(".crdownload") || f.startsWith(".")) continue;
        candidates.push(join(dir, f));
      }
    }
    for (const path of candidates) {
      const size = statSync(path).size;
      if (stable?.path === path && stable.size === size && size > 0) return path;
      stable = { path, size };
    }
  }
  throw new Error("Flow started the download but no file arrived in either the tool's folder or ~/Downloads.");
}

// Flow reveals a tile's controls on a genuine pointer move, so the mouse is driven to the tile itself.
async function hoverTile(page: Page, tile: Locator, settleMs = 900): Promise<void> {
  await tile.scrollIntoViewIfNeeded();
  const box = await tile.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await pause(page, settleMs);
  } else {
    await tile.hover();
    await pause(page, settleMs);
  }
}

// Chrome's "allowAndName" writes each download under a bare id with NO extension, so there is nothing to copy from
// the filename and everything was landing as .mp4 - including stills, which arrived as clip-01.mp4. Read the first
// bytes instead and name the file after what it actually is.
function extensionOf(file: string): string {
  const head = Buffer.alloc(12);
  const fd = openSync(file, "r");
  try {
    readSync(fd, head, 0, 12, 0);
  } finally {
    closeSync(fd);
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return ".jpeg";
  if (head[0] === 0x89 && head.subarray(1, 4).toString("latin1") === "PNG") return ".png";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return ".webp";
  if (head.subarray(4, 8).toString("latin1") === "ftyp") return ".mp4";
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return ".gif";
  // Flow hands back a ZIP when one tile holds several takes (a generation made at x2-x4): the takes come bundled.
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return ".zip";
  // Anything else is unknown. Naming it .mp4 (the old fallback) made two ZIPs look like broken videos and broke a cut.
  return ".bin";
}

// Unpacks a multi-take ZIP into <stem>.mp4, <stem>-v2.mp4, ... - the same names a multi-variant generation gets - so
// every take is usable instead of one unplayable archive. The ZIP is kept beside them, renamed, in case it is wanted.
function unpackTakes(zip: string, targetStem: string): string[] {
  const work = mkdtempSync(join(tmpdir(), "flow-takes-"));
  const takes = extractZip(zip, work).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const out: string[] = [];
  for (const [i, path] of takes.entries()) {
    const dest = `${targetStem}${i ? `-v${i + 1}` : ""}${extensionOf(path)}`;
    renameSync(path, dest);
    out.push(dest);
  }
  renameSync(zip, `${targetStem}-takes.zip`);
  if (!out.length) throw new Error("Flow sent a ZIP with nothing usable inside it.");
  return out;
}

// Titles this tool gives assets of its own: "<folder>-<file stem>", where the stems are scene-NN / clip-NN /
// edit-NN. A tile already wearing one is an asset from an earlier run, never a tile a job has just made.
const OUR_TITLE = /-(?:scene|clip|edit)-\d{1,3}(?:-v\d+)?$/i;

// Flow titles clips itself and happily reuses a title: two takes of the same scene both came back as "Woman climbing
// granite wall", which makes a clip impossible to identify by name and cost real time tonight. Renaming each finished
// tile to our own scene name fixes it at the source - the user's suggestion, and the right one.
// The guard is the last line of defence under that: renaming a tile that already carries one of OUR names would wipe
// a name later steps rely on, which is exactly what happened on 2026-10-21, so it throws instead. It is off only for
// flow_rename, where putting such a name back is the whole point and the user has named the tile themselves.
async function renameTile(page: Page, tile: Locator, title: string, guard = true): Promise<boolean> {
  const existing = (await tile.getAttribute("aria-label").catch(() => null)) ?? "";
  if (guard && OUR_TITLE.test(existing)) {
    throw new Error(
      `Refusing to rename "${existing}" to "${title}": that title was given by this tool to an earlier asset, so this is not the tile the job just made. Nothing was renamed or downloaded.`,
    );
  }
  try {
    await hoverTile(page, tile);
    const more = tile.getByRole("button", { name: "More options" });
    if (!(await more.isVisible({ timeout: 3000 }).catch(() => false))) return false;
    await more.click();
    const rename = page.getByRole("menuitem", { name: "Rename", exact: true });
    if (!(await rename.isVisible({ timeout: 4000 }).catch(() => false))) {
      await page.keyboard.press("Escape");
      return false;
    }
    await rename.click();
    await pause(page, 1200);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(title, { delay: 8 });
    await page.keyboard.press("Enter");
    await pause(page, 1500);
    return true;
  } catch {
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
}

async function downloadTile(page: Page, target: Locator | TileResolver, targetStem: string, quality: DownloadQuality): Promise<string[]> {
  await useOwnDownloadDir(page);
  const resolve: TileResolver = typeof target === "function" ? target : async () => target;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const tile = await resolve();
      const before = downloadsNow();
      // Flow only shows a tile's toolbar for a real pointer move over it - Playwright's hover() does not trigger it.
      // The toolbar's "More options" beats a right-click, which can land on the <video> and raise Chrome's own menu.
      await hoverTile(page, tile, 250);
      const more = tile.getByRole("button", { name: "More options" });
      // isVisible() answers at once whatever timeout it is given, so wait for the button itself.
      if (await more.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false)) await more.click();
      else await tile.click({ button: "right" });
      const download = page.getByRole("menuitem", { name: "Download", exact: true });
      if (!(await download.isVisible({ timeout: 8000 }).catch(() => false))) {
        // Saying what Flow actually offered turns "locator timed out" into something that explains itself next time.
        const items = await page.locator('[role="menuitem"]').evaluateAll((ms) => ms.map((m) => (m.textContent ?? "").replace(/\s+/g, " ").trim()));
        throw new Error(items.length ? `Flow's tile menu has no Download item. It offered: ${items.join(" | ")}` : "Flow's tile menu did not open.");
      }
      await download.click({ timeout: 10_000 });
      // Size submenu: "720p Original size" / "1K Original size", or the best upscale the plan allows.
      const original = page.getByRole("menuitem", { name: /original/i }).first();
      if (await original.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false)) {
        const upscaled = page.locator('[role="menuitem"]:not([aria-disabled="true"]):not([disabled])').filter({ hasText: /upscaled/i }).first();
        const wanted = quality === "upscaled" && (await upscaled.isVisible().catch(() => false)) ? upscaled : original;
        await wanted.click();
      }
      // Upscales are rendered on demand, so they can take minutes to appear.
      const file = await waitForDownloadedFile(page, before, quality === "upscaled" ? 600_000 : 180_000);
      const kind = extensionOf(file);
      let saved: string[];
      if (kind === ".zip") saved = unpackTakes(file, targetStem);
      else {
        const target = `${targetStem}${kind}`;
        renameSync(file, target);
        saved = [target];
      }
      await page.keyboard.press("Escape");
      await scrollToTop(page);
      return saved;
    } catch (err) {
      lastError = err;
      await page.keyboard.press("Escape").catch(() => {});
      await pause(page, 2000);
    }
  }
  throw lastError;
}

// The left-hand "Project navigation" (All media, Images, Videos, Characters...). Its Collapse button (a setting Flow
// keeps for every project) turns it into a strip of icons with no labels, and getByText("Characters") then found
// nothing visible. Each item's text holds its icon name and its label whether or not the label shows, so it is found by
// label in both states. (Why the menu used to vanish altogether: see leaveSideMenu.)
async function clickProjectNav(page: Page, item: string): Promise<boolean> {
  const button = page
    .getByRole("navigation", { name: "Project navigation" })
    .locator("button, a")
    .filter({ hasText: new RegExp(`${item}\\s*$`) })
    .first();
  if (!(await button.isVisible().catch(() => false))) return false;
  await button.click({ timeout: 5000 });
  await leaveSideMenu(page);
  return true;
}

// The left-hand menu is a Material drawer, and Escape shuts it whenever the keyboard focus is inside it. Clicking
// "All media" left the focus there, so the very next Escape (dismissOverlays runs before almost every step) shut the
// menu for the rest of the session: the user's menu vanished, "All media" was hidden from then on, and each later click
// on it waited out Playwright's 30 s default (traced with DEBUG=pw:api, 2026-10-13). Take the focus out first.
async function leaveSideMenu(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const focused = document.activeElement as HTMLElement | null;
      if (focused?.closest("mat-sidenav")) focused.blur();
    })
    .catch(() => {});
}
async function openProjectNav(page: Page, item: string): Promise<void> {
  if (await clickProjectNav(page, item)) return;
  // A page load shows the menu again in whatever state the user keeps it, and changes nothing about that choice.
  await page.goto(inEnglish(page.url()), { waitUntil: "domcontentloaded" });
  await pause(page, 3000);
  if (!(await clickProjectNav(page, item))) throw new Error(`Flow's left-hand menu is not showing, so "${item}" could not be opened. Show the menu in the Flow window and try again.`);
}

// All media: through the left-hand menu when it shows. When it does not (collapsed and scrolled away), the top bar's
// Filter menu does the same job: nothing ticked, newest first. `thorough` (the start of a job) checks that menu; a
// plain grid scan does not, so a hidden menu costs nothing.
async function showAllMedia(page: Page, thorough = false): Promise<void> {
  if (await clickProjectNav(page, "All media").catch(() => false)) return;
  const filter = page.getByRole("button", { name: "Filtering and sorting options" });
  if (!thorough || !(await filter.isVisible().catch(() => false))) return;
  await filter.click({ timeout: 5000 }).catch(() => {});
  await pause(page, 600);
  const menu = page.locator(".cdk-overlay-container");
  if (await menu.locator("input[type=checkbox]:checked").count().catch(() => 0)) {
    await page.getByRole("button", { name: "Clear all filters" }).click({ timeout: 4000 }).catch(() => {});
    await pause(page, 600);
  }
  // New tiles must come first: everything that finds a fresh result looks at the top of the grid.
  const newest = menu.locator("label", { hasText: /^\s*Newest\s*$/ }).locator("input[type=radio]");
  if ((await newest.count().catch(() => 0)) && !(await newest.first().isChecked().catch(() => true))) {
    await newest.first().click({ force: true, timeout: 4000 }).catch(() => {});
    await pause(page, 600);
  }
  await page.keyboard.press("Escape");
  await clearBackdrops(page);
}

async function ensureProjectGrid(page: Page): Promise<void> {
  await dismissOverlays(page);
  const root = page.url().match(/^https:\/\/[^/]+\/project\/[0-9a-f-]{36}/)?.[0];
  // Compared by path: an address ending in ?hl=en is already the grid.
  if (root && new URL(page.url()).pathname !== new URL(root).pathname) {
    await page.goto(inEnglish(root), { waitUntil: "domcontentloaded" });
    await pause(page, 2500);
  }
  // An agent chat left open (e.g. the user asked Flow's agent something) covers the composer and hides `Agent`.
  if (await page.getByRole("button", { name: "Start new session" }).isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Close", exact: true }).click().catch(() => {});
    await pause(page, 1000);
  }
  await showAllMedia(page, true);
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
  // Flow's composer offers Frames OR Ingredients, never both: a clip with first/last frames cannot also carry
  // reference images. The frames already pin the look, so the references are dropped and the job says so.
  const framesMode = s.type === "video" && Boolean(s.first_frame || s.last_frame);
  if (framesMode && s.reference_images?.length) {
    job.note = [job.note, `first/last frames were set, so ${s.reference_images.length} reference image(s) were skipped — Flow allows one or the other.`]
      .filter(Boolean)
      .join(" · ");
    s.reference_images = [];
  }
  for (const [i, ref] of (s.reference_images ?? []).entries()) {
    const name = await uploadAsset(page, job, ref, `ref${i + 1}`);
    await attachAsset(page, page.getByRole("button", { name: "Add ingredients to the prompt box" }), name);
  }
  const wanted = (s.reference_images ?? []).length;
  if (wanted) {
    const attached = await page.getByRole("button", { name: "Ingredient" }).count();
    if (attached < wanted) throw new Error(`Only ${attached} of ${wanted} reference image(s) attached in Flow; nothing was generated.`);
  }

  await typePrompt(page, s.prompt);
  const start = page.getByRole("button", { name: "Start generation" });
  if (!(await start.isEnabled())) throw new Error("Flow's Start generation button is disabled; the prompt or inputs were not accepted.");
  await scrollToTop(page);
  const before = await mediaIds(page);
  await start.click();

  const variants = s.variants ?? 1;
  const fresh = await waitForNewMedia(page, before, variants, s.type === "image" ? IMAGE_TIMEOUT_MS : VIDEO_TIMEOUT_MS, job, s.type === "image" ? "image" : "video");
  job.progress = undefined;

  mkdirSync(s.output_dir, { recursive: true });
  const files: string[] = [];
  for (const [i, id] of fresh.entries()) {
    const label = fresh.length > 1 ? `${s.file_stem}-v${i + 1}` : s.file_stem;
    // Flow names clips itself and reuses those names, so two takes of one scene come back identically titled and
    // neither can be found by name afterwards. Renaming each finished tile to the scene's own file stem makes every
    // later lookup - download, continue, assemble - unambiguous. A rename that merely fails returns false and the
    // clip is still downloaded; the one thing that is NOT survivable is renaming a tile that is not ours, so that
    // check throws and takes the whole job down with it rather than quietly destroying another asset's name.
    const newTitle = `${basename(s.output_dir)}-${label}`;
    const renamed = await renameTile(page, mediaTile(page, id), newTitle);
    if (renamed) job.note = [job.note, `renamed in Flow to ${newTitle}`].filter(Boolean).join(" · ");
    await pause(page, 800);
    const stem = join(s.output_dir, label);
    // A video at rest has no media id, so it is tracked by its title - which the rename just changed. Looking for the
    // old title failed every such download after 30 s ("locator.waitFor: Timeout 30000ms exceeded ... aria-label=
    // <the prompt>", reported by a user, 2026-10-15) while the clip sat finished and renamed in Flow.
    const handle = renamed && id.startsWith("title:") ? `title:${newTitle}` : id;
    files.push(...(await downloadMedia(page, handle, stem, s.download_quality)));
    await pause(page, 1500);
  }
  return files;
}

export interface FlowAsset {
  name: string;
  kind: "image" | "video" | "scene";
  id?: string;
}

// Walks the virtualised grid from the top and collects every tile it passes. Recycled tiles sometimes have no
// media id yet, so entries are keyed by title and the id is filled in from whichever pass saw it.
async function scanGrid(page: Page, stopAt?: (assets: FlowAsset[]) => boolean): Promise<FlowAsset[]> {
  await dismissOverlays(page);
  await showAllMedia(page);
  await pause(page, 600);
  await scrollToTop(page);
  const seen = new Map<string, FlowAsset>();
  for (let step = 0; step < 200; step++) {
    const batch = await page.evaluate(
      (js) =>
        [...document.querySelectorAll("flow-grid-tile-container")].map((t) => ({
          name: t.getAttribute("aria-label") ?? "",
          // A scene (several clips on one timeline) is its own tile type; lumping it in with images made it look
          // like a still in the Library and download as a ZIP of loose clips.
          kind: t.querySelector("flow-scene-tile") ? ("scene" as const) : t.querySelector("flow-video-tile") ? ("video" as const) : ("image" as const),
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
  await openProjectNav(page, "Characters");
  await pause(page, 2500);
  const names = await page.evaluate(() =>
    [...document.querySelectorAll("flow-character-tile")].map((t) => (t as HTMLElement).innerText.replace(/\s+/g, " ").trim()).filter(Boolean),
  );
  await ensureProjectGrid(page).catch(() => {});
  // Strip Material icon ligatures Flow renders as text ("accessibility_new", "person") and its own avatar.
  return [...new Set(names.map((n) => n.replace(/\b(accessibility_new|person|movie|image|videocam|mic)\b/g, "").replace(/\s+/g, " ").trim()))].filter(
    (n) => n && n !== "Me",
  );
}

// A run that stopped half-way leaves Flow inside a character's editor, where the project navigation is gone. Done keeps
// whatever is on screen - leaving any other way could drop a finished edit - and then the grid is put back.
async function leaveCharacterEditor(page: Page): Promise<void> {
  if (/\/character(\/|$)/.test(new URL(page.url()).pathname)) {
    await page.getByRole("button", { name: /^Done( editing)?$/ }).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForURL((u) => !/\/character/.test(u.pathname), { timeout: 10_000 }).catch(() => {});
  }
  await ensureProjectGrid(page).catch(() => {});
}

// The portrait's own toolbar (Download image, Delete image) sits invisible with pointer events off until a real pointer
// moves over the picture - the same rule as grid tiles - so a plain click lands on the image and times out. That, plus
// Playwright's download event, is why an edit that worked never reached disk (2026-10-02). Point at the picture, then
// download through the same watched folders as every other file.
async function savePortrait(page: Page, name: string): Promise<string> {
  await useOwnDownloadDir(page);
  const dir = join(process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out"), "_cast");
  mkdirSync(dir, { recursive: true });
  const picture = page.getByRole("img", { name: "Generated character image" }).first();
  const button = page.getByRole("button", { name: "Download image", exact: true });
  const before = downloadsNow();
  let pressed = false;
  for (let attempt = 0; attempt < 3 && !pressed; attempt++) {
    await hoverTile(page, picture);
    pressed = await button.click({ timeout: 4000 }).then(
      () => true,
      () => false,
    );
  }
  if (!pressed) throw new Error("Flow never showed the portrait's Download image button");
  const file = await waitForDownloadedFile(page, before, 90_000);
  const portrait = join(dir, `${name.replace(/[^\w.-]+/g, "_")}${extensionOf(file)}`);
  renameSync(file, portrait);
  return portrait;
}

// Opens an existing character and restyles its portrait in place (Nano Banana, free) instead of making a new one.
// Without a change it only saves the character's current portrait: for a look changed by hand in Flow, or an edit whose
// portrait never reached disk.
export async function editCharacter(name: string, change?: string, job?: Job): Promise<{ name: string; portrait?: string; note?: string }> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  await leaveCharacterEditor(page);
  await dismissOverlays(page);
  await openProjectNav(page, "Characters");
  await pause(page, 2500);

  const card = page.locator("flow-character-tile").filter({ hasText: name }).first();
  if (!(await card.isVisible().catch(() => false))) throw new Error(`No character called "${name}". Use flow_characters to list them.`);
  await card.scrollIntoViewIfNeeded();
  await card.click();
  await page.waitForURL(/\/character\/[0-9a-f-]{36}/, { timeout: 20_000 });
  await pause(page, 2000);

  if (change) {
    const portraitImg = page.getByRole("img", { name: "Generated character image" }).first();
    const before = await portraitImg.getAttribute("src").catch(() => null);

    const box = page.locator(".ProseMirror").last();
    await box.click();
    await page.keyboard.press("ControlOrMeta+a");
    // Delete leaves a full selection standing in this editor; Backspace clears it (mapped 2026-10-02).
    await page.keyboard.press("Backspace");
    // The character editor always draws a wide 16:9 picture (1376x768), whatever shape the portrait was. Told only "make
    // his coat red", it filled the frame with three Pips side by side (2026-10-02), so every edit pins a single figure.
    const told = `${change.replace(/\s*\n+\s*/g, " ").trim().replace(/[.\s]*$/, ".")} Exactly one ${name} in the picture: never add copies of ${name} or extra poses side by side.`;
    await page.keyboard.type(told, { delay: 8 });
    await pause(page, 600);
    const start = page.getByRole("button", { name: "Start generation" });
    if (!(await start.isEnabled())) throw new Error("Flow did not accept the change (Start generation stayed disabled).");
    await start.click();

    const deadline = Date.now() + 4 * 60_000;
    for (;;) {
      await pause(page, 3000);
      const now = await portraitImg.getAttribute("src").catch(() => null);
      const pct = (await page.locator("main").first().innerText()).match(/\d+%/)?.[0];
      if (job) job.progress = pct;
      if (now && now !== before && !pct) break;
      if (Date.now() > deadline) throw new Error("Timed out waiting for Flow to redraw the character.");
    }
    if (job) job.progress = undefined;
  }

  // From here on the edit is done in Flow. A failed download must never throw that away, so it becomes a note instead.
  let portrait: string | undefined;
  let note: string | undefined;
  try {
    portrait = await savePortrait(page, name);
  } catch (err) {
    note = `${change ? `${name} was changed in Flow, but the new` : "The"} portrait could not be saved (${err instanceof Error ? err.message : String(err)}). Call flow_character_edit with just the name to save it.`;
  }

  await leaveCharacterEditor(page);
  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();
  return { name, portrait, note };
}

export async function listAssets(): Promise<FlowAsset[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  // From a scene, clip or character view the grid is not on screen, and the scan found nothing at all (2026-10-12:
  // a scene open in Flow listed as "no scenes"). Go back to the project's All media first.
  await ensureProjectGrid(page);
  const assets = await scanGrid(page);
  await scrollToTop(page);
  return assets;
}

// Downloads media that already exists in the project, matched by (the start of) its title.
export async function downloadAsset(name: string, targetStem: string, quality: DownloadQuality): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  await ensureProjectGrid(page);
  const matches = (a: FlowAsset) => a.name.toLowerCase().startsWith(name.toLowerCase());
  const found = (await scanGrid(page, (assets) => assets.some(matches))).find(matches);
  if (!found) throw new Error(`No asset whose title starts with "${name}". Use flow_assets to list titles.`);
  if (found.kind === "scene") return downloadScene(page, found, targetStem);
  return downloadTile(page, tileOf(page, found), targetStem, quality);
}

// Moves one item in the open project to Flow's Trash. Flow keeps it there with Restore and Delete permanently, so this
// is recoverable - and it never deletes permanently. Flow asks NO confirmation (mapped 2026-10-01: the tile menu's
// "Move to trash" removes the tile at once), so whoever calls this must confirm with the user first. Matching is by
// EXACT title, and an ambiguous title is refused: Flow reuses titles, and trashing the wrong one is the worst outcome.
// How many tiles carry this exact title. scanGrid keeps one entry per title (the virtual grid shows the same tile again
// as it scrolls), so it can never see two items with the same name: trashAsset's "two share it" guard never fired,
// and Flow's agent reuses titles freely (three "Red fox sitting in snow" in one test, 2026-10-18). Images are told apart
// by their media ids; id-less videos only when two of them are on screen together.
async function countTitled(page: Page, name: string): Promise<number> {
  await scrollToTop(page);
  const ids = new Set<string>();
  let together = 0;
  for (let step = 0; step < 200; step++) {
    const found = await page.evaluate(
      ([js, title]) => {
        const idOf = eval(js) as (t: Element) => string | undefined;
        return [...document.querySelectorAll("flow-grid-tile-container")].filter((t) => t.getAttribute("aria-label") === title).map((t) => idOf(t) ?? "");
      },
      [TILE_ID_JS, name] as const,
    );
    together = Math.max(together, found.length);
    for (const id of found) if (id && !id.startsWith("title:")) ids.add(id);
    const moved = await page.evaluate(() => {
      const el = document.querySelector(".page-container");
      if (!el) return false;
      const before = el.scrollTop;
      el.scrollTop = before + el.clientHeight * 0.8;
      return el.scrollTop > before;
    });
    if (!moved) break;
    await pause(page, 500);
  }
  await scrollToTop(page);
  return Math.max(ids.size, together);
}

export async function trashAsset(name: string): Promise<{ trashed: string }> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  await ensureProjectGrid(page);
  const same = (await scanGrid(page)).filter((a) => a.name === name);
  if (!same.length) throw new Error(`Nothing in the open project is called "${name}".`);
  const copies = await countTitled(page, name);
  if (copies > 1) throw new Error(`${copies} items are called "${name}", so it isn't clear which one to trash. Rename one in Flow first.`);
  // Scan again, stopping on the tile so it stays mounted in the virtual grid (no scrollToTop before acting on it).
  await scanGrid(page, (seen) => seen.some((a) => a.name === name));
  const tile = tileOf(page, same[0]);
  await hoverTile(page, tile);
  await tile.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Move to trash", exact: true }).click();
  await pause(page, 2000);
  if (await tile.count()) throw new Error(`"${name}" is still in the project - Flow did not move it to Trash.`);
  await scrollToTop(page);
  return { trashed: name };
}

// Renames one item in the open project through the tile menu's `Rename`. runGeneration already does this for every
// clip it makes; this is the same thing on demand, for putting a name back when something went wrong - on
// 2026-10-21 two frames of clip 3 ended up wearing the portraits' names and there was no way to undo it from here.
// Matching is by EXACT title and an ambiguous one is refused, as in trashAsset: Flow reuses titles, and renaming the
// wrong item is how the damage happened in the first place. The target name is refused if it is already taken, so a
// rename can never create that ambiguity either.
export async function renameAsset(name: string, newName: string): Promise<{ renamed: string; to: string }> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  if (name === newName) throw new Error(`"${name}" is already called that.`);
  const page = await getFlowPage();
  await ensureProjectGrid(page);
  const assets = await scanGrid(page);
  const same = assets.filter((a) => a.name === name);
  if (!same.length) throw new Error(`Nothing in the open project is called "${name}". Use flow_assets to list titles.`);
  if (same.length > 1) throw new Error(`${same.length} items are called "${name}", so it isn't clear which one to rename. Rename one by hand in Flow first.`);
  if (assets.some((a) => a.name === newName)) throw new Error(`Something in the project is already called "${newName}". Pick a title that is free.`);
  // Scan again, stopping on the tile so it stays mounted in the virtual grid (no scrollToTop before acting on it).
  await scanGrid(page, (seen) => seen.some((a) => a.name === name));
  if (!(await renameTile(page, tileOf(page, same[0]), newName, false))) {
    throw new Error(`Flow's tile menu did not offer Rename for "${name}", so nothing was changed.`);
  }
  await scrollToTop(page);
  const after = await scanGrid(page, (seen) => seen.some((a) => a.name === newName));
  if (!after.some((a) => a.name === newName)) throw new Error(`Flow did not accept the new title: "${name}" is still called that.`);
  return { renamed: name, to: newName };
}

// A scene's tile menu downloads a ZIP of its loose clips, which is not what anyone wants. The whole scene comes out as
// ONE stitched file from inside the scene view: open the scene, press "Download scene", and Flow shows "Exporting your
// scene..." before the file arrives (a 29 s scene took a few seconds). The user showed this route; verified 2026-10-01.
// Nothing may be pressed while it exports - an Escape here cancelled an earlier attempt.
async function downloadScene(page: Page, scene: FlowAsset, targetStem: string): Promise<string[]> {
  await useOwnDownloadDir(page);
  const tile = tileOf(page, scene);
  await hoverTile(page, tile);
  const box = await tile.boundingBox();
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  else await tile.click();
  await page.waitForURL(/\/scene\//, { timeout: 30_000 });
  await pause(page, 3000);
  const before = downloadsNow();
  await page.getByRole("button", { name: "Download scene", exact: true }).click();
  const file = await waitForDownloadedFile(page, before, 600_000);
  const target = `${targetStem}${extensionOf(file)}`;
  renameSync(file, target);
  await page.getByRole("button", { name: "Back button to go to previous page" }).click().catch(() => {});
  await pause(page, 2000);
  await ensureProjectGrid(page).catch(() => {});
  return [target];
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
// What each character looks like, so scenes can hold Flow to the same design instead of letting it redraw.
// Kept on disk so a restarted server still knows the cast.
const LOOKS_FILE = join(HOME_DIR, "characters.json");
const loadLooks = (): Record<string, string> => {
  try {
    return JSON.parse(readFileSync(LOOKS_FILE, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
};
export const characterLook = (name: string): string | undefined => loadLooks()[name.toLowerCase()];
export function rememberCharacter(name: string, look: string): void {
  const all = { ...loadLooks(), [name.toLowerCase()]: look.trim() };
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(LOOKS_FILE, JSON.stringify(all, null, 2));
}

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

  await openProjectNav(page, "Characters");
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
  await page.waitForURL((u) => !/\/character/.test(u.pathname), { timeout: 15_000 }).catch(() => page.goto(inEnglish(projectUrl)));
  await pause(page, 1000);
  // Flow drops the new character into the composer; leave the composer empty for the next job.
  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();
  await showAllMedia(page);
  if (c.describe) rememberCharacter(c.name, c.describe);
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
  const fresh = await waitForNewMedia(page, before, 1, 90_000, undefined, "video");
  mkdirSync(s.output_dir, { recursive: true });
  const saved = await downloadMedia(page, fresh[0], join(s.output_dir, s.file_stem), s.download_quality);
  const after = await readCredits(page).catch(() => undefined);
  if (balance !== undefined && after !== undefined) job.credits = balance - after;
  return saved;
}

// The agent session panel hides the composer, so a toggle attempted underneath it does nothing at all. Leaving agent
// mode on then breaks the NEXT job, which expects the plain composer - a free character build failed that way. So this
// confirms the toggle actually landed rather than assuming the click worked.
async function setAgentMode(page: Page, on: boolean): Promise<void> {
  const agent = page.getByRole("button", { name: "Agent", exact: true });
  // Playwright says why a click did not land ("<div ...> intercepts pointer events", "element is not visible"); keep
  // that, so a failure names what was in the way instead of guessing.
  let why = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    await clearBackdrops(page);
    await closeAgentSettings(page);
    if (((await agent.getAttribute("aria-pressed").catch(() => null)) === "true") === on) return;
    await agent.click({ timeout: 8000 }).catch((err: Error) => {
      const lines = err.message.split("\n").map((l) => l.trim());
      why = (lines.find((l) => /intercepts pointer events|not visible|not enabled|detached|not stable/.test(l)) ?? lines[0]).slice(0, 200);
    });
    await pause(page, 1500);
  }
  if (((await agent.getAttribute("aria-pressed").catch(() => null)) === "true") !== on) {
    throw new Error(`Could not switch Agent mode ${on ? "on" : "off"}${why ? ` (${why})` : "; the click landed but the toggle did not change"}.`);
  }
}

// "Never" lets the agent generate without asking; it is switched back to "Always" as soon as the batch ends.
async function setAgentSettings(page: Page, confirm: "Always" | "Never", imageAspect?: string): Promise<void> {
  // Scoped to the prompt box: Flow added a second "Settings" button to the top bar ("View settings", seen 2026-10-13),
  // and an unscoped lookup matched both and failed every agent batch.
  await clearBackdrops(page);
  await page.locator("flow-base-prompt-box").getByRole("button", { name: "Settings", exact: true }).click();
  try {
    await page.getByRole("heading", { name: "Agent settings" }).waitFor({ state: "visible", timeout: 8000 });
    await page.getByRole("radio", { name: new RegExp(`^${confirm}`) }).click();
    if (imageAspect) {
      await page.getByRole("radio", { name: imageAspect, exact: true }).first().click();
      await page.getByRole("radio", { name: "x1", exact: true }).first().click();
      await pickAgentImageModel(page);
    }
    await pause(page, 300);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await pause(page, 1200);
  } finally {
    // Saved or not, never leave the panel covering the composer: the next step needs the Agent button.
    await closeAgentSettings(page);
  }
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
// Bulk downloads go at an even, human pace: as quick as the steps allow (about 2.5 s), then held to a random 4-4.4 s each
// (the user's call, 2026-10-19), in the spirit of the random pauses between generations. Before, each took ~5.6 s.
const downloadPace = () => 4000 + Math.random() * 400;

// Progress the panel and flow_wait show; with FLOW_MCP_DEBUG set, also a timed line on stderr to find slow steps.
const t0s = new WeakMap<Job, number>();
function step(job: Job, text: string | undefined): void {
  job.progress = text;
  if (!process.env.FLOW_MCP_DEBUG || !text) return;
  if (!t0s.has(job)) t0s.set(job, Date.now());
  console.error(`[flow-mcp ${job.id}] ${((Date.now() - t0s.get(job)!) / 1000).toFixed(1)}s ${text}`);
}

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
  const base = Number(s.file_stem.match(/\d+/)?.[0] ?? 1);
  const numberOf = (i: number) => s.agent_numbers?.[i] ?? base + i;
  await ensureProjectGrid(page);
  const seenBefore = await scanGrid(page);
  // Ids are unique per generation; titles are not (the agent reuses wording), so only id-less tiles fall back to a name.
  const before = new Set<string>(seenBefore.map((a) => a.id).filter((v): v is string => Boolean(v)));
  const beforeNames = new Set<string>(seenBefore.filter((a) => !a.id).map((a) => a.name));
  await scrollToTop(page);

  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();
  const script = indexes.map((i) => `Scene ${numberOf(i)}: ${scenes[i].replace(/\s*\n+\s*/g, " ").trim()}`).join(" ");
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
    step(job, working ? (pending.length ? `${pending.length} rendering` : "the agent is working") : "the agent has finished");
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

  step(job, "checking for failed tiles");
  const failedTiles = await retryNewErrorTiles(page, before, true)
    .then((r) => r.errors)
    .catch(() => 0);
  const fresh = (await scanGrid(page)).filter((t) => t.id && !before.has(t.id) && !beforeNames.has(t.name) && t.kind === "image");

  // Tiles finish in any order and the agent rewords prompts, so each image is matched back to its scene by the
  // prompt Flow stored for it ("Reuse prompt" puts that text in the composer).
  const prompts: string[] = [];
  for (const [k, tile] of fresh.entries()) {
    step(job, `matching image ${k + 1} of ${fresh.length} to its scene`);
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
  let produced = 0;
  for (const [n, tileIndexes] of assigned.entries()) {
    const sceneIndex = indexes[n];
    if (!tileIndexes.length || (numberOf(sceneIndex) === drop && !s.agent_numbers)) continue;
    for (const [v, tileIndex] of tileIndexes.entries()) {
      const id = fresh[tileIndex].id!;
      const started = Date.now();
      // New tiles sit at the top of the grid, so a scan is only needed when this one has scrolled out of the page.
      if (!(await mediaTile(page, id).count())) await scanGrid(page, (seen) => seen.some((x) => x.id === id));
      const stem = join(s.output_dir, `scene-${String(numberOf(sceneIndex)).padStart(2, "0")}${v ? `-v${v + 1}` : ""}`);
      step(job, `downloading scene ${numberOf(sceneIndex)}`);
      files.push(...(await downloadTile(page, mediaTile(page, id), stem, s.download_quality ?? "original")));
      await pause(page, Math.max(0, downloadPace() - (Date.now() - started)));
    }
    done.add(sceneIndex);
    produced++;
  }
  return { produced, timedOut, failedTiles };
}

// Hands a whole multi-scene script to Flow's own agent, which generates every image in parallel (seconds instead
// of one paced job per scene). Scenes the agent drops are asked for again, then re-run one by one as a last resort.
// Continues a clip from its own last frame WITH characters still attached - the combination the composer refuses.
// Flow's composer offers Frames OR Ingredients, never both, but agent mode does both, and this is the route the user
// demonstrated: save the clip's last frame, Animate that image (which switches Flow into agent mode by itself), then
// add the avatar or character as a second chip. Verified step by step against the live UI on 2026-09-20.
export async function runContinue(job: Job): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  const s = job.params;
  const balance = await readCredits(page).catch(() => undefined);

  await ensureProjectGrid(page);
  const wanted = s.continue_from!.toLowerCase();
  const matches = (a: FlowAsset) => a.kind === "video" && a.name.toLowerCase().startsWith(wanted);
  const source = (await scanGrid(page, (assets) => assets.some(matches))).find(matches);
  if (!source) throw new Error(`No video whose title starts with "${s.continue_from}". Use flow_assets to list titles.`);

  try {
    // 1. Open the clip and park the playhead on its final frame, then let Flow save that frame as an image.
    job.progress = "saving the last frame";
    const tile = tileOf(page, source);
    await hoverTile(page, tile);
    await tile.click();
    await page.waitForURL(/\/edit\//, { timeout: 30_000 });
    await pause(page, 4000);
    await page.getByRole("button", { name: "Skip to next clip" }).click();
    await pause(page, 2500);
    await page.getByRole("button", { name: "Save frame" }).click();
    await pause(page, 4500);
    await page.getByRole("button", { name: "Back button to go to previous page" }).click();
    await pause(page, 3500);
    await ensureProjectGrid(page);
    await scrollToTop(page);

    // 2. Animate the frame we just saved. Flow names it after the source and puts the newest copy at the top, and
    //    the click also flips Agent on, which is what lets a character ride along.
    job.progress = "loading the frame into the composer";
    const frame = page.locator(`flow-grid-tile-container[aria-label="${`Saved frame from ${source.name}`.replace(/"/g, '\\"')}"]`).first();
    await frame.waitFor({ state: "visible", timeout: 30_000 });
    await hoverTile(page, frame);
    await frame.getByRole("button", { name: "More options" }).click();
    await pause(page, 1500);
    await page.getByRole("menuitem", { name: "Animate", exact: true }).click();
    await pause(page, 3500);
    await setAgentMode(page, true);

    // 3. The second chip: an avatar ("Me") or any character. Only useful in likeness mode - Flow's first-frame tool
    //    (I2V) ignores extra references, and attaching one just makes the agent stop and ask which we meant.
    for (const name of s.continue_mode === "likeness" ? (s.attach ?? []) : []) {
      await attachAsset(page, page.getByRole("button", { name: "Add ingredients to the prompt box" }), name);
      await pause(page, 1200);
    }

    // 4. Agent mode asks for confirmation unless told not to, which would stall an unattended run.
    await setAgentSettings(page, "Never", s.aspect_ratio ?? "16:9");
    // Agent mode treats both chips as ingredients and decides what to do with them. Attaching the saved frame is not
    // enough - without being told, the agent reads it as a style reference and stages a fresh shot. It has to be told
    // in words that the frame IS the opening frame. (Cost 15 credits to learn on 2026-09-20.)
    const cast = (s.attach ?? []).join(" and ");
    const exact = s.continue_mode !== "likeness";
    // Naming the tool settles it in one go. Flow offers first-frame animation (I2V), which continues an image exactly
    // but ignores other references, or reference-to-video (R2V), which honours a character but only approximates the
    // frame. Left unsaid, the agent stops mid-run and asks - which stalls an unattended job.
    await typePrompt(
      page,
      (exact
        ? `Use I2V, Flow's first frame animation tool. The attached frame is the FIRST FRAME of this clip: begin exactly ` +
          `on it, with the same framing, lighting, colours, wardrobe and set, and continue from there with no cut, as an ` +
          `unbroken continuation of the shot it came from. Do not use any other reference.`
        : `Use R2V, reference-to-video, with the attached frame and ${cast || "the attached reference"} both as references, ` +
          `so the look and the person stay consistent through the clip. Open as close to the attached frame as you can.`) +
        ` ${s.prompt}`,
    );
    const before = await mediaIds(page);
    job.progress = "generating";
    await page.getByRole("button", { name: "Start generation" }).click();

    // The agent sometimes still stops to ask which tool to use. Nobody is watching an unattended run, so answer it.
    for (let i = 0; i < 12; i++) {
      await pause(page, 5000);
      const asking = await page.evaluate(() => /Would you like to|which you prefer|I2V|R2V/i.test(document.body.innerText));
      const working = await page.evaluate(() => /\d{1,3}%/.test(document.body.innerText));
      if (working) break;
      if (!asking) continue;
      job.progress = "answering the agent's question";
      await typePrompt(
        page,
        exact
          ? "Use I2V, first frame animation. Start exactly on that frame and continue from it with no cut. Do not use the other reference."
          : "Use R2V, reference-to-video, using both attached references so the person stays consistent.",
      );
      await page.keyboard.press("Enter");
      await pause(page, 6000);
      break;
    }

    const fresh = await waitForNewMedia(page, before, 1, VIDEO_TIMEOUT_MS, job, "video");
    job.progress = undefined;
    mkdirSync(s.output_dir, { recursive: true });
    const saved = await downloadMedia(page, fresh[0], join(s.output_dir, s.file_stem), s.download_quality);
    const after = await readCredits(page).catch(() => undefined);
    if (balance !== undefined && after !== undefined) job.credits = balance - after;
    return saved;
  } finally {
    // Leave the composer the way the rest of the driver expects to find it. Order matters: the session panel has to go
    // first and the grid has to be back, otherwise the toggles below are clicking at something that is not there.
    await closeAgentSession(page).catch(() => {});
    await pause(page, 1500);
    await ensureProjectGrid(page).catch(() => {});
    await setAgentSettings(page, "Always").catch(() => {});
    await setAgentMode(page, false).catch(() => {});
    const clear = page.getByRole("button", { name: "Clear prompt" });
    if (await clear.isVisible().catch(() => false)) await clear.click().catch(() => {});
  }
}

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
  let agentProblem = "";
  try {
    step(job, "switching Agent mode on");
    await setAgentMode(page, true);
    step(job, "setting the agent to generate without asking");
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
  } catch (err) {
    // Agent mode could not be used (2026-10-13: "Could not switch Agent mode on" failed a whole 11-image batch with
    // nothing made). Whatever the agent did not deliver is made one by one below instead: slower, but the batch still
    // ends with every image.
    agentProblem = (err as Error).message;
  } finally {
    step(job, "putting the agent settings back");
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
  const numberOf = (i: number) => s.agent_numbers?.[i] ?? base + i;
  const stillFails = Number(process.env.FLOW_MCP_SIMULATE_FAILED ?? 0); // test hook: pretend this scene failed for good
  for (const [n, i] of missing.entries()) {
    job.progress = `re-running scene ${numberOf(i)} one by one (${n + 1}/${missing.length})`;
    if (numberOf(i) === stillFails && !job.params.agent_numbers) {
      failed.push(numberOf(i));
      continue;
    }
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
        file_stem: `scene-${String(numberOf(i)).padStart(2, "0")}`,
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
    if (!ok) failed.push(numberOf(i));
  }
  job.failed_scenes = failed.length ? failed : undefined;
  step(job, "reading the credit balance");
  const left = await readCredits(page).catch(() => undefined);
  step(job, undefined);
  files.sort();
  job.note = [
    // What still needs doing first: the panel shows only the start of a long note.
    failed.length ? `still failed: scene ${failed.join(", ")} (use Retry)` : "",
    agentProblem ? `agent mode failed (${agentProblem}), so the images were made one by one` : "",
    agentTimedOut ? "the agent stalled and was stopped" : "",
    `${done.size} of ${scenes.length} scenes came from the agent`,
    agentRetries ? `${agentRetries} asked again` : "",
    failedTiles ? `${failedTiles} tile(s) failed in Flow` : "",
    missing.length > failed.length ? `${missing.length - failed.length} re-run one by one` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (!files.length) throw new Error("No image could be generated for any scene. Open the Flow tab to see what Flow reported.");

  if (balance !== undefined && left !== undefined) job.credits = balance - left;
  return files;
}

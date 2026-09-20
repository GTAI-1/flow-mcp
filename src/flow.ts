import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { getFlowPage } from "./chrome.js";
import type { Job } from "./queue.js";

export interface FlowState {
  url: string;
  signedIn: boolean;
  inProject: boolean;
  plan?: string;
  composer?: string;
  hint?: string;
}

const IMAGE_TIMEOUT_MS = 3 * 60_000;
const VIDEO_TIMEOUT_MS = 12 * 60_000;
const FAILURE_TEXT = /fail|error|couldn.t|unable|violat|policy|try again/i;

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

export async function getFlowState(): Promise<FlowState> {
  const page = await getFlowPage();
  const url = page.url();
  // Signed-out visitors are bounced to the marketing page or Google's sign-in.
  const signedIn = !/\/about|accounts\.google\.com/.test(url);
  const inProject = /\/project\//.test(url);
  const state: FlowState = { url, signedIn, inProject };
  if (!signedIn) state.hint = "Not signed in. Run `npm run login` and sign in to Google in the Flow Chrome window.";
  else if (!inProject) state.hint = "Signed in, but no project is open. Open or create a project in the Flow Chrome window.";
  else {
    state.plan = await page.getByRole("button", { name: "Account details" }).innerText().then((t) => t.trim().split("\n")[0], () => undefined);
    state.composer = await settingsTrigger(page).innerText().then((t) => t.replace(/\s+/g, " ").trim(), () => undefined);
  }
  return state;
}

const settingsTrigger = (page: Page) => page.getByRole("button", { name: "Settings trigger" });

// A finished tile is keyed by the media uuid in its <img>/<video> src. Image tiles also carry
// data-media-id, but video tiles at rest only show a thumbnail <img>, so the src is the common handle.
export async function mediaIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("flow-grid-tile-container")]
      .map((tile) => {
        const media = tile.querySelector("flow-image-tile img[src], flow-video-tile img[src], flow-video-tile video[src]");
        return media?.getAttribute("src")?.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0];
      })
      .filter((id): id is string => Boolean(id)),
  );
}

// The grid is virtualised and the top bar hides once it is scrolled, so every step starts from the top,
// where new tiles appear.
async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelectorAll(".page-container").forEach((e) => (e.scrollTop = 0)));
  await pause(page, 400);
}

const mediaTile = (page: Page, id: string) => page.locator(`flow-grid-tile-container:has([src*="${id}"])`).first();

async function waitForNewMedia(page: Page, before: string[], count: number, timeoutMs: number, job?: Job): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await pause(page, 2000);
    const fresh = [...new Set((await mediaIds(page)).filter((id) => !before.includes(id)))];
    if (fresh.length >= count) return fresh;
    // Tiles that are neither finished nor showing a percentage have usually failed.
    const tiles = await page.evaluate(() =>
      [...document.querySelectorAll("flow-grid-tile-container")].slice(0, 8).map((t) => ({
        done: Boolean(t.querySelector("flow-image-tile img[src], flow-video-tile img[src], flow-video-tile video[src]")),
        text: (t as HTMLElement).innerText.trim(),
      })),
    );
    const pending = tiles.filter((t) => !t.done);
    const progress = pending.map((t) => t.text.match(/\d+%/)?.[0]).filter(Boolean);
    if (job) job.progress = progress.join(", ") || undefined;
    const failed = pending.find((t) => !/\d+%/.test(t.text) && FAILURE_TEXT.test(t.text));
    if (failed) {
      if (fresh.length) return fresh;
      throw new Error(`Flow reported a failed generation: ${failed.text.replace(/\s+/g, " ").slice(0, 300)}`);
    }
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

// Uploads under a unique filename so the asset can be picked unambiguously afterwards.
async function uploadAsset(page: Page, job: Job, file: string, label: string): Promise<string> {
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

// The frame pickers attach on click; the ingredients picker only previews and needs "Add to prompt".
// Option names are "<asset name>" or "<asset name> Image|Video", so match on the prefix.
async function attachAsset(page: Page, opener: Locator, assetName: string): Promise<void> {
  await opener.click();
  const list = page.getByRole("listbox", { name: "Asset list" });
  await list.waitFor({ state: "visible", timeout: 10_000 });
  const escaped = assetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const option = list.getByRole("option", { name: new RegExp(`^${escaped}`) }).first();
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

export async function downloadMedia(page: Page, mediaId: string, targetStem: string): Promise<string> {
  const tile = mediaTile(page, mediaId);
  await tile.scrollIntoViewIfNeeded();
  const download = page.waitForEvent("download", { timeout: 120_000 });
  download.catch(() => {});
  await tile.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Download", exact: true }).click();
  // Images and videos offer a size submenu; take the original (no upscale wait, no extra cost).
  const original = page.getByRole("menuitem", { name: /original/i }).first();
  if (await original.waitFor({ state: "visible", timeout: 2500 }).then(() => true, () => false)) {
    await original.click();
  }
  const file = await download;
  const target = `${targetStem}${extname(file.suggestedFilename()) || ".bin"}`;
  await file.saveAs(target);
  await page.keyboard.press("Escape");
  await scrollToTop(page);
  return target;
}

// Drives one generation in the Flow tab and returns the downloaded file paths.
export async function runGeneration(job: Job): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  const s = job.params;

  await page.keyboard.press("Escape");
  await scrollToTop(page);
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
    files.push(await downloadMedia(page, id, stem));
    await pause(page, 1500);
  }
  return files;
}

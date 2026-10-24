import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { assemble, localVoices, speakLocally, voiceTrack } from "./assemble.js";
import { GEMINI_VOICES, geminiKey, saveGeminiKey, speakWithGemini } from "./gemini.js";
import { extractLastFrame } from "./chain.js";
import { burnCaptions, captionedName, captionSetup, previewCaptions, transcribe } from "./captions.js";
import { characterLook, createCharacter, downloadAsset, trashAsset, editCharacter, getFlowState, imageModelFor, LATEST_IMAGE_MODEL, listAssets, listCharacters, listImageModels, rememberCharacter, runAgentBatch, runContinue, runEdit, runGeneration } from "./flow.js";
import { accountByName, addAccount, defaultAccount, defaultImageModel, enabledAccounts, listAccounts, loadSettings, onAccount, profileDir, saveSettings, setAccountEnabled } from "./accounts.js";
import { getFlowPage } from "./chrome.js";
import { differenceMatte } from "./matte.js";
import { JobQueue, type Job } from "./queue.js";
import { BIN, COMPUTER, IS_MAC, IS_WIN, moveToBin } from "./platform.js";
import { TECHNIQUES, techniqueById } from "./techniques.js";

export const OUTPUT_ROOT = process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out");
const words = (s: string) => s.split(/[^a-z0-9]+/i).filter((w) => w.length > 3).map((w) => w.toLowerCase());

export const projectDir = (project: string) => resolve(OUTPUT_ROOT, project.replace(/[^\w.-]+/g, "_"));

const sceneSchema = z.object({
  prompt: z.string().min(1).describe("Full English prompt for one clip: action, shot and camera move, location, style, light, sound."),
  type: z.enum(["video", "image"]).default("video"),
  model: z
    .string()
    .optional()
    .describe("Model label as shown in Flow, e.g. 'Omni 1.1 Flash', 'Veo 3.1 - Fast', 'Veo 3.1 - Quality', 'Nano Banana Pro'. Images default to the newest Nano Banana (2.1 today); video omitted keeps Flow's current model."),
  aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).optional().describe("Video supports 16:9 and 9:16 only."),
  duration: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).optional().describe("Video length in seconds. Omni models only; Veo 3.1 clips are fixed at 8s."),
  resolution: z.enum(["360p", "720p"]).optional().describe("Video resolution. Omni models only."),
  max_credits: z.number().int().min(0).default(25).describe("Safety cap: the scene is skipped (nothing spent) if Flow quotes more credits than this."),
  variants: z.number().int().min(1).max(4).optional().describe("Outputs per prompt (each one spends credits). Default 1."),
  first_frame: z.string().optional().describe("First frame: absolute image path, or 'asset:<title>' for an image already in the Flow project."),
  last_frame: z.string().optional().describe("Last frame: absolute image path, or 'asset:<title>'."),
  reference_images: z
    .array(z.string())
    .max(3)
    .optional()
    .describe(
      "Reference media: absolute image paths, or 'asset:<title>' for media or characters already in the Flow project. Flow's COMPOSER takes references OR first/last frames on a video scene, never both, so with frames set these are skipped and the job says so. Flow itself can do both via agent mode (save the last frame, Animate it, then add the character).",
    ),
  download_quality: z.enum(["original", "upscaled"]).optional().describe("'upscaled' fetches 1080p video / 2K image (free, slower). Default original."),
  retries: z.number().int().min(0).max(3).default(1).describe("Automatic retries when Flow itself reports the generation failed."),
  technique: z.string().optional().describe("Id from flow_techniques (e.g. 'orbit-360'); its exact phrase is appended to the prompt. One per scene."),
  reference_previous: z
    .boolean()
    .optional()
    .describe("Use the previous scene's finished image as an extra reference, so this scene inherits its exact drawing of the characters, style and palette. Best way to keep a set of stills on-model."),
  chain_previous: z
    .boolean()
    .optional()
    .describe("Continue the previous scene in this call: its last frame becomes this scene's first frame. Not valid on the first scene or together with first_frame."),
});

// Raw shapes double as MCP input schemas and, wrapped in z.object, as HTTP body validators.
const captionFields = {
  video: z.string().min(1).describe("Absolute path of the video to caption: any MP4 or MOV on this computer, such as a film made with flow_assemble."),
  style: z
    .enum(["bold", "highlight", "reveal", "clean", "boxed"])
    .default("bold")
    .describe(
      "bold: big capitals, 1-3 words at a time, the spoken word lights up (the short-form look). highlight: the spoken word sits on a coloured block. reveal: words appear as they are said. clean: classic subtitles. boxed: white words on a dark band.",
    ),
  position: z
    .union([z.enum(["bottom", "middle", "top"]), z.number().min(0).max(100)])
    .default("bottom")
    .describe("bottom, middle or top - or a number for an exact height: how far down the frame the middle of the caption sits, 0 = top edge, 100 = bottom edge."),
  size: z
    .union([z.enum(["small", "medium", "large"]), z.number().min(40).max(250)])
    .default("medium")
    .describe("small, medium, large, or a percentage of the style's normal size (100 = medium, 150 = half again as big)."),
  lead: z
    .number()
    .min(-0.5)
    .max(0.5)
    .optional()
    .describe("Seconds the highlight runs ahead of the voice. Default 0.12; raise it if words still light up late, lower it if early."),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Highlight colour as #RRGGBB, for bold, highlight and reveal."),
  letters: z
    .enum(["as_said", "capitals", "lowercase"])
    .optional()
    .describe("as_said keeps normal capitals (sentence starts, names); capitals is the high-energy short-form look; lowercase is the calm, casual look, and names still keep their capital in it. Default: capitals for bold, as_said for the rest."),
  names: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe("Lowercase only: names to keep capitalised even where they start a sentence (e.g. [\"Juno\"]). Names in the middle of a sentence are found by themselves."),
  text: z.string().max(50_000).optional().describe("Corrected words, to fix anything misheard. Timings are kept for every word that still matches; a line break starts a new caption."),
  language: z
    .string()
    .default("auto")
    .describe(
      "Spoken language as a code: en, es, fr, de, pt, tr, ja, zh, ar... Pass it whenever you know it. auto detects it (a 60 MB detector downloads once). English uses a 148 MB model; every other language a 574 MB one, each downloaded the first time.",
    ),
};

// Several Google accounts can be signed in, each in its own Chrome; jobs spread over all of them at once.
const accountField = z
  .string()
  .min(1)
  .optional()
  .describe("Run on this Flow account only (a name from flow_accounts). Default: queued work goes to whichever account is free first; anything that uses media already in a Flow project goes to the first account.");

export const shapes = {
  status: { detailed: z.boolean().default(true).describe("false skips the plan/credits readout, which briefly opens Flow's account panel.") },
  generate: {
    project: z.string().min(1).describe("Folder name for the downloaded clips, e.g. 'HotelPromo'."),
    scenes: z.array(sceneSchema).min(1).max(100),
    account: accountField,
  },
  wait: {
    job_ids: z.array(z.string()).optional().describe("Job ids from a queued call, or the task_id of a call that answered still_working. Default: every queued job."),
    timeout_seconds: z.number().int().min(5).max(900).default(40).describe("An MCP call returns after at most 40 s whatever this says, so call again until finished is true."),
  },
  cancel: { job_id: z.string() },
  retry: { job_ids: z.array(z.string()).optional().describe("Jobs to re-queue. Default: every failed job.") },
  assets: { kind: z.enum(["image", "video", "scene"]).optional(), account: accountField },
  download: {
    project: z.string().min(1).describe("Local folder name under the output root."),
    assets: z.array(z.string().min(1)).min(1).max(30).describe("Titles (or title prefixes) from flow_assets, in the order they should be numbered."),
    quality: z.enum(["original", "upscaled"]).default("original"),
    account: accountField,
  },
  assemble: {
    project: z.string().min(1).describe("Same project name used in flow_generate."),
    clips: z.array(z.string()).optional().describe("Absolute clip paths in play order. Default: every scene-NN.mp4 in the project folder (first variant of each)."),
    music: z.string().optional().describe("Absolute path to a music file; looped and trimmed to the film length."),
    music_volume: z.number().min(0).max(1).default(0.25),
    clip_volume: z
      .number()
      .min(0)
      .max(1)
      .default(1)
      .describe("Volume of the clips' own sound, 0-1. Lower it (around 0.2-0.3) so a narration sits clearly on top; 1 keeps it as recorded."),
    voiceover: z.string().optional().describe("Absolute path to a voiceover audio file, starts at 0:00."),
    voice_lines: z
      .array(
        z.object({
          file: z.string().min(1).describe("Take to cut the line from: audio or video (its sound is used)."),
          from: z.number().min(0).optional().describe("Start of the line within the take, seconds (from flow_transcribe word times)."),
          to: z.number().min(0).optional().describe("End of the line within the take, seconds."),
          at: z.number().min(0).describe("Where the line starts in the film, seconds."),
          max_seconds: z.number().min(0.2).optional().describe("Longest it may last; a longer line is sped up slightly (at most 1.25x)."),
        }),
      )
      .max(60)
      .optional()
      .describe(
        "A timed voiceover built from separate lines, each placed at its own moment in the film - for example lines cut from several Flow takes in your avatar's voice, each landing on the title it describes. Replaces `voiceover`.",
      ),
    output_name: z.string().default("final"),
    hold_last_frame: z.boolean().default(true).describe("Freeze the final frame so a longer voiceover is not cut off."),
  },
  transcribe: {
    video: z.string().min(1).describe("Absolute path of a video or audio file on this computer."),
    language: z.string().default("auto").describe("Spoken language code (en, es, tr, ja...) or auto. Pass it whenever you know it."),
    words: z.boolean().default(true).describe("Include every word with its start and end time in seconds."),
  },
  caption_preview: captionFields,
  captions: {
    ...captionFields,
    project: z.string().optional().describe("Films folder to save into. Default: the video's own folder when it is already in the films folder, otherwise 'Captions'."),
  },
  caption_setup: {},
  agent: {
    project: z.string().min(1).describe("Folder name for the downloaded images."),
    scenes: z.array(z.string().min(1)).min(1).max(50).describe("One image description per scene, in order."),
    aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).default("16:9"),
    model: z.string().optional().describe("Image model label as shown in Flow, e.g. 'Nano Banana Pro'. Default: the saved default (flow_image_models), else the newest Nano Banana."),
    download_quality: z.enum(["original", "upscaled"]).optional(),
    references: z
      .array(
        z.object({
          image: z.string().min(1).describe("Absolute image path, or 'asset:<title>' for an image or character already in the Flow project."),
          name: z.string().min(1).max(40).describe("Short name the scenes use for it, e.g. 'Ines' or 'the station'."),
        }),
      )
      .max(10)
      .optional()
      .describe(
        "Reference images for the whole batch (characters, places, objects), attached once in the agent's composer like the + button does, so every scene stays on-model. Pair with scene_references to say which scenes use which.",
      ),
    scene_references: z
      .array(z.array(z.string()))
      .optional()
      .describe("One list per scene, in scene order: the reference names that scene uses (empty list for none). Without it the agent decides which references fit each scene."),
    account: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Run the whole batch on this account. Default: with several accounts enabled the batch is split between them and they all render at once; scene numbers stay in order. A batch whose references are 'asset:' items stays whole on the first account, where that media lives.",
      ),
  },
  voices: {},
  narrate: {
    project: z.string().min(1).describe("Folder for the narration audio."),
    engine: z
      .enum(["gemini", "mac"])
      .default("gemini")
      .describe(
        "'gemini' uses Google AI Studio's text-to-speech - the same voices Flow has, free on the AI Studio tier, no length limit, needs a key in ~/.flow-mcp/gemini-key. 'mac' uses a voice installed on this computer (macOS voices on a Mac, the built-in speech voices on Windows): free, instant, no key.",
      ),
    text: z.string().min(1).max(400).describe("The line to speak. About 20 words fits 8 s, 30 words fits 12 s; anything longer needs a longer take."),
    voice: z.string().min(1).default("Charon").describe("Voice name from flow_voices, e.g. Charon (informative), Aoede (breezy), Gacrux (mature) for Google; Zoe or Samantha for macOS."),
    style: z.string().max(200).optional().describe("Delivery note for the 'gemini' engine, e.g. 'slowly and warmly, like a documentary narrator'."),
  },
  cutout: {
    project: z.string().min(1).describe("Folder for the cutout PNG (and the white and black takes it is made from)."),
    prompt: z
      .string()
      .min(1)
      .optional()
      .describe("What to draw, e.g. 'a red sneaker, three-quarter view, studio product photo'. Leave the background out: it is set for you. With `image`, an optional note on what to keep."),
    image: z.string().min(1).optional().describe("Cut out a picture you already have instead: absolute path, or 'asset:<title>' of an image in the Flow project."),
    aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).default("1:1"),
    model: z.string().optional().describe("Image model label as shown in Flow. Default: the saved default (flow_image_models), else the newest Nano Banana."),
    download_quality: z.enum(["original", "upscaled"]).optional().describe("'upscaled' makes a 2K cutout (slower)."),
    account: accountField,
  },
  edit: {
    project: z.string().min(1).describe("Local folder for the edited clip."),
    asset: z.string().min(1).describe("Title (or title prefix) of a video already in the Flow project; see flow_assets."),
    prompt: z.string().min(1).describe("What to change, e.g. 'change the time of day to golden hour', 'remove the cup', 'make it snow'."),
    acknowledge_cost: z
      .literal(true)
      .describe("Must be true. Flow shows no quote for edits, so max_credits cannot protect you: a 4 s clip cost 20 credits when measured. The real cost is reported on the finished job."),
    download_quality: z.enum(["original", "upscaled"]).optional(),
    account: accountField,
  },
  continue_shot: {
    project: z.string().min(1).describe("Local folder for the new clip."),
    from_asset: z.string().min(1).describe("Title (or title prefix) of the video to continue from; see flow_assets."),
    prompt: z.string().min(1).describe("What happens in the new clip, written as one continuous shot with one camera move."),
    attach: z
      .array(z.string().min(1))
      .max(3)
      .optional()
      .describe("Characters or avatars to keep attached, by name, e.g. ['Me'] for your own Flow avatar or ['Pip']. This is the whole point of this tool: the normal composer cannot hold a character and a start frame at the same time."),
    aspect_ratio: z.enum(["16:9", "9:16"]).default("16:9"),
    mode: z
      .enum(["exact", "likeness"])
      .default("exact")
      .describe(
        "'exact' uses Flow's first-frame animation (I2V): the clip begins on the source clip's real last frame, invisible cut, but attached characters are IGNORED - the likeness has to come from the frame itself. 'likeness' uses reference-to-video (R2V): the character stays locked but the opening frame is only approximate. Flow cannot do both; this is a model limit, not a UI one.",
      ),
    acknowledge_cost: z
      .literal(true)
      .describe("Must be true. Agent mode shows no credit quote before it runs, so max_credits cannot protect you; the real cost is reported on the finished job."),
    download_quality: z.enum(["original", "upscaled"]).optional(),
    force: z
      .boolean()
      .optional()
      .describe("Skip the guard that refuses to run when Flow already holds a fresh-looking continuation of this clip. Only pass it when you have checked the grid and genuinely want another paid take."),
    account: accountField,
  },
  trash: { name: z.string().min(1).describe("Exact title of the item to move to Flow's Trash, as listed by flow_assets."), account: accountField },
  set_key: { key: z.string().min(1).max(200) },
  discard: { path: z.string().min(1).describe("A saved film, still, narration or whole project folder inside the films folder, to move to this computer's bin (Mac Trash, Windows Recycle Bin).") },
  outputs: {},
  characters: { account: accountField },
  accounts: {
    action: z
      .enum(["list", "add", "open", "enable", "disable"])
      .default("list")
      .describe(
        "list: every account with whether it is signed in, has a project open and is busy. add: create a new account and open its own Chrome window on Flow for the user to sign in by hand. open: bring an account's Chrome window up (to sign in or open a project). enable / disable: let an account take work or not (its sign-in is kept).",
      ),
    name: z.string().min(1).max(31).optional().describe("Account name for add/open/enable/disable, e.g. 'work' or 'acc2'. The original account is 'main'."),
  },
  image_models: {
    set_default: z
      .string()
      .min(1)
      .optional()
      .describe("Make this the image model every image job uses when it names none, e.g. 'Nano Banana Pro'. 'latest' goes back to always using the newest Nano Banana. Checked against Flow's own list."),
    account: accountField,
  },
  character_edit: {
    name: z.string().min(1).describe("Character to change, as listed by flow_characters."),
    change: z
      .string()
      .min(1)
      .max(600)
      .optional()
      .describe(
        "What to change about the look, e.g. 'make his coat red, keep everything else the same'. Leave it out to only save the character's current portrait (after a change made by hand in Flow, or one whose portrait never arrived).",
      ),
    look: z
      .string()
      .min(1)
      .max(1500)
      .optional()
      .describe(
        "The character's whole description AFTER the change, e.g. the old one with 'navy coat' swapped for 'red coat'. Scenes quote it word for word to hold the design, so a stale colour in it fights the new portrait. Without it, the change is added to the end of the old description.",
      ),
    account: accountField,
  },
  character: {
    name: z.string().min(1).max(60).describe("Character name; scenes then reference it as 'asset:<name>' in reference_images."),
    describe: z
      .string()
      .max(1200)
      .optional()
      .describe("What the character looks like. Flow draws the portrait first (free image), then builds the character from it. Use this or `image`."),
    image: z
      .string()
      .min(1)
      .optional()
      .describe("Existing picture instead of `describe`: absolute path, or 'asset:<title>' of an image already in the Flow project."),
    aspect_ratio: z.enum(["3:4", "1:1", "9:16", "16:9", "4:3"]).optional().describe("Frame for the drawn portrait when using `describe`. Default 3:4."),
    personality: z.string().max(500).optional().describe("How the character acts; Flow uses it when crafting scenes."),
    account: z.string().min(1).optional().describe("Account whose Flow project gets the character (characters belong to one project). Default: the first account."),
    voice: z.string().optional().describe("Flow voice name, e.g. 'Charon' (male, informative) or 'Aoede' (female, breezy)."),
  },
  techniques: { category: z.enum(["camera", "product", "transition", "image"]).optional() },
};

type Args<K extends keyof typeof shapes> = z.infer<z.ZodObject<(typeof shapes)[K]>>;

export const jobView = ({ id, status, params, files, attempts, credits, progress, note, error, failed_scenes, account }: Job) => ({
  id,
  status,
  account: account ?? params.account,
  project: params.output_dir,
  scene: params.file_stem,
  prompt: params.prompt,
  attempts,
  credits,
  progress,
  files,
  note,
  error,
  failed_scenes,
});

// One implementation runs in whichever process owns the Flow tab; the other process talks to it over HTTP (remote.ts).
export interface Core {
  status(a: Args<"status">): Promise<unknown>;
  generate(a: Args<"generate">): Promise<unknown>;
  wait(a: Args<"wait">): Promise<unknown>;
  cancel(a: Args<"cancel">): Promise<unknown>;
  retry(a: Args<"retry">): Promise<unknown>;
  assets(a: Args<"assets">): Promise<unknown>;
  download(a: Args<"download">): Promise<unknown>;
  assemble(a: Args<"assemble">): Promise<unknown>;
  techniques(a: Args<"techniques">): Promise<unknown>;
  voices(): Promise<unknown>;
  narrate(a: Args<"narrate">): Promise<unknown>;
  character(a: Args<"character">): Promise<unknown>;
  characters(a: Args<"characters">): Promise<unknown>;
  accounts(a: Args<"accounts">): Promise<unknown>;
  image_models(a: Args<"image_models">): Promise<unknown>;
  character_edit(a: Args<"character_edit">): Promise<unknown>;
  edit(a: Args<"edit">): Promise<unknown>;
  cutout(a: Args<"cutout">): Promise<unknown>;
  trash(a: Args<"trash">): Promise<unknown>;
  discard(a: Args<"discard">): Promise<unknown>;
  set_key(a: Args<"set_key">): Promise<unknown>;
  continue_shot(a: Args<"continue_shot">): Promise<unknown>;
  agent(a: Args<"agent">): Promise<unknown>;
  outputs(): Promise<unknown>;
  transcribe(a: Args<"transcribe">): Promise<unknown>;
  caption_preview(a: Args<"caption_preview">): Promise<unknown>;
  captions(a: Args<"captions">): Promise<unknown>;
  caption_setup(): Promise<unknown>;
}

// Flow's own voices: still offered when giving a character a voice, but narration no longer goes through Flow.
export const VOICES = [
  { name: "Achernar", description: "female, soft, high pitch" },
  { name: "Achird", description: "male, friendly, mid pitch" },
  { name: "Algenib", description: "male, gravelly, low pitch" },
  { name: "Algieba", description: "male, easy-going, mid-low pitch" },
  { name: "Alnilam", description: "male, firm, mid-low pitch" },
  { name: "Aoede", description: "female, breezy, mid pitch" },
  { name: "Autonoe", description: "female, bright, mid pitch" },
  { name: "Callirrhoe", description: "female, easy-going, mid pitch" },
  { name: "Charon", description: "male, informative, lower pitch" },
  { name: "Despina", description: "female, smooth, mid pitch" },
  { name: "Enceladus", description: "male, breathy, lower pitch" },
  { name: "Erinome", description: "female, clear, mid pitch" },
  { name: "Fenrir", description: "male, excitable, younger pitch" },
  { name: "Gacrux", description: "female, mature, mid pitch" },
  { name: "Iapetus", description: "male, clear, mid-low pitch" },
];

// The highest scene number a queued job will write: an image batch writes one file per scene, not just its first.
const lastNumber = (j: Job) => Math.max(Number(j.params.file_stem.match(/\d+/)?.[0] ?? 0) + (j.params.agent_scenes?.length ?? 1) - 1, ...(j.params.agent_numbers ?? []));

const BUSY = "A generation is running in the Flow tab. Wait for it to finish (flow_wait), then retry.";

const STILL = /\.(jpe?g|png|webp)$/i;
// The matte reads transparency from how far each pixel moves between the two takes, so the background must be flat
// and the subject must not change at all between them: no shadow, glow or reflection that exists on one take only.
const ON_WHITE =
  "show it alone on a pure solid white background (#FFFFFF), perfectly flat and even: no shadow, no floor, no reflection, no gradient, no vignette, no text, nothing else in the frame. The whole subject in frame with a clear margin on every side.";
const TO_BLACK =
  "Change ONLY the background of this image to pure solid black (#000000), perfectly flat and even. Keep the subject pixel-for-pixel identical: same position, same size, same pose, same crop and framing, same colours, same lighting, every detail and edge unchanged. Do not add any shadow, glow, rim light, reflection or outline.";

export class LocalCore implements Core {
  // One worker per enabled account, all running at once; each job runs inside its account, so every Flow step it takes
  // (getFlowPage, downloads) goes to that account's own Chrome.
  private queue: JobQueue = new JobQueue((job, account) => onAccount(account, () => this.run(job)), {
    accounts: () => enabledAccounts().map((a) => a.name),
    ready: (account) =>
      onAccount(account, async () => {
        const state = await getFlowState();
        return state.signedIn && state.inProject ? undefined : state.hint;
      }),
  });

  private async run(job: Job): Promise<string[]> {
    const { chain_from, reference_from } = job.params;
    if (reference_from) {
      const still = this.queue.get(reference_from)?.files.find((f) => /\.(jpe?g|png|webp)$/i.test(f));
      if (!still) throw new Error(`reference_previous: the previous scene (${reference_from}) produced no image.`);
      job.params.reference_images = [still, ...(job.params.reference_images ?? [])].slice(0, 3);
    }
    if (chain_from) {
      const clip = this.queue.get(chain_from)?.files.find((f) => /\.(mp4|webm|mov)$/i.test(f));
      if (!clip) throw new Error(`chain_previous: the previous scene (${chain_from}) produced no video, so this scene was skipped.`);
      job.params.first_frame = await extractLastFrame(clip);
    }
    if (job.params.matte_from) return this.runCutout(job, job.params.matte_from);
    if (job.params.continue_from) return runContinue(job);
    if (job.params.agent_scenes) return runAgentBatch(job);
    if (job.params.edit_asset) return runEdit(job);
    return runGeneration(job);
  }

  // Calls that drive one account's Flow tab directly (not through the queue) run on the account asked for, or the first
  // one, and wait for nothing: if that account's Chrome is in the middle of a job they say so instead.
  private direct<T>(account: string | undefined, work: () => Promise<T>): Promise<T> {
    const target = account ? accountByName(account) : defaultAccount();
    if (this.queue.busyOn(target.name)) return Promise.reject(new Error(`${BUSY} (account "${target.name}")`));
    return onAccount(target, work);
  }

  // Which account a queued job must run on: the one named, or - for work that uses media already in a Flow project
  // (asset:..., an edit, a continuation) - the first account, since that media lives in one account's project.
  // Everything else is left free for whichever account is idle first.
  private pin(account: string | undefined, usesProject: boolean): string | undefined {
    if (account) return accountByName(account).name;
    return usesProject && enabledAccounts().length > 1 ? defaultAccount().name : undefined;
  }

  // Second half of a cutout: redraw the white take on black through Flow, then difference-matte the pair locally.
  private async runCutout(job: Job, whiteJob: string): Promise<string[]> {
    const white = this.queue.get(whiteJob)?.files.find((f) => STILL.test(f));
    if (!white) throw new Error(`The white-background take (job ${whiteJob}) produced no image, so there is nothing to cut out. Run flow_cutout again.`);
    job.params.reference_images = [white];
    const black = (await runGeneration(job)).find((f) => STILL.test(f));
    if (!black) throw new Error("Flow made no black-background take, so the cutout could not be finished.");
    const matte = await differenceMatte(white, black, join(job.params.output_dir, `${job.params.file_stem.replace(/-black$/, "")}.png`));
    job.note = [
      job.note,
      `cutout ${matte.width}x${matte.height}: ${Math.round(matte.opaque_share * 100)}% solid, ${Math.round(matte.clear_share * 100)}% clear`,
      matte.warning,
    ]
      .filter(Boolean)
      .join(" · ");
    return [matte.file, white, black];
  }

  async status({ detailed }: Args<"status">) {
    const enabled = enabledAccounts();
    const accounts = [];
    for (const a of enabled) {
      const flow = await onAccount(a, () => getFlowState(detailed && !this.queue.busyOn(a.name))).catch((err: Error) => ({ error: err.message }));
      accounts.push({ name: a.name, ...this.queue.workerView(a.name), flow });
    }
    // `flow` stays the first account's state so a single-account setup (and the Studio panel) reads it as before.
    return {
      flow: accounts[0]?.flow,
      ...(enabled.length > 1 ? { accounts } : {}),
      image_model: defaultImageModel() ?? "latest (the newest Nano Banana)",
      pacing: this.queue.pausedReason,
      output_root: OUTPUT_ROOT,
      jobs: this.queue.list().map(jobView),
    };
  }

  async generate({ project, scenes, account }: Args<"generate">) {
    const invalid = scenes.findIndex((s, i) => s.chain_previous && (i === 0 || s.first_frame || s.type === "image"));
    if (invalid >= 0) {
      throw new Error(`Scene ${invalid + 1}: chain_previous needs a preceding video scene in the same call and cannot be combined with first_frame.`);
    }
    const noPrev = scenes.findIndex((s, i) => s.reference_previous && i === 0);
    if (noPrev >= 0) throw new Error("Scene 1 has no previous scene to reference.");
    const unknown = scenes.find((s) => s.technique && !techniqueById(s.technique));
    if (unknown) throw new Error(`Unknown technique "${unknown.technique}". Call flow_techniques for valid ids.`);

    const output_dir = projectDir(project);
    // Continue numbering after whatever is already on disk or queued, so reruns never overwrite earlier scenes.
    const onDisk = existsSync(output_dir) ? readdirSync(output_dir).map((f) => Number(f.match(/^scene-(\d+)/)?.[1] ?? 0)) : [];
    const queued = this.queue.list().filter((j) => j.params.output_dir === output_dir).map(lastNumber);
    const offset = Math.max(0, ...onDisk, ...queued);
    const jobs: Job[] = [];
    for (const [i, { chain_previous, reference_previous, technique, ...scene }] of scenes.entries()) {
      const phrase = technique ? techniqueById(technique)!.phrase : "";
      // A referenced character must come out identical, not merely similar, so the scene says so explicitly. The
      // wording stays medium-neutral: the same lock has to serve a flat cartoon character and a photoreal avatar.
      const cast = (scene.reference_images ?? [])
        .filter((r) => r.startsWith("asset:"))
        .map((r) => r.slice(6).trim())
        .filter((n) => characterLook(n) !== undefined || /^[\w .'-]{1,60}$/.test(n));
      const lock = cast.length
        ? ` CHARACTER LOCK — ${cast.join(" and ")} must match the reference image exactly, as if copying it: same head shape and size, same face, same eyes, same hair, same skin, same build and proportions, same clothing items in the same colours, same hands, and the same rendering style and level of realism as the reference. Never redesign, restyle, re-proportion, re-age or re-colour them, and never swap an item for a similar one.${cast
            .map((n) => (characterLook(n) ? ` ${n} is exactly: ${characterLook(n)}.` : ""))
            .join("")}`
        : "";
      const inherit = reference_previous
        ? " Match the previous image exactly for the subject's appearance, colour palette, lighting and rendering style; this is the same scene a moment later."
        : "";
      jobs.push(
        this.queue.add({
          ...scene,
          prompt: `${scene.prompt.trim().replace(/\.?$/, ".")}${phrase ? ` ${phrase}` : ""}${lock}${inherit}`,
          chain_from: chain_previous ? jobs[i - 1].id : undefined,
          reference_from: reference_previous ? jobs[i - 1].id : undefined,
          account: this.pin(account, [scene.first_frame, scene.last_frame, ...(scene.reference_images ?? [])].some((r) => r?.startsWith("asset:"))),
          output_dir,
          file_stem: `scene-${String(offset + i + 1).padStart(2, "0")}`,
        }),
      );
    }
    return { output_dir, jobs: jobs.map(jobView) };
  }

  async wait({ job_ids, timeout_seconds }: Args<"wait">) {
    const pick = () => (job_ids ? job_ids.map((id) => this.queue.get(id)).filter((j): j is Job => Boolean(j)) : this.queue.list());
    const deadline = Date.now() + timeout_seconds * 1000;
    while (Date.now() < deadline && pick().some((j) => j.status === "queued" || j.status === "running")) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    const jobs = pick();
    return {
      finished: jobs.every((j) => j.status !== "queued" && j.status !== "running"),
      pacing: this.queue.pausedReason,
      jobs: jobs.map(jobView),
    };
  }

  async cancel({ job_id }: Args<"cancel">) {
    const job = this.queue.cancel(job_id);
    if (!job) throw new Error(`No job with id ${job_id}. Use flow_status to list jobs.`);
    return jobView(job);
  }

  async retry({ job_ids }: Args<"retry">) {
    const ids = job_ids ?? this.queue.list().filter((j) => j.status === "failed" || j.failed_scenes?.length).map((j) => j.id);
    const jobs: Job[] = [];
    for (const id of ids) {
      const job = this.queue.get(id);
      const p = job?.params;
      if (job?.failed_scenes?.length && p?.agent_scenes && job.status === "done") {
        // A batch that finished with some images still failed: make just those again, under their own scene numbers,
        // instead of re-running the whole batch. The list moves to the new job, so it is never retried twice.
        const base = Number(p.file_stem.match(/\d+/)?.[0] ?? 1);
        const numbers = p.agent_numbers ?? p.agent_scenes.map((_, i) => base + i);
        const pick = job.failed_scenes.map((n) => numbers.indexOf(n)).filter((i) => i >= 0);
        job.failed_scenes = undefined;
        jobs.push(
          this.queue.add({
            ...p,
            prompt: `Agent batch: ${pick.length} failed image(s) again`,
            agent_scenes: pick.map((i) => p.agent_scenes![i]),
            agent_numbers: pick.map((i) => numbers[i]),
            agent_scene_refs: p.agent_scene_refs ? pick.map((i) => p.agent_scene_refs![i]) : undefined,
            file_stem: `scene-${String(numbers[pick[0]]).padStart(2, "0")}`,
          }),
        );
        continue;
      }
      const again = this.queue.retry(id);
      if (again) jobs.push(again);
    }
    if (!jobs.length) throw new Error("Nothing to retry: no failed jobs, and no batch with failed images.");
    return { jobs: jobs.map(jobView) };
  }

  async assets({ kind, account }: Args<"assets">) {
    return this.direct(account, async () => (await listAssets()).filter((a) => !kind || a.kind === kind).map(({ name, kind }) => ({ name, kind })));
  }

  async download({ project, assets, quality, account }: Args<"download">) {
    return this.direct(account, () => this.downloadNow(project, assets, quality));
  }

  private async downloadNow(project: string, assets: string[], quality: "original" | "upscaled") {
    const dir = projectDir(project);
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    // Numbering from 1 every call overwrote clips fetched earlier - it destroyed a finished shot once. Carry on from
    // the highest clip-NN already on disk instead.
    let next = Math.max(0, ...readdirSync(dir).map((f) => Number(f.match(/^clip-(\d+)/)?.[1] ?? 0))) + 1;
    for (const name of assets) {
      try {
        files.push(...(await downloadAsset(name, join(dir, `clip-${String(next++).padStart(2, "0")}`), quality)));
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : err} (downloaded so far: ${files.length})`);
      }
    }
    return { dir, files };
  }

  async assemble({ project, voice_lines, ...rest }: Args<"assemble">) {
    const dir = projectDir(project);
    if (!voice_lines?.length) return assemble({ dir, ...rest });
    mkdirSync(dir, { recursive: true });
    const track = await voiceTrack(voice_lines, join(dir, `${rest.output_name.replace(/[^\w.-]+/g, "_")}-voice.wav`));
    const film = await assemble({ dir, ...rest, voiceover: track.file });
    return { ...film, voice: track };
  }

  // Captions never touch Flow or its queue: whisper.cpp hears the words, a headless Chrome of its own draws them.
  async transcribe({ video, language, words }: Args<"transcribe">) {
    const t = await transcribe(video, language);
    return {
      text: t.text,
      word_count: t.words.length,
      language: t.language,
      model: t.model,
      ...(words ? { words: t.words.map((w) => ({ text: w.text, start: Number(w.start.toFixed(2)), end: Number(w.end.toFixed(2)) })) } : {}),
    };
  }

  async caption_preview(a: Args<"caption_preview">) {
    return previewCaptions(a.video, a);
  }

  async captions({ project, ...a }: Args<"captions">) {
    // Save next to the video when it is already one of the user's films, otherwise in a Captions folder.
    const rel = relative(OUTPUT_ROOT, dirname(a.video));
    const inFilms = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    const dir = project ? projectDir(project) : inFilms ? dirname(a.video) : projectDir("Captions");
    mkdirSync(dir, { recursive: true });
    return burnCaptions(a.video, a, captionedName(dir, a.video));
  }

  async caption_setup() {
    return captionSetup();
  }

  // Everything already downloaded, newest project first, so the panel can show past work after a restart.
  async outputs() {
    if (!existsSync(OUTPUT_ROOT)) return { root: OUTPUT_ROOT, projects: [] };
    const media = /\.(mp4|webm|mov|gif|jpe?g|png|webp|m4a|mp3|wav|aiff?)$/i;
    const projects = readdirSync(OUTPUT_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const dir = join(OUTPUT_ROOT, d.name);
        const files = readdirSync(dir)
          .filter((f) => media.test(f) && !f.endsWith("-lastframe.jpg"))
          .map((f) => ({ name: f, path: join(dir, f), kind: /\.(mp4|webm|mov)$/i.test(f) ? "video" : /\.(m4a|mp3|wav|aiff?)$/i.test(f) ? "audio" : "image", mtime: statSync(join(dir, f)).mtimeMs }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { name: d.name, dir, files, mtime: Math.max(0, ...files.map((f) => f.mtime)) };
      })
      .filter((p) => p.files.length)
      .sort((a, b) => b.mtime - a.mtime);
    return { root: OUTPUT_ROOT, projects };
  }

  private nextStem(output_dir: string, prefix: string): string {
    const onDisk = existsSync(output_dir) ? readdirSync(output_dir).map((f) => Number(f.match(new RegExp(`^${prefix}-(\\d+)`))?.[1] ?? 0)) : [];
    const queued = this.queue.list().filter((j) => j.params.output_dir === output_dir && j.params.file_stem.startsWith(prefix)).map(lastNumber);
    return `${prefix}-${String(Math.max(0, ...onDisk, ...queued) + 1).padStart(2, "0")}`;
  }

  async agent({ project, scenes, aspect_ratio, model, download_quality, references, scene_references, account }: Args<"agent">) {
    const output_dir = projectDir(project);
    if (scene_references && scene_references.length !== scenes.length) {
      throw new Error(`scene_references has ${scene_references.length} entries for ${scenes.length} scenes; give one list per scene (empty for none).`);
    }
    const known = new Set((references ?? []).map((r) => r.name.toLowerCase()));
    const unknown = [...new Set((scene_references ?? []).flat().filter((n) => !known.has(n.toLowerCase())))];
    if (unknown.length) throw new Error(`scene_references names ${unknown.map((n) => `"${n}"`).join(", ")}, which is not in references.`);
    for (const r of references ?? []) {
      if (!r.image.startsWith("asset:") && !existsSync(r.image)) throw new Error(`Reference image not found: ${r.image}`);
    }
    // A reference already in a Flow project (asset:...) exists only in that account's project, so such a batch stays
    // whole on one account. References given as files are uploaded by whichever account runs each part.
    const pinned = this.pin(account, (references ?? []).some((r) => r.image.startsWith("asset:")));
    const first = Number(this.nextStem(output_dir, "scene").match(/\d+/)![0]);
    // With several accounts the batch is cut into one part per account (at least two scenes each) and every account's
    // agent renders its part at the same time. Each part keeps its scenes' own numbers, so the files come out in order.
    const parts = pinned ? 1 : Math.max(1, Math.min(enabledAccounts().length, Math.floor(scenes.length / 2)));
    const size = Math.ceil(scenes.length / parts);
    const jobs: Job[] = [];
    for (let start = 0; start < scenes.length; start += size) {
      const part = scenes.slice(start, start + size);
      const numbers = part.map((_, i) => first + start + i);
      jobs.push(
        this.queue.add({
          agent_refs: references?.length ? references : undefined,
          agent_scene_refs: references?.length && scene_references ? scene_references.slice(start, start + size) : undefined,
          prompt: parts > 1 ? `Agent batch: scenes ${numbers[0]}-${numbers.at(-1)} of ${first}-${first + scenes.length - 1}` : `Agent batch: ${scenes.length} images`,
          type: "image",
          model,
          max_credits: 0,
          aspect_ratio,
          download_quality,
          agent_scenes: part,
          agent_numbers: parts > 1 ? numbers : undefined,
          account: pinned,
          output_dir,
          file_stem: `scene-${String(numbers[0]).padStart(2, "0")}`,
        }),
      );
    }
    return { output_dir, jobs: jobs.map(jobView) };
  }

  // Two free Nano Banana stills - the subject on white, then the same picture redrawn on black - and a local
  // difference matte turns the pair into a PNG with real transparency, soft edges included.
  async cutout({ project, prompt, image, aspect_ratio, model, download_quality, account }: Args<"cutout">) {
    if (!prompt && !image) throw new Error("Pass `prompt` (Flow draws the subject) or `image` (cut out a picture you already have).");
    const output_dir = projectDir(project);
    const stem = this.nextStem(output_dir, "cutout");
    const shared = { type: "image" as const, max_credits: 0, aspect_ratio, model, download_quality, output_dir, account: this.pin(account, Boolean(image?.startsWith("asset:"))) };
    const white = this.queue.add({
      ...shared,
      prompt: image
        ? `${prompt ? `${prompt.trim().replace(/\.?$/, ".")} ` : ""}Keep the main subject of the reference image exactly as it is - same shape, colours, details and pose - and ${ON_WHITE}`
        : `${prompt!.trim().replace(/\.?$/, ".")} Draw the subject and ${ON_WHITE}`,
      reference_images: image ? [image] : undefined,
      file_stem: `${stem}-white`,
    });
    const black = this.queue.add({ ...shared, prompt: TO_BLACK, matte_from: white.id, file_stem: `${stem}-black` });
    return { output_dir, cutout: join(output_dir, `${stem}.png`), jobs: [white, black].map(jobView) };
  }

  async edit({ project, asset, prompt, download_quality, account }: Args<"edit">) {
    const output_dir = projectDir(project);
    const job = this.queue.add({ prompt, type: "video", max_credits: 0, edit_asset: asset, download_quality, account: this.pin(account, true), output_dir, file_stem: this.nextStem(output_dir, "edit") });
    return { output_dir, jobs: [jobView(job)] };
  }

  // Flow's composer takes a start frame OR a character, never both; agent mode takes both, so this goes that way.
  async continue_shot({ project, from_asset, prompt, attach, aspect_ratio, mode, download_quality, force, account }: Args<"continue_shot">) {
    // A lost queue entry is not proof that nothing ran: when the owner process is replaced mid-job the job vanishes
    // while Flow carries on and charges for it. Re-running then spends twice, which is exactly what happened on
    // 2026-09-20. Flow's own grid is the only honest record, so ask it before starting another paid generation.
    if (!force) {
      const recent = (await onAccount(account ?? defaultAccount(), () => listAssets())).slice(0, 6).filter((a) => a.kind === "video");
      const source = from_asset.toLowerCase();
      const echo = recent.find((a) => {
        const n = a.name.toLowerCase();
        return n !== source && !n.startsWith(source) && words(n).some((w) => words(source).includes(w));
      });
      if (echo) {
        throw new Error(
          `Flow already holds a recent clip called "${echo.name}", which looks like a continuation of "${from_asset}" that may have just been generated and charged for. ` +
            `Check it with flow_assets / flow_download before spending again. Pass force: true if you really do want another take.`,
        );
      }
    }
    const output_dir = projectDir(project);
    const job = this.queue.add({
      prompt,
      type: "video",
      max_credits: 0,
      continue_from: from_asset,
      attach,
      continue_mode: mode,
      aspect_ratio,
      download_quality,
      account: this.pin(account, true),
      output_dir,
      file_stem: this.nextStem(output_dir, "shot"),
    });
    return { output_dir, jobs: [jobView(job)] };
  }

  // Moves a file or a project folder from the films folder to the system's bin - recoverable from there, never
  // erased. Anything outside the films folder is refused, so a bad path can never reach the rest of the Mac.
  async discard({ path }: Args<"discard">) {
    const target = resolve(path);
    // relative() works with either separator; a path that climbs out ("..") or lands on another drive is refused.
    const rel = relative(OUTPUT_ROOT, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Only things inside your films folder can be moved to the bin from here.");
    if (!existsSync(target)) throw new Error("That file is already gone.");
    return { trashed: target, to: moveToBin(target), bin: BIN };
  }

  async trash({ name, account }: Args<"trash">) {
    return this.direct(account, () => trashAsset(name));
  }

  async character(a: Args<"character">) {
    if (!a.image && !a.describe) throw new Error("Pass either `describe` (Flow draws the portrait) or `image`.");
    const made = await this.direct(a.account, () => createCharacter(a));
    if (a.describe) rememberCharacter(a.name, a.describe);
    return { ...made, use_as: `asset:${a.name}` };
  }

  async character_edit({ name, change, look, account }: Args<"character_edit">) {
    const out = await this.direct(account, () => editCharacter(name, change));
    // Every scene that references the character quotes this description in its character lock, so it has to describe
    // the NEW look - "deep navy coat" left in it would argue with a portrait whose coat is now red.
    if (look) rememberCharacter(name, look);
    else if (change) rememberCharacter(name, `${characterLook(name) ?? ""} Changed since, and this wins over anything above: ${change.replace(/[.\s]+$/, "")}`.trim());
    return { ...out, use_as: `asset:${name}` };
  }

  async characters({ account }: Args<"characters">) {
    return this.direct(account, async () => (await listCharacters()).map((name) => ({ name, use_as: `asset:${name}` })));
  }

  // Accounts: each is its own Chrome profile the user signs in to by hand. Adding one only opens that window on Flow.
  async accounts({ action, name }: Args<"accounts">) {
    const needName = () => {
      if (!name) throw new Error(`Pass \`name\` with action "${action}".`);
      return name;
    };
    if (action === "add") {
      const a = addAccount(needName());
      await getFlowPage(a).then((p) => p.bringToFront());
      this.queue.kick();
      return {
        added: a.name,
        profile: profileDir(a),
        next: `A new Chrome window is open on Flow for "${a.name}". Sign in to that Google account there by hand, then open or create a project. Until then the other accounts take all the work.`,
        accounts: await this.accountList(),
      };
    }
    if (action === "open") {
      const a = accountByName(needName());
      await getFlowPage(a).then((p) => p.bringToFront());
      return { opened: a.name, accounts: await this.accountList() };
    }
    if (action === "enable" || action === "disable") {
      setAccountEnabled(needName(), action === "enable");
      this.queue.kick();
    }
    return { accounts: await this.accountList() };
  }

  private async accountList() {
    const out = [];
    for (const a of listAccounts()) {
      const flow = a.enabled ? await onAccount(a, () => getFlowState()).catch((err: Error) => ({ error: err.message })) : undefined;
      out.push({ name: a.name, enabled: a.enabled, ...(a.enabled ? this.queue.workerView(a.name) : {}), ...(flow ? { flow } : {}) });
    }
    return out;
  }

  // The image models Flow offers (read live from its menu) and the one image jobs use when they name none.
  async image_models({ set_default, account }: Args<"image_models">) {
    const available = await this.direct(account, () => listImageModels());
    if (set_default) {
      const wanted = set_default.trim();
      if (/^(latest|newest)$/i.test(wanted)) saveSettings({ ...loadSettings(), default_image_model: undefined });
      else {
        const match = available.find((m) => m.toLowerCase() === wanted.toLowerCase()) ?? available.find((m) => m.toLowerCase().includes(wanted.toLowerCase()));
        if (!match) throw new Error(`Flow has no image model called "${wanted}". Available: ${available.join(", ")}.`);
        saveSettings({ ...loadSettings(), default_image_model: match });
      }
    }
    const saved = defaultImageModel();
    return {
      default_image_model: saved ?? LATEST_IMAGE_MODEL,
      used_when_none_named: imageModelFor() === LATEST_IMAGE_MODEL ? "the newest Nano Banana in Flow's menu" : saved,
      available,
    };
  }

  // Panel only: deliberately NOT registered as an MCP tool, so a key typed into Flow Studio never reaches Claude.
  async set_key({ key }: Args<"set_key">) {
    return saveGeminiKey(key);
  }

  async voices() {
    // The panel words itself from these, so a PC never reads "this Mac".
    const place = { computer: COMPUTER, bin: BIN, local_engine: IS_MAC ? "macOS voice" : IS_WIN ? "Windows voice" : "System voice", platform: process.platform };
    return { gemini: GEMINI_VOICES, gemini_ready: Boolean(geminiKey()), mac: await localVoices(), place };
  }

  async narrate({ project, text, voice, engine, style }: Args<"narrate">) {
    const output_dir = projectDir(project);
    mkdirSync(output_dir, { recursive: true });
    const target = join(output_dir, `${this.nextStem(output_dir, "narration")}.m4a`);
    const spoken = engine === "mac" ? await speakLocally(text.trim(), voice, target) : await speakWithGemini(text.trim(), voice, target, style);
    return { output_dir, credits: 0, engine, voice, ...spoken };
  }

  async techniques({ category }: Args<"techniques">) {
    return TECHNIQUES.filter((t) => !category || t.category === category);
  }
}

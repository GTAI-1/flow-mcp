# flow-mcp

Local MCP server (stdio, TypeScript) that drives Google Flow in a dedicated Chrome profile over CDP
(`playwright-core`, `connectOverCDP` on port 9333). No extension. Goal: feature parity with
OmniFlow (lingoflow.pro/omniflow), using subscription credits instead of the API.

- `src/chrome.ts` launch/attach Chrome · `src/flow.ts` UI driver · `src/queue.ts` paced job queue
- `src/core.ts` all tool logic + zod shapes (LocalCore) · `src/server.ts` localhost HTTP API + Studio page ·
  `src/remote.ts` RemoteCore (used when another process owns port 8787) · `src/index.ts` MCP tools · `src/studio.ts` standalone panel
- `studio/index.html` Studio UI (single file, vanilla JS, mobile-first) · `src/chain.ts`, `src/assemble.ts` ffmpeg ·
  `src/techniques.ts` presets · `src/playbook.ts` guidance returned by `flow_status`
- Test: `node scripts/e2e.mjs <project> '<scenes json>'` (spends credits unless scenes are images)

## Rules

- Never guess selectors. Map them from the live page (`ariaSnapshot`, DOM dump) before writing driver code.
- Anything that spends credits needs the user's OK first. Images (Nano Banana 2) cost 0 and exercise the same pipeline.
- Never enter Google credentials; the user signs in by hand via `npm run login`.
- No bot-detection evasion. The page has invisible reCAPTCHA; we only drive the real UI at human pace.
- MCP FIRST, ALWAYS. When a new Flow capability or workaround is learned, build it into the MCP before using it for
  the task at hand, and do not ask whether to - the user has made this standing. Hand-driving a path once and moving
  on is not acceptable: the next run must be able to do it through the tools. Map the selectors live, wire the
  feature in, rebuild, then carry on with the user's actual request.

## Flow UI map (verified 2026-09-19, flow.google.com, Pro plan)

- Flow lives at `flow.google.com/project/<uuid>`; signed-out redirects to `/about`.
- Composer: prompt box is `.ProseMirror`; Enter submits. Buttons by accessible name: `Agent` (toggle,
  must be off: agent mode is conversational and asks for confirmation), `Settings trigger`,
  `Start generation`, `Add ingredients to the prompt box`, `Clear prompt`; Frames mode adds `Start` / `End`.
- Settings popover (radios): Image|Video · Frames|Ingredients (video) · aspect (video 16:9, 9:16; image
  also 4:3, 1:1, 3:4) · `Select model family` menu · 360p|720p and 4s|6s|8s|10s (Omni only) · x1–x4 ·
  live quote as a link "<N> credits". The trigger click sometimes does not open it: retry.
- Models/cost x1: Omni 1.1 Flash 7 (4s) / 12 (8s) · Veo 3.1 Lite 10 · Fast 20 · Quality 100 · images 0.
- Upload: `Add media menu` → `Upload` fires a filechooser; asset name = file name, so we upload as
  `fm-<jobid>-<label>.ext`. Pickers (`Start`, `End`, ingredients) show listbox `Asset list`; clicking an
  option attaches it immediately.
- Grid: `flow-grid-tile-container` (aria-label = title), virtual scroll inside `.page-container`. The top
  bar gets `visibility:hidden` once scrolled, so scroll to top before every step. New tiles appear first.
- Tile identity: uuid in the media `src`. Image tiles: `flow-image-tile img[data-media-id]`. Video tiles at
  rest hold only `img[alt="Generated video thumbnail"]`; a `<video>` appears after hover. In-progress tiles show `NN%`.
- Download: right-click tile → `Download` → submenu. Image: `1K Original size`, `2K Upscaled`. Video:
  `270p Animated GIF`, `720p Original size`, `1080p Upscaled` (4K disabled on Pro). Playwright `download.saveAs` works over CDP.
- Other tile menu items not automated yet: `Animate` (image→video), `Add to scene`, `Add to prompt`, `Rename`.
  Left nav: All media, Images, Videos, Characters, Scenes, Uploads, Tools, Trash.
- Edit view: clicking a video tile opens `/project/<id>/edit/<uuid>`. It has the edit composer
  ("Describe how to edit this video…", Omni 1.1 Flash, `Start generation`) = basis for `flow_edit`;
  a scene timeline with `Add clip` (native stitching), `Save frame`, `Download media`, history strip of
  project assets, `Done editing scene`, and `Back button to go to previous page`. Not automated yet.

## Status

Verified unattended end to end: image (incl. x2 variants), text→video, first+last frame, reference_images (files and
`asset:` characters), chain_previous, download (original + free 1080p upscale), credit guard, pacing, credits readout,
flow_assets, flow_download, flow_techniques, flow_assemble (incl. looping music + voiceover mix, checked with
volumedetect), flow_character, flow_edit (20 credits for a 4 s clip, result verified visually), flow_agent_images
(20 scenes → 20 files in scene order, 204 s, 0 credits; and the re-ask + one-by-one recovery path), Studio panel,
MCP-as-client via RemoteCore.
Omni 1.1 Flash quotes: 360p 4/5/6/7 and 720p 7/10/12/15 credits for 4/6/8/10 s.
Not built: "improve prompt (AI)" in Studio (bundled Claude Code CLI exists at
~/Library/Application Support/Claude/claude-code/<ver>/claude.app/Contents/MacOS/claude but is not logged in).
The app's Browser pane shows `studio/index.html` as a static file after edits: that view is NOT connected (the page
now says so). The real panel is http://127.0.0.1:8787 served by `npm run studio` / `Flow Studio.command`.
The preview tool could not read the project while it lived in ~/Desktop; check the Studio UI with headless Chrome screenshots instead.

## More UI map (2026-09-19)

- Ingredients picker (`Add ingredients to the prompt box`): tabs All/Images/Videos/Voices/Characters/Avatars/Uploads,
  `Upload media`, listbox `Asset list` with options named "<name> Image|Video|Avatar"; clicking only previews
  (videos get Trim start/end sliders) and `Add to prompt` attaches. Frame pickers (`Start`/`End`) attach on click.
- Characters: left-nav `Characters` → with none yet opens `/character` (describe + Nano Banana 2, `Upload`,
  `Add from project` → dialog `Select media` → option → `Add media`). That creates `/character/<uuid>` with
  textbox `Character name`, `Select a voice`, `Character personality`, `Reroll`, `Portrait`, `Create body`, `Done editing`.
  Afterwards the composer shows the character as a chip.
- Scenes nav is just a filter; scenes are made via tile menu `Add to scene` / Add media → `New scene`. Assembly is done locally (flow_assemble) instead.
- Edit composer shows no credit quote before starting, so `max_credits` cannot be enforced for edits; cost must be measured with one paid run before building `flow_edit`.
- Edit run (paid, 2026-09-19): in `/edit/<uuid>` type into the last `.ProseMirror`, `Start generation`; progress shows as
  "NN% <prompt>" text in the view and vanishes when done (~80 s for 4 s); URL does not change; the result is a NEW video
  tile at the top of the grid with the same title as the source. No credit quote is shown anywhere beforehand.
- Voice picker: `Select a voice` → dialog with listbox options "<Name> <description>" → `Add to character`. Filling
  "Customize performance" switches the dialog to generating/saving a new voice (`Preview`, `Save new voice`), so the tool uses stock voices only.
- Characters view lists `New character`, the user's own "Me" avatar and characters. Characters are PER PROJECT, not
  account-wide (checked 2026-09-20 across all three projects). The account holds exactly two, both real: "Pip" and
  "Sticky". The old "zz-test-*" and "Mina the barista" test characters are gone.
- Generations must start from the project root + `All media`; other views/pages give a wrong "before" tile snapshot.
- Agent mode (2026-09-19): `Agent` toggle on → composer gets `Agent instructions` + `Settings` (Agent settings: confirm
  Always/Never, image default aspect + x1–x4 + model, video defaults, `Save`). With confirm=Never a multi-scene prompt
  renders all images in parallel; a `Stop` button and status "Thinking…" show while it works, tiles show "NN% <enriched
  prompt>". New tiles end up newest-first, i.e. reverse scene order. runAgentBatch always restores confirm=Always and Agent off.
- Retry: queue retries once automatically only when the error says Flow reported a failure (timeouts are not retried: they may
  have spent credits); `flow_retry` / the Studio Retry button re-queue manually. A REAL failed tile has never been observed,
  so the failure detection in waitForNewMedia (FAILURE_TEXT on tile text) and any agent-mode per-scene retry are unverified.
  Capture the DOM of a genuine failed tile before building more on it. Caps: 100 scenes exact, 50 agent.
- Agent batches (verified 2026-09-20, 5 scenes with scene 2 simulated missing via `FLOW_MCP_SIMULATE_MISSING=2` → all 5
  files correctly numbered, 114 s, 0 credits): tiles finish in ANY order and the agent rewords prompts, so runAgentBatch
  reads each new tile's stored prompt (hover → `Reuse prompt` → composer text), matches tiles to scenes by word overlap
  (matchScenes, ≥50 % of the scene's words), and re-runs unmatched scenes through runGeneration (2 attempts each).
  `Reuse prompt` on an agent-made tile opens the agent session panel (`Start new session`, `Close`) which hides the normal
  composer; closeAgentSession handles it. This retry does not depend on what a failed tile looks like.
- REAL failed tile observed 2026-09-20 (user's own image, busy servers): `flow-grid-tile-container` with EMPTY aria-label →
  `flow-image-tile` → `flow-error-tile` (`.error-title` "Failed", `.error-message-text` "Sorry, this image failed to
  generate.", `.disclaimer-message` "You have not been charged for this generation."), buttons `Retry`, `Reuse prompt`,
  `Delete`. No "%" text, so wait loops end normally. Pressing `Retry` removes the error tile and starts a fresh progress tile
  at the TOP of the grid (done in ~25 s); verified by hand on that tile. Old failed tiles stay in the grid forever, so
  newErrorTiles only counts error tiles above the first already-known tile (unit-checked with injected stand-ins).
  Both engines now press Flow's Retry (exact: `retries`, default 1; agent: up to 2 rounds) before giving up; agent scenes
  still missing afterwards are re-run one by one. NOT yet seen live: an automated run hitting a genuine failure end to end.
- Tile identity (fixed 2026-09-20): Flow now serves thumbnails from signed `https://flow.google.com/asb/...` URLs with NO
  uuid, so the old "uuid in src" extraction silently returned nothing for most tiles (listAssets: 5/42 ids). Use
  TILE_ID_JS: `data-media-id` (images) → uuid in src → the signed src URL itself (video tiles at rest have only a
  thumbnail `img[alt="Generated video thumbnail"]`). mediaTile handles both a uuid and a URL handle. Re-verified: 42/42.
- Two flow-mcp processes attached to the same Chrome (e.g. Studio running while a test drives the MCP) break downloads:
  Playwright's per-connection artifact dir is swept while the other process saves → `download.saveAs ... ENOENT`.
  downloadTile now falls back to copying from `download.path()`; still, stop the Studio server before running MCP tests.
- AGENT-MODE FAILURES (observed live 2026-09-20, 20-scene batch): 4 of 20 tiles failed. An agent-made `flow-error-tile`
  offers ONLY a `Delete` button - no `Retry`, no `Reuse prompt` (a manually generated failure does offer Retry). So Flow's
  native retry is unavailable for agent batches; recovery is: ask the AGENT again for just the missing scene numbers
  (parallel, what the user asked for), up to 2 extra rounds, then one-by-one runGeneration as a last resort.
- Agent batch lessons from that run: (1) the retry step must never throw - 16 good images were lost when it did;
  (2) `done.add(sceneIndex)` must only happen when a tile was really downloaded, otherwise missing scenes are silently
  skipped and the note lies ("20 of 20"); (3) freshness must be judged by media id, NOT by title - the agent reuses the
  same titles across runs, so a name-based `before` set hid 12 of 20 new tiles.
- Virtual grid trap (cost two failed flow_edit runs): after `scanGrid` finds a tile far down the list, DO NOT
  `scrollToTop` before clicking it - the tile is unmounted and every locator times out. Take the "before" snapshot
  first (new tiles always appear at the top), then scan and act on the tile where it is.
- Characters (2026-09-20): `flow_character` accepts `describe` (draws a free portrait into <output>/_cast first) or `image`;
  the editor's finish button is "Done editing" OR "Done" depending on panel state. Portraits must NOT be downloaded into
  os.tmpdir() - the artifact is swept mid-save (download.saveAs ENOENT). listCharacters reads `img[alt="Character thumbnail"]`
  containers (the template chooser shown when no characters exist is not a character) and strips Material icon ligature text
  ("accessibility_new", "person"). Studio has a Cast card that creates and lists them and drops one into scene 1's references.
- Character tiles are `<flow-character-tile>` elements (NOT buttons) whose innerText is "<name> accessibility_new";
  listCharacters/editCharacter both go through that selector. editCharacter types into the LAST `.ProseMirror`
  ("What do you want to change?"), waits for the `img[alt="Generated character image"]` src to change with no "%" on the
  page, then `Download image` -> `<output>/_cast/<name>.jpeg`. Free (Nano Banana). Verified live 2026-09-20 (added gloves).
- Studio v2 (2026-09-20) is a TAB workspace: cast/frames/shots/narrate/restyle/cut/library, each a `.panel`
  toggled by `#tabs button[data-tab]`; Monitor + Gallery stay in the right column. State is one object `S` per tab in
  localStorage key `flow-studio-v2`. All five previously MCP-only features are now in the UI: reference_previous
  ("match previous frame"), voice attachment (flow_narrate), character editing, flow_edit, hold-last-frame in assemble.
- Flow's voice "Play preview" plays a CANNED sample from gstatic (voices/samples/<Name>.wav) - it never speaks your text.
  Real speech only comes from generating a video with the voice attached as an ingredient; flow_narrate does that with a
  cheap 360p take and extracts the audio. Frames and Ingredients are mutually exclusive in the COMPOSER (see the agent
  route below), so a composer narration take cannot also lock first/last frames.
- Narration has two engines: `flow` (Flow voice, 4-7 credits, capped by take length) and `mac` (`say -v <voice>`,
  free, any length, cleaned up through ffmpeg loudnorm; the .aiff intermediate is removed). localVoices() filters
  `say -v ?` down to en_* and drops the novelty voices. Premium macOS voices appear automatically once the user
  installs them in System Settings - Claude must not install them (system settings are the user's to change).
- assemble's defaultClips now accepts scene-NN / clip-NN / edit-NN mp4s (never narration-*, never the output file);
  if none match it falls back to every other mp4 oldest-first. Studio shows assemble errors inline in #c_out, not just a toast.
- Narration engines are now gemini | flow | mac. `src/gemini.ts` calls `models/<tts>:generateContent` with
  responseModalities ["AUDIO"] and a prebuiltVoiceConfig; the reply is base64 raw s16le PCM whose sample rate is only in
  the mimeType (`audio/L16;rate=24000`), so ffmpeg wraps it with -f s16le -ar <rate>. Key comes from GEMINI_API_KEY or
  ~/.flow-mcp/gemini-key (the user writes it themselves; Claude never handles the key). Gemini and Flow share the voice
  family, so a Gemini take matches a Flow one. UNTESTED until a real key exists - the no-key path is verified.
- Narration through Flow was REMOVED (2026-09-20): it cost 4-7 credits, capped the line to the take length and could
  paraphrase. flow_narrate is now gemini | mac only, both free and unlimited in length. Flow's own VOICES list stays in
  core.ts solely for giving a CHARACTER a voice. Verified in the panel: both engines record, the style note shows for
  Google only, and the Google take used the same Charon voice a Flow take had cost 7 credits for.
- Downloads rewritten (2026-09-20, after three clips generated fine but never reached disk): Playwright's `download`
  event + `saveAs` is not dependable here - the bytes sit in a per-connection artifact directory that a second
  connection to the same Chrome sweeps. Chrome now writes into `~/.flow-mcp/downloads` itself
  (CDP `Browser.setDownloadBehavior`, `allowAndName`) and `waitForDownloadedFile` polls for a new non-`.crdownload`
  file whose size has stopped changing, then renames it onto the target. Two more traps in the same path:
  (1) Playwright's `hover()` does NOT open a tile's toolbar - Flow only reveals it for a real pointer move, so
  `hoverTile` drives `page.mouse.move` to the tile's box centre; (2) prefer the toolbar's `More options` button over a
  right-click, which can land on the `<video>` and raise Chrome's own context menu instead of Flow's. `downloadMedia`
  now settles (scrollToTop + 2.5 s) and re-resolves the tile by id before touching it, because a tile that has just
  finished rendering is still being re-mounted by the virtual grid and the old handle's toolbar never opens.
- Frames and Ingredients are mutually exclusive IN THE COMPOSER ONLY (verified 2026-09-20: picking the `Frames` radio
  removes the "Add ingredients to the prompt box" button from the page entirely and puts `Start`/`End` in its place).
  runGeneration therefore drops references when frames are set, and says so in the job note. This is NOT a limit of
  Flow - see the agent route below, which does both at once.
- The server lives at `~/flow-mcp` (2026-09-20); `~/Desktop/flow-mcp` is a symlink to it. Claude Desktop's shared MCP
  pool could not start it from `~/Desktop`: `EPERM` opening `dist/index.js`, repeatedly, even with Full Disk Access
  granted to Claude - while a node spawned from that same path in another lane read the file fine. Cause not fully
  explained; keeping the runtime out of `~/Desktop` is the remedy being tested. Both `claude_desktop_config.json` and
  `~/.claude.json` point at the new path.

- AGENT ROUTE - continue from a last frame AND keep a reference attached (user-demonstrated 2026-09-20, with
  screenshots). The composer cannot do both; agent mode can. The steps:
  1. Open the finished video (click its tile) -> the edit view. Scrub the playhead to the end and press `Save frame`
     (icon button top-right of the player). That writes an image asset titled "Saved frame from <video title>".
  2. Go back to All media. On THAT IMAGE's tile menu press `Animate` (an image-only menu item; a video's menu has
     `Add to scene` / `Add to prompt` instead). It drops the image into the composer as a chip.
  3. Agent mode MUST be on, otherwise the avatar cannot be added alongside it.
  4. Press `+` in the composer and add the avatar (or any character), giving TWO chips at once: the saved frame and
     the avatar. Then type the prompt and generate.
  Never tell the user Flow "cannot" do something because the composer refuses it - check the agent route first.
  Agent mode routinely offers combinations the composer gates, and the user has been right about this before.
  BUILT IN as `flow_continue` (runContinue in flow.ts), verified selector by selector on 2026-09-20:
  tile click -> /edit/<uuid> -> `Skip to next clip` parks the playhead (clock reads 00:10:00 / 00:10:00; there is NO
  <video> element in that view, so scrub through the control, not the DOM) -> `Save frame` writes an image titled
  "Saved frame from <video title>" -> `Back button to go to previous page` -> the saved frame is the newest tile at
  the top (titles repeat if you save twice, so take .first()) -> its menu has `Animate` (image-only; a video's menu
  has `Add to scene`/`Add to prompt` instead) -> Animate drops it in the composer AND turns Agent on by itself ->
  `Add ingredients to the prompt box` -> `Avatars` tab -> `Me` attaches on click, giving TWO chips.
  Agent mode shows no credit quote, so flow_continue takes acknowledge_cost like flow_edit.
  ATTACHING THE FRAME IS NOT ENOUGH (cost 15 credits to learn, 2026-09-20): agent mode treats both chips as
  ingredients and decides what to do with them, so a saved frame read as a style reference and the agent staged a
  fresh shot instead of continuing. runContinue now prefixes the user's prompt with an explicit instruction that the
  attached frame IS the first frame and the clip must begin exactly on it. Agent mode has to be TOLD, not just given.
  flow_download used to number clip-NN from 1 on every call and silently overwrote earlier files - it destroyed a
  finished shot. It now continues from the highest clip-NN already in the folder.
  DOUBLE-SPEND (2026-09-20, 30 credits): flow_wait timed out and the queue came back EMPTY, so the shot looked like it
  had never run - but the owner process had been replaced mid-job while Flow carried on generating and charging. An
  empty queue is NOT evidence that nothing ran; Flow's grid is the only honest record. flow_continue now checks
  listAssets for a fresh-looking continuation of the same source before starting, and refuses unless force: true.
  Whenever a paid job disappears from the queue, look at the grid before re-running anything.
  I2V vs R2V - THE REAL CONSTRAINT (2026-09-20, straight from Flow's agent): "The first frame animation tool (I2V)
  allows for an exact continuation of your image, but it doesn't support additional references like your avatar
  (likeness)." So a frame-exact continuation and a separate character reference are mutually exclusive AT THE MODEL,
  not just in the composer. Agent mode lets both chips be attached, then stops and asks which one to honour. Attaching
  a likeness in exact mode therefore buys nothing and stalls the run on a question. flow_continue now takes
  mode: exact (I2V, default - invisible join, likeness comes from the frame itself) or likeness (R2V - character
  locked, opening frame only approximate), names the tool in the prompt so the agent does not ask, and answers the
  question automatically if it asks anyway. Verified live: shot 2 opened on shot 1's exact last frame, same pose, same
  hand on the desk, invisible cut.
  MULTIPLE LOCALCORES (FIXED 2026-09-20): Claude Desktop spawns several MCP processes in the same second. Binding the
  port is atomic, so that part never raced - the bug was the fallback. A process that lost the bind did ONE 2 s health
  check and, on a timeout, returned role "none", which means "drive Chrome myself with my own queue". A timeout proves
  nothing when the owner is still booting or is busy inside a Playwright call, so several processes became local
  drivers: flow_status answered from a process that knew nothing about the running job (queue empty while Flow
  generated and charged), and a shot was paid for twice. startServer now retries the health check 8 times over ~12 s,
  treats a VALID answer from something that is not flow-mcp as "the port belongs to another program, local is safe",
  and on a never-confirmed holder defers as a client rather than overriding it - a client whose calls fail loudly
  beats a second process silently spending credits. Checked with 5 processes racing one port: 1 owner, 4 clients.
- Chrome's `Browser.setDownloadBehavior` with "allowAndName" writes every download under a bare uuid with NO extension,
  so `extname()` on it is always empty and everything was being saved as .mp4 - a still came down as clip-01.mp4.
  extensionOf() now sniffs the first 12 bytes (JPEG/PNG/WEBP/GIF/ftyp) and names the file after what it really is.
- Agent mode left ON breaks the NEXT job, which looks for the plain composer: `flow_character` died with
  "waiting for getByRole('button', { name: 'Agent' })" because runContinue's cleanup had toggled it while Flow's agent
  session panel still covered the composer, so the click hit nothing and the failure was swallowed by .catch(). The
  cleanup now closes the panel and returns to the grid FIRST, and setAgentMode verifies the toggle actually flipped.
- Prompting lesson (cost 15 credits): an extreme close-up of hands doing a continuous activity ("working a knot")
  gives the model nothing to finish, so it loops aimless fidgeting for the whole clip. A shot needs ONE specific
  action with a beginning and an end - a switch clicked off, a single clap of chalk, one decisive pull - and the
  person's face in frame with their hands, not hands alone.
- DOWNLOADS WERE GOING TO ~/Downloads ALL ALONG (root cause of hours lost, 2026-09-21). `Browser.setDownloadBehavior`
  was sent ONCE per process behind a `downloadsReady` flag, but the override is browser-wide and gets reset whenever
  another CDP client attaches - Claude Desktop starts several. Chrome then silently used its own Downloads folder
  while waitForDownloadedFile watched an empty directory and reported "no file arrived", so clip after clip looked
  like a failed download when the file was already on disk. Now: the behaviour is re-asserted before EVERY download,
  and both `~/.flow-mcp/downloads` and `~/Downloads` are watched.
- Flow reuses its auto-generated titles: two takes of one scene both came back "Woman climbing granite wall", so the
  newer clip could not be found by name and flow_assets looked unchanged. runGeneration now renames each finished
  tile to `<project>-<file_stem>` through the tile menu's `Rename` (renameTile, best effort - a failed rename must
  never lose the clip). The user asked for this; it removes a whole class of confusion.
- FALSE "FAILED" CLIPS (2026-10-09, 31 in one session, every clip that used first/last frames): the job grabbed its
  OWN UPLOAD instead of the clip. Frames and reference files are uploaded as `fm-<job>-<label>`; the upload tile
  appears at once ("image 0%") and only gets its media id when processing ends, which was after the "before"
  snapshot, so it looked new. Its menu offers only Delete, hence "tile menu has no Download item. It offered: Delete",
  while the real clip sat finished in the grid (flow_download by title always worked). Now: freshMedia() skips
  `fm-` tiles, tiles still showing "NN%", and tiles of the wrong kind (a video job only accepts flow-video-tile, an
  image job flow-image-tile; edit and continue jobs accept videos only, so "Save frame" stills are ignored too), and
  uploadAsset waits for its own tile by name until it carries data-media-id. Replayed against the live grid: the old
  logic picked fm-db88e712-end.png, the new one waits and then picks the clip. Then verified on a paid clip (4 credits,
  the user's OK): Omni 1.1 Flash 4 s 360p from an uploaded first frame -> job "done" in 63 s, the clip downloaded,
  opening on the frame, progress readout working ("14%").
- SECOND REFERENCE (2026-10-09, twice: a character, then an uploaded still): the click on "Add ingredients" produced
  no picker at all and the job died after 10 s. Not reproducible on demand (character + upload, even mid-processing,
  all opened fine), so attachAsset now retries the opener three times with Escape in between, and always switches
  the picker to its All tab (it reopens on the last tab used, e.g. Characters). Verified with a real free still:
  "asset:Juno" + an uploaded file -> both attached, the generated still (not the upload) downloaded.
  Also noted: getByRole("button", { name: "Ingredient" }) also counts a hidden button outside the composer.
- listAssets/downloadAsset now go to the project grid first: with a scene (or clip/character) view open, the scan
  found nothing and flow_assets reported "no scenes" while one was on screen.
- Gemini TTS: a LONG `style` note makes the model ramble - a 45-word line with a 25-word delivery note produced 674
  SECONDS of audio. The same line with no style note is 20.5 s, with a short note 32 s. Keep style notes to a few
  words, and sanity-check the returned duration against the expected one before using it.
- Flow's "1080p Upscaled" download renders on demand and may simply never deliver (waited 7+ minutes twice on one
  clip, nothing). Do not block a delivery on it: take the 720p original and upscale locally with
  `scale=1920:1080:flags=lanczos` if a 1080p master is needed.
- SCENES (mapped 2026-10-01, user-demonstrated): a scene is its own tile, `<flow-scene-tile>` with
  `flow-multi-clip-video-player` + `flow-clip-filmstrip`. scanGrid used to call anything without `flow-video-tile` an
  "image", so scenes showed as stills in the Library. Kind is now image | video | scene. A scene's TILE MENU
  (Favorite, Rename, Copy, Download, Move to trash) has a Download with no submenu that hands back a ZIP of the loose
  clips - not what anyone wants. The whole scene comes out of the SCENE VIEW: click the tile -> /project/<id>/scene/<uuid>
  -> button `Download scene` -> page shows "Exporting your scene..." -> ONE stitched mp4 (29 s scene: a few seconds,
  25.6 MB). Pressing Escape during the export cancelled it once, so downloadScene touches nothing until the file lands.
- ZIP downloads: a tile holding several takes (x2-x4) also downloads as a ZIP. extensionOf() fell back to ".mp4" for
  anything it did not recognise, so ZIPs were saved as clip-NN.mp4 and the Cut failed with "moov atom not found".
  ZIPs are now detected (PK\x03\x04) and unpacked into <stem>.mp4, <stem>-v2.mp4 ... (the ZIP kept as -takes.zip);
  unknown types get ".bin" instead of a misleading ".mp4". The download functions now return string[].
- Cut tab (2026-10-01): it could only take clips from a project folder, with no way to choose a video, so a user with
  one MP4 and a narration could not combine them. It now has "Video clips, in play order" (Upload a video, From my
  films -> api outputs), passed as `clips` to assemble; empty = the old folder behaviour. Added `clip_volume` (0-1):
  the clips' own sound played at full volume over the narration, only music had a level. Measured: 0.25 = -12.0 dB.
  assemble now explains an unreadable clip by name and a missing project folder in words, instead of ffprobe output.
- DELETE (mapped 2026-10-01 on throwaway images, never on user work): tile menu -> `Move to trash` removes the tile
  IMMEDIATELY - Flow asks no confirmation - and it lands in left-nav `Trash`, where the tile offers `Restore` and
  `Delete permanently`. trashAsset / flow_trash / the Library tab's "Move to trash" only ever MOVE to Trash (never
  Delete permanently), match the EXACT title, and refuse when two items share it. The panel confirms before calling.
- Panel housekeeping (2026-10-01): local files can be moved to the Mac's Trash (core.discard - refuses anything
  outside the films folder; Gallery viewer "Move to Trash" and "Move this whole folder to Trash"). outputs() now lists
  narrations as kind "audio": the Voice tab has its own "Your narrations" list (play + Move to Trash) and Cut's music
  and narration slots pick from it ("My narrations"). GALLERY_KINDS decides the side gallery per tab: Cast and Frames
  stills, Shots stills + clips (stills are its first/last frames), Restyle and Cut clips; hidden on Voice and Library,
  which have their own lists. Delete labels name WHERE: "Mac's Trash" (local files) vs "Flow's Trash" (Library - removes
  from the Flow project only; downloaded files stay). On wide screens the right column scrolls on its own
  (max-height + overflow-y:auto + overscroll-behavior:contain); before, its gallery was unreachable until the whole
  page reached the bottom. Verified with real wheel scrolls: each column scrolls only under the mouse. The page had no [hidden] rule, so `el.hidden` silently did nothing where CSS set display - added one.
- AI Studio key field (Voice tab): core.set_key -> saveGeminiKey writes ~/.flow-mcp/gemini-key (0600) only after the
  key passes a format check AND Google accepts it (models list, key in a header, no TTS quota), so a bad paste can
  never replace a working key. set_key is deliberately NOT an MCP tool - a key typed into the panel never reaches
  Claude. Tested only on the rejection path, so the user's real key was never overwritten.
- Key format (2026-10-13): new Google AI Studio keys start "AQ" instead of "AIza", and saveGeminiKey's prefix check
  (^AIza...) refused them in the panel. It now checks only the shape (20-512 key characters, no spaces, no template
  text) and leaves validity to Google's own models-list check. Both requests send the key in the x-goog-api-key header,
  which is format-agnostic. Privacy scans before a push must look for AQ-style keys as well as AIza ones.
- CROSS-PLATFORM (2026-10-02): every OS difference lives in src/platform.ts - COMPUTER/BIN wording, moveToBin (Mac:
  rename into ~/.Trash; Windows: PowerShell Microsoft.VisualBasic ...SendToRecycleBin; Linux: `gio trash`, else
  ~/.local/share/Trash/files), extractZip (`tar` is bsdtar on macOS and Windows 10+ and reads ZIPs; `unzip` fallback),
  openUrl (open / cmd start / xdg-open), FFMPEG_HINT (brew / winget Gyan.FFmpeg / apt). Computer voices: `say` on a
  Mac; on Windows System.Speech through PowerShell, with the line passed via a file, never the command line. Chrome
  is looked for in Program Files, Program Files (x86) and %LOCALAPPDATA% too. discard's containment check uses
  path.relative, not "/" string tests (those refused everything on Windows). The panel words itself from
  voices().place (data-place spans + PLACE; Mac wording is the default, so a Mac is unchanged). Windows launcher:
  Flow Studio.cmd (CRLF kept by .gitattributes). Mac re-verified after the change: unzip of a real Flow ZIP, bin move
  plus three refusals, Mac wording, 9 voices listed, speech produced. The Windows branches have NOT run on a real PC.
- NEVER kill Claude Desktop's own flow-mcp process to load new code (did it 2026-10-01): Claude logs "Server
  disconnected" and does NOT restart it, so the app's flow connector stays dead until the user restarts Claude, and
  reconnect_session_connector cannot help (user-config servers are the user's to reconnect). Code sessions and the
  panel survive. To reload the PANEL only, restart the process that owns 8787 only when it is a standalone
  `node dist/studio.js`; if Claude's process owns it, the new code waits for the user's next Claude restart.
- Tile menus carry Material icon ligatures in their labels now ("downloadDownload"), but the accessible name still
  computes as "Download", so getByRole(..., { exact: true }) keeps working. Verified, not assumed.
- CHARACTER EDITOR (mapped 2026-10-02, editing Pip's coat to red): (1) the portrait's toolbar (`Download image`,
  `Delete image`) is `div.top-actions.hidden` - opacity 0, pointer-events none - until a REAL pointer moves over the
  picture, so a plain click times out on `img.preview-image`; savePortrait moves the mouse there first and downloads
  through the watched folders (the old `waitForEvent("download")` path is gone). (2) The editor ALWAYS draws 16:9
  (1376x768), whatever the portrait's shape: "make his coat red" turned a tall single Pip into THREE Pips side by side.
  editCharacter now appends "Exactly one <name> in the picture: never add copies...". (3) In its prompt box Ctrl/Cmd+A
  then Delete does nothing; Backspace clears. (4) `Format` is NOT an aspect setting: it replaces the prompt with a stock
  "studio shot of a person" template. (5) `Show history` lists every version with the prompt that made it.
  editCharacter presses Done on a leftover editor before starting (leaving any other way could drop a finished edit),
  never throws away a finished edit over a failed download (it returns a note), and with no `change` only re-saves the
  portrait. The stored look (characters.json) is quoted word for word in every scene's CHARACTER LOCK, so
  flow_character_edit takes `look` (the full new description); without it the change is appended "and this wins".
- ONE-MINUTE TOOL LIMIT: the desktop app's Code tab gives up on an MCP call after 60 s ("Request timed out", measured
  60.6 s on a character edit that went on to finish), and Codex does by default - while flow_wait defaulted to 240 s.
  That is every "Request timed out" in these sessions, and part of the 30-credit double spend. index.ts `patient()` now
  answers within 45 s (FLOW_MCP_PATIENCE_MS): a slower call returns `still_working` + `task_id`, keeps running, and
  flow_wait (job_ids may hold task ids) collects it; flow_wait itself returns within 40 s; flow_status lists
  `slow_calls`. Verified: a 3 s limit on flow_characters -> task id at 3.0 s, collected by flow_wait 1 s later.
- TESTING NEW CODE WITHOUT TOUCHING CLAUDE'S PROCESS: start `dist/index.js` from an MCP client script with
  FLOW_MCP_PORT=8799 and FLOW_MCP_HOME=<scratch dir>. Never reuse the real home for that: a process that owns a port
  writes a fresh token to HOME/token, which locks every client of the real owner out (401). Symlink characters.json into
  the scratch home when looks must persist. Give the client a 60 s request timeout so the app's limit is reproduced.
- FLOW IN ENGLISH (2026-10-13): every driver step finds a button by its ENGLISH accessible name (~45 labels), so a
  Google account set to another language made the whole MCP fail. Measured on a spare tab: `?hl=es` turned every label
  Spanish ("Inicio", "Menú para añadir contenido multimedia") on an English account, the choice holds through in-app
  navigation (grid -> /edit/ -> back), a plain reload drops it, and a Spanish Accept-Language changes nothing (the
  account's language wins over the browser's). So `?hl=en` overrides the account: launchChrome and getFlowPage load
  `inEnglish(url)`, ensureProjectGrid compares paths (an address ending ?hl=en is already the grid) and reloads with
  hl=en, and getFlowPage calls ensureEnglish, which reloads a non-English Flow page (`<html lang>`) and throws a clear
  message if it stays foreign. Verified: the Flow tab put into Spanish, then a free still through a test MCP ->
  switched to English, generated and downloaded (0 credits, 39 s).

- COMPACT STUDIO (2026-10-13, the user found it "too big and bulky"): one density pass over the CSS, same look (stripe,
  display font, orange tally, button styles). Floors kept on purpose: body and input text >= 16 px (iOS zooms into
  smaller inputs; the global mobile-first rule), buttons and segments >= 38-46 px tall. Title on one line, 12 px
  stripe, inputs 17 px with 10 px padding, labels 13 px, cards 14 px padding, headings 30 px, Roll bar 56 px. Pages
  are 23-35% shorter on a phone. It also fixed a sideways scroll: at 390 px wide the old page was 427 px (checked with
  a headless shot); every tab now fits at 375 px. Re-check with full-page headless shots per tab at 390 and 1440 wide
  and an overflow scan (elements whose right edge passes the viewport, tabs row excluded).
- GALLERY VIEWER (2026-10-13): Close and Move to Trash sat UNDER the media, and a tall clip (74vh) plus a wrapped path
  pushed them off screen. They are now a bar on top, and every clip and still plays in one fixed black frame
  (min(96dvh - 150px, 720px) tall, 960 px wide max, object-fit contain), so the viewer is the same size whatever is
  open. Dialogs were also stuck in the top-left corner: the `*{margin:0}` reset kills <dialog>'s centring, so dialog
  has margin:auto again. Close carries autofocus; showModal otherwise focused the red Trash button.
- AGENT BATCHES + THE LEFT-HAND MENU (2026-10-13). An 11-image flow_agent_images run in another session failed at
  once with "Could not switch Agent mode on" and made nothing. Flow was NOT redesigned (I first claimed it was; the
  user corrected me): the left "Project navigation" (All media, Images, Videos, Characters, Scenes, Uploads, Tools,
  Trash, Collapse) is where it always was. What was found, live:
  1. ESCAPE SHUTS THE LEFT MENU. It is a Material drawer (mat-sidenav), and Escape closes it whenever the keyboard focus
     is inside it. Clicking "All media" left the focus there, so the next dismissOverlays Escape shut the menu for the
     rest of the session (the user's menu vanished; traced with DEBUG=pw:api plus a second connection watching the
     menu). "All media" was then hidden and every later click on it waited out Playwright's 30 s default: a 3-image
     agent batch took 6.4 min. leaveSideMenu() blurs the focus after each menu click and before every dismissOverlays
     Escape. A page load restores the drawer to the saved state (localStorage flow-sidenav-collapsed, shared by every
     project in that Chrome).
  2. Collapse turns the menu into a strip of icons with no labels; getByText found nothing visible. clickProjectNav()
     matches the button by its text, which holds icon name and label in both states; openProjectNav() reloads once if
     the menu still is not showing. showAllMedia() falls back to the top bar's Filter menu (`Filtering and sorting
     options`: tick boxes, `Clear all filters`, Sort by Newest/Oldest) only when the menu cannot be used.
  3. The top bar also has a gear `Settings` ("View settings": Grid/Batch layout, tile size, toggles), so an unscoped
     getByRole("button", { name: "Settings" }) matched it AND the agent's Settings: strict-mode error. Scoped to
     `flow-base-prompt-box`.
  4. Some menus ignore Escape (the agent panel's model menu did) and leave `cdk-overlay-backdrop settings-menu-backdrop`
     over the page, swallowing every click, the Agent chip's included. dismissOverlays clicks showing backdrops away
     (closes the menu, picks nothing); setAgentMode clears them and closes the agent settings panel (`flow-agent-panel`
     -> `Back`; Escape does not close it, and while open it hides the Agent chip) before each try, and its error quotes
     what intercepted the click. If agent mode still cannot be used, every scene goes the one-by-one route.
  Progress names each step; FLOW_MCP_DEBUG=1 prints timed steps on stderr. Image models are now Nano Banana Pro,
  Nano Banana 2 Lite and Nano Banana 2.1 (all 0 credits at x1); plain "Nano Banana 2" is gone. The user's call: images
  ALWAYS default to the newest; newestNanoBanana() picks the highest version number that is not Lite from Flow's own
  menu, for image jobs with no model, "Nano Banana" or "Nano Banana 2", and for the agent's image default.
  Verified live, 0 credits: three 3-image batches (all from the agent, right order; 90 s each once All media stopped
  waiting, against 6.4 min), a batch with a scene forced missing (asked again, then one by one, composer moved from
  2 Lite to 2.1), and with the menu open and collapsed: flow_characters 6.6 s, flow_assets 5.6 s (was 15.5), the menu
  still open afterwards. Afterwards Flow had agent mode off, confirm back on Always, no backdrop, panel closed.
- RENAMED VIDEO NOT FOUND (2026-10-15, reported by a user of the public repo): "locator.waitFor: Timeout 30000ms
  exceeded ... flow-grid-tile-container[aria-label="<the prompt>"]". A video tile at rest has no media id, so TILE_ID_JS
  hands back "title:<Flow's title>"; runGeneration then renamed the tile to <project>-<stem> and asked downloadMedia
  for the OLD title, which no longer existed. The clip was finished and renamed in Flow (credits spent, file not
  downloaded). Now the handle follows the rename, and a tile that cannot be found again says so in words and points at
  flow_download. Not re-run on a paid clip yet; images are unaffected (they carry data-media-id).
  SAME USER, AFTER UPDATING (2026-10-16): "could not be found again in the grid (looked for "<the prompt>")". Watched
  live on a paid 4 s Omni clip (4 credits, user's OK), logging the top tile every second: 9 s titled with the PROMPT,
  no thumbnail, NO "NN%" yet; 12 s Flow's own short title ("Paper boat drifting across pond") and "0%"; 34 s "100%";
  35 s img[alt="Generated video thumbnail"]; 36 s the % gone. The old rule (no "NN%" = finished) took the tile in
  those first seconds, so the rename failed and the prompt-title then vanished. (The user guessed "after 100%"; it is
  the start.) freshMedia now counts a video tile without its thumbnail (or a <video>) as busy, and waitForNewMedia
  takes title-tracked tiles only once the same titles show on two polls running. Same clip with the fix: done in
  48 s, renamed SettleTest-scene-01, 4.0 s file downloaded.
- RETRY ONLY THE FAILED IMAGES (2026-10-18, the user's request). A batch that ends "done" with some scenes still
  failed (after the agent was asked again and the one-by-one route) now records job.failed_scenes (scene numbers).
  flow_retry on such a job queues a NEW agent batch of just those scenes with agent_numbers, so they save as scene-07,
  scene-12 (numberOf() in agentRound and the one-by-one fallback); the list moves to the new job so it is never retried
  twice. The Monitor shows "Retry N failed image(s)" on that batch (before, Retry only showed on failed jobs, and would
  have re-run the whole batch). The note now starts with "still failed: ..." (the panel clamps notes to two lines).
  Test hooks: FLOW_MCP_SIMULATE_MISSING=n drops scene n from agent rounds, FLOW_MCP_SIMULATE_FAILED=n skips its
  one-by-one rerun; neither applies to a retry batch. Verified live, 0 credits: 3 scenes with 2 forced to fail ->
  done with scene-01/03 and "still failed: scene 2", the panel button pressed in a headless panel -> only scene-02
  made -> folder 01, 02, 03; the button gone afterwards.
- TRASH GUARD WAS BLIND TO DUPLICATES: scanGrid keeps one entry per title, so trashAsset's "two items share this name"
  check never fired and it trashed one of several same-titled tiles. countTitled() counts copies by media id (images)
  and by how many show at once (id-less videos). Verified: three "Red fox sitting in snow" -> refused.
- BULK DOWNLOAD PACE (2026-10-19, the user's call: "trim down to random 4-4.4"). A 20-image agent batch took 231 s,
  113 s of it downloads at ~5.6 s each, all in the steps around Flow's tile menu (More options -> Download -> 1K
  Original size): a grid re-scan before every tile, hoverTile's fixed 900 ms, waitForDownloadedFile polling once a
  second (two equal sizes = 2 s minimum), and a fixed 800 ms after. Now: no re-scan when the tile is already mounted,
  a 250 ms hover then a wait for the More options button itself (locator.isVisible({ timeout }) does NOT wait - it
  answers at once), 250 ms polling, and each download held to a random 4-4.4 s (downloadPace). Measured on 6 images:
  4.2, 4.1, 4.2, 4.0, 4.4, 4.4 s, all 1024x1024 originals in scene order. Other hoverTile callers keep 900 ms.
- CAPTIONS (built 2026-10-08, `src/captions.ts`, Studio tab "Captions", MCP `flow_captions`): Homebrew's ffmpeg 8.1
  has NO text filters at all (no ass, subtitles, drawtext - no libass/freetype), so captions are drawn by headless
  Chrome (playwright-core `chromium.launch` on the system Chrome with a throwaway profile, never the Flow profile) as
  transparent full-frame PNGs, one per distinct caption state, played as an ffconcat image track with exact durations
  and `overlay`-ed onto the video (libx264 veryfast crf 18, AAC copied). Words come from whisper.cpp (`whisper-cli`,
  brew `whisper-cpp`) with `-ojf`: build words from TOKENS (leading space = new word), because `-ml 1 -sow` segments
  run each word into the next and hide every pause. Measured against the waveform: plain token offsets land within
  ~50 ms of the real word onset; `-dtw` (needs `-nfa`, else t_dtw is -1) was ~150 ms LATE; large-v3-turbo placed a
  word 0.6 s early and drops punctuation - so small.en > base.en > ... > turbo. 20 s of speech: 1 s to transcribe,
  ~0.3 s per preview, ~8 s to burn. Transcripts cache in ~/.flow-mcp/captions; the media route only serves
  OUTPUT_ROOT, uploads and that folder (previews 404'd until it was allowed). Edited text is re-timed by LCS against
  the heard words; a line break forces a new caption. Captions break at commas and sentence ends; `text-wrap:balance`
  stops a lone word on line two.
- TESTING THE PANEL without touching the real one or Flow: a script that sets FLOW_MCP_PORT=8799, FLOW_MCP_HOME and
  FLOW_MCP_OUTPUT to scratch dirs BEFORE dynamically importing dist/core.js + dist/server.js, overrides
  core.status/characters/assets (status -> getFlowState -> getBrowser LAUNCHES the Flow Chrome when CDP is down), then
  startServer(core); open http://127.0.0.1:8799 in the Browser pane. Kill the node pid itself afterwards - pkill on
  the background shell left it listening.
- Caption placement: `position` is bottom|middle|top or a number 0-100 (how far down the frame the caption's middle
  sits); the panel has an exact-height slider and tap-the-preview. Bold pop scales the spoken word by 1.06 - at 1.08
  with no word margin it swallowed the space beside it ("EVERYTHINGAFTER"), so words carry a .07em margin.
  First Ascent's finished film survived the Trash only because it was published in an artifact (film.mp4); it is back
  at ~/flow-mcp-out/Ascent/ascent-1080.mp4.
- Caption letters (2026-10-09): `letters` as_said | capitals | lowercase, per style in the panel (Bold pop defaults
  to capitals, the rest to as_said). It is a CSS text-transform on the drawn captions only; the .srt keeps the words as
  heard. capitals and lowercase drop trailing commas and full stops (? and ! stay), the short-form convention; capitals
  in a non-bold font take 1.2x the line width, lowercase in Arial Black 0.85x. Panel labels are "Normal / CAPS /
  lower" because "CAPITALS" and "lowercase" were cut off at 375 px wide.
- Speech model (2026-10-09, the user's call): it downloads BY ITSELF the first time words are needed - picking a video
  in the Captions tab, or the first flow_captions call - not from a button. ggml-base.en.bin, 148 MB, from
  huggingface ggerganov/whisper.cpp (FLOW_MCP_MODEL_URL for a mirror), into ~/.flow-mcp/models, via a .part file.
  It uses CURL, not fetch: Node's built-in fetch (undici) crashed the whole process with "assert(!this.paused)" when
  the server closed the connection mid-download, and that process is the panel or Claude's connector. caption_setup
  is "ready" once whisper-cli exists; the panel shows "Getting the speech model (148 MB, one time only)" while it
  downloads. Tested with a local stand-in server (HOME pointed at an empty folder): first use, two callers at once
  (one download), a second download in the same panel process, and an unreachable server (clear error, no leftovers).
  The real huggingface download has not been run from this code.
- Caption timing (2026-10-11, "words light up a bit late"): measured on the First Ascent narration against each word's
  real onset in the sound (words after a pause): whisper's token start was 0.00 s for about half and 0.13-0.18 s LATE
  for the rest (one outlier 0.53). AV sync tolerance is asymmetric (ITU-R BT.1359: a picture lagging its sound shows from
  ~45 ms, one leading it goes unnoticed to ~125 ms), so every caption state now starts LEAD = 0.12 s early (`lead`
  option, -0.5..0.5, MCP only). The .srt shifts with it (first cue 0.22 -> 0.10). Size is now a percentage too
  (`size` small|medium|large or 40-250; the panel has a 50-180 % slider; old saved presets map to 80/100/120).
- VOICEOVER IN THE USER'S OWN VOICE (2026-10-12): Flow's Voices tab holds only the 15 stock voices (the same as
  Google AI Studio's); the user's own voice comes with the "Me" avatar, and the only way to make it speak is a paid
  video take with reference_images ["asset:Me"] and the line in the prompt ("He says these exact words and nothing
  else: ..."), keeping just the sound (Omni 1.1 Flash 360p: 4/5/6/7 credits for 4/6/8/10 s). Flow cannot time speech
  to on-screen titles, so timing is local: flow_transcribe gives each word's start/end, and flow_assemble's
  voice_lines places each line (file, from, to, at, max_seconds -> atempo up to 1.25x, per-line loudnorm) at its own
  moment. The voice track is written as PCM WAV: AAC .m4a from delayed+mixed lines was unreadable ("Cannot calculate
  dts entry length"), and whisper-cli exits 0 and writes no JSON on unreadable audio, so transcribe now checks for it.
  Cut lines at the gap between words (midpoint), not word end + padding: padding pulled the next word's start in.
- CAPTION LANGUAGES (2026-10-13): the auto-downloaded model was English-only (base.en) and "auto" picked it, so a
  Spanish video got English-sounding nonsense with no error ("(speaking in foreign language)" at best). Now three
  models, each fetched on first need (FLOW_MCP_MODEL_BASE = mirror folder): base.en 148 MB for English (best timing;
  English fetches it even when a multilingual model exists, falling back to that one only if the download fails),
  large-v3-turbo-q5_0 574 MB for every other language, and base-q5_1 60 MB that only DETECTS the language for "auto"
  (whisper-cli -dl; the line "auto-detected language: xx" is on stderr and -np hides it). Measured on Mac `say` lines:
  turbo heard every Spanish/German word where small-q5_1 (190 MB) misheard "ni un solo" -> "guión solo"; word starts
  of both were within ~0.05 s of the waveform for most words; base-q5_1 detected 8/8 languages in 0.2 s. Detection
  runs once per video ("auto" has its own cache entry). UNSPACED languages (ja, zh, yue, th...) get words from
  Intl.Segmenter over a per-character timeline built from the tokens (tokens there are word pieces: 人/工/知/能), are
  joined with no space, hold 3x the words per caption and count as full-width; edited text is segmented the same way
  so alignText still matches. <html lang> is set so capitals follow the language (Turkish BİRLİKTE), RTL scripts get
  dir=rtl (checked with Arabic text: order and highlight right). The panel has a "Spoken language" select (37 languages
  + Detect automatically), defaulting to the browser's language when listed, else English; changing it re-listens and
  drops corrections. The panel read transcribe's `words` (now an array since flow_transcribe) as the word count; it
  now asks words:false and shows word_count.
- NAMES IN LOWERCASE CAPTIONS (2026-10-18, the user's rule: "always capitalize names even if lower case selected").
  namesIn(): a word written with a capital where no sentence starts (the speech model and corrections capitalise
  names), every other occurrence of it, plus `names` passed in (for a name that only ever starts sentences, "Juno");
  "I" is not a name. The page marks those words `.w.name{text-transform:none}`. Checked on Sol Tomorrow, boxed
  lowercase: "Sol said the same word every morning", "he just went". TRAP: the page script lives inside a TS template
  literal, so a regex there needs `\\p{L}` in the source - with `\p{L}` the page got `p{L}`, matched nothing, and
  the name stayed lowercase without any error.
- CAPTIONS WORKFLOW (the user's rule, 2026-10-18): transcribe first, show the words with likely mishearings fixed,
  get the user's OK, THEN make the video once. The playbook and the flow_captions description say so too.

- KOKORO (2026-10-29, the user's call: the default narration voice). `engine: "kokoro"` is now flow_narrate's default
  (then gemini, mac). It runs through kokoro-js (npm, so `npm install` is the whole setup on Mac and PC, no Python) in
  its OWN process, dist/kokoro-worker.js, so the 326 MB model and Hugging Face's fetch-based download never live in the
  panel or Claude's connector. The model downloads itself on first use into ~/.flow-mcp/models/kokoro (measured 17 s
  to 93 s); a take after that is ~2 s, 36 s of speech in 8 s. Takes run one at a time. Kokoro reads at most 510 phoneme
  tokens per pass and silently drops the rest, so the worker splits sentences into <=300-character chunks; each pass
  also opens with ~0.45 s of silence (joins measured 1.1 s), so every chunk is trimmed to its speech and joined with a
  0.4 s pause. A 538-character line checked with whisper: every word present, pauses 0.26-0.67 s. 28 English voices,
  graded on the model card (af_heart A, af_bella A-; the user's pick am_michael C+, the default), `speed` 0.5-2 (panel
  slider 0.70-1.30). When Google's daily limit answers 429/quota, a gemini take is recorded with Kokoro and the result
  carries `fell_back_from` + a note - that fallback is NOT tested against a real exhausted key yet. Voice tab: Kokoro |
  Google AI Studio, each engine keeps its own voice pick (S.narrate.kokoroVoice / geminiVoice).
- COMPUTER VOICES REMOVED (2026-10-29, the user's call): the `mac` engine (`say` on a Mac, System.Speech on Windows),
  localVoices and speakLocally are gone; narration is kokoro | gemini only. A panel that saved engine "mac" switches
  to Kokoro. Kokoro was kept local at first; the user cleared it for GitHub on 2026-11-07.
- NARRATION RUNS IN THE CALLER (2026-10-29): voices/narrate are module functions (voicesHere, narrateHere) used by
  LocalCore AND RemoteCore, because they never touch Chrome. Claude Desktop's own flow-mcp often owns 8787 with code a
  release behind (the user cannot always restart), and a client forwarding narrate to it got the old engine list.
  Verified: a fresh client process recorded a Kokoro line while the stale owner (pid unchanged) kept 8787. The panel
  page itself is read from disk on every request, so after a build the PANEL is new while its API is the owner's: the
  Voice tab stays broken until the owner restarts. story_pitches (playbook) is served by the caller's index.ts too.
- FIRST FRAME FROM A CLIP (2026-10-29): flow_generate's `first_frame` may be a finished .mp4; the queue swaps in its
  last frame (extractLastFrame), i.e. chain_previous across separate calls, so each clip can be reviewed before the
  next is paid for. Made for The Last Slice (3 x 10 s Omni 1.1 Flash 720p = 45 credits, every join invisible).
- CAPTIONS FROM THE CLEAN NARRATION (2026-10-29, captions came out "off" on The Last Slice): transcribing the MIXED
  film (narration + the clips' crashes at 30%) made whisper squeeze the first five words after each pause onto one
  instant (10.18 s, zero length) and drop all punctuation, so the panel's captions ran up to 1.5 s early. flow_assemble
  keeps the narration as <film>-voice.wav on the film's timeline (it can be shorter than the film); transcribe now
  hears that instead. Even the clean track squeezed words after long silences ("Why risk it all for one" at 20.24 s),
  so its spoken stretches (silencedetect -40 dB, >= 0.6 s) are each heard separately and shifted back. Measured against
  the known narration times: Tonight 10.41 (true 10.42), Why 20.42 (20.42), waiting 27.03 (27.0), punctuation back.
  Cache key carries the voice track + "spans". Transcribe/captions now also run in the CALLER like narration.
- CAPTIONS ON DIALOGUE (2026-10-30, First Lesson: two people talking in a car, no narration track): heard whole, the
  engine noise made whisper put "See?" 0.5 s and "You were braver" 0.9 s early. Every non-clean track is now cut into
  speech stretches by whisper.cpp's own detector, `whisper-vad-speech-segments` (ships with brew whisper-cpp; model
  ggml-silero-v5.1.2.bin, 0.9 MB, fetched on first use from huggingface ggml-org/whisper-vad), each heard on its own,
  and no word may start before its stretch's detected onset (whisper liked to start the first word at the window's
  edge, 0.3 s early). whisper-cli's own --vad is NOT usable for this: its token times are on the squeezed timeline and
  its segments run on through seconds of noise. The detector's list comes out once (stdout or stderr) in centiseconds.
  A first stretch within 2 s of the start is opened to 0:00 with no floor ("Dad!" over the stall noise was missed).
  Measured against the loudness (-40 -> -20 dB jumps): See? 15.39, Don't 18.27, You 23.78, all exact; The Last Slice
  (clean track, silencedetect path) unchanged. Cache tag "spans-v5".
- LAST FRAME FROM A CLIP (2026-10-30): flow_generate's `last_frame` may be a finished .mp4; the queue swaps in its
  FIRST frame (extractFirstFrame in chain.ts). With first_frame = the clip before and last_frame = the clip after, a
  middle clip is redone with both cuts invisible (Midnight clip 2: Flow had dissolved from the gears to the clock face;
  the redo is one move down, and its last frame matched clip 3's first exactly).
- CORRECTED WORDS TAKE THE MISHEARD WORD'S TIME (2026-10-30, Midnight): alignText spread an unmatched corrected word
  over the whole gap between its matched neighbours, so "Pim" (heard "Pym") started right after the previous line,
  4.6 s early. Now the heard words in the same gap are used: equal counts map one to one ("Pym"->"Pim", "12"->"twelve"),
  otherwise the corrected words share the heard words' stretch. Checked: "Pim found the" 10.30 s (line placed at 10.5).
- ALIGNMENT, TWO MORE CASES (2026-10-30, Last Train dialogue): (1) a word the listener missed entirely ("That" in
  "That was the 949") sat at the start of the pause before it (2 s early); now it goes just before the next word, 0.3 s
  per word. (2) whisper prints a speaker-change dash as its own token; pairing "fifty" with "-" made a zero-length
  caption. Only tokens with letters or digits count when corrected words borrow heard times.
- OPENING STRETCH (2026-10-30, Last Train: footsteps for 1.3 s before the first line): opening the first stretch to
  0:00 with no floor bunched Theo's whole line at 0:00. It now starts 0.2 s before the first loud spike (18 dB over the
  quietest fifth of the track, or the detector's onset if earlier), which is also its floor. Checked: Last Train
  "You" 1.26 / "fifteen" 1.98 (speech 1.3-3.0), First Lesson "Dad!" 0.53 (spike 0.55). Cache tag "spans-v7".
- NEW PROJECT, TRIMS, END CARD (2026-10-30, for a UGC ad shot from scratch): `flow_new_project` (createProject in
  flow.ts) - Flow's home page has one button "New project" (getByRole button /new project/i, mapped live), which opens
  /project/<uuid>; the project's name is the textbox "Editable text" on the project page, filled + Enter. Not yet run
  live (its first run was meant to be on camera). flow_assemble got `trims` (one {from,to}|null per clip, applied as
  input -ss/-t, clamped to the clip) and `end_card` {text, seconds}: renderEndCard (captions.ts, the captions' headless
  Chrome) draws big centred words (12% of the frame's short side, 8.5% past 40 characters) over the last kept frame,
  blurred 28 px at 42% brightness, saved as <name>-endcard.mp4 with silent audio and joined like a clip. Tested on
  Last Train: trims [{from:1}, null, {to:8}] + a 2.5 s card -> 29.55 s, 4.7 s to make.
- SETTINGS POPOVER CLOSED BY THE MODEL MENU'S ESCAPE (2026-10-30, first image in a brand-new project): the project
  already sat on the newest Nano Banana, so pickModel closed its menu with Escape - which also closed the settings
  popover, and the next pickRadio failed with 'Flow has no "x2" option'. pickRadio now reopens the popover
  (openSettings) before giving up. Until the owner process reloads, naming the model ("Nano Banana 2.1") avoids it.
- FIRST FRAME AT A CHOSEN SECOND (2026-10-30, KOVA bottle ad: clip 1's speech ended at 6.5 s, then 3 s of nodding):
  flow_generate's `first_frame_at` (seconds) with a clip as first_frame starts the next clip from that frame instead of
  the last (extractFrameAt in chain.ts); flow_assemble's `trims` cuts the earlier clip at the same second, so the join
  stays invisible with no editor. The user's line for the video: "Flow MCP cuts it for you." Also: size clips to their
  words (Omni 4/6/8/10 s) instead of always 10 s.
- PRODUCT FLIPS MORPH (2026-10-30, KOVA clip 2, 10 credits): "turn the bottle upside down, shake, turn it upright" came back
  with the lid jumping to the other end of the bottle around 4.3 s, while the first and last frames looked perfect, so a
  start/end check missed it. A symmetric object turned end over end loses its ends. The playbook now says: keep a
  product's orientation fixed, and check every 1/8 s of motion before showing a clip.
- B-ROLL INSERTS + OUTFIT (2026-10-30, matcha UGC ad, the structure the user took from ChatGPT: talk / product shot /
  talk). flow_assemble `inserts` [{clip, over, at, seconds, from, volume}] lays a cutaway's picture over part of a clip
  while that clip's own sound keeps playing: the line "Strawberry, milk, and matcha..." from clip 3 plays over the drink
  close-up and the picture cuts back to her on "Would you try it", in sync. voice_lines was wrong for this: it levels
  each line to -16 LUFS while Flow takes sit near -24, an 8 dB jump. flow_generate `outfit` (per scene) keeps the
  character lock on face/hair/build but takes the clothes from the scene; without it the lock's saved look (Skye's
  denim shirt) fights a costume (cream sweatshirt). Both need the owner process restarted; this ad was cut by running
  dist/assemble.js directly. Talking clips: R2V with ["asset:Skye", the car still] (her saved voice Aoede in both);
  product shot: I2V from a free still. 3 clips, 40 credits, every clip right first time.
- MATCHA AD V2 + LOUDNESS (2026-10-30): flow_assemble `loudness` (LUFS, -30..-9) runs loudnorm on the finished mix;
  Flow takes sit near -24 LUFS, quiet on a phone, so ads go out at -14. "Too static, like a robot" was fixed with a
  hand-held selfie take (her arm runs out of frame, gentle sway) and one simple action with the product already in
  hand (one sip through a straw), plus a hand-held arc on the B-roll instead of a locked-off cup. Both passed the 1/8 s
  check first time (22 credits). Flow's "Add AI credits" banner (low balance) also ends in "credits": the quote is now
  read from a link named "<N> credits" only. A take can open on a stray half-word (heard as "suffix"): listen to the
  first second of every take and trim it.
- SIP CLIPS + REPEATED LINES (2026-10-30, matcha v3, 12 credits): with a CLEAR straw the model never moved liquid up it
  ("when she drinks nothing going up on the straw"); the redo used an opaque pink paper straw, in the free still first
  and then in the prompt, and passed the 1/8 s check. The take then said "Would you try?" and then the whole line
  ("Would you try it, or stick to coffee?"). Cut the repeat with no new code: list the clip TWICE in flow_assemble's
  `clips` with two `trims` that skip the first attempt, cutting in the quiet gaps (token times + 50 ms RMS). Same pose on
  both sides, so the jump is barely visible. Transcribe EVERY take with token times before showing it.
  The first v3 cut was wrong at the clip 2 -> 3 join (the user heard it): scene-10 opens on a stray syllable
  (0.05-0.35 s, heard as "This.") and I cut at 0.3, leaving its tail on the cut; and that take's room noise sat 8 dB
  above clip 2's, so the background jumped. trims entries now take `volume` (0-2), `fade_in`, `fade_out`, and every
  trimmed edge gets a 15 ms fade so a cut never clicks. Fixed with from 0.45, volume 0.4 on the sip stretch: the level
  is -38 on both sides of the cut. Check 50 ms RMS ACROSS every join, not just the words.
  Then an "s" was still audible (the user again): plain RMS hid it under the room noise. Above 4 kHz
  (highpass=f=4000 twice, 20 ms RMS) it stood out: -31 dB at 0.40-0.56 s of the take against -89 around it, plus a
  40 ms tick at 3.46. Cut points moved to 0.6 / 3.44 / 4.44; every join now reads -82 dB or lower in that band. Check
  the HISS BAND across every join too, not only loudness and words.
- CHARACTER FROM A PICTURE KEPT A STALE LOOK (2026-10-30, protein soda ad): characters.json is keyed by name and only
  `describe` wrote it, so a new "Maya" made from the user's photo would have been locked to an OLD Maya description
  (ponytail, mustard sweater) in every scene. flow_character now takes `look` (the picture in words) with `image`, and
  without it drops any older description under that name (forgetCharacter). Needs the owner restart; until then the
  look was written with dist/flow.js rememberCharacter directly.
- "PROMINENT PEOPLE" REFUSAL (2026-10-30, protein soda clip 1): a character made from the USER'S UPLOADED PHOTO made
  free stills fine, but every VIDEO with it failed: the tile said "This prompt might violate our policies about
  generating prominent people" (refunded, 61 credits kept). The queue only reported a generic "failed" and pressed
  Flow's Retry, which cannot help. waitForNewMedia now reads `.error-message-text` (errorReason; checked on the live
  tile), never retries a policy refusal, and says in Flow's words what happened plus what to do: draw the character
  from a description instead. Never try to get the same face past the filter.
- NO SUBTITLES BY DEFAULT (2026-10-30, the user's rule: "it should be default for you to tell flow never to generate
  subtitles"). Omni burned garbled captions ("thyel", "voch", "roil") into 0.8-4.9 s of a 15-credit talking clip, though
  the prompt said "No text, captions or subtitles" near its end. core.generate now opens AND closes every video prompt
  with a no-subtitles/no-text clause; `on_screen_text: true` on a scene turns it off (a sign, a title card). Checked by
  building prompts with a stubbed queue. Captions are made afterwards with flow_captions, where the words are checked.
- PHONE IN THE SHOT + CROP (2026-10-30, protein soda clip 3, 12 credits, only 9 left so no redo): the prompt said "the
  phone is propped upright ... she is never holding the phone", and Omni drew a second iPhone on a stand in the
  bottom-left corner for the whole clip. Naming an object, even to rule it out, can put it in the picture: describe the
  camera ("a fixed camera at her eye level, about 70 cm away") and never mention the phone. flow_assemble `trims`
  entries now take `crop` {x, y, w, h?} (fractions; h defaults to w so the shape holds): {x:0, y:0, w:0.78} punched in
  1.28x and dropped the corner; checked at 2 frames a second along the bottom edge, nothing left. The punch-in sits
  right after the can cutaway, where an editor would put one anyway. Ad: protein-soda-ad.mp4, 16.4 s, -13.1 LUFS.
- REFRAMING SOMEONE ELSE'S EXPORT (2026-10-30): the user cut the ad in another Google tool and got a 1920x1080 file with
  the vertical picture in the middle (x 656-1263), white bars both sides, a soft subtitle track, and Gemini's sparkle
  mark in the picture's bottom-right corner. flow_assemble now sizes a cropped clip by what it KEEPS (it used to size the
  film by the landscape canvas), crop fractions go down to 0.1, and `size` ("1080x1920") sets the master. One clip with
  crop {x:0.3638, y:0, w:0.2724, h:0.8602} -> 1080x1920, bars and mark gone (corner checked once a second), subtitle
  track dropped, -13.9 LUFS. Voice check by median pitch (numpy autocorrelation): Flow's Callirrhoe takes ~215 Hz, that
  tool's takes ~230 Hz on both talking clips, so its voice is consistent within itself but not Flow's.
- CAPTION CORRECTIONS SPLITTING A WORD WERE IGNORED (2026-10-30, matcha ad): whisper heard "your iced" as "youriced"; the
  corrected text was compared with the transcript with every space removed, so "your iced" == "youriced" and the
  correction was dropped as "no change". timedWords now compares word by word (space-free only for unspaced languages).
  Also, burnCaptions/previewCaptions called directly with no `size`/`position` drew tiny serif captions (no font size
  on the page): they now default to medium/bottom themselves. Both need the owner restart; the matcha captions were
  made by running dist/captions.js directly. Two looks for the two ads, the user's call: soda = bold, lime #B8E62E;
  matcha = highlight, strawberry #F2557E.
- HITCH AT EVERY JOIN (2026-10-31, the user saw it at 47-48 s of Three Tiers): AI clips carry 0.03-0.05 s more sound
  than picture, and the concat filter pads the shorter picture with repeated frames, so each cut froze for a frame or
  two (found at 37.79/38.00/48.04 s by frame differences < 0.2). assemble's probe now takes the VIDEO stream's duration
  and trims every clip's sound to it (atrim=end). Checked: the same three clips -> no frozen frames, cuts exactly at
  37.75 and 47.75, picture and sound both 57.75 s. When joining by hand, trim the audio to the picture the same way.
- SHARPNESS SNAP AT A CONTINUATION (2026-10-31, "a skip frame" at 47.75 s of Three Tiers): a clip animated from the
  previous clip's exact last frame matched it in position, zoom and colour, but Omni clips soften over their 10 s
  while the continuation is drawn from a crisp still: detail jumped 190 -> 330 (Laplacian variance) in one frame.
  flow_assemble `trims[i].soften_in` (seconds) measures both sides, picks the gblur sigma that matches the earlier
  clip's end (0.6 here) and fades that blur out over the given time: the curve now runs 1895 -> 1779 -> 1701, no step.
  Tried and REJECTED: dissolving from the frozen last frame (stalls the motion for two frames: a hitch of its own) and
  a 3-frame crossfade of the moving tails (ghosted both faces into double images). The remaining tiny jump is the
  model redrawing the frame; only a new clip can remove it.
- LOUDNESS LANDS ON TARGET (2026-10-31): flow_assemble's single loudnorm pass is held back by its -1.5 dBTP ceiling
  (Three Tiers: asked -14, got -14.9; the ads earlier came out -13.1/-13.9). It now measures the finished film and, when
  more than 0.3 LU off, corrects with plain gain + alimiter (limit 0.84) on a video-copy remux; the result carries
  `loudness`. Three Tiers: -14.1 LUFS, true peak -1.4 dBTP.
- CONTINUATION CAMERA (2026-10-31, Three Tiers clip 6, five takes): a clip animated from the previous clip's last frame
  must keep the camera moving the SAME WAY. Clip 5 ended drifting slowly backwards; takes that pushed in (or pulled
  back to make room for a dismount) read as a "skip" at the join even with matching frames. Measure the drift on both
  sides (best-fit scale of the top band between frames 12 apart: s>1 = moving back) and name it in the prompt ("keeps
  drifting very slowly backwards, exactly as it already is; never moves toward them"). A whisper slice that cuts a
  line's first word in half invents words ("Told" -> "Totally"): it is not a false start.
- WATERMARK (2026-10-31, the user asked): Google's video models (Vids, Flow) put a four-point sparkle, 71 px at
  1080p, in the bottom-right corner (centre ~1740,900). flow_assemble `remove_watermark: true` finds it without being
  told where: frames sampled across every clip at film size (1.5 per second), each pixel's 5th-percentile value, points
  45+ brighter than their 31x31 neighbourhood, the densest 100 px window = the mark (a white wall shared by clips also
  passes, so never take the bbox of all hits). Its centre is see-through and barely stands out, so the mask is a filled
  astroid around that box (P5 PGM), painted out with `removelogo` on the joined picture. Three Tiers: box 1704-1775 x
  864-935, corner shows plain cobbles at 5 moments. With 32 samples only the bottom half registered: keep the sample
  count up. The invisible SynthID mark stays; platforms still expect an AI-content label.
- WATERMARK ON VERTICAL FILMS (2026-11-01, Glow UGC): watermarkMask scaled its search window by height / 1080, so a 1080x1920
  film got a 178 px window, spurious bright points widened the box to 125x93, and a corner of the sparkle stayed visible
  while the tool reported "painted out". Scale is now by the short side: box 864-935 x 1704-1776, the same 71 px mark.
  Always look at the corner after painting; the returned message only says a mask was made. Faint smudges remain where
  the mark crossed sharp edges.
- MUSIC UNDER A VOICE + THICK WATERMARK (2026-11-01, The Last Delivery): flow_assemble `duck_music` pulls the music down with sidechaincompress while the voice
  speaks, and `music_curve` [{at, volume}] shapes it over the film (straight lines, volume expression with eval=frame). A long Extend chain redraws
  Google's sparkle each hop, so by clip 8 it had a black outline and a fatter diamond that the star mask missed while the tool still said "painted out"
  (outline visible at 72 and 88 s). `watermark_margin` (10 here) grows the mask and makes it a diamond: no outline, a soft smudge remains on hard texture.
  `end_hold` {seconds, fade} holds the last frame and fades the picture to black (music_curve fades the sound with it). Checked on The Last Delivery: 103.75 s, -14.4 LUFS.
  The speech check hears "deliveries stopped" as "delivery stopped" on both Tyra and Kokoro: it is the listener, not the voice. Pass the real words as `text` to burnCaptions.


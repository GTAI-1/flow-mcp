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
- CHARACTER VOICES (2026-10-19, built after a user asked for it; verified live on the VegetableVideo project): the voice
  shows in the character editor as a button NAMED after it ("orus", "achird" ...) right before `Play preview` and `Remove`;
  a character without one shows `Select a voice` instead. Both open the same dialog (listbox "Asset list" of stock voices,
  `Search assets` box reaches voices below the first 15, `Add to character`, `Close`). New tools/params: `flow_characters`
  now returns each character's voice read live (`with_voices`, default true, ~8 s per character: each editor is opened);
  `flow_character_edit` takes `voice` or `voice_from` (a voice-only call skips the portrait redraw); `flow_character` takes
  `voice_from` for copies/outfit variants, and reports the voice the character ended up with (Flow sometimes assigns one
  itself) or a note when it has none. The choice is also kept in `<HOME>/voices.json` (name -> voice) beside characters.json.
  Everything lives in flow.ts: voices.json helpers, openCharacter, readVoice, pickVoice, setCharacterVoice, characterVoices.
  BUG FOUND AND FIXED the same day: `locator("flow-character-tile").filter({ hasText: name })` is a SUBSTRING match, so
  "Ollie" opened "Ollie_Village" (tile textContent is "<name>accessibility_newfavoritemore_vert", no space). characterTile()
  now matches the name followed by the icon text or the end; editCharacter uses it too. Both Ollie copies were given the
  original's voice (achird) with it. A running Claude Desktop flow-mcp process keeps the OLD code until the user restarts Claude.
- AGENT BATCHES WITH CHARACTERS (2026-10-19): the user ran Flow's Agent mode with a character attached (via `+` or `@`)
  and a one-prompt 20-scene script: all 20 images came back with the character identical. `flow_agent_images` now takes
  `characters` (up to 3 names, attached as chips through the same `+` picker as flow_continue: attachAsset on
  `Add ingredients to the prompt box`, Characters appear as "<name> Character" options) and `style` (a global directive
  sent once). agentRound attaches AFTER `Clear prompt` every round (Clear drops the chips) and adds a sentence telling
  the agent the attached characters are the exact look; the one-by-one fallback passes them as `asset:<name>` references.
  The attach is retried 3x with Escape in between. (The first live failure looked like a timing problem; it was really the
  WRONG PROJECT being open - that project had other characters. flow_status now shows the open project's title.) Verified live: 3 scenes with Spuddy + Ollie_Village
  -> all 3 from the agent, both characters on-model in every frame, 165 s end to end, 0 credits. Still not possible in the
  agent route: reference PLATES (only characters/ingredients you attach; max 3). Describe the location in the scene text.
- PROJECTS, SEARCH-TRASH, IMAGE REFERENCES (2026-10-19, all verified live, user-directed):
  1. Everything is per PROJECT (characters, assets, trash), so a "character not found" usually means the wrong project is open.
     `flow_status` shows `project` (the title from the h1). New `flow_projects` (lists the home page's projects, read in a
     spare tab: each is `a[href*="/project/<uuid>"]` followed by the title; the card also holds `Delete project`, never touched)
     and `flow_open_project` (title or link, requires `user_confirmed: true` = the user said which project in chat; never
     creates or deletes). Verified: switched to "Batch image generation test" and back.
  2. `trashAsset` no longer scans the virtual grid (it timed out whole batches). It opens the Images tab, types the title in the
     top-bar `Search` box, waits until every visible tile matches, acts on the single exact match (a name cut off with "…"
     matches by prefix; two matches are refused), then clears the search. THE TOP BAR GOES visibility:hidden WHEN THE GRID IS
     SCROLLED, so searchProject scrolls to the top until the box is visible (the user's fix; before it, search "did not work").
  3. The asset picker (`+` / ingredients) lists only the first (newest) options, so a location plate or older still further down
     was not clickable: attaching plates failed in agent AND normal mode. attachAsset now clears the picker's `Search assets` box
     and searches by name before falling back to the tabs.
  4. `flow_agent_images` `references` (max 8 image titles; plates, start-frame stills) are attached next to the characters.
     The agent has no Start-frame slot, so each scene's text must say "location: <title>" or "start frame: <title>"; a generic
     sentence in the ask explains that. Verified: 2 characters + 2 plates + 1 start frame, 3 scenes, all from the agent in 172 s,
     plates and the start frame's composition honoured, characters on-model (a character can still come out small in a wide shot).
     Not done: Ctrl+click multi-select in the picker (the user offered it); one image at a time + `Add to prompt` is used.
- DOWNLOAD FOLDERS (2026-10-19, user-directed): (1) Chrome's default download folder for this profile is the normal Downloads
  (USER_DOWNLOAD_DIR in chrome.ts, env FLOW_MCP_USER_DOWNLOADS; the profile's Preferences are patched right before each
  Chrome LAUNCH, since Chrome rewrites that file on exit). (2) The tools' own downloads go through the hidden
  `<HOME>/downloads` folder (Browser.setDownloadBehavior allowAndName = random uuid names, no extension) and are renamed
  into the project folders. That override is Chrome-wide and OUTLIVES the CDP session, so it used to stay on and a download
  the user made by hand in that Chrome "happened" but landed there under a uuid name. Now every tool download ends with
  `setDownloadBehavior default` (visibleDownloadsAgain). (3) All three folders (hidden, Chrome's Downloads, the user's) are
  watched for the new file, and moveFile() copies + deletes when rename fails across drives (EXDEV: Downloads on C:, project
  folders on another drive; first seen 2026-10-19). Leftover uuid files in `<HOME>/downloads` are safe to delete any time.
  Test scripts: use forward slashes in target paths (backslashes got eaten by the shell).
- The tool folder is not tied to any one project: flow-mcp is used from many working folders. Project knowledge lives here and in
  the user's global notes, not in a single project's memory.
- DOWNLOADS, SECOND PASS (2026-10-19, user-directed; supersedes the allowAndName routing above): the tool's own downloads used
  `allowAndName`, so Chrome's download list showed random-ID entries nobody could open (and renaming the files afterwards
  breaks the list's link anyway). Now: `useOwnDownloadDir(page, dir)` sets `Browser.setDownloadBehavior allow` into the PROJECT
  folder, Chrome keeps Flow's real name ("<title>_<timestamp>.<ext>"), and the file is NOT renamed or moved (inFolder() only
  moves a file that landed in the wrong folder, keeping its name). Consequence: outputs are named by Flow's title, no longer
  scene-NN.ext / clip-NN.ext (flow_assemble's default clip pick falls back to every mp4 in the folder). The output root defaults to
  `~/Downloads/flow-mcp-out` (OUTPUT_ROOT in chrome.ts, env FLOW_MCP_OUTPUT, set in ~/.claude.json). Verified: image + video
  downloads landed there with real names, hidden `<HOME>/downloads` stayed empty. After every download the override is reset to
  `default`, so manual downloads in that Chrome go to Downloads with real names. NOT understood: the user reported a manual
  right-click download "cannot be opened from the browser" (only from the Downloads folder); needs their error message.

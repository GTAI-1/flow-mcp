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
The preview tool cannot read ~/Desktop; check the Studio UI with headless Chrome screenshots instead.

## More UI map (2026-09-19)

- Ingredients picker (`Add ingredients to the prompt box`): tabs All/Images/Videos/Voices/Characters/Avatars/Uploads,
  `Upload media`, listbox `Asset list` with options named "<name> Image|Video|Avatar"; clicking only previews
  (videos get Trim start/end sliders) and `Add to prompt` attaches. Frame pickers (`Start`/`End`) attach on click.
- Characters: left-nav `Characters` → with none yet opens `/character` (describe + Nano Banana 2, `Upload`,
  `Add from project` → dialog `Select media` → option → `Add media`). That creates `/character/<uuid>` with
  textbox `Character name`, `Select a voice`, `Character personality`, `Reroll`, `Portrait`, `Create body`, `Done editing`.
  Afterwards the composer shows the character as a chip. A test character "zz-test-bicycle…" exists in the mapping project.
- Scenes nav is just a filter; scenes are made via tile menu `Add to scene` / Add media → `New scene`. Assembly is done locally (flow_assemble) instead.
- Edit composer shows no credit quote before starting, so `max_credits` cannot be enforced for edits; cost must be measured with one paid run before building `flow_edit`.
- Edit run (paid, 2026-09-19): in `/edit/<uuid>` type into the last `.ProseMirror`, `Start generation`; progress shows as
  "NN% <prompt>" text in the view and vanishes when done (~80 s for 4 s); URL does not change; the result is a NEW video
  tile at the top of the grid with the same title as the source. No credit quote is shown anywhere beforehand.
- Voice picker: `Select a voice` → dialog with listbox options "<Name> <description>" → `Add to character`. Filling
  "Customize performance" switches the dialog to generating/saving a new voice (`Preview`, `Save new voice`), so the tool uses stock voices only.
- Characters view lists `New character`, the user's own "Me" avatar and characters. Test characters left in the mapping
  project: "zz-test-bicycle…", "zz-test-voice…", and "Mina the barista" (accidentally built from the clapperboard image).
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

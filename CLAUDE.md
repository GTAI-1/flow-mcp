# flow-mcp

Local MCP server (stdio, TypeScript) that drives Google Flow in a dedicated Chrome profile over CDP
(`playwright-core`, `connectOverCDP` on port 9333). No extension. Goal: feature parity with
OmniFlow (lingoflow.pro/omniflow), using subscription credits instead of the API.

- `src/chrome.ts` launch/attach Chrome · `src/flow.ts` UI driver · `src/queue.ts` paced job queue
- `src/index.ts` MCP tools · `src/chain.ts` ffmpeg last-frame · `src/playbook.ts` guidance returned by `flow_status`
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

Verified end to end: image generation, text→video, first+last-frame video, upload, download, credit guard, pacing.
Written but untested: `reference_images` (ingredients picker), `chain_previous` (ffmpeg part tested), variants > 1.
Not built: `flow_edit`, scene/timeline stitching, characters (@name), library asset reuse, 1080p upscale download, local Studio UI.

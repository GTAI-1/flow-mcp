# flow-mcp

Local MCP server that drives Google Flow (flow.google.com) in a dedicated Chrome profile, so
generations run on your Google AI subscription credits instead of the paid API. No extension.

```
Claude ──stdio──> flow-mcp ──CDP──> Chrome (own profile, ~/.flow-mcp/chrome-profile) ──> Flow
```

## Setup

```bash
npm install && npm run build
npm run login   # opens the dedicated Chrome; sign in to Google and open a Flow project
```

Claude Code:

```bash
claude mcp add flow -- node /ABSOLUTE/PATH/flow-mcp/dist/index.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "flow": { "command": "node", "args": ["/ABSOLUTE/PATH/flow-mcp/dist/index.js"] } } }
```

## Tools

| Tool | Purpose |
|---|---|
| `flow_status` | Session state (signed in, project open, plan, credits left), queue, pacing, prompt playbook |
| `flow_generate` | Queue scenes: prompt, type (video/image), model, aspect, duration, resolution, variants, first/last frame, reference images, `max_credits` cap |
| `flow_wait` | Block until jobs finish; returns file paths |
| `flow_cancel` | Cancel a queued job |
| `flow_retry` | Re-queue failed jobs with the same settings and file names (failed tiles are first retried inside Flow with its own free Retry button: `retries`, default 1) |
| `flow_assets` | List images/videos already in the Flow project (usable as `asset:<title>`) |
| `flow_download` | Download existing project media without regenerating (original or free 1080p/2K upscale) |
| `flow_agent_images` | Fast image batch: hands up to 50 scenes to Flow's own Agent mode, rendered in parallel (8 images in ~85 s), 0 credits. Every image is matched back to its scene by its stored prompt (correct file numbers in any finish order). Scenes the agent drops are asked of the agent again (up to 2 extra rounds), then re-run one by one as a last resort. Confirm setting is restored to Always afterwards |
| `flow_narrate` | Free narration audio, any length: `gemini` (Google AI Studio TTS — the same voices Flow has, plus a `style` note; needs a key in `~/.flow-mcp/gemini-key`) or `mac` (a voice installed on this Mac, no key) |
| `flow_voices` | Narrator voices: Google AI Studio's 30 (and whether a key is set up) plus the English voices installed on this Mac |
| `flow_edit` | Video-to-video edit of a clip already in the project (relight, weather, remove objects). No prior quote; ~20 credits for a 4 s clip |
| `flow_character` | Create a reusable character from a description (Flow draws the portrait) or an image, with personality and a stock voice; reference it as `asset:<name>` |
| `flow_characters` | List the project's characters |
| `flow_character_edit` | Restyle an existing character in place (Flow redraws the portrait, free); name, personality and voice are kept |
| `flow_techniques` | 39 film-technique prompt presets (camera, product, transitions, image commands); pass an id as a scene's `technique` |
| `flow_assemble` | Join a project's clips into one MP4 with optional music and voiceover (local ffmpeg, no credits) |

Scene continuity: `chain_previous` (last frame of the previous clip becomes this clip's first frame),
`first_frame` + `last_frame` (animate between two stills), `reference_images` (keep a product/person consistent).

Clips are saved to `~/flow-mcp-out/<project>/scene-NN.ext`.

## Studio (local control panel)

Double-click `Flow Studio.command`, or:

```bash
npm run studio   # http://127.0.0.1:8787
```

Opening `studio/index.html` directly as a file does nothing: the page needs this server behind it (it says so in red).

Tabbed workspace, one tab per stage: **Cast** (create/edit reusable characters), **Frames** (stills, with
*match previous frame* so a set stays on-model, plus a script splitter and the agent engine), **Shots** (video
clips with first/last frames, chaining and a live credit estimate), **Voice** (free narration from Google AI Studio or a macOS voice), **Restyle** (`flow_edit` on an existing clip), **Cut** (assemble with music,
narration and hold-last-frame) and **Library** (browse and download what is already in Flow). A Monitor and a
Gallery of everything saved locally stay visible alongside every tab.

Claude's MCP process serves the same panel while it is running. Whichever process starts first owns the Flow tab
and the queue; the other one talks to it over the local API, so Claude and the panel always see the same queue.
The API listens on 127.0.0.1 only and requires a per-run token (`~/.flow-mcp/token`).

## Behaviour

- One generation at a time, random 25–70 s pause between them (`FLOW_MCP_PAUSE_MIN_S` / `FLOW_MCP_PAUSE_MAX_S`).
- Before each generation the server reads Flow's own credit quote and skips the scene if it exceeds `max_credits` (default 25).
- The Chrome window must stay open; the machine needs a display.
- Env: `GEMINI_API_KEY` (or `~/.flow-mcp/gemini-key`), `FLOW_MCP_PORT` (8787), `FLOW_MCP_OUTPUT`, `FLOW_MCP_HOME`, `FLOW_MCP_CDP_PORT` (9333), `FLOW_MCP_CHROME`.

This automates Flow's web UI: it can break when Google changes the UI, and automated use may
be against Google's terms. Use on your own account at your own risk.

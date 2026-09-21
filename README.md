# flow-mcp

Drive **Google Flow** (flow.google.com) from Claude, or from a local control panel, using the
credits already included in your Google AI subscription — not the pay-per-use video API.

It is a small program that runs on your own machine. It opens its own Chrome window, signs in
as you, and clicks Flow's real buttons. There is no browser extension, no hosted service and no
account to create.

```
Claude ──stdio──> flow-mcp ──Chrome DevTools Protocol──> Chrome (its own profile) ──> Flow
```

**MCP** = Model Context Protocol, the standard that lets Claude use outside tools.
New here? [OVERVIEW.md](OVERVIEW.md) explains what it does in plain English, with no code names.

---

## What you need

| | |
|---|---|
| **macOS** | Developed and tested here. The Mac-voice narration engine uses macOS `say`; everything else should port, but nothing else is tested |
| **Node.js 22 or newer** | `node --version` |
| **Google Chrome** | Any recent version |
| **A Google AI subscription with Flow** | Pro or Ultra. This is where the credits come from |
| **FFmpeg** *(optional)* | `brew install ffmpeg` — needed only to join clips, mix music or record narration |
| **A Google AI Studio key** *(optional, free)* | Only for the Google narration voices. See below |

A display must stay awake: the Chrome window is really being driven, so the machine cannot be
headless or asleep mid-run.

---

## Install

```bash
git clone https://github.com/GTAI-1/flow-mcp.git
cd flow-mcp
npm install
npm run build
```

> **Do not put this folder in `~/Desktop`, `~/Documents` or `~/Downloads`.** macOS protects those
> folders, and apps that launch the server from there can be refused permission to read its own
> files (`EPERM: operation not permitted`). `~/flow-mcp` or anywhere in your home folder is fine.

Then sign in, once:

```bash
npm run login
```

That opens the dedicated Chrome window. Sign into Google by hand, open (or create) a Flow project,
and leave the window open. The program never types your password — it only uses the session you
created. That Chrome profile lives in `~/.flow-mcp/chrome-profile` and is separate from your
everyday browser.

---

## Connect it to Claude

**Claude Code**

```bash
claude mcp add flow -- node /absolute/path/to/flow-mcp/dist/index.js
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{ "mcpServers": { "flow": { "command": "node", "args": ["/absolute/path/to/flow-mcp/dist/index.js"] } } }
```

Restart Claude, then ask it: *"check my Flow session"*. You should get your plan and credit balance
back. Everything after that is plain English — you never type tool names.

---

## Your first film

Nothing below costs a credit until step 4, and Claude asks before spending.

1. **Check the session.** *"Check my Flow session."* — confirms sign-in, plan and credits.
2. **Make a character.** *"Create a character called Pip, a small lamplighter in a flat cartoon style."*
   Flow draws the portrait. Free.
3. **Draw the key frames.** *"Draw three stills with Pip: a dark rooftop, him lighting a lamp, the
   whole hillside glowing. Match each one to the last."* Free — stills cost nothing, so get the look
   right here before spending.
4. **Shoot it.** *"Turn those into three 10-second shots, each starting where the last one ended,
   720p, no more than 15 credits each."* This spends credits. The price is read from Flow's own
   quote first and the scene is skipped if it is over your cap.
5. **Narrate it.** *"Record this line with a warm documentary voice."* Free, any length.
6. **Cut it.** *"Join the three shots under the narration, don't freeze the last frame."*
   The finished file lands in `~/flow-mcp-out/<project>/`.

---

## The control panel

The same features, without Claude in the loop:

```bash
npm run studio     # then open http://127.0.0.1:8787
```

or double-click **Flow Studio.command**.

Seven tabs, in the order you would use them: **Cast** (reusable characters) → **Frames** (free
stills, with *match previous frame* to keep a set on-model) → **Shots** (paid clips, with first/last
frames, chaining, a live credit estimate, and a card that continues a finished clip from its own last frame) → **Voice** (free narration) → **Restyle** (change a
clip you already have) → **Cut** (join everything, with music and narration) → **Library** (browse
Flow and pull things back for free). A progress monitor and a gallery of finished work stay visible
throughout.

The panel ships with the repo but is not started for you — run `npm run studio` when you want it.
Opening `studio/index.html` as a plain file does nothing; the page needs the server behind it, and
says so in red if you try.

Claude's own process serves the same panel while it runs. Whichever process starts first owns the
Chrome tab and the job queue; the other talks to it over a local API, so Claude and the panel always
agree on what is running. That API listens on 127.0.0.1 only and needs a per-run token
(`~/.flow-mcp/token`).

---

## Tools

| Tool | Purpose |
|---|---|
| `flow_status` | Session state (signed in, project open, plan, credits left), queue, pacing, prompt playbook |
| `flow_generate` | Queue scenes: prompt, image or video, model, aspect, duration, resolution, variants, first/last frame, reference images, `max_credits` cap |
| `flow_wait` | Block until jobs finish; returns file paths |
| `flow_cancel` | Cancel a job that has not started |
| `flow_retry` | Re-queue failed jobs with the same settings and file names (a failed tile is first retried inside Flow with its own free Retry button: `retries`, default 1) |
| `flow_assets` | List images and videos already in the Flow project (usable as `asset:<title>`) |
| `flow_download` | Download existing project media without regenerating — free, including the 1080p / 2K upscale |
| `flow_agent_images` | Fast image batch: hands up to 50 scenes to Flow's own Agent mode, rendered in parallel (20 images in ~204 s), 0 credits. Each image is matched back to its scene by its stored prompt, so file numbers are right in any finish order. Scenes the agent drops are re-asked of it (up to 2 rounds), then re-run one by one |
| `flow_edit` | Video-to-video edit of a clip already in the project (relight, weather, remove objects). Flow shows no quote first; about 20 credits for a 4 s clip |
| `flow_continue` | Start a clip from the last frame of an existing one **with a character or your avatar still attached** — the composer allows a start frame or attached characters, never both, so this drives Flow's agent mode, which does both. No quote beforehand |
| `flow_character` | Create a reusable character from a description (Flow draws the portrait) or an image, with a personality and a stock voice; use it as `asset:<name>` |
| `flow_character_edit` | Restyle an existing character in place (free); name, personality and voice are kept, so every scene referencing it updates |
| `flow_characters` | List the project's characters |
| `flow_techniques` | 39 film-technique prompt presets (camera moves, product shots, transitions, image commands); pass an id as a scene's `technique` |
| `flow_narrate` | Free narration audio, any length: `gemini` (Google AI Studio text-to-speech — the same voices Flow has, plus a `style` note) or `mac` (a voice installed on this Mac, no key needed) |
| `flow_voices` | Narrator voices available, and whether a Google key is set up |
| `flow_assemble` | Join a project's clips into one MP4 with optional music and voiceover (local FFmpeg, no credits) |

**Continuity between shots:** `chain_previous` (this clip starts on the last frame of the previous
one), `first_frame` + `last_frame` (animate between two stills you chose), `reference_images` (keep a
character or product consistent). Flow's *composer* takes either frames or references, never both — so
when you need a start frame **and** a character locked together, use `flow_continue`, which goes through
Flow's agent mode and does both.

Output lands in `~/flow-mcp-out/<project>/scene-NN.ext`.

### Narration with Google's voices (optional)

`flow_narrate` with `engine: "mac"` works out of the box. For Google's voices — the same ones Flow
offers — get a free key from [Google AI Studio](https://aistudio.google.com/apikey) and save it
yourself:

```bash
echo "YOUR_KEY" > ~/.flow-mcp/gemini-key
```

or set `GEMINI_API_KEY`. The key never passes through Claude.

---

## Behaviour and settings

- One generation at a time, with a random 25–70 second pause between them. The page carries an
  invisible reCAPTCHA; this drives the real interface at human pace and does nothing to evade it.
- Before each generation the server reads Flow's own credit quote and skips the scene if it exceeds
  `max_credits` (default 25).
- Environment variables: `GEMINI_API_KEY`, `FLOW_MCP_PORT` (8787), `FLOW_MCP_OUTPUT`,
  `FLOW_MCP_HOME`, `FLOW_MCP_CDP_PORT` (9333), `FLOW_MCP_CHROME`, `FLOW_MCP_PAUSE_MIN_S`,
  `FLOW_MCP_PAUSE_MAX_S`.

## If something goes wrong

| Symptom | Cause |
|---|---|
| The server will not start, `EPERM: operation not permitted` | The folder is in a macOS-protected location. Move it out of `~/Desktop`, `~/Documents` or `~/Downloads` and update the path in your Claude config |
| *"Not signed in"* or *"no project open"* | Run `npm run login`, sign in, open a Flow project, leave the window open |
| A clip generated but no file arrived | The media is still in Flow. `flow_download` pulls it back for nothing — never re-generate and pay twice |
| Everything times out | The Chrome window was closed, or the machine slept. Reopen it with `npm run login` |

---

## Licence and risk

This automates Flow's web interface. It can break whenever Google changes that interface, and
automated use may be against Google's terms of service. Use it on your own account, at your own
risk.

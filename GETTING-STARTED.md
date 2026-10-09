# Getting started with Flow MCP

From nothing to your first video, step by step. No coding needed.

**What this is:** a free tool that makes videos and images in Google Flow for you, using Flow's own credits.
It runs on your computer and works Flow's real buttons in its own Chrome window. You can drive it by
talking to an AI assistant, or click through it yourself in its control panel, **Flow Studio**.

---

## 1. What it costs

**Flow itself: free.** All you need is a Google account (a Gmail). Flow gives every account **50 free
credits a day**; unused credits don't carry over. Stills cost nothing, and a short video clip is about 7–12
credits, so a free account makes a few clips a day. A paid Google AI plan adds more credits and unlocks
1080p downloads.

**An AI assistant: optional, and you only need one.**

| Assistant | Cost | Sets everything up for you? |
|---|---|---|
| **Antigravity** (Google) | Free, with a weekly limit | Yes: follow **Setup A** |
| **Codex** (OpenAI) | A free ChatGPT account gets a small allowance; more with ChatGPT Plus | Yes: follow **Setup A** |
| **Claude Code** (or the **Code** tab in the Claude app) | Needs a paid Claude plan (Pro or higher) | Yes: follow **Setup A** |
| **The Claude app's Chat tab** | Free | No: follow **Setup B**, then connect it |
| **No assistant, just Flow Studio** | Free | No: follow **Setup B** |

Prices and limits change; check each company's own page.

**Your computer:** a Mac, or a Windows 10/11 PC. It can't run in a cloud workspace or on a phone, because
it controls a Chrome window on the computer it's installed on. Keep the computer awake while it's making
something.

---

## Setup A: let your assistant do it

For Antigravity, Codex or Claude Code. The assistant installs everything, including the helper programs,
and connects the tool to itself, so there is no separate "connect" step.

**1.** Open your assistant and paste this:

> *Set up Flow MCP from https://github.com/GTAI-1/flow-mcp for me. Install anything it needs that I don't
> have yet (Node.js 22 or newer, Google Chrome and FFmpeg), put it in my home folder, build
> it, connect it to yourself, then run `npm run login`.*

It asks your permission before each step. Say yes.

**2.** Two things only you can do:

- **Your computer password**, if it asks for one. Installing some helpers needs it, and the assistant never
  types it for you.
- **Sign in to Google** in the Chrome window that opens (that's `npm run login`). Then open a Flow project,
  or create one, and leave the window open. The tool never sees or types your Google password, and this
  Chrome is separate from your everyday one.

**3.** Restart your assistant app, or start a new chat, so it picks up the new tool. Then ask:

> *Check my Flow session.*

You should get your credit balance back. You're done: go to **Your first video**.

**Also want it in the Claude app's Chat tab?** Ask your assistant: *"Also connect Flow MCP to the Claude
desktop app."* Then quit the Claude app completely and reopen it.

---

## Setup B: do it yourself

For the free Claude app (Chat tab), or for using Flow Studio with no assistant at all. You copy and paste
a few commands into **Terminal** (Mac) or **PowerShell** (Windows).

### B1. Install the helpers

**Mac.** Install [Homebrew](https://brew.sh) first if you don't have it (it asks for your password), then:

```bash
brew install node ffmpeg git
```

**Windows.** One at a time, skipping any you already have:

```bash
winget install OpenJS.NodeJS.LTS
```

```bash
winget install Gyan.FFmpeg
```

```bash
winget install Git.Git
```

```bash
winget install Google.Chrome
```

Then close and reopen PowerShell.

### B2. Get Flow MCP

```bash
cd ~
```

```bash
git clone https://github.com/GTAI-1/flow-mcp.git
```

```bash
cd flow-mcp
```

```bash
npm install
```

```bash
npm run build
```

> **Mac:** keep the folder in your home folder (`~/flow-mcp`), not in Desktop, Documents or Downloads.
> macOS protects those, and the Claude app can be refused permission to start the tool from there.
> **Windows:** keep it out of folders OneDrive syncs.

### B3. Sign in to Flow, once

```bash
npm run login
```

A separate Chrome window opens. Sign in to Google yourself, open a Flow project (or create one), and leave
the window open. The sign-in is remembered.

### B4. Connect the Claude app (Chat tab)

Skip this if you'll only use Flow Studio.

1. In the Claude app: **Settings** → **Developer** → **Edit Config**. It shows you a file called
   `claude_desktop_config.json`. Open it in a text editor.
2. Paste this in, using the full path to your `flow-mcp` folder. If the file already has an
   `"mcpServers"` section, add the `"flow"` part inside it rather than making a second one.

   ```json
   { "mcpServers": { "flow": { "command": "node", "args": ["/Users/yourname/flow-mcp/dist/index.js"] } } }
   ```

   On Windows the path looks like `"C:\\Users\\yourname\\flow-mcp\\dist\\index.js"`, with double
   backslashes.
3. Save, then **quit the Claude app completely** (Cmd+Q on a Mac; on Windows right-click its tray icon →
   Quit) and open it again. Just closing the window isn't enough.
4. Ask: *"Check my Flow session."*

To connect Claude Code, Codex or Antigravity by hand instead, see the
[README](README.md#connect-it-to-claude-codex-or-antigravity).

---

## Starting and stopping

Nothing needs to run all the time.

| | Starts | Stops |
|---|---|---|
| **The Flow tools in your assistant** | By themselves, when the assistant app opens | When you quit the app |
| **Flow Studio, the control panel** | While your assistant is open: go to **http://127.0.0.1:8787** in your browser. Without one: double-click **Flow Studio.command** (Mac) or **Flow Studio.cmd** (Windows) in the `flow-mcp` folder, and it opens the panel for you | When you quit the assistant, or close the Flow Studio window you started |
| **The Flow Chrome window** | `npm run login`, or by itself when the tool needs Flow | Close it any time; keep it open while something is being made |

So Flow Studio is only running while your assistant is open, or while its own window is. If the panel says
*"Not connected"*, start it again. On a Mac, if double-clicking the launcher says it *"can't be opened"*,
right-click it → **Open**, or run `npm run studio` in the `flow-mcp` folder.

---

## Your first video

Talk in plain English; you never type tool names. Nothing costs credits until step 4, and the assistant
asks before spending.

1. *"Check my Flow session."*
2. *"Create a character called Pip, a small lamplighter in a flat cartoon style."* (free)
3. *"Draw three stills with Pip: a dark rooftop, him lighting a lamp, the whole hillside glowing."* (free)
4. *"Turn the first still into an 8-second clip at 720p."* (about 12 credits)
5. *"Record a warm narration for it."* (free)
6. *"Put the narration on the clip."* (free)

Everything you make is saved in the **flow-mcp-out** folder in your home folder.

**No assistant?** Open Flow Studio and work through its tabs from left to right: Cast, Frames, Shots,
Voice, Restyle, Cut.

---

## If something goes wrong

| What you see | What to do |
|---|---|
| The Claude app's Chat tab says to install in Terminal | The Chat tab can't run commands. Use Claude Code or the Code tab (Setup A), or follow Setup B |
| The install stops with *403 Forbidden* or *blocked by a security policy* | Your network blocks some downloads (common on work and school networks). Try a home connection |
| The tool doesn't show up in your assistant | Restart the assistant app. In the Claude app, check the path is the full path, that `npm run build` ran, and that you fully quit and reopened it |
| It still doesn't show up | The app may not find Node. Run `which node` (Mac) or `where node` (Windows) and put that full path in `"command"` instead of `"node"` |
| Mac: *EPERM: operation not permitted* | The folder is in Desktop, Documents or Downloads. Move it to your home folder and update the path |
| *"Not signed in"* or *"no project open"* | Run `npm run login`, sign in, open a project, leave the window open |
| Out of credits | Free credits refill daily, starting with your next generation. Stills are always free |
| A video was made but no file arrived | It's still in Flow. Ask to download it again; that's free. Never make it again and pay twice |
| Everything times out | The Flow Chrome window was closed or the computer slept. Run `npm run login` again |

---

## Updating

Ask your assistant: *"Update Flow MCP."* Or in the `flow-mcp` folder:

```bash
git pull
```

```bash
npm install
```

```bash
npm run build
```

Then restart your assistant app so it picks up the new version.

# Getting started with Flow MCP

Step by step, from nothing to your first video. No coding needed: you copy and paste a few commands, and
Claude can run most of them for you.

**What this is:** a free tool that lets Claude make videos and images in Google Flow for you, using the
credits already in your Google AI subscription. It runs on your own computer and works Flow's real
buttons in its own Chrome window. It also comes with a control panel, **Flow Studio**, that does
everything without Claude.

---

## 1. What you need

| | |
|---|---|
| **A Mac or a Windows 10/11 PC** | It runs on your own computer. It can't run in a cloud workspace or on a phone, because it controls a Chrome window on the machine it's installed on |
| **A Google AI subscription with Flow** | Pro or Ultra. That's where the credits come from |
| **Google Chrome** | Any recent version |
| **Node.js 22 or newer** | The program the tool runs on |
| **Git** | To download the tool. Optional: you can download a ZIP from GitHub instead |
| **FFmpeg** *(recommended)* | Joins clips, mixes music and narration, adds captions |
| **whisper.cpp** *(optional)* | Only for captions: it hears the words in your video |
| **Claude** | The desktop app (Chat or Code) or Claude Code. Codex and other MCP apps work too |

Keep the computer awake while it's making something. The Chrome window is really being used, so it
can't run while the machine is asleep.

> **On a work or school network?** Some networks block software downloads. If the install stops with
> "403 Forbidden" or "blocked by a security policy", that's the network, not the tool. Try a home
> connection.

---

## 2. Install the helpers

**Mac.** Install [Homebrew](https://brew.sh) first if you don't have it, then:

```bash
brew install node ffmpeg whisper-cpp git
```

**Windows.** Open PowerShell and run these one at a time (skip any you already have):

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

Then close and reopen PowerShell so it finds them.

On Windows, captions also need `whisper-cli.exe` from the
[whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases), placed somewhere on your PATH.
Skip it if you don't want captions.

---

## 3. Get Flow MCP

**The easy way: let Claude do it.** Open the **Code** tab in the Claude desktop app (or Claude Code in
a terminal) and say:

> *Install https://github.com/GTAI-1/flow-mcp into my home folder, build it, and connect it to Claude.*

Claude runs the commands below and asks before each one. Use the **Code** tab, not the Chat tab: the Chat
tab can't run commands on your computer, so it will only tell you to use Terminal.

**The manual way.** Open Terminal (Mac) or PowerShell (Windows):

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

> **Where to put it.** On a Mac, keep the folder in your home folder (`~/flow-mcp`), **not** in Desktop,
> Documents or Downloads: macOS protects those, and Claude can be refused permission to start the tool
> from there. On Windows, keep it out of folders OneDrive syncs.

---

## 4. Sign in to Flow (once)

In the `flow-mcp` folder, run:

```bash
npm run login
```

A separate Chrome window opens, its own profile apart from your everyday Chrome. In that window:

1. Sign in to Google yourself. The tool never sees or types your password.
2. Open a Flow project, or create one.
3. Leave the window open.

You only do this once. The sign-in is remembered.

---

## 5. Connect it to Claude

You need the **full path** to the tool's main file. On a Mac it's usually
`/Users/<your name>/flow-mcp/dist/index.js`; on Windows `C:\Users\<your name>\flow-mcp\dist\index.js`.

**Claude Code (or the desktop app's Code tab).** Run this, with your own path:

```bash
claude mcp add --scope user flow -- node /Users/yourname/flow-mcp/dist/index.js
```

`--scope user` makes it available in every folder you work in. Without it, Claude Code only sees the tool
in the folder you ran the command from.

**Claude desktop app, Chat tab.**

1. Open Claude → **Settings** → **Developer** → **Edit Config**. That shows you a file called
   `claude_desktop_config.json` in Finder (or Explorer). Open it in a text editor.
2. Paste this in, with your own path. If the file already has an `"mcpServers"` section, add the `"flow"`
   part inside it instead of making a second one.

   ```json
   { "mcpServers": { "flow": { "command": "node", "args": ["/Users/yourname/flow-mcp/dist/index.js"] } } }
   ```

   On Windows, write the path with double backslashes:
   `"C:\\Users\\yourname\\flow-mcp\\dist\\index.js"`.
3. Save the file.
4. **Quit Claude completely** (Cmd+Q on a Mac, or right-click the tray icon → Quit on Windows) and open it
   again. Closing the window isn't enough.

**Codex, Antigravity, Cursor and others:** see the [README](README.md#connect-it-to-claude-codex-or-antigravity).

**Check it worked.** Ask Claude: *"Check my Flow session."* You should get your plan and credit balance
back.

---

## 6. Starting and stopping

Nothing needs to run all the time. Here's what starts what:

| | Starts | Stops |
|---|---|---|
| **The Flow tools in Claude** | By themselves, whenever Claude opens | When you quit Claude |
| **Flow Studio, the control panel** | With Claude: just go to **http://127.0.0.1:8787** in your browser. Without Claude: double-click **Flow Studio.command** (Mac) or **Flow Studio.cmd** (Windows) in the `flow-mcp` folder; it opens the panel for you | When you quit Claude, or close the Flow Studio window you started it from |
| **The Flow Chrome window** | `npm run login`, or by itself when a tool needs Flow | Close it any time. Keep it open while something is being made |

So **Flow Studio isn't always running**: it's there while Claude is open, or while its own window is open.
If the panel says *"Not connected"*, start it again.

Can't double-click the launcher (Mac: *"can't be opened"*)? Right-click it → **Open**, or run
`npm run studio` in the `flow-mcp` folder instead.

---

## 7. Your first video

Talk to Claude in plain English; you never type tool names. Nothing costs credits until step 4, and
Claude asks before spending.

1. *"Check my Flow session."*
2. *"Create a character called Pip, a small lamplighter in a flat cartoon style."* (free)
3. *"Draw three stills with Pip: a dark rooftop, him lighting a lamp, the whole hillside glowing."* (free)
4. *"Turn those into three 8-second shots, 720p, no more than 15 credits each."* (spends credits)
5. *"Record a warm narration for it."* (free)
6. *"Join the shots under the narration."* (free)
7. *"Add bold captions to the film."* (free)

Everything you make is saved in the **flow-mcp-out** folder in your home folder.

Prefer clicking? Open Flow Studio and work through its tabs, left to right: Cast, Frames, Shots, Voice,
Restyle, Cut, Captions.

---

## 8. If something goes wrong

| What you see | What to do |
|---|---|
| Claude says to install in Terminal | You're in the Chat tab. Use the **Code** tab (step 3), or run the commands yourself |
| The install stops with *403 Forbidden* or *blocked by a security policy* | Your network is blocking a download. Try a home connection |
| Flow doesn't show up in Claude | Check the path in your config is the full path, that `npm run build` ran, and that you fully quit and reopened Claude |
| It still doesn't show up | Claude may not find Node. Run `which node` (Mac) or `where node` (Windows) and put that full path in `"command"` instead of `"node"` |
| Mac: *EPERM: operation not permitted* | The folder is in Desktop, Documents or Downloads. Move it to your home folder and update the path |
| *"Not signed in"* or *"no project open"* | Run `npm run login`, sign in, open a project, leave the window open |
| A video was made but no file arrived | It's still in Flow. Ask Claude to download it again; that's free. Never make it again and pay twice |
| Everything times out | The Flow Chrome window was closed or the computer slept. Run `npm run login` again |

---

## 9. Updating

In the `flow-mcp` folder:

```bash
git pull
```

```bash
npm install
```

```bash
npm run build
```

Then quit and reopen Claude, so it picks up the new version.

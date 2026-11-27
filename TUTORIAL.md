# flow-mcp tutorial

This guide takes you from `git clone` to asking Claude for images and videos made in **Google Flow**, and then shows how to work on the code.

- [1. What it is and how it works](#1-what-it-is-and-how-it-works)
- [2. Before you start](#2-before-you-start)
- [3. Install](#3-install)
- [4. Sign in to Flow](#4-sign-in-to-flow)
- [5. Local mode (start here)](#5-local-mode-start-here)
- [6. The Studio panel](#6-the-studio-panel)
- [7. Web mode: claude.ai and Claude Design](#7-web-mode-claudeai-and-claude-design)
- [8. Working on the code](#8-working-on-the-code)
- [9. Troubleshooting](#9-troubleshooting)
- [10. Security and risks](#10-security-and-risks)

---

## 1. What it is and how it works

flow-mcp is a program that runs **on your own computer**. It opens a separate Chrome window where you sign in, then clicks Flow's real buttons for you. Generations therefore spend the credits of your own Google account. It is not a Google API, and there is no browser extension.

**MCP** (Model Context Protocol) is the standard that lets an assistant such as Claude use outside tools.

There are two ways to connect an assistant to the program:

```
Local mode   Claude Code / Claude Desktop ──stdio──> flow-mcp ──> Chrome ──> Flow

Web mode     claude.ai / Claude Design ──HTTPS──> Tailscale Funnel ──> flow-mcp web ──> Chrome ──> Flow
```

| | Local mode | Web mode |
|---|---|---|
| For | Apps installed on the same computer | Claude in the browser |
| Setup | One command | Tailscale, sign-in code and a service |
| Tools | All of them | A small set, with limits |
| Exposed to the internet | No | Yes, behind a sign-in |

**If you do not need Claude in the browser, use local mode only and skip section 7.**

## 2. Before you start

| Item | Required? | What for |
|---|---|---|
| Node.js 22 or newer | Yes | Runs the program. Check with `node --version` |
| Google Chrome | Yes | The window the program drives |
| A Google account with access to Flow | Yes | The credits spent are this account's |
| Git | Yes, for this guide | Downloads the code |
| FFmpeg | For video, audio and web mode | Joins clips, lays a still on green, makes previews. Mac: `brew install ffmpeg`. Windows: `winget install Gyan.FFmpeg` |
| whisper.cpp | Only for captions | Mac: `brew install whisper-cpp` |
| Tailscale | Only for web mode | Gives you an HTTPS address without buying a domain |

Local mode is developed and tested on **macOS**. There is code for Windows, but it has not been run on a real PC yet. Web mode has only been tested on macOS.

The computer must stay **on and awake** while Flow is working.

## 3. Install

**Step 1. Download the code.**

```bash
git clone https://github.com/antoniovita/flow-mcp.git
cd flow-mcp
```

> On a Mac, do **not** put the folder in `Desktop`, `Documents` or `Downloads`. macOS protects those folders and can stop the program from reading its own files (an `EPERM` error).

**Step 2. Install the dependencies.** This downloads the libraries the project uses.

```bash
npm install
```

**Step 3. Build.** The code is written in TypeScript (`src/`). This command produces the JavaScript that actually runs (`dist/`).

```bash
npm run build
```

If it finishes without error messages, it worked. **Repeat this step whenever the code changes**, including after a `git pull`.

## 4. Sign in to Flow

```bash
npm run login
```

1. A Chrome window opens, **separate** from the one you use every day. Its profile lives in `~/.flow-mcp/chrome-profile`.
2. **You** sign in to Google by hand. The program never types your password.
3. Open a project in Flow, or create one.
4. Leave the window open.

The sign-in is kept in that profile for next time.

## 5. Local mode (start here)

**Step 1. Register the server with your app.** Replace `/full/path` with the real path of your folder (on Mac or Linux, `pwd` prints it).

*Claude Code:*

```bash
claude mcp add --scope user flow -- node /full/path/flow-mcp/dist/index.js
```

`--scope user` makes the tool available in every folder.

*Claude Desktop:* add this to `claude_desktop_config.json`, keeping whatever is already in it:

```json
{ "mcpServers": { "flow": { "command": "node", "args": ["/full/path/flow-mcp/dist/index.js"] } } }
```

Setup for other apps is in the [README](README.md).

**Step 2. Restart the app.** You do not need to keep a terminal running: the app starts the server when it needs it.

**Step 3. Check the connection.** Ask:

> Check my Flow session.

The answer should say you are signed in with a project open.

**Step 4. Try something free first.**

> Generate an image of a lighthouse at sunset in my test project.

Files land in `~/flow-mcp-out/<project>/`.

**Step 5. Check the price before any video.** Video spends credits. Every scene has a cap (`max_credits`, 25 by default): if Flow quotes more than that, nothing is generated. Some operations, such as editing or continuing a clip, **show no price beforehand**. Prices change, so go by what Flow shows.

## 6. The Studio panel

A panel in your browser, for working without an assistant:

```bash
npm run studio
```

Open `http://127.0.0.1:8787`. It is reachable from your own computer only. On a Mac you can also open `Flow Studio.command`; on Windows, `Flow Studio.cmd`.

Opening `studio/index.html` as a plain file does not work, because the page needs the server behind it.

## 7. Web mode: claude.ai and Claude Design

This mode lets Claude in the browser use the Flow that runs on your computer.

> **Current status (read first):** web mode is new.
> - **Tested:** sign-in and protections in an isolated setup; on the public address, refusal of requests without a sign-in; and generating one image through the web tools, called by a test client on the same computer.
> - **Tested only with a prototype server:** Claude Design calling a custom connector and saving a small image as a design file.
> - **Not tested yet:** the full claude.ai connection to this server; delivering full-size images and videos to Design; generating video through web mode; the credit-approval dialog; and starting automatically after a reboot.

Before you begin, finish sections 3 and 4 and make sure FFmpeg is installed (`ffmpeg -version`).

### 7.1 Why a tunnel?

claude.ai runs on Anthropic's servers and cannot reach your computer directly. **Tailscale Funnel** creates a public address, such as `https://your-computer.your-tailnet.ts.net`, that forwards requests to flow-mcp. Chrome and your Google session stay on your computer.

> Hosting all of flow-mcp on a functions platform such as Vercel does not work: it needs a Chrome that stays open and signed in.

### 7.2 Install Tailscale

1. Download it from [tailscale.com/download](https://tailscale.com/download). On a Mac, this guide uses the version downloaded from the website.
2. Install it and approve whatever the system asks for.
3. Sign in to your account and check that it says **Connected**.

On a Mac the command lives inside the app. Create a shortcut that **works in this terminal**:

```bash
alias tailscale="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
```

### 7.3 Turn on Funnel

Port `8790` is web mode's port.

```bash
tailscale funnel --bg 8790
```

- The first time, the command may print a link to **enable Funnel** on your account. Open it, approve, and run the command again.
- When it works, it prints your public address. **Copy it.**

> **Heads-up:** the HTTPS certificate is published in a public log, so **your computer's name on your Tailscale network can be discovered by anyone**. If the name contains something personal, rename the machine in the Tailscale admin console first.

**Point Funnel at port 8790 only.** Never publish port 8787 (the Studio panel) or 9333 (Chrome's debugging port). Whoever reaches 9333 controls the signed-in browser.

### 7.4 Configure the connector

Replace the address with yours:

```bash
npm run web:setup -- --url https://your-computer.your-tailnet.ts.net
```

**Optional: a reference folder.** If you want Claude to use your own images (a character, a product, a logo), share a folder:

```bash
npm run web:setup -- --folder /full/path/to/the/folder
```

The connector then lists the PNG, JPG and WebP files in that folder and its subfolders. **Share one specific folder, never your whole home folder.** Whatever Claude receives from it is sent to Claude's service, and whatever is used as a reference also goes to Flow.

The configuration lives in `~/.flow-mcp/web/config.json`:

```json
{
  "public_url": "https://your-computer.your-tailnet.ts.net",
  "folders": ["/full/path/to/the/folder"],
  "max_per_clip": 25,
  "max_per_day": 100
}
```

To remove a folder or change the limits, edit that file. If you change `public_url`, restart the server.

### 7.5 Start the server

To try it, run this in a terminal and leave the window open:

```bash
npm run web
```

To start it with the Mac (macOS only), stop that command with `Ctrl+C` and run:

```bash
npm run web:service -- install
```

The log is in `~/.flow-mcp/web/web.log`. Also set Tailscale to open at login.

### 7.6 Check the address

```bash
curl -i -X POST https://your-computer.your-tailnet.ts.net/mcp
```

You should get **`401`**: the server is up and refuses anyone who has not signed in. A new address can take a few minutes to answer. A test from the same computer may travel inside your Tailscale network; to confirm outside access, open `https://your-computer.your-tailnet.ts.net/.well-known/oauth-protected-resource/mcp` on a phone with Wi-Fi and Tailscale turned off. You should see a short piece of JSON.

### 7.7 Add it to Claude

1. In claude.ai, open **Customize → Connectors → Add custom connector**.
2. Give it a name, such as `flow`.
3. For the URL, use your address **with `/mcp` at the end**.
4. Leave Client ID and Client Secret empty and click **Connect**.
5. A page titled **"Connect Claude to flow-mcp"** should open.
6. On the computer running the server, generate a code:

   ```bash
   npm run web:pair
   ```

7. Type the code into the page.

The code is valid for **10 minutes**, works **once**, and stops working after 5 wrong attempts. **Do not send it to anyone, not even in a chat.** Only type it if you just added the connector yourself.

Claude's plans and menus change. On team plans, an administrator may need to add the connector.

### 7.8 Use it

Open a chat, turn the connector on under **+ → Connectors**, and start with something free:

> Use the flow connector. Check the status and the library. Then generate an image of a simple character on a green background, wait for it to finish and show me the preview. Do not generate any video.

Tools available in web mode:

| Tool | What it does | Cost |
|---|---|---|
| `flow_status` | Session, queue and limits | 0 |
| `flow_library` | Shared references and recent results | 0 |
| `flow_assets` | Items in the project open in Flow | 0 |
| `flow_image` | Generates an image, with optional references and green screen | 0 |
| `flow_video` | Generates or animates a video with Omni 1.2 Flash | Credits |
| `flow_wait` | Follows a job | 0 |
| `flow_get` | Returns a preview or the original file | 0 |

**References without paths:** Claude uses identifiers, such as `ref:MyFolder/character.png` or `result:abc123/1`. The tools do not accept free-form paths on your computer. They also accept `asset:<title>` for something already in the Flow project.

**Green screen:** with `green_screen`, the request asks for a flat green background. For a video with a start image, that image is first laid on `#00B140`. **The generated shade can differ a little from the one requested.** In our image test it came out as `#07AB4A`. When you remove the background, measure the color in the file itself.

**Looping animation:** pass the start image with `loop` so the video begins and ends on the same frame. Check the result, because the loop may not be perfect.

### 7.9 Credit limits

- Defaults: **25 per clip** and **100 per day**.
- To go over, a dialog appears **on the Mac** with **Deny** and **Allow** buttons. Typing "yes" in the chat is not enough. Outside macOS, requests over the limit are refused.
- The daily total counts **only what went through web mode**. Generations made in local mode or directly in Flow are not included.
- The expected cost becomes the scene's cap: if Flow quotes more, nothing is generated. Check [the price table in the code](src/web-policy.ts) whenever Flow changes its prices.

### 7.10 Controlling access

| I want to | Command |
|---|---|
| Remove every sign-in | `npm run web:logout` |
| Take the address off the internet | `tailscale funnel --https=443 off` |
| Remove the automatic start | `npm run web:service -- uninstall` |
| Restart the service | `npm run web:service -- restart` |

## 8. Working on the code

### 8.1 Project map

| File | Responsibility |
|---|---|
| `src/chrome.ts` | Opens Chrome and connects to it |
| `src/flow.ts` | Drives Flow's interface |
| `src/queue.ts` | Job queue, with pauses between jobs |
| `src/core.ts` | Tool logic and parameter validation |
| `src/index.ts` | Local mode's MCP server |
| `src/server.ts`, `src/remote.ts` | Local API, so several processes can share one queue |
| `src/web.ts` | Web mode's server and tools |
| `src/web-auth.ts` | Sign-in (OAuth) and the access code |
| `src/web-policy.ts` | Credits, shared folders, green screen and previews |
| `src/platform.ts` | Differences between operating systems |
| `studio/index.html` | The panel's interface |
| `CLAUDE.md` | Technical notes: what has been observed in Flow and the traps already found |

**Read `CLAUDE.md` before changing the automation.** It is long, but it explains why much of the code looks the way it does.

### 8.2 Project rules

1. **Do not guess selectors.** Inspect the real Flow page before writing code.
2. **Spending credits needs the account owner's OK.** To test a flow, prefer images.
3. **Never automate Google sign-in.**
4. **Do not try to get around bot detection.** The program drives the interface at a human pace.
5. **A new Flow capability becomes a tool**, instead of being done by hand once.
6. **In web mode, treat every input as untrusted.** Do not accept file paths, do not let the caller raise limits, and do not add destructive actions without reviewing the security model.

### 8.3 Development loop

1. Change the code in `src/`.
2. Build with `npm run build`.
3. Reload the process you are using:

| You changed | How to reload |
|---|---|
| Local-mode tools | Restart the app that uses the MCP |
| Web mode, running as a service | `npm run web:service -- restart` |
| A panel you started yourself | Stop `npm run studio` and start it again |
| Only `studio/index.html` | Reload the page |

When several processes are open, only one "owns" port 8787 and runs the queue; the others pass many requests to it. **The owner also has to be restarted** to load new code.

### 8.4 Testing

The project **has no automated test suite yet**; `npm test` does not work. There is a manual end-to-end check for local mode, which **uses your real Flow account**:

```bash
node scripts/e2e.mjs Test '[{"prompt":"a lighthouse at sunset","type":"image"}]'
```

Images exercise the same basic generate-and-download path. Video scenes spend credits.

Before testing, stop the panel and avoid leaving another process generating at the same time, because two connections to the same Chrome can break downloads. To isolate a test, use other ports and folders:

```bash
FLOW_MCP_PORT=8799 FLOW_MCP_HOME=/tmp/flow-test FLOW_MCP_OUTPUT=/tmp/flow-test/out <command>
```

A Chrome already open on port 9333 is reused. If it is closed, the test folder creates a new profile with no sign-in.

### 8.5 Environment variables

| Variable | Default | Use |
|---|---|---|
| `FLOW_MCP_HOME` | `~/.flow-mcp` | Chrome profile, tokens and configuration |
| `FLOW_MCP_OUTPUT` | `~/flow-mcp-out` | Generated files |
| `FLOW_MCP_PORT` | `8787` | Panel and local API |
| `FLOW_MCP_CDP_PORT` | `9333` | Chrome's debugging port |
| `FLOW_MCP_CHROME` | automatic | Path to Chrome |
| `FLOW_WEB_PORT` | `8790` | Web mode |
| `FLOW_WEB_URL` | value in `config.json` | Web mode's public address |
| `FLOW_MCP_DEBUG` | off | `1` prints detailed steps |

Variables set in your terminal do not automatically reach the auto-start service.

### 8.6 Contributing

1. Fork the repository and create a branch.
2. Make a small change with one clear goal.
3. Run `npm run build` and test what you changed.
4. In the pull request, say **what you tested, what you did not**, and on which operating system.
5. Never commit keys, tokens, the `~/.flow-mcp` folder, or screenshots that show your account details.

## 9. Troubleshooting

| Symptom | What to do |
|---|---|
| `Not signed in` or `no project open` | Sign in in flow-mcp's Chrome and open a project |
| `Browser context management is not supported` | Seen when flow-mcp's Chrome was running with no windows open. Quit **only that** Chrome and run `npm run login` |
| `EPERM: operation not permitted` on a Mac | Move the project out of `Desktop`, `Documents` or `Downloads` and update the path in your app |
| New code does not show up | Run `npm run build` and restart the right process (section 8.3) |
| A job disappeared or timed out | **Look at Flow's grid before generating again.** It may have finished and been charged. If the file is there, download it instead of repeating |
| `Couldn't reach` in claude.ai | Check the server, Funnel and the test in section 7.6. Remove the connector and add it again. Others have reported custom-connector failures in the [connector issue tracker](https://github.com/anthropics/claude-ai-mcp/issues) |
| Access code refused | Generate another with `npm run web:pair`, using the same `FLOW_MCP_HOME` as the server |
| Port 8790 in use | Do not run `npm run web` while the service is installed |
| `ffmpeg` errors | Install FFmpeg and reinstall the service so it can find the program |
| Flow changed and a button is not found | Inspect the current page, update `src/flow.ts` and record the change in `CLAUDE.md` |

## 10. Security and risks

- **License:** ISC, see [LICENSE](LICENSE). It covers this code only, not Google Flow or its terms.
- **Google's terms:** this project automates Flow's web interface. It can stop working whenever the interface changes, and automated use may be against Google's terms. Use it on your own account, at your own risk.
- **One person's tool:** web mode is designed for **one person**. Whoever is given access uses your Flow account. Do not share the connector or the code.
- **The internet:** with Funnel on, the sign-in pages are visible to anyone. Turn Funnel off when you do not need it.
- **Review:** web mode has had its own tests but **no independent security audit**. Read `src/web-auth.ts`, `src/web-policy.ts` and `src/web.ts` before relying on it.
- **Private files:** the `~/.flow-mcp` folder holds your Google session. **Never share or publish it.**

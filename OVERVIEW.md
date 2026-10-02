# Flow Studio — what it is and what it does

*A plain-English guide. Written 20 September 2026.*

---

## What this actually is

**There is no website, no cloud service, and no account to sign up for.**

Everything here is a small program sitting on your own computer — a Mac or a Windows PC — in the folder
`~/flow-mcp`. When it runs, it opens a private Chrome window, signs into Google
Flow as you, and clicks Flow's real buttons — the same ones you'd click
yourself. Nothing is hosted anywhere else. Nothing leaves your machine except
the ordinary traffic between that Chrome window and Google.

Three abbreviations you'll see, spelled out once:

- **MCP — Model Context Protocol.** The standard that lets an AI assistant use
  outside tools. Claude uses it, and so does Codex, OpenAI's coding assistant.
  The program on your computer speaks it, which is how either one can operate
  Flow on your behalf.
- **CDP — Chrome DevTools Protocol.** A remote-control channel that Chrome
  already ships with, normally used by developers to inspect pages. The program
  uses it to move the mouse and click inside that private Chrome window.
- **API — application programming interface.** Google sells one for video
  generation, billed per use. **We deliberately do not touch it.** Everything
  here spends the credits already included in your Google AI subscription.

### How a request travels

1. You ask Claude or Codex for something, or you click a button in the control panel.
2. The program on your computer receives it and works out the exact steps.
3. It drives the private Chrome window — typing the prompt, choosing the
   settings, pressing generate, waiting, and saving the finished file to
   `~/flow-mcp-out`.

No browser extension is involved, and your everyday Chrome is never touched —
the program uses its own separate Chrome profile so your normal browsing,
logins and tabs stay untouched.

### Which assistants it works with

- **Claude** — in Claude Code or the Claude app. This is what it was built and tested with.
- **Codex** — OpenAI's coding assistant. It works the same way, because it speaks the same standard. One
  setting matters: Codex gives up on any single step after 60 seconds, and some steps here take longer
  (making a character, a high-quality download, waiting on a video), so the setup guide gives it more
  time. It hasn't been tried with Codex yet.
- **Other apps that support MCP**, like Cursor and VS Code, use the same setup.
- **Not ChatGPT in the browser or the ChatGPT app.** Those can only reach tools on the internet, and this
  one has to run on your own computer, because it drives the Chrome window there.
- **No assistant at all** — the control panel does everything on its own.

Mac is the tested platform. Windows support is new and hasn't been tried on a real PC yet.

---

## The toolkit — 18 tools

### Getting set up

| Name | What it does |
|---|---|
| **Session Check** | Are you signed in, which plan, how many credits are left, what's running right now |
| **Progress Watcher** | Waits and reports as each shot finishes |
| **Cancel** | Drops something that hasn't started yet |
| **Retry Failed** | Re-runs anything that failed, with the same settings and file names |

### Making things

| Name | What it does |
|---|---|
| **Shot Builder** | The main one. Makes a still or a video clip for each scene — opening frame, closing frame, up to three look references, continue-from-last-clip, a camera move, aspect ratio, length and quality. Before spending a single credit it reads the price Flow itself quotes and stops if it's over your limit |
| **Bulk Storyboard** | Hands up to 50 stills to Flow's own assistant, which draws them all at once in about a minute. Free |
| **Continue a Shot** | Picks up on the real last frame of a clip you already made, so the two play as one unbroken take and you cannot see the join. This is how you follow someone across a cut without them changing |
| **Restyle Clip** | Takes a clip you already made and changes it — relight it, change the weather, swap a background. Costs about 20 credits, and Flow shows no price beforehand, so this one always asks you first |
| **Camera Move Library** | 39 ready-written camera directions: 360° orbit, crash zoom, pull-back reveal, drone fly-through, seamless loop, match cut, logo resolve, and more |

**One rule worth knowing before you use Continue a Shot.** Flow makes you pick one of two things, and it will not do both:

- **An exact join** — the new clip opens on the real final frame of the old one, so the cut is invisible. The person looks right because they are *already in that frame*. Any character you attach is ignored.
- **A locked character** — the face or avatar you attach is held steady, but the opening frame is only approximately the old one, so there is a small visible jump.

This is a limit in Flow itself, not something we can program around. The exact join is the better choice almost every time, because the frame you are continuing from already has the person in it.

### Your cast

| Name | What it does |
|---|---|
| **Character Maker** | Creates a reusable character from a description — Flow draws the portrait, free — or from a picture you already have. Can carry a personality and a voice |
| **Character Editor** | Changes how an existing character looks without starting over. Keeps the name, voice and personality, so every future scene picks up the new look |
| **Cast List** | Shows who you've got |

### Your library

| Name | What it does |
|---|---|
| **Library Browser** | Everything sitting in your Flow project |
| **Free Re-download** | Pulls any of it back onto your computer at no cost — including the free upgrade to 1080p for video or 2K for stills. A scene comes down as one finished film, not a pile of loose clips |
| **Move to Flow's Trash** | Clears things out of your Flow project. Flow keeps them in its Trash, where you can restore them — nothing is ever deleted for good, and nothing on your computer is touched |

### Sound and final cut

| Name | What it does |
|---|---|
| **Voiceover Recorder** | Narration for free, at any length. Either Google AI Studio's text-to-speech — the same voices Flow has, and you can tell it *how* to read the line (keep that note short) — or a voice already on your computer (macOS voices on a Mac, Windows' own voices on a PC) |
| **Voice List** | Every narrator available to you |
| **Film Cutter** | Joins clips into one film using FFmpeg, a free video toolkit — the clips you made, or any video you pick, in the order you choose. Lays the narration on top, adds a looping music bed, and lets you turn the clips' own sound down so it doesn't drown out the voice. Sizes everything to match your best clip, and can hold the last frame if the voice runs longer than the footage |

---

## The control panel

A web page served by that same program, reachable only from your own computer.
Start it by double-clicking **Flow Studio.command** (Mac) or **Flow Studio.cmd** (Windows) in the project folder.

Seven tabs, in the order you'd use them:

1. **Cast** — make characters and pick who's in the scene
2. **Frames** — free key stills to lock the look before spending anything
3. **Shots** — the paid clips, with a credit ceiling you set, and the card that carries on from a clip you already made
4. **Voice** — record the narration, free. Your saved narrations are listed here, so you can play them back or delete the ones you don't want. This is also where you paste your free Google AI Studio key — it's checked with Google and saved only on your computer, so you never have to put it in a chat
5. **Restyle** — change a clip you already have
6. **Cut** — join everything into a finished film. Pick the videos you want, in order — ones you made, or any video you upload — then add a narration and music, and turn the clips' own sound down so the voice sits on top
7. **Library** — browse what Flow is holding, pull it back for free, or move things to Flow's Trash

Progress and a gallery of your saved work sit alongside. The gallery shows stills or clips on the tabs where you'd use them, and on a wide screen each side scrolls on its own.

**Two kinds of delete, so you always know what you're removing:**

- **Move to the Mac's Trash** (the **Recycle Bin** on Windows) — takes a file off your computer: a film, a still, or a narration. Put it back from the Trash if you change your mind.
- **Move to Flow's Trash** — in the Library tab. Takes it out of your Flow project only; anything you've already downloaded stays on your computer. Restore it from Trash in Flow.

---

## What we proved works

Every item below was run for real, not assumed:

- Stills, and video generated from text alone
- Animating between an opening and a closing frame you chose
- Look references — from a file on disk, or from one of your own characters
- Continuing one clip from the exact last frame of another
- Downloading at higher quality for free
- The spending guard, the pacing, and the credit readout
- Camera moves
- Joining films with music and narration (audio levels measured to confirm)
- Making a character, and editing one in place
- Restyling an existing clip
- The bulk storyboard: 20 stills in 204 seconds, free

We also hit a **real** Flow failure in the wild — 4 of 20 stills failed while
Google's servers were busy. Flow offers no retry button at all on those, so the
recovery asks Flow's assistant again for just the missing scene numbers, and
only falls back to one-at-a-time as a last resort.

---

## What we made

| Film | What it shows off |
|---|---|
| **The Lamplighter** — 30 seconds, 1080p, narrated | The whole chain end to end: a character, three matching key frames, three 10-second shots that flow into each other, free narration, and a final cut with no frozen ending. 45 credits |
| **Obstacles** | Sticky the stick figure, opening-to-closing-frame animation, three narrator voices compared |
| **NYC Flight** | A 10-second drone shot that begins exactly where an earlier clip ended |
| **Welcome to America** | Earth from space down to the Statue of Liberty, a pin drop, and a text reveal |
| **Desk Take** — 20 seconds, 1080p | You, from your own Flow avatar, talking to camera in two shots. The second one starts on the exact last frame of the first, so it plays as one continuous take. 30 credits |

---

## What you can do with it now

- Generate 30–50 scenes in one sitting
- Keep a character looking identical across every shot
- Animate between two stills you picked yourself
- Carry on from the real last frame of a finished clip, so two clips play as one shot
- Chain shots into one unbroken camera move
- Survive busy-server failures without losing the work that succeeded
- Narrate anything, at any length, for free
- Cut it all together with music and voice
- Restyle footage you already paid for
- Re-download at higher quality for nothing
- Run all of it from the panel, without any AI assistant involved

**Not covered:** Flow's own clip-stitching (the cut happens on your computer
instead), its "improve prompt" button, and 4K — your plan blocks that one.

---

## If a clip is made but no file appears

It happens. The important part: **you have already paid for that clip and it is safe.** It is sitting in your Flow project, and fetching it costs nothing — that is what Free Re-download is for. Ask for it by name and it comes down. Never make the clip again; you would be paying twice for the same thing.

The same goes for a job that seems to vanish while it is running. What Flow is holding is the honest answer — look there before starting anything over.

---

## Where things live

| What | Where |
|---|---|
| The program | `~/flow-mcp` |
| Finished films and stills | `~/flow-mcp-out/<project name>` |
| The private Chrome profile | `~/.flow-mcp/chrome-profile` |
| The control panel | Started by **Flow Studio.command** (Mac) or **Flow Studio.cmd** (Windows), opens on your computer only |
| Sign in to Flow by hand | `npm run login` in the project folder |

Your Google password is never typed by the program — you sign in yourself, once,
and that private Chrome window stays signed in afterwards.

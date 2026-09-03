# cobra-tool

Instantly pull up TikTok, Instagram Reels and YouTube Shorts — side by side —
while your coding agent is working. The moment it has a question or finishes,
the windows close themselves.

You hand Claude Code a task. Three seconds later the feeds slide in across your
screen. You scroll. The agent hits a permission prompt, or finishes the job —
the feeds vanish and you're looking at your terminal again.

```
┌──────────────┬──────────────┬──────────────┐
│              │              │              │
│    TikTok    │  IG  Reels   │  YT  Shorts  │
│   (audio)    │   (muted)    │   (muted)    │
│              │              │              │
└──────────────┴──────────────┴──────────────┘
   opens when the agent gets busy
   closes the instant it needs you
```

## Install

Needs Node 18+ and a Chromium-family browser (Chrome, Brave, Edge, Chromium).

```sh
git clone https://github.com/cobrasbangles-a11y/cobra-tool
cd cobra-tool
npm link            # optional — gives you a global `cobra`
cobra doctor        # check browser + screen detection before wiring anything up
```

Then wire it into your agent:

```sh
cobra install          # this repo only
cobra install --user   # every repo you open
```

Restart Claude Code (or run `/hooks`) and you're done. `cobra uninstall` takes
it back out and leaves the rest of your settings untouched.

## How it decides when to open

| Moment | Agent event | What happens |
| --- | --- | --- |
| You submit a prompt | `UserPromptSubmit` | Arms a timer — **nothing opens yet** |
| Agent still busy after 8s | *(timer fires)* | Three windows open, side by side |
| Agent asks a question | `Notification` | Windows close |
| Agent finishes the turn | `Stop` | Windows close |
| You close the session | `SessionEnd` | Windows close |

The delay is the important part. Without it, "what does this function do" would
summon three browser windows for about a second and a half. Eight seconds is the
default; `cobra config openDelayMs=0` makes it instant, or crank it up if you
only want the feeds on genuinely long jobs.

## Other agents

**Codex** notifies on turn completion but has no turn-start hook, so it gets the
closing half automatically and the opening half from the wrapper:

```sh
cobra install --codex
cobra wrap -- codex
```

**Anything else** — any CLI at all — works through the wrapper. It opens the
feeds while the command runs and closes them when it exits, including on Ctrl-C,
and passes the exit code straight through:

```sh
cobra wrap -- your-agent --do-the-thing
cobra wrap -- npm run build
```

## Everyday use

```sh
cobra on / cobra off     # master switch; leaves your hooks in place
cobra open               # pull them up right now
cobra close              # put them away
cobra status             # what's open, and what's armed
cobra feeds              # list the built-in feeds
cobra doctor             # diagnose browser, screen, layout and hook wiring
```

## Config

```sh
cobra config                          # show everything in effect
cobra config layout=phones
cobra config feeds=tiktok,youtube
cobra config openDelayMs=3000
cobra config closeOn.question=false   # only close when the agent is fully done
```

| Key | Default | What it does |
| --- | --- | --- |
| `feeds` | `tiktok, instagram, youtube` | Which feeds, left to right. Any `https://` URL works too. |
| `layout` | `columns` | `columns` fills the screen; `phones` uses centered 9:16 windows. |
| `audio` | `primary` | `primary` = leftmost keeps sound. Also `all` or `none`. |
| `openDelayMs` | `8000` | How long the agent must be busy before anything opens. |
| `closeOn` | all on | `question`, `done`, `sessionEnd` — turn any of them off. |
| `browser` | `auto` | A key (`chrome`, `brave`, `edge`, `chromium`, `firefox`) or a full path. |
| `appMode` | `true` | Chromeless windows. Off gives you tabs and an address bar. |
| `screen` | auto-detected | Override with `screen.width` / `screen.height` if detection is wrong. |
| `gap` | `0` | Space between windows, in points. |
| `insets` | menu bar on macOS | Keep-clear space around the row: `insets.top` etc. |
| `enabled` | `true` | What `cobra on` / `cobra off` flip. |

Config, state, logs and browser profiles all live in `~/.cobra-tool`.

## How it works

Each feed opens in a **Chromium app window** — no tab strip, no address bar —
positioned with `--window-position` and `--window-size`. That's why a
Chromium-family browser matters: Firefox has no geometry flags, so it can only
be nudged into place afterwards (via `wmctrl` on Linux, and not at all
elsewhere). `cobra doctor` will tell you if you're on that path.

Each feed also gets **its own persistent profile** under
`~/.cobra-tool/profiles/`. This does two useful things: the windows are separate
OS processes, so they can be positioned and closed independently, and you log
into each site once and stay logged in — without cobra ever touching your normal
browser profile. Closing kills the whole process group, so no renderers linger.

State is keyed by agent session id, so two Claude Code sessions in two terminals
won't close each other's windows.

Nothing is scraped, automated, or posted. This opens three URLs in a browser and
gets out of the way.

## A note on the hooks

They run in your agent's critical path, so they're built to be boring: they read
stdin with a hard timeout, do their work in a detached background process, and
**always exit 0**. A bug in cobra should cost you the feeds, not your turn. When
something does go wrong it's written to `~/.cobra-tool/cobra.log` rather than
your terminal.

## Development

```sh
npm test        # 23 tests, no dependencies, no network
COBRA_DEBUG=1 cobra open    # mirror the log to stderr
COBRA_HOME=/tmp/cobra-scratch cobra open   # sandbox state and profiles
```

`hooks/claude-code.example.json` shows exactly what `cobra install` writes, if
you'd rather wire it up by hand or adapt it for another agent.

## Licence

MIT

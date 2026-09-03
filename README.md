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

The whole interface is two commands. Anything that can run a shell command when
work starts and when it ends can drive cobra:

```sh
cobra start
cobra stop
```

**Codex** notifies on turn completion but has no turn-start event, so it gets
the closing half natively and the opening half from the wrapper:

```sh
cobra install --codex
cobra wrap -- codex
```

**Any other agent CLI** — aider, opencode, whatever you're running — gets the
full open *and* close behaviour from `--idle`, no hooks required:

```sh
cobra wrap --idle 8 -- aider
```

The wrapper watches the command's output and treats 8 seconds of silence from a
still-running process as *it's waiting for you*: the feeds close, and reopen the
moment it starts talking again. Pick a number above the agent's normal thinking
pauses — too low and the feeds flap, too high and you scroll past the question.

Because `--idle` has to pipe output in order to watch it, it isn't right for
full-screen TUIs that redraw the terminal. For those, plain `cobra wrap` passes
the terminal through untouched and closes on exit:

```sh
cobra wrap -- your-agent --do-the-thing
cobra wrap -- npm run build
```

Exit codes pass straight through in every case. See `adapters/` for
copy-pasteable snippets, including a Makefile and a drop-in shell wrapper.

## Multi-monitor

This is where it stops being a gimmick. On a two-screen desk the feeds go on the
second monitor and your editor stays exactly where it was.

```sh
cobra displays
```

```
  [0] eDP-1            1512x945 at 0,0       primary
  [1] HDMI-1           2560x1440 at 1512,0   ← feeds go here
```

The default is `display=auto`, which means *the second monitor if you have one,
otherwise the main one* — so it does the right thing on one screen and the
better thing on two. Override it however you like:

```sh
cobra config display=primary     # keep them on the main screen
cobra config display=1           # by index, from `cobra displays`
cobra config display=HDMI-1      # by output name
```

Displays are enumerated per platform: `NSScreen` via JXA on macOS, `xrandr` on
Linux, `System.Windows.Forms.Screen` on Windows. macOS reports screen geometry
bottom-left-origin with +Y upward while browsers place windows top-left-origin
with +Y downward, so cobra flips the coordinates — without that, a monitor
stacked above your laptop would get windows placed below it.

## Everyday use

```sh
cobra on / cobra off     # master switch; leaves your hooks in place
cobra open               # pull them up right now
cobra close              # put them away
cobra status             # what's open, and what's armed
cobra stats              # where your feed time actually went
cobra feeds              # list the built-in feeds
cobra displays           # your monitors, and which one gets the feeds
cobra doctor             # diagnose browser, screen, layout and hook wiring
```

## Guard rails

The feeds open when your agent gets busy — and a long build can be *very* busy.
Two things keep that honest.

**A time cap.** Close the feeds after a fixed stretch even if the agent is still
grinding, so a forty-minute test run doesn't cost you forty minutes:

```sh
cobra config maxOpenMs=900000    # 15 minutes, then they close themselves
```

Off by default. When it fires, the windows close exactly as they would if the
agent had finished.

**Honest numbers.** Every stretch is recorded, and `cobra stats` tells you where
the time actually went:

```
today      42m 10s    over 6 stretch(es)
last 7d    3h 18m     over 31 stretch(es)
all time   9h 04m     over 88 stretch(es)

last 7 days
  Fri  ████████ 24m 0s
  Sat  █████████████████████████ 1h 12m
  ...

longest single stretch: 38m 12s
```

`cobra stats --reset` clears the history. It lives in
`~/.cobra-tool/usage.jsonl` — append-only, one JSON object per stretch, yours to
grep.

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
| `maxOpenMs` | `0` (off) | Hard cap on one stretch, in ms. Closes the feeds even mid-task. |
| `closeOn` | all on | `question`, `done`, `sessionEnd` — turn any of them off. |
| `display` | `auto` | Which monitor: `auto` (second if present), `primary`, `secondary`, an index, or an output name. |
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
npm test        # 55 tests, no dependencies, no network
COBRA_DEBUG=1 cobra open    # mirror the log to stderr
COBRA_HOME=/tmp/cobra-scratch cobra open   # sandbox state and profiles
```

`adapters/` holds copy-pasteable wiring for each agent, including exactly what
`cobra install` writes into `settings.json` if you'd rather do it by hand.

## Status

Built in phases, each one landed and tested:

1. **Core** — hooks, three positioned windows, delayed open, clean close.
2. **Multi-monitor** — display enumeration on all three platforms, feeds on your second screen.
3. **Guard rails** — a time cap on a single stretch, and `cobra stats`.
4. **Any agent** — `--idle` output watching, public `start`/`stop`, adapters.
5. **CI** — tests on macOS, Linux and Windows across Node 18/20/22.

CI runs the suite on all three platforms because the display probes, process
group kills and browser discovery are genuinely platform-specific, plus a smoke
job that exercises the CLI on a machine with no browser and no display attached.

## Licence

MIT

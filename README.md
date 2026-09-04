# white-python

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

**On a Mac? See [docs/macos.md](docs/macos.md)** — the same steps with the
Homebrew, zsh, `/Applications` and Automation-permission details filled in.

Needs Node 18+ and a Chromium-family browser (Chrome, Brave, Edge, Chromium).

```sh
mkdir -p ~/tools && cd ~/tools
git clone https://github.com/cobrasbangles-a11y/white-python
cd white-python
npm link
```

That gives you two commands, both the same program: **`white-python`** and the
short **`wpy`**. Two names on purpose — `wpy` is what you'll type, and the long
one is there in case something else on your PATH ever claims the short one.

Clone somewhere permanent. `wpy install` writes absolute paths into your
`settings.json`, so moving or deleting the clone afterwards silently stops the
hooks from firing.

```sh
wpy doctor      # check browser + screen detection BEFORE wiring anything up
wpy login       # sign in to each feed once
wpy install     # this repo only
wpy install --user   # every repo you open
```

Restart Claude Code (or run `/hooks`) and you're done. `wpy uninstall` takes it
back out and leaves the rest of your settings untouched.

### If `npm link` fails

Usually a permissions error on a system-installed Node. Either symlink it
yourself:

```sh
mkdir -p ~/.local/bin
ln -sf ~/tools/white-python/bin/white-python.js ~/.local/bin/wpy
# then make sure ~/.local/bin is on your PATH
```

or alias it in `~/.zshrc` (or `~/.bashrc`):

```sh
alias wpy="node ~/tools/white-python/bin/white-python.js"
```

## Signing in

The feeds are far better logged in, and you should only ever have to do it once:

```sh
wpy login
```

That opens each feed in a **normal** browser window — address bar and all,
because OAuth popups and 2FA are miserable in a chromeless one. Sign in to each,
press Enter, and they close.

Every feed keeps its own profile directory under `~/.white-python/profiles/`,
which persists across sessions, reboots and upgrades. So the windows that open
while your agent works are already signed in. `wpy doctor` shows how many feeds
have a stored profile.

Two honest caveats. This reports whether a browser **profile** exists, not
whether you're actually signed in — Chromium encrypts its cookie store, and
checking properly would mean a native dependency. And Google sometimes refuses
sign-in from a browser launched with a custom profile directory; YouTube Shorts
browses fine signed out, so that's rarely a problem in practice.

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
default; `wpy config openDelayMs=0` makes it instant, or crank it up if you
only want the feeds on genuinely long jobs.

## Other agents

The whole interface is two commands. Anything that can run a shell command when
work starts and when it ends can drive white-python:

```sh
wpy start
wpy stop
```

**Codex** notifies on turn completion but has no turn-start event, so it gets
the closing half natively and the opening half from the wrapper:

```sh
wpy install --codex
wpy wrap -- codex
```

**Any other agent CLI** — aider, opencode, whatever you're running — gets the
full open *and* close behaviour from `--idle`, no hooks required:

```sh
wpy wrap --idle 8 -- aider
```

The wrapper watches the command's output and treats 8 seconds of silence from a
still-running process as *it's waiting for you*: the feeds close, and reopen the
moment it starts talking again. Pick a number above the agent's normal thinking
pauses — too low and the feeds flap, too high and you scroll past the question.

Because `--idle` has to pipe output in order to watch it, it isn't right for
full-screen TUIs that redraw the terminal. For those, plain `white-python wrap` passes
the terminal through untouched and closes on exit:

```sh
wpy wrap -- your-agent --do-the-thing
wpy wrap -- npm run build
```

Exit codes pass straight through in every case. See `adapters/` for
copy-pasteable snippets, including a Makefile and a drop-in shell wrapper.

## Multi-monitor

This is where it stops being a gimmick. On a two-screen desk the feeds go on the
second monitor and your editor stays exactly where it was.

```sh
white-python displays
```

```
  [0] eDP-1            1512x945 at 0,0       primary
  [1] HDMI-1           2560x1440 at 1512,0   ← feeds go here
```

The default is `display=auto`, which means *the second monitor if you have one,
otherwise the main one* — so it does the right thing on one screen and the
better thing on two. Override it however you like:

```sh
wpy config display=primary     # keep them on the main screen
wpy config display=1           # by index, from `white-python displays`
wpy config display=HDMI-1      # by output name
```

Displays are enumerated per platform: `NSScreen` via JXA on macOS, `xrandr` on
Linux, `System.Windows.Forms.Screen` on Windows. macOS reports screen geometry
bottom-left-origin with +Y upward while browsers place windows top-left-origin
with +Y downward, so white-python flips the coordinates — without that, a monitor
stacked above your laptop would get windows placed below it.

## Everyday use

```sh
wpy on / wpy off   # master switch; leaves your hooks in place
wpy open           # pull them up right now
wpy close          # put them away
wpy status         # what's open, and what's armed
wpy stats          # where your feed time actually went
wpy login          # sign in to the feeds (one time)
wpy feeds          # list the built-in feeds
wpy displays       # your monitors, and which one gets the feeds
wpy doctor         # diagnose browser, screen, layout and hook wiring
```

## Guard rails

The feeds open when your agent gets busy — and a long build can be *very* busy.
Two things keep that honest.

**A time cap.** Close the feeds after a fixed stretch even if the agent is still
grinding, so a forty-minute test run doesn't cost you forty minutes:

```sh
wpy config maxOpenMs=900000    # 15 minutes, then they close themselves
```

Off by default. When it fires, the windows close exactly as they would if the
agent had finished.

**Honest numbers.** Every stretch is recorded, and `white-python stats` tells you where
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

`wpy stats --reset` clears the history. It lives in
`~/.white-python/usage.jsonl` — append-only, one JSON object per stretch, yours to
grep.

## Config

```sh
wpy config                          # show everything in effect
wpy config layout=phones
wpy config feeds=tiktok,youtube
wpy config openDelayMs=3000
wpy config closeOn.question=false   # only close when the agent is fully done
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
| `enabled` | `true` | What `white-python on` / `white-python off` flip. |

Config, state, logs and browser profiles all live in `~/.white-python`.

## How it works

Each feed opens in a **Chromium app window** — no tab strip, no address bar —
positioned with `--window-position` and `--window-size`. That's why a
Chromium-family browser matters: Firefox has no geometry flags, so it can only
be nudged into place afterwards (via `wmctrl` on Linux, and not at all
elsewhere). `wpy doctor` will tell you if you're on that path.

Each feed also gets **its own persistent profile** under
`~/.white-python/profiles/`. This does two useful things: the windows are separate
OS processes, so they can be positioned and closed independently, and you log
into each site once and stay logged in — without white-python ever touching your normal
browser profile. Closing kills the whole process group, so no renderers linger.

Profiles are keyed per feed, and two feeds must never share one: Chromium routes
every launch with the same `--user-data-dir` into a single process, which stacks
both windows in the same spot. Built-in feeds use their plain names (so your
logins survive upgrades); custom URLs get a digest of the full URL, so
`youtube.com/shorts` and `youtube.com/@someone` stay separate.

State is keyed by agent session id, so two Claude Code sessions in two terminals
won't close each other's windows.

Nothing is scraped, automated, or posted. This opens three URLs in a browser and
gets out of the way.

## A note on the hooks

They run in your agent's critical path, so they're built to be boring: they read
stdin with a hard timeout, do their work in a detached background process, and
**always exit 0**. A bug in white-python should cost you the feeds, not your turn. When
something does go wrong it's written to `~/.white-python/white-python.log` rather than
your terminal.

## Development

```sh
npm test        # 86 tests, no dependencies, no network
WHITE_PYTHON_DEBUG=1 wpy open    # mirror the log to stderr
WHITE_PYTHON_HOME=/tmp/white-python-scratch wpy open   # sandbox state and profiles
```

There is also an end-to-end check that drives a real browser on a real display —
the layer unit tests can't reach. It runs every command, reads window counts
back from the window manager, and fails if anything is left open:

```sh
Xvfb :99 -screen 0 1920x1080x24 &
DISPLAY=:99 openbox &
DISPLAY=:99 bash test/integration.sh
```

It needs a browser, a display and a window manager, so it's deliberately not
part of `npm test`, which stays dependency-free and headless.

`adapters/` holds copy-pasteable wiring for each agent, including exactly what
`wpy install` writes into `settings.json` if you'd rather do it by hand.

## Status

Built in phases, each one landed and tested:

1. **Core** — hooks, three positioned windows, delayed open, clean close.
2. **Multi-monitor** — display enumeration on all three platforms, feeds on your second screen.
3. **Guard rails** — a time cap on a single stretch, and `white-python stats`.
4. **Any agent** — `--idle` output watching, public `start`/`stop`, adapters.
5. **CI** — tests on macOS, Linux and Windows across Node 18/20/22.

Verified against a real X display, a real window manager and real Chromium:
three windows opened at the computed geometry, the `phones` layout centered
correctly, the hook lifecycle went armed → open → closed on a question, and
close left no windows or processes behind.

CI runs the suite on all three platforms because the display probes, process
group kills and browser discovery are genuinely platform-specific, plus a smoke
job that exercises the CLI on a machine with no browser and no display attached.

## When something goes wrong

```sh
wpy debug
```

One diagnostic dump: platform, Node, the raw and normalized config with any
repairs, display enumeration (including the raw macOS probes when it fails),
every browser path searched and whether it was found, hook wiring, and the last
30 log lines. Paste it when reporting a problem.

**If every turn started erroring right after installing**, the most likely cause
is that the clone moved. `wpy install` writes absolute paths, so if the folder
is renamed, moved or deleted, each hook still fires and then dies with a Node
"cannot find module" trace — on every turn. `wpy doctor` names it:

```
hooks:   project 4 wired, 4 STALE       (~/.claude/settings.json)
         ↳ they point at /old/path/white-python.js, which no longer exists.
         ↳ every turn will error until you re-install or remove them.
```

Re-run `wpy install --user` from the clone's new location, or remove the hooks:

```sh
wpy uninstall --user
wpy uninstall            # and in any project you installed into
```

Bad config values can't break commands any more — they're validated on read and
on write, repaired where possible, and `wpy doctor` lists what it repaired. If
you'd rather start clean, delete `~/.white-python/config.json`.

## Licence

MIT

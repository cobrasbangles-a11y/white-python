# Setting up on a Mac

Copy-paste, in order. Every command here is meant to be run in Terminal.

macOS uses **zsh**, so shell config goes in `~/.zshrc`.

## 1. Prerequisites

```sh
node --version
```

You need **v18 or higher**. If it's missing or older:

```sh
brew install node
```

No Homebrew? Install it from [brew.sh](https://brew.sh), or use the installer
from [nodejs.org](https://nodejs.org).

You also need a **Chromium-family browser** in `/Applications` — Chrome, Brave,
Edge or Chromium. Firefox will run, but macOS gives no way to position its
windows, so the whole side-by-side effect is lost.

These are the paths searched, in order:

```
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
/Applications/Brave Browser.app/Contents/MacOS/Brave Browser
/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge
/Applications/Chromium.app/Contents/MacOS/Chromium
/Applications/Firefox.app/Contents/MacOS/firefox
```

## 2. Clearing out an earlier install

Skip this on a fresh machine. Run it if you had an older version — especially
one installed under the old `cobra` name.

```sh
wpy uninstall --user 2>/dev/null; cobra uninstall --user 2>/dev/null
rm -rf ~/.white-python ~/.cobra-tool
rm -rf ~/tools/white-python ~/tools/cobra-tool
```

## 3. Install

```sh
mkdir -p ~/tools && cd ~/tools
git clone https://github.com/cobrasbangles-a11y/white-python
cd white-python
npm link
```

That gives you two commands for the same program: `white-python`, and the short
`wpy` used throughout these docs.

> **Leave the folder where it is.** `wpy install` writes absolute paths into
> `settings.json`. Move or rename the clone afterwards and every hook still
> fires, then dies with a "cannot find module" error — on every turn. If you do
> move it, re-run `npm link` and `wpy install --user` from the new location.
> `wpy doctor` reports this as `STALE` and names the missing path.

### If `npm link` fails with EACCES

A permissions error on a system-installed Node. Don't reach for `sudo` — point
npm at a directory you own:

```sh
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
npm link
```

## 4. Check it before wiring anything up

```sh
wpy doctor
```

A healthy Mac looks like this:

```
screen:  1512x982 (detected, full display list)
display: 1 attached, using "auto" → Main display
browser: chrome (chromium) — /Applications/Google Chrome.app/...
```

**`browser: NOT FOUND`** — installed somewhere non-standard:

```sh
wpy config browser="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

**`screen: NOT DETECTED — guessed`** — set it by hand. Use the figures from
 → System Settings → Displays, taking the resolution it says it is
*"looking like"*. Those are **points**, which is what window placement uses —
not the Retina pixel count:

```sh
wpy config screen.width=1512 screen.height=982
```

### "Terminal wants to control Finder"

macOS may show this the first time. It comes from the fallback screen probe,
which asks Finder for the desktop size and needs Automation permission.

Click **OK**, or dismiss it and set `screen.width` / `screen.height` by hand as
above — with those set, nothing ever asks again. The primary probe reads
`NSScreen` directly and needs no permission; Finder is only consulted when that
fails.

## 5. Sign in once

```sh
wpy login
```

Each feed opens in a normal browser window — address bar and all, because
signing in through a chromeless window with OAuth popups and 2FA is miserable.
Sign in to each, press Enter, and they close.

Every feed keeps its own browser profile under `~/.white-python/profiles/`,
which survives sessions, reboots and upgrades. The windows that open later,
while your agent works, are already signed in.

Two things worth knowing:

- `wpy doctor` reports whether a **profile** exists, which is not the same as
  being signed in. Chromium encrypts its cookie store, and checking properly
  would need a native dependency.
- **Google sometimes refuses sign-in** from a browser launched with a custom
  profile directory. That's Google, not a bug here. TikTok and Instagram are
  where signing in actually matters; YouTube Shorts browses fine signed out.

## 6. Wire it into Claude Code

```sh
wpy install --user
```

Then **quit and reopen Claude Code** (or run `/hooks`).

Use `wpy install` without `--user` to wire it into the current repo only.

## 7. Test it

```sh
wpy wrap -- sleep 20
```

Three windows open, twenty seconds pass, they close. If that works, everything
works — it exercises the same open and close path the hooks use.

## Everyday

```sh
wpy on / wpy off       # master switch; hooks stay wired
wpy open / wpy close   # pull them up or put them away right now
wpy status             # what's open, and what's armed
wpy stats              # where your feed time actually went
wpy displays           # your monitors, and which one gets the feeds
```

## Common tweaks

```sh
wpy config display=primary     # two monitors, but keep the feeds on the main one
wpy config layout=phones       # 9:16 windows instead of full-height columns
wpy config openDelayMs=3000    # open sooner (default: 8s of the agent being busy)
wpy config audio=none          # mute everything (default: only the leftmost has sound)
wpy config maxOpenMs=900000    # close themselves after 15 minutes regardless
```

## When something goes wrong

```sh
wpy debug
```

One dump with everything: your config raw and normalized, display detection
including the raw macOS probe output when it fails, every browser path searched
with hit or miss, each installed hook with `ok` or `MISSING`, and the log tail.
Paste it when reporting a problem.

Emergency reset — removes the hooks and leaves the rest of your Claude Code
settings untouched:

```sh
wpy uninstall --user
```

Other useful paths:

```sh
rm ~/.white-python/config.json          # start from default settings
tail -30 ~/.white-python/white-python.log
```

## Known gap

Window **placement** on macOS is covered by unit tests and by CI running on
macOS runners, but no one has yet watched it position a real window on a real
Mac. Step 7 is the test that settles it. If the three windows land anywhere
other than side by side, `wpy debug` output is what's needed to fix it.

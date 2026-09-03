#!/usr/bin/env node
'use strict';

// Piping into `head`, `grep -q` or a closed pager slams stdout shut mid-write.
// That's ordinary shell usage, not a crash worth a stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
  });
}

const { readConfig, inspectConfig, writeConfig, setConfigPath, PATHS } = require('../src/config');
const { FEEDS } = require('../src/feeds');
const { openWindows, closeWindows, status, runReaper } = require('../src/windows');
const usage = require('../src/usage');
const { login, profileState } = require('../src/login');
const { debugReport } = require('../src/debug');
const { detectScreen, defaultInsets } = require('../src/screen');
const { detectDisplays, selectDisplay } = require('../src/displays');
const { findBrowser } = require('../src/browser');
const hooks = require('../src/hooks');
const install = require('../src/install');
const { wrap } = require('../src/wrap');
const { log } = require('../src/log');

const HELP = `
white-python — pull up TikTok, Instagram Reels and YouTube Shorts side by side
               while your coding agent works, and close them the second it
               needs you.

Both "white-python" and the short "wpy" run this. Examples use wpy.

Setup
  wpy doctor              check browser, screen and hook wiring FIRST
  wpy debug               full diagnostic dump — paste this when reporting a problem
  wpy login               open the feeds once so you can sign in; sessions persist
  wpy install [--user]    wire up Claude Code hooks (this repo, or --user for all)
  wpy install --codex     wire up the Codex turn-complete notifier
  wpy uninstall [--user]  remove the hooks again

Everyday
  wpy on | off            master switch, without touching your hooks
  wpy open [--feeds a,b,c] [--layout columns|phones]
  wpy close [--all]
  wpy status              what is open, and what is armed
  wpy stats [--reset]     where your feed time actually went
  wpy feeds               list the built-in feeds
  wpy displays            your monitors, and which one gets the feeds

Any agent
  wpy wrap [--idle N] -- <command...>
                          open while the command runs, close when it exits.
                          --idle N also closes after N seconds of silence,
                          which is how a hook-less agent gets the full effect.
  wpy start / wpy stop    drive it from any tool, one line each

Config
  wpy config                       show the effective config
  wpy config <key>=<value> [...]   e.g. layout=phones display=primary openDelayMs=0

Files live in ${PATHS.root}
`;

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inlineValue] = arg.slice(2).split('=');
      if (inlineValue !== undefined) flags[key] = inlineValue;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else flags[key] = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function list(value) {
  if (!value || value === true) return null;
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function fail(message) {
  process.stderr.write(`white-python: ${message}\n`);
  process.exitCode = 1;
}

async function main() {
  const argv = process.argv.slice(2);
  // Everything after a bare `--` belongs to the wrapped command, untouched.
  const sepIndex = argv.indexOf('--');
  const ownArgs = sepIndex === -1 ? argv : argv.slice(0, sepIndex);
  const restArgs = sepIndex === -1 ? [] : argv.slice(sepIndex + 1);

  const [command = 'help', ...rest] = ownArgs;
  const { flags, positional } = parseFlags(rest);

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;

    case 'version':
    case '--version':
      process.stdout.write(`${require('../package.json').version}\n`);
      return;

    case 'open': {
      const sessionId = flags.session || process.env.WHITE_PYTHON_SESSION_ID || `manual:${process.cwd()}`;
      const result = openWindows({
        sessionId,
        feeds: list(flags.feeds),
        layout: flags.layout && flags.layout !== true ? flags.layout : undefined,
      });
      if (result.skipped === 'disabled') {
        process.stdout.write('white-python is off — run `white-python on` first.\n');
        return;
      }
      if (result.skipped === 'already-open') {
        process.stdout.write('Already open.\n');
        return;
      }
      for (const w of result.opened) {
        process.stdout.write(`  ${w.label}  ${w.rect.width}x${w.rect.height} at ${w.rect.x},${w.rect.y}  (pid ${w.pid})\n`);
      }
      return;
    }

    case 'close': {
      const sessionId = flags.all ? 'all' : flags.session || process.env.WHITE_PYTHON_SESSION_ID || `manual:${process.cwd()}`;
      const result = closeWindows({ sessionId, reason: 'cli' });
      process.stdout.write(`Closed ${result.closed} window(s).\n`);
      return;
    }

    case 'on':
    case 'off': {
      writeConfig({ enabled: command === 'on' });
      if (command === 'off') closeWindows({ sessionId: 'all', reason: 'disabled' });
      process.stdout.write(`white-python is ${command}.\n`);
      return;
    }

    case 'status': {
      const s = status();
      process.stdout.write(`white-python: ${s.enabled ? 'on' : 'off'}\n`);
      process.stdout.write(`feeds: ${s.config.feeds.join(', ')}  layout: ${s.config.layout}  delay: ${s.config.openDelayMs}ms\n`);
      if (!s.sessions.length) {
        process.stdout.write('no windows open\n');
        return;
      }
      for (const session of s.sessions) {
        const when = session.openedAt ? new Date(session.openedAt).toLocaleTimeString() : 'pending';
        process.stdout.write(`\n${session.sessionId}  (since ${when})${session.pending ? ' [armed]' : ''}\n`);
        for (const w of session.windows) {
          process.stdout.write(`  ${w.alive ? '●' : '○'} ${w.feed} (pid ${w.pid})\n`);
        }
      }
      return;
    }

    case 'feeds': {
      for (const [key, feed] of Object.entries(FEEDS)) {
        process.stdout.write(`  ${key.padEnd(10)} ${feed.label.padEnd(18)} ${feed.url}\n`);
      }
      process.stdout.write('\nAny https:// URL works as a feed too.\n');
      return;
    }

    case 'login': {
      await login({ feeds: list(flags.feeds) });
      return;
    }

    case 'stats': {
      if (flags.reset) {
        usage.reset();
        process.stdout.write('Usage history cleared.\n');
        return;
      }
      const entries = usage.readAll();
      if (!entries.length) {
        process.stdout.write('No feed time recorded yet.\n');
        return;
      }
      const s = usage.summarize(entries);
      const fmt = usage.formatDuration;

      process.stdout.write(`today      ${fmt(s.today.ms).padEnd(10)} over ${s.today.stretches} stretch(es)\n`);
      process.stdout.write(`last 7d    ${fmt(s.week.ms).padEnd(10)} over ${s.week.stretches} stretch(es)\n`);
      process.stdout.write(`all time   ${fmt(s.total.ms).padEnd(10)} over ${s.total.stretches} stretch(es)\n`);

      // Scale the bars to the busiest day so the shape is readable regardless
      // of whether the peak is four minutes or four hours.
      const peak = Math.max(...s.days.map((d) => d.ms), 1);
      process.stdout.write('\nlast 7 days\n');
      for (const day of s.days) {
        const label = day.date.toLocaleDateString(undefined, { weekday: 'short' });
        const bar = '█'.repeat(Math.round((day.ms / peak) * 28));
        process.stdout.write(`  ${label}  ${bar}${bar ? ' ' : ''}${day.ms ? fmt(day.ms) : ''}\n`);
      }

      const feeds = Object.entries(s.perFeed).sort((a, b) => b[1] - a[1]);
      if (feeds.length) {
        process.stdout.write('\nby feed\n');
        for (const [feed, ms] of feeds) {
          process.stdout.write(`  ${feed.padEnd(12)} ${fmt(ms)}\n`);
        }
      }
      if (s.longest) {
        process.stdout.write(`\nlongest single stretch: ${fmt(s.longest.ms)} (${new Date(s.longest.end).toLocaleString()})\n`);
      }
      return;
    }

    case 'displays': {
      const config = readConfig();
      const displays = detectDisplays();
      if (!displays) {
        process.stdout.write('Could not enumerate displays on this machine.\n');
        process.stdout.write('Set the geometry by hand: white-python config screen.width=2560 screen.height=1440\n');
        return;
      }
      const chosen = selectDisplay(displays, config.display);
      for (const d of displays) {
        const marks = [d.primary ? 'primary' : null, d === chosen ? '← feeds go here' : null]
          .filter(Boolean)
          .join('  ');
        process.stdout.write(
          `  [${d.index}] ${String(d.name).padEnd(16)} ${d.width}x${d.height} at ${d.x},${d.y}  ${marks}\n`
        );
      }
      process.stdout.write(`\ndisplay = ${config.display}   (change with: white-python config display=primary)\n`);
      return;
    }

    case 'config': {
      if (!positional.length) {
        process.stdout.write(`${JSON.stringify(readConfig(), null, 2)}\n`);
        return;
      }
      let updated;
      for (const pair of positional) {
        const eq = pair.indexOf('=');
        if (eq === -1) return fail(`config expects key=value, got "${pair}"`);
        updated = setConfigPath(pair.slice(0, eq), pair.slice(eq + 1));
      }
      process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`);
      return;
    }

    case 'install': {
      if (flags.codex) {
        const result = install.installCodex();
        process.stdout.write(
          result.changed
            ? `Added the Codex notifier to ${result.file}.\n`
            : `${result.file} already points at white-python.\n`
        );
        process.stdout.write('Codex only notifies on turn completion, so it closes the feeds.\nTo open them too: white-python wrap -- codex\n');
        return;
      }
      const scope = flags.user ? 'user' : 'project';
      const result = install.installClaude({ scope });
      process.stdout.write(`Installed ${result.events.join(', ')} hooks into ${result.file}.\n`);
      process.stdout.write('Restart Claude Code (or run /hooks) to pick them up.\n');
      return;
    }

    case 'uninstall': {
      const scope = flags.user ? 'user' : 'project';
      const result = install.uninstallClaude({ scope });
      process.stdout.write(`Removed ${result.removed} hook(s) from ${result.file}.\n`);
      return;
    }

    case 'wrap': {
      const argvToRun = restArgs.length ? restArgs : positional;
      const idleSeconds = flags.idle && flags.idle !== true ? Number(flags.idle) : 0;
      if (flags.idle && !Number.isFinite(idleSeconds)) return fail('--idle expects a number of seconds');
      process.exitCode = await wrap(argvToRun, { idleSeconds });
      return;
    }

    // The universal interface: any tool that can run a shell command on start
    // and finish can drive white-python with these two lines. Everything else in this
    // CLI is convenience on top.
    case 'start': {
      const sessionId = flags.session && flags.session !== true
        ? flags.session
        : process.env.WHITE_PYTHON_SESSION_ID || `manual:${process.cwd()}`;
      const result = hooks.handleStart({ sessionId, reason: 'external' });
      if (result.reason === 'disabled') process.stdout.write('white-python is off — run `white-python on` first.\n');
      else if (result.armed) process.stdout.write(`Armed: feeds open in ${result.delay}ms unless you stop first.\n`);
      else process.stdout.write('Feeds open.\n');
      return;
    }

    case 'stop': {
      const sessionId = flags.session && flags.session !== true
        ? flags.session
        : process.env.WHITE_PYTHON_SESSION_ID || `manual:${process.cwd()}`;
      const reason = flags.reason && flags.reason !== true ? flags.reason : 'done';
      const result = hooks.handleStop({ sessionId, reason });
      process.stdout.write(result.skipped ? `Left up (closeOn.${reason} is off).\n` : `Closed ${result.closed} window(s).\n`);
      return;
    }

    case 'debug': {
      // Must never throw: this is what someone runs when nothing else works.
      try {
        process.stdout.write(`${debugReport()}\n`);
      } catch (err) {
        process.stdout.write(`debug report failed: ${err.stack || err.message}\n`);
      }
      return;
    }

    case 'doctor': {
      const { config, warnings } = inspectConfig();
      process.stdout.write(`white-python ${require('../package.json').version} on ${process.platform}\n`);
      process.stdout.write(`state:   ${config.enabled ? 'on' : 'off'}\n`);

      const screen = detectScreen(config);
      const where = screen.x || screen.y ? ` at ${screen.x},${screen.y}` : '';
      const how = {
        config: 'from your config',
        display: 'detected, full display list',
        detected: 'detected, single screen',
        fallback: 'NOT DETECTED — guessed',
      }[screen.source] || screen.source;
      process.stdout.write(`screen:  ${screen.width}x${screen.height}${where} (${how})\n`);
      if (screen.source === 'fallback') {
        process.stdout.write('         ↳ detection failed; set it with: white-python config screen.width=2560 screen.height=1440\n');
      }
      const displays = detectDisplays();
      if (displays) {
        const chosen = screen.display;
        process.stdout.write(`display: ${displays.length} attached, using "${config.display}" → ${chosen ? chosen.name : 'n/a'}\n`);
        if (displays.length === 1) {
          process.stdout.write('         ↳ only one display; feeds will cover your editor. A second monitor is where this shines.\n');
        }
      } else {
        process.stdout.write('display: could not enumerate (single-screen mode)\n');
      }

      try {
        const browser = findBrowser(config.browser);
        process.stdout.write(`browser: ${browser.key} (${browser.family}) — ${browser.bin}\n`);
        if (browser.family === 'firefox') {
          process.stdout.write('         ↳ Firefox can\'t be positioned at launch; a Chromium browser lays out much better.\n');
        }
      } catch (err) {
        process.stdout.write(`browser: NOT FOUND — ${err.message}\n`);
      }

      let staleScope = null;
      for (const scope of ['project', 'user']) {
        const status = install.hookStatus(scope);
        const stale = status.hooks.filter((h) => !h.exists);
        let state;
        if (!status.hooks.length) state = 'not installed';
        else if (stale.length) {
          state = `${status.hooks.length} wired, ${stale.length} STALE`;
          staleScope = scope;
        } else state = `${status.hooks.length} wired`;
        process.stdout.write(`hooks:   ${scope.padEnd(7)} ${state.padEnd(22)} (${status.file})\n`);
        if (stale.length) {
          process.stdout.write(`         ↳ they point at ${stale[0].target}, which no longer exists.\n`);
          process.stdout.write('         ↳ every turn will error until you re-install or remove them.\n');
        }
      }
      if (staleScope) {
        process.stdout.write(
          `         ↳ fix: wpy install${staleScope === 'user' ? ' --user' : ''}   (or remove: wpy uninstall${staleScope === 'user' ? ' --user' : ''})\n`
        );
      }

      const rects = require('../src/layout').computeLayout({
        screen,
        count: config.feeds.length,
        layout: config.layout,
        gap: config.gap,
        insets: config.insets || defaultInsets(),
      });
      process.stdout.write(`layout:  ${config.layout} → ${rects.map((r) => `${r.width}x${r.height}@${r.x},${r.y}`).join('  ')}\n`);
      const stored = config.feeds.filter((f) => {
        try {
          return profileState(require('../src/feeds').resolveFeed(f).key).exists;
        } catch {
          return false;
        }
      });
      process.stdout.write(`signin:  ${stored.length}/${config.feeds.length} feeds have a saved profile`);
      process.stdout.write(stored.length < config.feeds.length ? '  — run: wpy login\n' : '\n');
      process.stdout.write(`log:     ${PATHS.log}\n`);
      if (warnings.length) {
        process.stdout.write(`\nconfig repairs (${PATHS.config}):\n`);
        for (const w of warnings) process.stdout.write(`  ! ${w}\n`);
        process.stdout.write('Re-set them with: wpy config <key>=<value>\n');
      }
      return;
    }

    // Hook entrypoints. These sit in the agent's critical path, so they must be
    // fast and must never exit non-zero — a broken hook should cost you the
    // feeds, not your turn.
    case 'hook': {
      const [event = ''] = positional;
      try {
        const payload = await hooks.readHookPayload();
        const sessionId = flags.session && flags.session !== true
          ? flags.session
          : hooks.sessionIdFrom(payload);
        if (event === 'start') {
          hooks.handleStart({ sessionId });
        } else if (event === 'stop') {
          const reason = flags.reason && flags.reason !== true ? flags.reason : 'done';
          hooks.handleStop({ sessionId, reason });
        } else if (event === 'codex') {
          // Codex passes its notification JSON as argv, not stdin.
          hooks.handleStop({ sessionId: hooks.sessionIdFrom({}), reason: 'done' });
        } else {
          log('hook: unknown event', event);
        }
      } catch (err) {
        log('hook: swallowed error —', err.stack || err.message);
      }
      process.exitCode = 0;
      return;
    }

    case '_reap': {
      try {
        await runReaper({
          sessionId: flags.session,
          openId: flags.openId,
          after: Number(flags.after) || 0,
        });
      } catch (err) {
        log('reap: swallowed error —', err.stack || err.message);
      }
      process.exitCode = 0;
      return;
    }

    case '_watch': {
      try {
        await hooks.runWatcher({
          sessionId: flags.session,
          token: flags.token,
          delay: Number(flags.delay) || 0,
        });
      } catch (err) {
        log('watch: swallowed error —', err.stack || err.message);
      }
      process.exitCode = 0;
      return;
    }

    default:
      return fail(`unknown command "${command}". Try: white-python help`);
  }
}

main().catch((err) => {
  fail(err.message);
  log('cli: fatal —', err.stack || err.message);
});

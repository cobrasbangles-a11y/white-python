#!/usr/bin/env node
'use strict';

const { readConfig, writeConfig, setConfigPath, PATHS } = require('../src/config');
const { FEEDS } = require('../src/feeds');
const { openWindows, closeWindows, status } = require('../src/windows');
const { detectScreen, defaultInsets } = require('../src/screen');
const { detectDisplays, selectDisplay } = require('../src/displays');
const { findBrowser } = require('../src/browser');
const hooks = require('../src/hooks');
const install = require('../src/install');
const { wrap } = require('../src/wrap');
const { log } = require('../src/log');

const HELP = `
cobra — pull up TikTok, Instagram Reels and YouTube Shorts side by side while
        your coding agent works, and close them the second it needs you.

Setup
  cobra install [--user]        wire up Claude Code hooks (project, or --user for all repos)
  cobra install --codex         wire up the Codex turn-complete notifier
  cobra uninstall [--user]      remove the hooks again
  cobra doctor                  check browser, screen and hook wiring

Everyday
  cobra on | off                master switch, without touching your hooks
  cobra open [--feeds a,b,c] [--layout columns|phones]
  cobra close [--all]
  cobra status
  cobra wrap -- <command...>    open while any command runs, close when it exits

Config
  cobra config                          show the effective config
  cobra config <key>=<value> [...]      e.g. layout=phones openDelayMs=0 closeOn.done=false
  cobra feeds                           list the built-in feeds
  cobra displays                        list your monitors and which one gets the feeds

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
  process.stderr.write(`cobra: ${message}\n`);
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
      const sessionId = flags.session || process.env.COBRA_SESSION_ID || `manual:${process.cwd()}`;
      const result = openWindows({
        sessionId,
        feeds: list(flags.feeds),
        layout: flags.layout && flags.layout !== true ? flags.layout : undefined,
      });
      if (result.skipped === 'disabled') {
        process.stdout.write('cobra is off — run `cobra on` first.\n');
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
      const sessionId = flags.all ? 'all' : flags.session || process.env.COBRA_SESSION_ID || `manual:${process.cwd()}`;
      const result = closeWindows({ sessionId, reason: 'cli' });
      process.stdout.write(`Closed ${result.closed} window(s).\n`);
      return;
    }

    case 'on':
    case 'off': {
      writeConfig({ enabled: command === 'on' });
      if (command === 'off') closeWindows({ sessionId: 'all', reason: 'disabled' });
      process.stdout.write(`cobra is ${command}.\n`);
      return;
    }

    case 'status': {
      const s = status();
      process.stdout.write(`cobra: ${s.enabled ? 'on' : 'off'}\n`);
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

    case 'displays': {
      const config = readConfig();
      const displays = detectDisplays();
      if (!displays) {
        process.stdout.write('Could not enumerate displays on this machine.\n');
        process.stdout.write('Set the geometry by hand: cobra config screen.width=2560 screen.height=1440\n');
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
      process.stdout.write(`\ndisplay = ${config.display}   (change with: cobra config display=primary)\n`);
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
            : `${result.file} already points at cobra.\n`
        );
        process.stdout.write('Codex only notifies on turn completion, so it closes the feeds.\nTo open them too: cobra wrap -- codex\n');
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
      process.exitCode = await wrap(argvToRun);
      return;
    }

    case 'doctor': {
      const config = readConfig();
      process.stdout.write(`cobra ${require('../package.json').version} on ${process.platform}\n`);
      process.stdout.write(`state:   ${config.enabled ? 'on' : 'off'}\n`);

      const screen = detectScreen(config);
      const where = screen.x || screen.y ? ` at ${screen.x},${screen.y}` : '';
      process.stdout.write(`screen:  ${screen.width}x${screen.height}${where} (${screen.source})\n`);
      if (screen.source === 'fallback') {
        process.stdout.write('         ↳ detection failed; set it with: cobra config screen.width=2560 screen.height=1440\n');
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

      for (const scope of ['project', 'user']) {
        const file = install.settingsPath(scope);
        let wired = 0;
        try {
          const settings = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
          for (const entries of Object.values(settings.hooks || {})) {
            wired += entries.filter((e) => (e.hooks || []).some((h) => String(h.command).includes('cobra.js'))).length;
          }
        } catch {
          /* not installed there */
        }
        process.stdout.write(`hooks:   ${scope.padEnd(7)} ${wired ? `${wired} wired` : 'not installed'}  (${file})\n`);
      }

      const rects = require('../src/layout').computeLayout({
        screen,
        count: config.feeds.length,
        layout: config.layout,
        gap: config.gap,
        insets: config.insets || defaultInsets(),
      });
      process.stdout.write(`layout:  ${config.layout} → ${rects.map((r) => `${r.width}x${r.height}@${r.x},${r.y}`).join('  ')}\n`);
      process.stdout.write(`log:     ${PATHS.log}\n`);
      return;
    }

    // Hook entrypoints. These sit in the agent's critical path, so they must be
    // fast and must never exit non-zero — a broken hook should cost you the
    // feeds, not your turn.
    case 'hook': {
      const [event = ''] = positional;
      try {
        const payload = await hooks.readHookPayload();
        const sessionId = hooks.sessionIdFrom(payload);
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
      return fail(`unknown command "${command}". Try: cobra help`);
  }
}

main().catch((err) => {
  fail(err.message);
  log('cli: fatal —', err.stack || err.message);
});

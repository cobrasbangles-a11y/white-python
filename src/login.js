'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readConfig, PATHS } = require('./config');
const { resolveFeeds } = require('./feeds');
const { openWindows, closeWindows } = require('./windows');
const { log } = require('./log');

/**
 * Has this feed's profile been used at all?
 *
 * Deliberately NOT a claim about being signed in. Chromium keeps cookies in an
 * encrypted SQLite file; reading it properly would mean a native dependency,
 * and a byte-scan heuristic proved unreliable in testing. So this reports the
 * one thing that can be checked honestly — whether a real browser profile
 * exists on disk — and leaves "am I logged in?" to the person looking at the
 * screen.
 */
function profileState(feedKey) {
  const dir = path.join(PATHS.profiles, feedKey);
  const cookies = path.join(dir, 'Default', 'Cookies');
  try {
    const stat = fs.statSync(cookies);
    return { dir, exists: true, bytes: stat.size, usedAt: stat.mtime };
  } catch {
    return { dir, exists: false, bytes: 0, usedAt: null };
  }
}

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    if (!process.stdin.isTTY) return resolve(); // non-interactive: don't hang
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

/**
 * First-run sign-in.
 *
 * Opens every feed in a normal browser window — address bar and all, because
 * OAuth popups and 2FA are painful in a chromeless one — and waits. Each feed
 * keeps its own profile directory under ~/.white-python/profiles, so whatever
 * you sign into here is still signed in every time the feeds open later.
 */
async function login({ feeds, config = readConfig() } = {}) {
  const specs = feeds && feeds.length ? feeds : config.feeds;
  const resolved = resolveFeeds(specs);

  process.stdout.write('Opening each feed in a normal browser window so you can sign in.\n');
  process.stdout.write('These profiles are kept, so this is a one-time thing.\n\n');

  const result = openWindows({
    sessionId: 'login',
    config,
    feeds: specs,
    reason: 'login',
    appMode: false, // real browser chrome: address bar, popups, password manager
  });

  if (result.skipped === 'disabled') {
    process.stdout.write('white-python is off — run `wpy on` first.\n');
    return { signedIn: [] };
  }
  if (result.skipped === 'already-open') {
    process.stdout.write('Feeds are already open — sign in there, then run `wpy close`.\n');
    return { skipped: 'already-open' };
  }

  for (const feed of resolved) process.stdout.write(`  • ${feed.label}\n`);
  await waitForEnter('\nSign in to each one, then press Enter here to close them… ');

  closeWindows({ sessionId: 'login', reason: 'login-done' });

  process.stdout.write('\nSaved profiles:\n');
  const saved = [];
  for (const feed of resolved) {
    const state = profileState(feed.key);
    if (state.exists) saved.push(feed.key);
    process.stdout.write(`  ${state.exists ? '✓' : '·'} ${feed.label.padEnd(20)} ${state.exists ? 'profile stored' : 'nothing stored'}\n`);
  }
  process.stdout.write('\nThese sessions persist. If a site signs you out later, run `wpy login` again.\n');
  log('login: profiles stored for', saved.join(', ') || 'nothing');
  return { signedIn: saved };
}

module.exports = { login, profileState };

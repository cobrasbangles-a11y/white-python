'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const { PATHS, readConfig, ensureRoot } = require('./config');
const { resolveFeeds } = require('./feeds');
const { detectScreen, defaultInsets } = require('./screen');
const { computeLayout } = require('./layout');
const { findBrowser, buildArgs } = require('./browser');
const { reposition } = require('./position');
const state = require('./state');
const usage = require('./usage');
const { log } = require('./log');

function profileDirFor(feedKey) {
  const dir = path.join(PATHS.profiles, feedKey);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function shouldMute(audioMode, index) {
  if (audioMode === 'all') return false;
  if (audioMode === 'none') return true;
  return index !== 0; // "primary": leftmost feed keeps its sound
}

/**
 * Open one window per feed, positioned side by side.
 * Returns { opened: [...], skipped?: reason }.
 */
function openWindows({ sessionId, config = readConfig(), feeds, layout, reason = 'manual' } = {}) {
  if (!sessionId) throw new Error('openWindows requires a sessionId');

  if (!config.enabled) {
    log('open: skipped, cobra is disabled');
    return { opened: [], skipped: 'disabled' };
  }

  const existing = state.getSession(sessionId);
  if (existing && (existing.windows || []).some((w) => state.isAlive(w.pid))) {
    log('open: session', sessionId, 'already has live windows');
    return { opened: existing.windows, skipped: 'already-open' };
  }

  const feedSpecs = feeds && feeds.length ? feeds : config.feeds;
  const resolved = resolveFeeds(feedSpecs);
  const screen = detectScreen(config);
  const rects = computeLayout({
    screen,
    count: resolved.length,
    layout: layout || config.layout,
    gap: config.gap,
    insets: config.insets || defaultInsets(),
  });
  const browser = findBrowser(config.browser);

  ensureRoot();
  fs.mkdirSync(PATHS.profiles, { recursive: true });

  const opened = [];
  resolved.forEach((feed, index) => {
    const rect = rects[index];
    const profileDir = profileDirFor(feed.key);
    const args = buildArgs({
      family: browser.family,
      url: feed.url,
      rect,
      profileDir,
      muted: shouldMute(config.audio, index),
      appMode: config.appMode !== false,
    });

    // detached gives the child its own process group on POSIX, which is what
    // lets close() take down the browser and every renderer it forked.
    const child = spawn(browser.bin, args, {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    });
    child.unref();

    if (browser.family === 'firefox') reposition(child.pid, rect);

    opened.push({ feed: feed.key, label: feed.label, pid: child.pid, rect, profileDir });
    log('open:', feed.key, 'pid', child.pid, 'at', `${rect.x},${rect.y} ${rect.width}x${rect.height}`);
  });

  // openId identifies this particular stretch. The reaper only closes if the
  // id it was armed with is still current, so it can't take down a later
  // stretch that happens to reuse the session.
  const openId = crypto.randomUUID();
  state.updateSession(sessionId, {
    sessionId,
    windows: opened,
    openedAt: Date.now(),
    openReason: reason,
    pendingToken: null,
    browser: browser.key,
    openId,
  });

  const cap = Math.max(0, Number(config.maxOpenMs) || 0);
  if (cap > 0) armReaper(sessionId, openId, cap);

  return { opened, screen, browser, openId };
}

/**
 * Arm the time cap. A detached process sleeps for the cap and then closes the
 * feeds — but only if this stretch is still the one that's open.
 */
function armReaper(sessionId, openId, afterMs) {
  const cli = path.join(__dirname, '..', 'bin', 'cobra.js');
  const child = spawn(
    process.execPath,
    [cli, '_reap', '--session', sessionId, '--openId', openId, '--after', String(afterMs)],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();
  log('open: time cap armed for', afterMs, 'ms');
}

/**
 * Body of the reaper process.
 */
async function runReaper({ sessionId, openId, after }) {
  await new Promise((resolve) => setTimeout(resolve, after));
  const session = state.getSession(sessionId);
  if (!session || session.openId !== openId) {
    log('reap: stretch already ended for', sessionId, '- standing down');
    return { closed: 0 };
  }
  log('reap: time cap reached after', after, 'ms - closing');
  return closeWindows({ sessionId, reason: 'time-cap' });
}

function killPid(pid) {
  if (!state.isAlive(pid)) return false;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
    } else {
      // Negative pid = the whole process group we created with detached:true.
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        process.kill(pid, 'SIGTERM');
      }
    }
    return true;
  } catch (err) {
    log('close: failed to kill', pid, '-', err.message);
    return false;
  }
}

/**
 * Close the windows for one session, or every session when sessionId is "all".
 */
function closeWindows({ sessionId, reason = 'manual' } = {}) {
  const all = state.readState();
  const targets = sessionId && sessionId !== 'all'
    ? [[sessionId, all.sessions[sessionId]]].filter(([, s]) => s)
    : Object.entries(all.sessions);

  let closed = 0;
  for (const [id, session] of targets) {
    let killedHere = 0;
    for (const window of session.windows || []) {
      if (killPid(window.pid)) {
        killedHere += 1;
        log('close:', window.feed, 'pid', window.pid, 'reason', reason);
      }
    }
    closed += killedHere;

    // Only log a stretch that actually had windows up, so an idle Stop hook
    // doesn't pad the numbers with zero-length entries.
    if (killedHere > 0 && session.openedAt) {
      const end = Date.now();
      usage.record({
        session: id,
        start: session.openedAt,
        end,
        ms: end - session.openedAt,
        feeds: (session.windows || []).map((w) => w.feed),
        reason,
      });
    }
    state.clearSession(id);
  }
  if (closed === 0) log('close: nothing to close for', sessionId || 'all');
  return { closed, sessions: targets.length };
}

function status() {
  const pruned = state.pruneState();
  const config = readConfig();
  const sessions = Object.values(pruned.sessions).map((session) => ({
    sessionId: session.sessionId,
    openedAt: session.openedAt,
    pending: !!session.pendingToken,
    windows: (session.windows || []).map((w) => ({
      feed: w.feed,
      pid: w.pid,
      alive: state.isAlive(w.pid),
    })),
  }));
  return { enabled: config.enabled, config, sessions };
}

module.exports = { openWindows, closeWindows, status, profileDirFor, shouldMute, runReaper, armReaper };

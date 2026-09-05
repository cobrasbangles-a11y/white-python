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
function openWindows({ sessionId, config = readConfig(), feeds, layout, reason = 'manual', appMode } = {}) {
  if (!sessionId) throw new Error('openWindows requires a sessionId');

  if (!config.enabled) {
    log('open: skipped, white-python is disabled');
    return { opened: [], skipped: 'disabled' };
  }

  const existing = state.getSession(sessionId);
  if (existing && (existing.windows || []).some((w) => state.isAlive(w.pid))) {
    log('open: session', sessionId, 'already has live windows');
    return { opened: existing.windows, skipped: 'already-open' };
  }

  const feedSpecs = feeds && feeds.length ? feeds : config.feeds;
  const resolved = resolveFeeds(feedSpecs);

  // A feed's profile directory can only have one owner. Chromium routes every
  // launch sharing a --user-data-dir into the single process that already owns
  // it, so a second session's spawns hand off and exit immediately — leaving
  // this session tracking dead pids while live windows belong to someone else,
  // and making its own close a silent no-op. Take ownership first.
  releaseProfiles(sessionId, resolved.map((f) => f.key));
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

  // The identity of this stretch, written BEFORE anything is spawned so a
  // crash part-way through the loop still leaves a record to close against.
  const openId = crypto.randomUUID();
  state.updateSession(sessionId, {
    sessionId,
    windows: [],
    openedAt: Date.now(),
    openReason: reason,
    pendingToken: null,
    browser: browser.key,
    openId,
    stopSeq: state.stopSeqOf(sessionId),
  });

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
      appMode: appMode === undefined ? config.appMode !== false : appMode,
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
    // Commit after every spawn, not once at the end.
    state.updateSession(sessionId, { windows: [...opened] });
    log('open:', feed.key, 'pid', child.pid, 'at', `${rect.x},${rect.y} ${rect.width}x${rect.height}`);
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
  const cli = path.join(__dirname, '..', 'bin', 'white-python.js');
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

/**
 * Close any OTHER session's windows that use these feed profiles.
 *
 * Two sessions cannot both own a profile directory, so the older one is closed
 * rather than left in a state where neither can close it.
 */
function releaseProfiles(sessionId, feedKeys) {
  const wanted = new Set(feedKeys);
  const all = state.readState();
  for (const [id, session] of Object.entries(all.sessions)) {
    if (id === sessionId) continue;
    const clash = (session.windows || []).some((w) => wanted.has(w.feed) && state.isAlive(w.pid));
    if (clash) {
      log('open: session', id, 'already owns one of these profiles - closing it first');
      closeWindows({ sessionId: id, reason: 'profile-taken-over' });
    }
  }
}

// A synchronous pause, so a hook can confirm the browser actually died before
// it reports success. Node has no sync sleep; this is the standard trick.
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable: skip the grace period */
  }
}

function signal(pid, sig) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
    } else {
      // Negative pid = the whole process group we created with detached:true.
      try {
        process.kill(-pid, sig);
      } catch {
        process.kill(pid, sig);
      }
    }
    return true;
  } catch (err) {
    log('close: signal', sig, 'to', pid, 'failed -', err.message);
    return false;
  }
}

/**
 * Ask the browser to quit, then make sure it did.
 *
 * Reporting "closed" on the strength of one un-escalated SIGTERM meant a
 * browser that ignored it stayed on screen while the record was thrown away,
 * leaving nothing able to try again.
 */
function killPid(pid, profileDir) {
  if (!state.isAlive(pid)) return false;
  // A recycled pid belongs to somebody else now. Signalling it would kill an
  // unrelated process, so treat it as already gone.
  if (!state.isOurProcess(pid, profileDir)) {
    log('close: pid', pid, 'is no longer our browser (recycled) - leaving it alone');
    return false;
  }
  signal(pid, 'SIGTERM');
  if (!state.isAlive(pid)) return true;
  sleepSync(400);
  if (!state.isAlive(pid)) return true;
  log('close: pid', pid, 'ignored SIGTERM - escalating');
  signal(pid, 'SIGKILL');
  sleepSync(200);
  const gone = !state.isAlive(pid);
  if (!gone) log('close: pid', pid, 'SURVIVED - keeping it on record to retry');
  return gone;
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
    const survivors = [];
    for (const window of session.windows || []) {
      if (killPid(window.pid, window.profileDir)) {
        killedHere += 1;
        log('close:', window.feed, 'pid', window.pid, 'reason', reason);
      } else if (state.isAlive(window.pid)) {
        survivors.push(window);
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
    state.markStopped(id);
    // Anything that refused to die stays on the books so the next close, the
    // time cap, or `close --all` can have another go at it.
    if (survivors.length) {
      state.updateSession(id, { sessionId: id, windows: survivors });
      log('close:', survivors.length, 'window(s) survived and remain tracked');
    }
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

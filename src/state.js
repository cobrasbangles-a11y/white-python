'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { PATHS, ensureRoot } = require('./config');
const { log } = require('./log');

// State is keyed by agent session id so two Claude Code sessions open in two
// terminals don't close each other's windows.
function emptyState() {
  return { version: 1, sessions: {} };
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PATHS.state, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.sessions) return emptyState();
    return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') log('state: unreadable, starting fresh —', err.message);
    return emptyState();
  }
}

// Write to a temp file and rename, so a hook that dies mid-write can't leave a
// truncated state file behind for the next one to trip over.
function writeState(state) {
  ensureRoot();
  const tmp = path.join(PATHS.root, `.state.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, PATHS.state);
}

// A killed browser we spawned gets orphaned to init, and until init reaps it
// the pid still answers kill(0) as a zombie. Treating that as "open" would make
// us refuse to reopen the feeds, so zombies count as dead.
function isZombie(pid) {
  if (process.platform !== 'linux') return false;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 3 is the state char, but comm (field 2) may contain spaces or
    // parens — so start scanning after the last ')'.
    const after = stat.slice(stat.lastIndexOf(')') + 1).trim();
    return after.startsWith('Z');
  } catch {
    return false;
  }
}

/**
 * Read a live process's command line, or null if that isn't possible.
 *
 * Used to prove a pid still belongs to the browser we launched. Pids are
 * recycled, so "this pid is alive" is not the same as "this is still our
 * window" — without the check, a close could signal an unrelated process that
 * happened to inherit the number.
 */
function commandLineOf(pid) {
  if (process.platform === 'linux') {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32') {
    // Slower than /proc, but a close happens rarely and signalling the wrong
    // process is worse than a few hundred milliseconds.
    try {
      return execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`,
        ],
        { encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'] }
      );
    } catch {
      return null;
    }
  }
  try {
    return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * Is this pid still the browser we launched for this profile?
 *
 * The profile directory is unique per feed and appears in the browser's own
 * argv, which makes it a reliable marker. When the command line can't be read
 * (Windows, or a permissions failure) this returns true rather than blocking a
 * legitimate close — the pid check alone is the fallback, as before.
 */
function isOurProcess(pid, profileDir) {
  if (!profileDir) return true;
  const cmd = commandLineOf(pid);
  if (cmd === null) return true;
  return cmd.includes(profileDir);
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM means the pid exists but belongs to someone else.
    return err.code === 'EPERM';
  }
  return !isZombie(pid);
}

const LOCK_DIR = () => path.join(PATHS.root, '.state.lock');

/**
 * Serialize read-modify-write on state.json across processes.
 *
 * Hooks, the watcher and the reaper are separate processes that all rewrite
 * this file. Without a lock, one reading before another writes silently drops
 * the other's changes — and losing a window record means losing the only
 * handle anything has for closing that window.
 *
 * mkdir is atomic on every platform we support. A lock older than the timeout
 * is assumed to belong to a process that died holding it and is broken, so a
 * crash can never wedge the tool permanently.
 */
function withLock(fn, { timeoutMs = 2000, staleMs = 10000 } = {}) {
  ensureRoot();
  const dir = LOCK_DIR();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') break; // can't lock at all: proceed unlocked
      let age = 0;
      try {
        age = Date.now() - fs.statSync(dir).mtimeMs;
      } catch {
        continue; // vanished between calls; try again
      }
      if (age > staleMs) {
        log('state: breaking a stale lock');
        try {
          fs.rmdirSync(dir);
        } catch {
          /* someone else got there first */
        }
        continue;
      }
      if (Date.now() > deadline) {
        log('state: lock wait timed out, proceeding without it');
        break;
      }
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      } catch {
        /* no SharedArrayBuffer: spin */
      }
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(dir);
    } catch {
      /* already gone */
    }
  }
}

function getSession(sessionId) {
  return readState().sessions[sessionId] || null;
}

function updateSession(sessionId, patch) {
  return withLock(() => {
    const state = readState();
    const current = state.sessions[sessionId] || { sessionId };
    state.sessions[sessionId] = { ...current, ...patch };
    writeState(state);
    return state.sessions[sessionId];
  });
}

/**
 * Record that this session was told to stop.
 *
 * Deleting the record outright loses the fact that a stop happened, which
 * matters when a watcher is mid-open at the time: it would commit its windows
 * on top of the deletion and leave them up forever. The tombstone keeps a
 * monotonic stopSeq so an in-flight open can notice it was superseded.
 */
function markStopped(sessionId) {
  return withLock(() => {
    const state = readState();
    const current = state.sessions[sessionId] || {};
    state.sessions[sessionId] = {
      sessionId,
      windows: [],
      pendingToken: null,
      stopSeq: (current.stopSeq || 0) + 1,
    };
    writeState(state);
    return state.sessions[sessionId].stopSeq;
  });
}

function stopSeqOf(sessionId) {
  const session = readState().sessions[sessionId];
  return (session && session.stopSeq) || 0;
}

function clearSession(sessionId) {
  const state = readState();
  delete state.sessions[sessionId];
  writeState(state);
}

// Drop sessions whose browser processes are all gone (user closed the windows
// by hand, machine rebooted, hook never fired). Keeps the file from growing.
function pruneState() {
  const state = readState();
  let changed = false;
  for (const [id, session] of Object.entries(state.sessions)) {
    const windows = (session.windows || []).filter((w) => isAlive(w.pid));
    if (windows.length !== (session.windows || []).length) changed = true;
    if (windows.length === 0 && !session.pendingToken && !session.stopSeq) {
      delete state.sessions[id];
      changed = true;
    } else {
      state.sessions[id] = { ...session, windows };
    }
  }
  if (changed) writeState(state);
  return state;
}

module.exports = {
  readState,
  writeState,
  getSession,
  updateSession,
  clearSession,
  markStopped,
  stopSeqOf,
  pruneState,
  isAlive,
  isOurProcess,
  commandLineOf,
  withLock,
};

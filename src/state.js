'use strict';

const fs = require('node:fs');
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

function getSession(sessionId) {
  return readState().sessions[sessionId] || null;
}

function updateSession(sessionId, patch) {
  const state = readState();
  const current = state.sessions[sessionId] || { sessionId };
  state.sessions[sessionId] = { ...current, ...patch };
  writeState(state);
  return state.sessions[sessionId];
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
};

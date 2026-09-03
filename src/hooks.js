'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');

const { readConfig } = require('./config');
const { openWindows, closeWindows } = require('./windows');
const state = require('./state');
const { log } = require('./log');

const CLI = path.join(__dirname, '..', 'bin', 'white-python.js');

// Hooks run in the agent's critical path. Read stdin with a hard deadline so a
// hosting agent that opens the pipe but never writes can't stall a turn.
function readHookPayload(timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let raw = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

// Every agent gives us something session-shaped; fall back to the working
// directory so two repos still get independent state.
function sessionIdFrom(payload = {}) {
  return (
    payload.session_id ||
    payload.sessionId ||
    process.env.WHITE_PYTHON_SESSION_ID ||
    `cwd:${payload.cwd || process.cwd()}`
  );
}

/**
 * The agent started working. Arm a detached watcher that opens the windows once
 * the turn has been running for openDelayMs — a two-second turn shouldn't
 * summon three browser windows.
 */
function handleStart({ sessionId, config = readConfig(), reason = 'agent-busy' }) {
  if (!config.enabled) {
    log('hook start: disabled, ignoring');
    return { armed: false, reason: 'disabled' };
  }

  const delay = Math.max(0, Number(config.openDelayMs) || 0);
  if (delay === 0) {
    openWindows({ sessionId, config, reason });
    return { armed: false, opened: true };
  }

  // The token is the cancellation mechanism: a stop event nulls it out, and the
  // watcher only opens if the token it was armed with is still the current one.
  const token = crypto.randomUUID();
  state.updateSession(sessionId, { sessionId, pendingToken: token, armedAt: Date.now(), openReason: reason });

  const child = spawn(
    process.execPath,
    [CLI, '_watch', '--session', sessionId, '--token', token, '--delay', String(delay)],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();

  log('hook start: armed watcher for', sessionId, 'in', delay, 'ms');
  return { armed: true, token, delay };
}

/**
 * The agent wants something (a question, a permission prompt) or has finished.
 * Either way the windows go away.
 */
function handleStop({ sessionId, config = readConfig(), reason = 'done' }) {
  const gate = {
    question: config.closeOn?.question !== false,
    done: config.closeOn?.done !== false,
    'session-end': config.closeOn?.sessionEnd !== false,
  };
  if (gate[reason] === false) {
    log('hook stop: closeOn.' + reason + ' is off, leaving windows up');
    return { closed: 0, skipped: reason };
  }

  // Cancel any watcher that hasn't fired yet, then close whatever is open.
  const session = state.getSession(sessionId);
  if (session?.pendingToken) state.updateSession(sessionId, { pendingToken: null });

  const result = closeWindows({ sessionId, reason });
  log('hook stop:', reason, '- closed', result.closed, 'window(s)');
  return result;
}

/**
 * Body of the detached watcher process.
 */
async function runWatcher({ sessionId, token, delay }) {
  await new Promise((resolve) => setTimeout(resolve, delay));

  const session = state.getSession(sessionId);
  if (!session || session.pendingToken !== token) {
    log('watch: token superseded or cancelled for', sessionId, '- standing down');
    return { opened: false, reason: 'cancelled' };
  }
  const config = readConfig();
  if (!config.enabled) return { opened: false, reason: 'disabled' };

  log('watch: agent still busy after', delay, 'ms - opening feeds');
  const result = openWindows({ sessionId, config, reason: session.openReason || 'agent-busy' });
  return { opened: result.opened.length > 0, ...result };
}

module.exports = { readHookPayload, sessionIdFrom, handleStart, handleStop, runWatcher, CLI };

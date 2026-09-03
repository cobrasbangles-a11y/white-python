'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const { readConfig } = require('./config');
const { openWindows, closeWindows } = require('./windows');
const { log } = require('./log');

/**
 * `cobra wrap -- <command...>`
 *
 * The escape hatch for agents with no hook system: open the feeds while the
 * command runs, close them the moment it exits — including on Ctrl-C. The
 * child keeps the real terminal (stdio: inherit), so an interactive TUI agent
 * behaves exactly as it would unwrapped.
 */
function wrap(argv, { config = readConfig() } = {}) {
  if (!argv.length) throw new Error('Nothing to run. Usage: cobra wrap -- <command> [args...]');

  const sessionId = `wrap:${crypto.randomUUID()}`;
  const delay = Math.max(0, Number(config.openDelayMs) || 0);
  let opened = false;
  let closed = false;

  const openTimer = setTimeout(() => {
    try {
      openWindows({ sessionId, config, reason: 'wrap' });
      opened = true;
    } catch (err) {
      // A missing browser must never take the user's agent down with it.
      log('wrap: open failed —', err.message);
      process.stderr.write(`cobra: ${err.message}\n`);
    }
  }, delay);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(openTimer);
    if (opened) closeWindows({ sessionId, reason: 'wrap-exit' });
  };

  const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit' });

  const forward = (signal) => {
    process.on(signal, () => {
      cleanup();
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    });
  };
  forward('SIGINT');
  forward('SIGTERM');
  process.on('exit', cleanup);

  return new Promise((resolve) => {
    child.on('error', (err) => {
      cleanup();
      process.stderr.write(`cobra: could not run "${argv[0]}": ${err.message}\n`);
      resolve(127);
    });
    child.on('exit', (code, signal) => {
      cleanup();
      resolve(signal ? 128 : code ?? 0);
    });
  });
}

module.exports = { wrap };

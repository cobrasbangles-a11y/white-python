'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const { readConfig } = require('./config');
const { openWindows, closeWindows } = require('./windows');
const { ActivityMonitor } = require('./activity');
const { log } = require('./log');

/**
 * `white-python wrap [--idle N] -- <command...>`
 *
 * The escape hatch for agents with no hook system: open the feeds while the
 * command runs, close them the moment it exits — including on Ctrl-C.
 *
 * With --idle, output is also watched: N seconds of silence from a still-running
 * command is treated as "it's waiting for you" and closes the feeds, which
 * reopen when it starts talking again. That gives any line-based agent CLI the
 * same open/close behaviour Claude Code gets from real hooks.
 */
function wrap(argv, { config = readConfig(), idleSeconds = 0 } = {}) {
  if (!argv.length) throw new Error('Nothing to run. Usage: white-python wrap -- <command> [args...]');

  const sessionId = `wrap:${crypto.randomUUID()}`;
  const delay = Math.max(0, Number(config.openDelayMs) || 0);
  const idleMs = Math.max(0, Number(idleSeconds) || 0) * 1000;

  let openTimer = null;
  let opened = false;
  let finished = false;

  const openNow = () => {
    if (finished || opened) return;
    try {
      openWindows({ sessionId, config, reason: 'wrap' });
      opened = true;
    } catch (err) {
      // A missing browser must never take the user's agent down with it.
      log('wrap: open failed —', err.message);
      process.stderr.write(`white-python: ${err.message}\n`);
    }
  };

  const scheduleOpen = () => {
    if (finished || opened || openTimer) return;
    openTimer = setTimeout(() => {
      openTimer = null;
      openNow();
    }, delay);
    openTimer.unref?.();
  };

  const closeNow = (reason) => {
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = null;
    }
    if (!opened) return;
    closeWindows({ sessionId, reason });
    opened = false;
  };

  // Only pipe output when we actually need to watch it. Plain `wrap` inherits
  // the real terminal so a full-screen TUI agent renders exactly as it would
  // unwrapped; --idle trades that for the ability to see the output.
  const watching = idleMs > 0;
  const monitor = watching
    ? new ActivityMonitor({
        idleMs,
        onIdle: () => {
          log('wrap: quiet for', idleMs, 'ms - assuming it wants you');
          closeNow('wrap-idle');
        },
        onActive: () => {
          log('wrap: output resumed - back to work');
          scheduleOpen();
        },
      })
    : null;

  const child = spawn(argv[0], argv.slice(1), {
    stdio: watching ? ['inherit', 'pipe', 'pipe'] : 'inherit',
  });

  if (watching) {
    monitor.start();
    // Mirror the child's output through untouched; we only tap it for timing.
    child.stdout?.on('data', (chunk) => {
      process.stdout.write(chunk);
      monitor.touch();
    });
    child.stderr?.on('data', (chunk) => {
      process.stderr.write(chunk);
      monitor.touch();
    });
  }

  scheduleOpen();

  const cleanup = () => {
    if (finished) return;
    finished = true;
    monitor?.stop();
    closeNow('wrap-exit');
  };

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
  // SIGHUP is what a closing terminal sends. Without it, quitting the terminal
  // left all three windows on screen with nothing able to address them.
  forward('SIGINT');
  forward('SIGTERM');
  forward('SIGHUP');
  forward('SIGQUIT');
  process.on('exit', cleanup);

  return new Promise((resolve) => {
    let settled = false;
    child.on('error', (err) => {
      cleanup();
      process.stderr.write(`white-python: could not run "${argv[0]}": ${err.message}\n`);
      if (!settled) {
        settled = true;
        resolve(127);
      }
    });
    // 'exit' fires when the command itself ends; 'close' waits for its stdio
    // pipes, which a surviving grandchild can hold open indefinitely. Closing
    // the feeds must not wait on that, so clean up on whichever comes first
    // and only resolve once, with a short grace period for output to flush.
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      // In --idle mode we hold the child's pipes. A grandchild that outlives
      // the command keeps them open, and an open pipe keeps THIS process
      // alive — so the wrapper would sit there long after the agent exited
      // and the feeds had closed. Let them go once the command is done.
      for (const stream of [child.stdout, child.stderr]) {
        try {
          stream?.destroy();
        } catch {
          /* already gone */
        }
      }
      resolve(signal ? 128 : code ?? 0);
    };
    child.on('exit', (code, signal) => {
      cleanup();
      const t = setTimeout(() => finish(code, signal), 2000);
      t.unref?.();
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

module.exports = { wrap };

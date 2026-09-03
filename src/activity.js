'use strict';

/**
 * Turns a stream of output into a busy/idle signal.
 *
 * An agent CLI with no hook system still tells you what it's doing: it prints
 * while it works, and goes quiet when it wants something from you. Silence for
 * long enough is the closest generic equivalent of "the agent has a question".
 *
 * Pure timer logic with no I/O, so the state machine can be tested directly
 * rather than by racing a real subprocess.
 */
class ActivityMonitor {
  /**
   * @param {object} options
   * @param {number} options.idleMs Silence this long counts as idle.
   * @param {() => void} [options.onIdle]   Fired once per active→idle edge.
   * @param {() => void} [options.onActive] Fired once per idle→active edge.
   * @param {typeof setTimeout} [options.setTimer] Injectable for tests.
   */
  constructor({ idleMs, onIdle, onActive, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.idleMs = idleMs;
    this.onIdle = onIdle || (() => {});
    this.onActive = onActive || (() => {});
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.state = 'active';
    this.timer = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.arm();
    return this;
  }

  arm() {
    if (this.stopped) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.stopped || this.state === 'idle') return;
      this.state = 'idle';
      this.onIdle();
    }, this.idleMs);
    // Never let the idle timer be the reason the process stays alive.
    this.timer?.unref?.();
  }

  /** Call on every chunk of output from the wrapped command. */
  touch() {
    if (this.stopped) return;
    const wasIdle = this.state === 'idle';
    this.state = 'active';
    this.arm();
    // Edge-triggered: only the idle→active transition fires, not every chunk.
    if (wasIdle) this.onActive();
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
}

module.exports = { ActivityMonitor };

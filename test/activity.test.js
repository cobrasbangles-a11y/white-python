'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ActivityMonitor } = require('../src/activity');

/**
 * A hand-cranked clock, so the idle state machine is tested deterministically
 * instead of by sleeping and hoping.
 */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

function build(idleMs = 1000) {
  const clock = fakeClock();
  const events = [];
  const monitor = new ActivityMonitor({
    idleMs,
    onIdle: () => events.push('idle'),
    onActive: () => events.push('active'),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, events, monitor };
}

test('silence for the full window flips it to idle', () => {
  const { clock, events, monitor } = build(1000);
  monitor.start();
  clock.advance(999);
  assert.deepStrictEqual(events, [], 'not yet — one millisecond short');
  clock.advance(1);
  assert.deepStrictEqual(events, ['idle']);
  assert.strictEqual(monitor.state, 'idle');
});

test('steady output keeps it active indefinitely', () => {
  const { clock, events, monitor } = build(1000);
  monitor.start();
  for (let i = 0; i < 10; i += 1) {
    clock.advance(900);
    monitor.touch();
  }
  clock.advance(900);
  assert.deepStrictEqual(events, [], 'a chatty agent never looks idle');
  assert.strictEqual(monitor.state, 'active');
});

test('output after a silence fires exactly one active edge', () => {
  const { clock, events, monitor } = build(1000);
  monitor.start();
  clock.advance(1000);
  monitor.touch();
  monitor.touch();
  monitor.touch();
  assert.deepStrictEqual(events, ['idle', 'active'], 'edge-triggered, not per-chunk');
});

test('a full work / question / work cycle produces the right transitions', () => {
  const { clock, events, monitor } = build(2000);
  monitor.start();

  // Working: prints steadily.
  for (let i = 0; i < 5; i += 1) {
    clock.advance(400);
    monitor.touch();
  }
  // Asks a question and waits.
  clock.advance(2000);
  // You answer; it gets back to work.
  monitor.touch();
  clock.advance(400);
  monitor.touch();
  // Finishes and goes quiet again.
  clock.advance(2000);

  assert.deepStrictEqual(events, ['idle', 'active', 'idle']);
});

test('stop() silences the monitor for good', () => {
  const { clock, events, monitor } = build(1000);
  monitor.start();
  monitor.stop();
  clock.advance(5000);
  monitor.touch();
  clock.advance(5000);
  assert.deepStrictEqual(events, [], 'nothing fires after stop');
  assert.strictEqual(clock.pending, 0, 'no timer left holding the process open');
});

test('idle does not re-fire while it stays quiet', () => {
  const { clock, events, monitor } = build(1000);
  monitor.start();
  clock.advance(1000);
  clock.advance(10000);
  assert.deepStrictEqual(events, ['idle'], 'one edge, not one per window');
});

test('touch before the window closes simply resets the countdown', () => {
  const { clock, events, monitor } = build(1000);
  monitor.start();
  clock.advance(600);
  monitor.touch();
  clock.advance(600);
  assert.deepStrictEqual(events, [], 'the clock restarted at the touch');
  clock.advance(400);
  assert.deepStrictEqual(events, ['idle']);
});

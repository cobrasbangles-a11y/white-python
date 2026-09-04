'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mergeConfig, DEFAULTS } = require('../src/config');
const { shouldMute } = require('../src/windows');

test('nested config objects merge instead of being replaced wholesale', () => {
  const merged = mergeConfig(DEFAULTS, { closeOn: { question: false } });
  assert.strictEqual(merged.closeOn.question, false);
  assert.strictEqual(merged.closeOn.done, true, 'unrelated keys must survive');
  assert.strictEqual(merged.closeOn.sessionEnd, true);
});

test('arrays are replaced, not concatenated', () => {
  const merged = mergeConfig(DEFAULTS, { feeds: ['youtube'] });
  assert.deepStrictEqual(merged.feeds, ['youtube']);
});

test('undefined values do not clobber defaults', () => {
  const merged = mergeConfig(DEFAULTS, { layout: undefined });
  assert.strictEqual(merged.layout, DEFAULTS.layout);
});

test('audio modes decide which windows get muted', () => {
  // "primary": the leftmost feed keeps sound so you get one soundtrack, not three.
  assert.deepStrictEqual([0, 1, 2].map((i) => shouldMute('primary', i)), [false, true, true]);
  assert.deepStrictEqual([0, 1, 2].map((i) => shouldMute('all', i)), [false, false, false]);
  assert.deepStrictEqual([0, 1, 2].map((i) => shouldMute('none', i)), [true, true, true]);
});

// --- config validation ---
//
// Every one of these arrived as a real crash: `wpy config feeds=tiktok` stored
// the string "tiktok", and doctor, status and open then died on .filter, .join
// and .map respectively. Config values come from a hand-editable JSON file and
// from `key=value` on a command line, so nothing can be assumed well-shaped.

const { normalizeConfig } = require('../src/config');

test('a single feed with no comma is still a list', () => {
  const { config, warnings } = normalizeConfig({ ...DEFAULTS, feeds: 'tiktok' });
  assert.deepStrictEqual(config.feeds, ['tiktok']);
  assert.ok(warnings.some((w) => w.startsWith('feeds:')), 'the repair should be reported');
});

test('a comma-separated feed string splits and trims', () => {
  const { config } = normalizeConfig({ ...DEFAULTS, feeds: ' tiktok , youtube ' });
  assert.deepStrictEqual(config.feeds, ['tiktok', 'youtube']);
});

test('an empty feeds value falls back to the defaults rather than opening nothing', () => {
  for (const empty of ['', '   ', [], [''], null, undefined, 42]) {
    const { config } = normalizeConfig({ ...DEFAULTS, feeds: empty });
    assert.deepStrictEqual(config.feeds, DEFAULTS.feeds, `failed for ${JSON.stringify(empty)}`);
  }
});

test('a non-numeric number never reaches the layout as NaN', () => {
  for (const key of ['openDelayMs', 'maxOpenMs', 'gap']) {
    const { config } = normalizeConfig({ ...DEFAULTS, [key]: 'abc' });
    assert.strictEqual(config[key], DEFAULTS[key], `${key} should fall back`);
    assert.ok(Number.isFinite(config[key]));
  }
});

test('negative delays are clamped, not passed through', () => {
  const { config } = normalizeConfig({ ...DEFAULTS, openDelayMs: -5000, gap: -10 });
  assert.strictEqual(config.openDelayMs, 0);
  assert.strictEqual(config.gap, 0);
});

test('an unknown layout or audio mode falls back instead of rendering nothing', () => {
  assert.strictEqual(normalizeConfig({ ...DEFAULTS, layout: 'bogus' }).config.layout, DEFAULTS.layout);
  assert.strictEqual(normalizeConfig({ ...DEFAULTS, audio: 'loud' }).config.audio, DEFAULTS.audio);
});

test('booleans accept the strings a command line produces', () => {
  assert.strictEqual(normalizeConfig({ ...DEFAULTS, enabled: 'false' }).config.enabled, false);
  assert.strictEqual(normalizeConfig({ ...DEFAULTS, enabled: 'true' }).config.enabled, true);
  assert.strictEqual(normalizeConfig({ ...DEFAULTS, enabled: 'maybe' }).config.enabled, DEFAULTS.enabled);
});

test('closeOn keeps its shape even when handed a scalar', () => {
  const { config } = normalizeConfig({ ...DEFAULTS, closeOn: 'nope' });
  assert.deepStrictEqual(config.closeOn, DEFAULTS.closeOn);
  const partial = normalizeConfig({ ...DEFAULTS, closeOn: { question: false } }).config;
  assert.strictEqual(partial.closeOn.question, false);
  assert.strictEqual(partial.closeOn.done, true, 'unspecified keys keep their defaults');
});

test('screen and insets accept an object or null, nothing else', () => {
  assert.strictEqual(normalizeConfig({ ...DEFAULTS, screen: 5 }).config.screen, null);
  assert.deepStrictEqual(normalizeConfig({ ...DEFAULTS, insets: { top: 25 } }).config.insets, { top: 25 });
  assert.strictEqual(normalizeConfig({ ...DEFAULTS, insets: 'big' }).config.insets, null);
});

test('display accepts a name or an index but not an object', () => {
  assert.strictEqual(normalizeConfig({ ...DEFAULTS, display: 'HDMI-1' }).config.display, 'HDMI-1');
  assert.strictEqual(normalizeConfig({ ...DEFAULTS, display: 1 }).config.display, 1);
  assert.strictEqual(normalizeConfig({ ...DEFAULTS, display: { a: 1 } }).config.display, DEFAULTS.display);
});

test('a fully valid config passes through untouched and silent', () => {
  const { config, warnings } = normalizeConfig({ ...DEFAULTS });
  assert.deepStrictEqual(config, DEFAULTS);
  assert.deepStrictEqual(warnings, []);
});

test('the normalized config is always usable by the code that consumes it', () => {
  // The exact operations that crashed: feeds.filter / feeds.join / feeds.map.
  for (const bad of ['tiktok', '', 42, null, {}, ['']]) {
    const { config } = normalizeConfig({ ...DEFAULTS, feeds: bad, gap: 'abc', layout: 'x' });
    assert.doesNotThrow(() => {
      config.feeds.filter(Boolean);
      config.feeds.join(', ');
      config.feeds.map((f) => f);
    }, `feeds unusable for ${JSON.stringify(bad)}`);
  }
});

// --- stop-during-open race ---
//
// Opening is not instant: detecting displays and finding a browser both shell
// out, then three spawns follow. A stop arriving inside that window used to
// find nothing recorded yet, close nothing, and then be overwritten by the
// open committing — leaving windows up after the agent had already finished.

const fsx = require('node:fs');
const osx = require('node:os');
const pathx = require('node:path');

test('a stop leaves a tombstone so an in-flight open can tell it was superseded', () => {
  const home = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'wp-race-'));
  const prev = process.env.WHITE_PYTHON_HOME;
  process.env.WHITE_PYTHON_HOME = home;
  // Fresh module registry so state.js picks up the temp home.
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  const state = require('../src/state');
  try {
    state.updateSession('s', { sessionId: 's', pendingToken: 'T' });
    const before = state.stopSeqOf('s');

    const seq = state.markStopped('s');
    assert.strictEqual(seq, before + 1, 'a stop must advance the counter');
    assert.notStrictEqual(state.stopSeqOf('s'), before, 'an in-flight open must be able to see it');

    // The record survives so the counter is not lost.
    assert.ok(state.getSession('s'), 'stop must leave a tombstone, not delete the record');
    assert.deepStrictEqual(state.getSession('s').windows, [], 'no windows should remain recorded');

    // Two stops in a row keep advancing, so repeated turns stay distinguishable.
    assert.strictEqual(state.markStopped('s'), seq + 1);
  } finally {
    process.env.WHITE_PYTHON_HOME = prev;
    for (const k of Object.keys(require.cache)) delete require.cache[k];
    fsx.rmSync(home, { recursive: true, force: true });
  }
});

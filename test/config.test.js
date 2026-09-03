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

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { computeLayout } = require('../src/layout');

const HD = { width: 1920, height: 1080 };

test('columns fill the screen edge to edge with no gaps or overlaps', () => {
  const rects = computeLayout({ screen: HD, count: 3 });
  assert.strictEqual(rects.length, 3);
  assert.strictEqual(rects[0].x, 0);
  for (let i = 1; i < rects.length; i += 1) {
    assert.strictEqual(rects[i].x, rects[i - 1].x + rects[i - 1].width, 'columns must be flush');
  }
  const last = rects[rects.length - 1];
  assert.strictEqual(last.x + last.width, HD.width, 'row must end at the screen edge');
  assert.ok(rects.every((r) => r.height === HD.height));
});

test('rounding remainder lands in the last column, never lost', () => {
  const rects = computeLayout({ screen: { width: 1001, height: 800 }, count: 3 });
  const total = rects.reduce((sum, r) => sum + r.width, 0);
  assert.strictEqual(total, 1001);
});

test('insets are respected on every side', () => {
  const insets = { top: 25, right: 10, bottom: 5, left: 15 };
  const rects = computeLayout({ screen: HD, count: 3, insets });
  assert.strictEqual(rects[0].x, 15);
  assert.strictEqual(rects[0].y, 25);
  assert.strictEqual(rects[0].height, 1080 - 25 - 5);
  const last = rects[rects.length - 1];
  assert.strictEqual(last.x + last.width, HD.width - 10);
});

test('gaps separate windows without overflowing the screen', () => {
  const gap = 20;
  const rects = computeLayout({ screen: HD, count: 3, gap });
  for (let i = 1; i < rects.length; i += 1) {
    assert.strictEqual(rects[i].x - (rects[i - 1].x + rects[i - 1].width), gap);
  }
  const last = rects[rects.length - 1];
  assert.ok(last.x + last.width <= HD.width);
});

test('phones layout keeps a 9:16-ish shape and centers the row', () => {
  const rects = computeLayout({ screen: HD, count: 3, layout: 'phones' });
  const aspect = rects[0].width / rects[0].height;
  assert.ok(Math.abs(aspect - 9 / 16) < 0.02, `aspect was ${aspect}`);
  const rowWidth = rects[rects.length - 1].x + rects[rects.length - 1].width - rects[0].x;
  const leftMargin = rects[0].x;
  const rightMargin = HD.width - (rects[0].x + rowWidth);
  assert.ok(Math.abs(leftMargin - rightMargin) <= 1, 'row should be centered');
});

test('phones shrink to fit rather than running off a narrow screen', () => {
  const narrow = { width: 1280, height: 1600 };
  const rects = computeLayout({ screen: narrow, count: 3, layout: 'phones' });
  const last = rects[rects.length - 1];
  assert.ok(last.x + last.width <= narrow.width, 'must not overflow');
  assert.ok(rects[0].height <= narrow.height);
});

test('a single feed takes the whole screen', () => {
  const [only] = computeLayout({ screen: HD, count: 1 });
  assert.deepStrictEqual(only, { x: 0, y: 0, width: HD.width, height: HD.height });
});

test('zero feeds produces no windows', () => {
  assert.deepStrictEqual(computeLayout({ screen: HD, count: 0 }), []);
});

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point white-python at a throwaway home BEFORE requiring anything that reads config,
// so these tests can never touch a real usage history.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'white-python-usage-'));
process.env.WHITE_PYTHON_HOME = TMP_HOME;

const test = require('node:test');
const assert = require('node:assert');
const usage = require('../src/usage');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

test.after(() => fs.rmSync(TMP_HOME, { recursive: true, force: true }));

test('durations read the way a human would say them', () => {
  assert.strictEqual(usage.formatDuration(0), '0s');
  assert.strictEqual(usage.formatDuration(45 * 1000), '45s');
  assert.strictEqual(usage.formatDuration(90 * 1000), '1m 30s');
  assert.strictEqual(usage.formatDuration(3 * 60 * MINUTE), '3h 0m');
  assert.strictEqual(usage.formatDuration(95 * MINUTE), '1h 35m');
});

test('today excludes yesterday, even a few minutes before midnight', () => {
  const now = new Date('2026-09-03T10:00:00').getTime();
  const justBeforeMidnight = new Date('2026-09-02T23:58:00').getTime();
  const thisMorning = new Date('2026-09-03T09:00:00').getTime();

  const summary = usage.summarize(
    [
      { start: justBeforeMidnight, end: justBeforeMidnight + MINUTE, ms: MINUTE, feeds: ['tiktok'] },
      { start: thisMorning, end: thisMorning + 5 * MINUTE, ms: 5 * MINUTE, feeds: ['tiktok'] },
    ],
    now
  );

  assert.strictEqual(summary.today.ms, 5 * MINUTE, 'yesterday must not count toward today');
  assert.strictEqual(summary.today.stretches, 1);
  assert.strictEqual(summary.total.ms, 6 * MINUTE);
});

test('the week window covers seven days and drops the eighth', () => {
  const now = new Date('2026-09-03T12:00:00').getTime();
  const entries = [0, 3, 6, 7, 9].map((daysAgo) => ({
    start: now - daysAgo * DAY,
    end: now - daysAgo * DAY,
    ms: MINUTE,
    feeds: ['youtube'],
  }));
  const summary = usage.summarize(entries, now);
  assert.strictEqual(summary.week.stretches, 3, 'today, 3d and 6d ago are in; 7d and 9d are out');
  assert.strictEqual(summary.total.stretches, 5);
});

test('per-feed totals attribute a stretch to every feed that was up', () => {
  const now = Date.now();
  const summary = usage.summarize(
    [
      { start: now, end: now, ms: 10 * MINUTE, feeds: ['tiktok', 'youtube'] },
      { start: now, end: now, ms: 5 * MINUTE, feeds: ['tiktok'] },
    ],
    now
  );
  assert.strictEqual(summary.perFeed.tiktok, 15 * MINUTE);
  assert.strictEqual(summary.perFeed.youtube, 10 * MINUTE);
  assert.strictEqual(summary.perFeed.instagram, undefined);
});

test('the seven-day chart always has seven buckets, oldest first', () => {
  const now = new Date('2026-09-03T12:00:00').getTime();
  const summary = usage.summarize([], now);
  assert.strictEqual(summary.days.length, 7);
  for (let i = 1; i < summary.days.length; i += 1) {
    assert.ok(summary.days[i].date > summary.days[i - 1].date, 'buckets must run oldest to newest');
  }
  assert.ok(summary.days.every((d) => d.ms === 0));
});

test('longest stretch picks the real maximum', () => {
  const now = Date.now();
  const summary = usage.summarize(
    [
      { start: now, end: now, ms: 2 * MINUTE, feeds: [] },
      { start: now, end: now, ms: 40 * MINUTE, feeds: [] },
      { start: now, end: now, ms: 9 * MINUTE, feeds: [] },
    ],
    now
  );
  assert.strictEqual(summary.longest.ms, 40 * MINUTE);
});

test('an empty history summarizes to zeroes instead of NaN', () => {
  const summary = usage.summarize([], Date.now());
  assert.strictEqual(summary.total.ms, 0);
  assert.strictEqual(summary.today.ms, 0);
  assert.strictEqual(summary.longest, null);
});

test('a torn line is skipped without losing the rest of the history', () => {
  fs.writeFileSync(
    usage.USAGE_FILE,
    [
      JSON.stringify({ start: 1, end: 2, ms: 1000, feeds: ['tiktok'] }),
      '{ truncated mid-write',
      JSON.stringify({ start: 3, end: 4, ms: 2000, feeds: ['youtube'] }),
    ].join('\n') + '\n'
  );
  const entries = usage.readAll();
  assert.strictEqual(entries.length, 2, 'good lines on both sides of the tear survive');
  assert.strictEqual(entries[0].ms + entries[1].ms, 3000);
});

test('record appends and reset clears', () => {
  usage.reset();
  assert.deepStrictEqual(usage.readAll(), []);
  usage.record({ start: 1, end: 2, ms: 500, feeds: ['tiktok'] });
  usage.record({ start: 3, end: 4, ms: 700, feeds: ['tiktok'] });
  assert.strictEqual(usage.readAll().length, 2);
  usage.reset();
  assert.deepStrictEqual(usage.readAll(), [], 'reset on an already-clean history is safe');
});

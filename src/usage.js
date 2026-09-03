'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PATHS, ensureRoot } = require('./config');
const { log } = require('./log');

const USAGE_FILE = path.join(PATHS.root, 'usage.jsonl');

// Append-only JSONL: one line per stretch of feeds being open. Cheap to write
// from a hook, trivially inspectable, and a corrupt line can never poison more
// than itself.
function record(entry) {
  try {
    ensureRoot();
    fs.appendFileSync(USAGE_FILE, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    log('usage: could not record —', err.message);
  }
}

function readAll() {
  try {
    return fs
      .readFileSync(USAGE_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null; // skip a torn line rather than losing the whole history
        }
      })
      .filter((entry) => entry && Number.isFinite(entry.ms) && entry.ms >= 0);
  } catch (err) {
    if (err.code !== 'ENOENT') log('usage: could not read —', err.message);
    return [];
  }
}

function reset() {
  try {
    fs.rmSync(USAGE_FILE, { force: true });
    return true;
  } catch (err) {
    log('usage: could not reset —', err.message);
    return false;
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Aggregate the history into the numbers worth showing: today, the last seven
 * days, all time, plus per-feed totals and the longest single stretch.
 */
function summarize(entries = readAll(), now = Date.now()) {
  const todayStart = startOfDay(now);
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;

  const sum = (list) => list.reduce((total, e) => total + e.ms, 0);
  const today = entries.filter((e) => e.end >= todayStart);
  const week = entries.filter((e) => e.end >= weekStart);

  const perFeed = {};
  for (const entry of entries) {
    for (const feed of entry.feeds || []) {
      perFeed[feed] = (perFeed[feed] || 0) + entry.ms;
    }
  }

  const longest = entries.reduce((best, e) => (!best || e.ms > best.ms ? e : best), null);

  // Group the last seven days into buckets for the bar chart, oldest first.
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const dayStart = todayStart - i * 24 * 60 * 60 * 1000;
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    days.push({
      date: new Date(dayStart),
      ms: sum(entries.filter((e) => e.end >= dayStart && e.end < dayEnd)),
    });
  }

  return {
    total: { ms: sum(entries), stretches: entries.length },
    today: { ms: sum(today), stretches: today.length },
    week: { ms: sum(week), stretches: week.length },
    perFeed,
    longest,
    days,
  };
}

module.exports = { record, readAll, reset, summarize, formatDuration, USAGE_FILE };

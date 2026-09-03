'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { resolveFeed, resolveFeeds, FEEDS } = require('../src/feeds');

test('the three headline feeds resolve to real URLs', () => {
  for (const key of ['tiktok', 'instagram', 'youtube']) {
    const feed = resolveFeed(key);
    assert.strictEqual(feed.key, key);
    assert.match(feed.url, /^https:\/\//);
  }
  assert.match(FEEDS.youtube.url, /shorts/);
  assert.match(FEEDS.instagram.url, /reels/);
});

test('a bare URL becomes a feed with a hostname label', () => {
  const feed = resolveFeed('https://news.ycombinator.com/');
  assert.strictEqual(feed.label, 'news.ycombinator.com');
  assert.strictEqual(feed.url, 'https://news.ycombinator.com/');
});

test('profile keys stay filesystem-safe', () => {
  const feed = resolveFeed('https://www.example.co.uk/a/b');
  assert.match(feed.key, /^[a-z0-9-]+$/);
});

test('an unknown feed name fails loudly with the valid options', () => {
  assert.throws(() => resolveFeed('myspace'), /Unknown feed .*tiktok/s);
});

test('resolveFeeds preserves left-to-right order', () => {
  const feeds = resolveFeeds(['youtube', 'tiktok']);
  assert.deepStrictEqual(feeds.map((f) => f.key), ['youtube', 'tiktok']);
});

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

test('a bare URL becomes a feed with a readable label', () => {
  const feed = resolveFeed('https://news.ycombinator.com/');
  assert.strictEqual(feed.label, 'news.ycombinator.com');
  assert.strictEqual(feed.url, 'https://news.ycombinator.com/');
});

test('a URL label keeps the path, so two feeds on one host are tellable apart', () => {
  assert.strictEqual(resolveFeed('https://www.youtube.com/shorts').label, 'youtube.com/shorts');
  assert.strictEqual(resolveFeed('https://www.youtube.com/@someone').label, 'youtube.com/@someone');
});

// The key names the browser profile directory. Two feeds sharing a profile end
// up inside ONE browser process, which silently stacks both windows in the same
// place — caught by opening three same-host URLs against a real browser.
test('two URLs on the same host get distinct keys', () => {
  const feeds = resolveFeeds([
    'http://127.0.0.1:8899/tiktok.html',
    'http://127.0.0.1:8899/instagram.html',
    'http://127.0.0.1:8899/youtube.html',
  ]);
  const keys = feeds.map((f) => f.key);
  assert.strictEqual(new Set(keys).size, 3, `keys collided: ${keys.join(', ')}`);
});

test('paths that differ only after the hostname still get distinct keys', () => {
  const [a, b] = resolveFeeds(['https://youtube.com/shorts', 'https://youtube.com/@someone']);
  assert.notStrictEqual(a.key, b.key);
});

test('the same feed listed twice still gets one profile each', () => {
  const keys = resolveFeeds(['tiktok', 'tiktok', 'tiktok']).map((f) => f.key);
  assert.strictEqual(new Set(keys).size, 3, `keys collided: ${keys.join(', ')}`);
  assert.strictEqual(keys[0], 'tiktok', 'the first keeps the plain name');
});

test('built-in feed keys never change, so logins survive upgrades', () => {
  assert.deepStrictEqual(
    resolveFeeds(['tiktok', 'instagram', 'youtube']).map((f) => f.key),
    ['tiktok', 'instagram', 'youtube']
  );
});

test('a URL key is stable across calls, so its login persists', () => {
  const once = resolveFeed('https://youtube.com/shorts').key;
  const twice = resolveFeed('https://youtube.com/shorts').key;
  assert.strictEqual(once, twice);
});

test('profile keys stay filesystem-safe', () => {
  for (const spec of ['https://www.example.co.uk/a/b', 'https://x.com/?q=a&b=c#frag', 'https://[::1]:80/p']) {
    assert.match(resolveFeed(spec).key, /^[a-z0-9-]+$/, `unsafe key for ${spec}`);
  }
});

test('an unknown feed name fails loudly with the valid options', () => {
  assert.throws(() => resolveFeed('myspace'), /Unknown feed .*tiktok/s);
});

test('resolveFeeds preserves left-to-right order', () => {
  const feeds = resolveFeeds(['youtube', 'tiktok']);
  assert.deepStrictEqual(feeds.map((f) => f.key), ['youtube', 'tiktok']);
});

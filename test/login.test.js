'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point at a throwaway home before anything reads config.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-login-'));
process.env.WHITE_PYTHON_HOME = TMP_HOME;

const test = require('node:test');
const assert = require('node:assert');
const { profileState } = require('../src/login');
const { PATHS } = require('../src/config');

test.after(() => fs.rmSync(TMP_HOME, { recursive: true, force: true }));

function makeProfile(key, { cookies = true } = {}) {
  const dir = path.join(PATHS.profiles, key, 'Default');
  fs.mkdirSync(dir, { recursive: true });
  if (cookies) fs.writeFileSync(path.join(dir, 'Cookies'), Buffer.alloc(20480));
  return dir;
}

test('a feed with no profile reports nothing stored', () => {
  const state = profileState('never-opened');
  assert.strictEqual(state.exists, false);
  assert.strictEqual(state.bytes, 0);
  assert.strictEqual(state.usedAt, null);
});

test('a profile with a cookie store reports as stored, with its size', () => {
  makeProfile('tiktok');
  const state = profileState('tiktok');
  assert.strictEqual(state.exists, true);
  assert.strictEqual(state.bytes, 20480);
  assert.ok(state.usedAt instanceof Date);
});

// Chromium creates the profile directory the moment it launches but writes the
// cookie store later, so a directory alone must not count as stored — that was
// exactly the false positive worth avoiding.
test('a profile directory without a cookie store does not count as stored', () => {
  makeProfile('half-started', { cookies: false });
  assert.strictEqual(profileState('half-started').exists, false);
});

test('profileState reports the path it checked, for error messages', () => {
  const state = profileState('somefeed');
  assert.ok(state.dir.endsWith(path.join('profiles', 'somefeed')));
});

test('feed keys are read literally, never interpreted as paths', () => {
  // Keys come from resolveFeed and are already sanitised; this pins that
  // profileState itself does not resolve anything surprising.
  const state = profileState('a-b-c-12345678');
  assert.ok(state.dir.includes('a-b-c-12345678'));
  assert.strictEqual(state.exists, false);
});

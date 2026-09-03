'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const HOME = os.homedir();
const ROOT = process.env.WHITE_PYTHON_HOME || path.join(HOME, '.white-python');

const PATHS = {
  root: ROOT,
  config: path.join(ROOT, 'config.json'),
  state: path.join(ROOT, 'state.json'),
  log: path.join(ROOT, 'white-python.log'),
  profiles: path.join(ROOT, 'profiles'),
};

// Everything a user might reasonably want to change, with the defaults that
// make the "just turn it on" path work without a config file at all.
const DEFAULTS = {
  // Which feeds to open, left to right. See src/feeds.js for the registry.
  feeds: ['tiktok', 'instagram', 'youtube'],

  // "columns"  -> three full-height columns filling the screen
  // "phones"   -> three 9:16 phone-shaped windows, centered as a row
  layout: 'columns',

  // "primary" -> only the leftmost feed keeps audio, the rest are muted
  // "all"     -> every window keeps audio (chaos)
  // "none"    -> everything muted
  audio: 'primary',

  // Don't open anything until the agent has been busy this long. Stops the
  // windows flashing open and shut on "what does this function do" turns.
  openDelayMs: 8000,

  // Hard cap on how long the feeds stay up in one stretch, even if the agent
  // is still grinding away. 0 disables it. A long build shouldn't cost you the
  // whole afternoon.
  maxOpenMs: 0,

  // Which agent events close the windows again.
  closeOn: {
    question: true,
    done: true,
    sessionEnd: true,
  },

  // "auto" or an explicit executable path / known key (chrome, brave, edge,
  // chromium, firefox).
  browser: 'auto',

  // Chromeless app windows. Turn off if you want a normal browser window with
  // tabs and an address bar.
  appMode: true,

  // Which monitor the feeds land on: "auto" (a second display if you have one,
  // otherwise the main one), "primary", "secondary", a 0-based index, or an
  // output name like "HDMI-1". The point of "auto" is that on a two-monitor
  // desk the feeds never cover your editor.
  display: 'auto',

  // Override screen detection entirely, e.g. {"width": 3440, "height": 1440}.
  // Takes precedence over `display`.
  screen: null,

  // Space kept clear around the whole row of windows.
  insets: null, // null -> platform default (mac keeps the menu bar clear)

  // Gap between adjacent windows, in points.
  gap: 0,

  // Master switch. `white-python off` flips this without touching your hooks.
  enabled: true,
};

function ensureRoot() {
  fs.mkdirSync(PATHS.root, { recursive: true });
  return PATHS.root;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// One level of structural merge is all the config shape needs: only `closeOn`,
// `screen` and `insets` are nested, and none of them are arrays.
function mergeConfig(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(base[key])) {
      out[key] = { ...base[key], ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function readConfig() {
  let onDisk = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(PATHS.config, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`${PATHS.config} is not valid JSON: ${err.message}`);
    }
  }
  return mergeConfig(DEFAULTS, onDisk);
}

function writeConfig(patch) {
  ensureRoot();
  let onDisk = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(PATHS.config, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const next = mergeConfig(onDisk, patch);
  fs.writeFileSync(PATHS.config, `${JSON.stringify(next, null, 2)}\n`);
  return mergeConfig(DEFAULTS, next);
}

// Accepts "layout=phones" / "openDelayMs=0" / "closeOn.question=false" and
// coerces the value to something JSON-shaped.
function setConfigPath(dottedKey, rawValue) {
  const segments = dottedKey.split('.');
  let value;
  if (rawValue === 'true') value = true;
  else if (rawValue === 'false') value = false;
  else if (rawValue === 'null') value = null;
  else if (rawValue !== '' && !Number.isNaN(Number(rawValue))) value = Number(rawValue);
  else if (rawValue.includes(',')) value = rawValue.split(',').map((s) => s.trim()).filter(Boolean);
  else value = rawValue;

  const patch = {};
  let cursor = patch;
  for (let i = 0; i < segments.length - 1; i += 1) {
    cursor[segments[i]] = {};
    cursor = cursor[segments[i]];
  }
  cursor[segments[segments.length - 1]] = value;
  return writeConfig(patch);
}

module.exports = { PATHS, DEFAULTS, ensureRoot, readConfig, writeConfig, setConfigPath, mergeConfig };

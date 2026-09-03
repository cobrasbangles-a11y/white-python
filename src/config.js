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

// What each setting is allowed to be. Values arrive from a JSON file a human
// may have edited and from `config key=value` on the command line, where
// everything starts life as a string — so nothing can be trusted to have the
// shape the rest of the code expects. A single feed written as
// `config feeds=tiktok` used to be stored as the string "tiktok", and then
// doctor, status and open all died on `.filter`, `.join` and `.map`.
const SCHEMA = {
  feeds: { kind: 'array' },
  layout: { kind: 'enum', values: ['columns', 'phones'] },
  audio: { kind: 'enum', values: ['primary', 'all', 'none'] },
  openDelayMs: { kind: 'number', min: 0 },
  maxOpenMs: { kind: 'number', min: 0 },
  gap: { kind: 'number', min: 0 },
  closeOn: { kind: 'object' },
  browser: { kind: 'string' },
  display: { kind: 'display' },
  screen: { kind: 'objectOrNull' },
  insets: { kind: 'objectOrNull' },
  appMode: { kind: 'boolean' },
  enabled: { kind: 'boolean' },
};

// Only a list, or a comma-separated string, is a plausible way to write one.
// Anything else (a number, an object) is a mistake worth falling back from
// rather than coercing into a feed name that resolveFeed would reject later.
function toArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
  return [];
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return null;
}

/**
 * Coerce a config into the shape the rest of the code relies on, repairing
 * what can be repaired and falling back to the default otherwise.
 *
 * Runs on every read, so a config file already broken on disk heals itself
 * rather than crashing every command until someone deletes it by hand.
 *
 * @returns {{config: object, warnings: string[]}}
 */
function normalizeConfig(raw) {
  const config = { ...DEFAULTS, ...raw };
  const warnings = [];
  const reset = (key, why) => {
    warnings.push(`${key}: ${why} — using ${JSON.stringify(DEFAULTS[key])}`);
    config[key] = DEFAULTS[key];
  };

  for (const [key, rule] of Object.entries(SCHEMA)) {
    const value = config[key];

    switch (rule.kind) {
      case 'array': {
        const list = toArray(value);
        if (!list.length) {
          reset(key, `no usable entries in ${JSON.stringify(value)}`);
        } else {
          if (!Array.isArray(value)) {
            warnings.push(`${key}: was not a list — read as ${JSON.stringify(list)}`);
          }
          config[key] = list;
        }
        break;
      }
      case 'enum':
        if (!rule.values.includes(value)) reset(key, `${JSON.stringify(value)} is not one of ${rule.values.join(', ')}`);
        break;
      case 'number': {
        const n = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(n)) reset(key, `${JSON.stringify(value)} is not a number`);
        else config[key] = Math.max(rule.min ?? -Infinity, n);
        break;
      }
      case 'boolean': {
        const b = toBoolean(value);
        if (b === null) reset(key, `${JSON.stringify(value)} is not true or false`);
        else config[key] = b;
        break;
      }
      case 'string':
        if (typeof value !== 'string' || !value.trim()) reset(key, `${JSON.stringify(value)} is not a name or path`);
        break;
      case 'display':
        // "auto" / "primary" / "secondary" / an index / an output name.
        if (typeof value !== 'string' && !Number.isFinite(value)) {
          reset(key, `${JSON.stringify(value)} is not a display name or index`);
        }
        break;
      case 'object':
        if (!isPlainObject(value)) reset(key, `${JSON.stringify(value)} is not a set of options`);
        else config[key] = { ...DEFAULTS[key], ...value };
        break;
      case 'objectOrNull':
        if (value !== null && !isPlainObject(value)) reset(key, `${JSON.stringify(value)} is not a set of options`);
        break;
      default:
        break;
    }
  }

  return { config, warnings };
}

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

function readRaw() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PATHS.config, 'utf8'));
    return isPlainObject(parsed) ? parsed : {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`${PATHS.config} is not valid JSON: ${err.message}`);
    }
    return {};
  }
}

function readConfig() {
  return normalizeConfig(mergeConfig(DEFAULTS, readRaw())).config;
}

/** Same as readConfig, but keeps the repair notes so doctor can show them. */
function inspectConfig() {
  return normalizeConfig(mergeConfig(DEFAULTS, readRaw()));
}

function writeConfig(patch) {
  ensureRoot();
  const next = mergeConfig(readRaw(), patch);
  // Normalize before writing so the file on disk is always a shape the rest
  // of the code can use, not just whatever was typed.
  const { config } = normalizeConfig(mergeConfig(DEFAULTS, next));
  const toStore = {};
  for (const key of Object.keys(next)) if (key in config) toStore[key] = config[key];
  fs.writeFileSync(PATHS.config, `${JSON.stringify(toStore, null, 2)}\n`);
  return config;
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

module.exports = {
  PATHS,
  DEFAULTS,
  ensureRoot,
  readConfig,
  inspectConfig,
  normalizeConfig,
  writeConfig,
  setConfigPath,
  mergeConfig,
};

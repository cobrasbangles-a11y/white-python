'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { PATHS, inspectConfig, DEFAULTS } = require('./config');
const { CANDIDATES, findBrowser } = require('./browser');
const { detectDisplays } = require('./displays');
const { settingsPath, hookStatus } = require('./install');

/**
 * Everything needed to diagnose a failure on someone else's machine, in one
 * paste. Every probe is individually guarded: a broken environment is exactly
 * when this has to keep working, so it reports what failed instead of failing.
 */
function line(out, label, value) {
  out.push(`${String(label).padEnd(14)} ${value}`);
}

function safe(fn, fallback = 'ERROR') {
  try {
    const value = fn();
    return value === undefined || value === null ? fallback : value;
  } catch (err) {
    return `${fallback}: ${err.message}`;
  }
}

// A file that simply isn't there yet is normal, not an error worth printing an
// ENOENT for — this report is what people paste when asking for help, so its
// absences should read as absences.
function readOr(file, missing) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text || missing;
  } catch (err) {
    return err.code === 'ENOENT' ? missing : `unreadable: ${err.message}`;
  }
}

function debugReport() {
  const out = [];

  out.push('=== white-python debug ===');
  line(out, 'version', safe(() => require('../package.json').version));
  line(out, 'platform', `${process.platform} ${process.arch} (${safe(() => os.release())})`);
  line(out, 'node', process.version);
  line(out, 'node path', process.execPath);
  line(out, 'cli path', path.join(__dirname, '..', 'bin', 'white-python.js'));
  line(out, 'cwd', process.cwd());
  line(out, 'home', PATHS.root);
  line(out, 'HOME env', process.env.WHITE_PYTHON_HOME || '(unset)');

  out.push('');
  out.push('--- config ---');
  line(out, 'file', PATHS.config);
  line(out, 'exists', fs.existsSync(PATHS.config) ? 'yes' : 'no (using defaults)');
  if (fs.existsSync(PATHS.config)) out.push(`raw:\n${readOr(PATHS.config, '(empty)')}`);
  const inspected = safe(() => inspectConfig(), null);
  if (inspected && inspected.config) {
    for (const key of Object.keys(DEFAULTS)) {
      line(out, `  ${key}`, JSON.stringify(inspected.config[key]));
    }
    if (inspected.warnings.length) {
      out.push('repairs:');
      for (const w of inspected.warnings) out.push(`  ! ${w}`);
    }
  } else {
    out.push(`config could not be read: ${inspected}`);
  }

  out.push('');
  out.push('--- displays ---');
  const displays = safe(() => detectDisplays(), null);
  if (Array.isArray(displays)) {
    for (const d of displays) {
      line(out, `  [${d.index}] ${d.name}`, `${d.width}x${d.height} at ${d.x},${d.y}${d.primary ? '  primary' : ''}`);
    }
  } else {
    out.push(`  enumeration failed or unsupported: ${displays}`);
    // On macOS the JXA probe is the usual suspect; show its raw error.
    if (process.platform === 'darwin') {
      out.push('  raw JXA probe:');
      out.push(
        '    ' +
          safe(() =>
            execFileSync('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); String($.NSScreen.screens.count)'], {
              encoding: 'utf8',
              timeout: 6000,
            }).trim()
          )
      );
      out.push('  raw Finder probe:');
      out.push(
        '    ' +
          safe(() =>
            execFileSync('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop'], {
              encoding: 'utf8',
              timeout: 6000,
            }).trim()
          )
      );
    }
  }

  out.push('');
  out.push('--- browser search ---');
  const list = CANDIDATES[process.platform] || CANDIDATES.linux;
  for (const c of list) {
    let found = 'no';
    try {
      if (c.bin.includes(path.sep)) {
        fs.accessSync(c.bin, fs.constants.X_OK);
        found = 'YES';
      } else {
        execFileSync(process.platform === 'win32' ? 'where' : 'which', [c.bin], { stdio: 'ignore', timeout: 4000 });
        found = 'YES (on PATH)';
      }
    } catch {
      found = 'no';
    }
    line(out, `  ${c.key}`, `${found.padEnd(14)} ${c.bin}`);
  }
  line(out, 'selected', safe(() => JSON.stringify(findBrowser(inspected?.config?.browser || 'auto'))));

  out.push('');
  out.push('--- hooks ---');
  for (const scope of ['project', 'user']) {
    const status = safe(() => hookStatus(scope), null);
    if (!status || !status.hooks) {
      line(out, `  ${scope}`, `could not read: ${status}`);
      continue;
    }
    const stale = status.hooks.filter((h) => !h.exists);
    const state = status.hooks.length
      ? `${status.hooks.length} wired${stale.length ? `, ${stale.length} STALE` : ''}`
      : 'not installed';
    line(out, `  ${scope}`, `${state.padEnd(22)} ${status.file}`);
    for (const h of status.hooks) {
      line(out, `    ${h.event}`, `${h.exists ? 'ok  ' : 'MISSING'} ${h.target || h.command}`);
    }
  }

  out.push('');
  out.push('--- profiles ---');
  let profiles = [];
  try {
    profiles = fs.readdirSync(PATHS.profiles);
  } catch {
    profiles = [];
  }
  out.push(profiles.length ? `  ${profiles.join(', ')}` : '  none yet (run: wpy login)');

  out.push('');
  out.push('--- last 30 log lines ---');
  const log = readOr(PATHS.log, null);
  out.push(log ? log.split('\n').slice(-30).join('\n') : '  (no log yet)');

  return out.join('\n');
}

module.exports = { debugReport };

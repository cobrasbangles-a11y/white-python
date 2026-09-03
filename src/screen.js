'use strict';

const { execFileSync } = require('node:child_process');
const { log } = require('./log');
const { detectDisplays, selectDisplay } = require('./displays');

const FALLBACK = { width: 1920, height: 1080 };

function run(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    timeout: 4000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

// macOS: ask the Finder for the desktop bounds. This reports *points*, which is
// the coordinate space Chrome's --window-position uses; system_profiler would
// hand back physical pixels and put everything off-screen on a Retina display.
function detectDarwin() {
  try {
    const out = run('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop']);
    const nums = out.trim().split(',').map((n) => Number(n.trim()));
    if (nums.length === 4 && nums.every(Number.isFinite)) {
      return { width: nums[2] - nums[0], height: nums[3] - nums[1] };
    }
  } catch (err) {
    log('screen: osascript failed', err.message);
  }
  return null;
}

function detectLinux() {
  try {
    const out = run('xdpyinfo', []);
    const match = out.match(/dimensions:\s+(\d+)x(\d+)/);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  } catch {
    /* fall through to xrandr */
  }
  try {
    const out = run('xrandr', ['--current']);
    const match = out.match(/current\s+(\d+)\s*x\s*(\d+)/);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  } catch (err) {
    log('screen: xdpyinfo and xrandr both unavailable', err.message);
  }
  return null;
}

// WorkingArea rather than Bounds, so we don't slide a window under the taskbar.
function detectWindows() {
  try {
    const out = run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; ' +
        '$a=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; ' +
        'Write-Output "$($a.Width)x$($a.Height)"',
    ]);
    const match = out.match(/(\d+)x(\d+)/);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  } catch (err) {
    log('screen: powershell probe failed', err.message);
  }
  return null;
}

/**
 * Work out the rectangle the feeds should be laid out inside, in browser
 * coordinates (top-left origin, primary display at 0,0).
 *
 * Four layers, most specific first: an explicit config override, full display
 * enumeration (which is what makes "put it on the second monitor" work), a
 * single-screen probe for machines where enumeration isn't available, and
 * finally a hardcoded guess so we always return something usable.
 */
function detectScreen(config = {}) {
  if (config.screen && config.screen.width && config.screen.height) {
    return { x: 0, y: 0, ...config.screen, source: 'config' };
  }

  const displays = detectDisplays();
  if (displays) {
    const chosen = selectDisplay(displays, config.display ?? 'auto');
    if (chosen) {
      return {
        x: chosen.x,
        y: chosen.y,
        width: chosen.width,
        height: chosen.height,
        source: 'display',
        display: chosen,
        displayCount: displays.length,
      };
    }
  }

  let detected = null;
  if (process.platform === 'darwin') detected = detectDarwin();
  else if (process.platform === 'win32') detected = detectWindows();
  else detected = detectLinux();

  if (detected && detected.width > 0 && detected.height > 0) {
    return { x: 0, y: 0, ...detected, source: 'detected' };
  }

  log('screen: falling back to', FALLBACK);
  return { x: 0, y: 0, ...FALLBACK, source: 'fallback' };
}

// The menu bar on macOS is always on top; leaving it clear keeps the first
// window's title area reachable.
function defaultInsets() {
  if (process.platform === 'darwin') return { top: 25, right: 0, bottom: 0, left: 0 };
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

module.exports = { detectScreen, defaultInsets, FALLBACK };

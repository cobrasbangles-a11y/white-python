'use strict';

const { execFileSync } = require('node:child_process');
const { log } = require('./log');

// Chromium takes its geometry from launch flags, so this is only ever needed to
// rescue a Firefox window. Best effort by design: a browser that ends up in the
// wrong place is a worse outcome than no browser, but not by much, so failures
// here are logged and swallowed.
function repositionLinux(pid, rect) {
  try {
    const out = execFileSync('wmctrl', ['-lp'], { encoding: 'utf8', timeout: 4000 });
    const line = out.split('\n').find((l) => l.split(/\s+/)[2] === String(pid));
    if (!line) return false;
    const windowId = line.split(/\s+/)[0];
    execFileSync(
      'wmctrl',
      ['-i', '-r', windowId, '-e', `0,${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`],
      { stdio: 'ignore', timeout: 4000 }
    );
    return true;
  } catch (err) {
    log('position: wmctrl unavailable or failed —', err.message);
    return false;
  }
}

function reposition(pid, rect) {
  if (process.platform === 'linux') return repositionLinux(pid, rect);
  log('position: no repositioner for', process.platform, '- window placement left to the browser');
  return false;
}

module.exports = { reposition };

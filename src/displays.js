'use strict';

const { execFileSync } = require('node:child_process');
const { log } = require('./log');

// A display is reported in the coordinate space browsers actually use for
// window placement: top-left origin, +Y downward, with the primary display's
// top-left corner at (0, 0). Every platform probe below normalises into that.
//   { index, name, x, y, width, height, primary }

function run(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    timeout: 6000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Convert NSScreen frames into browser coordinates.
 *
 * NSScreen's origin is the bottom-left of the primary display with +Y upward;
 * browsers place windows from the top-left with +Y downward. Flipping through
 * the primary's full height is what keeps a monitor stacked above or below the
 * main one from landing on the opposite side of the desktop.
 *
 * Exported so the flip can be tested without a Mac attached.
 */
function framesToDisplays(frames) {
  if (!Array.isArray(frames) || !frames.length) return null;
  // A probe that returns junk must yield null, not NaN geometry that would
  // place windows off-screen.
  const usable = frames.every(
    (f) => f && ['x', 'y', 'w', 'h', 'fullH'].every((k) => Number.isFinite(Number(f[k])))
  );
  if (!usable) return null;
  // screens[0] is the display containing the origin — the primary.
  const primaryHeight = Number(frames[0].fullH);
  return frames.map((f, index) => ({
    index,
    name: index === 0 ? 'Main display' : `Display ${index + 1}`,
    x: Math.round(Number(f.x)),
    y: Math.round(primaryHeight - (Number(f.y) + Number(f.h))),
    width: Math.round(Number(f.w)),
    height: Math.round(Number(f.h)),
    primary: index === 0,
  }));
}

/**
 * macOS via JXA + the AppKit bridge.
 *
 * NSScreen uses a bottom-left origin with +Y upward, so every display has to be
 * flipped through the primary's height to land in browser coordinates. Without
 * this, a second monitor above or below the main one ends up mirrored onto the
 * wrong side of the desktop.
 */
function detectDarwin() {
  // .js converts the ObjC NSArray into a real JS array. Iterating the ObjC
  // object directly (screens.count / objectAtIndex) is brittle across JXA
  // versions, and every value is coerced with Number() because struct fields
  // can arrive as ObjC numbers rather than JS ones.
  const script = `
    ObjC.import("AppKit");
    var out = [];
    var screens = $.NSScreen.screens.js;
    for (var i = 0; i < screens.length; i++) {
      var s = screens[i];
      var v = s.visibleFrame;
      var f = s.frame;
      out.push({
        x: Number(v.origin.x), y: Number(v.origin.y),
        w: Number(v.size.width), h: Number(v.size.height),
        fullH: Number(f.size.height)
      });
    }
    JSON.stringify(out);
  `;
  try {
    const raw = run('osascript', ['-l', 'JavaScript', '-e', script]);
    return framesToDisplays(JSON.parse(raw));
  } catch (err) {
    log('displays: JXA probe failed —', err.message);
    return null;
  }
}

// xrandr already reports top-left origin geometry as WxH+X+Y.
function detectLinux() {
  try {
    const out = run('xrandr', ['--current']);
    const pattern = /^(\S+)\s+connected\s+(primary\s+)?(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/gm;
    const displays = [];
    let match;
    while ((match = pattern.exec(out)) !== null) {
      displays.push({
        index: displays.length,
        name: match[1],
        x: Number(match[5]),
        y: Number(match[6]),
        width: Number(match[3]),
        height: Number(match[4]),
        primary: Boolean(match[2]),
      });
    }
    if (!displays.length) return null;
    // xrandr only marks a primary when one was set explicitly.
    if (!displays.some((d) => d.primary)) displays[0].primary = true;
    return displays;
  } catch (err) {
    log('displays: xrandr unavailable —', err.message);
    return null;
  }
}

// WorkingArea rather than Bounds, so windows don't slide under the taskbar.
function detectWindows() {
  const ps =
    'Add-Type -AssemblyName System.Windows.Forms; ' +
    '[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { ' +
    'Write-Output "$($_.DeviceName)|$($_.Primary)|$($_.WorkingArea.X)|$($_.WorkingArea.Y)|' +
    '$($_.WorkingArea.Width)|$($_.WorkingArea.Height)" }';
  try {
    const out = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    const displays = out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        const [name, primary, x, y, width, height] = line.split('|');
        return {
          index,
          name: (name || `Display ${index + 1}`).replace(/^\\\\\.\\/, ''),
          x: Number(x),
          y: Number(y),
          width: Number(width),
          height: Number(height),
          primary: /true/i.test(primary),
        };
      })
      .filter((d) => d.width > 0 && d.height > 0);
    return displays.length ? displays : null;
  } catch (err) {
    log('displays: powershell probe failed —', err.message);
    return null;
  }
}

function detectDisplays() {
  let displays = null;
  if (process.platform === 'darwin') displays = detectDarwin();
  else if (process.platform === 'win32') displays = detectWindows();
  else displays = detectLinux();

  if (displays && displays.length) return displays;
  return null;
}

/**
 * Pick the display to put the feeds on.
 *
 * "auto" is the default and prefers a non-primary display: the entire point of
 * a second monitor here is that the feeds don't cover the editor. With one
 * display it degrades to that display, so the default is safe either way.
 */
function selectDisplay(displays, preference = 'auto') {
  if (!displays || !displays.length) return null;
  const primary = displays.find((d) => d.primary) || displays[0];

  if (preference === 'primary') return primary;

  if (preference === 'secondary' || preference === 'auto') {
    const secondary = displays.find((d) => !d.primary);
    if (secondary) return secondary;
    if (preference === 'secondary') {
      log('displays: no secondary display attached, falling back to primary');
    }
    return primary;
  }

  if (typeof preference === 'number' || /^\d+$/.test(String(preference))) {
    const wanted = Number(preference);
    const byIndex = displays[wanted];
    if (byIndex) return byIndex;
    log('displays: no display at index', wanted, '- falling back to primary');
    return primary;
  }

  const byName = displays.find((d) => d.name.toLowerCase() === String(preference).toLowerCase());
  if (byName) return byName;
  log('displays: no display named', preference, '- falling back to primary');
  return primary;
}

module.exports = { detectDisplays, selectDisplay, framesToDisplays };

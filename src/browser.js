'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Chromium-family browsers are strongly preferred: they're the only ones that
// take window geometry as launch flags, which is the whole trick behind
// "three windows, side by side, instantly".
const CANDIDATES = {
  darwin: [
    { key: 'chrome', family: 'chromium', bin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { key: 'brave', family: 'chromium', bin: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
    { key: 'edge', family: 'chromium', bin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    { key: 'chromium', family: 'chromium', bin: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
    { key: 'firefox', family: 'firefox', bin: '/Applications/Firefox.app/Contents/MacOS/firefox' },
  ],
  win32: [
    { key: 'chrome', family: 'chromium', bin: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { key: 'chrome', family: 'chromium', bin: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' },
    { key: 'edge', family: 'chromium', bin: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { key: 'brave', family: 'chromium', bin: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe' },
    { key: 'firefox', family: 'firefox', bin: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' },
  ],
  linux: [
    { key: 'chrome', family: 'chromium', bin: 'google-chrome' },
    { key: 'chrome', family: 'chromium', bin: 'google-chrome-stable' },
    { key: 'chromium', family: 'chromium', bin: 'chromium' },
    { key: 'chromium', family: 'chromium', bin: 'chromium-browser' },
    { key: 'brave', family: 'chromium', bin: 'brave-browser' },
    { key: 'edge', family: 'chromium', bin: 'microsoft-edge' },
    { key: 'firefox', family: 'firefox', bin: 'firefox' },
  ],
};

function candidatesForPlatform() {
  return CANDIDATES[process.platform] || CANDIDATES.linux;
}

function exists(bin) {
  if (bin.includes(path.sep) || path.isAbsolute(bin)) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  // Bare command name: let the OS resolve it against PATH.
  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(which, [bin], { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

function familyFor(bin) {
  return /firefox/i.test(path.basename(bin)) ? 'firefox' : 'chromium';
}

/**
 * @param {string} preference "auto", a known key ("chrome"), or an explicit path.
 * @returns {{bin: string, family: string, key: string}}
 */
function findBrowser(preference = 'auto') {
  const list = candidatesForPlatform();

  if (preference && preference !== 'auto') {
    // An explicit path wins outright, even if we can't stat it (the user may
    // know better than us about a wrapper script).
    if (preference.includes('/') || preference.includes('\\')) {
      return { bin: preference, family: familyFor(preference), key: 'custom' };
    }
    const matches = list.filter((c) => c.key === preference);
    const found = matches.find((c) => exists(c.bin));
    if (found) return { ...found };
    if (matches.length) {
      throw new Error(`Browser "${preference}" is configured but wasn't found at ${matches[0].bin}.`);
    }
    if (exists(preference)) return { bin: preference, family: familyFor(preference), key: preference };
    throw new Error(`Browser "${preference}" not found. Known keys: chrome, brave, edge, chromium, firefox.`);
  }

  const found = list.find((c) => exists(c.bin));
  if (found) return { ...found };
  throw new Error(
    'No supported browser found. Install Chrome/Chromium/Brave/Edge, or set one explicitly: white-python config browser=/path/to/browser'
  );
}

/**
 * Build the argv for one feed window.
 *
 * Each feed gets its own persistent profile directory. That buys two things:
 * the windows are separate OS processes we can position and close individually,
 * and you stay logged in to each site across sessions without us ever touching
 * your day-to-day browser profile.
 */
function buildArgs({ family, url, rect, profileDir, muted, appMode = true }) {
  if (family === 'firefox') {
    // Firefox has no geometry flags; position.js repositions it afterwards
    // where the platform allows.
    return ['--profile', profileDir, '--no-remote', '--new-window', url];
  }
  const args = [
    `--user-data-dir=${profileDir}`,
    `--window-position=${Math.round(rect.x)},${Math.round(rect.y)}`,
    `--window-size=${Math.round(rect.width)},${Math.round(rect.height)}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--disable-features=Translate',
  ];
  if (muted) args.push('--mute-audio');
  // --app gives a chromeless window (no tab strip or omnibox), which is what
  // makes three of them read as three phones rather than three browsers.
  if (appMode) args.push(`--app=${url}`);
  else args.push('--new-window', url);
  return args;
}

module.exports = { findBrowser, buildArgs, CANDIDATES, familyFor };

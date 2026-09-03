'use strict';

const fs = require('node:fs');
const { PATHS, ensureRoot } = require('./config');

const MAX_BYTES = 512 * 1024;

// Hooks run detached with nowhere useful to print, so everything interesting
// goes to ~/.cobra-tool/cobra.log instead. Logging must never be the reason a
// hook fails, hence the blanket catch.
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ')}\n`;
  try {
    ensureRoot();
    try {
      if (fs.statSync(PATHS.log).size > MAX_BYTES) {
        fs.renameSync(PATHS.log, `${PATHS.log}.1`);
      }
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(PATHS.log, line);
  } catch {
    /* logging is best effort */
  }
  if (process.env.COBRA_DEBUG) process.stderr.write(line);
}

module.exports = { log };

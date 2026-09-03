'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CLI } = require('./hooks');

// Claude Code fires these three at exactly the right moments:
//   UserPromptSubmit -> you just handed the agent work
//   Notification     -> it needs you (permission prompt, or idle waiting on input)
//   Stop             -> the turn is finished
// SessionEnd is a belt-and-braces cleanup for a closed terminal.
const CLAUDE_EVENTS = [
  { event: 'UserPromptSubmit', args: ['hook', 'start'] },
  { event: 'Notification', args: ['hook', 'stop', '--reason', 'question'] },
  { event: 'Stop', args: ['hook', 'stop', '--reason', 'done'] },
  { event: 'SessionEnd', args: ['hook', 'stop', '--reason', 'session-end'] },
];

const MARKER = 'white-python.js';

function quote(value) {
  return /[\s"']/.test(value) ? `"${value}"` : value;
}

function hookCommand(args) {
  return [quote(process.execPath), quote(CLI), ...args].join(' ');
}

function settingsPath(scope) {
  if (scope === 'user') return path.join(os.homedir(), '.claude', 'settings.json');
  return path.join(process.cwd(), '.claude', 'settings.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`${file} is not valid JSON — fix or move it first (${err.message})`);
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function isOurs(entry) {
  return (entry.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes(MARKER));
}

/**
 * Merge our hooks into Claude Code settings without disturbing anyone else's.
 * Idempotent: re-running replaces our entries and leaves the rest alone.
 */
function installClaude({ scope = 'project' } = {}) {
  const file = settingsPath(scope);
  const settings = readJson(file);
  settings.hooks = settings.hooks || {};

  for (const { event, args } of CLAUDE_EVENTS) {
    const existing = (settings.hooks[event] || []).filter((entry) => !isOurs(entry));
    existing.push({ hooks: [{ type: 'command', command: hookCommand(args) }] });
    settings.hooks[event] = existing;
  }

  writeJson(file, settings);
  return { file, events: CLAUDE_EVENTS.map((e) => e.event) };
}

function uninstallClaude({ scope = 'project' } = {}) {
  const file = settingsPath(scope);
  if (!fs.existsSync(file)) return { file, removed: 0 };
  const settings = readJson(file);
  let removed = 0;

  for (const event of Object.keys(settings.hooks || {})) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter((entry) => !isOurs(entry));
    removed += before - settings.hooks[event].length;
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

  writeJson(file, settings);
  return { file, removed };
}

/**
 * Codex only notifies on turn completion, so it gets the closing half of the
 * feature. Opening is handled by `white-python wrap -- codex ...`.
 */
function codexSnippet() {
  const cmd = [process.execPath, CLI, 'hook', 'codex'];
  return `notify = ${JSON.stringify(cmd)}`;
}

function installCodex() {
  const file = path.join(os.homedir(), '.codex', 'config.toml');
  const line = codexSnippet();
  let contents = '';
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (contents.includes(MARKER)) {
    return { file, changed: false, line };
  }
  const stripped = contents.replace(/^notify\s*=.*$/gm, (m) => `# ${m}  # replaced by white-python`);
  const next = `${stripped.trimEnd()}\n\n# white-python: close the feeds when the turn finishes\n${line}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next.trimStart());
  return { file, changed: true, line };
}

module.exports = { installClaude, uninstallClaude, installCodex, codexSnippet, hookCommand, CLAUDE_EVENTS, settingsPath };

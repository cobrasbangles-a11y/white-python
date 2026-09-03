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

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    // A settings file that parses to null, an array, or a scalar is not
    // something we can merge into; treat it as empty rather than crashing on
    // property access further down.
    return isPlainObject(parsed) ? parsed : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`${file} is not valid JSON — fix or move it first (${err.message})`);
  }
}

/**
 * Refuse to touch a hooks block shaped in a way we can't merge into.
 *
 * Overwriting it would silently destroy whatever the user had there, and
 * crashing on `.filter` tells them nothing. Naming the exact key does.
 */
function assertMergeable(settings, file) {
  if (!isPlainObject(settings.hooks)) {
    throw new Error(`${file} has a "hooks" value that is not an object — fix it first, nothing was changed`);
  }
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) {
      throw new Error(`${file} has "hooks.${event}" set to something other than a list — fix it first, nothing was changed`);
    }
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

// Tolerates junk entries left by other tools: anything not shaped like ours
// simply isn't ours, and is preserved untouched.
function isOurs(entry) {
  if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((h) => isPlainObject(h) && typeof h.command === 'string' && h.command.includes(MARKER));
}

/**
 * Merge our hooks into Claude Code settings without disturbing anyone else's.
 * Idempotent: re-running replaces our entries and leaves the rest alone.
 */
function installClaude({ scope = 'project' } = {}) {
  const file = settingsPath(scope);
  const settings = readJson(file);
  if (settings.hooks === undefined) settings.hooks = {};
  assertMergeable(settings, file);

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

  // Uninstall stays tolerant: an event we can't parse simply has none of ours
  // in it, and is left exactly as found.
  for (const event of Object.keys(isPlainObject(settings.hooks) ? settings.hooks : {})) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => !isOurs(entry));
    removed += entries.length - kept.length;
    settings.hooks[event] = kept;
    if (kept.length === 0) delete settings.hooks[event];
  }
  if (isPlainObject(settings.hooks) && Object.keys(settings.hooks).length === 0) delete settings.hooks;

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

/**
 * Where each installed hook actually points, and whether that file still
 * exists.
 *
 * `install` writes absolute paths, so moving or deleting the clone leaves
 * hooks that fire on every turn and die with a Node module-not-found trace —
 * which reads as the agent itself being broken. Worth naming explicitly.
 */
function hookStatus(scope) {
  const file = settingsPath(scope);
  let settings;
  try {
    settings = readJson(file);
  } catch {
    return { file, readable: false, hooks: [] };
  }
  const hooks = [];
  for (const [event, entries] of Object.entries(isPlainObject(settings.hooks) ? settings.hooks : {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isOurs(entry)) continue;
      for (const h of entry.hooks) {
        const command = String(h.command || '');
        // Pull our script path back out of `"<node>" "<cli>" hook start`,
        // tolerating the quoting added for paths containing spaces.
        const match = command.match(/"([^"]*white-python\.js)"|(\S*white-python\.js)/);
        const target = match ? match[1] || match[2] : null;
        hooks.push({ event, command, target, exists: target ? fs.existsSync(target) : false });
      }
    }
  }
  return { file, readable: true, hooks };
}

module.exports = {
  installClaude,
  uninstallClaude,
  installCodex,
  codexSnippet,
  hookCommand,
  hookStatus,
  CLAUDE_EVENTS,
  settingsPath,
};

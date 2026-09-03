'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installClaude, uninstallClaude, settingsPath, CLAUDE_EVENTS } = require('../src/install');

function withTempProject(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'white-python-test-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return run(dir);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const readSettings = () => JSON.parse(fs.readFileSync(settingsPath('project'), 'utf8'));

test('install wires up every agent event we care about', () => {
  withTempProject(() => {
    installClaude({ scope: 'project' });
    const hooks = readSettings().hooks;
    for (const { event } of CLAUDE_EVENTS) {
      assert.ok(hooks[event], `${event} should be wired`);
      assert.match(hooks[event][0].hooks[0].command, /white-python\.js/);
    }
    // The open/close split is the whole feature; assert the direction of each.
    assert.match(hooks.UserPromptSubmit[0].hooks[0].command, /hook start/);
    assert.match(hooks.Notification[0].hooks[0].command, /hook stop .*question/);
    assert.match(hooks.Stop[0].hooks[0].command, /hook stop .*done/);
  });
});

test('installing twice does not duplicate our hooks', () => {
  withTempProject(() => {
    installClaude({ scope: 'project' });
    installClaude({ scope: 'project' });
    const hooks = readSettings().hooks;
    for (const { event } of CLAUDE_EVENTS) {
      assert.strictEqual(hooks[event].length, 1, `${event} should have exactly one entry`);
    }
  });
});

test('install preserves unrelated settings and third-party hooks', () => {
  withTempProject(() => {
    fs.mkdirSync('.claude');
    fs.writeFileSync(
      path.join('.claude', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(npm test)'] },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }] },
      })
    );

    installClaude({ scope: 'project' });
    const after = readSettings();
    assert.deepStrictEqual(after.permissions, { allow: ['Bash(npm test)'] });
    assert.strictEqual(after.hooks.Stop.length, 2, 'their hook plus ours');
    assert.ok(after.hooks.Stop.some((e) => e.hooks[0].command === 'echo theirs'));
  });
});

test('uninstall removes only our hooks, leaving the file as it was', () => {
  withTempProject(() => {
    const original = {
      permissions: { allow: ['Bash(npm test)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }] },
    };
    fs.mkdirSync('.claude');
    fs.writeFileSync(path.join('.claude', 'settings.json'), JSON.stringify(original));

    installClaude({ scope: 'project' });
    const result = uninstallClaude({ scope: 'project' });

    assert.strictEqual(result.removed, CLAUDE_EVENTS.length);
    assert.deepStrictEqual(readSettings(), original);
  });
});

test('uninstall on a machine that never installed is a no-op, not a crash', () => {
  withTempProject(() => {
    const result = uninstallClaude({ scope: 'project' });
    assert.strictEqual(result.removed, 0);
  });
});

test('a corrupt settings file fails with a pointed message instead of silent data loss', () => {
  withTempProject(() => {
    fs.mkdirSync('.claude');
    fs.writeFileSync(path.join('.claude', 'settings.json'), '{ this is not json');
    assert.throws(() => installClaude({ scope: 'project' }), /not valid JSON/);
  });
});

// --- malformed settings.json ---
//
// settings.json is hand-editable and shared with other tools, so it can hold
// shapes we don't expect. Every case below used to throw a raw TypeError out
// of `install`, which reads to the user as "installing broke everything".

function writeSettings(text) {
  fs.mkdirSync('.claude', { recursive: true });
  fs.writeFileSync(path.join('.claude', 'settings.json'), text);
}

test('a settings file that is null or an array is treated as empty, not crashed on', () => {
  for (const junk of ['null', '[]', '"a string"', '42']) {
    withTempProject(() => {
      writeSettings(junk);
      assert.doesNotThrow(() => installClaude({ scope: 'project' }), `threw for ${junk}`);
      const hooks = readSettings().hooks;
      for (const { event } of CLAUDE_EVENTS) assert.ok(hooks[event], `${event} missing for ${junk}`);
    });
  }
});

test('junk entries left by other tools are tolerated and preserved', () => {
  withTempProject(() => {
    writeSettings(JSON.stringify({ hooks: { Stop: [null, { hooks: 'not-a-list' }] } }));
    assert.doesNotThrow(() => installClaude({ scope: 'project' }));
    const stop = readSettings().hooks.Stop;
    assert.ok(stop.some((e) => e === null), 'a null entry should survive untouched');
    assert.ok(stop.some((e) => e && e.hooks === 'not-a-list'), 'a foreign entry should survive untouched');
    assert.ok(stop.some((e) => e && Array.isArray(e.hooks) && String(e.hooks[0].command).includes('white-python.js')));
  });
});

test('an unmergeable hooks shape is refused by name, and nothing is written', () => {
  for (const [junk, needle] of [
    [JSON.stringify({ hooks: { Stop: 'a string' } }), /hooks\.Stop/],
    [JSON.stringify({ hooks: { Stop: { a: 1 } } }), /hooks\.Stop/],
    [JSON.stringify({ hooks: [] }), /"hooks"/],
  ]) {
    withTempProject(() => {
      writeSettings(junk);
      assert.throws(() => installClaude({ scope: 'project' }), needle);
      assert.strictEqual(
        fs.readFileSync(path.join('.claude', 'settings.json'), 'utf8'),
        junk,
        'a refused install must not modify the file'
      );
    });
  }
});

test('uninstall never throws on any of that, and leaves foreign data alone', () => {
  for (const junk of [
    JSON.stringify({ hooks: { Stop: 'a string' } }),
    JSON.stringify({ hooks: [] }),
    'null',
    JSON.stringify({ hooks: { Stop: [null] } }),
  ]) {
    withTempProject(() => {
      writeSettings(junk);
      assert.doesNotThrow(() => uninstallClaude({ scope: 'project' }), `threw for ${junk}`);
    });
  }
});

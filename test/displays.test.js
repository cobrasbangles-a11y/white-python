'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { selectDisplay, framesToDisplays } = require('../src/displays');

const LAPTOP = { index: 0, name: 'eDP-1', x: 0, y: 0, width: 1512, height: 945, primary: true };
const EXTERNAL = { index: 1, name: 'HDMI-1', x: 1512, y: 0, width: 2560, height: 1440, primary: false };
const TWO = [LAPTOP, EXTERNAL];

test('auto prefers the second monitor, so feeds never cover the editor', () => {
  assert.strictEqual(selectDisplay(TWO, 'auto'), EXTERNAL);
});

test('auto degrades to the only display on a single-monitor machine', () => {
  assert.strictEqual(selectDisplay([LAPTOP], 'auto'), LAPTOP);
});

test('explicit primary overrides the auto preference', () => {
  assert.strictEqual(selectDisplay(TWO, 'primary'), LAPTOP);
});

test('secondary falls back to primary rather than failing when unplugged', () => {
  assert.strictEqual(selectDisplay([LAPTOP], 'secondary'), LAPTOP);
});

test('a display can be chosen by index or by output name', () => {
  assert.strictEqual(selectDisplay(TWO, 1), EXTERNAL);
  assert.strictEqual(selectDisplay(TWO, '1'), EXTERNAL);
  assert.strictEqual(selectDisplay(TWO, 'HDMI-1'), EXTERNAL);
  assert.strictEqual(selectDisplay(TWO, 'hdmi-1'), EXTERNAL, 'name match should be case-insensitive');
});

test('an out-of-range index or unknown name falls back to primary', () => {
  assert.strictEqual(selectDisplay(TWO, 7), LAPTOP);
  assert.strictEqual(selectDisplay(TWO, 'DP-9'), LAPTOP);
});

test('no displays at all yields null rather than throwing', () => {
  assert.strictEqual(selectDisplay(null, 'auto'), null);
  assert.strictEqual(selectDisplay([], 'auto'), null);
});

test('when nothing is flagged primary, the first display is treated as primary', () => {
  const unflagged = [{ ...LAPTOP, primary: false }, { ...EXTERNAL }];
  assert.strictEqual(selectDisplay(unflagged, 'primary'), unflagged[0]);
});

// macOS: NSScreen is bottom-left origin with +Y up; browsers are top-left with
// +Y down. These cases are the ones that break if the flip is wrong.
test('macOS frames flip to browser coordinates: primary sits at the origin', () => {
  const [main] = framesToDisplays([{ x: 0, y: 0, w: 1512, h: 945, fullH: 982 }]);
  // 982 tall in total, visible area 945 => a 37pt menu bar at the top.
  assert.strictEqual(main.x, 0);
  assert.strictEqual(main.y, 37);
  assert.strictEqual(main.width, 1512);
  assert.strictEqual(main.primary, true);
});

test('macOS: a monitor stacked ABOVE the main one gets a negative y, not a positive one', () => {
  const displays = framesToDisplays([
    { x: 0, y: 0, w: 1512, h: 982, fullH: 982 },
    { x: 0, y: 982, w: 2560, h: 1440, fullH: 982 },
  ]);
  // In NS coords the second screen sits above (higher y). In browser coords
  // that must become negative, i.e. above the primary's top edge.
  assert.strictEqual(displays[1].y, 982 - (982 + 1440));
  assert.ok(displays[1].y < 0, 'a monitor above the main one must have negative y');
});

test('macOS: a monitor to the right keeps its positive x offset', () => {
  const displays = framesToDisplays([
    { x: 0, y: 0, w: 1512, h: 982, fullH: 982 },
    { x: 1512, y: 0, w: 2560, h: 1440, fullH: 982 },
  ]);
  assert.strictEqual(displays[1].x, 1512);
  assert.strictEqual(displays[1].primary, false);
});

test('empty frame lists are handled, not crashed on', () => {
  assert.strictEqual(framesToDisplays([]), null);
  assert.strictEqual(framesToDisplays(null), null);
});

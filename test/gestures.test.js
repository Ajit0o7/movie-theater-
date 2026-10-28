import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDENTITY, containBox, fillTransform, transformBox } from '../public/js/geometry.js';
import { pinchIntent, setupTouchGestures, tapZone } from '../public/js/gestures.js';

const near = (a, b) => Math.abs(a - b) < 1e-6;

test('fill zooms the picture (not the bars baked into the file) to cover the screen', () => {
  // A 16:9 file on a 20:9 phone in landscape: zoom until the width is covered.
  const phone = fillTransform(2000, 900, 1920, 1080);
  assert.ok(near(phone.s, 2000 / 1600) && near(phone.tx, 0) && near(phone.ty, 0));
  // A 2.39:1 film inside a 16:9 file (12.8% bars top and bottom) on a 16:9 screen: zoom past
  // the bars so the picture's height fills the screen.
  const crop = { top: 0.128, bottom: 0.128, left: 0, right: 0 };
  const film = fillTransform(1600, 900, 1920, 1080, crop);
  assert.ok(near(film.s, 1 / (1 - 0.256)));
  const pic = transformBox(containBox(1600, 900, 1920, 1080), film, 1600, 900);
  assert.ok(near(pic.y + 0.128 * pic.h, 0), 'the picture starts at the top of the screen');
  assert.ok(near(pic.y + (1 - 0.128) * pic.h, 900), 'and ends at the bottom');
  // Bars on one side only: the picture is centred, not the file.
  const offset = fillTransform(1600, 900, 1920, 1080, { top: 0.2, bottom: 0, left: 0, right: 0 });
  const moved = transformBox(containBox(1600, 900, 1920, 1080), offset, 1600, 900);
  assert.ok(near(moved.y + 0.2 * moved.h, 0) && near(moved.y + moved.h, 900));
  assert.equal(fillTransform(1600, 900, 0, 0), IDENTITY, 'no video yet: nothing to zoom');
  assert.deepEqual(transformBox({ x: 10, y: 20, w: 30, h: 40 }, IDENTITY, 100, 100), { x: 10, y: 20, w: 30, h: 40 });
});

test('double-tap zones and pinch intent', () => {
  assert.equal(tapZone(100, 1000), 'back');
  assert.equal(tapZone(500, 1000), 'middle');
  assert.equal(tapZone(900, 1000), 'forward');
  assert.equal(pinchIntent(100, 130), 'fill');
  assert.equal(pinchIntent(100, 70), 'fit');
  assert.equal(pinchIntent(100, 105), null, 'a wobble is not a pinch');
});

/** A stand-in for the click shield that records what the gestures asked for. */
function rig() {
  const listeners = {};
  const el = { clientWidth: 1000, clientHeight: 600, addEventListener: (type, fn) => (listeners[type] = fn) };
  const calls = [];
  let enabled = true;
  setupTouchGestures(el, {
    enabled: () => enabled,
    tap: () => calls.push(['tap']),
    togglePlay: () => calls.push(['togglePlay']),
    seekPreview: (s) => (calls.push(['preview', s]), true),
    seek: (s) => calls.push(['seek', s]),
    swipe: (side, d) => calls.push(['swipe', side, Math.round(d * 1000) / 1000]),
    pinch: (intent) => calls.push(['pinch', intent]),
  });
  let now = 0;
  const fire = (type, id, x, y, pointerType = 'touch') => listeners[type]({ type, pointerId: id, clientX: x, clientY: y, pointerType, timeStamp: now });
  const tap = (x, y = 300, id = 1) => {
    fire('pointerdown', id, x, y);
    now += 60;
    fire('pointerup', id, x, y);
  };
  return { calls, fire, tap, wait: (ms) => (now += ms), setEnabled: (v) => (enabled = v) };
}

test('touch: tap toggles the controls; double-tap skips (one seek per streak) or plays', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig();
  r.tap(500);
  assert.deepEqual(r.calls, [], 'a single tap waits to see if a second one follows');
  t.mock.timers.tick(300);
  assert.deepEqual(r.calls, [['tap']]);

  // Double-tap on the right, then two more taps: +10, +20, +30, sent as a single seek.
  r.calls.length = 0;
  r.wait(1000);
  r.tap(900);
  r.wait(100);
  r.tap(905);
  r.wait(200);
  r.tap(880);
  r.wait(200);
  r.tap(910);
  assert.deepEqual(r.calls, [['preview', 10], ['preview', 20], ['preview', 30]]);
  t.mock.timers.tick(700);
  assert.deepEqual(r.calls.at(-1), ['seek', 30]);
  assert.ok(!r.calls.some(([k]) => k === 'tap'), 'taps in a skip streak never toggle the controls');

  // Double-tap on the left goes back; in the middle it plays/pauses.
  r.calls.length = 0;
  r.wait(1000);
  r.tap(80);
  r.wait(150);
  r.tap(90);
  t.mock.timers.tick(700);
  assert.deepEqual(r.calls, [['preview', -10], ['seek', -10]]);
  r.calls.length = 0;
  r.wait(1000);
  r.tap(500);
  r.wait(150);
  r.tap(510);
  t.mock.timers.tick(700);
  assert.deepEqual(r.calls, [['togglePlay']]);
});

test('touch: vertical swipes adjust by side, pinches pick fill or fit, mice are ignored', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig();
  // Swipe up 180px on the left half: brightness +50% of the range (180 / (600 × 0.6)).
  r.fire('pointerdown', 1, 200, 400);
  r.fire('pointermove', 1, 202, 380);
  r.fire('pointermove', 1, 204, 220);
  r.fire('pointerup', 1, 204, 220);
  t.mock.timers.tick(500);
  assert.deepEqual(r.calls, [['swipe', 'left', 0.056], ['swipe', 'left', 0.444]]);
  assert.ok(!r.calls.some(([k]) => k === 'tap'), 'a swipe is not a tap');

  r.calls.length = 0;
  r.fire('pointerdown', 1, 800, 200);
  r.fire('pointermove', 1, 800, 290);
  r.fire('pointerup', 1, 800, 290);
  assert.deepEqual(r.calls, [['swipe', 'right', -0.25]]);

  // Two fingers spreading apart: fill (once), then pinching in: fit.
  r.calls.length = 0;
  r.fire('pointerdown', 1, 400, 300);
  r.fire('pointerdown', 2, 600, 300);
  r.fire('pointermove', 2, 650, 300);
  r.fire('pointermove', 2, 700, 300);
  r.fire('pointermove', 1, 300, 300);
  r.fire('pointermove', 1, 560, 300); // 140px apart: narrower than at the start
  r.fire('pointerup', 1, 560, 300);
  r.fire('pointermove', 2, 900, 100); // the finger left behind doesn't turn into a swipe
  r.fire('pointerup', 2, 900, 100);
  t.mock.timers.tick(500);
  assert.deepEqual(r.calls, [['pinch', 'fill'], ['pinch', 'fit']]);

  // A mouse click, or any touch while disabled (laser mode), is left to other handlers.
  r.calls.length = 0;
  r.fire('pointerdown', 9, 500, 300, 'mouse');
  r.fire('pointerup', 9, 500, 300, 'mouse');
  r.setEnabled(false);
  r.tap(500);
  t.mock.timers.tick(500);
  assert.deepEqual(r.calls, []);
});

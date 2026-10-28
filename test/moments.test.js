import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bucketMoments, pickBadges } from '../public/js/moments.js';

test('groups reactions along the timeline and finds each spot’s top emoji', () => {
  const moments = [
    { t: 61, emoji: '😂' }, { t: 62, emoji: '😂' }, { t: 62.5, emoji: '😱' }, // one moment around 1:02
    { t: 1800, emoji: '😭' },
    { t: -5, emoji: '🍿' }, { t: 99999, emoji: '🍿' }, // out of range: ignored
  ];
  const buckets = bucketMoments(moments, 3600);
  assert.equal(buckets.length, 2);
  assert.deepEqual(buckets.map((b) => [b.count, b.top]), [[3, '😂'], [1, '😭']]);
  assert.ok(Math.abs(buckets[0].at - 61.83) < 0.01, 'the marker sits at the average reaction time');
  assert.deepEqual(bucketMoments(moments, 0), [], 'no duration yet: nothing to place');
});

test('only the busiest spots get an emoji badge', () => {
  const moments = [];
  for (let i = 0; i < 10; i++) for (let n = 0; n <= i; n++) moments.push({ t: i * 100 + 1, emoji: '🔥' });
  const badges = pickBadges(bucketMoments(moments, 1000));
  assert.equal(badges.length, 6);
  assert.deepEqual(badges.map((b) => b.count), [10, 9, 8, 7, 6, 5]);
  assert.equal(pickBadges(bucketMoments([{ t: 5, emoji: '😂' }], 100)).length, 0, 'a single reaction is a dot, not a badge');
});

test('spatial pan follows the tile across the screen, never fully one-sided', async () => {
  const { panFor } = await import('../public/js/spatial.js');
  assert.equal(panFor(0, 1000), -0.8);
  assert.equal(panFor(500, 1000), 0);
  assert.equal(panFor(1000, 1000), 0.8);
  assert.ok(Math.abs(panFor(250, 1000) + 0.4) < 1e-9);
  assert.equal(panFor(5000, 1000), 0.8, 'clamped');
  assert.equal(panFor(100, 0), 0);
});

test('laser points are picture fractions, so they land on the same spot on any screen', async () => {
  const { containBox, toPicture } = await import('../public/js/laser.js');
  // A 16:9 movie on a 4:3 screen: bars top and bottom.
  const box = containBox(1024, 768, 1920, 1080);
  assert.deepEqual(box, { x: 0, y: 96, w: 1024, h: 576 });
  assert.deepEqual(toPicture(512, 384, box), [0.5, 0.5]);
  // The same picture fraction on a 21:9 screen (bars left and right) is the same movie spot.
  const wide = containBox(2560, 1080, 1920, 1080);
  assert.deepEqual(wide, { x: 320, y: 0, w: 1920, h: 1080 });
  assert.deepEqual(toPicture(320 + 960, 540, wide), [0.5, 0.5]);
  assert.deepEqual(toPicture(-9999, 9999, box), [-0.5, 1.5], 'clamped');
  const { sanitizeLaserPoints } = await import('../server/rooms.js');
  assert.deepEqual(sanitizeLaserPoints([[0.123456, 0.5]]), [[0.1235, 0.5]]);
  for (const bad of [null, [], [[1]], [[0, 'x']], [[5, 0]], Array(25).fill([0, 0])]) assert.equal(sanitizeLaserPoints(bad), null);
});

test('ambilight finds black bars baked into the video, and keeps quiet on dark scenes', async () => {
  const { detectBars } = await import('../public/js/ambilight.js');
  const W = 64;
  const H = 36;
  // A frame painted by `pixel(x, y) -> [r, g, b]`.
  const frame = (pixel) => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set([...pixel(x, y), 255], (y * W + x) * 4);
    return data;
  };
  const scene = (x, y) => [(x * 4) % 256, 90 + (y % 7) * 10, 140];
  // A 2.39:1 film in a 16:9 file: about 12% black at the top and bottom (slightly noisy black).
  const scope = frame((x, y) => (y < 4 || y >= H - 4 ? [10, 12, 9] : scene(x, y)));
  const bars = detectBars(scope, W, H);
  assert.ok(Math.abs(bars.top - 4 / 36) < 1e-9 && Math.abs(bars.bottom - 4 / 36) < 1e-9);
  assert.equal(bars.left, 0);
  assert.equal(bars.right, 0);
  // A 4:3 show in a 16:9 file: pillars left and right.
  const pillars = detectBars(frame((x, y) => (x < 8 || x >= W - 8 ? [0, 0, 0] : scene(x, y))), W, H);
  assert.deepEqual(pillars, { top: 0, bottom: 0, left: 0.125, right: 0.125 });
  // A full-frame picture: no bars. A dark scene: no verdict (it would look like all bars).
  assert.deepEqual(detectBars(frame(scene), W, H), { top: 0, bottom: 0, left: 0, right: 0 });
  assert.equal(detectBars(frame(() => [3, 3, 3]), W, H), null);
  // A one-row sliver is noise, not a letterbox.
  assert.equal(detectBars(frame((x, y) => (y === 0 ? [0, 0, 0] : scene(x, y))), W, H).top, 0);
  // The bar ends partway through a line (scaled-down frame): that line is a dim blend.
  const flat = [100, 100, 100];
  const blended = detectBars(frame((x, y) => (y < 4 || y >= H - 4 ? [0, 0, 0] : y === 4 ? [40, 40, 40] : flat)), W, H);
  assert.ok(Math.abs(blended.top - 4.6 / 36) < 1e-9, `top ${blended.top * 36} lines`);
  // Burned-in subtitle text in the bottom bar: still a letterbox, same size as the top one.
  const text = (x, y) => (y === H - 3 && x > W * 0.3 && x < W * 0.7 && x % 4 === 0 ? [235, 235, 235] : [0, 0, 0]);
  const subbed = detectBars(frame((x, y) => (y < 4 || y >= H - 4 ? text(x, y) : scene(x, y))), W, H);
  assert.equal(subbed.bottom, subbed.top);
  assert.ok(subbed.top > 0.1);
});

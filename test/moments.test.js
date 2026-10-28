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

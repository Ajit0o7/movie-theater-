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

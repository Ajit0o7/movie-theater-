import assert from 'node:assert/strict';
import { test } from 'node:test';
import { danmakuMetrics, laneCount, pickLane, shorten, speedFor } from '../public/js/danmaku.js';

test('floating chat: lanes fit the top of any screen, and a busy lane is skipped', () => {
  assert.deepEqual(danmakuMetrics(1920), { size: 22, laneH: 40 });
  assert.deepEqual(danmakuMetrics(390), { size: 15, laneH: 31 });
  assert.equal(laneCount(1080, 80, 40), 8, 'capped at 8 on big screens');
  assert.equal(laneCount(390, 60, 31), 3, 'a landscape phone still gets a few');
  assert.equal(laneCount(200, 80, 40), 2, 'never fewer than 2');
  // Lane 0 is still showing a message's tail; lane 1 is free.
  assert.equal(pickLane([5000, 900, 0], 1000), 1);
  assert.equal(pickLane([5000, 6000], 1000), -1, 'all busy: the message waits in the queue');
  assert.equal(pickLane([], 1000), -1);
  assert.equal(pickLane([, 2000], 1000), 0, 'a lane added by a resize is free');
  // Constant speed (so nothing overtakes): about 7 s to cross, never crawling on phones.
  assert.equal(speedFor(1400), 200);
  assert.equal(speedFor(390), 140);
  assert.equal(shorten('  hi \n there  '), 'hi there');
  assert.equal(shorten('x'.repeat(200)).length, 90);
});

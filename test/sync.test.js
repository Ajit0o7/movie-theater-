import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CinemaSync } from '../public/js/sync.js';

function fakeVideo(props = {}) {
  const v = new EventTarget();
  Object.assign(v, { currentTime: 0, duration: 100, paused: false, seeking: false, readyState: 4, playbackRate: 1, play: async () => {}, pause() {}, ...props });
  return v;
}
const fakeSocket = () => ({ on() {}, off() {}, emit() {}, calls: [] });
const clock = { now: () => Date.now() };
const urlSource = (id) => ({ id, type: 'url', url: 'https://example.com/m.mp4', name: 'm', ownerId: 'host', duration: 100 });
const state = (source, time) => ({ source, playing: true, time, serverTime: Date.now(), rate: 1 });

test('a catch-up seek near the end never overshoots the duration (which would pause the room)', async () => {
  const video = fakeVideo();
  let ended = 0;
  video.addEventListener('ended', () => ended++);
  const sync = new CinemaSync({ socket: fakeSocket(), clock, video, selfId: 'me' });
  try {
    sync.setInitialState(state(urlSource('a'), 99.9));
    sync.seekLead = 6; // a slow connection has measured a 6s seek latency
    video.currentTime = 80; // far behind: triggers a hard catch-up seek on the next tick
    await new Promise((r) => setTimeout(r, 1200));
    assert.ok(video.currentTime > 99, `a catch-up seek happened (${video.currentTime}); also right after page load`);
    assert.ok(video.currentTime <= 99.75 + 1e-9, `seeked to ${video.currentTime}, past the end margin`);
  } finally {
    sync.destroy();
  }
});

test('catch-up seek latency is forgotten when the source changes', () => {
  const sync = new CinemaSync({ socket: fakeSocket(), clock, video: fakeVideo(), selfId: 'me' });
  try {
    sync.setInitialState(state(urlSource('a'), 10));
    sync.seekLead = 4;
    sync.lastHardSeek = 12345;
    sync.onState({ playback: state(urlSource('a'), 20), action: 'SEEK' });
    assert.equal(sync.seekLead, 4, 'same source: keep what we learned');
    sync.onState({ playback: state(urlSource('b'), 0), action: 'SOURCE' });
    assert.equal(sync.seekLead, 0);
    assert.equal(sync.lastHardSeek, -Infinity);
  } finally {
    sync.destroy();
  }
});

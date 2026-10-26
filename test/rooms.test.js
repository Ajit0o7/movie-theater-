import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_PARTICIPANTS,
  addChatMessage,
  addParticipant,
  applyHeartbeat,
  applySyncEvent,
  createRoom,
  currentTime,
  generateRoomId,
  isValidRoomId,
  removeParticipant,
  sanitizeName,
  setMedia,
  setSource,
  snapshotPlayback,
} from '../server/rooms.js';

function roomWith(...names) {
  const room = createRoom('abc123', 0);
  names.forEach((n, i) => addParticipant(room, `p${i}`, n, 0));
  return room;
}

test('room ids are valid and url-safe', () => {
  for (let i = 0; i < 50; i++) assert.ok(isValidRoomId(generateRoomId()));
  assert.equal(isValidRoomId('../etc'), false);
  assert.equal(isValidRoomId('a'), false);
});

test('names are trimmed, stripped of control chars and defaulted', () => {
  assert.equal(sanitizeName('  Ajit  '), 'Ajit');
  assert.equal(sanitizeName('\u0007'), 'Guest');
  assert.equal(sanitizeName('x'.repeat(100)).length, 32);
});

test('playback time extrapolates only while playing', () => {
  const room = roomWith('A');
  setSource(room, 'p0', { type: 'url', url: 'https://example.com/m.mp4' }, 0);
  applySyncEvent(room, 'p0', { action: 'PLAY', time: 10 }, 1000);
  assert.equal(currentTime(room.playback, 3000), 12);
  applySyncEvent(room, 'p0', { action: 'PAUSE', time: 12.5 }, 3500);
  assert.equal(currentTime(room.playback, 9000), 12.5);
});

test('any participant can play, pause and seek (two-way control)', () => {
  const room = roomWith('Host', 'Guest');
  setSource(room, 'p0', { type: 'stream', name: 'movie.mkv', duration: 100 }, 0);
  const s1 = applySyncEvent(room, 'p1', { action: 'PLAY', time: 0 }, 0);
  assert.equal(s1.playing, true);
  assert.equal(s1.lastActor, 'p1');
  const s2 = applySyncEvent(room, 'p1', { action: 'SEEK', time: 50 }, 1000);
  assert.equal(s2.time, 50);
  assert.equal(s2.playing, true, 'seek keeps play state');
  const s3 = applySyncEvent(room, 'p0', { action: 'PAUSE', time: 51 }, 2000);
  assert.equal(s3.playing, false);
});

test('seek is clamped to duration; bad times fall back to current time', () => {
  const room = roomWith('A');
  setSource(room, 'p0', { type: 'local', name: 'f.mp4', duration: 60 }, 0);
  assert.equal(applySyncEvent(room, 'p0', { action: 'SEEK', time: 999 }, 0).time, 60);
  applySyncEvent(room, 'p0', { action: 'SEEK', time: 5 }, 0);
  assert.equal(applySyncEvent(room, 'p0', { action: 'PAUSE', time: 'nope' }, 0).time, 5);
});

test('sync events are ignored with no source or a live screen share', () => {
  const room = roomWith('A');
  assert.equal(applySyncEvent(room, 'p0', { action: 'PLAY', time: 0 }), null);
  setSource(room, 'p0', { type: 'screen' });
  assert.equal(applySyncEvent(room, 'p0', { action: 'PLAY', time: 0 }), null);
  assert.equal(applySyncEvent(room, 'p0', { action: 'EXPLODE' }), null);
});

test('youtube sources need a valid video id and are two-way controllable', () => {
  const room = roomWith('A', 'B');
  assert.throws(() => setSource(room, 'p0', { type: 'youtube', videoId: 'x"><script>' }), /video id/);
  const snap = setSource(room, 'p0', { type: 'youtube', videoId: 'dQw4w9WgXcQ' });
  assert.equal(snap.source.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(snap.source.videoId, 'dQw4w9WgXcQ');
  assert.equal(applySyncEvent(room, 'p1', { action: 'PLAY', time: 12 }).playing, true);
});

test('url sources must be http(s)', () => {
  const room = roomWith('A');
  assert.throws(() => setSource(room, 'p0', { type: 'url', url: 'javascript:alert(1)' }), /valid/);
  assert.throws(() => setSource(room, 'p0', { type: 'bogus' }), /Unknown/);
});

test('only the stream owner can move the clock via heartbeat; anyone can report duration', () => {
  const room = roomWith('Host', 'Guest');
  setSource(room, 'p0', { type: 'stream', name: 'x' }, 0);
  assert.equal(applyHeartbeat(room, 'p1', { time: 99, playing: true }, 0), null);
  const withDuration = applyHeartbeat(room, 'p1', { duration: 120 }, 0);
  assert.equal(withDuration.source.duration, 120);
  const beat = applyHeartbeat(room, 'p0', { time: 42, playing: true, duration: 120 }, 5000);
  assert.equal(beat.time, 42);
  assert.equal(beat.playing, true);
});

test('leaving clears a stream/screen source owned by the leaver, not a url source', () => {
  const room = roomWith('Host', 'Guest');
  setSource(room, 'p0', { type: 'screen' });
  assert.equal(removeParticipant(room, 'p0').sourceCleared, true);
  assert.equal(room.playback.source.type, 'none');

  const room2 = roomWith('Host', 'Guest');
  setSource(room2, 'p0', { type: 'url', url: 'https://example.com/a.mp4' });
  assert.equal(removeParticipant(room2, 'p0').sourceCleared, false);
  assert.equal(room2.playback.source.type, 'url');
});

test('rooms are capped', () => {
  const room = createRoom('full');
  for (let i = 0; i < MAX_PARTICIPANTS; i++) addParticipant(room, `p${i}`, `P${i}`);
  assert.throws(() => addParticipant(room, 'extra', 'Late'), /full/);
});

test('chat keeps a bounded history and rejects empty messages', () => {
  const room = roomWith('A');
  assert.equal(addChatMessage(room, 'p0', '   '), null);
  assert.equal(addChatMessage(room, 'nobody', 'hi'), null);
  for (let i = 0; i < 150; i++) addChatMessage(room, 'p0', `m${i}`);
  assert.equal(room.chat.length, 100);
  assert.equal(room.chat.at(-1).text, 'm149');
});

test('media announcements validate kind', () => {
  const room = roomWith('A');
  assert.equal(setMedia(room, 'p0', 'stream-1', 'camera'), true);
  assert.equal(setMedia(room, 'p0', 'stream-2', 'evil'), false);
  assert.deepEqual(room.participants.get('p0').media, { 'stream-1': 'camera' });
  assert.equal(setMedia(room, 'p0', 'stream-1', null), true);
  assert.deepEqual(room.participants.get('p0').media, {});
});

test('snapshot carries server time for client-side extrapolation', () => {
  const room = roomWith('A');
  const snap = snapshotPlayback(room.playback, 1234);
  assert.equal(snap.serverTime, 1234);
  assert.equal(snap.source.type, 'none');
});

test('restarting the same file gets a new source id, so clients reload it', () => {
  const room = roomWith('A');
  const first = setSource(room, 'p0', { type: 'stream', name: 'movie.mkv', id: 'client-proposed-1' });
  const again = setSource(room, 'p0', { type: 'stream', name: 'movie.mkv' });
  assert.equal(first.source.id, 'client-proposed-1');
  assert.ok(again.source.id && again.source.id !== first.source.id);
  assert.notEqual(setSource(room, 'p0', { type: 'stream', name: 'x', id: '<bad id>' }).source.id, '<bad id>');
});

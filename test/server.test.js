import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { io as connect } from 'socket.io-client';
import { createCinemaServer } from '../server/index.js';

let server;
let baseUrl;
const clients = [];

before(async () => {
  server = createCinemaServer({ env: {} });
  await new Promise((resolve) => server.httpServer.listen(0, resolve));
  baseUrl = `http://localhost:${server.httpServer.address().port}`;
});

after(async () => {
  for (const c of clients) c.disconnect();
  server.io.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
});

async function client() {
  const socket = connect(baseUrl, { transports: ['websocket'], forceNew: true });
  clients.push(socket);
  await new Promise((resolve) => socket.once('connect', resolve));
  return socket;
}

const emit = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));

test('creates rooms and serves the theater page', async () => {
  const res = await fetch(`${baseUrl}/api/rooms`, { method: 'POST' });
  assert.equal(res.status, 201);
  const { roomId, url } = await res.json();
  assert.match(roomId, /^[a-z0-9]{6}$/);
  const page = await fetch(`${baseUrl}${url}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="player"/);
  const cfg = await (await fetch(`${baseUrl}/api/config`)).json();
  assert.ok(cfg.iceServers.length >= 1);
});

test('two participants: presence, signaling relay, two-way sync, chat and reactions', async () => {
  const a = await client();
  const b = await client();

  const joinA = await emit(a, 'room:join', { roomId: 'movienight', name: 'Ajit' });
  assert.equal(joinA.self.name, 'Ajit');
  assert.deepEqual(joinA.peers, []);

  const peerJoined = once(a, 'peer:joined');
  const joinB = await emit(b, 'room:join', { roomId: 'movienight', name: 'Friend' });
  assert.equal(joinB.peers.length, 1);
  assert.equal((await peerJoined).name, 'Friend');

  // Signaling is relayed only to the addressed peer.
  const signal = once(b, 'signal');
  a.emit('signal', { to: b.id, data: { description: { type: 'offer', sdp: 'x' } } });
  assert.deepEqual(await signal, { from: a.id, data: { description: { type: 'offer', sdp: 'x' } } });

  // Host sets a source; both get the state.
  const stateB1 = once(b, 'sync:state');
  const src = await emit(a, 'sync:source', { type: 'url', url: 'https://example.com/movie.mp4', name: 'movie.mp4' });
  assert.equal(src.playback.source.type, 'url');
  assert.equal((await stateB1).action, 'SOURCE');

  // Guest presses play; host receives it with the guest's name.
  const stateA = once(a, 'sync:state');
  const echoB = once(b, 'sync:state'); // the sender gets the authoritative state back too
  b.emit('sync:event', { action: 'PLAY', time: 30 });
  const played = await stateA;
  assert.equal((await echoB).playback.playing, true);
  assert.equal(played.action, 'PLAY');
  assert.equal(played.actor, 'Friend');
  assert.equal(played.playback.playing, true);
  assert.equal(played.playback.time, 30);

  // Host pauses; guest receives it.
  const stateB2 = once(b, 'sync:state');
  a.emit('sync:event', { action: 'PAUSE', time: 31 });
  const paused = await stateB2;
  assert.equal(paused.playback.playing, false);
  assert.equal(paused.actor, 'Ajit');

  // Chat & reactions are broadcast to everyone.
  const msg = once(b, 'chat:message');
  a.emit('chat:send', { text: 'popcorn ready?' });
  assert.equal((await msg).text, 'popcorn ready?');
  const reaction = once(a, 'reaction');
  b.emit('reaction', { emoji: '🍿' });
  assert.equal((await reaction).emoji, '🍿');

  // Late joiner gets current state and chat history.
  const c = await client();
  const joinC = await emit(c, 'room:join', { roomId: 'movienight', name: 'Late' });
  assert.equal(joinC.playback.source.url, 'https://example.com/movie.mp4');
  assert.equal(joinC.playback.time, 31);
  assert.equal(joinC.chat.at(-1).text, 'popcorn ready?');
  assert.equal(joinC.peers.length, 2);

  // Leaving is announced.
  const left = once(a, 'peer:left');
  c.disconnect();
  assert.equal((await left).name, 'Late');
});

test('screen share source is cleared when its owner leaves', async () => {
  const host = await client();
  const guest = await client();
  await emit(host, 'room:join', { roomId: 'screens', name: 'Host' });
  await emit(guest, 'room:join', { roomId: 'screens', name: 'Guest' });
  await emit(host, 'sync:source', { type: 'screen', name: 'Tab' });

  const cleared = new Promise((resolve) => guest.on('sync:state', (s) => s.playback.source.type === 'none' && resolve(s)));
  host.disconnect();
  assert.equal((await cleared).playback.source.type, 'none');
});

test('rejects invalid room ids', async () => {
  const s = await client();
  const res = await emit(s, 'room:join', { roomId: '../../etc', name: 'x' });
  assert.match(res.error, /Invalid/);
});

test('malformed client messages never crash the server', async () => {
  const s = await client();
  const events = ['room:join', 'signal', 'media:announce', 'peer:status', 'sync:source', 'sync:event', 'sync:heartbeat', 'chat:send', 'reaction', 'time:ping'];
  for (const event of events) {
    for (const payload of [null, undefined, 42, 'x', [], { roomId: 7 }]) s.emit(event, payload);
    s.emit(event, null, 5); // non-function "ack"
  }
  await emit(s, 'room:join', { roomId: 'sturdy', name: 'A' }); // and the same socket can still join
  for (const event of events) s.emit(event, null);
  await new Promise((r) => setTimeout(r, 200));
  const res = await fetch(`${baseUrl}/healthz`);
  assert.equal(res.status, 200);
});

test('a reconnect from the same tab replaces its old connection instead of leaving a ghost', async () => {
  const friend = await client();
  await emit(friend, 'room:join', { roomId: 'ghosts', name: 'Friend' });
  const oldConn = await client();
  await emit(oldConn, 'room:join', { roomId: 'ghosts', name: 'Ajit', clientId: 'tab-123456' });
  await emit(oldConn, 'sync:source', { type: 'screen', name: 'Tab' });
  const oldId = oldConn.id; // socket.io-client clears .id once disconnected

  const replaced = once(oldConn, 'session:replaced');
  const left = once(friend, 'peer:left');
  const newConn = await client(); // e.g. after a Wi-Fi switch, before the old socket timed out
  const join = await emit(newConn, 'room:join', { roomId: 'ghosts', name: 'Ajit', clientId: 'tab-123456' });
  await replaced;
  assert.equal((await left).id, oldId);
  assert.deepEqual(join.peers.map((p) => p.name), ['Friend'], 'no ghost copy of Ajit');
  assert.equal(join.playback.source.type, 'none', "the ghost's screen share was cleared");
  assert.equal(join.self.clientId, undefined, 'client ids stay private');
});

test('moving or resizing a camera tile is shared with everyone, including late joiners', async () => {
  const a = await client();
  const b = await client();
  const joinA = await emit(a, 'room:join', { roomId: 'layouts', name: 'Ajit' });
  const joinB = await emit(b, 'room:join', { roomId: 'layouts', name: 'Friend' });
  assert.notDeepEqual(joinA.self.cam, joinB.self.cam, 'each person starts on their own spot');

  // Ajit drags Ajit's tile and enlarges it; Friend sees it with Ajit's id.
  const seen = once(b, 'cam:layout');
  a.emit('cam:layout', { id: a.id, cam: { fx: 0.1, fy: 0.2, size: 'l' } });
  assert.deepEqual(await seen, { id: a.id, cam: { fx: 0.1, fy: 0.2, size: 'l' } });

  // Friend moves Ajit's tile; Ajit sees it too (any participant arranges any tile).
  const seenByA = once(a, 'cam:layout');
  b.emit('cam:layout', { id: a.id, cam: { fx: 0.9, fy: 0.9, size: 's' } });
  assert.deepEqual((await seenByA).cam, { fx: 0.9, fy: 0.9, size: 's' });

  const late = await client();
  const joinLate = await emit(late, 'room:join', { roomId: 'layouts', name: 'Late' });
  const ajit = joinLate.peers.find((p) => p.name === 'Ajit');
  assert.deepEqual(ajit.cam, { fx: 0.9, fy: 0.9, size: 's' });

  // Unknown tiles and junk are ignored without a crash.
  a.emit('cam:layout', { id: 'nobody', cam: { fx: 0, fy: 0 } });
  a.emit('cam:layout', null);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
});

test('a newly learned duration reaches everyone including the reporter; position heartbeats do not echo to the owner', async () => {
  const owner = await client();
  const guest = await client();
  await emit(owner, 'room:join', { roomId: 'beats', name: 'Owner' });
  await emit(guest, 'room:join', { roomId: 'beats', name: 'Guest' });
  const guestSawSource = once(guest, 'sync:state');
  await emit(owner, 'sync:source', { type: 'stream', name: 'movie.mkv' });
  await guestSawSource; // let the source broadcast land before listening for the duration

  const ownerStates = [];
  owner.on('sync:state', (s) => ownerStates.push(s));
  const guestDuration = once(guest, 'sync:state');
  const ownerDuration = new Promise((resolve) => owner.once('sync:state', resolve));
  owner.emit('sync:heartbeat', { duration: 7200 });
  const [g, o] = await Promise.all([guestDuration, ownerDuration]);
  assert.equal(g.playback.source.duration, 7200);
  assert.equal(o.playback.source.duration, 7200, 'the reporter learns it too');
  assert.equal(o.action, 'DURATION');

  // Ongoing position heartbeats go to the guest only.
  ownerStates.length = 0;
  const guestBeat = once(guest, 'sync:state');
  owner.emit('sync:heartbeat', { time: 12, playing: true, duration: 7200 });
  assert.equal((await guestBeat).action, 'HEARTBEAT');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ownerStates.length, 0, 'the owner is not sent its own position back');
});

test('the server listens on all IPv4 interfaces by default (needed on Render/Docker)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(src, /process\.env\.HOST \|\| '0\.0\.0\.0'/);
  assert.match(src, /httpServer\.listen\(port, host,/);
});

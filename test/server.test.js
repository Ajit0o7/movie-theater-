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

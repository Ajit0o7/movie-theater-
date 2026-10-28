import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { io as connect } from 'socket.io-client';
import { createCinemaServer } from '../server/index.js';

let server;
let baseUrl;
const clients = [];

before(async () => {
  server = createCinemaServer({ env: {}, hostGraceMs: 300 });
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
  const events = ['room:join', 'signal', 'media:announce', 'peer:status', 'sync:source', 'sync:event', 'sync:heartbeat', 'chat:send', 'reaction', 'time:ping',
    'remote:pair', 'remote:join', 'remote:command', 'remote:signal', 'remote:state', 'remote:unpair'];
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
  assert.equal(join.playback.source.type, 'screen', 'the reconnected tab gets its screen share back');
  assert.equal(join.playback.source.ownerId, newConn.id);
  assert.equal(join.playback.source.ownerAway, undefined);
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

test('a host whose connection drops keeps the stream for a grace period and gets it back', async () => {
  const guest = await client();
  await emit(guest, 'room:join', { roomId: 'grace', name: 'Guest' });
  const host = await client();
  await emit(host, 'room:join', { roomId: 'grace', name: 'Host', clientId: 'host-tab-1' });
  const started = await emit(host, 'sync:source', { type: 'stream', name: 'movie.mkv' });
  assert.equal(started.playback.source.ownerName, 'Host');
  assert.equal(JSON.stringify(started).includes('host-tab-1'), false, 'client ids never reach other clients');

  const away = new Promise((resolve) => guest.on('sync:state', (s) => s.action === 'OWNER_AWAY' && resolve(s)));
  host.disconnect(); // e.g. Wi-Fi drops
  const awayState = await away;
  assert.equal(awayState.playback.source.type, 'stream', 'not cleared');
  assert.equal(awayState.playback.source.ownerAway, true);

  const back = new Promise((resolve) => guest.on('sync:state', (s) => s.action === 'OWNER_BACK' && resolve(s)));
  const again = await client();
  const join = await emit(again, 'room:join', { roomId: 'grace', name: 'Host', clientId: 'host-tab-1' });
  assert.equal(join.playback.source.ownerId, again.id);
  assert.equal(join.playback.source.id, started.playback.source.id, 'same source continues');
  assert.equal((await back).playback.source.ownerId, again.id);

  await new Promise((r) => setTimeout(r, 450)); // past the grace period: nothing expires now
  const late = await client();
  assert.equal((await emit(late, 'room:join', { roomId: 'grace', name: 'Late' })).playback.source.type, 'stream');
});

test('the stream ends if the host does not return in time, or leaves on purpose', async () => {
  const guest = await client();
  await emit(guest, 'room:join', { roomId: 'grace2', name: 'Guest' });
  const host = await client();
  await emit(host, 'room:join', { roomId: 'grace2', name: 'Host', clientId: 'host-tab-2' });
  await emit(host, 'sync:source', { type: 'screen', name: 'Tab' });
  const cleared = new Promise((resolve) => guest.on('sync:state', (s) => s.action === 'SOURCE' && s.playback.source.type === 'none' && resolve(s)));
  host.disconnect();
  await cleared; // after the (test-shortened) grace period

  const host2 = await client();
  await emit(host2, 'room:join', { roomId: 'grace2', name: 'Host', clientId: 'host-tab-3' });
  await emit(host2, 'sync:source', { type: 'screen', name: 'Tab' });
  const ended = new Promise((resolve) => guest.on('sync:state', (s) => s.action === 'SOURCE' && s.playback.source.type === 'none' && resolve(s)));
  const t0 = Date.now();
  host2.emit('room:leave'); // closing the tab
  await ended;
  assert.ok(Date.now() - t0 < 250, 'no grace period for a deliberate leave');
});

test('subtitles reach everyone and late joiners; reactions carry the movie time', async () => {
  const a = await client();
  const b = await client();
  await emit(a, 'room:join', { roomId: 'subs', name: 'Ajit' });
  await emit(b, 'room:join', { roomId: 'subs', name: 'Friend' });
  const seenSource = once(b, 'sync:state');
  await emit(a, 'sync:source', { type: 'url', url: 'https://example.com/m.mp4', name: 'm.mp4' });
  await seenSource;
  const got = once(b, 'subs:state');
  const res = await emit(a, 'subs:set', { name: 'm.en.srt', text: '1\n00:00:01,000 --> 00:00:02,000\nHello' });
  assert.equal(res.ok, true);
  const { subs, actor } = await got;
  assert.equal(subs.name, 'm.en.srt');
  assert.equal(actor, 'Ajit');

  const reaction = once(b, 'reaction');
  a.emit('reaction', { emoji: '😱' });
  assert.equal(typeof (await reaction).t, 'number');

  const late = await client();
  const join = await emit(late, 'room:join', { roomId: 'subs', name: 'Late' });
  assert.equal(join.subtitles.name, 'm.en.srt');
  assert.equal(join.moments.length, 1);

  const cleared = once(late, 'subs:state');
  b.emit('subs:clear');
  assert.equal((await cleared).subs, null);
});

test('a paired phone remote-controls its own computer only, and outlives that computer reloading', async () => {
  const pc = await client();
  const friend = await client();
  await emit(pc, 'room:join', { roomId: 'phonenight', name: 'Ajit', clientId: 'tab-phone-1' });
  await emit(friend, 'room:join', { roomId: 'phonenight', name: 'Friend', clientId: 'tab-phone-2' });

  // The computer gets a link for the phone and its QR code; on localhost it points at the LAN.
  const pair = await emit(pc, 'remote:pair', { origin: 'https://cinema.example.com' });
  assert.match(pair.url, /^https:\/\/cinema\.example\.com\/remote\/phonenight\?pair=[\w-]{22}$/);
  assert.match(pair.qr, /^<svg[^>]*viewBox/);
  assert.equal((await emit(pc, 'remote:pair', { origin: 'https://cinema.example.com' })).url, pair.url, 'reopening shows the same code');
  const token = new URL(pair.url).searchParams.get('pair');
  const page = await fetch(`${baseUrl}/remote/phonenight?pair=${token}`);
  assert.match(await page.text(), /id="remote"/);

  assert.match((await emit(await client(), 'remote:join', { token: 'nope' })).error, /expired/);
  const phone = await client();
  const status = once(pc, 'remote:status');
  const joined = await emit(phone, 'remote:join', { token });
  assert.deepEqual(joined, { ok: true, roomId: 'phonenight', name: 'Ajit', online: true });
  assert.equal((await status).phones, 1);

  // Commands reach the paired computer (validated), and nobody else; the phone is not a participant.
  let friendHeard = false;
  friend.on('remote:command', () => (friendHeard = true));
  const command = once(pc, 'remote:command');
  phone.emit('remote:command', { cmd: 'seekBy', value: 'lots' }); // invalid: dropped
  phone.emit('remote:command', { cmd: 'rm -rf' });
  phone.emit('remote:command', { cmd: 'seekBy', value: 10 });
  assert.deepEqual(await command, { cmd: 'seekBy', value: 10, from: phone.id });
  const reaction = once(pc, 'remote:command');
  phone.emit('remote:command', { cmd: 'reaction', value: '🔥' });
  assert.equal((await reaction).value, '🔥');
  // The computer's state reaches its phone; camera signaling flows both ways between just them.
  const state = once(phone, 'remote:state');
  pc.emit('remote:state', { playing: true, time: 12, title: 'Film' });
  assert.deepEqual(await state, { playing: true, time: 12, title: 'Film' });
  const offer = once(pc, 'remote:signal');
  phone.emit('remote:signal', { data: { description: { type: 'offer', sdp: 'o' } } });
  assert.deepEqual(await offer, { from: phone.id, data: { description: { type: 'offer', sdp: 'o' } } });
  const answer = once(phone, 'remote:signal');
  pc.emit('remote:signal', { to: phone.id, data: { description: { type: 'answer', sdp: 'a' } } });
  assert.deepEqual(await answer, { data: { description: { type: 'answer', sdp: 'a' } } });
  friend.emit('remote:signal', { to: phone.id, data: { evil: true } }); // not their phone
  friend.emit('remote:state', { evil: true });
  assert.match((await emit(phone, 'room:join', { roomId: 'phonenight', name: 'Sneaky' })).error, /Already/, 'a phone never becomes a participant');
  const roster = await emit(await client(), 'room:join', { roomId: 'phonenight', name: 'Late' });
  assert.deepEqual(roster.peers.map((p) => p.name).sort(), ['Ajit', 'Friend'], 'the phone is not in the room');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(friendHeard, false);

  // The computer reloads: the phone waits, then carries on with the same pairing.
  const away = once(phone, 'remote:owner');
  pc.emit('room:leave');
  pc.disconnect();
  assert.deepEqual(await away, { online: false, name: 'Ajit' });
  const back = once(phone, 'remote:owner');
  const reloaded = await client();
  const statusAgain = once(reloaded, 'remote:status');
  await emit(reloaded, 'room:join', { roomId: 'phonenight', name: 'Ajit', clientId: 'tab-phone-1' });
  assert.deepEqual(await back, { online: true, name: 'Ajit' });
  assert.equal((await statusAgain).phones, 1);
  const again = once(reloaded, 'remote:command');
  phone.emit('remote:command', { cmd: 'toggle' });
  assert.deepEqual(await again, { cmd: 'toggle', from: phone.id });

  // Unpairing ends it: the phone is told and disconnected, and the code stops working.
  const ended = once(phone, 'remote:ended');
  reloaded.emit('remote:unpair');
  await ended;
  assert.match((await emit(await client(), 'remote:join', { token })).error, /expired/);
});

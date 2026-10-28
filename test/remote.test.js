import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OWNER_GONE_TTL_MS,
  PAIR_TTL_MS,
  acceptableState,
  createPairings,
  joinPairing,
  pairFor,
  phoneOrigin,
  sanitizeCommand,
  sweepPairings,
} from '../server/remote.js';

test('the phone link points at an address the phone can reach', () => {
  const lan = ['https://192.168.1.20:3000'];
  assert.equal(phoneOrigin('https://cinema.example.com', lan), 'https://cinema.example.com');
  assert.equal(phoneOrigin('http://localhost:3000', lan), 'https://192.168.1.20:3000', 'a phone can’t open the computer’s localhost');
  assert.equal(phoneOrigin('http://127.0.0.1:3000', lan), 'https://192.168.1.20:3000');
  assert.equal(phoneOrigin('http://localhost:3000', []), 'http://localhost:3000', 'no LAN: best effort');
  assert.equal(phoneOrigin('javascript:alert(1)', lan), 'https://192.168.1.20:3000');
  assert.equal(phoneOrigin(undefined, []), null);
});

test('only known remote commands with sane values get through', () => {
  assert.deepEqual(sanitizeCommand({ cmd: 'toggle', value: 'ignored' }), { cmd: 'toggle' });
  assert.deepEqual(sanitizeCommand({ cmd: 'seekBy', value: -10 }), { cmd: 'seekBy', value: -10 });
  assert.deepEqual(sanitizeCommand({ cmd: 'volume', value: 0.5 }), { cmd: 'volume', value: 0.5 });
  assert.deepEqual(sanitizeCommand({ cmd: 'reaction', value: '😂' }), { cmd: 'reaction', value: '😂' });
  for (const bad of [{ cmd: 'seek', value: -1 }, { cmd: 'volume', value: 2 }, { cmd: 'seekBy', value: NaN }, { cmd: 'reaction', value: '<b>' }, { cmd: 'eval' }, {}, undefined]) {
    assert.equal(sanitizeCommand(bad), null, JSON.stringify(bad));
  }
  assert.equal(acceptableState({ playing: true }), true);
  assert.equal(acceptableState({ title: 'x'.repeat(5000) }), false);
  assert.equal(acceptableState([1]), false);
});

test('pairings: one per computer tab, a few phones each, and they expire', () => {
  const store = createPairings();
  const a = pairFor(store, { roomId: 'r', clientId: 'tab-a', socketId: 's1', name: 'Ajit' }, 0);
  assert.equal(pairFor(store, { roomId: 'r', clientId: 'tab-a', socketId: 's2', name: 'Ajit' }, 5).token, a.token, 'reopening keeps the code');
  assert.equal(a.ownerSocketId, 's2');
  assert.notEqual(pairFor(store, { roomId: 'r', clientId: 'tab-b', socketId: 's3', name: 'B' }, 0).token, a.token);
  for (const id of ['p1', 'p2', 'p3']) assert.ok(joinPairing(store, a.token, id).pairing);
  assert.match(joinPairing(store, a.token, 'p4').error, /Too many/);
  assert.match(joinPairing(store, 'guess', 'p5').error, /expired/);
  // The computer has been gone 30 minutes: over. Others last at most 12 hours.
  a.ownerGoneSince = 1000;
  assert.deepEqual(sweepPairings(store, 1000 + OWNER_GONE_TTL_MS - 1), []);
  assert.deepEqual(sweepPairings(store, 1000 + OWNER_GONE_TTL_MS + 1).map((p) => p.token), [a.token]);
  assert.equal(sweepPairings(store, PAIR_TTL_MS + 1).length, 1);
  assert.equal(store.byToken.size, 0);
});

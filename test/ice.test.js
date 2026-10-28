import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIceProvider, normalizeIceServers } from '../server/ice.js';

const quiet = { warn() {} };
const turn = { urls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349'], username: 'u', credential: 'p' };
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('without any TURN settings only STUN is returned', async () => {
  const ice = createIceProvider({}, { fetchImpl: () => assert.fail('no fetch expected'), log: quiet });
  assert.equal(ice.source, 'none');
  const servers = await ice.iceServers();
  assert.equal(servers.length, 1);
  assert.match(String(servers[0].urls), /^stun:/);
});

test('a fixed TURN server from TURN_URLS is added after STUN', async () => {
  const ice = createIceProvider({ TURN_URLS: 'turn:a.example:3478, turns:a.example:5349', TURN_USERNAME: 'x', TURN_CREDENTIAL: 'y' }, { log: quiet });
  assert.equal(ice.source, 'static');
  const [, relay] = await ice.iceServers();
  assert.deepEqual(relay, { urls: ['turn:a.example:3478', 'turns:a.example:5349'], username: 'x', credential: 'y' });
});

test('Cloudflare: short-lived credentials, bearer auth, cached instead of fetched per visitor', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return json({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }, turn] });
  };
  const ice = createIceProvider({ CLOUDFLARE_TURN_KEY_ID: 'key123', CLOUDFLARE_TURN_API_TOKEN: 'tok' }, { fetchImpl, log: quiet });
  assert.equal(ice.source, 'cloudflare');
  const servers = await ice.iceServers();
  assert.ok(servers.some((s) => s.credential === 'p'));
  assert.equal(calls[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/key123/credentials/generate-ice-servers');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(JSON.parse(calls[0].init.body).ttl, 86400);
  await Promise.all([ice.iceServers(), ice.iceServers(), ice.iceServers()]);
  assert.equal(calls.length, 1, 'served from cache');
});

test('Cloudflare: falls back to the original endpoint and its single-object response', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return url.endsWith('/generate-ice-servers') ? json({}, 404) : json({ iceServers: turn });
  };
  const ice = createIceProvider({ CLOUDFLARE_TURN_KEY_ID: 'k', CLOUDFLARE_TURN_API_TOKEN: 't' }, { fetchImpl, log: quiet });
  const servers = await ice.iceServers();
  assert.deepEqual(urls.map((u) => u.split('/').pop()), ['generate-ice-servers', 'generate']);
  assert.deepEqual(servers.at(-1), turn);
});

test('TURN_CREDENTIALS_URL (e.g. Metered) accepts a plain array', async () => {
  const fetchImpl = async () => json([{ urls: 'stun:stun.relay.metered.ca:80' }, turn]);
  const ice = createIceProvider({ TURN_CREDENTIALS_URL: 'https://app.metered.live/api/v1/turn/credentials?apiKey=k' }, { fetchImpl, log: quiet });
  assert.equal(ice.source, 'url');
  assert.ok((await ice.iceServers()).some((s) => s.username === 'u'));
});

test('a failing provider never blocks joining: STUN is returned and retries are spaced out', async () => {
  let calls = 0;
  let clock = 1_000_000;
  const fetchImpl = async () => {
    calls++;
    throw new Error('network down');
  };
  const ice = createIceProvider({ TURN_CREDENTIALS_URL: 'https://x.example/creds' }, { fetchImpl, log: quiet, now: () => clock });
  const servers = await ice.iceServers();
  assert.equal(servers.length, 1);
  await ice.iceServers();
  assert.equal(calls, 1, 'no hammering right after a failure');
  clock += 61_000;
  await ice.iceServers();
  assert.equal(calls, 2, 'retried after a minute');
});

test('responses without any turn: entry are rejected (e.g. an error page returning JSON)', async () => {
  const ice = createIceProvider({ TURN_CREDENTIALS_URL: 'https://x.example' }, { fetchImpl: async () => json([{ urls: 'stun:only' }]), log: quiet });
  assert.equal((await ice.iceServers()).length, 1);
});

test('normalizeIceServers drops junk entries and keeps only known fields', () => {
  assert.deepEqual(normalizeIceServers({ iceServers: [{ urls: [] }, null, { urls: 'turn:x', username: 'a', credential: 'b', extra: 1 }] }), [
    { urls: 'turn:x', username: 'a', credential: 'b' },
  ]);
  assert.deepEqual(normalizeIceServers('nonsense'), []);
});

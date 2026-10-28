// ICE servers for WebRTC. STUN alone only works when both people's networks allow a direct
// connection; mobile data (CGNAT), campus, hotel and office networks often don't, and then
// a TURN relay is needed. Options, first match wins:
//
//   CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN   short-lived credentials from Cloudflare
//   TURN_CREDENTIALS_URL                                 any URL returning ICE servers as JSON,
//                                                        e.g. Metered: https://<app>.metered.live/api/v1/turn/credentials?apiKey=<key>
//   TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL          a fixed TURN server (e.g. your own coturn)
//
// Fetched credentials are cached and refreshed before they expire, so the provider is hit
// about once a day, not once per visitor. If the provider fails, STUN still works.

const DEFAULT_STUN = 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302';
const CREDENTIAL_TTL_S = 24 * 60 * 60;
const REFRESH_BEFORE_MS = 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

export function stunServers(env) {
  return [{ urls: (env.STUN_URLS || DEFAULT_STUN).split(',').map((u) => u.trim()).filter(Boolean) }];
}

/** Accepts the shapes providers return: an array, { iceServers: [...] } or { iceServers: {...} }. */
export function normalizeIceServers(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.iceServers) ? data.iceServers : data?.iceServers ? [data.iceServers] : [];
  return list
    .filter((s) => s && (typeof s.urls === 'string' || Array.isArray(s.urls)) && s.urls.length)
    .map((s) => ({ urls: s.urls, ...(s.username ? { username: s.username } : {}), ...(s.credential ? { credential: s.credential } : {}) }));
}

const hasTurn = (servers) => servers.some((s) => [].concat(s.urls).some((u) => /^turns?:/i.test(u)));

async function fetchJson(fetchImpl, url, init) {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function cloudflareIceServers(env, fetchImpl) {
  const base = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CLOUDFLARE_TURN_KEY_ID)}/credentials`;
  const init = {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: CREDENTIAL_TTL_S }),
  };
  // Newer endpoint returns a ready-made list; the original one returns a single object.
  let lastError;
  for (const path of ['generate-ice-servers', 'generate']) {
    try {
      const servers = normalizeIceServers(await fetchJson(fetchImpl, `${base}/${path}`, init));
      if (servers.length) return servers;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('no ICE servers in response');
}

export function createIceProvider(env = process.env, { fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
  const stun = stunServers(env);
  const staticTurn = env.TURN_URLS
    ? [{ urls: env.TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }]
    : [];
  const source = env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN ? 'cloudflare' : env.TURN_CREDENTIALS_URL ? 'url' : staticTurn.length ? 'static' : 'none';

  let cached = null; // { servers, expiresAt }
  let inflight = null;
  let retryAt = 0;

  async function fetchFresh() {
    const servers =
      source === 'cloudflare'
        ? await cloudflareIceServers(env, fetchImpl)
        : normalizeIceServers(await fetchJson(fetchImpl, env.TURN_CREDENTIALS_URL, { headers: { Accept: 'application/json' } }));
    if (!hasTurn(servers)) throw new Error('response contained no turn: servers');
    return servers;
  }

  async function iceServers() {
    if (source === 'static') return [...stun, ...staticTurn];
    if (source === 'none') return stun;
    const t = now();
    if (cached && cached.expiresAt - t > REFRESH_BEFORE_MS) return cached.servers;
    if (t < retryAt) return cached?.servers ?? stun;
    inflight ??= fetchFresh()
      .then((servers) => {
        // Keep STUN first; a provider's list may already include its own STUN entries.
        cached = { servers: [...stun, ...servers], expiresAt: t + CREDENTIAL_TTL_S * 1000 };
        return cached.servers;
      })
      .catch((err) => {
        retryAt = now() + RETRY_AFTER_FAILURE_MS;
        log.warn?.(`[ice] TURN credentials from ${source} failed (${err.message}); using ${cached ? 'previous credentials' : 'STUN only'}.`);
        return cached?.servers ?? stun;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return { source, iceServers };
}

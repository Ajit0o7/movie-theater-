// Phone pairing: a computer in a room shows a QR code; the phone that scans it becomes that
// person's remote control (and, optionally, their webcam). A phone is never a room
// participant: it talks only to the computer it is paired with, through the server.

import { randomBytes } from 'node:crypto';
import { isValidReaction } from './rooms.js';

export const PAIR_TTL_MS = 12 * 60 * 60 * 1000; // a pairing lasts one evening at most
export const OWNER_GONE_TTL_MS = 30 * 60 * 1000; // ...or until its computer has been gone this long
export const MAX_PHONES = 3;
const MAX_STATE_CHARS = 4000;

const ownerKey = (roomId, clientId) => `${roomId}|${clientId}`;

/** A store of pairings: by token, and by owner (room + the owner tab's private client id). */
export function createPairings() {
  return { byToken: new Map(), byOwner: new Map() };
}

/** The owner's pairing, created on first use; the same token is shown again on reopening. */
export function pairFor(store, { roomId, clientId, socketId, name }, now) {
  const key = ownerKey(roomId, clientId);
  let pairing = store.byOwner.get(key);
  if (!pairing) {
    pairing = { token: randomBytes(16).toString('base64url'), key, roomId, created: now, phones: new Set() };
    store.byOwner.set(key, pairing);
    store.byToken.set(pairing.token, pairing);
  }
  Object.assign(pairing, { ownerSocketId: socketId, ownerName: name, ownerGoneSince: null });
  return pairing;
}

export const findOwnerPairing = (store, roomId, clientId) => store.byOwner.get(ownerKey(roomId, clientId)) ?? null;

export function findPairingOwnedBy(store, socketId) {
  for (const p of store.byOwner.values()) if (p.ownerSocketId === socketId) return p;
  return null;
}

/** A phone scanning the code. */
export function joinPairing(store, token, socketId) {
  const pairing = typeof token === 'string' ? store.byToken.get(token) : null;
  if (!pairing) return { error: 'This pairing code has expired. Show the QR code on the computer again (Phone button) and scan it.' };
  if (pairing.phones.size >= MAX_PHONES && !pairing.phones.has(socketId)) return { error: 'Too many phones are paired with this computer.' };
  pairing.phones.add(socketId);
  return { pairing };
}

export function deletePairing(store, pairing) {
  store.byOwner.delete(pairing.key);
  store.byToken.delete(pairing.token);
}

/** Removes and returns expired pairings. */
export function sweepPairings(store, now) {
  const expired = [];
  for (const p of store.byOwner.values()) {
    if (now - p.created > PAIR_TTL_MS || (p.ownerGoneSince !== null && now - p.ownerGoneSince > OWNER_GONE_TTL_MS)) expired.push(p);
  }
  for (const p of expired) deletePairing(store, p);
  return expired;
}

/** A remote-control command from a phone, validated; null when it isn't one. */
export function sanitizeCommand({ cmd, value } = {}) {
  const num = (min, max) => (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null);
  switch (cmd) {
    case 'toggle':
    case 'state':
      return { cmd };
    case 'seekBy':
      return num(-3600, 3600) === null ? null : { cmd, value };
    case 'seek':
      return num(0, 1e7) === null ? null : { cmd, value };
    case 'volume':
      return num(0, 1) === null ? null : { cmd, value };
    case 'reaction':
      return isValidReaction(value) ? { cmd, value } : null;
    default:
      return null;
  }
}

/** The computer's player state for its phones: a small plain object, passed through as is. */
export function acceptableState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  try {
    return JSON.stringify(state).length <= MAX_STATE_CHARS;
  } catch {
    return false;
  }
}

/** The address a phone should open: a computer on localhost must be reached by its LAN IP. */
export function phoneOrigin(origin, lanOrigins) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return lanOrigins[0] ?? null;
  }
  if (!/^https?:$/.test(url.protocol)) return lanOrigins[0] ?? null;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost');
  return loopback && lanOrigins.length ? lanOrigins[0] : url.origin;
}

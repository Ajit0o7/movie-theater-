// Room state for the virtual cinema. Pure logic, no sockets, so it can be unit tested.
//
// Playback state is authoritative on the server. Instead of storing a constantly
// changing "current time", we store the media time at a known server timestamp and
// extrapolate from it while playing.

import { randomBytes } from 'node:crypto';

export const MAX_PARTICIPANTS = 8;
export const CHAT_HISTORY_LIMIT = 100;
export const MAX_CHAT_LENGTH = 1000;
export const MAX_NAME_LENGTH = 32;
export const REACTIONS = ['🍿', '❤️', '😂', '👏', '😱', '🔥', '😭', '👀'];
// url: everyone loads the same link; youtube: everyone embeds the same YouTube video;
// local: everyone opens their own copy of the same file;
// stream: one person's file is streamed over WebRTC; screen: one person's screen/tab capture.
export const SOURCE_TYPES = ['none', 'url', 'youtube', 'local', 'stream', 'screen'];

const ROOM_ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function generateRoomId(length = 6) {
  const bytes = randomBytes(length);
  let id = '';
  for (let i = 0; i < length; i++) id += ROOM_ID_ALPHABET[bytes[i] % ROOM_ID_ALPHABET.length];
  return id;
}

export function isValidRoomId(id) {
  return typeof id === 'string' && /^[a-z0-9-]{3,40}$/i.test(id);
}

export function sanitizeName(name) {
  const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH);
  return clean || 'Guest';
}

function emptySource() {
  return { id: null, type: 'none', url: null, name: null, ownerId: null, duration: null };
}

/**
 * Every source gets a unique id so clients can tell "the same file/screen started again"
 * apart from "nothing changed". The owner may propose the id (it has to recognise its own
 * pending media before the server's confirmation arrives); otherwise the server makes one.
 */
function sourceId(proposed) {
  return typeof proposed === 'string' && /^[\w-]{6,64}$/.test(proposed) ? proposed : randomBytes(9).toString('base64url');
}

export function createRoom(id, now = Date.now()) {
  return {
    id,
    createdAt: now,
    participants: new Map(), // socketId -> { id, name, joinedAt, media: { [streamId]: 'camera' | 'movie' }, status }
    chat: [],
    subtitles: null, // { id, sourceId, name, text, by }: shared with everyone, tied to one source
    moments: [], // [{ t, emoji }]: reactions stamped with the movie time, for the timeline
    playback: {
      source: emptySource(),
      playing: false,
      time: 0,          // media time (seconds) at `updatedAt`
      updatedAt: now,   // server ms timestamp
      rate: 1,
      lastActor: null,
    },
  };
}

/** Current media time, extrapolated from the last known state. */
export function currentTime(playback, now = Date.now()) {
  if (!playback.playing) return playback.time;
  const t = playback.time + ((now - playback.updatedAt) / 1000) * playback.rate;
  const d = playback.source.duration;
  return d && Number.isFinite(d) ? Math.min(t, d) : t;
}

export function snapshotPlayback(playback, now = Date.now()) {
  return {
    source: { ...playback.source },
    playing: playback.playing,
    time: currentTime(playback, now),
    serverTime: now,
    rate: playback.rate,
    lastActor: playback.lastActor,
  };
}

// Camera tiles are laid out once per room and shared by everyone. A position is stored as
// fractions (0..1) of the *free* space (viewport minus the tile), so "bottom-right" is
// bottom-right on every screen regardless of its size.
export const CAM_SIZES = ['s', 'm', 'l', 'min'];
const SLOTS_PER_COLUMN = 3;

/**
 * Default spot for the n-th person. `auto` means "nobody has arranged this tile yet": each
 * client stacks auto tiles up the right edge by `slot` using its own screen and tile sizes
 * (fixed fractions would overlap on short screens). fx/fy are only a fallback. The first
 * move or resize by anyone replaces it with a real, shared position.
 */
export function defaultCamLayout(slot) {
  const column = Math.floor(slot / SLOTS_PER_COLUMN);
  const row = slot % SLOTS_PER_COLUMN;
  return { fx: Math.max(0, 1 - column * 0.16), fy: Math.max(0, 0.84 - row * 0.3), size: 'm', auto: true, slot };
}

export function normalizeCamLayout(input, fallback) {
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(1, Math.max(0, Number(v))) : d);
  return {
    fx: num(input?.fx, fallback.fx),
    fy: num(input?.fy, fallback.fy),
    size: CAM_SIZES.includes(input?.size) ? input.size : fallback.size,
  };
}

/** Lets anyone arrange anyone's tile. Returns the stored layout, or null for an unknown tile. */
export function setCamLayout(room, targetId, input) {
  const target = room.participants.get(targetId);
  if (!target) return null;
  target.cam = normalizeCamLayout(input, target.cam);
  return target.cam;
}

export const isValidClientId = (id) => typeof id === 'string' && /^[\w-]{6,64}$/.test(id);

/** The participant (if any) that an earlier connection of the same browser tab created. */
export function findByClientId(room, clientId) {
  if (!isValidClientId(clientId)) return null;
  for (const p of room.participants.values()) if (p.clientId === clientId) return p;
  return null;
}

export function addParticipant(room, id, name, now = Date.now(), clientId = null) {
  if (room.participants.size >= MAX_PARTICIPANTS) {
    throw new RoomError('ROOM_FULL', `Room is full (max ${MAX_PARTICIPANTS} people).`);
  }
  const taken = new Set([...room.participants.values()].map((p) => p.slot));
  let slot = 0;
  while (taken.has(slot)) slot++;
  const participant = {
    id,
    slot,
    cam: defaultCamLayout(slot),
    clientId: isValidClientId(clientId) ? clientId : null, // private: never sent to other clients
    name: sanitizeName(name),
    joinedAt: now,
    media: {},
    status: { camera: false, mic: false },
  };
  room.participants.set(id, participant);
  return participant;
}

/** Removes a participant. If they owned the current stream/screen source, the source is cleared. */
/**
 * Removes a participant. A stream/screen source they owned is cleared, unless `grace` is set
 * and the tab can be recognised again (it has a client id): then the source is kept and
 * marked `ownerAway`, so a host whose Wi-Fi blinks or laptop sleeps can come back and carry
 * on instead of the movie stopping for everyone. See reclaimSource / expireAwaySource.
 */
export function removeParticipant(room, id, now = Date.now(), { grace = false } = {}) {
  const participant = room.participants.get(id);
  room.participants.delete(id);
  let sourceCleared = false;
  let sourceAway = false;
  const { source } = room.playback;
  if (source.ownerId === id && (source.type === 'stream' || source.type === 'screen')) {
    if (grace && room.sourceOwnerClientId && room.sourceOwnerClientId === participant?.clientId) {
      room.playback = { ...room.playback, source: { ...source, ownerAway: true } };
      sourceAway = true;
    } else {
      room.playback = { ...room.playback, source: emptySource(), playing: false, time: 0, updatedAt: now };
      room.sourceOwnerClientId = null;
      sourceCleared = true;
    }
  }
  return { participant, sourceCleared, sourceAway };
}

/** The away host's tab is back (same client id): hand the source to its new connection. */
export function reclaimSource(room, clientId, newId) {
  const { source } = room.playback;
  if (!source.ownerAway || !isValidClientId(clientId) || room.sourceOwnerClientId !== clientId) return false;
  const { ownerAway, ...rest } = source;
  room.playback = { ...room.playback, source: { ...rest, ownerId: newId } };
  return true;
}

/** Grace period over and the host never came back: stop the source. */
export function expireAwaySource(room, now = Date.now()) {
  if (!room.playback.source.ownerAway) return false;
  room.playback = { ...room.playback, source: emptySource(), playing: false, time: 0, updatedAt: now };
  room.sourceOwnerClientId = null;
  return true;
}

export function publicParticipant(p) {
  return { id: p.id, name: p.name, media: { ...p.media }, status: { ...p.status }, cam: { ...p.cam } };
}

export function listParticipants(room) {
  return [...room.participants.values()].map(publicParticipant);
}

export function setMedia(room, participantId, streamId, kind) {
  const p = room.participants.get(participantId);
  if (!p || typeof streamId !== 'string' || streamId.length > 128) return false;
  if (kind === null) {
    delete p.media[streamId];
    return true;
  }
  if (kind !== 'camera' && kind !== 'movie') return false;
  p.media[streamId] = kind;
  return true;
}

export function setStatus(room, participantId, status) {
  const p = room.participants.get(participantId);
  if (!p) return null;
  p.status = { camera: Boolean(status?.camera), mic: Boolean(status?.mic) };
  return p.status;
}

export function setSource(room, actorId, input, now = Date.now()) {
  const type = input?.type;
  if (!SOURCE_TYPES.includes(type)) throw new RoomError('BAD_SOURCE', 'Unknown source type.');
  let source = emptySource();
  if (type === 'url') {
    const url = String(input.url ?? '').trim();
    if (!/^https?:\/\//i.test(url) || url.length > 2048) throw new RoomError('BAD_SOURCE', 'Enter a valid http(s) video URL.');
    source = { type, url, name: String(input.name ?? '').slice(0, 200) || url, ownerId: actorId, duration: null };
  } else if (type === 'youtube') {
    const videoId = String(input.videoId ?? '');
    if (!/^[\w-]{11}$/.test(videoId)) throw new RoomError('BAD_SOURCE', 'That YouTube link has no valid video id.');
    source = {
      type,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
      name: String(input.name ?? '').slice(0, 200) || 'YouTube video',
      ownerId: actorId,
      duration: null,
    };
  } else if (type === 'local' || type === 'stream' || type === 'screen') {
    source = {
      type,
      url: null,
      name: String(input.name ?? '').slice(0, 200) || (type === 'screen' ? 'Screen share' : 'Movie'),
      ownerId: actorId,
      duration: validDuration(input.duration),
    };
  }
  if (type !== 'none') {
    source.id = sourceId(input.id);
    // The owner's name lets guests see who they are waiting for if the owner drops.
    source.ownerName = room.participants.get(actorId)?.name ?? null;
  }
  // Subtitles and reaction moments belong to the previous movie.
  room.subtitles = null;
  room.moments = [];
  // Private (never sent to clients): recognises the owner's tab if it reconnects.
  room.sourceOwnerClientId = type === 'none' ? null : room.participants.get(actorId)?.clientId ?? null;
  room.playback = {
    source,
    playing: false,
    time: 0,
    updatedAt: now,
    rate: 1,
    lastActor: actorId,
  };
  return snapshotPlayback(room.playback, now);
}

const SYNC_ACTIONS = ['PLAY', 'PAUSE', 'SEEK'];

/**
 * Applies a play/pause/seek from any participant (two-way control).
 * Returns the new snapshot, or null when the event is a no-op/invalid.
 */
export function applySyncEvent(room, actorId, event, now = Date.now()) {
  const { playback } = room;
  if (!SYNC_ACTIONS.includes(event?.action)) return null;
  if (playback.source.type === 'none' || playback.source.type === 'screen') return null;
  let time = Number(event.time);
  if (!Number.isFinite(time) || time < 0) time = currentTime(playback, now);
  const d = playback.source.duration;
  if (d && Number.isFinite(d)) time = Math.min(time, d);

  const playing = event.action === 'PLAY' ? true : event.action === 'PAUSE' ? false : playback.playing;
  room.playback = { ...playback, playing, time, updatedAt: now, lastActor: actorId };
  return snapshotPlayback(room.playback, now);
}

/**
 * Periodic position report. In 'stream' mode only the owner (whose <video> is the real
 * player) may correct the clock; this keeps guests' timelines honest through buffering.
 * Duration may be reported by anyone once metadata loads.
 */
export function applyHeartbeat(room, actorId, beat, now = Date.now()) {
  const { playback } = room;
  const duration = validDuration(beat?.duration);
  let changed = false;
  if (duration && !playback.source.duration && playback.source.type !== 'none') {
    playback.source = { ...playback.source, duration };
    changed = true;
  }
  if (playback.source.type === 'stream' && playback.source.ownerId === actorId) {
    const time = Number(beat?.time);
    if (Number.isFinite(time) && time >= 0) {
      room.playback = { ...room.playback, time, playing: Boolean(beat.playing), updatedAt: now };
      changed = true;
    }
  }
  return changed ? snapshotPlayback(room.playback, now) : null;
}

export const MAX_SUBTITLE_CHARS = 1_500_000;
export const MAX_MOMENTS = 5000;
const TIMELINE_TYPES = ['url', 'youtube', 'local', 'stream'];

/** Shares a subtitle file with the room. Subtitles always belong to the current movie. */
export function setSubtitles(room, actorId, input) {
  const sourceId = room.playback.source.id;
  if (!sourceId || !TIMELINE_TYPES.includes(room.playback.source.type)) {
    throw new RoomError('NO_SOURCE', 'Start a movie (not a screen share) first, then add its subtitles.');
  }
  const text = typeof input?.text === 'string' ? input.text : '';
  if (!text.trim()) throw new RoomError('BAD_SUBS', 'That subtitle file is empty.');
  if (text.length > MAX_SUBTITLE_CHARS) throw new RoomError('BAD_SUBS', 'That subtitle file is too large.');
  room.subtitles = {
    id: randomBytes(6).toString('base64url'),
    sourceId,
    name: String(input.name ?? '').slice(0, 200) || 'Subtitles',
    text,
    by: room.participants.get(actorId)?.name ?? null,
  };
  return room.subtitles;
}

export function clearSubtitles(room) {
  room.subtitles = null;
}

/** The subtitles for what is playing now (null if none, or they belong to an older movie). */
export function currentSubtitles(room) {
  return room.subtitles && room.subtitles.sourceId === room.playback.source.id ? room.subtitles : null;
}

/** Stamps a reaction with the movie time, so the timeline can show where people reacted. */
export function recordMoment(room, emoji, now = Date.now()) {
  if (!room.playback.source.id || !TIMELINE_TYPES.includes(room.playback.source.type)) return null;
  const t = Math.round(currentTime(room.playback, now) * 10) / 10;
  room.moments.push({ t, emoji });
  if (room.moments.length > MAX_MOMENTS) room.moments.shift();
  return t;
}

/** Validates laser pointer points: up to 24 [x, y] pairs as picture fractions. */
export function sanitizeLaserPoints(pts) {
  if (!Array.isArray(pts) || !pts.length || pts.length > 24) return null;
  const out = [];
  for (const p of pts) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const [x, y] = p.map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < -0.5 || x > 1.5 || y < -0.5 || y > 1.5) return null;
    out.push([Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
  }
  return out;
}

export function addChatMessage(room, authorId, text, now = Date.now()) {
  const author = room.participants.get(authorId);
  const clean = String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, MAX_CHAT_LENGTH);
  if (!author || !clean) return null;
  const message = { id: `${now.toString(36)}-${randomBytes(3).toString('hex')}`, authorId, name: author.name, text: clean, ts: now };
  room.chat.push(message);
  if (room.chat.length > CHAT_HISTORY_LIMIT) room.chat.splice(0, room.chat.length - CHAT_HISTORY_LIMIT);
  return message;
}

export function isValidReaction(emoji) {
  return REACTIONS.includes(emoji);
}

function validDuration(value) {
  const d = Number(value);
  return Number.isFinite(d) && d > 0 ? d : null;
}

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

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
  return { type: 'none', url: null, name: null, ownerId: null, duration: null };
}

export function createRoom(id, now = Date.now()) {
  return {
    id,
    createdAt: now,
    participants: new Map(), // socketId -> { id, name, joinedAt, media: { [streamId]: 'camera' | 'movie' }, status }
    chat: [],
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

export function addParticipant(room, id, name, now = Date.now()) {
  if (room.participants.size >= MAX_PARTICIPANTS) {
    throw new RoomError('ROOM_FULL', `Room is full (max ${MAX_PARTICIPANTS} people).`);
  }
  const participant = { id, name: sanitizeName(name), joinedAt: now, media: {}, status: { camera: false, mic: false } };
  room.participants.set(id, participant);
  return participant;
}

/** Removes a participant. If they owned the current stream/screen source, the source is cleared. */
export function removeParticipant(room, id, now = Date.now()) {
  const participant = room.participants.get(id);
  room.participants.delete(id);
  let sourceCleared = false;
  const { source } = room.playback;
  if (source.ownerId === id && (source.type === 'stream' || source.type === 'screen')) {
    room.playback = { ...room.playback, source: emptySource(), playing: false, time: 0, updatedAt: now };
    sourceCleared = true;
  }
  return { participant, sourceCleared };
}

export function publicParticipant(p) {
  return { id: p.id, name: p.name, media: { ...p.media }, status: { ...p.status } };
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

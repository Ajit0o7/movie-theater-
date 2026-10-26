// HTTP + Socket.io server: serves the client, relays WebRTC signaling and
// owns the authoritative room state (playback sync, chat, presence).

import express from 'express';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server } from 'socket.io';
import {
  RoomError,
  addChatMessage,
  addParticipant,
  applyHeartbeat,
  applySyncEvent,
  createRoom,
  generateRoomId,
  isValidReaction,
  isValidRoomId,
  listParticipants,
  publicParticipant,
  removeParticipant,
  setMedia,
  setStatus,
  setSource,
  snapshotPlayback,
} from './rooms.js';
import { lanAddresses, loadOrCreateCert } from './tls.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;

export function iceServersFromEnv(env = process.env) {
  const servers = [{ urls: (env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',') }];
  if (env.TURN_URLS) {
    servers.push({ urls: env.TURN_URLS.split(','), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  }
  return servers;
}

/** `tls` ({ cert, key }) serves over HTTPS, which browsers require for camera/mic/screen on a LAN IP. */
export function createCinemaServer({ env = process.env, tls = null } = {}) {
  const app = express();
  const httpServer = tls ? createHttpsServer(tls, app) : createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 1e6 });
  const rooms = new Map();
  const cleanupTimers = new Map();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  app.get('/api/config', (_req, res) => {
    res.json({ iceServers: iceServersFromEnv(env) });
  });

  app.post('/api/rooms', (_req, res) => {
    let id;
    do id = generateRoomId(); while (rooms.has(id));
    res.status(201).json({ roomId: id, url: `/room/${id}` });
  });

  app.get('/room/:roomId', (req, res) => {
    if (!isValidRoomId(req.params.roomId)) return res.redirect('/');
    res.sendFile(path.join(PUBLIC_DIR, 'room.html'));
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

  function getOrCreateRoom(id) {
    clearTimeout(cleanupTimers.get(id));
    cleanupTimers.delete(id);
    let room = rooms.get(id);
    if (!room) {
      room = createRoom(id);
      rooms.set(id, room);
    }
    return room;
  }

  function scheduleCleanup(room) {
    if (room.participants.size > 0) return;
    const timer = setTimeout(() => {
      if (room.participants.size === 0) rooms.delete(room.id);
      cleanupTimers.delete(room.id);
    }, EMPTY_ROOM_TTL_MS);
    timer.unref?.();
    cleanupTimers.set(room.id, timer);
  }

  io.on('connection', (socket) => {
    let room = null;
    const self = () => room?.participants.get(socket.id);

    // Lightweight NTP-style clock sync so clients can convert server timestamps.
    socket.on('time:ping', (ack) => typeof ack === 'function' && ack(Date.now()));

    socket.on('room:join', ({ roomId, name } = {}, ack = () => {}) => {
      if (room) return ack({ error: 'Already in a room.' });
      if (!isValidRoomId(roomId)) return ack({ error: 'Invalid room id.' });
      const target = getOrCreateRoom(roomId.toLowerCase());
      try {
        const participant = addParticipant(target, socket.id, name);
        room = target;
        socket.join(room.id);
        socket.to(room.id).emit('peer:joined', publicParticipant(participant));
        ack({
          self: publicParticipant(participant),
          peers: listParticipants(room).filter((p) => p.id !== socket.id),
          playback: snapshotPlayback(room.playback),
          chat: room.chat,
        });
      } catch (err) {
        scheduleCleanup(target);
        ack({ error: err instanceof RoomError ? err.message : 'Could not join room.' });
      }
    });

    // WebRTC signaling relay (SDP descriptions + ICE candidates), scoped to the room.
    socket.on('signal', ({ to, data } = {}) => {
      if (!room || !room.participants.has(to) || to === socket.id) return;
      io.to(to).emit('signal', { from: socket.id, data });
    });

    socket.on('media:announce', ({ streamId, kind } = {}) => {
      if (!room || !setMedia(room, socket.id, streamId, kind ?? null)) return;
      socket.to(room.id).emit('media:announce', { peerId: socket.id, streamId, kind: kind ?? null });
    });

    socket.on('peer:status', (status) => {
      if (!room) return;
      const next = setStatus(room, socket.id, status);
      if (next) socket.to(room.id).emit('peer:status', { id: socket.id, status: next });
    });

    socket.on('sync:source', (input, ack = () => {}) => {
      if (!room) return ack({ error: 'Not in a room.' });
      try {
        const playback = setSource(room, socket.id, input);
        io.to(room.id).emit('sync:state', { playback, actor: self()?.name, action: 'SOURCE' });
        ack({ playback });
      } catch (err) {
        ack({ error: err instanceof RoomError ? err.message : 'Could not change source.' });
      }
    });

    socket.on('sync:event', (event) => {
      if (!room) return;
      const playback = applySyncEvent(room, socket.id, event);
      if (!playback) return;
      // Everyone (including the sender) gets the authoritative state back.
      io.to(room.id).emit('sync:state', { playback, actor: self()?.name, actorId: socket.id, action: event.action });
    });

    socket.on('sync:heartbeat', (beat) => {
      if (!room) return;
      const playback = applyHeartbeat(room, socket.id, beat);
      if (playback) socket.to(room.id).emit('sync:state', { playback, action: 'HEARTBEAT' });
    });

    socket.on('chat:send', ({ text } = {}) => {
      if (!room) return;
      const message = addChatMessage(room, socket.id, text);
      if (message) io.to(room.id).emit('chat:message', message);
    });

    socket.on('reaction', ({ emoji } = {}) => {
      if (!room || !isValidReaction(emoji)) return;
      io.to(room.id).emit('reaction', { emoji, from: socket.id, name: self()?.name });
    });

    socket.on('disconnect', () => {
      if (!room) return;
      const { participant, sourceCleared } = removeParticipant(room, socket.id);
      socket.to(room.id).emit('peer:left', { id: socket.id, name: participant?.name });
      if (sourceCleared) {
        io.to(room.id).emit('sync:state', { playback: snapshotPlayback(room.playback), actor: participant?.name, action: 'SOURCE' });
      }
      scheduleCleanup(room);
    });
  });

  return { app, httpServer, io, rooms };
}

/**
 * True when this file is the program being run (`node server/index.js`), not when it is
 * imported by tests. Compares real paths, case-insensitively on Windows, where a terminal
 * may report the drive as c:\ while the module URL says C:\ (a plain string comparison
 * there would make `npm start` exit silently).
 */
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const run = fs.realpathSync(process.argv[1]);
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? run.toLowerCase() === self.toLowerCase() : run === self;
  } catch {
    return false;
  }
}

async function main() {
  const port = Number(process.env.PORT) || 3000;
  const https = process.argv.includes('--https') || process.env.HTTPS === '1';
  const tls = https ? await loadOrCreateCert(path.join(__dirname, '..', '.cert')) : null;
  const { httpServer } = createCinemaServer({ tls });
  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Close the other server or run with PORT=<another port>.`);
    else console.error(err);
    process.exit(1);
  });
  httpServer.listen(port, () => {
    const scheme = https ? 'https' : 'http';
    console.log(`🎬 4K Virtual Cinema running at ${scheme}://localhost:${port}`);
    const lan = lanAddresses();
    if (https) {
      for (const ip of lan) console.log(`   Same Wi-Fi: ${scheme}://${ip}:${port}`);
      console.log('   The certificate is self-signed: in the browser choose "Advanced" → "Proceed" once per device.');
    } else if (lan.length) {
      console.log(`   Friends on the same Wi-Fi need camera/mic/screen share? Run "npm run start:https" (plain http://${lan[0]}:${port} blocks them).`);
    }
  });
}

if (isMainModule()) main();

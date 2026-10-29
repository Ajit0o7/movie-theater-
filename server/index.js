// HTTP + Socket.io server: serves the client, relays WebRTC signaling and
// owns the authoritative room state (playback sync, chat, presence).

import compression from 'compression';
import express from 'express';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import {
  RoomError,
  addChatMessage,
  addParticipant,
  applyHeartbeat,
  applySyncEvent,
  clearSubtitles,
  createRoom,
  currentSubtitles,
  expireAwaySource,
  findByClientId,
  generateRoomId,
  isValidReaction,
  isValidRoomId,
  listParticipants,
  publicParticipant,
  reclaimSource,
  recordMoment,
  removeParticipant,
  sanitizeLaserPoints,
  setCamLayout,
  setMedia,
  setStatus,
  setSource,
  setSubtitles,
  snapshotPlayback,
} from './rooms.js';
import { createIceProvider } from './ice.js';
import {
  acceptableState,
  createPairings,
  deletePairing,
  findOwnerPairing,
  findPairingOwnedBy,
  joinPairing,
  pairFor,
  phoneOrigin,
  sanitizeCommand,
  sweepPairings,
} from './remote.js';
import { lanAddresses, loadOrCreateCert } from './tls.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;
export const HOST_GRACE_MS = 60 * 1000;

/** `tls` ({ cert, key }) serves over HTTPS, which browsers require for camera/mic/screen on a LAN IP. */
export function createCinemaServer({ env = process.env, tls = null, ice = createIceProvider(env), hostGraceMs = HOST_GRACE_MS } = {}) {
  const app = express();
  const httpServer = tls ? createHttpsServer(tls, app) : createServer(app);
  // Room for a large subtitle file (MAX_SUBTITLE_CHARS); every other message is validated.
  const io = new Server(httpServer, { maxHttpBufferSize: 5e6 });
  const rooms = new Map();
  const cleanupTimers = new Map();

  app.disable('x-powered-by');
  app.use(compression()); // gzip: the client's JS/CSS shrink ~4x (Socket.io compresses its own)
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  app.get('/api/config', async (_req, res) => {
    res.set('Cache-Control', 'no-store'); // TURN credentials are short-lived
    res.json({ iceServers: await ice.iceServers(), relay: ice.source !== 'none' });
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

  // The phone remote (opened by scanning the QR code a computer in the room shows).
  app.get('/remote/:roomId', (req, res) => {
    if (!isValidRoomId(req.params.roomId)) return res.redirect('/');
    res.sendFile(path.join(PUBLIC_DIR, 'remote.html'));
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

  const pairings = createPairings();
  const phoneOf = (socketId) => io.sockets.sockets.get(socketId);
  /** Ends pairings: their phones are told and disconnected. */
  function endPairings(list) {
    for (const p of list) {
      deletePairing(pairings, p);
      for (const id of p.phones) {
        phoneOf(id)?.emit('remote:ended');
        phoneOf(id)?.disconnect(true);
      }
    }
  }
  const sweeper = setInterval(() => endPairings(sweepPairings(pairings, Date.now())), 60_000);
  sweeper.unref?.();
  httpServer.on('close', () => clearInterval(sweeper));
  const lanOrigins = () => {
    const port = httpServer.address()?.port;
    return port ? lanAddresses().map((ip) => `${tls ? 'https' : 'http'}://${ip}:${port}`) : [];
  };
  /** A phone's view of a chat message: `mine` when its own computer's person wrote it. */
  const forPhone = (pairing, m) => ({ id: m.id, name: m.name, text: m.text, ts: m.ts, mine: m.authorId === pairing.ownerSocketId || m.name === pairing.ownerName });
  /** New chat messages reach the phones paired with anyone in the room. */
  function chatToPhones(room, message) {
    for (const p of pairings.byOwner.values()) {
      if (p.roomId !== room.id) continue;
      for (const id of p.phones) io.to(id).emit('remote:chat', forPhone(p, message));
    }
  }
  /** A computer went away (or came back): its phones show that. */
  function ownerPresence(pairing, online) {
    pairing.ownerGoneSince = online ? null : Date.now();
    if (!online) pairing.ownerSocketId = null;
    for (const id of pairing.phones) io.to(id).emit('remote:owner', { online, name: pairing.ownerName });
  }

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

  const graceTimers = new Map(); // roomId -> timer while a stream/screen host is away

  /**
   * Removes a participant and tells the room. With `grace`, a stream/screen they were hosting
   * is kept for HOST_GRACE_MS in case the same tab reconnects (Wi-Fi blip, laptop sleep).
   */
  function leave(target, id, { grace }) {
    if (!target.participants.has(id)) return;
    const { participant, sourceCleared, sourceAway } = removeParticipant(target, id, Date.now(), { grace });
    const announceLeft = () => io.to(target.id).except(id).emit('peer:left', { id, name: participant?.name });
    if (!sourceAway) announceLeft();
    if (sourceCleared) {
      clearTimeout(graceTimers.get(target.id));
      io.to(target.id).emit('sync:state', { playback: snapshotPlayback(target.playback), actor: participant?.name, action: 'SOURCE' });
    }
    if (sourceAway) {
      // "Waiting for the host" first, so clients can tell this apart from a plain leave.
      io.to(target.id).except(id).emit('sync:state', { playback: snapshotPlayback(target.playback), actor: participant?.name, action: 'OWNER_AWAY' });
      announceLeft();
      clearTimeout(graceTimers.get(target.id));
      const timer = setTimeout(() => {
        graceTimers.delete(target.id);
        if (expireAwaySource(target)) {
          io.to(target.id).emit('sync:state', { playback: snapshotPlayback(target.playback), actor: participant?.name, action: 'SOURCE' });
        }
      }, hostGraceMs);
      timer.unref?.();
      graceTimers.set(target.id, timer);
    }
    scheduleCleanup(target);
  }

  /** Removes a participant whose connection was superseded by the same tab reconnecting. */
  function evict(target, oldId) {
    const old = io.sockets.sockets.get(oldId);
    leave(target, oldId, { grace: true }); // the new connection reclaims any stream right after
    if (old) {
      old.emit('session:replaced');
      old.disconnect(true);
    }
  }

  io.on('connection', (socket) => {
    let room = null;
    let phoneFor = null; // when this socket is a paired phone: its pairing
    const self = () => room?.participants.get(socket.id);

    // Every client message goes through here: payloads may be null or not objects and the
    // ack may be missing or not a function. An exception in a Socket.io handler is uncaught
    // and would kill the process (every room), so handlers never throw past this point.
    const on = (event, handler) =>
      socket.on(event, (...args) => {
        const last = args.at(-1);
        const ack = typeof last === 'function' ? args.pop() : () => {};
        const payload = args[0] !== null && typeof args[0] === 'object' ? args[0] : {};
        try {
          handler(payload, ack);
        } catch (err) {
          console.error(`[socket] "${event}" from ${socket.id} failed:`, err);
        }
      });

    // Lightweight NTP-style clock sync so clients can convert server timestamps.
    on('time:ping', (_payload, ack) => ack(Date.now()));

    on('room:join', ({ roomId, name, clientId }, ack) => {
      if (room || phoneFor) return ack({ error: 'Already in a room.' }); // a phone remote never joins
      if (!isValidRoomId(roomId)) return ack({ error: 'Invalid room id.' });
      const target = getOrCreateRoom(roomId.toLowerCase());
      // Same tab reconnecting (Wi-Fi switch, sleep) before the server noticed the old
      // connection died: drop the old one now, or it lingers as a ghost for ~45s.
      const previous = findByClientId(target, clientId);
      if (previous && previous.id !== socket.id) evict(target, previous.id);
      try {
        const participant = addParticipant(target, socket.id, name, Date.now(), clientId);
        room = target;
        socket.join(room.id);
        if (reclaimSource(room, clientId, socket.id)) {
          // The host is back within the grace period: their stream carries on. Sent before
          // peer:joined so clients show "is back" rather than a plain "joined".
          clearTimeout(graceTimers.get(room.id));
          graceTimers.delete(room.id);
          socket.to(room.id).emit('sync:state', { playback: snapshotPlayback(room.playback), actor: participant.name, action: 'OWNER_BACK' });
        }
        socket.to(room.id).emit('peer:joined', publicParticipant(participant));
        // This tab had paired a phone before reconnecting/reloading: the phone carries on.
        const paired = participant.clientId && findOwnerPairing(pairings, room.id, participant.clientId);
        if (paired) {
          paired.ownerSocketId = socket.id;
          ownerPresence(paired, true);
          socket.emit('remote:status', { phones: paired.phones.size });
        }
        ack({
          self: publicParticipant(participant),
          peers: listParticipants(room).filter((p) => p.id !== socket.id),
          playback: snapshotPlayback(room.playback),
          chat: room.chat,
          subtitles: currentSubtitles(room),
          moments: room.moments,
        });
      } catch (err) {
        scheduleCleanup(target);
        ack({ error: err instanceof RoomError ? err.message : 'Could not join room.' });
      }
    });

    // WebRTC signaling relay (SDP descriptions + ICE candidates), scoped to the room.
    on('signal', ({ to, data }) => {
      if (!room || !room.participants.has(to) || to === socket.id) return;
      io.to(to).emit('signal', { from: socket.id, data });
    });

    on('media:announce', ({ streamId, kind }) => {
      if (!room || !setMedia(room, socket.id, streamId, kind ?? null)) return;
      socket.to(room.id).emit('media:announce', { peerId: socket.id, streamId, kind: kind ?? null });
    });

    on('peer:status', (status) => {
      if (!room) return;
      const next = setStatus(room, socket.id, status);
      if (next) socket.to(room.id).emit('peer:status', { id: socket.id, status: next });
    });

    // Camera tiles are arranged for the whole room: whoever moves or resizes a tile moves it
    // for everyone (last change wins), and late joiners receive the current layout.
    on('cam:layout', ({ id, cam }) => {
      if (!room) return;
      const stored = setCamLayout(room, id, cam);
      if (stored) socket.to(room.id).emit('cam:layout', { id, cam: stored });
    });

    on('subs:set', (input, ack) => {
      if (!room) return ack({ error: 'Not in a room.' });
      try {
        const subs = setSubtitles(room, socket.id, input);
        io.to(room.id).emit('subs:state', { subs, actor: self()?.name });
        ack({ ok: true });
      } catch (err) {
        ack({ error: err instanceof RoomError ? err.message : 'Could not add subtitles.' });
      }
    });

    on('subs:clear', () => {
      if (!room || !room.subtitles) return;
      clearSubtitles(room);
      io.to(room.id).emit('subs:state', { subs: null, actor: self()?.name });
    });

    on('sync:source', (input, ack) => {
      if (!room) return ack({ error: 'Not in a room.' });
      try {
        const playback = setSource(room, socket.id, input);
        io.to(room.id).emit('sync:state', { playback, actor: self()?.name, action: 'SOURCE' });
        ack({ playback });
      } catch (err) {
        ack({ error: err instanceof RoomError ? err.message : 'Could not change source.' });
      }
    });

    on('sync:event', (event) => {
      if (!room) return;
      const playback = applySyncEvent(room, socket.id, event);
      if (!playback) return;
      // Everyone (including the sender) gets the authoritative state back.
      io.to(room.id).emit('sync:state', { playback, actor: self()?.name, actorId: socket.id, action: event.action });
    });

    on('sync:heartbeat', (beat) => {
      if (!room) return;
      const hadDuration = Boolean(room.playback.source.duration);
      const playback = applyHeartbeat(room, socket.id, beat);
      if (!playback) return;
      if (!hadDuration && playback.source.duration) {
        // The duration was just learned: everyone needs it, including the reporter, whose own
        // copy of the state would otherwise lack it. Only this one-off goes back to the sender.
        io.to(room.id).emit('sync:state', { playback, action: 'DURATION' });
      } else {
        // Position heartbeats from a stream owner must not echo to the owner: their own
        // player is the clock, and re-applying a slightly old snapshot would nudge it.
        socket.to(room.id).emit('sync:state', { playback, action: 'HEARTBEAT' });
      }
    });

    // A viewer whose connection can't keep up: tell the others once per source, so whoever
    // picked the video knows why that person keeps buffering.
    on('sync:struggling', () => {
      const me = self();
      const sourceId = room?.playback.source.id;
      if (!me || !sourceId || me.reportedStruggle === sourceId) return;
      me.reportedStruggle = sourceId;
      socket.to(room.id).emit('peer:struggling', { name: me.name });
    });

    on('chat:send', ({ text }) => {
      if (!room) return;
      const message = addChatMessage(room, socket.id, text);
      if (!message) return;
      io.to(room.id).emit('chat:message', message);
      chatToPhones(room, message);
    });

    // Laser pointer: relayed, never stored. Validated and rate-limited (~50 messages/s).
    let lastLaser = 0;
    on('laser', ({ pts }) => {
      const now = Date.now();
      if (!room || now - lastLaser < 20) return;
      const points = sanitizeLaserPoints(pts);
      if (!points) return;
      lastLaser = now;
      socket.to(room.id).emit('laser', { from: socket.id, name: self()?.name, pts: points });
    });

    on('reaction', ({ emoji }) => {
      if (!room || !isValidReaction(emoji)) return;
      const t = recordMoment(room, emoji); // movie time, or null with no timeline (screen share)
      io.to(room.id).emit('reaction', { emoji, from: socket.id, name: self()?.name, t });
    });

    // ---- phone remote --------------------------------------------------------------
    // The computer asks for its pairing: a token and a QR code of the link for the phone.
    on('remote:pair', ({ origin }, ack) => {
      const me = self();
      if (!me) return ack({ error: 'Join the room first.' });
      const pairing = pairFor(pairings, { roomId: room.id, clientId: me.clientId ?? socket.id, socketId: socket.id, name: me.name }, Date.now());
      const base = phoneOrigin(origin, lanOrigins());
      if (!base) return ack({ error: 'Couldn’t work out an address your phone can open.' });
      const url = `${base}/remote/${room.id}?pair=${pairing.token}`;
      QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(
        (qr) => ack({ url, qr, phones: pairing.phones.size }),
        () => ack({ error: 'Couldn’t make the QR code.' }),
      );
    });

    on('remote:unpair', () => {
      const pairing = findPairingOwnedBy(pairings, socket.id);
      if (pairing) endPairings([pairing]);
    });

    // A phone that scanned the code. It never joins the room itself.
    on('remote:join', ({ token }, ack) => {
      if (room || phoneFor) return ack({ error: 'Already connected.' });
      const result = joinPairing(pairings, token, socket.id);
      if (result.error) return ack({ error: result.error });
      phoneFor = result.pairing;
      if (phoneFor.ownerSocketId) io.to(phoneFor.ownerSocketId).emit('remote:status', { phones: phoneFor.phones.size, joined: socket.id });
      const history = (rooms.get(phoneFor.roomId)?.chat ?? []).slice(-50).map((m) => forPhone(phoneFor, m));
      ack({ ok: true, roomId: phoneFor.roomId, name: phoneFor.ownerName, online: Boolean(phoneFor.ownerSocketId), chat: history });
    });

    // Per-second budgets for a phone's messages (a scrub bar or ICE gathering never needs more).
    const budgets = {};
    const withinBudget = (kind, max) => {
      const second = Math.floor(Date.now() / 1000);
      const b = (budgets[kind] ??= { second, count: 0 });
      if (b.second !== second) Object.assign(b, { second, count: 0 });
      return ++b.count <= max;
    };
    on('remote:command', (input) => {
      if (!phoneFor?.ownerSocketId || !withinBudget('command', 20)) return;
      const command = sanitizeCommand(input);
      if (command) io.to(phoneFor.ownerSocketId).emit('remote:command', { ...command, from: socket.id });
    });

    // A chat message typed on the phone, posted as its computer's person (the phone isn't in the room).
    on('remote:chat', ({ text }, ack) => {
      if (!phoneFor) return ack({ error: 'Not paired.' });
      if (!withinBudget('chat', 3)) return ack({ error: 'Slow down a little.' });
      const target = rooms.get(phoneFor.roomId);
      if (!target?.participants.has(phoneFor.ownerSocketId)) return ack({ error: `${phoneFor.ownerName}’s computer is offline, so the message can’t be sent.` });
      const message = addChatMessage(target, phoneFor.ownerSocketId, text);
      if (!message) return ack({ error: 'Type a message first.' });
      io.to(target.id).emit('chat:message', message);
      chatToPhones(target, message);
      ack({ ok: true });
    });

    // Phone camera signaling (WebRTC offer/answer/candidates), only between a phone and its computer.
    on('remote:signal', ({ to, data }) => {
      if (phoneFor) {
        if (phoneFor.ownerSocketId && withinBudget('signal', 60)) io.to(phoneFor.ownerSocketId).emit('remote:signal', { from: socket.id, data });
        return;
      }
      const pairing = findPairingOwnedBy(pairings, socket.id);
      if (pairing?.phones.has(to)) io.to(to).emit('remote:signal', { data });
    });

    // The computer's player state, for its phones' screens.
    on('remote:state', (state) => {
      const pairing = findPairingOwnedBy(pairings, socket.id);
      if (!pairing?.phones.size || !acceptableState(state)) return;
      for (const id of pairing.phones) io.to(id).emit('remote:state', state);
    });

    /** This computer is gone for now: its phones wait for it (the pairing outlives a reload). */
    function ownerAway() {
      const pairing = findPairingOwnedBy(pairings, socket.id);
      if (pairing) ownerPresence(pairing, false);
    }

    // Closing the tab or navigating away is deliberate: end any stream right away.
    on('room:leave', () => {
      if (!room) return;
      ownerAway();
      leave(room, socket.id, { grace: false });
      socket.leave(room.id);
      room = null;
    });

    // A dropped connection may come back (Wi-Fi blip, sleep): give a host time to return.
    socket.on('disconnect', () => {
      if (phoneFor) {
        phoneFor.phones.delete(socket.id);
        if (phoneFor.ownerSocketId) io.to(phoneFor.ownerSocketId).emit('remote:status', { phones: phoneFor.phones.size, left: socket.id });
        phoneFor = null;
        return;
      }
      if (!room) return;
      ownerAway();
      leave(room, socket.id, { grace: true });
    });
  });

  return { app, httpServer, io, rooms, ice };
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
  // `--port` works the same on every OS; `PORT=3001 npm start` only works on macOS/Linux.
  const portFlag = process.argv.indexOf('--port');
  const port = Number(portFlag > -1 ? process.argv[portFlag + 1] : process.env.PORT) || 3000;
  const https = process.argv.includes('--https') || process.env.HTTPS === '1';
  const tls = https ? await loadOrCreateCert(path.join(__dirname, '..', '.cert')) : null;
  const { httpServer, ice } = createCinemaServer({ tls });
  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Close the other server, or use another port: npm start -- --port 3001`);
    else console.error(err);
    process.exit(1);
  });
  // Containers (Render, Docker, ...) route to the instance over IPv4, so bind every IPv4
  // interface explicitly rather than relying on the platform default. Override with HOST.
  const host = process.env.HOST || '0.0.0.0';
  httpServer.listen(port, host, () => {
    const scheme = https ? 'https' : 'http';
    console.log(`🎬 4K Virtual Cinema running at ${scheme}://localhost:${port}`);
    console.log(
      ice.source === 'none'
        ? '   No TURN relay configured: friends on mobile data or strict Wi-Fi may not connect (see README → TURN).'
        : `   TURN relay: ${{ cloudflare: 'Cloudflare (short-lived credentials)', url: 'TURN_CREDENTIALS_URL', static: 'TURN_URLS' }[ice.source]}`,
    );
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

// Theater page controller: joins the room, wires media, sync, cameras, chat and HUD.

import { Ambilight } from './ambilight.js';
import { CameraDeck, SpeakingDetector } from './cameras.js';
import { ChatDrawer } from './chat.js';
import {
  DEFAULT_PRESET,
  STREAM_PRESETS,
  applyDisplayPreset,
  canCaptureElement,
  canShareScreen,
  captureDisplay,
  captureElement,
  getCameraTrack,
  getMicTrack,
  resolutionLabel,
} from './media.js';
import { Reactions } from './reactions.js';
import { PeerManager } from './rtc.js';
import { CinemaSync, ClockSync } from './sync.js';
import { $, $$, formatTime, h, storage, toast } from './util.js';
import { YouTubeVideo, parseYouTubeUrl, youtubeQualityLabel } from './youtube.js';

const roomId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '').toLowerCase();
const player = $('#player');
const deck = new CameraDeck($('#cameras'));
const detector = new SpeakingDetector();
const ambilight = new Ambilight(player, $('#ambilight'));

const settings = {
  movieVolume: 1,
  voiceVolume: 1,
  ambilight: true,
  quality: DEFAULT_PRESET,
  ...storage.get('cinema.settings', {}),
};
if (!STREAM_PRESETS[settings.quality]) settings.quality = DEFAULT_PRESET;
const currentPreset = () => STREAM_PRESETS[settings.quality];

// The thing actually playing: the <video> element, or the YouTube adapter.
let yt = null;
const media = () => yt ?? player;

const local = {
  name: '',
  camTrack: null,
  micTrack: null,
  own: null, // media this client is the source of: { key, type, url?, display?, capture?, monitor? }
  localCopy: null, // { key, url } for 'local' sources
};

let socket = null;
let iceServers = [];
let session = null; // per-connection: { selfId, rtc, sync, chat, reactions, peers, remoteStreams }
let joinedOnce = false;
let statsOpen = false;

// ---------------------------------------------------------------------------
// Join

$('#room-code').textContent = roomId;
$('#join-room-code').textContent = roomId;
$('#join-name').value = storage.get('cinema.name', '');
// Camera, mic and screen capture only exist on secure origins (https or localhost). Say so
// up front instead of failing with a vague error after the user clicks.
const secure = window.isSecureContext;
if (!secure) {
  $('#insecure-note').hidden = false;
  for (const id of ['#join-cam', '#join-mic']) {
    $(id).checked = false;
    $(id).disabled = true;
  }
  $('#share-screen-btn').disabled = true;
  $('#screen-insecure').hidden = false;
} else if (!canShareScreen()) {
  $('#screen-card').hidden = true; // e.g. mobile browsers
}

const joinDialog = $('#join-dialog');
joinDialog.addEventListener('cancel', (e) => e.preventDefault());
joinDialog.showModal();

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#join-name').value.trim();
  if (!name) return;
  const submit = $('#join-submit');
  submit.disabled = true;
  submit.textContent = 'Joining…';
  $('#join-error').textContent = '';
  local.name = name;
  storage.set('cinema.name', name);

  // This click is our user gesture: unlock audio playback and the AudioContext now.
  detector.ensureContext();

  try {
    const res = await fetch('/api/config');
    iceServers = (await res.json()).iceServers;
  } catch {
    iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  }

  await Promise.all([
    $('#join-cam').checked ? enableCamera({ quiet: true }) : null,
    $('#join-mic').checked ? enableMic({ quiet: true }) : null,
  ]);

  try {
    await connect();
    joinDialog.close();
  } catch (err) {
    $('#join-error').textContent = err.message || 'Could not join the room.';
    submit.disabled = false;
    submit.textContent = 'Enter theater';
  }
});

const CONNECT_TIMEOUT_MS = 10_000;

function connect() {
  return new Promise((resolve, reject) => {
    // Socket.io's default transport order: start on HTTP long-polling, then upgrade to a
    // WebSocket when one works. Networks that block or break WebSockets (antivirus web
    // shields, corporate/school proxies, some mobile carriers) still connect over polling.
    socket = io();
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(giveUp);
      socket.disconnect();
      reject(err);
    };
    // A single failed attempt is not fatal: Socket.io keeps retrying in the background.
    const giveUp = setTimeout(() => fail(new Error('Can’t reach the server. Check the address and your connection.')), CONNECT_TIMEOUT_MS);

    socket.on('connect', async () => {
      try {
        await joinRoom();
        if (joinedOnce) toast('Reconnected', { tone: 'success' });
        joinedOnce = true;
        settled = true;
        clearTimeout(giveUp);
        resolve();
      } catch (err) {
        if (!joinedOnce) fail(err);
        else toast(err.message, { tone: 'error' });
      }
    });
    socket.on('disconnect', (reason) => {
      if (!joinedOnce) return;
      teardownSession();
      if (reason !== 'io client disconnect') toast('Connection lost. Reconnecting…', { tone: 'error', duration: 4000 });
    });
  });
}

async function joinRoom() {
  const clock = new ClockSync(socket);
  await clock.calibrate();

  // Build the session *before* joining so no signal/presence event that follows the
  // join ack can slip past unhandled.
  teardownSession();
  const selfId = socket.id;
  const rtc = new PeerManager({ socket, selfId, iceServers });
  rtc.setMoviePreset(currentPreset());
  const sync = new CinemaSync({ socket, clock, video: player, selfId });
  const chat = new ChatDrawer({ socket, selfId });
  const reactions = new Reactions({ socket });
  session = { selfId, self: { id: selfId, name: local.name }, rtc, sync, chat, reactions, peers: new Map(), remoteStreams: new Map(), handlers: [] };

  rtc.addEventListener('track', ({ detail }) => onRemoteTrack(detail));
  sync.addEventListener('state', ({ detail }) => onSyncState(detail));
  sync.addEventListener('blocked', ({ detail }) => ($('#unblock').hidden = !detail.blocked));

  on('peer:joined', (p) => {
    addPeer(p);
    toast(`${p.name} joined`);
  });
  on('peer:left', ({ id, name }) => {
    removePeer(id);
    if (name) toast(`${name} left`);
  });
  on('peer:status', ({ id, status }) => {
    const p = session.peers.get(id);
    if (!p) return;
    p.status = status;
    deck.get(id)?.setStatus(status);
  });
  on('media:announce', ({ peerId, streamId, kind }) => {
    const p = session.peers.get(peerId);
    if (!p) return;
    if (kind) p.media[streamId] = kind;
    else delete p.media[streamId];
    reconcilePeer(peerId);
  });

  const res = await new Promise((resolve) => socket.timeout(8000).emit('room:join', { roomId, name: local.name }, (err, r) => resolve(err ? { error: 'Server did not respond.' } : r)));
  if (res.error) {
    teardownSession();
    throw new Error(res.error);
  }

  session.self = res.self;
  local.name = res.self.name;
  const selfTile = deck.ensure('self', { name: local.name, isSelf: true });
  selfTile.setStatus(localStatus());
  refreshSelfTile();

  for (const p of res.peers) addPeer(p);
  await rtc.setTrack('camVideo', local.camTrack);
  await rtc.setTrack('micAudio', local.micTrack);
  socket.emit('media:announce', { streamId: rtc.cameraStreamId, kind: 'camera' });
  socket.emit('media:announce', { streamId: rtc.movieStreamId, kind: 'movie' });
  socket.emit('peer:status', localStatus());

  chat.load(res.chat);
  sync.setInitialState(res.playback);
  renderPeople();
}

function on(event, handler) {
  socket.on(event, handler);
  session.handlers.push([event, handler]);
}

function teardownSession() {
  if (!session) return;
  for (const [event, handler] of session.handlers) socket.off(event, handler);
  for (const id of session.peers.keys()) {
    deck.remove(id);
    detector.unwatch(`peer:${id}`);
  }
  session.rtc.destroy();
  session.sync.destroy();
  session.chat.destroy();
  session.reactions.destroy();
  releaseOwnMedia();
  session = null;
}

// ---------------------------------------------------------------------------
// Peers & remote media

function addPeer(p) {
  if (session.peers.has(p.id)) return;
  session.peers.set(p.id, { ...p, media: { ...p.media }, status: p.status ?? { camera: false, mic: false } });
  session.rtc.addPeer(p.id);
  const tile = deck.ensure(p.id, { name: p.name });
  tile.setStatus(session.peers.get(p.id).status);
  reconcilePeer(p.id);
  renderPeople();
}

function removePeer(id) {
  session.peers.delete(id);
  session.remoteStreams.delete(id);
  session.rtc.removePeer(id);
  detector.unwatch(`peer:${id}`);
  deck.remove(id);
  renderPeople();
  renderSource();
}

function onRemoteTrack({ peerId, stream }) {
  if (!session.remoteStreams.has(peerId)) session.remoteStreams.set(peerId, new Map());
  session.remoteStreams.get(peerId).set(stream.id, stream);
  stream.onaddtrack = () => reconcilePeer(peerId);
  reconcilePeer(peerId);
}

function streamOfKind(peerId, kind) {
  const peer = session?.peers.get(peerId);
  const streams = session?.remoteStreams.get(peerId);
  if (!peer || !streams) return null;
  for (const [streamId, k] of Object.entries(peer.media)) {
    if (k === kind && streams.has(streamId)) return streams.get(streamId);
  }
  return null;
}

function reconcilePeer(peerId) {
  const camera = streamOfKind(peerId, 'camera');
  const tile = deck.get(peerId);
  if (tile && camera) {
    tile.setStream(camera);
    const audio = camera.getAudioTracks()[0];
    const watched = detector.sources.get(`peer:${peerId}`);
    if (audio && watched?.track !== audio) detector.watch(`peer:${peerId}`, audio, (level) => tile.setSpeaking(level > 0.08));
  }
  if (session.sync.source.ownerId === peerId) renderSource();
}

function renderPeople() {
  if (!session) return;
  const everyone = [{ ...session.self, name: local.name }, ...session.peers.values()];
  session.chat.renderPeople(everyone);
  $('#people-count').textContent = String(everyone.length);
}

// ---------------------------------------------------------------------------
// Local camera / mic

function localStatus() {
  return { camera: Boolean(local.camTrack), mic: Boolean(local.micTrack?.enabled) };
}

function publishStatus() {
  deck.get('self')?.setStatus(localStatus());
  socket?.emit('peer:status', localStatus());
  $('#mic-btn use').setAttribute('href', local.micTrack?.enabled ? '#i-mic' : '#i-mic-off');
  $('#cam-btn use').setAttribute('href', local.camTrack ? '#i-cam' : '#i-cam-off');
  $('#mic-btn').classList.toggle('on', Boolean(local.micTrack?.enabled));
  $('#cam-btn').classList.toggle('on', Boolean(local.camTrack));
}

function refreshSelfTile() {
  const tile = deck.get('self');
  if (!tile) return;
  tile.setStream(local.camTrack ? new MediaStream([local.camTrack]) : null);
}

async function enableCamera({ quiet = false } = {}) {
  try {
    local.camTrack = await getCameraTrack();
    local.camTrack.addEventListener('ended', () => disableCamera());
  } catch (err) {
    if (!quiet) toast(mediaError(err, 'camera'), { tone: 'error' });
    local.camTrack = null;
  }
  await session?.rtc.setTrack('camVideo', local.camTrack);
  refreshSelfTile();
  publishStatus();
}

async function disableCamera() {
  local.camTrack?.stop();
  local.camTrack = null;
  await session?.rtc.setTrack('camVideo', null);
  refreshSelfTile();
  publishStatus();
}

async function enableMic({ quiet = false } = {}) {
  try {
    local.micTrack = await getMicTrack();
    detector.watch('self', local.micTrack, (level) => {
      $('#mic-meter').style.setProperty('--level', level.toFixed(2));
      deck.get('self')?.setSpeaking(level > 0.08);
    });
  } catch (err) {
    if (!quiet) toast(mediaError(err, 'microphone'), { tone: 'error' });
    local.micTrack = null;
  }
  await session?.rtc.setTrack('micAudio', local.micTrack);
  publishStatus();
}

function toggleMic() {
  if (!local.micTrack) return enableMic();
  // Mute by disabling the track: no new permission prompt when unmuting.
  local.micTrack.enabled = !local.micTrack.enabled;
  publishStatus();
}

function toggleCam() {
  return local.camTrack ? disableCamera() : enableCamera();
}

function mediaError(err, what) {
  if (!navigator.mediaDevices) return `The ${what} needs an https:// address (or localhost). Ask the host to run “npm run start:https”.`;
  if (err?.name === 'NotAllowedError') return `Permission to use the ${what} was denied.`;
  if (err?.name === 'NotFoundError') return `No ${what} found.`;
  return `Couldn’t start the ${what}.`;
}

// ---------------------------------------------------------------------------
// Sources

const sourceKey = (s) => `${s.type}|${s.ownerId}|${s.name}|${s.url}`;
const sourceDialog = $('#source-dialog');

async function setSource(input) {
  if (!session) return false;
  const res = await new Promise((resolve) => socket.timeout(5000).emit('sync:source', input, (err, r) => resolve(err ? { error: 'Server did not respond.' } : r)));
  if (res.error) {
    toast(res.error, { tone: 'error' });
    return false;
  }
  sourceDialog.close();
  return true;
}

function plannedKey(type, name, url = null) {
  return sourceKey({ type, ownerId: session.selfId, name, url });
}

$('#url-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#url-input').value.trim();
  const youtube = parseYouTubeUrl(url);
  if (youtube) {
    releaseOwnMedia();
    if (await setSource({ type: 'youtube', videoId: youtube.videoId, name: 'YouTube video' })) {
      $('#url-input').value = '';
      if (youtube.start) session.sync.seek(youtube.start);
    }
    return;
  }
  let name = url;
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').pop()) || url;
  } catch {
    /* keep raw url */
  }
  releaseOwnMedia();
  if (await setSource({ type: 'url', url, name })) $('#url-input').value = '';
});

$('#stream-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !session) return;
  if (!canCaptureElement()) {
    toast('This browser can’t stream files. Try Chrome, Edge or Firefox.', { tone: 'error' });
    return;
  }
  releaseOwnMedia();
  local.own = { key: plannedKey('stream', file.name), type: 'stream', url: URL.createObjectURL(file), pending: true };
  if (!(await setSource({ type: 'stream', name: file.name }))) releaseOwnMedia();
});

$('#local-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !session) return;
  releaseOwnMedia();
  setLocalCopy(plannedKey('local', file.name), file, true);
  if (!(await setSource({ type: 'local', name: file.name })) && local.localCopy?.pending) {
    URL.revokeObjectURL(local.localCopy.url);
    local.localCopy = null;
  }
});

$('#local-pick-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  const source = session?.sync.source;
  if (!file || source?.type !== 'local') return;
  if (file.name !== source.name) toast(`Heads up: “${file.name}” has a different name than “${source.name}”.`, { tone: 'warn', duration: 5000 });
  setLocalCopy(sourceKey(source), file);
  renderSource();
});

function setLocalCopy(key, file, pending = false) {
  if (local.localCopy) URL.revokeObjectURL(local.localCopy.url);
  local.localCopy = { key, url: URL.createObjectURL(file), pending };
}

async function shareScreen() {
  if (!session) return;
  let display;
  try {
    display = await captureDisplay(currentPreset());
  } catch (err) {
    if (err?.name !== 'NotAllowedError') toast('Screen sharing failed.', { tone: 'error' });
    return;
  }
  releaseOwnMedia();
  const video = display.getVideoTracks()[0];
  const name = video?.label || 'Screen share';
  local.own = { key: plannedKey('screen', name), type: 'screen', display, pending: true };
  video?.addEventListener('ended', () => {
    if (local.own?.display === display) setSource({ type: 'none' });
  });
  if (!display.getAudioTracks().length) {
    toast('No audio captured. Share a browser tab and tick “Share tab audio” to include the soundtrack.', { tone: 'warn', duration: 6000 });
  }
  await session.rtc.setTrack('movieVideo', video ?? null);
  await session.rtc.setTrack('movieAudio', display.getAudioTracks()[0] ?? null);
  if (!(await setSource({ type: 'screen', name }))) releaseOwnMedia();
}

/** Stops whatever this client was broadcasting (screen or streamed file). */
function releaseOwnMedia() {
  const own = local.own;
  if (!own) return;
  local.own = null;
  own.display?.getTracks().forEach((t) => t.stop());
  own.capture?.getTracks().forEach((t) => t.stop());
  if (own.monitor) {
    own.monitor.srcObject = null;
    own.monitor.remove();
  }
  if (own.url) URL.revokeObjectURL(own.url);
  session?.rtc.setTrack('movieVideo', null);
  session?.rtc.setTrack('movieAudio', null);
  if (player.src === own.url || player.srcObject === own.display) clearPlayer();
}

function clearPlayer() {
  player.pause();
  player.srcObject = null;
  player.removeAttribute('src');
  player.load();
  player.dataset.key = '';
}

function loadPlayer(key, { src = null, srcObject = null, muted = false }) {
  player.muted = muted;
  if (player.dataset.key === key && (srcObject ? player.srcObject === srcObject : true)) return;
  player.dataset.key = key;
  player.pause();
  if (srcObject) {
    player.removeAttribute('src');
    player.srcObject = srcObject;
    player.play().catch(() => ($('#unblock').hidden = false));
  } else {
    player.srcObject = null;
    player.src = src;
    player.load();
  }
}

/** Points the <video> at the right thing for the current room source. */
function renderSource() {
  if (!session) return;
  const { sync } = session;
  const source = sync.source;
  const key = sourceKey(source);
  const isOwner = source.ownerId === session.selfId;
  const show = (id) => {
    for (const panel of ['#empty-state', '#local-pick', '#waiting-stream']) $(panel).hidden = panel !== id;
  };

  // Media we just picked is "pending" until the server confirms it as the room source.
  if (local.own?.key === key) local.own.pending = false;
  else if (local.own && !local.own.pending) releaseOwnMedia();
  if (local.localCopy?.key === key) local.localCopy.pending = false;
  else if (local.localCopy && !local.localCopy.pending) {
    URL.revokeObjectURL(local.localCopy.url);
    local.localCopy = null;
  }

  if (source.type !== 'youtube') unmountYouTube();

  switch (source.type) {
    case 'url':
      show(null);
      loadPlayer(key, { src: source.url });
      break;
    case 'youtube':
      show(null);
      clearPlayer();
      mountYouTube(source.videoId);
      break;
    case 'local':
      if (local.localCopy) {
        show(null);
        loadPlayer(key, { src: local.localCopy.url });
      } else {
        clearPlayer();
        $('#local-pick-title').textContent = `Open your copy of “${source.name}”`;
        show('#local-pick');
      }
      break;
    case 'stream':
    case 'screen':
      if (isOwner && local.own) {
        show(null);
        if (source.type === 'stream') {
          loadPlayer(key, { src: local.own.url });
        } else {
          // Preview your own capture silently; you already hear the tab itself.
          loadPlayer(key, { srcObject: local.own.display, muted: true });
        }
      } else {
        const stream = streamOfKind(source.ownerId, 'movie');
        if (stream && stream.getVideoTracks().length) {
          show(null);
          session.rtc.setPlayoutBuffer(source.ownerId, stream.getTracks());
          loadPlayer(`${key}|${stream.id}`, { srcObject: stream });
        } else {
          clearPlayer();
          $('#waiting-stream-title').textContent = `Connecting to ${ownerName(source.ownerId)}’s stream…`;
          show('#waiting-stream');
        }
      }
      break;
    default:
      clearPlayer();
      show('#empty-state');
  }
  applyMovieVolume();
  $('#stop-source').hidden = source.type === 'none';
  $('#now-playing').textContent = source.type === 'none' ? '' : (source.type === 'youtube' && yt?.title) || source.name || '';
  document.body.classList.toggle('has-source', source.type !== 'none');
}

function mountYouTube(videoId) {
  if (yt?.videoId !== videoId) {
    unmountYouTube();
    const host = $('#yt-host');
    yt = new YouTubeVideo(host, videoId);
    host.hidden = false;
    player.hidden = true;
    yt.volume = settings.movieVolume;
    yt.addEventListener('error', ({ detail }) => toast(detail.message, { tone: 'error', duration: 6000 }));
    yt.addEventListener('loadedmetadata', () => {
      if (yt?.title && session?.sync.source.type === 'youtube') $('#now-playing').textContent = yt.title;
    });
  }
  session?.sync.setVideo(yt);
}

function unmountYouTube() {
  if (!yt) return;
  yt.destroy();
  yt = null;
  $('#yt-host').hidden = true;
  player.hidden = false;
  session?.sync.setVideo(player);
}

/** When we are streaming a file, capture the player as soon as media is ready. */
player.addEventListener('loadedmetadata', () => {
  const own = local.own;
  if (!own || own.type !== 'stream' || player.src !== own.url || own.capture) return;
  const captured = captureElement(player);
  if (!captured) return;
  own.capture = captured.stream;
  const publish = () => {
    const video = captured.stream.getVideoTracks()[0] ?? null;
    const audio = captured.stream.getAudioTracks()[0] ?? null;
    if (video) video.contentHint = 'motion';
    if (audio) audio.contentHint = 'music';
    session?.rtc.setTrack('movieVideo', video);
    session?.rtc.setTrack('movieAudio', audio);
    if (captured.needsMonitor && audio && !own.monitor) {
      own.monitor = new Audio();
      own.monitor.srcObject = new MediaStream([audio]);
      own.monitor.play().catch(() => {});
      applyMovieVolume();
    }
  };
  captured.stream.addEventListener('addtrack', publish);
  publish();
});

function ownerName(id) {
  if (id === session?.selfId) return 'your';
  return session?.peers.get(id)?.name ?? 'the host';
}

function onSyncState({ playback, prev, actor, actorId, action, sourceChanged, optimistic }) {
  if (sourceChanged) renderSource();
  if (optimistic || action === 'INIT' || action === 'HEARTBEAT' || actorId === session.selfId) return;
  const who = actor || 'Someone';
  if (action === 'SOURCE' && sourceChanged) {
    if (playback.source.type === 'none') {
      if (prev && prev.source.type !== 'none') toast(`${who} stopped playback`);
    } else {
      toast(`${who} started “${playback.source.name}”`);
    }
  } else if (action === 'PLAY') toast(`▶ ${who} pressed play`);
  else if (action === 'PAUSE') toast(`❚❚ ${who} paused at ${formatTime(playback.time)}`);
  else if (action === 'SEEK') toast(`⇆ ${who} jumped to ${formatTime(playback.time)}`);
  wake();
}

// ---------------------------------------------------------------------------
// HUD

const seek = $('#seek');
const fill = $('#timeline-fill');
const thumb = $('#timeline-thumb');
const buffer = $('#timeline-buffer');
const tooltip = $('#timeline-tooltip');
let scrubbing = false;

// The HUD updates 4×/second and writes only what changed, so it never competes with video
// playback for main-thread time. While idle (HUD hidden) the timeline isn't touched at all.
const hudCache = new Map();
function write(key, value, apply) {
  if (hudCache.get(key) === value) return;
  hudCache.set(key, value);
  apply(value);
}

function renderHud() {
  const sync = session?.sync;
  if (!sync) return;
  const m = media();
  const playing = Boolean(sync.state?.playing);
  const live = sync.source.type === 'screen';

  write('icon', playing || live ? '#i-pause' : '#i-play', (v) => $('#play-btn use').setAttribute('href', v));
  write('playing', playing || (live && !m.paused), (v) => document.body.classList.toggle('is-playing', v));
  write('controllable', sync.controllable, (v) => document.body.classList.toggle('not-controllable', !v));
  write('live', live, (v) => {
    $('#live-badge').hidden = !v;
    $('#time-label').hidden = v;
  });
  if (document.body.classList.contains('idle')) return;

  const duration = sync.duration();
  const position = sync.localTime();
  if (!scrubbing) {
    const ratio = duration > 0 ? Math.min(1, position / duration) : 0;
    write('ratio', ratio.toFixed(4), (v) => {
      fill.style.transform = `scaleX(${v})`;
      thumb.style.left = `${v * 100}%`;
      seek.value = String(Math.round(v * 1000));
    });
    write('time', `${formatTime(position)} / ${formatTime(duration)}`, (v) => ($('#time-label').textContent = v));
  }
  let end = 0;
  if (sync.isController && duration > 0 && m.buffered.length) {
    for (let i = 0; i < m.buffered.length; i++) {
      if (m.buffered.start(i) <= position + 1) end = Math.max(end, m.buffered.end(i));
    }
  }
  write('buffer', duration > 0 ? Math.min(1, end / duration).toFixed(3) : '0', (v) => (buffer.style.transform = `scaleX(${v})`));
}
setInterval(renderHud, 250);

seek.addEventListener('input', () => {
  scrubbing = true;
  const ratio = Number(seek.value) / 1000;
  fill.style.transform = `scaleX(${ratio})`;
  thumb.style.left = `${ratio * 100}%`;
  const duration = session?.sync.duration() ?? 0;
  $('#time-label').textContent = `${formatTime(ratio * duration)} / ${formatTime(duration)}`;
});
seek.addEventListener('change', () => {
  scrubbing = false;
  hudCache.delete('ratio');
  hudCache.delete('time');
  const duration = session?.sync.duration() ?? 0;
  if (duration > 0) session.sync.seek((Number(seek.value) / 1000) * duration);
});
$('#timeline').addEventListener('pointermove', (e) => {
  const duration = session?.sync.duration() ?? 0;
  if (!duration) return;
  const rect = seek.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  tooltip.hidden = false;
  tooltip.textContent = formatTime(ratio * duration);
  tooltip.style.left = `${ratio * 100}%`;
});
$('#timeline').addEventListener('pointerleave', () => (tooltip.hidden = true));

// Auto-hiding HUD + cursor on idle.
let idleTimer = null;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const busy = session?.chat.open || document.querySelector('dialog[open]') || $('.hud:hover') || !$('#reaction-tray').hidden;
    if (!busy && document.body.classList.contains('is-playing')) document.body.classList.add('idle');
    else wake();
  }, 3000);
}
for (const evt of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) {
  window.addEventListener(evt, wake, { passive: true });
}
wake();

function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen();
  // Fullscreen the whole app (not just <video>) so cameras, chat and reactions stay visible.
  const root = document.documentElement;
  if (root.requestFullscreen) return root.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  if (player.webkitEnterFullscreen) player.webkitEnterFullscreen(); // iOS Safari fallback
}
document.addEventListener('fullscreenchange', () => {
  $('#fs-btn use').setAttribute('href', document.fullscreenElement ? '#i-shrink' : '#i-expand');
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
});

async function copyInvite() {
  const url = `${location.origin}/room/${roomId}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied', { tone: 'success' });
  } catch {
    prompt('Copy this invite link:', url);
  }
}

// Mixer
const movieVol = $('#movie-vol');
const voiceVol = $('#voice-vol');
const ambToggle = $('#ambilight-toggle');
movieVol.value = String(Math.round(settings.movieVolume * 100));
voiceVol.value = String(Math.round(settings.voiceVolume * 100));
ambToggle.checked = settings.ambilight;

function applyMovieVolume() {
  player.volume = settings.movieVolume;
  if (yt) yt.volume = settings.movieVolume;
  if (local.own?.monitor) local.own.monitor.volume = settings.movieVolume;
}
function applySettings() {
  applyMovieVolume();
  deck.setVoiceVolume(settings.voiceVolume);
  ambilight.setEnabled(settings.ambilight);
  $('#ambilight').hidden = !settings.ambilight;
  $('#movie-vol-out').textContent = `${movieVol.value}%`;
  $('#voice-vol-out').textContent = `${voiceVol.value}%`;
  storage.set('cinema.settings', settings);
}
movieVol.addEventListener('input', () => {
  settings.movieVolume = Number(movieVol.value) / 100;
  applySettings();
});
voiceVol.addEventListener('input', () => {
  settings.voiceVolume = Number(voiceVol.value) / 100;
  applySettings();
});
ambToggle.addEventListener('change', () => {
  settings.ambilight = ambToggle.checked;
  applySettings();
});
applySettings();

// Stats / quality chip
let lastStats = null;
async function updateStats() {
  const sync = session?.sync;
  const chip = $('#quality-chip');
  const panel = $('#stats');
  if (!sync || sync.source.type === 'none') {
    chip.hidden = true;
    panel.hidden = true;
    return;
  }
  const lines = [];
  let label = resolutionLabel(player.videoHeight);
  if (player.videoWidth) lines.push(['Display', `${player.videoWidth}×${player.videoHeight}`]);

  if (sync.source.type === 'stream' || sync.source.type === 'screen') {
    const remoteTrack = streamOfKind(sync.source.ownerId, 'movie')?.getVideoTracks()[0] ?? null;
    const stats = await session.rtc.movieStats(sync.source.ownerId, remoteTrack);
    const now = performance.now();
    if (stats.inbound) {
      const s = stats.inbound;
      const prev = lastStats?.inbound;
      const mbps = prev ? ((s.bytes - prev.bytes) * 8) / ((s.timestamp - prev.timestamp) * 1000) : 0;
      label = `${resolutionLabel(s.frameHeight || player.videoHeight)} · ${mbps.toFixed(1)} Mbps`;
      lines.push(['Receiving', `${s.frameWidth ?? '?'}×${s.frameHeight ?? '?'} @ ${Math.round(s.fps || 0)}fps`], ['Bitrate', `${mbps.toFixed(2)} Mbps`]);
      if (s.codec) lines.push(['Codec', s.codec]);
      if (s.decoder) lines.push(['Decoder', `${s.decoder}${s.powerEfficient ? ' (hardware)' : ''}`]);
      if (s.bufferMs != null) lines.push(['Buffer', `${Math.round(s.bufferMs)} ms`]);
      lines.push(['Dropped / freezes', `${s.framesDropped ?? 0} / ${s.freezeCount ?? 0}`]);
    }
    if (stats.outbound.length) {
      let total = 0;
      for (const s of stats.outbound) {
        const prev = lastStats?.outbound?.find((p) => p.peerId === s.peerId);
        const mbps = prev ? ((s.bytes - prev.bytes) * 8) / ((s.timestamp - prev.timestamp) * 1000) : 0;
        total += mbps;
        lines.push([`→ ${session.peers.get(s.peerId)?.name ?? 'peer'}`, `${s.frameWidth ?? '?'}×${s.frameHeight ?? '?'} · ${mbps.toFixed(1)} Mbps${s.limitation && s.limitation !== 'none' ? ` (limited: ${s.limitation})` : ''}`]);
      }
      const first = stats.outbound[0];
      if (first.codec) lines.push(['Codec', first.codec]);
      if (first.encoder) lines.push(['Encoder', `${first.encoder}${first.powerEfficient ? ' (hardware)' : ' (software)'}`]);
      const uploads = stats.outbound.map((o) => o.availableBps).filter(Boolean);
      if (uploads.length) {
        const worst = Math.min(...uploads) / 1e6;
        lines.push(['Upload estimate', `${worst.toFixed(1)} Mbps per viewer`]);
        if (worst * 1e6 < currentPreset().bitrate * 0.8) lines.push(['Tip', 'Connection is below this preset; try Eco']);
      }
      lines.push(['Quality preset', `${currentPreset().label} · ${currentPreset().detail}`]);
      label = `${resolutionLabel(first.frameHeight)} · ↑${total.toFixed(1)} Mbps`;
    }
    lastStats = { ...stats, at: now };
  } else if (sync.source.type === 'youtube') {
    label = yt ? youtubeQualityLabel(yt.quality) : '';
    lines.push(['Mode', 'YouTube (each viewer streams from YouTube)']);
    if (label) lines.push(['YouTube quality', label]);
  } else {
    lines.push(['Mode', sync.source.type === 'url' ? 'Direct link (each viewer streams the source)' : 'Local copy (nothing sent over the network)']);
  }
  const m = media();
  lines.push(['Drift', sync.isController && m.readyState ? `${((m.currentTime - sync.expectedTime()) * 1000).toFixed(0)} ms` : '—']);

  chip.hidden = !label;
  chip.textContent = label;
  panel.hidden = !statsOpen;
  if (statsOpen) {
    panel.replaceChildren(
      ...lines.map(([k, v]) => {
        const row = document.createElement('div');
        const dt = document.createElement('span');
        const dd = document.createElement('strong');
        dt.textContent = k;
        dd.textContent = v;
        row.append(dt, dd);
        return row;
      }),
    );
  }
}
setInterval(() => updateStats().catch(() => {}), 1000);

// ---------------------------------------------------------------------------
// Actions & keyboard

const actions = {
  'toggle-play': () => session?.sync.toggle(),
  back: () => session?.sync.seekBy(-10),
  forward: () => session?.sync.seekBy(10),
  'toggle-mic': toggleMic,
  'toggle-cam': toggleCam,
  'open-source': () => sourceDialog.showModal(),
  'open-mixer': () => $('#mixer-dialog').showModal(),
  'close-dialog': (btn) => btn.closest('dialog')?.close(),
  'share-screen': shareScreen,
  'stop-source': () => setSource({ type: 'none' }),
  'toggle-chat': () => session?.chat.toggle(),
  'toggle-fullscreen': toggleFullscreen,
  'toggle-reactions': () => session?.reactions.toggleTray(),
  'copy-invite': copyInvite,
  'toggle-stats': () => {
    statsOpen = !statsOpen;
    updateStats();
  },
};

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (btn && actions[btn.dataset.action]) {
    actions[btn.dataset.action](btn);
  }
  if (!e.target.closest('#reaction-picker')) session?.reactions.toggleTray(false);
});

// Clicking the movie itself toggles play/pause, like a normal player. The shield covers the
// <video> and the YouTube iframe alike, so YouTube's own UI can never desync the room.
const shield = $('#click-shield');
let clickTimer = null;
shield.addEventListener('click', () => {
  // Wait briefly so a double-click (fullscreen) doesn't also toggle playback twice.
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => session?.sync.controllable && session.sync.toggle(), 220);
});
shield.addEventListener('dblclick', () => {
  clearTimeout(clickTimer);
  toggleFullscreen();
});

// Streaming quality picker (applies live to an ongoing share/stream).
function renderQualityPicker() {
  $('#quality-picker').replaceChildren(
    ...Object.entries(STREAM_PRESETS).map(([id, p]) =>
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(id === settings.quality), 'data-preset': id, title: p.note }, [
        p.label,
        h('small', { text: p.detail }),
        h('small', { text: p.note }),
      ]),
    ),
  );
}
$('#quality-picker').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-preset]');
  if (!btn) return;
  settings.quality = btn.dataset.preset;
  storage.set('cinema.settings', settings);
  renderQualityPicker();
  session?.rtc.setMoviePreset(currentPreset());
  if (local.own?.display) applyDisplayPreset(local.own.display.getVideoTracks()[0], currentPreset());
  toast(`Streaming quality: ${currentPreset().label} (${currentPreset().detail})`);
});
renderQualityPicker();

$('#unblock').addEventListener('click', () => {
  $('#unblock').hidden = true;
  session?.sync.unblock();
  if (player.srcObject) player.play().catch(() => {});
});

// Close dialogs by clicking the backdrop.
for (const dialog of $$('dialog')) {
  if (dialog.id === 'join-dialog') continue;
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
}

document.addEventListener('chat:peek', ({ detail }) => toast(`${detail.name}: ${detail.text}`, { tone: 'chat', duration: 4000 }));

document.addEventListener('keydown', (e) => {
  if (!session || e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) {
    if (e.key === 'Escape' && session?.chat.open) session.chat.toggle(false);
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key.toLowerCase();
  const handled = {
    ' ': () => session.sync.toggle(),
    k: () => session.sync.toggle(),
    arrowleft: () => session.sync.seekBy(-10),
    arrowright: () => session.sync.seekBy(10),
    j: () => session.sync.seekBy(-10),
    l: () => session.sync.seekBy(10),
    f: toggleFullscreen,
    c: () => session.chat.toggle(),
    m: toggleMic,
    v: toggleCam,
    r: () => session.reactions.toggleTray(),
    i: actions['toggle-stats'],
    escape: () => session.chat.open && session.chat.toggle(false),
  }[key];
  if (handled) {
    e.preventDefault();
    handled();
  } else if (/^[1-8]$/.test(key)) {
    session.reactions.sendByIndex(Number(key) - 1);
  }
});

window.addEventListener('beforeunload', () => {
  local.camTrack?.stop();
  local.micTrack?.stop();
  releaseOwnMedia();
});

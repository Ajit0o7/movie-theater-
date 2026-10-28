// Phone remote, opened by scanning the QR code a computer in the room shows. It controls that
// computer's playback (play/pause, skip, scrub, its volume), sends reactions as that person,
// and can make the phone their webcam. The phone is not a room participant: everything goes
// through the computer it is paired with, which runs the commands with its own controls.

import { $, formatTime, h } from './util.js';

const token = new URLSearchParams(location.search).get('pair');
const socket = io();

let joined = false;
let owner = { online: false, name: '' };
let state = null; // the computer's player, pushed about once a second
let stateAt = 0;
let scrubbing = false;
let reactionsKey = '';

const send = (cmd, value) => socket.emit('remote:command', value === undefined ? { cmd } : { cmd, value });
const buzz = () => navigator.vibrate?.(8);

function fail(message) {
  $('#remote-error-text').textContent = message;
  $('#remote-error').hidden = false;
  $('#remote-player').hidden = true;
  $('#remote-camera').hidden = true;
  setStatus('Not connected', 'off');
  camera.stop({ notify: false });
}

function setStatus(text, tone) {
  $('#remote-status').textContent = text;
  $('#remote-link').dataset.tone = tone;
}

socket.on('connect', () => {
  if (!token) return;
  socket.emit('remote:join', { token }, (res) => {
    if (res?.error) return fail(res.error);
    joined = true;
    owner = { online: res.online, name: res.name };
    $('#remote-player').hidden = false;
    $('#remote-camera').hidden = false;
    $('#remote-for').textContent = `Remote for ${res.name}’s screen`;
    render();
    send('state');
    if (camera.wanted) camera.connect(); // our socket changed: start the camera link again
  });
});
socket.on('disconnect', () => joined && setStatus('Reconnecting…', 'wait'));
socket.on('remote:owner', ({ online, name }) => {
  const wasOnline = owner.online;
  owner = { online, name };
  render();
  if (online && !wasOnline && camera.wanted && !camera.connected) camera.connect();
});
socket.on('remote:state', (s) => {
  state = s;
  stateAt = performance.now();
  render();
});
socket.on('remote:ended', () => {
  joined = false;
  fail('The computer unpaired this phone. Scan the QR code again to reconnect.');
});
socket.on('remote:signal', ({ data }) => camera.onSignal(data));

// ---- remote control ------------------------------------------------------------------
const position = () => {
  if (!state) return 0;
  const t = state.time + (state.playing ? (performance.now() - stateAt) / 1000 : 0);
  return state.duration ? Math.min(t, state.duration) : t;
};

function render() {
  if (!joined) return;
  setStatus(owner.online ? `Connected to ${owner.name}` : `Waiting for ${owner.name}’s computer…`, owner.online ? 'on' : 'wait');
  const live = Boolean(state) && !state.duration;
  const can = owner.online && Boolean(state?.controllable);
  $('#remote-title').textContent = state?.title || 'Nothing playing yet';
  $('#remote-play use').setAttribute('href', state?.playing ? '#i-pause' : '#i-play');
  for (const id of ['#remote-play', '#remote-back', '#remote-fwd', '#remote-seek']) $(id).disabled = !can;
  $('#remote-seek').hidden = live;
  $('#remote-duration').textContent = live ? 'Live' : formatTime(state?.duration ?? 0);
  if (state && !$('#remote-vol').matches(':active')) {
    $('#remote-vol').value = String(Math.round((state.volume ?? 1) * 100));
    $('#remote-vol-out').textContent = `${$('#remote-vol').value}%`;
  }
  $('#remote-vol').disabled = !owner.online;
  const reactions = Array.isArray(state?.reactions) ? state.reactions : [];
  if (reactions.join('') !== reactionsKey) {
    reactionsKey = reactions.join('');
    $('#remote-reactions').replaceChildren(
      ...reactions.map((emoji) => h('button', { type: 'button', class: 'remote-reaction', 'data-emoji': emoji, text: emoji, 'aria-label': `React ${emoji}` })),
    );
  }
  for (const b of $('#remote-reactions').children) b.disabled = !owner.online;
  tick();
}

function tick() {
  const t = position();
  if (!scrubbing) {
    $('#remote-time').textContent = formatTime(t);
    if (state?.duration) $('#remote-seek').value = String(Math.round((t / state.duration) * 1000));
  }
}
setInterval(tick, 250);

$('#remote-play').addEventListener('click', () => {
  buzz();
  send('toggle');
});
$('#remote-back').addEventListener('click', () => {
  buzz();
  send('seekBy', -10);
});
$('#remote-fwd').addEventListener('click', () => {
  buzz();
  send('seekBy', 10);
});
$('#remote-seek').addEventListener('input', (e) => {
  scrubbing = true;
  if (state?.duration) $('#remote-time').textContent = formatTime((Number(e.target.value) / 1000) * state.duration);
});
$('#remote-seek').addEventListener('change', (e) => {
  scrubbing = false;
  if (state?.duration) send('seek', (Number(e.target.value) / 1000) * state.duration);
});

let volumeTimer = null;
$('#remote-vol').addEventListener('input', (e) => {
  $('#remote-vol-out').textContent = `${e.target.value}%`;
  // At most ~8 updates a second while dragging; the last value always goes out.
  volumeTimer ??= setTimeout(() => {
    volumeTimer = null;
    send('volume', Number($('#remote-vol').value) / 100);
  }, 120);
});

$('#remote-reactions').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-emoji]');
  if (!btn) return;
  buzz();
  send('reaction', btn.dataset.emoji);
  btn.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
});

// ---- phone as webcam -------------------------------------------------------------------
const camera = {
  wanted: false,
  connected: false,
  facing: 'user',
  stream: null,
  pc: null,
  sender: null,
  chain: Promise.resolve(),
  wakeLock: null,

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      $('#remote-cam-hint').textContent =
        'The camera needs a secure (https://) address. On the computer, start the server with “npm run start:https”, then scan the new QR code.';
      return;
    }
    try {
      await this.open();
    } catch (err) {
      $('#remote-cam-hint').textContent = err?.name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in the browser settings and try again.' : 'Couldn’t start the camera.';
      return;
    }
    this.wanted = true;
    this.ui();
    this.keepAwake();
    await this.connect();
  },

  async open() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: this.facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'motion';
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    const preview = $('#remote-cam-video');
    preview.srcObject = stream;
    preview.classList.toggle('mirrored', this.facing === 'user');
    if (this.sender) await this.sender.replaceTrack(track); // flipping: no renegotiation
  },

  async connect() {
    if (!this.stream || !owner.online || !joined) return;
    this.pc?.close();
    this.connected = false;
    let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    try {
      const cfg = await (await fetch('/api/config', { cache: 'no-store' })).json();
      if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) iceServers = cfg.iceServers;
    } catch {
      /* STUN is enough on the same Wi-Fi */
    }
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    this.chain = Promise.resolve();
    this.sender = pc.addTrack(this.stream.getVideoTracks()[0], this.stream);
    pc.onicecandidate = ({ candidate }) => candidate && socket.emit('remote:signal', { data: { candidate } });
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;
      this.connected = pc.connectionState === 'connected';
      this.ui();
      if (pc.connectionState === 'failed' && this.wanted) setTimeout(() => this.wanted && pc === this.pc && this.connect(), 2000);
    };
    await pc.setLocalDescription(await pc.createOffer());
    socket.emit('remote:signal', { data: { description: pc.localDescription, facing: this.facing } });
    this.ui();
  },

  onSignal(data) {
    // In order: candidates must not overtake the answer they belong to.
    this.chain = this.chain.then(async () => {
      if (!data || typeof data !== 'object') return;
      if (data.stop) return this.stop({ notify: false }); // turned off on the computer
      if (!this.pc) return;
      if (data.description) await this.pc.setRemoteDescription(data.description);
      else if (data.candidate) await this.pc.addIceCandidate(data.candidate).catch(() => {});
    }).catch((err) => console.warn('[remote] camera signaling', err));
  },

  async flip() {
    this.facing = this.facing === 'user' ? 'environment' : 'user';
    try {
      await this.open();
      socket.emit('remote:signal', { data: { facing: this.facing } });
    } catch {
      this.facing = this.facing === 'user' ? 'environment' : 'user'; // no second camera
    }
  },

  stop({ notify = true } = {}) {
    if (notify && this.wanted) socket.emit('remote:signal', { data: { stop: true } });
    this.wanted = false;
    this.connected = false;
    this.pc?.close();
    this.pc = null;
    this.sender = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    $('#remote-cam-video').srcObject = null;
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.ui();
  },

  /** The screen must stay on while the phone is a camera. */
  async keepAwake() {
    try {
      this.wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      /* not supported, or battery saver */
    }
  },

  ui() {
    $('#remote-cam-preview').hidden = !this.wanted;
    $('#remote-cam-start').hidden = this.wanted;
    $('#remote-cam-flip').hidden = !this.wanted;
    $('#remote-cam-stop').hidden = !this.wanted;
    $('#remote-cam-state').textContent = !owner.online ? 'Waiting for the computer…' : this.connected ? '● Live in the room' : 'Connecting…';
    $('#remote-cam-state').classList.toggle('live', this.connected);
  },
};

$('#remote-cam-start').addEventListener('click', () => camera.start());
$('#remote-cam-flip').addEventListener('click', () => camera.flip());
$('#remote-cam-stop').addEventListener('click', () => camera.stop());
// The browser drops a wake lock whenever the page is hidden: take it again on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && camera.wanted && (!camera.wakeLock || camera.wakeLock.released)) camera.keepAwake();
});

if (!token) fail('Open this page by scanning the QR code on the computer (the phone button in the room).');

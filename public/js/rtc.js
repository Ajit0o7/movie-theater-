// Mesh WebRTC manager using the "perfect negotiation" pattern.
//
// Every participant has one RTCPeerConnection per other participant. Local media is
// organised in four fixed slots so tracks can be swapped with replaceTrack() (no
// renegotiation) when cameras toggle or the movie source changes:
//
//   camVideo + micAudio      -> "camera" MediaStream (voice: echo-cancelled)
//   movieVideo + movieAudio  -> "movie" MediaStream (preset-driven up to 4K, unfiltered stereo)

import { SAFE_DEFAULT_ORDER, movieCodecOrder } from './codecs.js';
import { DEFAULT_PRESET, STREAM_PRESETS } from './media.js';

// Opus is transparent for stereo film audio at ~160 kbps; anything above that is taken
// straight from the video's share of a slow connection.
export const MOVIE_AUDIO_BITRATE = 160_000;
export const CAMERA_VIDEO_BITRATE = 1_200_000;
export const VOICE_AUDIO_BITRATE = 64_000;

const SLOTS = {
  camVideo: { stream: 'camera', kind: 'video' },
  micAudio: { stream: 'camera', kind: 'audio' },
  movieVideo: { stream: 'movie', kind: 'video' },
  movieAudio: { stream: 'movie', kind: 'audio' },
};

/**
 * Raises Opus to full-band stereo. `stereo=1` in an SDP tells the *remote* encoder it may
 * send stereo, so this is applied to both offers and answers, and to every audio m-section
 * (mic and movie each have their own; the movie's is not the first one).
 */
export function enableOpusStereo(sdp) {
  const extra = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: String(MOVIE_AUDIO_BITRATE), useinbandfec: '1' };
  const sections = sdp.split(/\r\n(?=m=)/);
  return sections
    .map((section) => {
      if (!section.startsWith('m=audio')) return section;
      const match = section.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
      if (!match) return section;
      const pt = match[1];
      const fmtp = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
      if (!fmtp.test(section)) {
        const params = Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(';');
        return section.replace(match[0], `${match[0]}\r\na=fmtp:${pt} ${params}`);
      }
      return section.replace(fmtp, (_line, existing) => {
        const params = new Map(existing.split(';').filter(Boolean).map((p) => p.trim().split('=')));
        for (const [k, v] of Object.entries(extra)) params.set(k, v);
        return `a=fmtp:${pt} ${[...params].map(([k, v]) => `${k}=${v}`).join(';')}`;
      });
    })
    .join('\r\n');
}

/**
 * Movie receivers get a deliberate playout buffer. WebRTC defaults to call-style minimal
 * latency, which turns any network hiccup into a freeze; a movie can easily afford 0.8s.
 */
export const MOVIE_JITTER_BUFFER_MS = 800;

/** Temporal SVC: frames lost from the enhancement layer don't break the base layer's chain. */
const SVC_CODECS = ['video/av1', 'video/vp9'];
const SVC_MODE = 'L1T2';

/** Chrome accepts L1T2 but leaves `scalabilityModes` empty in its capabilities; only a
 *  browser that lists modes can rule one out. Rejection is handled by the fallback chain. */
function mayScale(mime, mode) {
  const caps = (globalThis.RTCRtpSender?.getCapabilities?.('video')?.codecs ?? []).filter((c) => c.mimeType.toLowerCase() === mime);
  const listed = caps.flatMap((c) => c.scalabilityModes ?? []);
  return listed.length === 0 || listed.includes(mode);
}

/**
 * Upload budget for a mesh. The host sends a separate encoded copy of the movie (and of their
 * webcam) to every viewer, and each copy competes for the same uplink and CPU. Giving every
 * viewer the full preset made big rooms freeze. Per-viewer bitrate and resolution shrink
 * as the room grows, so the total stays near what a home connection and CPU can sustain:
 *
 *   movie   1–2 viewers: full preset; then the bitrate of two full copies is shared (never below
 *           1.2 Mbps each), and resolution is capped at 1440p (3), 1080p (4–5), 720p (6+)
 *   camera  ~2.4 Mbps shared across viewers (250 kbps–1.2 Mbps each), 720p → 480p → 360p
 */
export function meshBudget(preset, viewers) {
  const n = Math.max(1, viewers || 1);
  const movieBitrate = n <= 2 ? preset.bitrate : Math.round(Math.max(1_200_000, Math.min(preset.bitrate, (preset.bitrate * 2) / n)));
  const movieHeightCap = n <= 2 ? preset.height : n === 3 ? 1440 : n <= 5 ? 1080 : 720;
  return {
    movieBitrate,
    movieHeight: Math.min(preset.height, movieHeightCap),
    cameraBitrate: Math.round(Math.min(CAMERA_VIDEO_BITRATE, Math.max(250_000, 2_400_000 / n))),
    cameraHeight: n <= 2 ? 720 : n <= 4 ? 480 : 360,
  };
}

/** Scale factor that brings a track down to `maxHeight` (never up). */
function downscale(track, maxHeight, knownHeight = 0) {
  const height = track.getSettings?.().height || knownHeight; // a forwarded (phone) track may not say
  return height && height > maxHeight ? height / maxHeight : 1;
}

/**
 * Camera resolution steps and the bitrate each needs to keep moving. A webcam squeezed to
 * ~150 kbps while still encoding 720p freezes: every lost keyframe is so large it takes seconds
 * to resend. A smaller picture at the same bitrate keeps the face moving.
 */
export const CAMERA_STEPS = [
  [720, 700_000],
  [480, 400_000],
  [360, 200_000],
  [240, 0],
];

/**
 * Pure: the camera height a connection that gives the camera `bitrate` (bps) can carry, never
 * above `maxHeight`. Going back up needs 30% headroom over that step's need, so it doesn't flap.
 * Unknown bitrate (a browser without the stat): keep `current`.
 */
export function cameraHeightFor(bitrate, maxHeight, current = maxHeight) {
  if (!(bitrate > 0)) return current;
  for (const [height, needs] of CAMERA_STEPS) {
    if (height > maxHeight) continue;
    if (bitrate >= (height > current ? needs * 1.3 : needs)) return height;
  }
  return 240;
}

/** Pure: the step below `height` (for a camera encoder short of CPU). */
export function cameraStepDown(height) {
  return CAMERA_STEPS.map(([h]) => h).find((h) => h < height) ?? 240;
}

const CAMERA_GUARD_MS = 3000;
const CPU_HOLD_MS = 30_000; // after stepping down for CPU, don't climb back for this long
const cameraCaps = new WeakMap(); // camera sender -> height the guard allows for that connection
const cameraHolds = new WeakMap(); // camera sender -> time before which it may not go up
const sourceHeights = new WeakMap(); // camera sender -> the track's real height, when it doesn't say

// getParameters()/setParameters() is a transaction: two overlapping calls on one sender make
// the second fail. Calls are queued per sender so they never overlap.
const senderQueues = new WeakMap();

/**
 * Lifts the browser's default (~2.5 Mbps) sender cap and applies the movie preset. Safe to
 * call repeatedly. Newer fields (codec, scalabilityMode) are tried first and dropped one
 * layer at a time if the browser rejects them, so the essentials always land.
 */
export function applySenderParams(sender, slot, preset = STREAM_PRESETS[DEFAULT_PRESET], codecOrder = SAFE_DEFAULT_ORDER, viewers = 1) {
  if (!sender) return Promise.resolve();
  const next = (senderQueues.get(sender) ?? Promise.resolve()).then(() => setSenderParams(sender, slot, preset, codecOrder, viewers));
  senderQueues.set(sender, next);
  return next;
}

async function setSenderParams(sender, slot, preset, codecOrder, viewers) {
  if (!sender.track) return;
  const budget = meshBudget(preset, viewers);
  const variants = slot === 'movieVideo' ? ['full', 'codec', 'no-codec', 'minimal'] : ['full', 'minimal'];
  let lastErr;
  for (const variant of variants) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      const enc = params.encodings[0];
      if (slot === 'movieVideo') {
        enc.maxBitrate = budget.movieBitrate;
        if (variant !== 'minimal') {
          // Scaled to the preset (a captured 4K file) and further down in big rooms.
          enc.scaleResolutionDownBy = downscale(sender.track, budget.movieHeight);
          enc.maxFramerate = preset.fps;
          enc.priority = 'high';
          enc.networkPriority = 'high';
          params.degradationPreference = preset.degradation;
        }
        if (variant === 'full' || variant === 'codec') {
          // Pin the codec on the sender itself, so it survives renegotiations started by the
          // other side (whose offers list codecs in their default order).
          const codec = codecOrder
            .map((mime) => params.codecs?.find((c) => c.mimeType.toLowerCase() === mime.toLowerCase()))
            .find(Boolean);
          if (codec) {
            enc.codec = codec;
            const mime = codec.mimeType.toLowerCase();
            if (variant === 'full' && SVC_CODECS.includes(mime) && mayScale(mime, SVC_MODE)) enc.scalabilityMode = SVC_MODE;
            else delete enc.scalabilityMode;
          }
        }
      } else if (slot === 'movieAudio') {
        enc.maxBitrate = MOVIE_AUDIO_BITRATE;
        if (variant !== 'minimal') {
          enc.priority = 'high';
          enc.networkPriority = 'high';
        }
      } else if (slot === 'camVideo') {
        enc.maxBitrate = budget.cameraBitrate;
        if (variant !== 'minimal') {
          // Below the movie, but not 'low': on a tight connection a low-priority camera was
          // starved to a frozen frame. Faces keep moving: drop resolution, never frame rate.
          enc.priority = 'medium';
          enc.networkPriority = 'medium';
          enc.maxFramerate = 30;
          const cap = Math.min(budget.cameraHeight, cameraCaps.get(sender) ?? Infinity);
          enc.scaleResolutionDownBy = downscale(sender.track, cap, sourceHeights.get(sender));
          params.degradationPreference = 'maintain-framerate';
        }
      } else if (slot === 'micAudio') {
        enc.maxBitrate = VOICE_AUDIO_BITRATE;
        if (variant !== 'minimal') enc.priority = 'high';
      }
      await sender.setParameters(params);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  console.warn('[rtc] setParameters failed', slot, lastErr);
}

/** Orders the movie transceiver's codecs for negotiation (most preferred first). */
function preferMovieCodecs(transceiver, order) {
  if (!transceiver?.setCodecPreferences || !window.RTCRtpReceiver?.getCapabilities) return;
  const caps = RTCRtpReceiver.getCapabilities('video');
  if (!caps) return;
  const rank = (c) => {
    const i = order.findIndex((m) => m.toLowerCase() === c.mimeType.toLowerCase());
    return i === -1 ? order.length : i; // rtx, red, ulpfec, flexfec keep their order at the end
  };
  const codecs = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
  try {
    transceiver.setCodecPreferences(codecs);
  } catch (err) {
    console.warn('[rtc] setCodecPreferences failed', err);
  }
}

export class PeerManager extends EventTarget {
  constructor({ socket, selfId, iceServers }) {
    super();
    this.socket = socket;
    this.selfId = selfId;
    this.iceServers = iceServers;
    this.peers = new Map();
    this.streams = { camera: new MediaStream(), movie: new MediaStream() };
    this.tracks = { camVideo: null, micAudio: null, movieVideo: null, movieAudio: null };
    this.moviePreset = STREAM_PRESETS[DEFAULT_PRESET];
    this.codecOrder = SAFE_DEFAULT_ORDER;

    this.onSignal = ({ from, data }) => this.#handleSignal(from, data);
    socket.on('signal', this.onSignal);
    this.cameraGuard = setInterval(() => this.#guardCameras(), CAMERA_GUARD_MS);
  }

  /**
   * Keeps each outgoing webcam at a resolution its connection can carry: every few seconds,
   * reads how much bitrate the browser actually gives the camera on that connection (it shares
   * the link with the movie) and steps 720p → 480p → 360p → 240p before the picture freezes.
   * An encoder short of CPU (a laptop also decoding a 4K movie) steps down too. Climbs back
   * when there's room.
   */
  async #guardCameras() {
    const budget = meshBudget(this.moviePreset, this.peers.size);
    for (const peer of this.peers.values()) {
      const sender = peer.senders.camVideo;
      if (!sender?.track || peer.pc.connectionState !== 'connected') continue;
      let out = null;
      try {
        (await sender.getStats()).forEach((s) => {
          if (s.type === 'outbound-rtp' && s.kind === 'video') out = s;
        });
      } catch {
        continue;
      }
      if (!out) continue;
      // A forwarded phone camera doesn't report its size: learn it from what's sent unscaled.
      if (!sender.track.getSettings?.().height && out.frameHeight && !cameraCaps.has(sender)) {
        sourceHeights.set(sender, Math.max(sourceHeights.get(sender) ?? 0, out.frameHeight));
      }
      const current = Math.min(cameraCaps.get(sender) ?? budget.cameraHeight, budget.cameraHeight);
      let next = cameraHeightFor(out.targetBitrate, budget.cameraHeight, current);
      const now = performance.now();
      if (out.qualityLimitationReason === 'cpu') {
        next = Math.min(next, cameraStepDown(current));
        cameraHolds.set(sender, now + CPU_HOLD_MS);
      }
      if (next > current && now < (cameraHolds.get(sender) ?? 0)) next = current;
      if (next === current) continue;
      cameraCaps.set(sender, next);
      applySenderParams(sender, 'camVideo', this.moviePreset, this.codecOrder, this.peers.size);
    }
  }

  get cameraStreamId() {
    return this.streams.camera.id;
  }

  get movieStreamId() {
    return this.streams.movie.id;
  }

  addPeer(peerId) {
    if (peerId === this.selfId) return null;
    const existing = this.peers.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    const peer = {
      id: peerId,
      pc,
      polite: this.selfId > peerId,
      makingOffer: false,
      ignoreOffer: false,
      senders: {},
      pendingCandidates: [],
    };
    this.peers.set(peerId, peer);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.#send(peerId, { candidate });
    };

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        const offer = await pc.createOffer();
        if (pc.signalingState !== 'stable') return;
        await pc.setLocalDescription({ type: 'offer', sdp: enableOpusStereo(offer.sdp) });
        this.#send(peerId, { description: pc.localDescription });
      } catch (err) {
        // A remote offer arrived while ours was being created (glare). Perfect negotiation
        // resolves it via the remote offer, and negotiationneeded fires again afterwards.
        if (err?.name === 'InvalidStateError' && pc.signalingState !== 'stable') return;
        console.warn('[rtc] negotiation failed', err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] ?? new MediaStream([track]);
      this.dispatchEvent(new CustomEvent('track', { detail: { peerId, track, stream } }));
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.#applyAllParams(peer);
      if (pc.connectionState === 'failed') pc.restartIce?.();
      this.dispatchEvent(new CustomEvent('state', { detail: { peerId, state: pc.connectionState } }));
    };

    for (const slot of Object.keys(SLOTS)) {
      if (this.tracks[slot]) this.#attach(peer, slot, this.tracks[slot]);
    }
    this.#rebudget(peer);
    return peer;
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.pc.close();
    this.peers.delete(peerId);
    this.#rebudget();
  }

  /** Puts `track` (or null to clear) into a slot on every connection. */
  async setTrack(slot, track) {
    const { stream } = SLOTS[slot];
    const previous = this.tracks[slot];
    if (previous && previous !== track) this.streams[stream].removeTrack(previous);
    if (track) this.streams[stream].addTrack(track);
    this.tracks[slot] = track;

    await Promise.all(
      [...this.peers.values()].map(async (peer) => {
        const sender = peer.senders[slot];
        if (sender) {
          await sender.replaceTrack(track).catch((err) => console.warn('[rtc] replaceTrack failed', err));
          if (track) await applySenderParams(sender, slot, this.moviePreset, this.codecOrder, this.peers.size);
        } else if (track) {
          this.#attach(peer, slot, track);
        }
      }),
    );
  }

  /** Changes bitrate / resolution / degradation for the outgoing movie on every connection. */
  async setMoviePreset(preset) {
    this.moviePreset = preset;
    this.#applyMovieParams();
    // Then re-pick the codec for what this device can encode smoothly at this preset.
    const order = await movieCodecOrder(preset);
    if (this.moviePreset !== preset) return; // superseded by a newer preset
    this.codecOrder = order;
    for (const peer of this.peers.values()) {
      const sender = peer.senders.movieVideo;
      if (sender) preferMovieCodecs(peer.pc.getTransceivers().find((t) => t.sender === sender), order);
    }
    this.#applyMovieParams();
    this.dispatchEvent(new CustomEvent('codecs', { detail: { order } }));
  }

  #applyMovieParams() {
    for (const peer of this.peers.values()) applySenderParams(peer.senders.movieVideo, 'movieVideo', this.moviePreset, this.codecOrder, this.peers.size);
  }

  /** Adds a playout buffer to the receivers carrying `tracks` from `peerId` (movie only). */
  setPlayoutBuffer(peerId, tracks, ms = MOVIE_JITTER_BUFFER_MS) {
    const pc = this.peers.get(peerId)?.pc;
    if (!pc) return;
    for (const receiver of pc.getReceivers()) {
      if (!receiver.track || !tracks.includes(receiver.track)) continue;
      if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = ms;
      else if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = ms / 1000; // older Chrome
    }
  }

  /**
   * Stats for the movie slot (for the quality chip): every outbound movie sender when we
   * are the source, otherwise the receiver carrying `remoteTrack` from the source peer.
   */
  async movieStats(sourcePeerId, remoteTrack = null) {
    const result = { outbound: [], inbound: null };
    if (sourcePeerId === this.selfId) {
      for (const peer of this.peers.values()) {
        const sender = peer.senders.movieVideo;
        if (!sender?.track) continue;
        const stats = await sender.getStats();
        let availableBps = null;
        stats.forEach((s) => {
          if (s.type === 'candidate-pair' && s.nominated && s.availableOutgoingBitrate) availableBps = s.availableOutgoingBitrate;
        });
        stats.forEach((s) => {
          if (s.type === 'outbound-rtp' && s.kind === 'video') result.outbound.push({ peerId: peer.id, availableBps, ...pick(s, stats) });
        });
      }
    } else {
      const receiver = this.peers.get(sourcePeerId)?.pc.getReceivers().find((r) => r.track && r.track === remoteTrack);
      if (!receiver) return result;
      const stats = await receiver.getStats();
      stats.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') result.inbound = pick(s, stats);
      });
    }
    return result;
  }

  destroy() {
    clearInterval(this.cameraGuard);
    this.socket.off('signal', this.onSignal);
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }

  #attach(peer, slot, track) {
    const sender = peer.pc.addTrack(track, this.streams[SLOTS[slot].stream]);
    peer.senders[slot] = sender;
    if (slot === 'movieVideo') {
      preferMovieCodecs(peer.pc.getTransceivers().find((t) => t.sender === sender), this.codecOrder);
    }
    applySenderParams(sender, slot, this.moviePreset, this.codecOrder, this.peers.size);
  }

  /** The room size changed: every other connection's share of the upload changes too. */
  #rebudget(except = null) {
    for (const peer of this.peers.values()) if (peer !== except) this.#applyAllParams(peer);
  }

  /** Total upload the movie and webcam will use across all viewers (for the host's warning). */
  uploadEstimate() {
    const budget = meshBudget(this.moviePreset, this.peers.size);
    const n = this.peers.size;
    return {
      viewers: n,
      movie: this.tracks.movieVideo ? budget.movieBitrate * n : 0,
      camera: this.tracks.camVideo ? budget.cameraBitrate * n : 0,
    };
  }

  #applyAllParams(peer) {
    for (const [slot, sender] of Object.entries(peer.senders)) applySenderParams(sender, slot, this.moviePreset, this.codecOrder, this.peers.size);
  }

  #send(to, data) {
    this.socket.emit('signal', { to, data });
  }

  async #handleSignal(from, { description, candidate } = {}) {
    const peer = this.peers.get(from) ?? this.addPeer(from);
    if (!peer) return;
    const { pc } = peer;
    try {
      if (description) {
        const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;

        await pc.setRemoteDescription(description);
        for (const c of peer.pendingCandidates.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        if (description.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription({ type: 'answer', sdp: enableOpusStereo(answer.sdp) });
          this.#send(from, { description: pc.localDescription });
        }
        this.#applyAllParams(peer);
      } else if (candidate) {
        if (!pc.remoteDescription) {
          peer.pendingCandidates.push(candidate);
          return;
        }
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          if (!peer.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.warn('[rtc] signal handling failed', err);
    }
  }
}

function pick(s, report) {
  const codec = s.codecId && report.get(s.codecId);
  return {
    codec: codec ? codec.mimeType.replace('video/', '') : null,
    encoder: s.encoderImplementation,
    decoder: s.decoderImplementation,
    powerEfficient: s.powerEfficientEncoder ?? s.powerEfficientDecoder,
    framesDropped: s.framesDropped,
    freezeCount: s.freezeCount,
    bufferMs: s.jitterBufferEmittedCount ? (s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000 : null,
    bytes: s.bytesSent ?? s.bytesReceived ?? 0,
    timestamp: s.timestamp,
    frameWidth: s.frameWidth,
    frameHeight: s.frameHeight,
    fps: s.framesPerSecond,
    limitation: s.qualityLimitationReason,
    codecId: s.codecId,
  };
}

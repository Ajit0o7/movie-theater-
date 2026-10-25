// Mesh WebRTC manager using the "perfect negotiation" pattern.
//
// Every participant has one RTCPeerConnection per other participant. Local media is
// organised in four fixed slots so tracks can be swapped with replaceTrack() (no
// renegotiation) when cameras toggle or the movie source changes:
//
//   camVideo + micAudio      -> "camera" MediaStream (voice: echo-cancelled)
//   movieVideo + movieAudio  -> "movie" MediaStream (up to 4K / 20 Mbps, unfiltered stereo)

import { DEFAULT_PRESET, STREAM_PRESETS } from './media.js';

export const MOVIE_AUDIO_BITRATE = 510_000;
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
 * send stereo, so this is applied to both offers and answers.
 */
export function enableOpusStereo(sdp) {
  const match = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!match) return sdp;
  const pt = match[1];
  const fmtp = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  const extra = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: String(MOVIE_AUDIO_BITRATE), useinbandfec: '1' };
  if (!fmtp.test(sdp)) {
    const params = Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(';');
    return sdp.replace(match[0], `${match[0]}\r\na=fmtp:${pt} ${params}`);
  }
  return sdp.replace(fmtp, (_line, existing) => {
    const params = new Map(existing.split(';').filter(Boolean).map((p) => p.trim().split('=')));
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    return `a=fmtp:${pt} ${[...params].map(([k, v]) => `${k}=${v}`).join(';')}`;
  });
}

/**
 * Movie receivers get a deliberate playout buffer. WebRTC defaults to call-style minimal
 * latency, which turns any network jitter into visible stutter; a movie can afford ~0.4s.
 */
export const MOVIE_JITTER_BUFFER_MS = 400;

/** Lifts the browser's default (~2.5 Mbps) sender cap. Safe to call repeatedly. */
export async function applySenderParams(sender, slot, preset = STREAM_PRESETS[DEFAULT_PRESET]) {
  if (!sender?.track) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    const enc = params.encodings[0];
    if (slot === 'movieVideo') {
      // A captured 4K file is scaled down to the preset; screen capture is already sized.
      const height = sender.track.getSettings?.().height;
      enc.scaleResolutionDownBy = height && height > preset.height ? height / preset.height : 1;
      enc.maxBitrate = preset.bitrate;
      enc.maxFramerate = preset.fps;
      enc.priority = 'high';
      enc.networkPriority = 'high';
      params.degradationPreference = preset.degradation;
    } else if (slot === 'movieAudio') {
      enc.maxBitrate = MOVIE_AUDIO_BITRATE;
      enc.priority = 'high';
      enc.networkPriority = 'high';
    } else if (slot === 'camVideo') {
      enc.maxBitrate = CAMERA_VIDEO_BITRATE;
      enc.priority = 'low';
    } else if (slot === 'micAudio') {
      enc.maxBitrate = VOICE_AUDIO_BITRATE;
      enc.priority = 'high';
    }
    await sender.setParameters(params);
  } catch (err) {
    // Some browsers reject a subset of fields (e.g. degradationPreference). Retry with the essentials.
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) return;
      if (slot === 'movieVideo') params.encodings[0].maxBitrate = preset.bitrate;
      if (slot === 'movieAudio') params.encodings[0].maxBitrate = MOVIE_AUDIO_BITRATE;
      await sender.setParameters(params);
    } catch {
      console.warn('[rtc] setParameters failed', slot, err);
    }
  }
}

/**
 * Prefers H.264 for the movie track: nearly every GPU (NVIDIA, Intel, AMD, Apple) encodes
 * it in hardware, so 1080p–4K at 60fps doesn't saturate the CPU and drop frames. VP9 is
 * the fallback; its encoder is usually software-only.
 */
function preferMovieCodecs(transceiver) {
  if (!transceiver?.setCodecPreferences || !window.RTCRtpReceiver?.getCapabilities) return;
  const caps = RTCRtpReceiver.getCapabilities('video');
  if (!caps) return;
  const rank = (c) => {
    const mime = c.mimeType.toLowerCase();
    if (mime === 'video/h264') return 0;
    if (mime === 'video/vp9') return 1;
    if (mime === 'video/av1') return 2;
    if (mime === 'video/vp8') return 3;
    return 4; // rtx, red, ulpfec, flexfec keep their relative order at the end
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

    this.onSignal = ({ from, data }) => this.#handleSignal(from, data);
    socket.on('signal', this.onSignal);
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
    return peer;
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.pc.close();
    this.peers.delete(peerId);
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
          if (track) await applySenderParams(sender, slot, this.moviePreset);
        } else if (track) {
          this.#attach(peer, slot, track);
        }
      }),
    );
  }

  /** Changes bitrate / resolution / degradation for the outgoing movie on every connection. */
  setMoviePreset(preset) {
    this.moviePreset = preset;
    for (const peer of this.peers.values()) applySenderParams(peer.senders.movieVideo, 'movieVideo', preset);
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
        stats.forEach((s) => {
          if (s.type === 'outbound-rtp' && s.kind === 'video') result.outbound.push({ peerId: peer.id, ...pick(s, stats) });
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
    this.socket.off('signal', this.onSignal);
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }

  #attach(peer, slot, track) {
    const sender = peer.pc.addTrack(track, this.streams[SLOTS[slot].stream]);
    peer.senders[slot] = sender;
    if (slot === 'movieVideo') {
      preferMovieCodecs(peer.pc.getTransceivers().find((t) => t.sender === sender));
    }
    applySenderParams(sender, slot, this.moviePreset);
  }

  #applyAllParams(peer) {
    for (const [slot, sender] of Object.entries(peer.senders)) applySenderParams(sender, slot, this.moviePreset);
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

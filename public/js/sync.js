// Two-way playback sync.
//
// The server holds the authoritative state: { playing, time, serverTime }. Any participant
// can send PLAY / PAUSE / SEEK; the server rebroadcasts the resulting state to everyone and
// each "controller" (a client whose <video> is a real player rather than a live WebRTC
// stream) steers its element towards it.
//
// UI actions are sent as *intents* rather than derived from <video> DOM events, so applying
// remote state never echoes back to the server, which avoids the usual isRemoteEvent races.

const HARD_SEEK_THRESHOLD = 1.5; // seconds of drift before we jump
const SOFT_DRIFT_THRESHOLD = 0.25; // seconds of drift before we nudge playbackRate
const NUDGE = 0.05;
const COARSE_SEEK_THRESHOLD = 0.8; // players without fine playbackRate (YouTube) seek past this
const HARD_SEEK_COOLDOWN_MS = 4000;
const MAX_SEEK_LEAD = 6; // seconds
const END_MARGIN = 0.25; // seconds kept clear of the end by catch-up seeks

export class ClockSync {
  constructor(socket) {
    this.socket = socket;
    this.offset = 0; // serverTime - localTime
  }

  async calibrate(samples = 5) {
    let best = null;
    for (let i = 0; i < samples; i++) {
      const t0 = Date.now();
      const serverTime = await new Promise((resolve) => this.socket.timeout(2000).emit('time:ping', (err, ts) => resolve(err ? null : ts)));
      const t1 = Date.now();
      if (serverTime == null) continue;
      const rtt = t1 - t0;
      if (!best || rtt < best.rtt) best = { rtt, offset: serverTime - (t0 + rtt / 2) };
    }
    if (best) this.offset = best.offset;
    return this.offset;
  }

  now() {
    return Date.now() + this.offset;
  }
}

export class CinemaSync extends EventTarget {
  constructor({ socket, clock, video, selfId }) {
    super();
    this.socket = socket;
    this.clock = clock;
    this.video = video;
    this.selfId = selfId;
    this.state = null;
    this.blocked = false;
    this.heartbeatTimer = null;
    // How long a catch-up seek takes to become playable on this connection. Catch-up seeks
    // aim that far ahead, so a slow connection doesn't land behind again and seek forever.
    this.seekLead = 0;
    // performance.now() starts near 0 at page load, so 0 would count as "a seek just happened".
    this.lastHardSeek = -Infinity;
    this.driftTimer = setInterval(() => this.#correctDrift(), 1000);

    this.onState = ({ playback, actor, actorId, action }) => {
      const prev = this.state;
      this.state = playback;
      const sourceChanged = !prev || !sameSource(prev.source, playback.source);
      if (sourceChanged) {
        // Seek latency belongs to one source (a different host or file behaves differently).
        this.seekLead = 0;
        this.lastHardSeek = -Infinity;
      }
      this.dispatchEvent(new CustomEvent('state', { detail: { playback, prev, actor, actorId, action, sourceChanged } }));
      this.apply();
    };
    socket.on('sync:state', this.onState);

    this.onMeta = () => this.#reportDuration();
    this.onEnded = () => {
      if (this.isController && this.state?.playing) this.#send('PAUSE', this.video.duration);
    };
    this.video = null;
    this.setVideo(video);
  }

  /**
   * Switches the player being steered: an HTMLVideoElement, or anything exposing the same
   * subset (currentTime, duration, paused, seeking, readyState, play(), pause(), events),
   * such as the YouTube adapter.
   */
  setVideo(video) {
    if (this.video === video) return;
    this.video?.removeEventListener('loadedmetadata', this.onMeta);
    this.video?.removeEventListener('ended', this.onEnded);
    this.video = video;
    video.addEventListener('loadedmetadata', this.onMeta);
    video.addEventListener('ended', this.onEnded);
    this.apply();
  }

  setInitialState(playback) {
    // A live update may already have arrived; never overwrite it with the older snapshot.
    if (!this.state) this.onState({ playback, action: 'INIT' });
  }

  get source() {
    return this.state?.source ?? { type: 'none' };
  }

  get isOwner() {
    return this.source.ownerId === this.selfId;
  }

  /** True when this client's <video> is a real, seekable player that must follow room state. */
  get isController() {
    const { type } = this.source;
    return type === 'url' || type === 'youtube' || type === 'local' || (type === 'stream' && this.isOwner);
  }

  get controllable() {
    const { type } = this.source;
    return type === 'url' || type === 'youtube' || type === 'local' || type === 'stream';
  }

  /** Media time the room should be at right now. */
  expectedTime() {
    const s = this.state;
    if (!s) return 0;
    if (!s.playing) return s.time;
    const t = s.time + ((this.clock.now() - s.serverTime) / 1000) * (s.rate || 1);
    const d = s.source.duration;
    return d ? Math.min(t, d) : t;
  }

  /** What this viewer is actually seeing: the real player position when we have one. */
  localTime() {
    if (this.isController && this.#hasMedia() && !this.video.seeking) return this.video.currentTime;
    return this.expectedTime();
  }

  duration() {
    if (this.isController && Number.isFinite(this.video.duration)) return this.video.duration;
    return this.state?.source.duration ?? 0;
  }

  // ---- Intents from the local UI (any participant may call these) ----

  play() {
    this.#send('PLAY', this.localTime());
  }

  pause() {
    this.#send('PAUSE', this.localTime());
  }

  toggle() {
    if (this.state?.playing) this.pause();
    else this.play();
  }

  seek(time) {
    const d = this.duration();
    const target = Math.max(0, d ? Math.min(time, d) : time);
    this.#send('SEEK', target);
  }

  seekBy(delta) {
    this.seek(this.localTime() + delta);
  }

  /** Steers the local player towards room state. Called on every state change. */
  apply() {
    const s = this.state;
    if (!s || !this.isController || !this.#hasMedia()) return;
    const target = this.expectedTime();
    // Seeking a YouTube embed re-buffers, so tolerate a little more before jumping.
    const tolerance = this.video.supportsRateNudge === false ? 0.5 : SOFT_DRIFT_THRESHOLD;
    if (Math.abs(this.video.currentTime - target) > tolerance && !this.video.seeking) {
      this.video.currentTime = target;
    }
    this.video.playbackRate = 1;
    if (s.playing && this.video.paused) {
      this.video.play().then(
        () => this.#setBlocked(false),
        (err) => {
          if (err?.name === 'NotAllowedError') this.#setBlocked(true);
        },
      );
    } else if (!s.playing && !this.video.paused) {
      this.video.pause();
    }
    this.#updateHeartbeat();
  }

  /** Retry after the user taps the "start playback" overlay (autoplay policy). */
  unblock() {
    this.#setBlocked(false);
    this.apply();
    if (!this.isController && this.video.paused) this.video.play().catch(() => {});
  }

  destroy() {
    clearInterval(this.driftTimer);
    clearInterval(this.heartbeatTimer);
    this.socket.off('sync:state', this.onState);
    this.video?.removeEventListener('loadedmetadata', this.onMeta);
    this.video?.removeEventListener('ended', this.onEnded);
  }

  #send(action, time) {
    if (!this.controllable) return;
    this.socket.emit('sync:event', { action, time });
    // Optimistic local feedback; the authoritative echo follows within one RTT.
    if (this.state) {
      const playing = action === 'PLAY' ? true : action === 'PAUSE' ? false : this.state.playing;
      this.state = { ...this.state, playing, time, serverTime: this.clock.now() };
      this.dispatchEvent(new CustomEvent('state', { detail: { playback: this.state, action, actorId: this.selfId, optimistic: true } }));
      this.apply();
    }
  }

  #hasMedia() {
    return this.video.readyState >= 1;
  }

  #setBlocked(value) {
    if (this.blocked === value) return;
    this.blocked = value;
    this.dispatchEvent(new CustomEvent('blocked', { detail: { blocked: value } }));
  }

  #correctDrift() {
    const s = this.state;
    if (!s || !this.isController || !this.#hasMedia() || !s.playing) return;
    // The stream owner is the clock for 'stream' sources; they never chase themselves.
    if (s.source.type === 'stream') return;
    if (this.video.paused || this.video.seeking || this.video.readyState < 3) return;
    const drift = this.video.currentTime - this.expectedTime();
    const abs = Math.abs(drift);
    // YouTube only supports coarse rates, so it can't be nudged; it just seeks on big drift.
    if (abs > HARD_SEEK_THRESHOLD || (this.video.supportsRateNudge === false && abs > COARSE_SEEK_THRESHOLD)) {
      this.#catchUpSeek();
    } else if (abs > SOFT_DRIFT_THRESHOLD && this.video.supportsRateNudge !== false) {
      this.video.playbackRate = drift > 0 ? 1 - NUDGE : 1 + NUDGE;
    } else if (this.video.playbackRate !== 1) {
      this.video.playbackRate = 1;
    }
  }

  #catchUpSeek() {
    const started = performance.now();
    if (started - this.lastHardSeek < HARD_SEEK_COOLDOWN_MS) return;
    this.lastHardSeek = started;
    const video = this.video;
    video.playbackRate = 1;
    // Aim ahead by the measured seek latency, but never past the end: seeking beyond the
    // duration fires 'ended', which would pause the whole room before the film finishes.
    const end = Number.isFinite(video.duration) ? video.duration : Infinity;
    video.currentTime = Math.min(this.expectedTime() + this.seekLead, Math.max(0, end - END_MARGIN));
    const measure = () => {
      if (this.video !== video) return;
      if (video.seeking || video.readyState < 3) {
        if (performance.now() - started < 15000) setTimeout(measure, 100);
        return;
      }
      this.seekLead = Math.min(MAX_SEEK_LEAD, (performance.now() - started) / 1000);
    };
    setTimeout(measure, 100);
  }

  #reportDuration() {
    if (!this.isController) return;
    const d = this.video.duration;
    if (Number.isFinite(d) && d > 0 && !this.state?.source.duration) {
      this.socket.emit('sync:heartbeat', { duration: d });
    }
    this.apply();
  }

  /** In 'stream' mode the owner's real player is the source of truth for position. */
  #updateHeartbeat() {
    const shouldBeat = this.source.type === 'stream' && this.isOwner;
    if (shouldBeat && !this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        if (!this.#hasMedia() || this.video.seeking) return;
        this.socket.emit('sync:heartbeat', {
          time: this.video.currentTime,
          playing: !this.video.paused,
          duration: this.video.duration,
        });
      }, 2000);
    } else if (!shouldBeat && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

function sameSource(a, b) {
  // Ids are unique per start, so re-sharing the same screen or file counts as a change.
  return a.id === b.id && a.type === b.type;
}

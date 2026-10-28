// Spatial voices: each friend's voice is panned toward where their camera tile sits on the
// screen (tile on the left, voice from the left), like people seated around you.
//
// Voices are routed MediaStreamSource → StereoPanner → Gain → speakers while enabled, and the
// tile's <video> is muted so the voice isn't heard twice. It is opt-in: audio played through
// Web Audio can bypass echo cancellation in some browsers, so it's meant for headphones.

const MAX_PAN = 0.8; // never fully one-sided
const UPDATE_MS = 150;
const SMOOTHING_S = 0.12;

/** Pure: pan (-MAX_PAN..MAX_PAN) for a tile whose centre is at x within a viewport of width w. */
export function panFor(centerX, viewportWidth) {
  if (!(viewportWidth > 0)) return 0;
  const p = (centerX / viewportWidth) * 2 - 1;
  return Math.max(-MAX_PAN, Math.min(MAX_PAN, p * MAX_PAN));
}

export class SpatialVoices {
  /** `getContext()` returns the page's AudioContext (created on a user gesture). */
  constructor({ getContext }) {
    this.getContext = getContext;
    this.enabled = false;
    this.volume = 1;
    this.voices = new Map(); // key -> { track, tile, nodes }
    this.timer = null;
  }

  /** Registers a friend's voice track and their tile element. Safe to call repeatedly. */
  attach(key, track, tileEl) {
    const existing = this.voices.get(key);
    if (existing?.track === track && existing.tile === tileEl) return;
    this.detach(key);
    const voice = { track, tile: tileEl, nodes: null };
    this.voices.set(key, voice);
    if (this.enabled) this.#connect(voice);
  }

  detach(key) {
    const voice = this.voices.get(key);
    if (!voice) return;
    this.#disconnect(voice);
    this.voices.delete(key);
  }

  setEnabled(enabled) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    for (const voice of this.voices.values()) (enabled ? this.#connect(voice) : this.#disconnect(voice));
    clearInterval(this.timer);
    this.timer = enabled ? setInterval(() => this.#updatePositions(), UPDATE_MS) : null;
    if (enabled) this.#updatePositions(true);
  }

  setVolume(volume) {
    this.volume = volume;
    for (const voice of this.voices.values()) if (voice.nodes) voice.nodes.gain.gain.value = volume;
  }

  /** Current pan per voice (for the stats panel). */
  pans() {
    return [...this.voices.entries()].map(([key, v]) => [key, v.nodes ? v.nodes.panner.pan.value : null]);
  }

  #connect(voice) {
    const ctx = this.getContext();
    if (!ctx || voice.nodes || voice.track.readyState === 'ended') return;
    try {
      const source = ctx.createMediaStreamSource(new MediaStream([voice.track]));
      const panner = ctx.createStereoPanner();
      const gain = ctx.createGain();
      gain.gain.value = this.volume;
      source.connect(panner).connect(gain).connect(ctx.destination);
      voice.nodes = { source, panner, gain };
      this.#place(voice, true);
    } catch (err) {
      console.warn('[spatial] cannot route voice', err);
    }
  }

  #disconnect(voice) {
    if (!voice.nodes) return;
    voice.nodes.source.disconnect();
    voice.nodes.gain.disconnect();
    voice.nodes = null;
  }

  #place(voice, immediate = false) {
    if (!voice.nodes) return;
    const r = voice.tile.getBoundingClientRect();
    const pan = panFor(r.left + r.width / 2, window.innerWidth);
    const param = voice.nodes.panner.pan;
    if (immediate) param.value = pan;
    else param.setTargetAtTime(pan, voice.nodes.panner.context.currentTime, SMOOTHING_S); // glide as tiles move
  }

  #updatePositions(immediate = false) {
    for (const voice of this.voices.values()) this.#place(voice, immediate);
  }

  destroy() {
    this.setEnabled(false);
    this.voices.clear();
  }
}

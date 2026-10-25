// Freely floating, draggable webcam tiles.
//
// Positions use GPU-composited transform: translate3d() and are clamped to the viewport.
// Each viewer arranges tiles for themselves; layouts are remembered per name.

import { clamp, h, hueFor, icon, initials, storage } from './util.js';

const SIZES = ['s', 'm', 'l'];
const LAYOUT_KEY = 'cinema.camLayout';
const MARGIN = 16;

export class DraggableCamera {
  constructor(element, { onMove } = {}) {
    this.element = element;
    this.onMove = onMove;
    this.x = 0;
    this.y = 0;
    this.dragging = false;
    this.pointerId = null;
    this.start = { x: 0, y: 0 };
    this.moved = false;

    element.addEventListener('pointerdown', (e) => this.#down(e));
    element.addEventListener('pointermove', (e) => this.#move(e));
    element.addEventListener('pointerup', (e) => this.#up(e));
    element.addEventListener('pointercancel', (e) => this.#up(e));
  }

  moveTo(x, y) {
    const maxX = window.innerWidth - this.element.offsetWidth;
    const maxY = window.innerHeight - this.element.offsetHeight;
    this.x = clamp(x, 0, Math.max(0, maxX));
    this.y = clamp(y, 0, Math.max(0, maxY));
    this.element.style.transform = `translate3d(${this.x}px, ${this.y}px, 0)`;
  }

  /** Re-clamp after resize/size change. */
  clamp() {
    this.moveTo(this.x, this.y);
  }

  #down(e) {
    if (e.button !== 0 || e.target.closest('button')) return;
    this.dragging = true;
    this.moved = false;
    this.pointerId = e.pointerId;
    this.start = { x: e.clientX - this.x, y: e.clientY - this.y };
    this.element.setPointerCapture(e.pointerId);
    this.element.classList.add('is-dragging');
  }

  #move(e) {
    if (!this.dragging || e.pointerId !== this.pointerId) return;
    this.moved = true;
    this.moveTo(e.clientX - this.start.x, e.clientY - this.start.y);
  }

  #up(e) {
    if (!this.dragging || e.pointerId !== this.pointerId) return;
    this.dragging = false;
    this.element.classList.remove('is-dragging');
    if (this.moved) this.onMove?.(this.x, this.y);
  }
}

export class CameraDeck {
  constructor(root) {
    this.root = root;
    this.tiles = new Map(); // key -> tile
    this.layout = storage.get(LAYOUT_KEY, {});
    this.voiceVolume = 1;
    window.addEventListener('resize', () => {
      for (const tile of this.tiles.values()) tile.drag.clamp();
    });
  }

  /** Adds or returns the tile for a participant. */
  ensure(key, { name, isSelf = false }) {
    let tile = this.tiles.get(key);
    if (tile) {
      tile.setName(name);
      return tile;
    }
    const saved = this.layout[this.#layoutKey(name, isSelf)];
    tile = this.#createTile(key, name, isSelf, saved);
    this.tiles.set(key, tile);
    this.root.append(tile.el);
    this.#placeInitially(tile, saved);
    return tile;
  }

  remove(key) {
    const tile = this.tiles.get(key);
    if (!tile) return;
    tile.el.remove();
    this.tiles.delete(key);
  }

  get(key) {
    return this.tiles.get(key);
  }

  setVoiceVolume(volume) {
    this.voiceVolume = volume;
    for (const tile of this.tiles.values()) {
      if (!tile.isSelf) tile.video.volume = volume;
    }
  }

  #createTile(key, name, isSelf, saved) {
    const video = h('video', { autoplay: true, playsinline: true });
    video.muted = isSelf; // never play your own voice back
    if (isSelf) video.classList.add('mirrored');
    else video.volume = this.voiceVolume;

    const avatar = h('div', { class: 'cam-avatar' });
    const label = h('span', { class: 'cam-name' });
    const micIcon = h('span', { class: 'cam-mic-off', title: 'Muted' }, [icon('mic-off')]);
    const sizeButtons = SIZES.map((size) =>
      h('button', { class: 'cam-tool', 'data-size': size, title: { s: 'Small', m: 'Medium', l: 'Large' }[size], text: size.toUpperCase() }),
    );
    const minimize = h('button', { class: 'cam-tool', 'data-size': 'min', title: 'Minimize to badge' }, [icon('minus')]);
    const tools = h('div', { class: 'cam-tools' }, [...sizeButtons, minimize]);
    const el = h('div', { class: 'cam-tile size-m cam-off', dataset: { key } }, [
      video,
      avatar,
      h('div', { class: 'cam-label' }, [label, micIcon]),
      tools,
    ]);

    const tile = {
      key,
      el,
      video,
      isSelf,
      name,
      size: saved?.size ?? 'm',
      drag: null,
      setName: (n) => {
        tile.name = n;
        label.textContent = isSelf ? `${n} (you)` : n;
        avatar.textContent = initials(n);
        el.style.setProperty('--hue', hueFor(n));
      },
      setStream: (stream) => {
        if (video.srcObject !== stream) video.srcObject = stream;
        if (stream) video.play().catch(() => {});
      },
      setStatus: ({ camera, mic }) => {
        el.classList.toggle('cam-off', !camera);
        el.classList.toggle('mic-off', !mic);
      },
      setSpeaking: (speaking) => el.classList.toggle('speaking', speaking),
      setSize: (size, { persist = true } = {}) => {
        tile.size = size;
        el.classList.remove('size-s', 'size-m', 'size-l', 'size-min');
        el.classList.add(`size-${size}`);
        for (const b of tools.querySelectorAll('[data-size]')) b.classList.toggle('active', b.dataset.size === size);
        requestAnimationFrame(() => tile.drag.clamp());
        if (persist) this.#save(tile);
      },
    };

    tile.drag = new DraggableCamera(el, { onMove: () => this.#save(tile) });
    tools.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-size]');
      if (btn) tile.setSize(btn.dataset.size);
    });
    // Double-click a tile (or tap the badge) to cycle size / restore from badge.
    el.addEventListener('dblclick', () => tile.setSize(tile.size === 'min' ? 'm' : SIZES[(SIZES.indexOf(tile.size) + 1) % 3]));
    el.addEventListener('click', () => {
      if (tile.size === 'min' && !tile.drag.moved) tile.setSize('m');
    });

    tile.setName(name);
    tile.setSize(tile.size, { persist: false });
    return tile;
  }

  #placeInitially(tile, saved) {
    requestAnimationFrame(() => {
      if (saved && Number.isFinite(saved.xr) && Number.isFinite(saved.yr)) {
        tile.drag.moveTo(saved.xr * window.innerWidth, saved.yr * window.innerHeight);
        return;
      }
      // Stack new tiles up the right edge, above the HUD.
      const index = [...this.tiles.values()].indexOf(tile);
      const w = tile.el.offsetWidth;
      const hgt = tile.el.offsetHeight;
      tile.drag.moveTo(window.innerWidth - w - MARGIN, window.innerHeight - 120 - (hgt + 12) * (index + 1));
    });
  }

  #layoutKey(name, isSelf) {
    return isSelf ? '__self__' : `peer:${name}`;
  }

  #save(tile) {
    if (!tile.drag) return;
    // Store relative position so layouts survive window size changes.
    this.layout[this.#layoutKey(tile.name, tile.isSelf)] = {
      xr: tile.drag.x / Math.max(1, window.innerWidth),
      yr: tile.drag.y / Math.max(1, window.innerHeight),
      size: tile.size,
    };
    storage.set(LAYOUT_KEY, this.layout);
  }
}

/** Polls audio levels for speaking rings and the mic meter. One shared AudioContext. */
export class SpeakingDetector {
  constructor() {
    this.ctx = null;
    this.sources = new Map(); // key -> { analyser, data, onLevel, source }
    this.timer = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      this.ctx = new Ctx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  watch(key, track, onLevel) {
    this.unwatch(key);
    const ctx = this.ensureContext();
    if (!ctx || !track) return;
    try {
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      this.sources.set(key, { source, analyser, data: new Uint8Array(analyser.fftSize), onLevel, track });
    } catch (err) {
      console.warn('[audio] cannot analyse track', err);
    }
    this.timer ??= setInterval(() => this.#tick(), 100);
  }

  unwatch(key) {
    const entry = this.sources.get(key);
    if (!entry) return;
    entry.source.disconnect();
    entry.onLevel(0);
    this.sources.delete(key);
  }

  #tick() {
    for (const entry of this.sources.values()) {
      if (entry.track.readyState === 'ended' || !entry.track.enabled) {
        entry.onLevel(0);
        continue;
      }
      entry.analyser.getByteTimeDomainData(entry.data);
      let sum = 0;
      for (const v of entry.data) {
        const x = (v - 128) / 128;
        sum += x * x;
      }
      entry.onLevel(Math.min(1, Math.sqrt(sum / entry.data.length) * 4));
    }
  }
}

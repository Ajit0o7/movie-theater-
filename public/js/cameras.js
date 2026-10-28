// Freely floating, draggable webcam tiles with a layout shared by the whole room.
//
// Whoever drags or resizes a tile moves it for everyone: local changes are reported through
// `deck.onLayout`, remote ones arrive via `tile.applyLayout`. A position is stored as
// fractions (0..1) of the free space (viewport minus the tile), so a tile left at the
// bottom-right stays at the bottom-right on every screen, whatever its size.
//
// Pixels are applied with GPU-composited transform: translate3d().

import { clamp, h, hueFor, icon, initials } from './util.js';

const SIZES = ['s', 'm', 'l'];
const ALL_SIZES = ['s', 'm', 'l', 'min'];
const DRAG_SEND_INTERVAL_MS = 40; // live movement is shared ~25×/s
const REMOTE_MOVE_MS = 200;

export const DEFAULT_LAYOUT = { fx: 1, fy: 0.84, size: 'm' };

const TOP_SAFE = 56; // clear of the top bar (brand, invite chip, people)

/**
 * Tiles live inside a safe area, so nobody (the shared layout lets anyone place anyone's
 * tile) can park one underneath the control bar where it could never be grabbed again.
 * The bottom inset is measured, because the bar is taller on phones.
 */
function insets() {
  const hud = document.getElementById('hud');
  const bottom = hud ? hud.offsetHeight - parseFloat(getComputedStyle(hud).paddingTop) + 8 : 90;
  return { top: TOP_SAFE, bottom };
}

export class DraggableCamera {
  /** `getLayout()` returns the fractions; `onDrag(fx, fy, final)` reports a drag. */
  constructor(element, { onDrag } = {}) {
    this.element = element;
    this.onDrag = onDrag;
    this.dragging = false;
    this.pointerId = null;
    this.start = { x: 0, y: 0 };
    this.moved = false;
    this.fx = 1;
    this.fy = 0.84;
    this.sendTimer = null;

    element.addEventListener('pointerdown', (e) => this.#down(e));
    element.addEventListener('pointermove', (e) => this.#move(e));
    element.addEventListener('pointerup', (e) => this.#up(e));
    element.addEventListener('pointercancel', (e) => this.#up(e));
  }

  /** The room the tile can move in: `top`/`left` origin and the free span left after its size. */
  #free() {
    const { top, bottom } = insets();
    return {
      top,
      w: Math.max(0, window.innerWidth - this.element.offsetWidth),
      h: Math.max(0, window.innerHeight - top - bottom - this.element.offsetHeight),
    };
  }

  /** Positions the tile from fractions of free space. */
  place(fx, fy) {
    this.fx = clamp(fx, 0, 1);
    this.fy = clamp(fy, 0, 1);
    const free = this.#free();
    this.x = this.fx * free.w;
    this.y = free.top + this.fy * free.h;
    this.element.style.transform = `translate3d(${this.x}px, ${this.y}px, 0)`;
  }

  /** Positions the tile from pixels (inside the safe area) and records the matching fractions. */
  placePx(x, y) {
    const free = this.#free();
    const cx = clamp(x, 0, free.w);
    const cy = clamp(y - free.top, 0, free.h);
    this.place(free.w ? cx / free.w : 0, free.h ? cy / free.h : 0);
  }

  /** Re-apply after a window resize or a size change (the tile's width changed). */
  reflow() {
    this.autoPlace ? this.autoPlace() : this.place(this.fx, this.fy);
  }

  #down(e) {
    if (e.button !== 0 || e.target.closest('button')) return;
    this.dragging = true;
    this.moved = false;
    this.pointerId = e.pointerId;
    this.start = { x: e.clientX - this.x, y: e.clientY - this.y };
    this.element.setPointerCapture(e.pointerId);
    this.element.classList.add('is-dragging');
    this.element.classList.remove('remote-move');
  }

  #move(e) {
    if (!this.dragging || e.pointerId !== this.pointerId) return;
    this.moved = true;
    const free = this.#free();
    const x = clamp(e.clientX - this.start.x, 0, free.w);
    const y = clamp(e.clientY - this.start.y - free.top, 0, free.h);
    this.place(free.w ? x / free.w : 0, free.h ? y / free.h : 0);
    // Throttled live updates, so everyone watches the tile move rather than jump.
    this.sendTimer ??= setTimeout(() => {
      this.sendTimer = null;
      if (this.dragging) this.onDrag?.(this.fx, this.fy, false);
    }, DRAG_SEND_INTERVAL_MS);
  }

  #up(e) {
    if (!this.dragging || e.pointerId !== this.pointerId) return;
    this.dragging = false;
    clearTimeout(this.sendTimer);
    this.sendTimer = null;
    this.element.classList.remove('is-dragging');
    if (this.moved) this.onDrag?.(this.fx, this.fy, true);
  }
}

const STACK_GAP = 12;
const STACK_MARGIN = 16;

/** Stacks an untouched tile up the right edge by slot, wrapping into columns on short screens. */
function stackAuto(tile) {
  const { top, bottom } = insets();
  const w = tile.el.offsetWidth;
  const hgt = tile.el.offsetHeight;
  const usable = window.innerHeight - top - bottom;
  const perColumn = Math.max(1, Math.floor((usable + STACK_GAP) / (hgt + STACK_GAP)));
  const slot = tile.slot ?? 0;
  const col = Math.floor(slot / perColumn);
  const row = slot % perColumn;
  tile.drag.placePx(
    window.innerWidth - w - STACK_MARGIN - col * (w + STACK_GAP),
    window.innerHeight - bottom - (row + 1) * hgt - row * STACK_GAP,
  );
  tile.layout = { ...tile.layout, fx: tile.drag.fx, fy: tile.drag.fy };
}

export class CameraDeck {
  constructor(root) {
    this.root = root;
    this.tiles = new Map(); // key -> tile
    this.voiceVolume = 1;
    this.externalVoices = false; // true while spatial voices play them through Web Audio
    /** Set by the page: called with (key, { fx, fy, size }) when the local user changes a tile. */
    this.onLayout = null;
    window.addEventListener('resize', () => {
      for (const tile of this.tiles.values()) tile.drag.reflow();
    });
  }

  /** Adds or returns the tile for a participant. `cam` is the room's current layout for it. */
  ensure(key, { name, isSelf = false, cam = null }) {
    let tile = this.tiles.get(key);
    if (tile) {
      tile.setName(name);
      return tile;
    }
    tile = this.#createTile(key, name, isSelf);
    this.tiles.set(key, tile);
    this.root.append(tile.el);
    tile.applyLayout(cam ?? DEFAULT_LAYOUT);
    // Fonts/CSS may still settle: re-apply once laid out so the pixel position is exact.
    requestAnimationFrame(() => tile.drag.reflow());
    return tile;
  }

  remove(key) {
    const tile = this.tiles.get(key);
    if (!tile) return;
    clearTimeout(tile.moveTimer);
    tile.el.remove();
    this.tiles.delete(key);
  }

  get(key) {
    return this.tiles.get(key);
  }

  /** Tells the room where a tile currently is (used after a reconnect). */
  announce(key) {
    const tile = this.tiles.get(key);
    if (tile) this.onLayout?.(key, { ...tile.layout });
  }

  setVoiceVolume(volume) {
    this.voiceVolume = volume;
    this.#applyVoiceOutput();
  }

  /** When voices play through Web Audio (spatial voices), tiles must stay silent. */
  setExternalVoices(external) {
    this.externalVoices = external;
    this.#applyVoiceOutput();
  }

  #applyVoiceOutput() {
    for (const tile of this.tiles.values()) {
      if (tile.isSelf) continue;
      tile.video.volume = this.voiceVolume;
      tile.video.muted = Boolean(this.externalVoices) || this.voiceVolume === 0; // muted also works on iOS
    }
  }

  #createTile(key, name, isSelf) {
    const video = h('video', { autoplay: true, playsinline: true });
    video.muted = isSelf; // never play your own voice back
    if (isSelf) video.classList.add('mirrored');
    else {
      video.volume = this.voiceVolume;
      video.muted = Boolean(this.externalVoices) || this.voiceVolume === 0;
    }

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
      layout: { ...DEFAULT_LAYOUT },
      drag: null,
      moveTimer: null,
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

      /** Applies a layout: from the room (`remote`) or from a local change that is then shared. */
      applyLayout: (next, { remote = false } = {}) => {
        if (tile.drag.dragging) return; // never fight the user's own drag
        const size = ALL_SIZES.includes(next.size) ? next.size : tile.layout.size;
        tile.layout = { fx: clamp(Number(next.fx) || 0, 0, 1), fy: clamp(Number(next.fy) || 0, 0, 1), size };
        // Untouched tiles are stacked by this screen from its own tile size (no overlap),
        // until someone moves or resizes one and a real position takes over.
        tile.slot = next.auto ? Number(next.slot) || 0 : null;
        tile.drag.autoPlace = next.auto ? () => stackAuto(tile) : null;
        if (remote) {
          // Glide to the new spot instead of teleporting.
          el.classList.add('remote-move');
          clearTimeout(tile.moveTimer);
          tile.moveTimer = setTimeout(() => el.classList.remove('remote-move'), REMOTE_MOVE_MS + 50);
        }
        el.classList.remove('size-s', 'size-m', 'size-l', 'size-min');
        el.classList.add(`size-${size}`);
        for (const b of tools.querySelectorAll('[data-size]')) b.classList.toggle('active', b.dataset.size === size);
        if (tile.drag.autoPlace) tile.drag.autoPlace();
        else tile.drag.place(tile.layout.fx, tile.layout.fy);
        // The width changes with the size class (animated), so settle the position afterwards.
        requestAnimationFrame(() => tile.drag.reflow());
        setTimeout(() => tile.drag.reflow(), 260);
      },

      /** A local size change: apply it, then share it with the room. */
      setSize: (size) => {
        // An auto tile becomes a real, shared position at its current spot.
        tile.applyLayout({ ...tile.layout, fx: tile.drag.fx, fy: tile.drag.fy, size });
        this.onLayout?.(key, { ...tile.layout });
      },
    };

    tile.drag = new DraggableCamera(el, {
      onDrag: (fx, fy, final) => {
        tile.slot = null;
        tile.drag.autoPlace = null;
        tile.layout = { ...tile.layout, fx, fy };
        this.onLayout?.(key, { ...tile.layout, final });
      },
    });
    tools.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-size]');
      if (btn) tile.setSize(btn.dataset.size);
    });
    // Double-click a tile (or tap the badge) to cycle size / restore from badge.
    el.addEventListener('dblclick', () => tile.setSize(tile.layout.size === 'min' ? 'm' : SIZES[(SIZES.indexOf(tile.layout.size) + 1) % 3]));
    el.addEventListener('click', (e) => {
      // Only a tap on the badge itself restores it; a click on the size buttons has already
      // been handled (before, choosing "minimize" was immediately undone by this handler).
      if (e.target.closest('.cam-tools')) return;
      if (tile.layout.size === 'min' && !tile.drag.moved) tile.setSize('m');
    });

    tile.setName(name);
    return tile;
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

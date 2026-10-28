// Danmaku (floating chat): new messages glide right-to-left across the top of the movie, in
// lanes, like Niconico / Bilibili. Optional and per viewer.
//
// Everything moves at the same speed, so messages never overtake each other: a lane can take
// the next message as soon as the previous one's tail has entered the screen. Animations run on
// the compositor (Web Animations API), so a busy chat costs no per-frame JavaScript.

import { h, hueFor } from './util.js';

const GAP = 48; // px between two messages in a lane
const MAX_CHARS = 90;
const MAX_QUEUE = 24;

/** Pure: font size (px) and lane height for a viewport width. */
export function danmakuMetrics(viewW) {
  const size = Math.round(Math.max(15, Math.min(22, viewW * 0.016)));
  return { size, laneH: Math.round(size * 1.25 + 12) };
}

/** Pure: how many lanes fit between `top` and 40% down the screen (at least 2, at most 8). */
export function laneCount(viewH, top, laneH) {
  return Math.max(2, Math.min(8, Math.floor((viewH * 0.4 - top) / laneH)));
}

/** Pure: speed in px/s; a message crosses any screen in about 7 s. */
export const speedFor = (viewW) => Math.max(140, viewW / 7);

/** Pure: the first lane free at `now`, or -1 when every lane is still busy. */
export function pickLane(freeAt, now) {
  for (let i = 0; i < freeAt.length; i++) if ((freeAt[i] ?? 0) <= now) return i;
  return -1;
}

export function shorten(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > MAX_CHARS ? `${clean.slice(0, MAX_CHARS - 1)}…` : clean;
}

export class Danmaku {
  /** `getTop()` returns where the first lane starts (just below the top bar), in px. */
  constructor(layer, { getTop }) {
    this.layer = layer;
    this.getTop = getTop;
    this.enabled = false;
    this.freeAt = [];
    this.queue = [];
    this.retry = null;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.layer.hidden = !enabled;
    if (!enabled) this.clear();
  }

  clear() {
    clearTimeout(this.retry);
    this.retry = null;
    this.queue = [];
    this.freeAt = [];
    this.layer.replaceChildren();
  }

  /** @param {{ name: string, text: string, mine?: boolean }} message */
  add(message) {
    if (!this.enabled || document.hidden) return; // the chat log has it; don't flood on return
    this.queue.push(message);
    if (this.queue.length > MAX_QUEUE) this.queue.shift();
    this.#flush();
  }

  #flush() {
    clearTimeout(this.retry);
    this.retry = null;
    const viewW = window.innerWidth;
    const { size, laneH } = danmakuMetrics(viewW);
    const top = this.getTop();
    const lanes = laneCount(window.innerHeight, top, laneH);
    this.freeAt.length = lanes;
    const speed = speedFor(viewW);
    while (this.queue.length) {
      const now = performance.now();
      const lane = pickLane(this.freeAt, now);
      if (lane < 0) {
        const wait = Math.min(...this.freeAt) - now;
        this.retry = setTimeout(() => this.#flush(), Math.max(16, wait));
        return;
      }
      const { name, text, mine } = this.queue.shift();
      const item = h('div', { class: `danmaku-item${mine ? ' mine' : ''}`, style: `--hue:${hueFor(name)};font-size:${size}px;top:${top + lane * laneH}px;transform:translateX(${viewW}px)` }, [
        h('b', { text: mine ? 'You' : name }),
        h('span', { text: shorten(text) }),
      ]);
      this.layer.append(item);
      const width = item.offsetWidth;
      const duration = ((viewW + width) / speed) * 1000;
      this.freeAt[lane] = now + ((width + GAP) / speed) * 1000;
      const anim = item.animate(
        [{ transform: `translateX(${viewW}px)` }, { transform: `translateX(${-width}px)` }],
        { duration, easing: 'linear' },
      );
      anim.onfinish = () => item.remove();
      anim.oncancel = () => item.remove();
    }
  }
}

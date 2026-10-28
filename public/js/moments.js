// Timeline moments: reactions are stamped with the movie time (server-side), grouped into
// buckets along the timeline, and drawn as a heat strip. The busiest spots get their top
// emoji as a clickable marker that jumps there.

import { formatTime, h } from './util.js';

const BUCKETS = 120;
const MAX_BADGES = 6;
const MIN_BADGE_COUNT = 2;

/** Pure: groups moments into buckets. Returns [{ index, start, count, top, emojis }]. */
export function bucketMoments(moments, duration, buckets = BUCKETS) {
  if (!(duration > 0)) return [];
  const width = duration / buckets;
  const map = new Map();
  for (const { t, emoji } of moments) {
    if (!(t >= 0) || t > duration) continue;
    const index = Math.min(buckets - 1, Math.floor(t / width));
    let b = map.get(index);
    if (!b) map.set(index, (b = { index, start: index * width, sum: 0, count: 0, emojis: {} }));
    b.count++;
    b.sum += t;
    b.emojis[emoji] = (b.emojis[emoji] ?? 0) + 1;
  }
  return [...map.values()]
    .map((b) => ({
      index: b.index,
      start: b.start,
      at: b.sum / b.count, // the average reaction time: where the moment actually is
      count: b.count,
      top: Object.entries(b.emojis).sort((x, y) => y[1] - x[1])[0][0],
      emojis: b.emojis,
    }))
    .sort((a, b) => a.index - b.index);
}

/** Pure: the buckets that earn a visible emoji badge (the busiest few). */
export function pickBadges(buckets, max = MAX_BADGES, min = MIN_BADGE_COUNT) {
  return [...buckets]
    .filter((b) => b.count >= min)
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .slice(0, max);
}

export class TimelineMoments {
  constructor(container, { onSeek }) {
    this.container = container;
    this.onSeek = onSeek;
    this.moments = [];
    this.duration = 0;
    this.version = 0; // bumped on every change, so a same-sized replacement still redraws
    this.key = '';
    container.addEventListener('click', (e) => {
      const badge = e.target.closest('[data-at]');
      if (badge) this.onSeek(Number(badge.dataset.at));
    });
  }

  set(moments) {
    this.moments = Array.isArray(moments) ? moments.slice() : [];
    this.version++;
    this.render();
  }

  add(t, emoji) {
    if (typeof t !== 'number') return;
    this.moments.push({ t, emoji });
    this.version++;
    this.render();
  }

  clear() {
    this.set([]);
  }

  setDuration(duration) {
    if (Math.abs((duration || 0) - this.duration) < 0.5) return;
    this.duration = duration || 0;
    this.render();
  }

  render() {
    const buckets = bucketMoments(this.moments, this.duration);
    const key = `${this.duration}|${this.version}`;
    if (key === this.key) return;
    this.key = key;
    const peak = buckets.reduce((m, b) => Math.max(m, b.count), 1);
    const badges = new Set(pickBadges(buckets).map((b) => b.index));
    const pct = (t) => `${(t / this.duration) * 100}%`;
    this.container.replaceChildren(
      ...buckets.map((b) =>
        h('span', { class: 'moment-dot', style: `left:${pct(b.at)};--heat:${(b.count / peak).toFixed(2)}` }),
      ),
      ...buckets
        .filter((b) => badges.has(b.index))
        .map((b) =>
          h('button', {
            type: 'button',
            class: 'moment-badge',
            style: `left:${pct(b.at)}`,
            'data-at': String(Math.max(0, b.at - 3)), // land just before the moment
            title: `${Object.entries(b.emojis).map(([e, n]) => `${e}×${n}`).join(' ')} at ${formatTime(b.at)}. Click to jump there`,
            text: b.top,
          }),
        ),
    );
  }
}

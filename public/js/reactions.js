// Live floating cinema reactions. Each emoji gets randomised physics (rise height,
// sideways drift, wobble, spin, scale) passed to a CSS animation as custom properties,
// so the motion runs on the compositor.

import { $, h } from './util.js';

export const REACTIONS = ['🍿', '❤️', '😂', '👏', '😱', '🔥', '😭', '👀'];
const MAX_ON_SCREEN = 60;

const rand = (min, max) => min + Math.random() * (max - min);

export class Reactions {
  constructor({ socket }) {
    this.socket = socket;
    this.layer = $('#reactions-layer');
    this.tray = $('#reaction-tray');
    this.lastSent = 0;

    this.tray.replaceChildren(
      ...REACTIONS.map((emoji, i) =>
        h('button', { class: 'reaction-btn', 'data-emoji': emoji, title: `${emoji} (${i + 1})`, text: emoji }),
      ),
    );
    // Removed in destroy(): a new Reactions is built on every (re)connect.
    this.onTrayClick = (e) => {
      const btn = e.target.closest('[data-emoji]');
      if (btn) this.send(btn.dataset.emoji);
    };
    this.tray.addEventListener('click', this.onTrayClick);

    this.onReaction = ({ emoji, name }) => this.spawn(emoji, name);
    socket.on('reaction', this.onReaction);
  }

  send(emoji) {
    const now = performance.now();
    if (now - this.lastSent < 120) return; // light client-side rate limit
    this.lastSent = now;
    this.socket.emit('reaction', { emoji });
  }

  sendByIndex(index) {
    if (REACTIONS[index]) this.send(REACTIONS[index]);
  }

  spawn(emoji, name) {
    if (this.layer.childElementCount > MAX_ON_SCREEN) this.layer.firstElementChild.remove();
    const node = h('div', { class: 'floater' }, [
      h('span', { class: 'floater-emoji', text: emoji }),
      name ? h('span', { class: 'floater-name', text: name }) : null,
    ]);
    const vars = {
      '--x': `${rand(8, 88)}vw`,
      '--rise': `${rand(55, 85)}vh`,
      '--drift': `${rand(-12, 12)}vw`,
      '--wobble': `${rand(1.5, 4)}vw`,
      '--spin': `${rand(-35, 35)}deg`,
      '--scale': rand(0.9, 1.5).toFixed(2),
      '--dur': `${rand(3.2, 4.8).toFixed(2)}s`,
    };
    for (const [k, v] of Object.entries(vars)) node.style.setProperty(k, v);
    node.addEventListener('animationend', (e) => {
      if (e.target === node) node.remove();
    });
    this.layer.append(node);
  }

  toggleTray(force) {
    const open = force ?? this.tray.hidden;
    this.tray.hidden = !open;
    return open;
  }

  destroy() {
    this.socket.off('reaction', this.onReaction);
    this.tray.removeEventListener('click', this.onTrayClick);
  }
}

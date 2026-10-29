// Pop-out: the movie, everyone's webcams and compact controls in an always-on-top window
// (Document Picture-in-Picture, Chrome/Edge 116+), so you can keep watching together while
// using other apps.
//
// The real <video> element moves into the window (it keeps playing, and room sync keeps
// steering it) and moves back when the window closes. Browsers without Document PiP get the
// browser's own picture-in-picture: the movie alone.

import { formatTime } from './util.js';

const BAR_H = 46;
const CAMS_H = 64;

export const canDocumentPip = () => 'documentPictureInPicture' in window;
export const canPopOut = () => canDocumentPip() || Boolean(document.pictureInPictureEnabled);

/** Pure: the pop-out's starting size: a 16:9 picture about 480px wide, plus its bars. */
export function popOutSize(hasCams, screenW = 1920) {
  const width = Math.round(Math.max(360, Math.min(560, screenW * 0.28)));
  return { width, height: Math.round((width * 9) / 16) + BAR_H + (hasCams ? CAMS_H : 0) };
}

const CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #000; color: #FAF2EC; overflow: hidden;
    font: 500 13px/1.2 Inter, system-ui, -apple-system, "Segoe UI", sans-serif; user-select: none; }
  .pip { display: flex; flex-direction: column; height: 100%; }
  .pip-stage { position: relative; flex: 1; min-height: 0; background: #000; }
  .pip-stage video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; transform: none !important; }
  .pip-cams { display: flex; gap: 6px; height: ${CAMS_H}px; padding: 6px 8px; overflow-x: auto; background: #141c1e; }
  .pip-cams:empty { display: none; }
  .pip-cam { position: relative; flex: none; height: 100%; aspect-ratio: 4 / 3; border-radius: 10px; overflow: hidden;
    background: hsl(var(--hue) 35% 18%); border: 1px solid rgba(255,255,255,.12); }
  .pip-cam video { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); }
  .pip-cam:not(.self) video { transform: none; }
  .pip-cam span { position: absolute; left: 4px; bottom: 3px; font-size: 10px; font-weight: 600;
    padding: 1px 5px; border-radius: 6px; background: rgba(0,0,0,.55); max-width: calc(100% - 8px);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pip-bar { display: flex; align-items: center; gap: 6px; height: ${BAR_H}px; padding: 0 8px;
    background: rgba(33, 44, 47, 0.97); border-top: 1px solid rgba(236,172,142,.12); }
  .pip-bar button { display: grid; place-items: center; width: 34px; height: 34px; padding: 0; border: 0; border-radius: 10px;
    background: transparent; color: inherit; cursor: pointer; }
  .pip-bar button:hover { background: rgba(255,255,255,.08); }
  .pip-bar button.play { background: linear-gradient(135deg, #D06F4C, #B6433E); }
  .pip-bar button:disabled { opacity: .35; cursor: default; }
  .pip-bar svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .pip-time { font-variant-numeric: tabular-nums; color: #D1C0B5; white-space: nowrap; }
  .pip-seek { flex: 1; min-width: 40px; accent-color: #D06F4C; }
`;

export class PopOut {
  /**
   * @param {object} o
   * @param {HTMLVideoElement} o.player
   * @param {() => Array<{key, name, isSelf, stream, camera}>} o.getCams
   * @param {() => {available: boolean, playing: boolean, time: number, duration: number, title: string, controllable: boolean}} o.getState
   * @param {{toggle: () => void, seekBy: (s: number) => void, seek: (t: number) => void}} o.control
   * @param {(open: boolean) => void} o.onChange
   */
  constructor({ player, getCams, getState, control, onChange }) {
    Object.assign(this, { player, getCams, getState, control, onChange });
    this.win = null;
    this.home = null;
    this.timer = null;
    this.camsKey = '';
  }

  get active() {
    return Boolean(this.win) || document.pictureInPictureElement === this.player;
  }

  async toggle() {
    if (this.active) return this.close();
    return this.open();
  }

  /** Must run from a click or key press (the browser requires a user gesture). */
  async open() {
    if (!canDocumentPip()) {
      await this.player.requestPictureInPicture(); // movie only
      return;
    }
    const size = popOutSize(this.getCams().some((c) => c.camera), screen.availWidth);
    const win = await window.documentPictureInPicture.requestWindow(size);
    this.win = win;
    this.#build(win.document);
    win.addEventListener('pagehide', () => this.#restore(), { once: true });
    this.timer = setInterval(() => this.#tick(), 250);
    this.#tick();
    this.onChange(true);
  }

  close() {
    if (this.win) this.win.close(); // pagehide moves everything back
    else if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  }

  #build(doc) {
    doc.title = this.getState().title || 'Cinema';
    const style = doc.createElement('style');
    style.textContent = CSS;
    doc.head.append(style);
    const font = document.querySelector('link[href*="fonts.googleapis.com/css"]');
    if (font) doc.head.append(font.cloneNode());
    const sprite = document.getElementById('icon-sprite');
    if (sprite) doc.body.append(sprite.cloneNode(true)); // <use href="#i-…"> resolves per document

    const el = (tag, cls, attrs = {}) => Object.assign(doc.createElement(tag), cls ? { className: cls } : {}, attrs);
    const iconBtn = (name, title) => {
      const b = el('button', '', { type: 'button', title });
      b.innerHTML = `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
      return b;
    };
    this.ui = {
      stage: el('div', 'pip-stage'),
      cams: el('div', 'pip-cams'),
      back: iconBtn('back', 'Back 10 s (←)'),
      play: iconBtn('play', 'Play / pause (Space)'),
      fwd: iconBtn('fwd', 'Forward 10 s (→)'),
      time: el('span', 'pip-time'),
      seek: el('input', 'pip-seek', { type: 'range', min: 0, max: 1000, value: 0, title: 'Seek' }),
      ret: iconBtn('shrink', 'Back to the tab'),
    };
    const { stage, cams, back, play, fwd, time, seek, ret } = this.ui;
    play.classList.add('play');
    const bar = el('div', 'pip-bar');
    bar.append(back, play, fwd, time, seek, ret);
    const root = el('div', 'pip');
    root.append(stage, cams, bar);
    doc.body.append(root);

    // Move the real player in (it keeps playing; fill mode's zoom doesn't apply here).
    this.home = { parent: this.player.parentNode, next: this.player.nextSibling };
    stage.append(this.player);

    play.addEventListener('click', () => this.control.toggle());
    back.addEventListener('click', () => this.control.seekBy(-10));
    fwd.addEventListener('click', () => this.control.seekBy(10));
    ret.addEventListener('click', () => this.close());
    stage.addEventListener('click', () => this.control.toggle());
    seek.addEventListener('pointerdown', () => (this.scrubbing = true));
    seek.addEventListener('change', () => {
      this.scrubbing = false;
      const { duration } = this.getState();
      if (duration) this.control.seek((Number(seek.value) / 1000) * duration);
    });
    doc.addEventListener('keydown', (e) => {
      const act = { ' ': () => this.control.toggle(), k: () => this.control.toggle(), arrowleft: () => this.control.seekBy(-10), arrowright: () => this.control.seekBy(10) }[e.key.toLowerCase()];
      if (act) {
        e.preventDefault();
        act();
      }
    });
  }

  #tick() {
    const state = this.getState();
    if (!state.available) return this.close(); // the movie ended, or switched to YouTube
    const { play, back, fwd, time, seek } = this.ui;
    play.querySelector('use').setAttribute('href', state.playing ? '#i-pause' : '#i-play');
    for (const b of [play, back, fwd, seek]) b.disabled = !state.controllable;
    time.textContent = state.duration ? `${formatTime(state.time)} / ${formatTime(state.duration)}` : 'Live';
    seek.hidden = !state.duration;
    if (!this.scrubbing && state.duration) seek.value = String(Math.round((state.time / state.duration) * 1000));
    this.#renderCams();
  }

  /** Webcam thumbnails, mirrored from the tiles (muted: voices still play from the page). */
  #renderCams() {
    const cams = this.getCams().filter((c) => c.camera && c.stream);
    const key = cams.map((c) => `${c.key}:${c.stream.id}:${c.name}`).join('|');
    if (key === this.camsKey) return;
    this.camsKey = key;
    const doc = this.win.document;
    this.ui.cams.replaceChildren(
      ...cams.map((c) => {
        const fig = doc.createElement('div');
        fig.className = `pip-cam${c.isSelf ? ' self' : ''}`;
        const video = Object.assign(doc.createElement('video'), { muted: true, autoplay: true, playsInline: true, srcObject: c.stream });
        const label = Object.assign(doc.createElement('span'), { textContent: c.isSelf ? 'You' : c.name });
        fig.append(video, label);
        video.play().catch(() => {});
        return fig;
      }),
    );
  }

  #restore() {
    clearInterval(this.timer);
    this.timer = null;
    const { parent, next } = this.home ?? {};
    if (parent) parent.insertBefore(this.player, next?.parentNode === parent ? next : null);
    this.home = null;
    this.win = null;
    this.camsKey = '';
    this.onChange(false);
  }
}

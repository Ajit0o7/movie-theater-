// Laser pointer: hold Alt (or turn on laser mode) to draw a glowing trail over the movie
// that everyone sees and that fades after 2 s.
//
// Points travel as fractions of the *picture* (the video's content box, inside any letterbox
// bars), so pointing at a face lands on that face on every screen size.

import { hueFor } from './util.js';

export const TRAIL_MS = 2000;
const SEND_INTERVAL_MS = 33;
const MAX_POINTS_PER_SEND = 24;

/** Pure: viewport point → fraction of the picture (allowing a little outside, into the bars). */
export function toPicture(x, y, box) {
  const clamp = (v) => Math.max(-0.5, Math.min(1.5, v));
  return [clamp((x - box.x) / box.w), clamp((y - box.y) / box.h)];
}

export class LaserLayer {
  /** `getBox()` returns the picture's box in viewport pixels. */
  constructor(canvas, { getBox }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getBox = getBox;
    this.trails = new Map(); // key -> { name, hue, points: [{ x, y, at }] }
    this.raf = 0;
    this.resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  /** Adds picture-fraction points [[x, y], …] to someone's trail. */
  add(key, name, points) {
    let trail = this.trails.get(key);
    if (!trail) this.trails.set(key, (trail = { name, hue: hueFor(name || key), points: [] }));
    const now = performance.now();
    for (const [x, y] of points) trail.points.push({ x, y, at: now });
    this.#start();
  }

  #start() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.#draw());
  }

  #draw() {
    this.raf = 0;
    const ctx = this.ctx;
    const now = performance.now();
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const box = this.getBox();
    let alive = false;
    for (const [key, trail] of this.trails) {
      trail.points = trail.points.filter((p) => now - p.at < TRAIL_MS);
      if (!trail.points.length) {
        this.trails.delete(key);
        continue;
      }
      alive = true;
      const px = (p) => [box.x + p.x * box.w, box.y + p.y * box.h];
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // Segments fade and thin out with age.
      for (let i = 1; i < trail.points.length; i++) {
        const a = trail.points[i - 1];
        const b = trail.points[i];
        const life = 1 - (now - b.at) / TRAIL_MS;
        const [x1, y1] = px(a);
        const [x2, y2] = px(b);
        ctx.strokeStyle = `hsla(${trail.hue} 100% 60% / ${(life * 0.9).toFixed(3)})`;
        ctx.shadowColor = `hsla(${trail.hue} 100% 55% / ${life.toFixed(3)})`;
        ctx.shadowBlur = 14 * life;
        ctx.lineWidth = 2 + 5 * life;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      // A bright dot and the person's name at the newest point.
      const head = trail.points[trail.points.length - 1];
      const life = 1 - (now - head.at) / TRAIL_MS;
      const [hx, hy] = px(head);
      ctx.shadowBlur = 22 * life;
      ctx.shadowColor = `hsla(${trail.hue} 100% 60% / ${life.toFixed(3)})`;
      ctx.fillStyle = `hsla(${trail.hue} 100% 85% / ${life.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(hx, hy, 6, 0, Math.PI * 2);
      ctx.fill();
      if (trail.name) {
        ctx.shadowBlur = 4;
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.font = '600 12px Inter, system-ui, sans-serif';
        ctx.fillStyle = `rgba(255,255,255,${(life * 0.95).toFixed(3)})`;
        ctx.fillText(trail.name, hx + 10, hy - 10);
      }
    }
    ctx.shadowBlur = 0;
    if (alive) this.#start(); // the loop stops by itself once every trail has faded
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
  }
}

/**
 * Pointer input: Alt + move (mouse), or press-and-drag while laser mode is on (touch).
 * `onPoints(points)` receives picture-fraction points, batched at ~30 Hz.
 */
export function setupLaserInput({ stage, getBox, isStageTarget, onPoints, onLocal }) {
  let mode = false; // laser mode (button / P)
  let drawing = false;
  let pending = [];
  let timer = null;

  const flush = () => {
    timer = null;
    if (!pending.length) return;
    onPoints(pending.splice(0, MAX_POINTS_PER_SEND));
    if (pending.length) timer = setTimeout(flush, SEND_INTERVAL_MS);
  };

  function point(e) {
    const p = toPicture(e.clientX, e.clientY, getBox());
    onLocal([p]);
    pending.push(p);
    timer ??= setTimeout(flush, SEND_INTERVAL_MS);
  }

  window.addEventListener('pointermove', (e) => {
    const active = (e.altKey && e.pointerType === 'mouse') || (mode && drawing);
    if (active && isStageTarget(e.target)) point(e);
  });
  stage.addEventListener('pointerdown', (e) => {
    if (!mode) return;
    drawing = true;
    point(e);
  });
  window.addEventListener('pointerup', () => (drawing = false));
  window.addEventListener('pointercancel', () => (drawing = false));
  // Alt alone would focus the browser's menu bar on some systems.
  window.addEventListener('keyup', (e) => e.key === 'Alt' && e.preventDefault());

  return {
    get active() {
      return mode;
    },
    toggle(force) {
      mode = force ?? !mode;
      document.body.classList.toggle('laser-mode', mode);
      return mode;
    },
  };
}

// Ambilight: the picture's colours glow around the movie.
//
// The current frame is drawn into a tiny 16×9 canvas that CSS stretches behind the movie;
// bilinear upscaling of so few pixels is the "blur". This runs next to a 4K video, so it
// never reads back full frames and uses no live CSS blur filter.
//
// Films often have black bars baked into the video file. Every couple of seconds a small
// copy is analysed to find them; the glow then samples only the picture (not the black), and
// moves in front of the video with the picture cut out of it, so it spills into those bars
// exactly as it does into the screen's own.

const W = 16;
const H = 9;
const INTERVAL_MS = 200;
const DETECT_EVERY_MS = 2000;
const AW = 128;
const AH = 72;
const BLACK = 24; // max luma (0–255) for a row/column to count as a bar
const DIM = 48; // average luma of a bar row that has burned-in subtitle text on it
const MIN_BAR = 0.03; // ignore slivers thinner than 3%
const MAX_BAR = 0.4;
const NO_BARS = Object.freeze({ top: 0, bottom: 0, left: 0, right: 0 });

/**
 * Pure: finds black bars in a small RGBA frame. Returns fractions { top, bottom, left, right },
 * or null when the frame is too dark to judge (a fade to black looks like all bars).
 */
export function detectBars(data, width, height) {
  const luma = (i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  const rowMax = new Array(height).fill(0);
  const rowMean = new Array(height).fill(0);
  const colMax = new Array(width).fill(0);
  const colMean = new Array(width).fill(0);
  let total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const l = luma((y * width + x) * 4);
      total += l;
      rowMean[y] += l / width;
      colMean[x] += l / height;
      if (l > rowMax[y]) rowMax[y] = l;
      if (l > colMax[x]) colMax[x] = l;
    }
  }
  if (total / (width * height) < 12) return null; // nearly black frame: no verdict

  // Lines from one edge inward. The first picture line is usually part bar, part picture (the
  // frame was scaled down), so its brightness against the next line's says how much is bar.
  const side = (max, mean) => {
    let n = 0;
    while (n < max.length && max[n] <= BLACK) n++;
    if (n === 0 || n + 1 >= max.length) return n / max.length;
    const partial = mean[n + 1] > BLACK ? 1 - mean[n] / mean[n + 1] : 0;
    return (n + (partial > 0.15 ? Math.min(partial, 0.9) : 0)) / max.length;
  };
  const rev = (a) => [...a].reverse();
  const bars = {
    top: side(rowMax, rowMean),
    bottom: side(rev(rowMax), rev(rowMean)),
    left: side(colMax, colMean),
    right: side(rev(colMax), rev(colMean)),
  };
  // Letterboxing is symmetric. Burned-in subtitles in the bottom bar stop it counting as black
  // while a line is shown; a side whose lines stay dark on average takes the other side's size.
  const mirror = (a, b, meanA, meanB) => {
    if (Math.abs(bars[a] - bars[b]) < 0.01) return;
    const [small, big, means] = bars[a] < bars[b] ? [a, b, meanA] : [b, a, meanB];
    const lines = Math.floor(bars[big] * means.length);
    if (means.slice(0, lines).every((m) => m < DIM)) bars[small] = bars[big];
  };
  mirror('top', 'bottom', rowMean, rev(rowMean));
  mirror('left', 'right', colMean, rev(colMean));
  for (const k in bars) if (!(bars[k] >= MIN_BAR && bars[k] < MAX_BAR)) bars[k] = 0;
  return bars;
}

const sameBars = (a, b) => a && b && ['top', 'bottom', 'left', 'right'].every((k) => Math.abs(a[k] - b[k]) < 0.02);
const hasBars = (c) => Boolean(c.top || c.bottom || c.left || c.right);

export class Ambilight {
  /**
   * @param video   the <video> element
   * @param canvas  the stretched glow (sits behind the video, or in front of it when the video
   *                has baked-in bars; it must come after the video in the DOM)
   * @param getBox  where the video element's picture is on screen, in viewport pixels
   */
  constructor(video, canvas, { getBox = null } = {}) {
    this.video = video;
    this.canvas = canvas;
    canvas.width = W;
    canvas.height = H;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.getBox = getBox;
    this.analysis = document.createElement('canvas');
    this.analysis.width = AW;
    this.analysis.height = AH;
    this.actx = this.analysis.getContext('2d'); // GPU-backed: only the small copy is read back
    this.actx.imageSmoothingQuality = 'medium'; // average when shrinking, so edge rows blend
    this.crop = NO_BARS;
    this.candidate = null;
    this.lastDetect = 0;
    this.canAnalyse = true;
    this.enabled = true;
    this.lastTime = -1;
    this.timer = setInterval(() => this.#draw(), INTERVAL_MS);
    video.addEventListener('emptied', () => this.#reset());
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) this.#clear();
  }

  #reset() {
    this.crop = NO_BARS;
    this.candidate = null;
    this.canAnalyse = true;
    this.#layout();
    this.#clear();
  }

  #clear() {
    this.lastTime = -1;
    this.canvas.classList.remove('lit');
  }

  /** Returns true when the crop changed. */
  #detect(v) {
    const now = performance.now();
    if (!this.canAnalyse || !this.getBox || now - this.lastDetect < DETECT_EVERY_MS) return false;
    this.lastDetect = now;
    try {
      this.actx.drawImage(v, 0, 0, AW, AH);
      const found = detectBars(this.actx.getImageData(0, 0, AW, AH).data, AW, AH);
      if (!found) return false; // dark scene: keep what we had
      const confirmed = sameBars(found, this.candidate); // seen twice: a single odd shot doesn't flip it
      this.candidate = found;
      if (!confirmed || sameBars(found, this.crop)) return false;
      this.crop = found;
      this.#layout();
      return true;
    } catch {
      this.canAnalyse = false; // cross-origin video without CORS: can't read pixels, glow still works
      return false;
    }
  }

  /**
   * With bars in the video, the glow moves in front of it and the picture is cut out of it
   * (CSS mask), so the bars light up like the space around the screen.
   */
  #layout() {
    const over = hasBars(this.crop);
    this.canvas.classList.toggle('over', over);
    if (!over) return;
    const box = this.getBox();
    const { top, bottom, left, right } = this.crop;
    const origin = this.canvas.getBoundingClientRect();
    const px = (v) => `${v.toFixed(1)}px`;
    const s = this.canvas.style;
    // 1px wider all round: detection is within a pixel or so, and glow must never cover picture.
    s.setProperty('--pic-x', px(box.x + left * box.w - origin.left - 1));
    s.setProperty('--pic-y', px(box.y + top * box.h - origin.top - 1));
    s.setProperty('--pic-w', px(box.w * (1 - left - right) + 2));
    s.setProperty('--pic-h', px(box.h * (1 - top - bottom) + 2));
  }

  relayout() {
    this.#layout();
  }

  #draw() {
    const v = this.video;
    if (!this.enabled || document.hidden || v.hidden || v.readyState < 2 || !v.videoWidth) {
      if (!v.videoWidth || v.hidden) this.#clear();
      return;
    }
    // An unchanged frame (paused file) needs no redraw unless the crop changed. Live streams
    // always advance. Detection still runs while paused (it limits itself to every 2 s).
    const cropChanged = this.#detect(v);
    if (!cropChanged && !v.srcObject && v.currentTime === this.lastTime) return;
    this.lastTime = v.currentTime;
    // Sample only the picture, not the baked-in black bars.
    const { top, bottom, left, right } = this.crop;
    const sx = left * v.videoWidth;
    const sy = top * v.videoHeight;
    const sw = v.videoWidth * (1 - left - right);
    const sh = v.videoHeight * (1 - top - bottom);
    this.ctx.drawImage(v, sx, sy, sw, sh, 0, 0, W, H);
    this.canvas.classList.add('lit');
  }

  destroy() {
    clearInterval(this.timer);
  }
}

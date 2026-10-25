// Ambilight: samples the movie's edges into a tiny canvas and tints the letterbox glow.
// Cross-origin videos without CORS taint the canvas; we detect that and switch off quietly.

const W = 32;
const H = 18;

export class Ambilight {
  constructor(video, target) {
    this.video = video;
    this.target = target;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.enabled = true;
    this.tainted = false;
    this.timer = setInterval(() => this.#sample(), 250);
    video.addEventListener('emptied', () => {
      this.tainted = false;
      this.#clear();
    });
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) this.#clear();
  }

  #clear() {
    this.target.style.opacity = '0';
  }

  #sample() {
    if (!this.enabled || this.tainted || document.hidden) return;
    const v = this.video;
    if (v.readyState < 2 || !v.videoWidth) {
      this.#clear();
      return;
    }
    try {
      this.ctx.drawImage(v, 0, 0, W, H);
      const { data } = this.ctx.getImageData(0, 0, W, H);
      const avg = (x0, y0, x1, y1) => {
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * W + x) * 4;
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            n++;
          }
        }
        return `rgb(${(r / n) | 0} ${(g / n) | 0} ${(b / n) | 0})`;
      };
      const s = this.target.style;
      s.setProperty('--amb-left', avg(0, 0, 4, H));
      s.setProperty('--amb-right', avg(W - 4, 0, W, H));
      s.setProperty('--amb-top', avg(0, 0, W, 3));
      s.setProperty('--amb-bottom', avg(0, H - 3, W, H));
      s.opacity = '';
    } catch {
      // SecurityError: cross-origin frame. Nothing to sample until the source changes.
      this.tainted = true;
      this.#clear();
    }
  }

  destroy() {
    clearInterval(this.timer);
  }
}

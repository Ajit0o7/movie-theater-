// Ambilight: draws the current frame into a tiny 16×9 canvas that CSS stretches behind the
// movie. Bilinear upscaling of so few pixels gives a soft glow in the letterbox bars.
//
// Performance matters here because this runs next to a 4K video: we never call getImageData
// (which would force a GPU→CPU readback of the frame) and never use a CSS blur filter
// (which would re-rasterise a full-screen layer on every update).

const W = 16;
const H = 9;
const INTERVAL_MS = 200;

export class Ambilight {
  constructor(video, canvas) {
    this.video = video;
    this.canvas = canvas;
    canvas.width = W;
    canvas.height = H;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.enabled = true;
    this.lastTime = -1;
    this.timer = setInterval(() => this.#draw(), INTERVAL_MS);
    video.addEventListener('emptied', () => this.#clear());
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) this.#clear();
  }

  #clear() {
    this.lastTime = -1;
    this.canvas.classList.remove('lit');
  }

  #draw() {
    const v = this.video;
    if (!this.enabled || document.hidden || v.hidden || v.readyState < 2 || !v.videoWidth) {
      if (!v.videoWidth || v.hidden) this.#clear();
      return;
    }
    // An unchanged frame (paused file) needs no redraw. Live streams always advance.
    if (!v.srcObject && v.currentTime === this.lastTime) return;
    this.lastTime = v.currentTime;
    this.ctx.drawImage(v, 0, 0, W, H);
    this.canvas.classList.add('lit');
  }

  destroy() {
    clearInterval(this.timer);
  }
}

// Touch gestures on the movie, for phones and tablets:
//   tap                     show / hide the controls (not play/pause: too easy to hit by accident)
//   double-tap left/right   −10 s / +10 s; keep tapping to add more, sent to the room as one seek
//   double-tap centre       play / pause
//   swipe up/down           brightness (left half) or volume (right half)
//   pinch out / in          fill the screen / fit the whole picture
// Mouse input is left alone (click: play/pause, double-click: fullscreen).

const TAP_MS = 300; // max gap between the taps of a double-tap
const TAP_SLOP = 12; // px a finger may wander and still be a tap
const DOUBLE_TAP_PX = 90;
const STREAK_MS = 700; // keep tapping within this to add another step
export const SEEK_STEP = 10;
const SWIPE_RANGE = 0.6; // a swipe over 60% of the screen height goes from 0% to 100%

export const isTouch = (e) => e.pointerType === 'touch' || e.pointerType === 'pen';

/** Pure: which part of the screen a double-tap lands on. */
export function tapZone(x, width) {
  const f = x / width;
  return f < 0.4 ? 'back' : f > 0.6 ? 'forward' : 'middle';
}

/** Pure: what a pinch means, from the distance between the two fingers at the start and now. */
export function pinchIntent(startDist, dist) {
  const ratio = dist / startDist;
  return ratio > 1.15 ? 'fill' : ratio < 0.87 ? 'fit' : null;
}

/**
 * @param {HTMLElement} el  the surface over the movie
 * @param {object} on
 * @param {() => boolean} on.enabled
 * @param {() => void} on.tap
 * @param {() => void} on.togglePlay
 * @param {(seconds: number) => boolean} on.seekPreview  a skip streak grew; false: can't seek here
 * @param {(seconds: number) => void} on.seek            the streak ended: seek by its total
 * @param {(side: 'left'|'right', delta: number) => void} on.swipe  delta: share of the full range
 * @param {(intent: 'fill'|'fit') => void} on.pinch
 */
export function setupTouchGestures(el, on) {
  const pointers = new Map();
  let mode = null; // 'press' | 'swipe' | 'pinch' | 'drag'
  let start = null;
  let lastY = 0;
  let side = 'left';
  let pinchStart = 0;
  let pinchDone = null;
  let lastTap = null;
  let singleTimer = null;
  let streak = null; // { zone, total, last, timer }

  const distance = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  function endStreak() {
    if (!streak) return;
    clearTimeout(streak.timer);
    const { total } = streak;
    streak = null;
    on.seek(total);
  }

  function step(zone, now) {
    const sign = zone === 'back' ? -1 : 1;
    const total = (streak?.total ?? 0) + sign * SEEK_STEP;
    if (!on.seekPreview(total)) return;
    clearTimeout(streak?.timer);
    streak = { zone, total, last: now, timer: setTimeout(endStreak, STREAK_MS) };
  }

  function handleTap(x, y, now) {
    const zone = tapZone(x, el.clientWidth);
    // Already skipping: every further tap on that side adds another step.
    if (streak && zone === streak.zone && now - streak.last < STREAK_MS) {
      step(zone, now);
      return;
    }
    if (lastTap && now - lastTap.t < TAP_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < DOUBLE_TAP_PX) {
      clearTimeout(singleTimer);
      lastTap = null;
      if (zone === 'middle') on.togglePlay();
      else {
        endStreak(); // a streak the other way ends here
        step(zone, now);
      }
      return;
    }
    lastTap = { x, y, t: now };
    clearTimeout(singleTimer);
    singleTimer = setTimeout(() => {
      lastTap = null;
      on.tap();
    }, TAP_MS);
  }

  el.addEventListener('pointerdown', (e) => {
    if (!isTouch(e) || !on.enabled()) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      mode = 'pinch';
      pinchStart = distance();
      pinchDone = null;
      clearTimeout(singleTimer);
      lastTap = null;
    } else if (pointers.size === 1) {
      mode = 'press';
      start = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    }
  });

  el.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (mode === 'pinch' && pointers.size === 2) {
      const intent = pinchIntent(pinchStart, distance());
      if (intent && intent !== pinchDone) {
        pinchDone = intent;
        on.pinch(intent);
      }
    } else if (mode === 'press') {
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) < TAP_SLOP) return;
      if (Math.abs(dy) > Math.abs(dx) * 1.2) {
        mode = 'swipe';
        side = start.x < el.clientWidth / 2 ? 'left' : 'right';
        lastY = start.y;
      } else mode = 'drag'; // sideways: nothing (the laser and camera tiles have their own drags)
    }
    if (mode === 'swipe') {
      on.swipe(side, (lastY - e.clientY) / (el.clientHeight * SWIPE_RANGE));
      lastY = e.clientY;
    }
  });

  const release = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (e.type === 'pointerup' && mode === 'press' && e.timeStamp - start.t < 500) handleTap(e.clientX, e.clientY, e.timeStamp);
    if (!pointers.size) mode = null;
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
}

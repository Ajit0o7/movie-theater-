// Where the movie's picture sits on screen: fitted whole (object-fit: contain), or zoomed so the
// picture, without any black bars baked into the file, fills the screen.

const NO_CROP = { top: 0, bottom: 0, left: 0, right: 0 };
export const IDENTITY = Object.freeze({ s: 1, tx: 0, ty: 0 });

/** Pure: the box a video of (vw × vh) occupies inside (w × h) with object-fit: contain. */
export function containBox(boxW, boxH, videoW, videoH) {
  if (!(videoW > 0 && videoH > 0 && boxW > 0 && boxH > 0)) return { x: 0, y: 0, w: boxW, h: boxH };
  const scale = Math.min(boxW / videoW, boxH / videoH);
  const w = videoW * scale;
  const h = videoH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

/**
 * Pure: the zoom that makes the picture cover a (viewW × viewH) screen, as
 * `translate(tx, ty) scale(s)` about the screen centre. `crop` is the share of the file on each
 * side that is black bars, so a 2.39:1 film inside a 16:9 file fills the screen, not its bars.
 */
export function fillTransform(viewW, viewH, videoW, videoH, crop = NO_CROP) {
  const file = containBox(viewW, viewH, videoW, videoH);
  const pic = {
    x: file.x + crop.left * file.w,
    y: file.y + crop.top * file.h,
    w: file.w * (1 - crop.left - crop.right),
    h: file.h * (1 - crop.top - crop.bottom),
  };
  if (!(pic.w > 0 && pic.h > 0 && videoW > 0 && videoH > 0)) return IDENTITY;
  const s = Math.max(viewW / pic.w, viewH / pic.h);
  return { s, tx: -s * (pic.x + pic.w / 2 - viewW / 2), ty: -s * (pic.y + pic.h / 2 - viewH / 2) };
}

/** Pure: where a box lands after `translate(tx, ty) scale(s)` about the centre of the screen. */
export function transformBox(box, { s, tx, ty }, viewW, viewH) {
  return {
    x: viewW / 2 + s * (box.x - viewW / 2) + tx,
    y: viewH / 2 + s * (box.y - viewH / 2) + ty,
    w: box.w * s,
    h: box.h * s,
  };
}

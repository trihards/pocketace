// The visual rules, shared by the browser preview and the FFmpeg render.
// Both ask the same question of this file: where is the photo drawn on the
// 1080×1920 canvas at this moment? So a number changed here changes both.
//
// Two treatments, chosen per photo in the story (each copy separately):
//   whole: the entire photo, as large as the canvas allows (edge to edge for
//          landscapes), over a dark, blurred copy of itself. Nothing is cut
//          off: right for groups, artwork and documents.
//   fill:  the photo covers the whole canvas and is cropped. Ace picks what
//          shows by moving the focus point (which point of the photo sits at
//          the centre of the frame).
// Photos are enlarged as much as these need: the archive is small, and a
// big, slightly soft photo reads better than a sharp postage stamp.

export const W = 1080, H = 1920;

// Whole: the photo may use the full width and this much of the height. A
// photo shorter than TALL sits centred at CENTER_Y (between the wordmark and
// the name); taller ones are centred on the canvas and run under the name,
// where the shade keeps the type readable.
export const WHOLE = { maxHeight: 0.86, centerY: 0.42, tall: 1300 };

// Photos at least this close to 9:16 (width / height) fill the frame unless
// Ace says otherwise: filling them crops less than a tenth of their width.
export const FILL_AUTO_ASPECT = 0.62;

// Where a fill crop looks first. A little above the middle, where faces
// usually are; Ace can drag it anywhere.
export const FOCUS = { x: 0.5, y: 0.4 };

// Enlarging a photo more than this when filling makes it noticeably soft.
export const SOFT_UPSCALE = 4;

// Movement, used sparingly. Whole photos hold still, and so do short shots.
// A filled photo Ace hasn't positioned that hides a lot at the sides pans
// slowly across, so nobody at the edges stays hidden. Once Ace has positioned
// a filled photo, his framing holds: it only pushes in a little towards it.
export const MOTION = { minSeconds: 6, panSpeed: 30, panMinHidden: 0.25, push: 1.05 };

// Behind a whole photo: a blurred copy of it, dimmed and muted so it frames
// the photo without competing. `dim` multiplies brightness and `saturation`
// colour, the way CSS brightness()/saturate() do, so the preview's filter and
// the render's lookup table give the same result. `blur` is the Gaussian sigma
// at quarter size (270 px wide), about 6.7% of the frame width.
export const BACKDROP = { blur: 18, dim: 0.38, saturation: 0.55 };
BACKDROP.css = `blur(6.7cqw) brightness(${BACKDROP.dim}) saturate(${BACKDROP.saturation})`;

// The guest name and the line under it break at these lengths, in the
// preview and the render alike. At most three lines each.
export const WRAP = { guest: 18, subtitle: 36 };
export function wrapLines(text, max) {
  const out = [];
  let line = '';
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + w).length > max) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.slice(0, 3);
}

// Crossfade length in seconds (shortened automatically for very short shots).
export const TRANSITION = 0.8;

export const defaultFit = (width, height) => (width / height <= FILL_AUTO_ASPECT ? 'fill' : 'whole');
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// The resting layout of a photo: `rect` is where the whole image is drawn,
// `clip` the part of the canvas it may show in.
export function layout({ width, height, fit, fx, fy }) {
  const f = fit === 'whole' || fit === 'fill' ? fit : defaultFit(width, height);
  if (f === 'whole') {
    const s = Math.min(W / width, (H * WHOLE.maxHeight) / height);
    const w = width * s, h = height * s;
    const cy = h > WHOLE.tall ? H / 2 : H * WHOLE.centerY;
    const rect = { x: (W - w) / 2, y: clamp(cy - h / 2, 0, H - h), w, h };
    return { fit: 'whole', rect, clip: rect, upscale: s };
  }
  const s = Math.max(W / width, H / height);
  const w = width * s, h = height * s;
  const focus = { x: Number.isFinite(fx) ? clamp(fx, 0, 1) : FOCUS.x, y: Number.isFinite(fy) ? clamp(fy, 0, 1) : FOCUS.y };
  const rect = { x: clamp(W / 2 - focus.x * w, W - w, 0), y: clamp(H / 2 - focus.y * h, H - h, 0), w, h };
  return { fit: 'fill', rect, clip: { x: 0, y: 0, w: W, h: H }, upscale: s, focus, positioned: Number.isFinite(fx) || Number.isFinite(fy) };
}

// How a photo moves during a clip of `seconds` (the shot plus its fade in).
// `index` alternates pan direction so neighbouring pans don't all go one way.
export function motionFor(L, seconds, index) {
  if (L.fit !== 'fill' || seconds < MOTION.minSeconds) return { kind: 'still' };
  const hidden = L.rect.w - W;
  if (!L.positioned && hidden / W >= MOTION.panMinHidden) {
    // A stretch centred on the resting position, no faster than panSpeed,
    // never past the photo's edges.
    const span = Math.min(hidden, MOTION.panSpeed * seconds);
    const mid = clamp(L.rect.x, W - L.rect.w + span / 2, -span / 2);
    const [a, b] = [mid + span / 2, mid - span / 2];
    return index % 2 ? { kind: 'pan', x0: b, x1: a } : { kind: 'pan', x0: a, x1: b };
  }
  // Push in towards the focus point (as it lands on the canvas).
  const ax = clamp(L.rect.x + L.focus.x * L.rect.w, 0, W), ay = clamp(L.rect.y + L.focus.y * L.rect.h, 0, H);
  return { kind: 'push', z0: 1, z1: MOTION.push, ax, ay };
}

// Where the image is drawn at progress f (0..1 through the clip).
export function rectAt(L, M, f) {
  const r = L.rect;
  if (M.kind === 'pan') return { ...r, x: M.x0 + (M.x1 - M.x0) * f };
  if (M.kind === 'push') {
    const z = M.z0 + (M.z1 - M.z0) * f;
    return { x: M.ax + (r.x - M.ax) * z, y: M.ay + (r.y - M.ay) * z, w: r.w * z, h: r.h * z };
  }
  return r;
}

export function transitionFor(shots, fps = 30) {
  const minLen = Math.min(...shots.map((s) => s.end - s.start));
  return Math.max(2 / fps, Math.round(Math.min(TRANSITION, minLen / 2) * fps) / fps);
}

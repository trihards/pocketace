// The visual rules, shared by the browser preview and the FFmpeg render.
// Change a number here and both follow.

// Photos narrower than this (width / height) fill the whole 9:16 frame.
// Everything else is shown whole, framed over a blurred copy of itself.
export const FILL_MAX_ASPECT = 0.62;

// Never enlarge a photo by more than this. Most of the Aced Out archive is
// small (median long side ~730px across 441 photos), so small photos sit
// smaller on screen instead of being blown up soft.
export const MAX_UPSCALE = 1.25;

// Where a photo sits on the 1080x1920 canvas: {fill} or {x,y,w,h} in px.
export function placement(width, height) {
  const a = width / height;
  if (a < FILL_MAX_ASPECT && height * MAX_UPSCALE >= 1920) return { fill: true };
  let w = Math.min(1080 - 2 * FRAME.margin, width * MAX_UPSCALE);
  let h = w / a;
  const maxH = Math.min(1920 * FRAME.maxHeight, height * MAX_UPSCALE);
  if (h > maxH) { h = maxH; w = h * a; }
  return { fill: false, x: (1080 - w) / 2, y: 1920 * FRAME.centerY - h / 2, w, h };
}

// Framed photos: side margin (px at 1080 wide), max height and vertical centre
// as fractions of the frame height.
export const FRAME = { margin: 40, maxHeight: 0.6, centerY: 0.43 };

// Crossfade length in seconds (shortened automatically for very short shots).
export const TRANSITION = 0.8;

// Camera moves, cycled in order so neighbouring shots differ.
// z = zoom factor; x/y = where the visible window sits (0 = left/top, 1 = right/bottom).
export const MOTIONS = [
  { z0: 1.0, z1: 1.08, x0: 0.5, x1: 0.5, y0: 0.5, y1: 0.5 }, // push in
  { z0: 1.08, z1: 1.0, x0: 0.5, x1: 0.5, y0: 0.4, y1: 0.5 }, // pull out
  { z0: 1.06, z1: 1.06, x0: 0.15, x1: 0.85, y0: 0.5, y1: 0.5 }, // drift right
  { z0: 1.02, z1: 1.09, x0: 0.6, x1: 0.4, y0: 0.6, y1: 0.35 }, // push in, rise
];
export const motion = (i) => MOTIONS[i % MOTIONS.length];

export function transitionFor(shots, fps = 30) {
  const minLen = Math.min(...shots.map((s) => s.end - s.start));
  return Math.max(2 / fps, Math.round(Math.min(TRANSITION, minLen / 2) * fps) / fps);
}

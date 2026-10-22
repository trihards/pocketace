// Deterministic photo scheduling. Shared by the browser (live preview) and
// the server (render), so what Ace sees is exactly what gets rendered.
//
// Rules, in plain words:
//  1. Photos play in exactly the order given: the order of the story strip.
//  2. The excerpt is shared out in proportion to each photo's weight. Every
//     weight is 1 today, so the split is even. (Weights are the hook for
//     dragging the boundaries between photos on the strip later.)
//  3. Boundaries snap to whole video frames, and the shots tile the excerpt
//     with no gaps.
// No randomness, no content analysis: the same inputs always give the same cut.

export const DEFAULTS = { fps: 30, minShot: 3, longShot: 25 };

export function schedule({ duration, photos, ...opts }) {
  const { fps, minShot, longShot } = { ...DEFAULTS, ...opts };
  const warnings = [];
  if (!(duration > 0)) throw new Error('Excerpt has no length. Set a start and an end.');
  if (!photos || photos.length === 0) throw new Error('Pick at least one photo.');

  const snap = (t) => Math.round(t * fps) / fps;
  const weights = photos.map((p) => (Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  const shots = photos.map((p, i) => {
    const start = snap((acc / total) * duration);
    acc += weights[i];
    return { id: p.id, start, end: snap((acc / total) * duration) };
  });
  shots[shots.length - 1].end = snap(duration);

  const short = shots.filter((s) => s.end - s.start < minShot).length;
  if (short) warnings.push(`${short} photo(s) get less than ${minShot}s on screen. Consider using fewer photos or a longer excerpt.`);
  const long = shots.filter((s) => s.end - s.start > longShot).length;
  if (long) warnings.push(`${long} photo(s) stay on screen longer than ${longShot}s. More photos will make it livelier.`);

  return { shots, warnings };
}

export function fmt(sec) {
  if (!Number.isFinite(sec)) return '--:--';
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = (s % 60).toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

// Accepts "1:23:45.6", "83:45", "45.2" → seconds. Returns NaN when unreadable.
export function parseTime(text) {
  const parts = String(text).trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

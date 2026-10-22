// Deterministic photo scheduling. Shared by the browser (live preview) and
// the server (render), so what Ace sees is exactly what gets rendered.
//
// Rules, in plain words:
//  1. A pinned photo is fully on screen from its pinned second.
//  2. Pins split the excerpt into stretches. Unpinned photos are handed out
//     one at a time to whichever stretch currently has the longest shots
//     (the D'Hondt method). Ties go to the earlier stretch.
//  3. Unpinned photos keep the order Ace put them in.
//  4. Inside a stretch, time is split evenly between its photos.
//  5. Boundaries snap to whole video frames.
// No randomness, no content analysis: the same inputs always give the same cut.

export const DEFAULTS = { fps: 30, minShot: 3, longShot: 25, minPinGap: 2 };

export function schedule({ duration, photos, ...opts }) {
  const { fps, minShot, longShot, minPinGap } = { ...DEFAULTS, ...opts };
  const warnings = [];
  if (!(duration > 0)) throw new Error('Excerpt has no length. Set a start and an end.');
  if (!photos || photos.length === 0) throw new Error('Pick at least one photo.');

  const snap = (t) => Math.round(t * fps) / fps;

  // Pins: keep valid ones, sort by time, push apart any that collide.
  const pinned = [];
  const unpinned = [];
  for (const p of photos) {
    const pin = typeof p.pin === 'number' && Number.isFinite(p.pin) ? p.pin : null;
    if (pin === null) unpinned.push(p);
    else if (pin < 0 || pin >= duration) {
      warnings.push(`Pin at ${fmt(pin)} is outside the excerpt and was ignored.`);
      unpinned.push(p);
    } else pinned.push({ photo: p, at: pin });
  }
  pinned.sort((a, b) => a.at - b.at);
  for (let i = 1; i < pinned.length; i++) {
    const min = pinned[i - 1].at + minPinGap;
    if (pinned[i].at < min) {
      warnings.push(`Two pins were less than ${minPinGap}s apart; the later one moved to ${fmt(min)}.`);
      pinned[i].at = min;
    }
  }
  while (pinned.length && pinned[pinned.length - 1].at >= duration - 0.5) {
    const dropped = pinned.pop();
    warnings.push(`A pin ended up too close to the end and was unpinned.`);
    unpinned.push(dropped.photo);
  }

  // Stretches: [0, first pin), then [pin_k, pin_k+1), last runs to the end.
  const stretches = [];
  const firstPin = pinned.length ? pinned[0].at : duration;
  stretches.push({ start: 0, end: firstPin, lead: null, fill: [] });
  pinned.forEach((p, i) => {
    stretches.push({ start: p.at, end: i + 1 < pinned.length ? pinned[i + 1].at : duration, lead: p.photo, fill: [] });
  });

  // D'Hondt allocation of unpinned photo *counts* to stretches.
  const counts = stretches.map((s) => (s.lead ? 1 : 0));
  const extra = stretches.map(() => 0);
  for (let n = 0; n < unpinned.length; n++) {
    let best = -1;
    let bestQ = -1;
    stretches.forEach((s, i) => {
      const len = s.end - s.start;
      if (len <= 0) return;
      const q = len / (counts[i] + 1);
      if (q > bestQ + 1e-9) { bestQ = q; best = i; }
    });
    counts[best]++;
    extra[best]++;
  }
  // Hand out the actual photos in Ace's order, earliest stretch first.
  let cursor = 0;
  stretches.forEach((s, i) => { s.fill = unpinned.slice(cursor, cursor + extra[i]); cursor += extra[i]; });

  // An empty lead stretch means the first pinned photo opens the video.
  if (stretches[0].fill.length === 0 && stretches.length > 1) {
    stretches[1].start = 0;
    stretches.shift();
  }

  const shots = [];
  for (const s of stretches) {
    const items = [...(s.lead ? [{ photo: s.lead, pinned: true }] : []), ...s.fill.map((photo) => ({ photo, pinned: false }))];
    const each = (s.end - s.start) / items.length;
    items.forEach((it, k) => {
      shots.push({ id: it.photo.id, pinned: it.pinned, start: snap(s.start + k * each), end: snap(s.start + (k + 1) * each) });
    });
  }
  shots[shots.length - 1].end = snap(duration);

  const short = shots.filter((s) => s.end - s.start < minShot).length;
  if (short) warnings.push(`${short} photo(s) get less than ${minShot}s on screen. Consider using fewer photos or moving pins apart.`);
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

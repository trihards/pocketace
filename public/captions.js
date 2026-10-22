// Human-supplied captions: SRT or WebVTT in, a plain cue list in the middle,
// SRT out. No speech recognition anywhere. The cue list is the editable model
// a future caption editor would work on.

export function parseCaptions(text) {
  const src = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues = [];
  for (const block of src.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx === -1) continue; // WEBVTT header, NOTE, STYLE blocks, stray numbers
    const [a, b] = lines[idx].split('-->');
    const start = parseStamp(a);
    const end = parseStamp(b.trim().split(/\s+/)[0]);
    const body = lines.slice(idx + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && body) cues.push({ start, end, text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

function parseStamp(s) {
  const m = String(s).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return NaN;
  return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

// Keep the cues that overlap [from, to), re-timed so the excerpt starts at 0.
export function clipCues(cues, from, to) {
  return cues
    .filter((c) => c.end > from && c.start < to)
    .map((c) => ({ start: Math.max(0, c.start - from), end: Math.min(to, c.end) - from, text: c.text }));
}

export function toSRT(cues) {
  const stamp = (t) => {
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms % 1000).padStart(3, '0')}`;
  };
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n');
}

const pad = (n) => String(n).padStart(2, '0');

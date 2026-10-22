import { schedule, fmt, parseTime } from './schedule.js';
import { parseCaptions, clipCues } from './captions.js';
import { motion, placement, transitionFor } from './look.js';

const $ = (s) => document.querySelector(s);
const state = {
  library: [],      // every photo we know about: {url, thumb, width, height}
  story: [],        // chosen photos in order: {url, pin}; pin = seconds into the *episode*,
                    // so a pin stays on its moment when the excerpt start moves
  cues: [],
  plan: { shots: [], warnings: [] },
};
const audio = $('#audio');
window.pocketace = state; // inspectable from the browser console when helping remotely

// ---------- 1. Episode lookup ----------
$('#lookup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#episode-url').value.trim();
  setStatus('#lookup-status', 'Looking up the episode…');
  try {
    const r = await fetch(`/api/episode?url=${encodeURIComponent(url)}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    $('#lookup-report').textContent = JSON.stringify(data, null, 2);
    $('#lookup-details').hidden = false;
    const failed = data.sources.filter((s) => !s.ok).map((s) => `${s.name} (${s.note || s.status})`);
    setStatus('#lookup-status', `${data.title || 'Untitled episode'}: ${data.images.length} photo(s), ${data.audio.length ? 'audio found' : 'no audio found'}.` + (failed.length ? ` Not available: ${failed.join(', ')}.` : ''), !data.audio.length || !data.images.length);
    if (data.guest) $('#guest').value = data.guest;
    const tag = data.title?.match(/\[([^\]]+)\]/)?.[1];
    const ep = data.title?.match(/ep(?:isode)?\.?\s*(\d+)/i)?.[1];
    $('#subtitle').value = [ep && `Ep ${ep}`, tag && titleCase(tag)].filter(Boolean).join(' · ');
    if (data.audio[0]) setAudio(data.audio[0].url);
    state.library = data.images.map((i) => ({ url: i.url, thumb: thumb(i.url), width: i.width, height: i.height }));
    state.story = [];
    refresh();
  } catch (err) {
    setStatus('#lookup-status', `Could not read that page: ${err.message}. You can still paste the audio and photo addresses below.`, true);
  }
});

$('#add-photo').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('#photo-url').value.trim();
  if (!url) return;
  state.library.push({ url, thumb: thumb(url), width: null, height: null });
  $('#photo-url').value = '';
  refresh();
});

function thumb(url) {
  return /squarespace(-cdn)?\.com\//.test(url) ? `${url.split('?')[0]}?format=500w` : url;
}

// ---------- 2. Excerpt ----------
function setAudio(url) { $('#audio-url').value = url; audio.src = url; }
$('#audio-url').addEventListener('change', (e) => { audio.src = e.target.value.trim(); });
const range = () => ({ start: parseTime($('#start').value), end: parseTime($('#end').value) });
document.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => {
  $(`#${b.dataset.set}`).value = fmt(audio.currentTime);
  refresh();
}));
// Update while typing, not on 'change': 'change' fires on blur, i.e. in the
// middle of a click elsewhere, and the re-render would swallow that click.
['#start', '#end'].forEach((s) => $(s).addEventListener('input', refresh));

// ---------- 3. Photos & story ----------
function refresh() {
  const { start, end } = range();
  const len = end - start;
  $('#length').textContent = len > 0 ? fmt(len) : '—';
  renderGallery();
  try {
    state.plan = state.story.length && len > 0
      ? schedule({ duration: len, photos: state.story.map((p, i) => ({ id: i, pin: rel(p.pin) })) })
      : { shots: [], warnings: [] };
  } catch (err) { state.plan = { shots: [], warnings: [err.message] }; }
  renderStory();
  renderTimeline();
  buildLayers();
  drawFrame();
}

function renderGallery() {
  const g = $('#gallery');
  if (!state.library.length) return;
  g.replaceChildren(...state.library.map((p) => {
    const b = el('button', { type: 'button', className: 'thumb' });
    const idx = state.story.findIndex((s) => s.url === p.url);
    b.classList.toggle('on', idx >= 0);
    b.setAttribute('aria-pressed', idx >= 0);
    b.append(el('img', { src: p.thumb, alt: '', loading: 'lazy' }));
    if (idx >= 0) b.append(el('span', { className: 'badge', textContent: idx + 1 }));
    if (p.width) {
      const low = Math.max(p.width, p.height) < 800;
      b.append(el('span', { className: `res${low ? ' low' : ''}`, textContent: `${p.width}×${p.height}`, title: low ? 'Small photo: it will appear smaller on screen' : '' }));
    }
    b.addEventListener('click', () => {
      if (idx >= 0) state.story.splice(idx, 1); else state.story.push({ url: p.url, pin: null });
      refresh();
    });
    return b;
  }));
}

function renderStory() {
  const shots = new Map(state.plan.shots.map((s) => [s.id, s]));
  $('#story-count').textContent = state.story.length ? `${state.story.length} photo(s)` : 'Nothing yet';
  $('#story').replaceChildren(...state.story.map((p, i) => {
    const s = shots.get(i);
    const li = el('li', { className: p.pin != null ? 'pinned' : '' });
    const when = el('div', { className: 'when' });
    when.innerHTML = s ? `${fmt(s.start)} – ${fmt(s.end)}` + (p.pin != null ? ` <b>pinned at ${fmt(rel(p.pin))}</b>` : '') : '';
    const tools = el('div', { className: 'tools' });
    const btn = (label, title, fn) => { const b = el('button', { type: 'button', textContent: label, title }); b.addEventListener('click', () => { fn(); refresh(); }); tools.append(b); };
    btn('↑', 'Earlier', () => i > 0 && state.story.splice(i - 1, 0, state.story.splice(i, 1)[0]));
    btn('↓', 'Later', () => i < state.story.length - 1 && state.story.splice(i + 1, 0, state.story.splice(i, 1)[0]));
    if (p.pin == null) btn('Pin here', 'Show this photo from the current audio position', () => { p.pin = audio.currentTime; });
    else btn('Unpin', '', () => { p.pin = null; });
    btn('✕', 'Remove from story', () => state.story.splice(i, 1));
    li.append(el('img', { src: thumb(p.url), alt: '' }), when, tools);
    return li;
  }));
  $('#warnings').replaceChildren(...state.plan.warnings.map((w) => el('li', { textContent: w })));
}

function renderTimeline() {
  const { start, end } = range();
  const tl = $('#timeline');
  tl.querySelectorAll('.seg').forEach((n) => n.remove());
  for (const s of state.plan.shots) {
    const seg = el('div', { className: `seg${s.pinned ? ' pinned' : ''}` });
    seg.style.flex = `${s.end - s.start} 0 0`;
    seg.style.backgroundImage = `url("${thumb(state.story[s.id].url)}")`;
    tl.append(seg);
  }
  tl.onclick = (e) => {
    const r = tl.getBoundingClientRect();
    audio.currentTime = start + ((e.clientX - r.left) / r.width) * (end - start);
    drawFrame();
  };
}

// ---------- 4. Captions ----------
$('#captions').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) { state.cues = []; return; }
  state.cues = parseCaptions(await file.text());
  const { start, end } = range();
  const inside = clipCues(state.cues, start, end).length;
  setStatus('#captions-status', `${state.cues.length} caption lines read, ${inside} fall inside the excerpt.`, state.cues.length === 0);
});

// ---------- Live preview: same rules as the render, drawn with CSS ----------
let layers = [];
function buildLayers() {
  const box = $('#layers');
  layers = state.plan.shots.map((s, i) => {
    const p = state.story[s.id];
    const layer = el('div', { className: 'layer' });
    const fg = el('div', { className: 'fg' });
    const img = el('img', { src: p.url, alt: '' });
    img.addEventListener('load', () => { layer.dataset.w = img.naturalWidth; layer.dataset.h = img.naturalHeight; place(layer); drawFrame(); }, { once: true });
    fg.append(img);
    layer.append(el('img', { className: 'bgimg', src: thumb(p.url), alt: '' }), fg);
    layer.shot = s; layer.index = i;
    return layer;
  });
  box.replaceChildren(...layers);
}

function place(layer) {
  const p = placement(Number(layer.dataset.w), Number(layer.dataset.h));
  const fg = layer.querySelector('.fg');
  layer.querySelector('.bgimg').hidden = p.fill;
  if (p.fill) { Object.assign(fg.style, { left: '0', top: '0', width: '100%', height: '100%' }); return; }
  const pct = (v, of) => `${(v / of) * 100}%`;
  Object.assign(fg.style, { left: pct(p.x, 1080), top: pct(p.y, 1920), width: pct(p.w, 1080), height: pct(p.h, 1920) });
}

function drawFrame() {
  const { start, end } = range();
  const t = Math.min(Math.max(audio.currentTime - start, 0), Math.max(end - start, 0));
  $('#clock').textContent = `${fmt(t)} / ${fmt(end - start)}`;
  $('#playhead').style.left = `${(t / (end - start || 1)) * 100}%`;
  const shots = state.plan.shots;
  const T = shots.length ? transitionFor(shots) : 0;
  layers.forEach((layer, i) => {
    const s = layer.shot;
    const clipStart = i > 0 ? s.start - T : 0;
    const visible = t >= clipStart && t < s.end + (i === shots.length - 1 ? 1 : 0);
    let alpha = visible ? 1 : 0;
    if (visible && i > 0 && t < s.start) alpha = (t - clipStart) / T;
    layer.style.opacity = alpha;
    layer.style.zIndex = i;
    if (!visible) return;
    const m = motion(i);
    const f = Math.min(1, (t - clipStart) / (s.end - clipStart));
    const z = m.z0 + (m.z1 - m.z0) * f;
    const ox = (1 - 1 / z) * (m.x0 + (m.x1 - m.x0) * f) * 100;
    const oy = (1 - 1 / z) * (m.y0 + (m.y1 - m.y0) * f) * 100;
    layer.querySelector('.fg img').style.transform = `scale(${z}) translate(${-ox}%, ${-oy}%)`;
  });
  const cue = state.cues.find((c) => audio.currentTime >= c.start && audio.currentTime < c.end);
  const cap = $('#ov-caption');
  cap.hidden = !cue || t <= 0 || t >= end - start;
  if (cue) cap.replaceChildren(el('span', { textContent: cue.text }));
  $('#ov-guest').textContent = $('#guest').value;
  $('#ov-sub').textContent = $('#subtitle').value;
}

$('#play').addEventListener('click', () => {
  const { start, end } = range();
  if (!audio.paused) { audio.pause(); return; }
  if (audio.currentTime < start || audio.currentTime >= end) audio.currentTime = start;
  audio.play().catch((err) => setStatus('#lookup-status', `Audio would not play: ${err.message}`, true));
});
audio.addEventListener('play', () => { $('#play').textContent = '❚❚ Pause'; tick(); });
audio.addEventListener('pause', () => { $('#play').textContent = '▶ Play excerpt'; });
audio.addEventListener('seeked', drawFrame);
function tick() {
  drawFrame();
  if (audio.currentTime >= range().end) audio.pause();
  if (!audio.paused) requestAnimationFrame(tick);
}
['#guest', '#subtitle'].forEach((s) => $(s).addEventListener('input', drawFrame));

// ---------- Render ----------
$('#render').addEventListener('click', async () => {
  const { start, end } = range();
  const body = {
    audioUrl: $('#audio-url').value.trim(), start, end,
    photos: state.story.map((p) => ({ url: p.url, pin: rel(p.pin) })),
    guest: $('#guest').value, subtitle: $('#subtitle').value,
    captions: state.cues.length ? (await $('#captions').files[0]?.text()) : null,
    quality: document.querySelector('input[name=quality]:checked').value,
  };
  $('#render').disabled = true;
  $('#job').hidden = false;
  $('#result').hidden = true;
  setStatus('#job-status', 'Sending…');
  try {
    const r = await fetch('/api/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    await poll(data.id);
  } catch (err) {
    setStatus('#job-status', err.message, true);
  } finally {
    $('#render').disabled = false;
  }
});

async function poll(id) {
  for (;;) {
    const j = await (await fetch(`/api/jobs/${id}`)).json();
    $('#job-progress').value = j.progress || 0;
    const words = { queued: `Waiting for another video to finish (${j.queuePosition} ahead)`, downloading: 'Fetching audio and photos…', rendering: `Making the video… ${Math.round((j.progress || 0) * 100)}%` };
    if (j.status === 'failed') throw new Error(`The render failed: ${j.error}`);
    if (j.status === 'done') {
      setStatus('#job-status', `Done in ${Math.round(j.renderSeconds)}s.`);
      $('#result-video').src = `/api/jobs/${id}/video`;
      $('#download').href = `/api/jobs/${id}/video?download=1`;
      $('#result').hidden = false;
      return;
    }
    setStatus('#job-status', words[j.status] || j.status);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ---------- helpers ----------
function rel(pin) { return pin == null ? null : pin - range().start; }
function el(tag, props = {}) { return Object.assign(document.createElement(tag), props); }
function setStatus(sel, text, bad = false) { const n = $(sel); n.textContent = text; n.classList.toggle('bad', bad); }
function titleCase(s) { return s.toLowerCase().replace(/(^|[\s/-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()); }

refresh();

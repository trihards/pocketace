import { schedule, fmt, parseTime } from './schedule.js';
import { parseCaptions, clipCues } from './captions.js';
import { layout, motionFor, rectAt, defaultFit, transitionFor, BACKDROP, SOFT_UPSCALE, WRAP, wrapLines, INTRO, splashRect, W as CW, H as CH } from './look.js';

const $ = (s) => document.querySelector(s);
const state = {
  episode: null,     // {url, title} of the last successful lookup
  library: [],       // every photo we know about: {url, thumb, width, height, local?, name?}
                     // local = imported from Ace's computer, url = /uploads/<hash>.<ext>
  story: [],         // photos in playback order: {id, url}. The same url can appear
                     // any number of times; each appearance has its own id.
  selected: null,    // id of the story photo picked on the strip
  captions: null,    // {name, text} of an optional captions file
  cues: [],
  plan: { shots: [], warnings: [] },
};
const audio = $('#audio');
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
const SECTIONS = ['step-episode', 'step-excerpt', 'step-photos', 'step-story'];
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
    const same = state.episode?.url === data.url;
    state.episode = { url: data.url, title: data.title };
    if (data.guest) $('#guest').value = data.guest;
    const tag = data.title?.match(/\[([^\]]+)\]/)?.[1];
    const ep = data.title?.match(/ep(?:isode)?\.?\s*(\d+)/i)?.[1];
    $('#subtitle').value = [ep && `Ep ${ep}`, tag && titleCase(tag)].filter(Boolean).join(' · ');
    if (data.audio[0]) setAudio(data.audio[0].url);
    // Photos Ace imported stay, whichever episode is looked up.
    const imported = state.library.filter((p) => p.local);
    state.library = [...data.images.map((i) => ({ url: i.url, thumb: thumb(i.url), width: i.width, height: i.height })), ...imported];
    // Looking the same episode up again keeps the story; a new episode starts a fresh one.
    state.story = same ? state.story.filter((p) => state.library.some((l) => l.url === p.url)) : [];
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
  const up = url.match(/^\/uploads\/([0-9a-f]{64})\./);
  if (up) return `/uploads/${up[1]}.thumb.jpg`;
  return /squarespace(-cdn)?\.com\//.test(url) ? `${url.split('?')[0]}?format=500w` : url;
}

// ---------- Photos from Ace's computer ----------
// Each file is uploaded once to the PocketAce server, which keeps the original
// and gives back a lasting address; the saved project only keeps that address.
$('#import-photos').addEventListener('click', () => $('#import-files').click());
$('#import-files').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });

// Drop anywhere on the Photos section (it opens if it was closed). Dropping a
// file elsewhere on the page must not make the browser open it instead.
const photoBox = $('#step-photos');
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;
photoBox.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; photoBox.open = true; photoBox.classList.add('dropping'); });
photoBox.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; photoBox.classList.remove('dropping'); } });
photoBox.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
photoBox.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  photoBox.classList.remove('dropping');
  importFiles(e.dataTransfer.files);
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });

const isHeic = (f) => /^image\/hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name);
const IMAGE_NAME = /\.(jpe?g|png|webp|hei[cf])$/i;

async function importFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const problems = [];
  let added = 0;
  for (const [n, f] of files.entries()) {
    setStatus('#import-status', `Adding ${files.length === 1 ? f.name : `photo ${n + 1} of ${files.length}`}…`);
    if (!f.type.startsWith('image/') && !IMAGE_NAME.test(f.name)) { problems.push(`${f.name} isn't a photo.`); continue; }
    if (f.size > 60e6) { problems.push(`${f.name} is larger than 60 MB. Export a smaller copy and add that.`); continue; }
    let body = f, name = f.name;
    if (isHeic(f)) {
      try { body = await heicToJpeg(f); name = f.name.replace(/\.hei[cf]$/i, '.jpg'); } catch {
        problems.push(`${f.name} is an HEIC photo (Apple's format), and this browser can't open it. Add it from Safari, which converts it, or in Photos choose File › Export › Export 1 Photo with Kind set to JPEG.`);
        continue;
      }
    }
    try {
      const r = await fetch('/api/photos', { method: 'POST', headers: { 'content-type': body.type || 'application/octet-stream', 'x-filename': encodeURIComponent(name) }, body });
      const d = await r.json();
      if (!r.ok) { problems.push(d.error); continue; }
      if (state.library.some((p) => p.url === d.url)) { problems.push(`${name} is already in the gallery.`); continue; }
      state.library.push({ url: d.url, thumb: d.thumb, width: d.width, height: d.height, local: true, name: d.name });
      added++;
      refresh();
    } catch (err) {
      problems.push(`${name} could not be added: ${err.message}`);
    }
  }
  const done = added ? `Added ${added} photo${added === 1 ? '' : 's'}. Tap one to put it in the story.` : '';
  setStatus('#import-status', [done, ...problems].filter(Boolean).join(' '), problems.length > 0);
}

// Safari reads HEIC natively; redraw it at full size and send a JPEG. The
// drawn pixels are already the right way up, so no orientation tag is needed.
async function heicToJpeg(file) {
  const src = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.95));
    if (!blob) throw new Error('could not convert');
    return blob;
  } finally { URL.revokeObjectURL(src); }
}

// The browser keeps imported photos cached, so a file that has gone from the
// computer can still look fine here. Ask the server which ones it still has.
const missing = new Set();
async function checkImported() {
  const local = state.library.filter((p) => p.local);
  await Promise.all(local.map(async (p) => {
    try {
      const r = await fetch(p.url, { method: 'HEAD', cache: 'no-store' });
      if (r.status === 404) missing.add(p.url); else missing.delete(p.url);
    } catch { /* server unreachable: say nothing */ }
  }));
  if (local.length) refresh();
}

function removeImported(url) {
  const p = state.library.find((l) => l.url === url);
  const uses = state.story.filter((s) => s.url === url).length;
  if (uses && !confirm(`Remove ${p?.name || 'this photo'}? It's in your story${uses > 1 ? ` ${uses} times` : ''} and will come out of it too.`)) return;
  state.library = state.library.filter((l) => l.url !== url);
  state.story = state.story.filter((s) => s.url !== url);
  missing.delete(url);
  setStatus('#import-status', `Removed ${p?.name || 'the photo'} from this project.`);
  refresh();
}

// ---------- 2. Excerpt ----------
function setAudio(url) { $('#audio-url').value = url; audio.src = url; }
$('#audio-url').addEventListener('change', (e) => { audio.src = e.target.value.trim(); save(); });
const range = () => ({ start: parseTime($('#start').value), end: parseTime($('#end').value) });
const epLength = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
const MIN_EXCERPT = 1;

// Moves one end of the excerpt, keeping start before end and both inside the
// episode. Everything else (fields, handles, length, story) follows from refresh().
function setBound(which, t) {
  const { start, end } = range();
  const D = epLength() ?? Infinity;
  const lo = which === 'start' ? 0 : (Number.isFinite(start) ? start + MIN_EXCERPT : 0);
  const hi = which === 'start' ? (Number.isFinite(end) ? end - MIN_EXCERPT : D) : D;
  const v = Math.round(Math.min(Math.max(t, lo), hi) * 10) / 10;
  $(`#${which}`).value = fmt(v);
  refresh();
  return v;
}

document.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => setBound(b.dataset.set, audio.currentTime)));
document.querySelectorAll('[data-nudge]').forEach((b) => b.addEventListener('click', () => {
  const t = range()[b.dataset.nudge];
  if (Number.isFinite(t)) setBound(b.dataset.nudge, t + Number(b.dataset.by));
}));
// Update while typing, not on 'change': 'change' fires on blur, i.e. in the
// middle of a click elsewhere, and the re-render would swallow that click.
['#start', '#end'].forEach((s) => $(s).addEventListener('input', refresh));

// The range bar: the whole episode, the excerpt in gold, playback as a white line.
for (const which of ['start', 'end']) {
  const h = $(`#h-${which}`);
  h.addEventListener('pointerdown', (e) => {
    if (!epLength() || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    h.focus();
    h.setPointerCapture(e.pointerId);
    h.classList.add('active');
    let t = range()[which];
    let lastX = e.clientX;
    // Relative movement, so the handle never jumps under the pointer; with
    // Shift held it moves at a twentieth of the speed for fine adjustments.
    const move = (ev) => {
      const w = $('#range').getBoundingClientRect().width;
      t += ((ev.clientX - lastX) / w) * epLength() * (ev.shiftKey ? 0.05 : 1);
      lastX = ev.clientX;
      t = setBound(which, t);
    };
    const up = () => {
      h.classList.remove('active');
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      h.removeEventListener('pointercancel', up);
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
  });
  h.addEventListener('keydown', (e) => {
    const t = range()[which];
    if (!epLength() || !Number.isFinite(t)) return;
    const step = e.altKey ? 0.1 : e.shiftKey ? 10 : 1;
    const to = { ArrowLeft: t - step, ArrowDown: t - step, ArrowRight: t + step, ArrowUp: t + step, PageDown: t - 60, PageUp: t + 60, Home: 0, End: epLength() }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    setBound(which, to);
  });
}
// Clicking or dragging on the bar itself moves playback, not the excerpt.
$('#range').addEventListener('pointerdown', (e) => {
  if (!epLength() || e.button !== 0) return;
  const bar = $('#range');
  leaveExcerpt();
  const seek = (ev) => {
    const r = bar.getBoundingClientRect();
    audio.currentTime = Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1) * epLength();
    drawPlayback();
    drawFrame();
  };
  bar.setPointerCapture(e.pointerId);
  seek(e);
  bar.addEventListener('pointermove', seek);
  const up = () => { bar.removeEventListener('pointermove', seek); bar.removeEventListener('pointerup', up); };
  bar.addEventListener('pointerup', up);
});

function renderRange() {
  const D = epLength();
  const { start, end } = range();
  $('#range').classList.toggle('off', !D);
  $('#range-dur').textContent = D ? fmtShort(D) : '';
  $('#range-note').textContent = D ? 'Drag the gold handles. Hold Shift while dragging for fine moves.' : (audio.src ? 'Loading the episode audio…' : 'The excerpt bar appears once the episode audio loads.');
  if (!D) return;
  const pct = (t) => `${(Math.min(Math.max(t, 0), D) / D) * 100}%`;
  const ok = Number.isFinite(start) && Number.isFinite(end) && end > start;
  const sel = $('#range-sel');
  sel.hidden = !ok;
  if (ok) Object.assign(sel.style, { left: pct(start), width: `${((Math.min(end, D) - Math.min(start, D)) / D) * 100}%` });
  for (const [which, t] of [['start', start], ['end', end]]) {
    const h = $(`#h-${which}`);
    h.hidden = !Number.isFinite(t);
    if (!Number.isFinite(t)) continue;
    h.style.left = pct(t);
    h.setAttribute('aria-valuemin', '0');
    h.setAttribute('aria-valuemax', String(Math.round(D)));
    h.setAttribute('aria-valuenow', String(t));
    h.setAttribute('aria-valuetext', fmt(t));
    h.querySelector('.tip').textContent = fmt(t);
  }
  drawPlayback();
}
function drawPlayback() {
  const D = epLength();
  if (D) $('#range-play').style.left = `${(audio.currentTime / D) * 100}%`;
}
audio.addEventListener('loadedmetadata', refresh);
audio.addEventListener('timeupdate', drawPlayback);

// ---------- 3 + 4. Photos and the story ----------
function refresh() {
  const { start, end } = range();
  const len = end - start;
  $('#length').textContent = len > 0 ? fmt(len) : '—';
  if (state.selected && !state.story.some((p) => p.id === state.selected)) state.selected = null;
  boundsChanged(start, end);
  try {
    state.plan = state.story.length && len > 0
      ? schedule({ duration: len, photos: state.story.map((p, i) => ({ id: i })) })
      : { shots: [], warnings: [] };
  } catch (err) { state.plan = { shots: [], warnings: [err.message] }; }
  renderGallery();
  renderRange();
  renderStrip();
  const gone = state.story.map((p, i) => (missing.has(p.url) ? i + 1 : 0)).filter(Boolean);
  const warnings = [...(gone.length ? [`Photo${gone.length > 1 ? 's' : ''} ${gone.join(', ')} ${gone.length > 1 ? 'were' : 'was'} imported but ${gone.length > 1 ? 'are' : 'is'} no longer on this computer. Remove ${gone.length > 1 ? 'them' : 'it'} in Photos and add ${gone.length > 1 ? 'them' : 'it'} again.`] : []), ...state.plan.warnings];
  $('#warnings').replaceChildren(...warnings.map((w) => el('li', { textContent: w })));
  buildLayers();
  drawFrame();
  renderSummaries();
  renderButtons();
  renderIntroOption();
  save();
}
function renderIntroOption() {
  $('#intro-opt').hidden = !intro.available;
  const len = excerptLength();
  $('#intro-len').textContent = intro.available ? `adds ${Math.round(intro.duration)} s${len ? ` · video ${fmtShort(intro.duration * $('#intro').checked + len)}` : ''}` : '';
}

function renderGallery() {
  const g = $('#gallery');
  if (!state.library.length) {
    g.replaceChildren(el('p', { className: 'empty', textContent: 'Photos from the episode page appear here. To add your own, drop them here or use Add photos.' }));
    return;
  }
  g.replaceChildren(...state.library.map((p) => {
    const item = el('div', { className: `gitem${p.local ? ' local' : ''}${missing.has(p.url) ? ' missing' : ''}` });
    const b = el('button', { type: 'button', className: 'thumb' });
    const uses = state.story.filter((s) => s.url === p.url).length;
    b.classList.toggle('on', uses > 0);
    if (p.url === justAdded) b.classList.add('added');
    b.setAttribute('aria-label', `Add to the end of the story${uses ? ` (in it ${uses === 1 ? 'once' : `${uses} times`} already)` : ''}`);
    const img = el('img', { src: p.thumb || thumb(p.url), alt: '', loading: 'lazy' });
    if (p.local) img.addEventListener('error', () => { item.classList.add('missing'); b.title = `${p.name || 'This photo'} is no longer on this computer. Remove it and add it again.`; }, { once: true });
    b.append(img);
    if (uses) b.append(el('span', { className: 'badge', textContent: `×${uses}`, title: `In the story ${uses === 1 ? 'once' : `${uses} times`}` }));
    if (p.width) {
      const low = Math.max(p.width, p.height) < 800;
      b.append(el('span', { className: `res${low ? ' low' : ''}`, textContent: `${p.width}×${p.height}`, title: low ? 'Small original: it will look soft at full size' : '' }));
    }
    b.addEventListener('click', () => addToStory(p.url));
    item.append(b);
    if (p.local) {
      if (p.name) b.title ||= p.name;
      item.append(el('span', { className: 'mine', textContent: 'Yours' }));
      const x = el('button', { type: 'button', className: 'remove', textContent: '✕', title: 'Remove from this project' });
      x.setAttribute('aria-label', `Remove ${p.name || 'this photo'} from this project`);
      x.addEventListener('click', () => removeImported(p.url));
      item.append(x);
    }
    return item;
  }));
}

// Each tap adds the photo once more, at the end. The tile pulses so the tap
// visibly did something even when the strip is out of view.
let justAdded = null;
function addToStory(url) {
  state.story.push({ id: newId(), url });
  justAdded = url;
  refresh();
  justAdded = null;
  $('#strip-live').textContent = `Added as photo ${state.story.length} of ${state.story.length}.`;
  const wrap = $('#strip-wrap');
  wrap.scrollLeft = wrap.scrollWidth;
}

// The story strip: one tile per photo, in playback order, each as wide as its
// share of the excerpt. Tile widths come straight from the scheduled shots, so
// the day shot lengths become adjustable, dragging the edge between two tiles
// is the only new interaction needed.
let stripKey = '';
function renderStrip() {
  const strip = $('#strip');
  const shots = state.plan.shots;
  const key = state.story.map((p) => p.id).join('\n');
  if (key !== stripKey) {
    stripKey = key;
    strip.replaceChildren(...state.story.map((p, i) => {
      const li = el('li', { className: 'cell' });
      const b = el('button', { type: 'button', className: 'tile' });
      b.dataset.index = i;
      b.style.backgroundImage = `url("${thumb(p.url)}")`;
      b.append(el('span', { className: 'num', textContent: i + 1 }), el('span', { className: 'dur' }));
      const x = el('button', { type: 'button', className: 'x', textContent: '✕', title: 'Take this photo out of the story' });
      x.setAttribute('aria-label', `Take photo ${i + 1} out of the story`);
      x.tabIndex = -1; // keyboard users have Delete on the tile
      x.addEventListener('click', () => removeFromStory(i));
      li.append(b, x);
      return li;
    }));
  }
  const tiles = [...strip.querySelectorAll('.tile')];
  const sel = selectedIndex();
  tiles.forEach((b, i) => {
    const s = shots[i];
    const d = s ? s.end - s.start : 1;
    b.parentElement.style.flexGrow = String(d);
    b.querySelector('.dur').textContent = s ? fmtShort(d) : '';
    b.classList.toggle('sel', i === sel);
    b.classList.toggle('filled', fitOf(state.story[i]) === 'fill');
    b.setAttribute('aria-pressed', i === sel);
    b.tabIndex = i === (sel >= 0 ? sel : 0) ? 0 : -1;
    b.setAttribute('aria-label', `Photo ${i + 1} of ${tiles.length}` + (s ? `, ${fmt(s.start)} to ${fmt(s.end)}` : ''));
  });
  const has = state.story.length > 0;
  $('#strip-wrap').hidden = !has;
  $('#strip-empty').hidden = has;
  $('#strip-tools').hidden = sel < 0;
  if (sel >= 0) {
    const s = shots[sel];
    $('#sel-info').textContent = `Photo ${sel + 1} of ${state.story.length}` + (s ? ` · ${fmt(s.start)}–${fmt(s.end)}` : '');
    renderFitTools(state.story[sel]);
    $('#move-earlier').disabled = sel === 0;
    $('#move-later').disabled = sel === state.story.length - 1;
  }
  drawStripPlayhead();
}

function moveStory(from, to, announce = true) {
  if (to < 0 || to >= state.story.length || from === to) return;
  const [p] = state.story.splice(from, 1);
  state.story.splice(to, 0, p);
  state.selected = p.id;
  refresh();
  if (announce) $('#strip-live').textContent = `Moved to position ${to + 1} of ${state.story.length}.`;
}
function removeFromStory(i) {
  const [p] = state.story.splice(i, 1);
  const next = state.story[Math.min(i, state.story.length - 1)];
  state.selected = next?.id ?? null;
  refresh();
  $('#strip-live').textContent = `Took photo ${i + 1} out. ${state.story.length} left.`;
  return p;
}
const selectedIndex = () => state.story.findIndex((p) => p.id === state.selected);
const focusTile = (i) => $(`#strip .tile[data-index="${i}"]`)?.focus();

$('#move-earlier').addEventListener('click', () => moveStory(selectedIndex(), selectedIndex() - 1));
$('#move-later').addEventListener('click', () => moveStory(selectedIndex(), selectedIndex() + 1));
$('#remove-photo').addEventListener('click', () => removeFromStory(selectedIndex()));

const strip = $('#strip');
strip.addEventListener('keydown', (e) => {
  const b = e.target.closest('.tile');
  if (!b) return;
  const i = Number(b.dataset.index);
  const n = state.story.length;
  let handled = true;
  if (e.altKey && e.key === 'ArrowLeft') { moveStory(i, i - 1); focusTile(Math.max(i - 1, 0)); }
  else if (e.altKey && e.key === 'ArrowRight') { moveStory(i, i + 1); focusTile(Math.min(i + 1, n - 1)); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
    const j = { ArrowLeft: Math.max(i - 1, 0), ArrowRight: Math.min(i + 1, n - 1), Home: 0, End: n - 1 }[e.key];
    selectTile(j, 0);
    focusTile(j);
  } else if (e.key === 'Delete' || e.key === 'Backspace') { removeFromStory(i); focusTile(Math.min(i, state.story.length - 1)); }
  else handled = false;
  if (handled) e.preventDefault();
});

// Pick a tile and move the excerpt preview to a point inside it (0..1 across
// the tile). Play excerpt then carries on from there.
function selectTile(i, frac) {
  const s = state.plan.shots[i];
  state.selected = state.story[i]?.id ?? null;
  if (s) setPreviewTime(s.start + Math.min(Math.max(frac, 0), 0.999) * (s.end - s.start));
  renderStrip();
  drawFrame();
  save();
}

// Drag to reorder. Pointer events rather than HTML drag-and-drop: one code
// path for mouse, trackpad and touch, and full control over what it looks like.
let drag = null;
let swallowClick = false;
strip.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('.tile');
  if (!b || e.button !== 0) return;
  drag = { from: Number(b.dataset.index), tile: b, x0: e.clientX, y0: e.clientY, id: e.pointerId, active: false, to: null };
});
strip.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
    drag.active = true;
    strip.setPointerCapture(e.pointerId);
    drag.tile.classList.add('lifted');
    drag.ghost = el('div', { className: 'ghost' });
    drag.ghost.style.backgroundImage = drag.tile.style.backgroundImage;
    document.body.append(drag.ghost);
    document.body.classList.add('dragging');
  }
  drag.ghost.style.transform = `translate(${e.clientX - 36}px, ${e.clientY - 30}px)`;
  // Where it would land: count the other tiles whose middle is left of the pointer.
  const others = [...strip.querySelectorAll('.tile')].filter((t) => t !== drag.tile);
  let to = 0;
  for (const t of others) { const r = t.getBoundingClientRect(); if (e.clientX > r.left + r.width / 2) to++; }
  drag.to = to;
  const wrap = $('#strip-wrap');
  const wr = wrap.getBoundingClientRect();
  const edge = to < others.length ? others[to].parentElement.offsetLeft : (others.length ? others.at(-1).parentElement.offsetLeft + others.at(-1).parentElement.offsetWidth : 0);
  const marker = $('#strip-marker');
  marker.hidden = false;
  marker.style.left = `${edge - 2}px`;
  // Scroll a long strip when dragging near its edges.
  if (e.clientX < wr.left + 30) wrap.scrollLeft -= 12;
  else if (e.clientX > wr.right - 30) wrap.scrollLeft += 12;
});
const endDrag = (e, cancelled) => {
  if (!drag || (e && e.pointerId !== drag.id)) return;
  const d = drag;
  drag = null;
  if (!d.active) return;
  // Some browsers follow a drag with a click on the tile; that click is not a
  // click. Others don't, so only ignore one that arrives straight away.
  swallowClick = true;
  setTimeout(() => { swallowClick = false; });
  d.tile.classList.remove('lifted');
  d.ghost.remove();
  document.body.classList.remove('dragging');
  $('#strip-marker').hidden = true;
  if (!cancelled && d.to !== null && d.to !== d.from) moveStory(d.from, d.to);
  else { state.selected = state.story[d.from].id; renderStrip(); }
  focusTile(selectedIndex());
};
strip.addEventListener('pointerup', (e) => endDrag(e, false));
strip.addEventListener('pointercancel', (e) => endDrag(e, true));
strip.addEventListener('click', (e) => {
  const b = e.target.closest('.tile');
  if (!b) return;
  if (swallowClick) { swallowClick = false; return; }
  const r = b.getBoundingClientRect();
  selectTile(Number(b.dataset.index), e.detail === 0 ? 0 : (e.clientX - r.left) / r.width);
});

function drawStripPlayhead() {
  const ph = $('#strip-playhead');
  const t = Math.min(previewTime(), Math.max(excerptLength() - 1e-3, 0));
  const shots = state.plan.shots;
  const i = shots.findIndex((s) => t >= s.start && t < s.end);
  const cell = $(`#strip .tile[data-index="${i}"]`)?.parentElement;
  ph.hidden = !cell;
  if (!cell) return;
  const s = shots[i];
  ph.style.left = `${cell.offsetLeft + ((t - s.start) / (s.end - s.start)) * cell.offsetWidth}px`;
}

// ---------- How each photo is shown: whole, or filling the frame ----------
// Each copy in the story has its own choice. Until Ace picks, look.js decides
// (photos already close to 9:16 fill, everything else is shown whole).
function dimsOf(item) {
  const layer = layers.find((l) => l.item === item);
  if (layer?.dims) return layer.dims;
  const lib = state.library.find((l) => l.url === item.url);
  return lib?.width ? { width: lib.width, height: lib.height } : null;
}
function fitOf(item) {
  if (!item) return null;
  if (item.fit) return item.fit;
  const d = dimsOf(item);
  return d ? defaultFit(d.width, d.height) : 'whole';
}
function renderFitTools(item) {
  const fit = fitOf(item);
  document.querySelectorAll('[data-fit]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fit === fit)));
  const d = dimsOf(item);
  const soft = fit === 'fill' && d && layoutOf(item, d).upscale > SOFT_UPSCALE;
  $('#fit-hint').textContent = fit === 'fill'
    ? `Drag the photo in the preview to choose what shows.${soft ? ' This photo is small, so filling the frame makes it soft.' : ''}`
    : 'The entire photo, nothing cut off.';
  $('#recentre').hidden = fit !== 'fill' || (item.fx === undefined && item.fy === undefined);
}
document.querySelectorAll('[data-fit]').forEach((b) => b.addEventListener('click', () => {
  const i = selectedIndex();
  if (i < 0) return;
  state.story[i].fit = b.dataset.fit;
  showShot(i);
  refresh();
}));
$('#recentre').addEventListener('click', () => {
  const i = selectedIndex();
  if (i < 0) return;
  delete state.story[i].fx; delete state.story[i].fy;
  showShot(i);
  refresh();
});
// Bring a shot into the preview unless it is already on screen.
function showShot(i) {
  const s = state.plan.shots[i];
  const t = previewTime();
  if (s && !(t >= s.start && t < s.end)) setPreviewTime(s.start + Math.min(1, (s.end - s.start) / 3));
}
// The photo on screen at the preview's moment (the incoming one during a fade).
function onScreen() {
  const t = previewTime();
  const i = state.plan.shots.findIndex((s) => t >= s.start && t < s.end);
  return i >= 0 && layers[i]?.dims ? layers[i] : null;
}

// Drag a filled photo in the preview (or use the arrow keys) to move what shows.
// The focus point is set from where the crop actually lands, so dragging past
// an edge never builds up slack that has to be dragged back first.
function moveFocus(layer, dx, dy) {
  const item = layer.item;
  const L = layoutOf(item, layer.dims);
  const x = Math.min(Math.max(L.rect.x + dx, CW - L.rect.w), 0);
  const y = Math.min(Math.max(L.rect.y + dy, CH - L.rect.h), 0);
  item.fx = (CW / 2 - x) / L.rect.w;
  item.fy = (CH / 2 - y) / L.rect.h;
}
const stage = $('#stage');
stage.addEventListener('pointerdown', (e) => {
  const layer = onScreen();
  if (!layer || fitOf(layer.item) !== 'fill' || e.button !== 0) return;
  e.preventDefault();
  stage.setPointerCapture(e.pointerId);
  stage.classList.add('dragging-photo');
  state.selected = layer.item.id;
  if (!layer.item.fit) layer.item.fit = 'fill';
  let last = { x: e.clientX, y: e.clientY };
  const scale = CW / stage.getBoundingClientRect().width;
  const move = (ev) => {
    moveFocus(layer, (ev.clientX - last.x) * scale, (ev.clientY - last.y) * scale);
    last = { x: ev.clientX, y: ev.clientY };
    drawFrame();
  };
  const up = () => {
    stage.classList.remove('dragging-photo');
    stage.removeEventListener('pointermove', move);
    stage.removeEventListener('pointerup', up);
    stage.removeEventListener('pointercancel', up);
    refresh();
  };
  stage.addEventListener('pointermove', move);
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
});
stage.addEventListener('keydown', (e) => {
  const layer = onScreen();
  const d = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
  if (!layer || !d || fitOf(layer.item) !== 'fill') return;
  e.preventDefault();
  const step = e.shiftKey ? 120 : 24; // canvas pixels; arrows move the view, so the photo goes the other way
  if (!layer.item.fit) layer.item.fit = 'fill';
  state.selected = layer.item.id;
  moveFocus(layer, d[0] * step, d[1] * step);
  refresh();
});

// ---------- Captions (optional, kept low-key) ----------
$('#captions').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setCaptions({ name: file.name, text: await file.text() });
  refresh();
});
function setCaptions(c) {
  state.captions = c;
  state.cues = c ? parseCaptions(c.text) : [];
  if (!c) { setStatus('#captions-status', ''); return; }
  const { start, end } = range();
  const inside = clipCues(state.cues, start, end).length;
  setStatus('#captions-status', `${c.name}: ${state.cues.length} caption lines, ${inside} inside the excerpt.`, state.cues.length === 0);
}

// ---------- Live preview: same rules as the render, drawn with CSS ----------
let layers = [];
let layersKey = '';
function buildLayers() {
  const key = state.story.map((p) => p.id).join('\n');
  if (key === layersKey && layers.length === state.plan.shots.length) {
    layers.forEach((layer, i) => { layer.shot = state.plan.shots[i]; });
    return;
  }
  layersKey = key;
  const box = $('#layers');
  layers = state.plan.shots.map((s, i) => {
    const p = state.story[s.id];
    const layer = el('div', { className: 'layer' });
    const fg = el('div', { className: 'fg' });
    const img = el('img', { src: p.url, alt: '', draggable: false });
    img.addEventListener('load', () => { layer.dims = { width: img.naturalWidth, height: img.naturalHeight }; drawFrame(); renderStrip(); }, { once: true });
    fg.append(img);
    const bg = el('img', { className: 'bgimg', src: thumb(p.url), alt: '' });
    bg.style.filter = BACKDROP.css;
    layer.append(bg, fg);
    layer.shot = s; layer.index = i; layer.item = p;
    return layer;
  });
  box.replaceChildren(...layers);
}

// The same geometry as the render: look.js says where the image is drawn at
// this moment (rect) and which part of the canvas it may show in (clip).
function layoutOf(item, dims) { return layout({ ...dims, fit: item.fit, fx: item.fx, fy: item.fy }); }
function place(layer, f, clipSeconds) {
  const L = layoutOf(layer.item, layer.dims);
  const R = rectAt(L, motionFor(L, clipSeconds, layer.index), f);
  const C = L.clip;
  const pct = (v, of) => `${(v / of) * 100}%`;
  layer.querySelector('.bgimg').hidden = L.fit === 'fill';
  Object.assign(layer.querySelector('.fg').style, { left: pct(C.x, CW), top: pct(C.y, CH), width: pct(C.w, CW), height: pct(C.h, CH) });
  Object.assign(layer.querySelector('.fg img').style, { left: pct(R.x - C.x, C.w), top: pct(R.y - C.y, C.h), width: pct(R.w, C.w), height: pct(R.h, C.h) });
}

function drawFrame() {
  const { start, end } = range();
  const t = previewTime();
  // The clock counts the whole video: intro (if on) plus the excerpt.
  const I = introLength();
  const inIntro = introInProgress();
  // At rest at the very start of the story, the next Play starts the intro: 0:00.
  const v = inIntro ? Math.min(introAudio.currentTime, I) : (I && !excerptPlay && previewAt < 0.05 ? 0 : I + t);
  $('#clock').textContent = `${fmt(v)} / ${fmt(I + Math.max(end - start, 0))}`;
  drawIntroCard(inIntro ? introAudio.currentTime : null);
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
    if (!visible || !layer.dims) return;
    const f = Math.min(1, (t - clipStart) / (s.end - clipStart));
    place(layer, f, s.end - clipStart);
  });
  $('#stage').classList.toggle('can-drag', fitOf(onScreen()?.item) === 'fill');
  const cue = state.cues.find((c) => start + t >= c.start && start + t < c.end);
  const cap = $('#ov-caption');
  cap.hidden = !cue || t <= 0 || t >= end - start;
  if (cue) cap.replaceChildren(el('span', { textContent: cue.text }));
  // Broken into lines exactly as the render breaks them.
  $('#ov-guest').textContent = wrapLines($('#guest').value.toUpperCase(), WRAP.guest).join('\n');
  $('#ov-sub').textContent = wrapLines($('#subtitle').value, WRAP.subtitle).join('\n');
  drawStripPlayhead();
}

// Two ways to listen, one audio element:
//  - The episode player in Excerpt is for exploring the whole recording. It
//    plays and seeks freely and never moves the excerpt preview.
//  - "Play excerpt" previews the selection: it starts at Start (or at the
//    photo last clicked on the strip), stops at End, and the preview, strip
//    playhead and clock follow it.
// The preview keeps its own position, `previewAt` (seconds into the excerpt).
// It goes back to 0 whenever Start or End changes and when playback reaches End.
let previewAt = 0;
let excerptPlay = false;
let ownSeek = false;
let lastBounds = '';
const excerptLength = () => { const { start, end } = range(); return end > start ? end - start : 0; };
function previewTime() { return Math.min(Math.max(previewAt, 0), excerptLength()); }
function setPreviewTime(t) {
  stopIntro();
  previewAt = Math.min(Math.max(t, 0), excerptLength());
  if (excerptPlay) seekAudio(range().start + previewAt);
}
function seekAudio(t) { ownSeek = true; audio.currentTime = t; }
function boundsChanged(start, end) {
  const b = `${start}|${end}`;
  if (b === lastBounds) return;
  const startMoved = lastBounds && lastBounds.split('|')[0] !== String(start);
  lastBounds = b;
  previewAt = 0;
  stopIntro();
  measureExcerpt();
  // Playing the excerpt while Start moves: carry on from the new Start.
  if (excerptPlay && startMoved && Number.isFinite(start)) seekAudio(start);
}
function leaveExcerpt() {
  if (!excerptPlay) return;
  excerptPlay = false; // previewAt keeps the last moment the excerpt really played
  setPlayButton();
}
// While the excerpt plays, previewAt follows the audio only as it plays on
// (small steps forward). A jump nobody here asked for is someone exploring
// the episode: let the excerpt go and leave the preview where it was. By the
// time the browser reports a seek, the audio is already at the new place, so
// this check is what tells the two apart. Runs every frame and on timeupdate
// (which keeps going when frames are throttled, e.g. in a background tab).
function follow() {
  if (!excerptPlay || audio.paused) return;
  const t = audio.currentTime - range().start;
  if (t < previewAt - 0.25 || t > previewAt + 3) { if (!ownSeek) leaveExcerpt(); return; }
  if (t >= excerptLength()) { previewAt = excerptLength(); finishing = true; audio.pause(); return; }
  previewAt = Math.max(t, 0);
}
function setPlayButton() {
  $('#play').textContent = (excerptPlay && !audio.paused) || !introAudio.paused ? '❚❚ Pause excerpt' : '▶ Play excerpt';
}

// ---------- The show intro (optional, on by default) ----------
// Fixed packaging, not part of the story: the splash plays over the intro
// audio, crossfading into the story's first frame in its last INTRO.fade
// seconds; then the excerpt starts at Start, as in the render. The preview
// plays it when Play excerpt starts from the beginning of the story.
const introAudio = $('#intro-audio');
const intro = { available: false, duration: 0, lufs: null, gain: 0.5 };
const introOn = () => intro.available && $('#intro').checked;
const introLength = () => (introOn() ? intro.duration : 0);
const introInProgress = () => introOn() && introAudio.currentTime > 0 && introAudio.currentTime < intro.duration && !introAudio.ended;
function stopIntro() {
  if (introAudio.currentTime === 0 && introAudio.paused) return;
  introAudio.pause();
  introAudio.currentTime = 0;
  setPlayButton();
  drawFrame();
}
function drawIntroCard(at) {
  const card = $('#intro-card');
  card.hidden = at === null;
  if (at === null) return;
  const img = $('#intro-splash');
  if (img.naturalWidth) {
    const r = splashRect(img.naturalWidth, img.naturalHeight);
    const pct = (val, of) => `${(val / of) * 100}%`;
    Object.assign(img.style, { left: pct(r.x, CW), top: pct(r.y, CH), width: pct(r.w, CW), height: pct(r.h, CH) });
  }
  card.style.background = INTRO.background;
  const X = Math.min(INTRO.fade, intro.duration / 2);
  card.style.opacity = String(Math.min(1, Math.max(0, (intro.duration - at) / X)));
}
function playIntro() {
  audio.pause();
  introAudio.volume = intro.gain * audio.volume; // levelled to the excerpt, like the render
  introAudio.play().then(() => { setPlayButton(); introTick(); }).catch((err) => setStatus('#lookup-status', `The intro would not play: ${err.message}`, true));
}
function introTick() {
  if (introAudio.paused) return;
  if (introAudio.currentTime >= intro.duration - 0.02) { finishIntro(); return; }
  drawFrame();
  requestAnimationFrame(introTick);
}
function finishIntro() {
  introAudio.pause();
  introAudio.currentTime = 0;
  previewAt = 0;
  seekAudio(range().start);
  excerptPlay = true;
  audio.play().catch((err) => { excerptPlay = false; setPlayButton(); setStatus('#lookup-status', `Audio would not play: ${err.message}`, true); });
  setPlayButton();
}
introAudio.addEventListener('ended', () => { if (introOn()) finishIntro(); });
introAudio.addEventListener('pause', setPlayButton);
$('#intro').addEventListener('change', () => { stopIntro(); refresh(); });

// How loud the excerpt is, so the preview can play the intro at a matching
// level (the render levels both to -16 LUFS). Measured on the server once the
// excerpt stops changing; until then the intro plays at half volume.
let loudTimer = null, loudKey = '';
function measureExcerpt() {
  const { start, end } = range();
  const url = $('#audio-url').value.trim();
  const key = `${url}|${start}|${end}`;
  if (!intro.available || !url || !(end > start) || key === loudKey) return;
  clearTimeout(loudTimer);
  loudTimer = setTimeout(async () => {
    loudKey = key;
    try {
      const r = await (await fetch(`/api/loudness?url=${encodeURIComponent(url)}&start=${start}&end=${end}`)).json();
      if (Number.isFinite(r.lufs) && Number.isFinite(intro.lufs) && loudKey === key) intro.gain = Math.min(1, 10 ** ((r.lufs - intro.lufs) / 20));
    } catch { loudKey = ''; }
  }, 1500);
}

$('#play').addEventListener('click', () => {
  if (!introAudio.paused) { introAudio.pause(); return; }
  if (excerptPlay && !audio.paused) { audio.pause(); return; }
  const { start } = range();
  const len = excerptLength();
  if (!len) return;
  // From the very start of the story (or mid-intro), the intro comes first.
  if (introOn() && (introInProgress() || previewAt < 0.05)) { playIntro(); return; }
  if (previewAt >= len - 0.05) previewAt = 0;
  seekAudio(start + previewAt);
  excerptPlay = true;
  setPlayButton();
  // Already playing (from the episode player)? The running frame loop just
  // carries on, now as the excerpt.
  if (audio.paused) audio.play().catch((err) => { excerptPlay = false; setPlayButton(); setStatus('#lookup-status', `Audio would not play: ${err.message}`, true); });
});
let finishing = false;
audio.addEventListener('play', () => { setPlayButton(); tick(); });
audio.addEventListener('pause', () => {
  if (excerptPlay) {
    if (finishing) previewAt = 0;
    excerptPlay = false;
  }
  finishing = false;
  setPlayButton();
  drawFrame();
});
// A seek we didn't make came from the episode player: that's exploring the
// episode, so the excerpt preview lets go and stays where it was.
audio.addEventListener('seeking', () => { if (!ownSeek) leaveExcerpt(); });
audio.addEventListener('seeked', () => { ownSeek = false; drawFrame(); drawPlayback(); });
audio.addEventListener('timeupdate', follow);
function tick() {
  follow();
  drawFrame();
  drawPlayback();
  if (!audio.paused) requestAnimationFrame(tick);
}
['#guest', '#subtitle'].forEach((s) => $(s).addEventListener('input', () => { drawFrame(); renderSummaries(); renderButtons(); save(); }));
document.querySelectorAll('input[name=quality]').forEach((r) => r.addEventListener('change', () => { renderButtons(); save(); }));

// ---------- Section summaries (shown beside each heading) ----------
function renderSummaries() {
  const { start, end } = range();
  const len = end - start;
  $('#sum-episode').textContent = state.episode ? episodeLabel(state.episode.title) : 'No episode yet';
  $('#sum-excerpt').textContent = len > 0 ? `${fmtShort(start)}–${fmtShort(end)} · ${fmtShort(len)} selected` : 'Set a start and an end';
  const used = new Set(state.story.map((p) => p.url)).size;
  $('#sum-photos').textContent = state.library.length ? `${state.library.length} available · ${used} in the story` : 'No photos yet';
  $('#sum-story').textContent = state.story.length ? `${state.story.length} photo${state.story.length === 1 ? '' : 's'}${len > 0 ? ` · ${fmtShort(len)} total` : ''}` : 'Nothing to arrange yet';
}
// "Episode 29: Rustee Allen & Levi Seacer Jr. [P-FUNK]" → "Episode 29 · Rustee Allen & Levi Seacer Jr."
function episodeLabel(title) {
  if (!title) return 'Untitled episode';
  const n = title.match(/^\s*ep(?:isode)?\.?\s*(\d+)\s*[:.\-–—]?\s*/i);
  const rest = title.slice(n ? n[0].length : 0).replace(/\s*\[[^\]]*\]\s*$/, '').trim();
  return n ? `Episode ${n[1]} · ${rest}` : rest || title;
}
SECTIONS.forEach((id) => $(`#${id}`).addEventListener('toggle', save));

// ---------- Autosave ----------
// One project, kept in this browser's localStorage under SAVE_KEY. Written a
// moment after every change; read back on load. See README "Saved work".
const SAVE_KEY = 'pocketace.project.v1';
let saveTimer = null;
let restoring = false;
function save() {
  if (restoring) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeSave, 300);
}
function writeSave() {
  const project = {
    v: 1,
    savedAt: new Date().toISOString(),
    episodeUrl: $('#episode-url').value,
    episode: state.episode,
    audioUrl: $('#audio-url').value,
    start: $('#start').value,
    end: $('#end').value,
    library: state.library,
    story: state.story.map((p) => ({ id: p.id, url: p.url, fit: p.fit, fx: p.fx, fy: p.fy })),
    selected: state.selected,
    guest: $('#guest').value,
    subtitle: $('#subtitle').value,
    quality: document.querySelector('input[name=quality]:checked').value,
    intro: $('#intro').checked,
    captions: state.captions && state.captions.text.length < 1e6 ? state.captions : null,
    open: Object.fromEntries(SECTIONS.map((id) => [id, $(`#${id}`).open])),
    playhead: audio.currentTime || 0,
    lastRender: job.last,
  };
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(project));
    setSaved(`Saved ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
  } catch (err) {
    setSaved('Not saved: this browser is blocking storage', true);
  }
}
function setSaved(text, bad = false) { const n = $('#save-status'); n.textContent = text; n.classList.toggle('bad', bad); }

function restore() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch { p = null; }
  if (!p || p.v !== 1) return false;
  restoring = true;
  $('#episode-url').value = p.episodeUrl || '';
  state.episode = p.episode || null;
  state.library = Array.isArray(p.library) ? p.library : [];
  // Saves from before repeats existed have no ids; give each appearance one.
  const seen = new Set();
  state.story = Array.isArray(p.story) ? p.story.filter((s) => s && s.url).map((s) => {
    const id = s.id && !seen.has(s.id) ? s.id : newId();
    seen.add(id);
    const unit = (v) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : undefined);
    return { id, url: s.url, fit: s.fit === 'whole' || s.fit === 'fill' ? s.fit : undefined, fx: unit(s.fx), fy: unit(s.fy) };
  }) : [];
  state.selected = p.selected || null;
  $('#start').value = p.start ?? '0:00.0';
  $('#end').value = p.end ?? '1:00.0';
  $('#guest').value = p.guest || '';
  $('#subtitle').value = p.subtitle || '';
  const q = document.querySelector(`input[name=quality][value="${p.quality}"]`);
  if (q) q.checked = true;
  $('#intro').checked = p.intro !== false; // on unless turned off (older saves: on)
  if (p.captions?.text) setCaptions(p.captions);
  for (const id of SECTIONS) if (p.open && id in p.open) $(`#${id}`).open = !!p.open[id];
  if (p.lastRender?.id) recheckLastRender(p.lastRender);
  if (p.audioUrl) {
    setAudio(p.audioUrl);
    if (p.playhead) audio.addEventListener('loadedmetadata', () => { audio.currentTime = p.playhead; }, { once: true });
  }
  restoring = false;
  setSaved(`Restored your work from ${new Date(p.savedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`);
  return true;
}

$('#start-over').addEventListener('click', () => {
  if (!confirm('Start over? This clears the episode, excerpt and story saved in this browser.')) return;
  clearTimeout(saveTimer);
  try { localStorage.removeItem(SAVE_KEY); } catch {}
  restoring = true; // nothing more gets saved on the way out
  location.reload();
});

// ---------- Render ----------
let renderBlocked = null;
async function checkRenderer() {
  try {
    const { render, intro: info } = await (await fetch('/api/health')).json();
    renderBlocked = render.ok ? null : render.advice;
    if (info) Object.assign(intro, { available: true, duration: info.duration, lufs: info.lufs });
    renderIntroOption();
    measureExcerpt();
    drawFrame();
    if (render.ok && !render.captions) $('#captions-box').dataset.unavailable = '1';
  } catch { renderBlocked = null; }
  $('#render-blocked').hidden = !renderBlocked;
  $('#render-blocked').textContent = renderBlocked ? `Videos can't be made on this computer yet. ${renderBlocked}` : '';
  renderButtons();
}

// The button under the preview does one obvious thing at a time:
//   nothing made yet, or the story changed since → Make the video
//   making it                                     → progress, in the button
//   made, and it matches what's on screen         → Download MP4 (Make it again next to it)
// When it finishes, the video plays right in the phone frame.
const job = { running: false, progress: 0, last: null, readyText: '' }; // last: {id, sig, seconds, quality}
function renderBody() {
  const { start, end } = range();
  return {
    audioUrl: $('#audio-url').value.trim(), start, end,
    photos: state.story.map((p) => ({ url: p.url, fit: p.fit, fx: p.fx, fy: p.fy })), // strip order is play order; repeats included
    guest: $('#guest').value, subtitle: $('#subtitle').value,
    captions: state.cues.length ? state.captions.text : null,
    quality: document.querySelector('input[name=quality]:checked').value,
    intro: introOn(),
  };
}
function renderSig() {
  const str = JSON.stringify(renderBody());
  let h = 2166136261; // FNV-1a, enough to notice a change
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36) + str.length.toString(36);
}
function renderButtons() {
  const current = !!job.last && !job.running && job.last.sig === renderSig();
  const r = $('#render');
  $('#download').hidden = !current;
  if (job.last) {
    $('#download').href = `/api/jobs/${job.last.id}/video?download=1`;
    $('#download-earlier').href = `/api/jobs/${job.last.id}/video?download=1`;
  }
  r.classList.toggle('primary', !current);
  r.classList.toggle('again', current);
  r.textContent = job.running ? `Making the video… ${Math.round(job.progress * 100)}%` : current ? 'Make it again' : 'Make the video';
  r.disabled = job.running || !!renderBlocked;
  $('#job-progress').hidden = !job.running;
  $('#job-progress').value = job.progress;
  $('#earlier').hidden = !job.last || current || job.running;
  // "Ready…" only while it's true; an error message is left alone.
  const status = $('#job-status').textContent;
  if (!current && !job.running && status && status === job.readyText) setStatus('#job-status', '');
  if (current && !status && job.readyText) setStatus('#job-status', job.readyText);
  if (!current && showingResult) showPreview(); // edits: back to the live preview
  fitPreview();
}

let showingResult = false;
function showResult() {
  if (!job.last) return;
  audio.pause();
  const v = $('#result-video');
  const src = `/api/jobs/${job.last.id}/video`;
  if (!v.src.endsWith(src)) v.src = src;
  showingResult = true;
  $('#stage').hidden = true; v.hidden = false;
  $('#transport').hidden = true; $('#result-bar').hidden = false;
  fitPreview();
}
function showPreview() {
  const v = $('#result-video');
  v.pause();
  showingResult = false;
  v.hidden = true; $('#stage').hidden = false;
  $('#result-bar').hidden = true; $('#transport').hidden = false;
  fitPreview();
}
$('#show-preview').addEventListener('click', showPreview);
$('#watch-earlier').addEventListener('click', showResult);

$('#render').addEventListener('click', async () => {
  const body = renderBody();
  const sig = renderSig();
  job.running = true;
  job.progress = 0;
  renderButtons();
  setStatus('#job-status', 'Sending…');
  try {
    const r = await fetch('/api/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    const j = await poll(data.id);
    job.last = { id: data.id, sig, seconds: Math.round(j.renderSeconds), quality: body.quality };
    job.running = false;
    job.readyText = `Ready: ${fmtShort(body.end - body.start + (body.intro ? intro.duration : 0))}${body.intro ? ' with the intro' : ''} at ${body.quality === 'final' ? '1080×1920' : '540×960'}, made in ${job.last.seconds}s.`;
    setStatus('#job-status', job.readyText);
    renderButtons();
    showResult();
    save();
    // On a narrow screen the column isn't pinned: bring the download into view.
    $('#download').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (err) {
    job.running = false;
    renderButtons();
    setStatus('#job-status', err.message, true);
  }
});

async function poll(id) {
  for (;;) {
    const j = await (await fetch(`/api/jobs/${id}`)).json();
    if (j.status === 'failed') throw new Error(`The render failed: ${j.error}`);
    if (j.status === 'done') return j;
    job.progress = j.progress || 0;
    renderButtons();
    const words = { queued: `Waiting for another video to finish (${j.queuePosition} ahead)`, downloading: 'Fetching audio and photos…', rendering: 'Rendering…' };
    setStatus('#job-status', words[j.status] || j.status);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// After a reload, the last video is still offered if the server still has it
// (renders are kept for JOB_TTL_HOURS, and not across a server restart).
async function recheckLastRender(last) {
  try {
    const j = await (await fetch(`/api/jobs/${last.id}`)).json();
    if (j.status !== 'done') return;
    job.last = last;
    job.readyText = `Your last video (${last.quality === 'final' ? '1080×1920' : '540×960'}) is still here.`;
    setStatus('#job-status', job.readyText);
    renderButtons();
  } catch { /* gone: nothing to offer */ }
}

// One page scroll. The preview column is pinned while the builder scrolls; if
// it is ever taller than the window it pins by its bottom edge instead, so the
// buttons under the phone can always be reached.
const previewCol = $('#preview-col');
function fitPreview() {
  const pinned = getComputedStyle(previewCol).position === 'sticky';
  previewCol.style.top = pinned ? `${Math.min(12, innerHeight - previewCol.offsetHeight - 12)}px` : '';
}
addEventListener('resize', fitPreview);
new ResizeObserver(fitPreview).observe(previewCol);

// ---------- helpers ----------
function el(tag, props = {}) { return Object.assign(document.createElement(tag), props); }
function setStatus(sel, text, bad = false) { const n = $(sel); n.textContent = text; n.classList.toggle('bad', bad); }
function titleCase(s) { return s.toLowerCase().replace(/(^|[\s/-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()); }
// 754.3 → "12:34" (summaries and tiles; the fields keep tenths)
function fmtShort(sec) {
  if (!Number.isFinite(sec)) return '--:--';
  const s = Math.floor(Math.max(0, sec) + 1e-6);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

restore();
refresh();
checkRenderer();
checkImported();

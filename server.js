// PocketAce prototype server. Node 22+ and FFmpeg; no npm dependencies.
//
//   GET  /api/health            can this machine render? (FFmpeg found, filters present)
//   GET  /api/episode?url=…     look up an episode page (title, photos, audio)
//   POST /api/render            queue a render, returns {id}
//   GET  /api/jobs/:id          status + progress
//   GET  /api/jobs/:id/video    the MP4 (add ?download=1 to save it)
//   POST /api/photos            import a photo from Ace's computer (raw image body)
//   GET  /uploads/<hash>.<ext>  an imported photo; <hash>.thumb.jpg is its gallery thumbnail
//
// Scratch files live in $TMPDIR/pocketace and are deleted after JOB_TTL_HOURS.
// Imported photos are kept in $DATA_DIR/uploads (default ./data/uploads),
// named by the SHA-256 of their contents: the same photo is stored once, and
// a saved project that names it keeps finding it.
// Renders run one at a time; extra requests wait in line.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, readdir, rename, open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupEpisode } from './lib/extract.js';
import { renderVideo, probeImage } from './lib/render.js';
import { findFFmpeg, captionsAdvice, tools } from './lib/ffmpeg.js';
import { sniffType } from './lib/photos.js';
import { schedule } from './public/schedule.js';
import { parseCaptions } from './public/captions.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const WORK = path.join(process.env.WORK_DIR || os.tmpdir(), 'pocketace');
const PORT = Number(process.env.PORT || 8080);
const TTL_MS = Number(process.env.JOB_TTL_HOURS || 6) * 3600e3;
const MAX_EXCERPT = 15 * 60;
const MAX_PHOTOS = 80;
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const UPLOADS = path.join(DATA, 'uploads');
const MAX_UPLOAD = 60e6;
const UPLOAD_URL = /^\/uploads\/([0-9a-f]{64})\.(jpg|png|webp|gif)$/;
const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

// Only these hosts (and their subdomains) are ever fetched. Add the audio
// host here if the episodes turn out to live somewhere else.
const ALLOWED = (process.env.ALLOWED_HOSTS || 'acedoutpodcast.com,squarespace-cdn.com,squarespace.com,amazonaws.com')
  .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
function allowed(u) {
  try {
    const { hostname, protocol } = new URL(u);
    if (!/^https?:$/.test(protocol)) return false;
    return ALLOWED.some((h) => hostname === h || hostname.endsWith(`.${h}`));
  } catch { return false; }
}

const jobs = new Map();
const queue = [];
let busy = false;

// Check FFmpeg before anything else, so a missing filter shows up here and
// in the app, not halfway through someone's first render.
const ff = await findFFmpeg();
console.log(ff.ok
  ? `FFmpeg ${ff.version} at ${ff.ffmpeg} has everything needed${ff.captions ? '' : ' (no libass: captions files are off)'}.`
  : `\n  Rendering is NOT available.\n  ${ff.advice}\n`);

await rm(WORK, { recursive: true, force: true });
await mkdir(path.join(WORK, 'cache'), { recursive: true });
await mkdir(UPLOADS, { recursive: true });
setInterval(sweep, 10 * 60e3).unref();

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { render: { ok: ff.ok, ffmpeg: ff.ffmpeg, version: ff.version, missing: ff.missing, captions: ff.captions, advice: ff.advice } });
    if (req.method === 'GET' && url.pathname === '/api/episode') return await episode(url, res);
    if (req.method === 'POST' && url.pathname === '/api/photos') return await importPhoto(req, res);
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/uploads/')) return await serveUpload(url.pathname, req, res);
    if (req.method === 'POST' && url.pathname === '/api/render') return await startRender(req, res);
    const m = url.pathname.match(/^\/api\/jobs\/([\w-]+)(\/video)?$/);
    if (req.method === 'GET' && m) return await jobRoute(m[1], !!m[2], url, req, res);
    if (req.method === 'GET') return await serveStatic(url.pathname, res);
    send(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    // Browsers cancel media range requests all the time (seeking, Safari's
    // probing); that is not an error. Once headers are out, all we can do is
    // close the socket. Answering again would throw and take the server down.
    if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    console.error(err);
    if (res.headersSent) res.destroy();
    else send(res, 500, { error: err.message });
  }
}).listen(PORT, () => console.log(`PocketAce on http://localhost:${PORT}  (work dir ${WORK}, allowed hosts: ${ALLOWED.join(', ')})`));

async function episode(url, res) {
  const target = url.searchParams.get('url') || '';
  if (!allowed(target)) return send(res, 400, { error: `Only episode pages on ${ALLOWED[0]} can be looked up.` });
  send(res, 200, await lookupEpisode(target));
}

async function startRender(req, res) {
  if (!ff.ok) return send(res, 503, { error: ff.advice });
  const body = JSON.parse(await readBody(req, 2e6));
  const start = Number(body.start), end = Number(body.end);
  const problems = [];
  if (!allowed(body.audioUrl)) problems.push('The audio address is missing or not on an allowed host.');
  if (!(end > start + 5)) problems.push('The excerpt must be at least 5 seconds long.');
  if (end - start > MAX_EXCERPT) problems.push(`The excerpt can be at most ${MAX_EXCERPT / 60} minutes.`);
  const photos = Array.isArray(body.photos) ? body.photos.slice(0, MAX_PHOTOS) : [];
  if (!photos.length) problems.push('Pick at least one photo.');
  for (const [i, p] of photos.entries()) {
    const local = uploadFile(p.url);
    if (local) { if (!(await exists(local))) problems.push(`Photo ${i + 1} was imported but is no longer on this computer. Remove it from the gallery and add it again.`); }
    else if (!allowed(p.url)) problems.push(`Photo ${i + 1} is not on an allowed host.`);
  }
  if (body.captions && !ff.captions) problems.push(captionsAdvice(ff));
  if (problems.length) return send(res, 400, { error: problems.join(' ') });

  // The server re-runs the same scheduler the browser used, so the render
  // matches the preview even if the request was tampered with. Photos play
  // in exactly the order they arrive: the order of Ace's story strip.
  const plan = schedule({ duration: end - start, photos: photos.map((p, i) => ({ id: `p${i}` })) });
  const id = randomUUID();
  const job = {
    id, status: 'queued', progress: 0, error: null, warnings: plan.warnings, createdAt: Date.now(), dir: path.join(WORK, id),
    input: { ...body, start, end, photos, plan, quality: body.quality === 'draft' ? 'draft' : 'final' },
  };
  jobs.set(id, job);
  queue.push(job);
  pump();
  send(res, 202, { id });
}

async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const job = queue.shift();
  const t0 = Date.now();
  try {
    await mkdir(job.dir, { recursive: true });
    const { input } = job;
    job.status = 'downloading';
    const audio = await cached(input.audioUrl, 600e6);
    const photos = new Map();
    for (const [i, p] of input.photos.entries()) {
      const file = uploadFile(p.url) || await cached(p.url, 40e6);
      photos.set(`p${i}`, { file, ...(await probeImage(file)) });
      job.progress = 0.1 * (i + 1) / input.photos.length;
    }
    job.status = 'rendering';
    await renderVideo({
      dir: job.dir, audio, photos, start: input.start, end: input.end, shots: input.plan.shots, quality: input.quality,
      guest: String(input.guest || '').slice(0, 60), subtitle: String(input.subtitle || '').slice(0, 80),
      cues: input.captions ? parseCaptions(String(input.captions)) : [],
      onProgress: (f) => { job.progress = 0.1 + 0.9 * f; },
    });
    job.status = 'done';
    job.progress = 1;
    job.renderSeconds = (Date.now() - t0) / 1000;
  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    console.error(`job ${job.id} failed:`, err.message);
  } finally {
    busy = false;
    pump();
  }
}

// Downloads are cached by URL for the job lifetime, so a draft followed by a
// final render fetches the episode audio once.
const inflight = new Map();
async function cached(u, maxBytes) {
  const file = path.join(WORK, 'cache', createHash('sha1').update(u).digest('hex') + (path.extname(new URL(u).pathname).slice(0, 6) || '.bin'));
  try { if ((await stat(file)).size > 0) return file; } catch {}
  if (!inflight.has(u)) {
    inflight.set(u, (async () => {
      const r = await fetch(u, { redirect: 'follow', headers: { 'user-agent': 'PocketAce/0.1' }, signal: AbortSignal.timeout(10 * 60e3) });
      if (!r.ok) throw new Error(`Download failed (HTTP ${r.status}): ${u}`);
      if (Number(r.headers.get('content-length')) > maxBytes) throw new Error(`File too large: ${u}`);
      if (r.url !== u && !allowed(r.url)) throw new Error(`Redirected to a host that is not allowed: ${new URL(r.url).hostname}`);
      const tmp = `${file}.part`;
      let seen = 0;
      const body = Readable.fromWeb(r.body);
      body.on('data', (c) => { seen += c.length; if (seen > maxBytes) body.destroy(new Error(`File too large: ${u}`)); });
      await pipeline(body, createWriteStream(tmp));
      await rename(tmp, file);
      return file;
    })().finally(() => inflight.delete(u)));
  }
  return inflight.get(u);
}

async function jobRoute(id, wantVideo, url, req, res) {
  const job = jobs.get(id);
  if (!job) return send(res, 404, { error: 'That render has expired or never existed.' });
  if (!wantVideo) {
    const ahead = queue.indexOf(job);
    return send(res, 200, { id, status: job.status, progress: job.progress, error: job.error, warnings: job.warnings, queuePosition: ahead >= 0 ? ahead + 1 : 0, renderSeconds: job.renderSeconds ?? null });
  }
  if (job.status !== 'done') return send(res, 409, { error: 'Not finished yet.' });
  const file = path.join(job.dir, 'video.mp4');
  const name = `aced-out-${String(job.input.guest || 'excerpt').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${job.input.quality}.mp4`;
  await sendFile(req, res, file, 'video/mp4', url.searchParams.has('download') ? name : null);
}

async function serveStatic(p, res) {
  const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, { error: 'Not found' });
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
  try { await sendFile(null, res, file, types[path.extname(file)] || 'application/octet-stream'); } catch { send(res, 404, { error: 'Not found' }); }
}

// ---- Imported photos ----
// The body is the image file itself. Its type comes from its first bytes, not
// its name. Originals are stored untouched; the thumbnail is upright and small.
async function importPhoto(req, res) {
  const name = safeName(decodeURIComponent(String(req.headers['x-filename'] || 'photo')));
  const tmp = path.join(UPLOADS, `.incoming-${randomUUID()}`);
  const hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(req, async function* (chunks) {
      for await (const c of chunks) {
        size += c.length;
        if (size > MAX_UPLOAD) throw Object.assign(new Error(`${name} is larger than ${MAX_UPLOAD / 1e6} MB.`), { status: 413 });
        hash.update(c);
        yield c;
      }
    }, createWriteStream(tmp));
    const head = await readHead(tmp);
    const type = sniffType(head);
    if (type === 'heic') throw Object.assign(new Error(`${name} is an HEIC photo, which can't be used directly. Add it from Safari (it converts HEIC for you), or export it from Photos as JPEG.`), { status: 415 });
    if (!type) throw Object.assign(new Error(`${name} isn't a JPEG, PNG or WebP photo.`), { status: 415 });
    const id = hash.digest('hex');
    const file = path.join(UPLOADS, `${id}.${type}`);
    if (await exists(file)) await rm(tmp, { force: true }); else await rename(tmp, file);
    let info;
    try { info = await probeImage(file); } catch {
      await rm(file, { force: true });
      throw Object.assign(new Error(`${name} couldn't be read as a photo.`), { status: 415 });
    }
    const thumb = path.join(UPLOADS, `${id}.thumb.jpg`);
    if (!(await exists(thumb))) {
      // probeImage hands back an upright copy when the photo needed turning.
      const { ffmpeg } = await tools();
      await new Promise((ok, fail) => spawn(ffmpeg, ['-v', 'error', '-y', '-noautorotate', '-i', info.file || file, '-vf', 'scale=600:600:force_original_aspect_ratio=decrease', '-frames:v', '1', '-q:v', '3', thumb])
        .on('close', (code) => (code === 0 ? ok() : fail(new Error(`${name}: the thumbnail could not be made.`)))));
    }
    send(res, 200, { url: `/uploads/${id}.${type}`, thumb: `/uploads/${id}.thumb.jpg`, width: info.width, height: info.height, name, bytes: size });
  } catch (err) {
    await rm(tmp, { force: true });
    send(res, err.status || 500, { error: err.message });
  }
}

function uploadFile(u) {
  const m = typeof u === 'string' && u.match(UPLOAD_URL);
  return m ? path.join(UPLOADS, `${m[1]}.${m[2]}`) : null;
}

async function serveUpload(p, req, res) {
  const m = p.match(/^\/uploads\/([0-9a-f]{64})(\.thumb\.jpg|\.(jpg|png|webp|gif))$/);
  if (!m) return send(res, 404, { error: 'Not found' });
  const file = path.join(UPLOADS, `${m[1]}${m[2]}`);
  if (!(await exists(file))) return send(res, 404, { error: 'That photo is no longer on this computer.' });
  // Content-addressed, so a given address never changes: cache it for good.
  await sendFile(req, res, file, m[3] ? TYPES[m[3]] : 'image/jpeg', null, 'public, max-age=31536000, immutable');
}

async function readHead(file, bytes = 256 * 1024) {
  const fh = await open(file, 'r');
  try { const b = Buffer.alloc(bytes); const { bytesRead } = await fh.read(b, 0, bytes, 0); return b.subarray(0, bytesRead); } finally { await fh.close(); }
}
async function exists(f) { try { await stat(f); return true; } catch { return false; } }
function safeName(n) { return n.replace(/[^\p{L}\p{N} ._()-]/gu, '').slice(0, 120) || 'photo'; }

// Range support so the browser's <video> element can seek.
async function sendFile(req, res, file, type, downloadName = null, cache = 'no-store') {
  const { size } = await stat(file);
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': cache };
  if (downloadName) headers['content-disposition'] = `attachment; filename="${downloadName}"`;
  const range = req?.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    return pipeline(createReadStream(file, { start, end }), res);
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  return pipeline(createReadStream(file), res);
}

async function sweep() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff && job.status !== 'rendering' && job.status !== 'downloading') {
      jobs.delete(id);
      await rm(job.dir, { recursive: true, force: true });
    }
  }
  for (const f of await readdir(path.join(WORK, 'cache'))) {
    const fp = path.join(WORK, 'cache', f);
    if ((await stat(fp)).mtimeMs < cutoff) await rm(fp, { force: true });
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new Error('Request too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Importing photos from Ace's computer, through the real server: storage,
// thumbnails, refusals, a render that uses an imported photo, and what happens
// when an imported file has gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureSite } from './fixture-site.js';
import { quadrantsJpeg, withOrientation, quadrants } from './images.js';
import { placement } from '../public/look.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('import → gallery thumbnail → render with an imported, sideways phone photo', { timeout: 120e3 }, async () => {
  const site = await startFixtureSite();
  const data = mkdtempSync(path.join(os.tmpdir(), 'pocketace-data-'));
  const port = 19100 + Math.floor(Math.random() * 800);
  const srv = spawn('node', ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), ALLOWED_HOSTS: '127.0.0.1', DATA_DIR: data, WORK_DIR: mkdtempSync(path.join(os.tmpdir(), 'pocketace-imp-')) }, stdio: 'pipe',
  });
  const api = `http://127.0.0.1:${port}`;
  const upload = (body, name, type = 'image/jpeg') => fetch(`${api}/api/photos`, { method: 'POST', headers: { 'content-type': type, 'x-filename': encodeURIComponent(name) }, body });
  try {
    await new Promise((resolve) => srv.stdout.on('data', (b) => String(b).includes('PocketAce on') && resolve()));

    // An iPhone-style JPEG stored landscape with "rotate 90° clockwise" in EXIF.
    const phone = withOrientation(quadrantsJpeg(), 6);
    const r = await upload(phone, 'IMG_0001.JPG');
    assert.equal(r.status, 200);
    const photo = await r.json();
    assert.match(photo.url, /^\/uploads\/[0-9a-f]{64}\.jpg$/);
    assert.deepEqual([photo.width, photo.height, photo.name], [200, 300, 'IMG_0001.JPG']);
    // The original is kept byte for byte; the thumbnail is upright.
    assert.deepEqual(Buffer.from(await (await fetch(api + photo.url)).arrayBuffer()), phone);
    const t = quadrants(api + photo.thumb);
    assert.equal(t.q, 'BRWG');
    assert.ok(t.h > t.w);
    // The same photo again is the same address.
    assert.equal((await (await upload(phone, 'copy.jpg')).json()).url, photo.url);

    // Refusals, in words Ace can act on.
    const heic = await upload(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heic', 'latin1'), 'IMG_0002.HEIC', 'image/heic');
    assert.equal(heic.status, 415);
    assert.match((await heic.json()).error, /HEIC.*Safari/);
    const pdf = await upload(Buffer.from('%PDF-1.7 not a photo'), 'notes.pdf', 'application/pdf');
    assert.equal(pdf.status, 415);
    assert.equal(readdirSync(path.join(data, 'uploads')).filter((f) => f.startsWith('.incoming')).length, 0);

    // Render: the imported photo first, then one from the (stand-in) website.
    const ep = await (await fetch(`${api}/api/episode?url=${encodeURIComponent(`${site.origin}/episodes/32/linda-shider`)}`)).json();
    const job = await (await fetch(`${api}/api/render`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audioUrl: ep.audio[0].url, start: 10, end: 22, quality: 'draft', guest: 'Test', subtitle: '', photos: [{ url: photo.url }, { url: ep.images[0].url }] }),
    })).json();
    assert.ok(job.id, job.error);
    let j;
    for (let i = 0; i < 100; i++) {
      j = await (await fetch(`${api}/api/jobs/${job.id}`)).json();
      if (j.status === 'done' || j.status === 'failed') break;
      await new Promise((ok) => setTimeout(ok, 500));
    }
    assert.equal(j.status, 'done', j.error);
    // Three seconds in, the imported photo is on screen, framed upright (draft is half size).
    const box = placement(200, 300);
    const k = 0.5, inset = 0.15;
    const crop = `crop=${Math.round(box.w * k * (1 - 2 * inset))}:${Math.round(box.h * k * (1 - 2 * inset))}:${Math.round((box.x + box.w * inset) * k)}:${Math.round((box.y + box.h * inset) * k)}`;
    const mp4 = path.join(data, 'out.mp4');
    writeFileSync(mp4, Buffer.from(await (await fetch(`${api}/api/jobs/${job.id}/video`)).arrayBuffer()));
    assert.equal(quadrants(mp4, { pre: ['-ss', '3'], vf: crop }).q, 'BRWG');

    // If the imported file disappears, a render says so before starting.
    for (const f of readdirSync(path.join(data, 'uploads'))) rmSync(path.join(data, 'uploads', f));
    const gone = await fetch(`${api}/api/render`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audioUrl: ep.audio[0].url, start: 10, end: 22, quality: 'draft', photos: [{ url: photo.url }] }),
    });
    assert.equal(gone.status, 400);
    assert.match((await gone.json()).error, /no longer on this computer/);
    assert.equal((await fetch(api + photo.thumb)).status, 404);
  } finally {
    srv.kill();
    site.close();
    rmSync(data, { recursive: true, force: true });
  }
});

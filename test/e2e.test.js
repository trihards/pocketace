// Full path through the real server: look up the stand-in episode page,
// queue a draft render, wait, and check the MP4 that comes back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import { writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureSite } from './fixture-site.js';
import { tools } from '../lib/ffmpeg.js';

const { ffprobe } = await tools();

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('episode lookup → draft render → MP4', { timeout: 120e3 }, async () => {
  const site = await startFixtureSite();
  const port = 18000 + Math.floor(Math.random() * 1000);
  const srv = spawn('node', ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), ALLOWED_HOSTS: '127.0.0.1', WORK_DIR: mkdtempSync(path.join(os.tmpdir(), 'pocketace-e2e-')) }, stdio: 'pipe',
  });
  const api = `http://127.0.0.1:${port}`;
  try {
    // Wait for the listening line: the server prints its FFmpeg check first.
    await new Promise((resolve) => srv.stdout.on('data', (b) => String(b).includes('PocketAce on') && resolve()));
    const ep = await (await fetch(`${api}/api/episode?url=${encodeURIComponent(`${site.origin}/episodes/32/linda-shider`)}`)).json();
    assert.equal(ep.images.length, 3);

    const r = await fetch(`${api}/api/render`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        audioUrl: ep.audio[0].url, start: 10, end: 22, quality: 'draft', guest: ep.guest, subtitle: 'Ep 32 · P-Funk',
        photos: ep.images.map((i) => ({ url: i.url })),
        captions: '1\n00:00:11,000 --> 00:00:14,000\nHello from the excerpt.\n',
      }),
    });
    assert.equal(r.status, 202);
    const { id } = await r.json();
    let job;
    for (let i = 0; i < 100; i++) {
      job = await (await fetch(`${api}/api/jobs/${id}`)).json();
      if (job.status === 'done' || job.status === 'failed') break;
      await new Promise((ok) => setTimeout(ok, 500));
    }
    assert.equal(job.status, 'done', job.error);

    const mp4 = Buffer.from(await (await fetch(`${api}/api/jobs/${id}/video`)).arrayBuffer());
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'pocketace-out-')), 'out.mp4');
    writeFileSync(file, mp4);
    const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', file]));
    assert.equal(Number(info.format.duration).toFixed(1), '12.0');
    assert.deepEqual(info.streams.map((s) => s.codec_type).sort(), ['audio', 'video']);
    const v = info.streams.find((s) => s.codec_type === 'video');
    assert.deepEqual([v.width, v.height], [540, 960]);

    // A browser cancelling a video range request mid-stream must not take the server down.
    await new Promise((resolve) => {
      const r = http.get(`${api}/api/jobs/${id}/video`, { headers: { range: 'bytes=0-' } }, (res) => res.once('data', () => { r.destroy(); setTimeout(resolve, 200); }));
      r.on('error', () => {});
    });
    assert.equal((await fetch(`${api}/api/health`)).status, 200);

    const bad = await fetch(`${api}/api/episode?url=${encodeURIComponent('https://evil.example/x')}`);
    assert.equal(bad.status, 400);
  } finally {
    srv.kill();
    site.close();
  }
});

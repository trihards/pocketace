// A local stand-in for a Squarespace episode page, used by the tests.
// The markup follows Squarespace's documented/commonly seen conventions
// (?format=json, ?format=rss, sqs-audio-embed data-url, lazy data-src images).
// It is NOT a capture of acedoutpodcast.com, which this sandbox could not reach.

import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function startFixtureSite() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pocketace-site-'));
  const make = (name, src) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, '-frames:v', '1', path.join(dir, name)]);
  make('logo.png', 'color=gold:s=200x80');
  make('a.jpg', 'mandelbrot=s=1800x1200');
  make('b.jpg', 'testsrc2=s=1080x1620');
  make('c.jpg', 'smptehdbars=s=1600x900');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=330:d=40', '-c:a', 'libmp3lame', '-b:a', '96k', path.join(dir, 'ep32.mp3')]);

  let origin = '';
  const article = () => `
    <article class="BlogItem">
      <h1 class="BlogItem-title">Ep 32: Linda Shider [P-FUNK/GARRY SHIDER]</h1>
      <div class="sqs-audio-embed" data-url="${origin}/static/ep32.mp3" data-title="Ep 32"></div>
      <p>Show notes: how she met the band, life on the road, and writing for Parlet.</p>
      <img data-src="${origin}/static/a.jpg" data-image-dimensions="1800x1200" alt="">
      <img data-src="${origin}/static/b.jpg" data-image-dimensions="1080x1620" alt="">
      <img src="${origin}/static/c.jpg?format=750w" alt="">
    </article>`;
  const page = () => `<!doctype html><html><head><title>Ep 32: Linda Shider — Aced Out Podcast</title>
    <meta property="og:title" content="Ep 32: Linda Shider [P-FUNK/GARRY SHIDER] &mdash; Aced Out Podcast">
    <link rel="alternate" type="application/rss+xml" title="RSS Feed" href="${origin}/episodes?format=rss">
    </head><body><header><img src="${origin}/static/logo.png" alt="Aced Out"></header>${article()}</body></html>`;
  const rss = () => `<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
    <item><title>Ep 31: Someone Else</title><link>${origin}/episodes/31/someone</link><enclosure url="${origin}/static/other.mp3" type="audio/mpeg"/></item>
    <item><title>Ep 32: Linda Shider [P-FUNK/GARRY SHIDER]</title><link>${origin}/episodes/32/linda-shider</link>
      <enclosure url="${origin}/static/ep32.mp3" length="1" type="audio/mpeg"/></item></channel></rss>`;

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, origin);
    if (u.pathname.startsWith('/static/')) {
      try {
        const body = readFileSync(path.join(dir, path.basename(u.pathname)));
        const type = u.pathname.endsWith('.mp3') ? 'audio/mpeg' : 'image/jpeg';
        // Byte ranges, like real media hosts: browsers need them to seek in audio.
        const m = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
        if (m) {
          const a = Number(m[1]), b = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
          res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${body.length}`, 'content-length': b - a + 1 });
          return res.end(body.subarray(a, b + 1));
        }
        res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': body.length });
        return res.end(body);
      } catch { res.writeHead(404); return res.end(); }
    }
    if (u.pathname === '/episodes' && u.searchParams.get('format') === 'rss') { res.writeHead(200, { 'content-type': 'application/rss+xml' }); return res.end(rss()); }
    if (u.pathname === '/episodes/32/linda-shider') {
      if (u.searchParams.get('format') === 'json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ item: { title: 'Ep 32: Linda Shider [P-FUNK/GARRY SHIDER]', body: article(), assetUrl: `${origin}/static/a.jpg` } }));
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(page());
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    origin = `http://127.0.0.1:${server.address().port}`;
    resolve({ origin, dir, close: () => server.close() });
  }));
}

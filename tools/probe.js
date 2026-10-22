// Live check of what can actually be pulled from Aced Out episode pages.
// Run it from any machine with normal internet access:
//
//   node tools/probe.js https://www.acedoutpodcast.com/episodes/32/linda-shider [more URLs…]
//
// For each page it reports: which lookup sources worked, the title, the photos
// (real pixel sizes, at the 2500w size and the original), the audio (type,
// size, whether it supports byte ranges, duration), browser CORS headers on
// every resource, and whether there is a transcript or only show notes.
// Writes probe-report.json next to where it is run. Requires ffprobe.

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { lookupEpisode } from '../lib/extract.js';

const urls = process.argv.slice(2);
if (!urls.length) { console.error('Usage: node tools/probe.js <episode-url> [...]'); process.exit(1); }
const ORIGIN = 'https://pocketace.example'; // a foreign origin, as a browser app would be

const results = [];
for (const url of urls) {
  console.log(`\n=== ${url}`);
  const r = await lookupEpisode(url, { fetchText: fetchWithOrigin });
  const out = { url, title: r.title, guest: r.guest, sources: r.sources, images: [], audio: [], transcript: null, players: r.players };
  for (const s of r.sources) console.log(`  source ${s.name.padEnd(4)} ${s.ok ? 'OK ' : 'NO '} HTTP ${s.status ?? '-'}  CORS ${s.cors ?? 'none'}  ${s.note ?? ''}`);
  console.log(`  title: ${r.title}`);

  for (const a of r.audio) {
    const head = await headers(a.url, { range: 'bytes=0-1' });
    const meta = await ffprobe(a.url, 'format=duration,bit_rate,format_name');
    const row = { url: a.url, foundBy: a.sources, status: head.status, finalUrl: head.url, type: head.h['content-type'], length: head.h['content-range']?.split('/')[1] || head.h['content-length'], ranges: head.status === 206, cors: head.h['access-control-allow-origin'] ?? null, ...meta };
    out.audio.push(row);
    console.log(`  audio: ${row.status} ${row.type} ${mb(row.length)} ranges=${row.ranges} CORS=${row.cors ?? 'none'} duration=${row.duration ?? '?'}s via ${a.sources.join(', ')}`);
    console.log(`         ${a.url}${row.finalUrl !== a.url ? `\n         → redirects to ${row.finalUrl}` : ''}`);
  }
  if (!r.audio.length) console.log(`  audio: NONE FOUND${r.players.length ? ` (player embeds: ${r.players.join(', ')})` : ''}`);

  for (const img of r.images) {
    const big = await ffprobe(img.url, 'stream=width,height');
    const orig = img.url.includes('format=2500w') ? await ffprobe(img.url.replace('format=2500w', 'format=original'), 'stream=width,height') : big;
    const head = await headers(img.url);
    const row = { url: img.url, foundBy: img.sources, declared: img.width ? `${img.width}x${img.height}` : null, served: big.width ? `${big.width}x${big.height}` : null, original: orig.width ? `${orig.width}x${orig.height}` : null, cors: head.h['access-control-allow-origin'] ?? null, bytes: head.h['content-length'] };
    row.verdict = !big.width ? 'unreadable' : Math.max(big.width, big.height) < 1080 ? 'too small for 1080p' : big.width < 1000 && big.width >= big.height ? 'soft when framed' : 'ok';
    out.images.push(row);
    console.log(`  photo: served ${row.served ?? '?'} (original ${row.original ?? '?'}) ${row.verdict}  CORS=${row.cors ?? 'none'}  via ${img.sources.join(', ')}`);
  }

  // Transcript or show notes? A transcript is long and has speaker turns.
  const html = await fetchWithOrigin(url).then((x) => x.text).catch(() => '');
  const text = (html.match(/<article[\s\S]*?<\/article>/i)?.[0] || html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const words = text.split(' ').filter(Boolean).length;
  const turns = (text.match(/\b(ACE|Ace|Ace Alan|[A-Z][a-z]+ [A-Z][a-z]+)\s?:/g) || []).length;
  const stamps = (text.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g) || []).length;
  out.transcript = { rssTranscriptTag: r.transcript, articleWords: words, speakerTurns: turns, timestamps: stamps,
    verdict: !html ? 'unknown (page not reachable)' : r.transcript ? 'transcript file linked in RSS' : words > 3000 && turns > 20 ? 'probably a full transcript on the page' : 'show notes only (no transcript found)' };
  console.log(`  text: ${words} words, ${turns} speaker-like turns, ${stamps} timestamps → ${out.transcript.verdict}`);
  results.push(out);
}
await writeFile('probe-report.json', JSON.stringify(results, null, 2));
console.log('\nFull details in probe-report.json');

async function fetchWithOrigin(url) {
  const res = await fetch(url, { headers: { origin: ORIGIN, 'user-agent': 'PocketAce-probe/0.1' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  return { status: res.status, text: await res.text(), headers: Object.fromEntries(res.headers) };
}
async function headers(url, extra = {}) {
  try {
    const res = await fetch(url, { headers: { origin: ORIGIN, ...extra }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    res.body?.cancel();
    return { status: res.status, url: res.url, h: Object.fromEntries(res.headers) };
  } catch (err) { return { status: err.message, url, h: {} }; }
}
function ffprobe(url, entries) {
  return new Promise((resolve) => execFile('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'json', url], { timeout: 60000 }, (err, stdout) => {
    if (err) return resolve({ error: err.message.split('\n')[0] });
    const j = JSON.parse(stdout);
    resolve({ ...(j.format || {}), ...(j.streams?.[0] || {}) });
  }));
}
function mb(n) { return n ? `${(Number(n) / 1e6).toFixed(1)} MB` : '? MB'; }

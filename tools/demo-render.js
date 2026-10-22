// Renders a sample video from locally generated stand-ins, no network needed:
// labelled test-pattern "photos" in mixed shapes and sizes, a synthetic audio
// track and a short SRT file. Checks the render pipeline only; it says nothing
// about the Aced Out site.
//
//   node tools/demo-render.js [seconds=45] [draft|final]

import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { schedule } from '../public/schedule.js';
import { parseCaptions } from '../public/captions.js';
import { renderVideo, probeImage } from '../lib/render.js';

const seconds = Number(process.argv[2] || 45);
const quality = process.argv[3] || 'draft';
const dir = await mkdtemp(path.join(os.tmpdir(), 'pocketace-demo-'));
const fx = path.join(dir, 'fixtures');
await mkdir(fx, { recursive: true });

const sources = [
  ['mandelbrot=s=3000x2000:start_scale=1.2', 'landscape 3000x2000'],
  ['testsrc2=s=1600x2400', 'portrait 1600x2400'],
  ['mandelbrot=s=1500x1500:start_x=-0.75:start_y=0.1:start_scale=0.3', 'square 1500x1500'],
  ['mandelbrot=s=640x480:start_scale=0.6', 'small 640x480'],
  ['smptehdbars=s=2400x1350', 'wide 2400x1350'],
  ['testsrc=s=1200x1800', 'portrait 1200x1800'],
];
const photos = new Map();
sources.forEach(([src, label], i) => {
  const file = path.join(fx, `photo${i + 1}.jpg`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${src},drawtext=text='TEST PHOTO ${i + 1}  ${label}':fontsize=h/14:fontcolor=white:box=1:boxcolor=black@0.6:x=(w-tw)/2:y=(h-th)/2`, '-frames:v', '1', file]);
  photos.set(`p${i + 1}`, { file });
});
for (const p of photos.values()) Object.assign(p, await probeImage(p.file));

// 3 minutes of synthetic "episode": a slow chord with a click track, so cuts and sync are audible.
const audio = path.join(fx, 'episode.mp3');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=220:d=180', '-f', 'lavfi', '-i', 'sine=f=277:d=180', '-f', 'lavfi', '-i', 'sine=f=1000:d=180:beep_factor=4',
  '-filter_complex', '[0][1][2]amix=inputs=3,volume=0.6,aformat=channel_layouts=stereo', '-c:a', 'libmp3lame', '-b:a', '128k', audio]);

const start = 30, end = start + seconds;
const srt = `1\n00:00:31,000 --> 00:00:35,500\nShe called them the black Rolling Stones.\n\n2\n00:00:36,000 --> 00:00:41,000\n(Sample caption. Ace would supply real ones\nas an SRT or VTT file.)\n`;
const ids = [...photos.keys()];
const pick = ids.map((id) => ({ id, pin: id === 'p5' ? Math.min(20, seconds / 2) : null }));
const { shots, warnings } = schedule({ duration: end - start, photos: pick });
console.log('Shots:'); shots.forEach((s) => console.log(`  ${s.id}${s.pinned ? ' (pinned)' : ''}  ${s.start.toFixed(2)} → ${s.end.toFixed(2)}`));
warnings.forEach((w) => console.log('  ! ' + w));

const t0 = Date.now();
const out = await renderVideo({
  dir, audio, start, end, shots, photos, quality,
  guest: 'Linda Shider', subtitle: 'Ep 32 · P-Funk / Garry Shider',
  cues: parseCaptions(srt),
  onProgress: (p) => process.stdout.write(`\r  rendering ${(p * 100).toFixed(0)}%   `),
});
const secs = (Date.now() - t0) / 1000;
console.log(`\nDone in ${secs.toFixed(1)}s (${(seconds / secs).toFixed(2)}× realtime): ${out}`);
await writeFile(path.join(dir, 'timing.json'), JSON.stringify({ seconds, quality, renderSeconds: secs }));

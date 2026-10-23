// The standard show intro: the story with and without it. Uses the real
// intro files in public/intro. The stand-in episode is silent until the
// excerpt starts and then plays a 1 kHz tone, so the tone's onset in the
// output is where the interview starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { schedule } from '../public/schedule.js';
import { splashRect, INTRO } from '../public/look.js';
import { renderVideo, probeImage } from '../lib/render.js';
import { tools } from '../lib/ffmpeg.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { ffmpeg, ffprobe } = await tools();
const run = (args) => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args]);

function toneOnset(file) {
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-af', 'bandpass=f=1000:width_type=h:w=40,bandpass=f=1000:width_type=h:w=40,aformat=channel_layouts=mono', '-ar', '8000', '-f', 's16le', '-']);
  const s = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
  const rms = [];
  for (let i = 0; i + 80 <= s.length; i += 80) { let a = 0; for (let j = 0; j < 80; j++) a += s[i + j] ** 2; rms.push(Math.sqrt(a / 80)); }
  const peak = Math.max(...rms);
  return rms.findIndex((v) => v > peak * 0.3) * 0.01;
}
const durations = (f) => JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', f])).streams.map((s) => Number(s.duration));
const frames = (f) => { const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', f, '-vf', 'scale=27:48,format=gray', '-f', 'rawvideo', '-']); const n = 27 * 48; return Array.from({ length: raw.length / n }, (_, i) => raw.subarray(i * n, (i + 1) * n)); };
const diff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

test('with the show intro the story starts exactly when the intro ends, unchanged', { timeout: 300e3 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pocketace-intro-'));
  try {
    run(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=10', '-f', 'lavfi', '-i', 'sine=f=1000:d=30:sample_rate=44100', '-filter_complex', '[1:a]aformat=channel_layouts=stereo,volume=0.3[t];[0:a][t]concat=n=2:v=0:a=1', '-c:a', 'libmp3lame', path.join(dir, 'ep.mp3')]);
    run(['-f', 'lavfi', '-i', 'mandelbrot=s=1600x1200', '-frames:v', '1', path.join(dir, 'a.jpg')]);
    run(['-f', 'lavfi', '-i', 'testsrc2=s=1200x1800', '-frames:v', '1', path.join(dir, 'b.jpg')]);
    const photos = new Map();
    for (const id of ['a', 'b']) photos.set(id, { file: path.join(dir, `${id}.jpg`), ...(await probeImage(path.join(dir, `${id}.jpg`))) });
    const { shots } = schedule({ duration: 12, photos: [{ id: 'a' }, { id: 'b' }] });
    const splash = path.join(ROOT, 'public/intro/splash.png'), audio = path.join(ROOT, 'public/intro/audio.m4a');
    const I = Math.round(Number(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audio])) * 30) / 30;
    const { width, height } = await probeImage(splash);
    const render = (sub, intro) => renderVideo({ dir: path.join(dir, sub), audio: path.join(dir, 'ep.mp3'), start: 10, end: 22, shots, photos, quality: 'draft', guest: 'Test', subtitle: '', cues: [], intro });
    execFileSync('mkdir', ['-p', path.join(dir, 'on'), path.join(dir, 'off')]);
    const on = await render('on', { splash, audio, duration: I, width, height });
    const off = await render('off', null);

    for (const d of durations(on)) assert.ok(Math.abs(d - (I + 12)) < 0.02, `with intro: ${d}`);
    for (const d of durations(off)) assert.ok(Math.abs(d - 12) < 0.02, `without: ${d}`);
    // The interview (the tone) starts I seconds later, to within 20 ms.
    assert.ok(Math.abs(toneOnset(on) - toneOnset(off) - I) < 0.02, `onsets ${toneOnset(on)} vs ${toneOnset(off)}`);
    // The story's frames line up best at a shift of exactly I.
    const fOn = frames(on), fOff = frames(off), F = Math.round(I * 30);
    const score = (shift) => [150, 160, 170, 180, 190, 200].reduce((s, k) => s + diff(fOn[k + shift], fOff[k]), 0);
    assert.ok(score(F) < score(F - 1) && score(F) < score(F + 1) && score(F) / 6 < 1, `shift scores ${score(F - 1)}, ${score(F)}, ${score(F + 1)}`);
    // Mid-intro: the splash whole and centred on the show's purple.
    const k = 540 / 1080, r = splashRect(width, height);
    const px = (y) => execFileSync(ffmpeg, ['-v', 'error', '-ss', '2', '-i', on, '-frames:v', '1', '-vf', `crop=2:2:270:${Math.round(y / 2) * 2},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const purple = [...Buffer.from(INTRO.background.slice(1), 'hex')];
    for (const y of [r.y * k / 2, (r.y + r.h) * k + (960 - (r.y + r.h) * k) / 2]) {
      const c = [...px(y)];
      assert.ok(c.every((v, i) => Math.abs(v - purple[i]) < 8), `background at y=${y}: ${c}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

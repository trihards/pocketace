import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { probeImage } from '../lib/render.js';
import { tools } from '../lib/ffmpeg.js';

const { ffmpeg } = await tools();

test('a GIF is swapped for a PNG still (the still-image reader rejects GIFs)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pocketace-probe-'));
  try {
    const gif = path.join(dir, 'group.gif');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x240:d=0.5', gif]);
    const p = await probeImage(gif);
    assert.deepEqual([p.width, p.height], [320, 240]);
    assert.ok(p.file.endsWith('.png'));
    execFileSync(ffmpeg, ['-v', 'error', '-framerate', '30', '-i', p.file, '-frames:v', '1', '-f', 'null', '-']);
    const jpg = path.join(dir, 'a.jpg');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=64x48', '-frames:v', '1', jpg]);
    assert.deepEqual(await probeImage(jpg), { width: 64, height: 48 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findFFmpeg, tools } from '../lib/ffmpeg.js';

// A stand-in for Homebrew's slim ffmpeg: the real binary, minus drawtext and ass.
const { ffmpeg: real } = await tools();
const dir = mkdtempSync(path.join(os.tmpdir(), 'pocketace-ff-'));
const slim = path.join(dir, 'slim', 'ffmpeg');
mkdirSync(path.dirname(slim));
writeFileSync(slim, `#!/bin/sh\nif [ "$2" = "-filters" ]; then "${real}" "$@" | grep -v -E " (drawtext|ass) "; else exec "${real}" "$@"; fi\n`);
chmodSync(slim, 0o755);

test('an FFmpeg without drawtext is refused, with the reason and the fix', async () => {
  const r = await findFFmpeg({ candidates: [slim], fresh: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['drawtext']);
  assert.equal(r.captions, false);
  assert.match(r.advice, /drawtext \(needs libfreetype\)/);
  assert.match(r.advice, process.platform === 'darwin' ? /brew install ffmpeg-full/ : /FFMPEG_PATH/);
});

test('a slim ffmpeg on PATH is passed over for a complete one further down the list', async () => {
  const r = await findFFmpeg({ candidates: [slim, '/nowhere/ffmpeg-full/bin/ffmpeg', real], fresh: true });
  assert.equal(r.ok, true);
  assert.equal(r.ffmpeg, path.resolve(real));
  assert.deepEqual(r.tried.map((t) => t.found), [true, false, true]);
});

test('no FFmpeg at all says so', async () => {
  const r = await findFFmpeg({ candidates: ['/nowhere/ffmpeg'], fresh: true });
  assert.equal(r.ok, false);
  assert.match(r.advice, /not found/);
  await findFFmpeg({ fresh: true }); // leave the default in place for other tests
});

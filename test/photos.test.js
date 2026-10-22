import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sniffType, exifOrientation } from '../lib/photos.js';
import { probeImage } from '../lib/render.js';
import { quadrantsJpeg, withOrientation, quadrants } from './images.js';

const jpeg = quadrantsJpeg();
// How each EXIF orientation should look once upright, as browsers show it
// (checked against Chromium for all eight).
const SEEN = { 1: 'RGBW', 2: 'GRWB', 3: 'WBGR', 4: 'BWRG', 5: 'RBGW', 6: 'BRWG', 7: 'WGBR', 8: 'GWRB' };

test('file types come from the bytes', () => {
  assert.equal(sniffType(jpeg), 'jpg');
  assert.equal(sniffType(Buffer.from('\x89PNG\r\n\x1a\nxxxx', 'latin1')), 'png');
  assert.equal(sniffType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'webp');
  assert.equal(sniffType(Buffer.from('GIF89a', 'latin1')), 'gif');
  assert.equal(sniffType(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0', 'latin1')), 'heic');
  assert.equal(sniffType(Buffer.from('%PDF-1.7', 'latin1')), null);
});

test('EXIF orientation is read from JPEGs', () => {
  assert.equal(exifOrientation(jpeg), 1);
  for (let o = 1; o <= 8; o++) assert.equal(exifOrientation(withOrientation(jpeg, o)), o);
});

test('a sideways phone photo is rendered upright, at its upright size', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pocketace-orient-'));
  try {
    for (let o = 1; o <= 8; o++) {
      const file = path.join(dir, `o${o}.jpg`);
      writeFileSync(file, withOrientation(jpeg, o));
      const p = await probeImage(file);
      const [w, h] = o >= 5 ? [200, 300] : [300, 200];
      assert.deepEqual([p.width, p.height], [w, h], `orientation ${o} size`);
      // Read the file the render will use exactly as pass 1 does (FFmpeg's defaults).
      const seen = quadrants(p.file || file);
      assert.equal(seen.q, SEEN[o], `orientation ${o} pixels`);
      assert.deepEqual([seen.w, seen.h], [w, h]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

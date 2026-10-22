import test from 'node:test';
import assert from 'node:assert/strict';
import { placement, MAX_UPSCALE } from '../public/look.js';

test('a typical archive photo is never enlarged past the limit', () => {
  const p = placement(652, 489); // median-ish Aced Out photo
  assert.equal(p.fill, false);
  assert.ok(Math.abs(p.w - 652 * MAX_UPSCALE) < 1e-9);
  assert.ok(p.x > 0 && p.x + p.w < 1080);
});

test('a big landscape photo uses the full framed width', () => {
  assert.equal(placement(3000, 2000).w, 1000);
});

test('only large, phone-shaped photos fill the frame', () => {
  assert.equal(placement(1620, 2880).fill, true);
  assert.equal(placement(540, 960).fill, false); // right shape, too small
  assert.equal(placement(1600, 2400).fill, false); // 2:3 stays whole
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { layout, motionFor, rectAt, defaultFit, W, H, WHOLE, MOTION } from '../public/look.js';

test('a small landscape photo is shown whole, edge to edge: enlarged as far as it takes', () => {
  const L = layout({ width: 553, height: 277 }); // a typical small Aced Out performance shot
  assert.equal(L.fit, 'whole');
  assert.equal(Math.round(L.rect.w), W);
  assert.ok(L.upscale > 1.9);
  assert.ok(Math.abs(L.rect.y + L.rect.h / 2 - H * WHOLE.centerY) < 1e-6); // between wordmark and name
});

test('a whole photo never leaves the canvas, and tall ones may run under the name', () => {
  for (const [w, h] of [[300, 300], [436, 702], [2500, 3333], [1600, 468], [480, 940]]) {
    const L = layout({ width: w, height: h, fit: 'whole' });
    assert.ok(L.rect.x >= -1e-6 && L.rect.y >= -1e-6 && L.rect.x + L.rect.w <= W + 1e-6 && L.rect.y + L.rect.h <= H + 1e-6, `${w}x${h}`);
    assert.ok(Math.abs(L.rect.w / L.rect.h - w / h) < 1e-9, 'no distortion');
  }
  assert.ok(layout({ width: 436, height: 702 }).rect.h > 1300);
});

test('only photos already close to 9:16 fill the frame unless chosen', () => {
  assert.equal(defaultFit(1080, 1920), 'fill');
  assert.equal(defaultFit(480, 940), 'fill');
  assert.equal(defaultFit(1600, 2400), 'whole'); // 2:3 would lose too much width
  assert.equal(defaultFit(974, 691), 'whole'); // group shots stay whole
});

test('fill covers the frame and puts the focus point at the centre where it can', () => {
  const L = layout({ width: 936, height: 642, fit: 'fill', fx: 0.3 });
  assert.ok(L.rect.x <= 0 && L.rect.y <= 0 && L.rect.x + L.rect.w >= W - 1e-6 && L.rect.y + L.rect.h >= H - 1e-6);
  assert.ok(Math.abs(L.rect.x + 0.3 * L.rect.w - W / 2) < 1e-6);
  // A focus at the very edge is held so the photo still covers the frame.
  assert.equal(layout({ width: 936, height: 642, fit: 'fill', fx: 0 }).rect.x, 0);
});

test('movement is selective: whole photos and short shots hold still', () => {
  assert.equal(motionFor(layout({ width: 974, height: 691 }), 30, 0).kind, 'still');
  assert.equal(motionFor(layout({ width: 974, height: 691, fit: 'fill' }), MOTION.minSeconds - 1, 0).kind, 'still');
});

test('a wide filled photo nobody has positioned pans slowly within its edges; alternate shots pan the other way', () => {
  const L = layout({ width: 936, height: 642, fit: 'fill' });
  const a = motionFor(L, 20, 0), b = motionFor(L, 20, 1);
  assert.equal(a.kind, 'pan');
  assert.ok(Math.abs(a.x0 - a.x1) <= MOTION.panSpeed * 20 + 1e-6);
  for (const x of [a.x0, a.x1]) assert.ok(x <= 0 && x >= W - L.rect.w);
  assert.deepEqual([b.x0, b.x1], [a.x1, a.x0]);
  assert.equal(rectAt(L, a, 0).x, a.x0);
  assert.equal(rectAt(L, a, 1).x, a.x1);
});

test('once positioned, a filled photo holds that framing: it pushes in, never pans away from it', () => {
  const L = layout({ width: 936, height: 642, fit: 'fill', fx: 0.2 });
  const M = motionFor(L, 30, 0);
  assert.equal(M.kind, 'push');
  assert.ok(Math.abs(M.ax - (L.rect.x + 0.2 * L.rect.w)) < 1e-6);
});

test('a filled photo with little hidden pushes in towards the focus point, keeping it in place', () => {
  const L = layout({ width: 1080, height: 1920, fit: 'fill' });
  const M = motionFor(L, 20, 0);
  assert.equal(M.kind, 'push');
  const end = rectAt(L, M, 1);
  assert.ok(Math.abs(end.w / L.rect.w - MOTION.push) < 1e-9);
  // The focus point lands on the same spot of the canvas at the start and the end.
  const at = (r) => [r.x + L.focus.x * r.w, r.y + L.focus.y * r.h];
  assert.deepEqual(at(end).map((v) => v.toFixed(6)), at(L.rect).map((v) => v.toFixed(6)));
});

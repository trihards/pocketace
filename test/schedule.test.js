import test from 'node:test';
import assert from 'node:assert/strict';
import { schedule, parseTime, fmt } from '../public/schedule.js';

const ids = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}` }));
const contiguous = (shots, D) => {
  assert.equal(shots[0].start, 0);
  assert.equal(shots.at(-1).end, D);
  for (let i = 1; i < shots.length; i++) assert.equal(shots[i].start, shots[i - 1].end);
};

test('even split in the given order', () => {
  const { shots, warnings } = schedule({ duration: 60, photos: ids(4) });
  assert.deepEqual(shots.map((s) => s.id), ['p0', 'p1', 'p2', 'p3']);
  assert.deepEqual(shots.map((s) => s.end - s.start), [15, 15, 15, 15]);
  assert.deepEqual(warnings, []);
});

test('order is exactly the order given, whatever the old pin field says', () => {
  const photos = [{ id: 'c', pin: 0 }, { id: 'a' }, { id: 'b', pin: 5 }];
  const { shots } = schedule({ duration: 30, photos });
  assert.deepEqual(shots.map((s) => s.id), ['c', 'a', 'b']);
  contiguous(shots, 30);
});

test('weights share out the excerpt proportionally (the hook for draggable boundaries)', () => {
  const { shots } = schedule({ duration: 60, photos: [{ id: 'a', weight: 2 }, { id: 'b' }, { id: 'c', weight: 1 }] });
  assert.deepEqual(shots.map((s) => s.end - s.start), [30, 15, 15]);
  contiguous(shots, 60);
});

test('same input, same output', () => {
  assert.deepEqual(schedule({ duration: 420, photos: ids(9) }), schedule({ duration: 420, photos: ids(9) }));
});

test('boundaries land on whole frames and tile the excerpt', () => {
  const { shots } = schedule({ duration: 100, photos: ids(7) });
  for (const s of shots) assert.ok(Math.abs(s.start * 30 - Math.round(s.start * 30)) < 1e-6);
  contiguous(shots, 100);
});

test('too many or too few photos produce warnings, not failures', () => {
  assert.ok(schedule({ duration: 20, photos: ids(10) }).warnings.some((w) => w.includes('less than')));
  assert.ok(schedule({ duration: 600, photos: ids(2) }).warnings.some((w) => w.includes('longer than')));
  assert.throws(() => schedule({ duration: 20, photos: [] }));
});

test('time parsing and formatting', () => {
  assert.equal(parseTime('1:02:03.5'), 3723.5);
  assert.equal(parseTime('12:30'), 750);
  assert.ok(Number.isNaN(parseTime('abc')));
  assert.equal(fmt(83.25), '1:23.3');
});

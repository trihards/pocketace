import test from 'node:test';
import assert from 'node:assert/strict';
import { schedule, parseTime, fmt } from '../public/schedule.js';

const ids = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}` }));
const contiguous = (shots, D) => {
  assert.equal(shots[0].start, 0);
  assert.equal(shots.at(-1).end, D);
  for (let i = 1; i < shots.length; i++) assert.equal(shots[i].start, shots[i - 1].end);
};

test('no pins: even split in the given order', () => {
  const { shots, warnings } = schedule({ duration: 60, photos: ids(4) });
  assert.deepEqual(shots.map((s) => s.id), ['p0', 'p1', 'p2', 'p3']);
  assert.deepEqual(shots.map((s) => s.end - s.start), [15, 15, 15, 15]);
  assert.deepEqual(warnings, []);
});

test('a pinned photo starts exactly at its pin', () => {
  const photos = ids(6);
  photos[4].pin = 20;
  const { shots } = schedule({ duration: 45, photos });
  contiguous(shots, 45);
  const pinned = shots.find((s) => s.id === 'p4');
  assert.equal(pinned.start, 20);
  assert.equal(pinned.pinned, true);
  // Unpinned photos keep their relative order around the pin.
  assert.deepEqual(shots.map((s) => s.id), ['p0', 'p1', 'p2', 'p4', 'p3', 'p5']);
});

test("unpinned photos go where shots are longest (D'Hondt)", () => {
  const photos = ids(5);
  photos[0].pin = 50; // short lead (50s) vs. long tail (250s)
  const { shots } = schedule({ duration: 300, photos });
  contiguous(shots, 300);
  const before = shots.filter((s) => s.start < 50).length;
  assert.equal(before, 1);
  assert.equal(shots.length, 5);
});

test('pin at 0 opens the video with that photo', () => {
  const photos = ids(3);
  photos[2].pin = 0;
  const { shots } = schedule({ duration: 30, photos });
  assert.equal(shots[0].id, 'p2');
  contiguous(shots, 30);
});

test('only pinned photos: first pin is pulled to the start', () => {
  const photos = [{ id: 'a', pin: 10 }, { id: 'b', pin: 20 }];
  const { shots } = schedule({ duration: 30, photos });
  assert.deepEqual(shots.map((s) => [s.id, s.start, s.end]), [['a', 0, 20], ['b', 20, 30]]);
});

test('pins out of range or colliding are handled with warnings', () => {
  const photos = [{ id: 'a', pin: 99 }, { id: 'b', pin: 10 }, { id: 'c', pin: 10.5 }, { id: 'd' }];
  const { shots, warnings } = schedule({ duration: 40, photos });
  contiguous(shots, 40);
  assert.equal(shots.find((s) => s.id === 'c').start, 12);
  assert.ok(warnings.some((w) => w.includes('outside')));
  assert.ok(warnings.some((w) => w.includes('apart')));
});

test('same input, same output', () => {
  const photos = ids(9).map((p, i) => ({ ...p, pin: i === 3 ? 41.3 : i === 7 ? 200 : null }));
  assert.deepEqual(schedule({ duration: 420, photos }), schedule({ duration: 420, photos }));
});

test('boundaries land on whole frames', () => {
  const { shots } = schedule({ duration: 100, photos: ids(7) });
  for (const s of shots) assert.ok(Math.abs(s.start * 30 - Math.round(s.start * 30)) < 1e-6);
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

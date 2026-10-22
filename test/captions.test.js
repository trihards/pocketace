import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCaptions, clipCues, toSRT } from '../public/captions.js';
import { toASS } from '../lib/render.js';

const SRT = `1
00:01:00,000 --> 00:01:04,500
They were the black
Rolling Stones.

2
00:01:05,000 --> 00:01:09,000
<i>Madison Square Garden.</i>
`;

const VTT = `WEBVTT

NOTE written by hand

00:01:00.000 --> 00:01:04.500 align:center
They were the black
Rolling Stones.

intro
01:05.000 --> 01:09.000
Madison Square Garden.
`;

test('SRT and VTT parse to the same cues', () => {
  const a = parseCaptions(SRT);
  const b = parseCaptions(VTT);
  assert.equal(a.length, 2);
  assert.deepEqual(a, b);
  assert.equal(a[0].text, 'They were the black\nRolling Stones.');
  assert.equal(a[1].text, 'Madison Square Garden.');
});

test('clipping re-times cues to the excerpt and trims the edges', () => {
  const cues = clipCues(parseCaptions(SRT), 62, 67);
  assert.deepEqual(cues.map((c) => [c.start, c.end]), [[0, 2.5], [3, 5]]);
});

test('SRT round trip', () => {
  const cues = parseCaptions(SRT);
  assert.deepEqual(parseCaptions(toSRT(cues)), cues);
});

test('ASS output escapes braces and keeps line breaks', () => {
  const ass = toASS([{ start: 0, end: 1.5, text: 'a {b}\nc' }], 1080, 1920);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:01\.50,Cap,,0,0,0,,a \\\{b\\\}\\Nc/);
});

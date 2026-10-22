import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupEpisode, normalizeImage, guessGuest } from '../lib/extract.js';
import { startFixtureSite } from './fixture-site.js';

test('finds title, article photos and audio from all three sources', async () => {
  const site = await startFixtureSite();
  try {
    const r = await lookupEpisode(`${site.origin}/episodes/32/linda-shider`);
    assert.equal(r.title, 'Ep 32: Linda Shider [P-FUNK/GARRY SHIDER]');
    assert.equal(r.guest, 'Linda Shider');
    assert.deepEqual(r.sources.map((s) => [s.name, s.ok]), [['json', true], ['html', true], ['rss', true]]);
    // Audio found by audio block and RSS enclosure, deduplicated, RSS ranked first.
    assert.equal(r.audio.length, 1);
    assert.ok(r.audio[0].sources.includes('rss:enclosure'));
    // Article photos only: the header logo is excluded.
    const names = r.images.map((i) => i.key.split('/').pop());
    assert.deepEqual(names.sort(), ['a.jpg', 'b.jpg', 'c.jpg']);
    assert.equal(r.images.find((i) => i.key.endsWith('a.jpg')).width, 1800);
  } finally { site.close(); }
});

test('reports failures per source instead of throwing', async () => {
  const r = await lookupEpisode('https://example.invalid/episodes/1/x', {
    fetchText: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });
  assert.equal(r.sources.length, 3);
  assert.ok(r.sources.every((s) => !s.ok && s.note.includes('ENOTFOUND')));
});

test('Squarespace image URLs are asked for at 2500px', () => {
  assert.equal(
    normalizeImage('https://images.squarespace-cdn.com/content/v1/abc/123/photo.jpg?format=500w'),
    'https://images.squarespace-cdn.com/content/v1/abc/123/photo.jpg?format=2500w',
  );
  assert.equal(normalizeImage('https://example.com/a.jpg?x=1'), 'https://example.com/a.jpg?x=1');
});

test('guest name guess', () => {
  assert.equal(guessGuest('Ep 32: Linda Shider [P-FUNK/GARRY SHIDER]'), 'Linda Shider');
  assert.equal(guessGuest('Episode 2: Amuka, Bride of Funkenstein'), 'Amuka, Bride of Funkenstein');
});

test('an episode thumbnail that repeats a body photo under a new path is folded into it', async () => {
  const cdn = 'https://images.squarespace-cdn.com/content/v1/site';
  const page = (thumb) => async (url) => {
    if (url.includes('format=json')) return { status: 200, text: JSON.stringify({ item: { title: 'Ep 1: X', assetUrl: `${cdn}/111-AAA/${thumb}`, body: `<img data-src="${cdn}/222/HERO.png" data-image-dimensions="864x1332"><img data-src="${cdn}/333/stage.jpg">` } }) };
    return { status: 404, text: '' };
  };
  const twin = await lookupEpisode('https://example.com/episodes/1/x', { fetchText: page('HERO.jpg') });
  assert.deepEqual(twin.images.map((i) => i.key.split('/').pop()), ['HERO.png', 'stage.jpg']);
  assert.ok(twin.images[0].sources.includes('json:assetUrl'));
  const own = await lookupEpisode('https://example.com/episodes/1/x', { fetchText: page('cover.jpg') });
  assert.deepEqual(own.images.map((i) => i.key.split('/').pop()), ['cover.jpg', 'HERO.png', 'stage.jpg']);
});

// Runs the episode lookup on every episode in the podcast feed and prints one
// line per episode: sources that worked (json/html/rss), photo count, photos
// under 1080px on the long side, audio host, how the audio was found, title.
//
//   node tools/sweep.js [feed-url]   (default: the Aced Out episodes feed)

import { lookupEpisode } from '../lib/extract.js';

const feed = process.argv[2] || 'https://www.acedoutpodcast.com/episodes/?format=rss';
const xml = await (await fetch(feed)).text();
const links = [...xml.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>/g)].map((m) => m[1].trim());
const totals = { episodes: 0, allSources: 0, withAudio: 0, photos: 0, sized: 0, small: 0 };
for (const url of links) {
  const r = await lookupEpisode(url);
  const sizes = r.images.filter((i) => i.width).map((i) => Math.max(i.width, i.height));
  const ok = r.sources.map((s) => (s.ok ? 'Y' : 'n')).join('');
  const via = [...new Set((r.audio[0]?.sources || []).map((s) => s.split(':')[0]))].join('+');
  totals.episodes++; totals.allSources += ok === 'YYY'; totals.withAudio += r.audio.length > 0;
  totals.photos += r.images.length; totals.sized += sizes.length; totals.small += sizes.filter((d) => d < 1080).length;
  console.log([ok, String(r.images.length).padStart(3), String(sizes.filter((d) => d < 1080).length).padStart(3),
    (r.audio[0] ? new URL(r.audio[0].url).hostname : 'NO AUDIO').padEnd(36), via.padEnd(13), r.title].join(' | '));
}
console.log(`\n${JSON.stringify(totals)}`);

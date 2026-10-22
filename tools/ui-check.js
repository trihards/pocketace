// Browser acceptance check against a real Aced Out episode. Starts its own
// server, drives the page like a person would, and prints PASS/FAIL per item.
// Ends by rendering the arranged story and checking the MP4.
//
//   npm i --no-save playwright && npx playwright install webkit   (once)
//   node tools/ui-check.js [--browser webkit|chromium] [--quality draft|final] [--episode URL]
//
// WebKit is Safari's engine. Needs FFmpeg as for `npm start` (`npm run doctor`).

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tools } from '../lib/ffmpeg.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const pw = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || 'playwright'));
const browserName = arg('browser', 'chromium');
const quality = arg('quality', 'draft');
const { ffmpeg, ffprobe } = await tools();

let failures = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`); if (!ok) failures++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

let episode = arg('episode');
if (!episode) {
  const feed = await (await fetch('https://www.acedoutpodcast.com/episodes/?format=rss')).text();
  episode = [...feed.matchAll(/<link>([^<]+episodes\/29[^<]*)<\/link>/g)][0][1];
}

const port = 18900 + Math.floor(Math.random() * 90);
const work = mkdtempSync(path.join(os.tmpdir(), 'pocketace-ui-'));
const srv = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), WORK_DIR: work }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.on('data', (b) => String(b).includes('PocketAce on') && r()));
const base = `http://localhost:${port}`;

const browser = await pw[browserName].launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const val = (sel) => page.$eval(sel, (n) => n.value ?? n.textContent);
const seconds = (sel) => page.evaluate((s) => { const p = document.querySelector(s).value.split(':').map(Number); return p.reduce((a, n) => a * 60 + n, 0); }, sel);
const storyUrls = () => page.evaluate(() => window.pocketace.story.map((p) => p.url));

try {
  await page.goto(base);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // ---- Episode ----
  await page.fill('#episode-url', episode);
  await page.click('#lookup button');
  await page.waitForSelector('#gallery .thumb', { timeout: 60000 });
  await page.waitForFunction(() => Number.isFinite(document.querySelector('#audio').duration), null, { timeout: 90000 });
  const D = await page.$eval('#audio', (a) => a.duration);
  check(D > 600, 'episode audio loads', `${(D / 60).toFixed(1)} min`);

  // ---- Excerpt: fields ↔ handles ----
  await page.fill('#start', '13:01');
  await page.fill('#end', '18:05');
  const bar = await page.$eval('#range', (n) => { const r = n.getBoundingClientRect(); return { x: r.left, w: r.width, y: r.top + r.height / 2 }; });
  const handleX = (which) => page.$eval(`#h-${which}`, (n) => n.getBoundingClientRect()[n.id === 'h-start' ? 'right' : 'left']);
  check(near(await handleX('start'), bar.x + (781 / D) * bar.w, 1.5), 'typed start moves the start handle');
  check(near(await handleX('end'), bar.x + (1085 / D) * bar.w, 1.5), 'typed end moves the end handle');
  check((await page.textContent('#sum-excerpt')) === '13:01–18:05 · 5:04 selected', 'excerpt summary', await page.textContent('#sum-excerpt'));

  // Drag the start handle 40px right: the field follows, by the bar's scale.
  let hb = await page.$eval('#h-start', (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(hb.x, hb.y); await page.mouse.down(); await page.mouse.move(hb.x + 20, hb.y, { steps: 4 }); await page.mouse.move(hb.x + 40, hb.y, { steps: 4 }); await page.mouse.up();
  const afterDrag = await seconds('#start');
  check(near(afterDrag, 781 + (40 / bar.w) * D, 1.5), 'dragging the start handle updates the Start field', `${await val('#start')}`);
  const lenNow = (await page.textContent('#length')).split(':').map(Number).reduce((x, n) => x * 60 + n, 0);
  check(near(lenNow, (await seconds('#end')) - afterDrag, 0.06), 'length recalculates', await page.textContent('#length'));
  // Shift-drag: the same 40px moves a twentieth as far.
  hb = await page.$eval('#h-start', (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.keyboard.down('Shift');
  await page.mouse.move(hb.x, hb.y); await page.mouse.down(); await page.mouse.move(hb.x - 40, hb.y, { steps: 8 }); await page.mouse.up();
  await page.keyboard.up('Shift');
  const fine = afterDrag - (await seconds('#start'));
  check(near(fine, (40 / bar.w) * D * 0.05, 0.6), 'Shift-drag moves in fine steps', `${fine.toFixed(1)}s for 40px`);
  // Keyboard and nudge buttons.
  await page.fill('#start', '13:01');
  await page.focus('#h-start'); await page.keyboard.press('ArrowRight');
  check((await val('#start')) === '13:02.0', 'arrow key on a handle moves it one second', await val('#start'));
  await page.click('[data-nudge="end"][data-by="-1"]');
  check((await val('#end')) === '18:04.0', '−1s nudge moves the end', await val('#end'));
  await page.fill('#start', '13:01'); await page.fill('#end', '18:05');
  // Handles cannot cross.
  await page.focus('#h-end'); await page.keyboard.press('Home');
  check((await seconds('#end')) - (await seconds('#start')) >= 1, 'end handle stops short of the start', `${await val('#start')}–${await val('#end')}`);
  await page.fill('#end', '18:05');
  // Use current time.
  await page.$eval('#audio', (a) => { a.currentTime = 790; });
  await page.waitForTimeout(300);
  await page.click('[data-set="start"]');
  check(near(await seconds('#start'), 790, 0.2), 'Use current time sets the start', await val('#start'));
  const markX = await page.$eval('#range-play', (n) => n.getBoundingClientRect().left + 1);
  check(near(markX, bar.x + (790 / D) * bar.w, 1.5), 'playback marker shows the audio position, separate from the handles');
  await page.fill('#start', '13:01');

  // ---- Play excerpt stops at the end ----
  await page.fill('#start', '13:01'); await page.fill('#end', '13:04');
  await page.$eval('#audio', (a) => { a.muted = true; });
  await page.click('#play');
  await page.waitForFunction(() => document.querySelector('#audio').paused, null, { timeout: 20000 });
  const stopAt = await page.$eval('#audio', (a) => a.currentTime);
  check(near(stopAt, 784, 0.3), 'Play excerpt plays only the selection', `started 13:01, stopped at ${stopAt.toFixed(2)}s`);
  await page.fill('#start', '13:01'); await page.fill('#end', '18:05');

  // ---- Photos ----
  for (const i of [0, 3, 5, 7, 9, 11]) await page.locator('#gallery .thumb').nth(i).click();
  check((await page.textContent('#sum-photos')).startsWith('6 selected ·'), 'photos summary', await page.textContent('#sum-photos'));
  check((await page.textContent('#sum-story')) === '6 photos · 5:04 total', 'story summary', await page.textContent('#sum-story'));
  const original = await storyUrls();

  // ---- Arrange: drag tile 1 to between tiles 3 and 4 ----
  await page.locator('#strip-wrap').scrollIntoViewIfNeeded();
  const tileBox = async (i) => (await page.locator('#strip .tile').nth(i).boundingBox());
  const a = await tileBox(0), c = await tileBox(2), d = await tileBox(3);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(a.x + a.width, a.y + a.height / 2, { steps: 5 });
  await page.mouse.move((c.x + c.width + d.x) / 2 + 2, c.y + c.height / 2, { steps: 10 });
  await page.screenshot({ path: path.join(work, 'dragging.png') });
  await page.mouse.up();
  let order = await storyUrls();
  check(JSON.stringify(order) === JSON.stringify([original[1], original[2], original[0], ...original.slice(3)]), 'drag moves photo 1 to position 3');
  const stripOrder = await page.$$eval('#strip .tile', (ts) => ts.map((t) => t.style.backgroundImage));
  check(stripOrder.every((bg, i) => bg.includes(order[i].split('?')[0])), 'strip shows the new order');
  const badges = await page.$$eval('#gallery .thumb', (ts) => ts.map((t) => t.querySelector('.badge')?.textContent ?? null));
  check(badges[0] === '3', 'gallery badge follows the move', `first photo now badge ${badges[0]}`);
  const layerOrder = await page.evaluate(() => [...document.querySelectorAll('#layers .layer .fg img')].map((i) => i.getAttribute('src')));
  check(JSON.stringify(layerOrder) === JSON.stringify(order), 'preview plays in strip order');
  // Keyboard alternative: Option/Alt+Left moves the selected tile earlier.
  await page.locator('#strip .tile').nth(2).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  order = await storyUrls();
  check(order[1] === original[0], 'Alt+Left moves the photo one place earlier');
  // Toolbar buttons.
  await page.click('#move-later');
  order = await storyUrls();
  check(order[2] === original[0], '"Later" button moves it back');
  check(await page.$eval('#sel-info', (n) => n.textContent.startsWith('Photo 3 of 6')), 'toolbar names the selected photo', await page.textContent('#sel-info'));
  // Click inside a tile moves the preview there.
  const t4 = await tileBox(3);
  await page.mouse.click(t4.x + t4.width / 2, t4.y + t4.height / 2);
  const shot = await page.evaluate(() => window.pocketace.plan.shots[3]);
  const now = await page.$eval('#audio', (a) => a.currentTime);
  check(now - 781 > shot.start && now - 781 < shot.end, 'clicking a tile jumps the preview into that photo');
  const typeOnTop = await page.evaluate(() => ['.ov-brand', '#ov-guest'].every((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(s);
  }));
  check(typeOnTop, 'wordmark and guest name stay above a later photo in the preview');
  const finalOrder = await storyUrls();

  await page.fill('#guest', 'Rustee & Levi');

  // ---- Sections collapse independently, with summaries ----
  await page.click('#step-photos > summary');
  await page.click('#step-episode > summary');
  const open = await page.$$eval('details.step', (ds) => ds.map((d) => d.open));
  check(JSON.stringify(open) === '[false,true,false,true]', 'closing two sections leaves the others open', JSON.stringify(open));
  check(await page.isVisible('#sum-photos'), 'a collapsed section still shows its summary');

  // ---- Survives a reload ----
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForSelector('#strip .tile');
  check(JSON.stringify(await storyUrls()) === JSON.stringify(finalOrder), 'story order survives a reload');
  check((await val('#start')) === '13:01' && (await val('#end')) === '18:05', 'excerpt survives a reload');
  check((await val('#guest')) === 'Rustee & Levi', 'edited text survives a reload');
  check(JSON.stringify(await page.$$eval('details.step', (ds) => ds.map((d) => d.open))) === '[false,true,false,true]', 'open/closed sections survive a reload');
  check((await page.textContent('#sum-episode')).startsWith('Episode 29 ·'), 'episode summary after reload', await page.textContent('#sum-episode'));
  await page.waitForFunction(() => Number.isFinite(document.querySelector('#audio').duration), null, { timeout: 90000 });

  // ---- Render: the request carries the strip order; the MP4 comes out ----
  await page.check(`input[name=quality][value=${quality}]`);
  const req = page.waitForRequest((r) => r.url().endsWith('/api/render'));
  await page.click('#render');
  const sent = JSON.parse((await req).postData());
  check(JSON.stringify(sent.photos.map((p) => p.url)) === JSON.stringify(finalOrder) && sent.photos.every((p) => !('pin' in p)), 'render request uses the strip order, no pins');
  await page.waitForSelector('#result:not([hidden])', { timeout: 15 * 60e3 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  const mp4 = path.join(work, await download.suggestedFilename());
  await download.saveAs(mp4);
  const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', mp4]));
  const v = info.streams.find((s) => s.codec_type === 'video');
  check(near(Number(info.format.duration), 304, 0.1) && v.height === (quality === 'final' ? 1920 : 960), `downloaded ${quality} MP4`, `${path.basename(mp4)}, ${v.width}×${v.height}, ${Number(info.format.duration).toFixed(2)}s`);

  // Which photo is on screen in the middle of each shot? Compare a patch from
  // the centre of the framed photo with the centre of each source photo.
  const shots = await page.evaluate(() => window.pocketace.plan.shots);
  const patch = (input, ss, crop) => execFileSync(ffmpeg, ['-v', 'fatal', ...(ss != null ? ['-ss', String(ss)] : []), '-i', input, '-frames:v', '1', '-vf', `${crop},scale=8:8,format=gray`, '-f', 'rawvideo', '-']);
  const sources = finalOrder.map((u) => patch(u, null, 'crop=iw*0.3:ih*0.3:iw*0.35:ih*0.35'));
  const seen = shots.map((s) => {
    const f = patch(mp4, (s.start + s.end) / 2, `crop=iw*0.12:ih*0.05:iw*0.44:ih*${0.43 - 0.025}`);
    const dist = sources.map((src) => src.reduce((acc, b, k) => acc + Math.abs(b - f[k]), 0));
    return dist.indexOf(Math.min(...dist));
  });
  check(seen.every((idx, i) => idx === i), 'each shot in the MP4 shows the photo in that strip position', `matched ${JSON.stringify(seen)}`);
  writeFileSync(path.join(work, 'order.json'), JSON.stringify({ finalOrder, shots, mp4 }, null, 1));
  console.log(`\nVideo and screenshots: ${work}`);
} finally {
  check(errors.length === 0, 'no errors in the page', errors.join(' | '));
  await browser.close();
  srv.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;

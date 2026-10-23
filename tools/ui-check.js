// Browser acceptance check against a real Aced Out episode. Starts its own
// server, drives the page like a person would, and prints PASS/FAIL per item.
// Ends by rendering the arranged story and checking the MP4.
//
//   npm i --no-save playwright && npx playwright install webkit   (once)
//   node tools/ui-check.js [--browser webkit|chromium] [--quality draft|final] [--episode URL] [--heic FILE]
//
// Imported photos are generated on the fly (a 4032×3024 sideways phone JPEG,
// a PNG, a WebP). For HEIC it uses --heic, or makes one with macOS's `sips`;
// without either, that check is skipped. It uses a throwaway data folder, so
// nothing lands in the real data/uploads.
//
// WebKit is Safari's engine. Needs FFmpeg as for `npm start` (`npm run doctor`).

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tools } from '../lib/ffmpeg.js';
import { withOrientation } from '../test/images.js';
import { layout, motionFor, rectAt, transitionFor, W as CW, H as CH } from '../public/look.js';

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
const data = path.join(work, 'data');
const srv = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), WORK_DIR: work, DATA_DIR: data }, stdio: ['ignore', 'pipe', 'inherit'] });

// Photos "on Ace's computer".
const mine = path.join(work, 'mine');
mkdirSync(mine, { recursive: true });
const make = (name, src, extra = []) => { execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, '-frames:v', '1', ...extra, path.join(mine, name)]); return path.join(mine, name); };
const phone = make('IMG_4410.JPG', 'color=red:s=2016x1512[a];color=lime:s=2016x1512[b];color=blue:s=2016x1512[c];color=white:s=2016x1512[d];[a][b]hstack[t];[c][d]hstack[u];[t][u]vstack', ['-q:v', '2']);
writeFileSync(phone, withOrientation(readFileSync(phone), 6)); // stored landscape, shown portrait: 3024×4032
const studio = make('studio.png', 'mandelbrot=s=2400x1600:start_scale=0.4');
const hasWebp = execFileSync(ffmpeg, ['-hide_banner', '-encoders']).toString().includes('libwebp');
const bars = make(hasWebp ? 'bars.webp' : 'bars.png', 'smptehdbars=s=1600x1200');
const portrait = make('portrait.jpg', 'testsrc2=s=1800x2400', ['-q:v', '3']);
let heic = arg('heic');
if (!heic && process.platform === 'darwin') {
  try { heic = path.join(mine, 'IMG_4411.HEIC'); execFileSync('sips', ['-s', 'format', 'heic', portrait, '--out', heic], { stdio: 'ignore' }); } catch { heic = null; }
}
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
  // The show intro is on by default; the excerpt checks below run without it,
  // the intro gets its own checks after them.
  await page.waitForSelector('#intro-opt:not([hidden])');
  check(await page.isChecked('#intro'), 'Include show intro is on by default');
  const I = (await (await fetch(`${base}/api/health`)).json()).intro.duration;
  await page.uncheck('#intro');

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

  // ---- Excerpt playback follows the selection, not the episode player ----
  const audioState = () => page.$eval('#audio', (a) => ({ t: a.currentTime, paused: a.paused }));
  const playAndTrack = async () => {
    await page.click('#play');
    await page.waitForFunction(() => !document.querySelector('#audio').paused, null, { timeout: 20000 });
    const first = (await audioState()).t;
    await page.waitForFunction(() => document.querySelector('#audio').paused, null, { timeout: 20000 });
    return { first, stop: (await audioState()).t };
  };
  await page.fill('#start', '13:01'); await page.fill('#end', '13:04');
  // The episode player was left inside the excerpt, at 13:02.5.
  await page.$eval('#audio', (a) => { a.muted = true; a.currentTime = 782.5; });
  await page.waitForTimeout(300);
  let run = await playAndTrack();
  check(near(run.first, 781, 0.35), 'Play excerpt starts at Start, wherever the episode player was', `episode at 13:02.5, excerpt started at ${run.first.toFixed(2)}s`);
  check(near(run.stop, 784, 0.3), 'Play excerpt stops at End', `stopped at ${run.stop.toFixed(2)}s`);
  await page.click('[data-nudge="start"][data-by="1"]');
  run = await playAndTrack();
  check(near(run.first, 782, 0.35) && near(run.stop, 784, 0.3), 'after moving Start, it plays the new selection', `${run.first.toFixed(2)}–${run.stop.toFixed(2)}s`);
  // Exploring the episode doesn't move the excerpt preview, and a seek there lets go of the excerpt.
  await page.fill('#start', '13:01'); await page.fill('#end', '13:20');
  await page.click('#play');
  await page.waitForTimeout(900);
  await page.$eval('#audio', (a) => { a.currentTime = 1000; });
  await page.waitForTimeout(500);
  const left = await page.evaluate(() => ({ btn: document.querySelector('#play').textContent, clock: document.querySelector('#clock').textContent, t: document.querySelector('#audio').currentTime, paused: document.querySelector('#audio').paused }));
  check(left.btn.includes('Play excerpt') && !left.paused && left.t > 999 && /^0:0[0-2]/.test(left.clock), 'seeking in the episode player keeps playing the episode and leaves the preview where it was', `${left.btn}, episode at ${left.t.toFixed(1)}s, preview ${left.clock}`);
  await page.$eval('#audio', (a) => a.pause());

  // ---- The show intro in the preview ----
  await page.check('#intro');
  await page.fill('#start', '13:01'); await page.fill('#end', '13:04');
  check((await page.textContent('#clock')) === `0:00.0 / 0:${(I + 3).toFixed(1).padStart(4, '0')}`, 'the clock shows intro + excerpt as the video length, from 0:00', await page.textContent('#clock'));
  await page.$eval('#intro-audio', (a) => { a.muted = true; });
  await page.click('#play');
  await page.waitForFunction(() => !document.querySelector('#intro-audio').paused, null, { timeout: 10000 });
  await page.waitForTimeout(1500);
  const during = await page.evaluate(() => ({ card: !document.querySelector('#intro-card').hidden, episodePaused: document.querySelector('#audio').paused, clock: document.querySelector('#clock').textContent }));
  check(during.card && during.episodePaused && /^0:0[1-2]/.test(during.clock), 'Play excerpt from the start plays the intro first, over the splash', `${during.clock}`);
  await page.waitForFunction(() => !document.querySelector('#audio').paused, null, { timeout: 15000 });
  const handover = await page.evaluate(() => ({ t: document.querySelector('#audio').currentTime, card: document.querySelector('#intro-card').hidden }));
  check(near(handover.t, 781, 0.35) && handover.card, 'then the excerpt starts exactly at Start, and the splash is gone', `episode at ${handover.t.toFixed(2)}s`);
  await page.waitForFunction(() => document.querySelector('#audio').paused, null, { timeout: 15000 });
  check(near(await page.$eval('#audio', (a) => a.currentTime), 784, 0.3), 'and stops at End as before');
  await page.fill('#start', '13:01'); await page.fill('#end', '18:05');

  // ---- Photos ----
  for (const i of [0, 3, 5, 7, 9, 11]) await page.locator('#gallery .thumb').nth(i).click();
  check(/ available · 6 in the story$/.test(await page.textContent('#sum-photos')), 'photos summary', await page.textContent('#sum-photos'));
  check((await page.textContent('#sum-story')) === '6 photos · 5:04 total', 'story summary', await page.textContent('#sum-story'));

  // ---- Photos from the computer ----
  await page.setInputFiles('#import-files', [phone, studio, bars]);
  await page.waitForFunction(() => /^Added 3 photos/.test(document.querySelector('#import-status').textContent), null, { timeout: 60000 });
  const imported = await page.evaluate(() => window.pocketace.library.filter((p) => p.local));
  check(imported.length === 3 && (await page.locator('#gallery .gitem.local').count()) === 3, 'Add photos imports several files into the gallery', await page.textContent('#import-status'));
  const ph = imported.find((p) => p.name === 'IMG_4410.JPG');
  check(ph.width === 3024 && ph.height === 4032, 'a sideways phone photo keeps its full resolution, upright', `${ph.width}×${ph.height}`);
  const stored = Buffer.from(await (await fetch(base + ph.url)).arrayBuffer());
  check(stored.equals(readFileSync(phone)), 'the original file is stored unchanged', `${(stored.length / 1e6).toFixed(1)} MB`);
  // Drag and drop: one new photo, and one already imported.
  const dropFiles = [portrait, studio].map((f) => ({ name: path.basename(f), type: f.endsWith('.png') ? 'image/png' : 'image/jpeg', b64: readFileSync(f).toString('base64') }));
  await page.locator('#step-photos').scrollIntoViewIfNeeded();
  await page.evaluate((files) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    const target = document.querySelector('#gallery');
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, dropFiles);
  await page.waitForFunction(() => /Added 1 photo/.test(document.querySelector('#import-status').textContent), null, { timeout: 60000 });
  check((await page.textContent('#import-status')).includes('already in the gallery'), 'dropping photos adds them; a repeat is recognised', await page.textContent('#import-status'));
  if (heic && existsSync(heic)) {
    await page.setInputFiles('#import-files', [heic]);
    await page.waitForFunction(() => !/Adding/.test(document.querySelector('#import-status').textContent), null, { timeout: 60000 });
    const msg = await page.textContent('#import-status');
    const conv = await page.evaluate(() => window.pocketace.library.find((p) => p.local && p.name.startsWith('IMG_4411')));
    check(conv ? conv.width >= 1000 && conv.url.endsWith('.jpg') : /HEIC photo \(Apple's format\).*Safari/.test(msg), `HEIC: ${conv ? 'converted to a full-size JPEG' : 'friendly explanation in this browser'}`, conv ? `${conv.width}×${conv.height}` : msg.slice(0, 90));
  } else console.log('SKIP  HEIC (no sample; pass --heic FILE)');
  const thumbsOk = await page.$$eval('#gallery .gitem.local img', (imgs) => imgs.every((i) => i.complete && i.naturalWidth > 0));
  check(thumbsOk, 'imported photos show thumbnails');
  // Put two imported photos in the story: the phone photo and the PNG.
  const gIndex = (name) => page.evaluate((n) => window.pocketace.library.findIndex((p) => p.name === n), name);
  await page.locator('#gallery .thumb').nth(await gIndex('IMG_4410.JPG')).click();
  await page.locator('#gallery .thumb').nth(await gIndex('studio.png')).click();
  const original = await storyUrls();
  check(original.length === 8 && original.slice(-2).every((u) => u.startsWith('/uploads/')), 'imported photos join the story like any other');

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
  // Website tiles show the photo at a small size, imported ones their thumbnail: compare what both keep.
  check(stripOrder.every((bg, i) => bg.includes(order[i].split('?')[0].replace(/\.(jpg|png|webp|gif)$/, ''))), 'strip shows the new order');
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
  check(await page.$eval('#sel-info', (n) => n.textContent.startsWith('Photo 3 of 8')), 'toolbar names the selected photo', await page.textContent('#sel-info'));
  // Click inside a tile moves the preview there, and Play excerpt carries on from that photo.
  const t4 = await tileBox(3);
  await page.mouse.click(t4.x + t4.width / 2, t4.y + t4.height / 2);
  const shot = await page.evaluate(() => window.pocketace.plan.shots[3]);
  const clockAt = (await page.textContent('#clock')).split(' / ')[0].split(':').map(Number).reduce((x, n) => x * 60 + n, 0);
  check(clockAt > shot.start && clockAt < shot.end, 'clicking a tile shows that moment in the preview', `${clockAt}s`);
  await page.click('#play');
  await page.waitForFunction(() => !document.querySelector('#audio').paused, null, { timeout: 20000 });
  const fromTile = (await audioState()).t - 781;
  await page.$eval('#audio', (a) => a.pause());
  check(fromTile > shot.start && fromTile < shot.end, 'Play excerpt then starts from that photo', `${fromTile.toFixed(1)}s into the excerpt`);
  const typeOnTop = await page.evaluate(() => ['.ov-brand', '#ov-guest'].every((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(s);
  }));
  check(typeOnTop, 'wordmark and guest name stay above a later photo in the preview');

  // ---- The gallery is a supply: each tap adds another copy ----
  const firstUrl = (await storyUrls())[0];
  const g0 = await page.evaluate((u) => window.pocketace.library.findIndex((p) => p.url === u), firstUrl);
  await page.locator('#gallery .thumb').nth(g0).click();
  await page.locator('#gallery .thumb').nth(g0).click();
  let st = await page.evaluate(() => window.pocketace.story);
  check(st.length === 10 && st[8].url === firstUrl && st[9].url === firstUrl && new Set(st.map((p) => p.id)).size === 10, 'tapping a photo again adds another copy at the end (never removes)', `${st.length} in the story`);
  check((await page.locator('#gallery .thumb').nth(g0).locator('.badge').textContent()) === '×3', 'the gallery badge counts the copies');
  // Move the last copy to position 5 with the keyboard; the other copies stay put.
  await page.locator('#strip-wrap').scrollIntoViewIfNeeded();
  await page.locator('#strip .tile').nth(9).focus();
  for (let k = 0; k < 5; k++) await page.keyboard.press('Alt+ArrowLeft');
  const movedId = st[9].id;
  st = await page.evaluate(() => window.pocketace.story);
  check(st[4].id === movedId && st[0].url === firstUrl && st[9].url === firstUrl, 'each copy is reordered on its own');
  // Take the copy at the end out with its ✕ on the strip.
  const lastCell = page.locator('#strip .cell').nth(9);
  await lastCell.hover();
  await lastCell.locator('.x').click();
  st = await page.evaluate(() => window.pocketace.story);
  check(st.length === 9 && st.filter((p) => p.url === firstUrl).length === 2 && st[4].id === movedId, '✕ on the strip takes out just that copy');
  check((await page.locator('#gallery .thumb').nth(g0).locator('.badge').textContent()) === '×2', 'and the badge counts down');
  const layerSrcs = await page.evaluate(() => [...document.querySelectorAll('#layers .layer .fg img')].map((i) => i.getAttribute('src')));
  check(JSON.stringify(layerSrcs) === JSON.stringify(st.map((p) => p.url)), 'the preview plays every copy, in strip order');

  // ---- Whole photo or fill frame, per copy ----
  await page.locator('#strip-wrap').scrollIntoViewIfNeeded();
  await page.locator('#strip .tile').nth(0).click();
  const pressed = () => page.$eval('.fit [aria-pressed="true"]', (b) => b.dataset.fit);
  check((await pressed()) === 'whole', 'a landscape photo is shown whole unless chosen otherwise');
  await page.click('[data-fit="fill"]');
  let s0 = await page.evaluate(() => window.pocketace.story[0]);
  check(s0.fit === 'fill' && (await page.locator('#strip .tile').nth(0).getAttribute('class')).includes('filled') && /Drag the photo/.test(await page.textContent('#fit-hint')), 'Fill frame applies to that copy, and says how to reposition it');
  const imgLeft = () => page.evaluate(() => { const t = window.pocketace.plan.shots[0]; return document.querySelectorAll('#layers .layer .fg img')[0].style.left; });
  const before = await imgLeft();
  const stageBox = await page.locator('#stage').boundingBox();
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + stageBox.width / 2 + 60, stageBox.y + stageBox.height / 2, { steps: 6 });
  await page.mouse.up();
  s0 = await page.evaluate(() => window.pocketace.story[0]);
  check(Number.isFinite(s0.fx) && s0.fx < 0.5 && (await imgLeft()) !== before, 'dragging the preview moves what the filled photo shows', `focus ${s0.fx?.toFixed(3)}`);
  const fxDragged = s0.fx;
  await page.focus('#stage'); await page.keyboard.press('ArrowRight');
  s0 = await page.evaluate(() => window.pocketace.story[0]);
  check(s0.fx > fxDragged, 'arrow keys on the preview move it too', `focus ${s0.fx.toFixed(3)}`);
  await page.click('#recentre');
  s0 = await page.evaluate(() => window.pocketace.story[0]);
  check(s0.fx === undefined && s0.fit === 'fill', 'Recentre goes back to the middle');
  await page.focus('#stage'); for (let k = 0; k < 3; k++) await page.keyboard.press('ArrowLeft');
  const otherCopy = (await page.evaluate(() => window.pocketace.story)).findIndex((p, i) => i > 0 && p.url === firstUrl);
  check((await page.evaluate((i) => window.pocketace.story[i].fit, otherCopy)) === undefined, 'another copy of the same photo keeps its own setting');
  const finalOrder = await storyUrls();
  const finalIds = st.map((p) => p.id);
  const finalLooks = await page.evaluate(() => window.pocketace.story.map((p) => ({ fit: p.fit, fx: p.fx, fy: p.fy })));

  await page.fill('#guest', 'Rustee & Levi');

  // The phone photo is shown upright and full size in the preview, with the shape the render uses.
  const phoneAt = finalOrder.indexOf(ph.url);
  await page.locator('#strip .tile').nth(phoneAt).click();
  await page.waitForTimeout(500);
  const layer = await page.evaluate((i) => { const l = document.querySelectorAll('#layers .layer')[i]; const img = l.querySelector('.fg img'); return { w: img.naturalWidth, h: img.naturalHeight, opacity: l.style.opacity }; }, phoneAt);
  check(layer.w === 3024 && layer.h === 4032 && layer.opacity === '1', 'the preview shows the imported phone photo upright at full resolution', `${layer.w}×${layer.h}`);

  // ---- Sections collapse independently, with summaries ----
  await page.click('#step-photos > summary');
  await page.click('#step-episode > summary');
  const open = await page.$$eval('details.step', (ds) => ds.map((d) => d.open));
  check(JSON.stringify(open) === '[false,true,false,true]', 'closing two sections leaves the others open', JSON.stringify(open));
  check(await page.isVisible('#sum-photos'), 'a collapsed section still shows its summary');
  const shut = await page.$$eval('details.step:not([open])', (ds) => ds.map((d) => Math.round(d.getBoundingClientRect().height)));
  check(shut.every((h) => h < 80), 'collapsed sections stay compact', `${shut.join(', ')} px`);

  // ---- Survives a reload ----
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForSelector('#strip .tile');
  check(JSON.stringify(await storyUrls()) === JSON.stringify(finalOrder), 'story order survives a reload');
  check(JSON.stringify(await page.evaluate(() => window.pocketace.story.map((p) => p.id))) === JSON.stringify(finalIds), 'repeated copies survive a reload as separate copies');
  check(JSON.stringify(await page.evaluate(() => window.pocketace.story.map((p) => ({ fit: p.fit, fx: p.fx, fy: p.fy })))) === JSON.stringify(finalLooks), 'whole/fill choices and positions survive a reload');
  check(await page.isChecked('#intro'), 'the intro setting survives a reload');
  check((await val('#start')) === '13:01' && (await val('#end')) === '18:05', 'excerpt survives a reload');
  check((await val('#guest')) === 'Rustee & Levi', 'edited text survives a reload');
  check(JSON.stringify(await page.$$eval('details.step', (ds) => ds.map((d) => d.open))) === '[false,true,false,true]', 'open/closed sections survive a reload');
  check((await page.textContent('#sum-episode')).startsWith('Episode 29 ·'), 'episode summary after reload', await page.textContent('#sum-episode'));
  await page.$eval('#step-photos', (d) => { d.open = true; });
  await page.waitForTimeout(500);
  const localAfter = await page.$$eval('#gallery .gitem.local img', (imgs) => imgs.map((i) => i.complete && i.naturalWidth > 0));
  check(localAfter.length >= 4 && localAfter.every(Boolean), 'imported photos are still there after a reload', `${localAfter.length} imported`);
  await page.waitForFunction(() => Number.isFinite(document.querySelector('#audio').duration), null, { timeout: 90000 });

  // ---- Render: the request carries the strip order; the MP4 comes out ----
  await page.check(`input[name=quality][value=${quality}]`);
  const req = page.waitForRequest((r) => r.url().endsWith('/api/render'));
  await page.click('#render');
  const sent = JSON.parse((await req).postData());
  check(JSON.stringify(sent.photos.map((p) => p.url)) === JSON.stringify(finalOrder) && sent.photos.every((p) => !('pin' in p)) && sent.photos[0].fit === 'fill' && sent.photos[0].fx === finalLooks[0].fx && sent.intro === true, 'render request uses the strip order, each copy\'s whole/fill choice, and the intro');
  check(/Making the video/.test(await page.textContent('#render')), 'progress shows in the button while it renders', await page.textContent('#render'));
  await page.waitForSelector('#download:not([hidden])', { timeout: 15 * 60e3 });
  await page.waitForTimeout(400);
  const ready = await page.evaluate(() => {
    const r = document.querySelector('#download').getBoundingClientRect();
    const v = document.querySelector('#result-video');
    const col = document.querySelector('#preview-col');
    return { inView: r.top >= 0 && r.bottom <= innerHeight, video: !v.hidden && v.getBoundingClientRect().height > 200, again: document.querySelector('#render').textContent, overflow: getComputedStyle(col).overflowY, scrolls: col.scrollHeight > col.clientHeight + 1 };
  });
  await page.screenshot({ path: path.join(work, 'ready.png') });
  check(ready.inView && ready.video, 'when the video is ready it plays in the phone frame, with Download MP4 in view');
  check(ready.again === 'Make it again', 'Download MP4 becomes the main button; Make it again sits beside it');
  check(ready.overflow === 'visible' && !ready.scrolls, 'the preview column has no scrolling of its own');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  const mp4 = path.join(work, await download.suggestedFilename());
  await download.saveAs(mp4);
  const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', mp4]));
  const v = info.streams.find((s) => s.codec_type === 'video');
  check(near(Number(info.format.duration), 304 + I, 0.1) && v.height === (quality === 'final' ? 1920 : 960), `downloaded ${quality} MP4 with the intro: excerpt + intro long`, `${path.basename(mp4)}, ${v.width}×${v.height}, ${Number(info.format.duration).toFixed(2)}s`);
  const streams = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', mp4])).streams;
  check(streams.every((st) => near(Number(st.duration), 304 + I, 0.05)), 'audio and video tracks are the same length', streams.map((st) => `${st.codec_type} ${Number(st.duration).toFixed(3)}`).join(', '));

  // Which photo is on screen in the middle of each shot? Compare a patch from
  // the centre of the framed photo with the centre of each source photo.
  const shots = await page.evaluate(() => window.pocketace.plan.shots);
  const patch = (input, ss, crop) => execFileSync(ffmpeg, ['-v', 'fatal', ...(ss != null ? ['-ss', String(ss)] : []), '-i', input, '-frames:v', '1', '-vf', `${crop},scale=8:8,format=gray`, '-f', 'rawvideo', '-']);
  // For each shot, the patch of the source photo that look.js says sits under
  // the sampled spot of the frame at mid-shot: whole or filled, panned or pushed.
  const dims = await page.evaluate(() => [...document.querySelectorAll('#layers .layer .fg img')].map((i) => ({ width: i.naturalWidth, height: i.naturalHeight })));
  const story = await page.evaluate(() => window.pocketace.story);
  const T = transitionFor(shots);
  const spot = { x: CW * 0.46, y: CH * 0.41, w: CW * 0.08, h: CH * 0.04 };
  const expected = shots.map((s, i) => {
    const L = layout({ ...dims[i], fit: story[i].fit, fx: story[i].fx, fy: story[i].fy });
    const clipStart = i > 0 ? s.start - T : 0, mid = (s.start + s.end) / 2;
    const R = rectAt(L, motionFor(L, s.end - clipStart, i), (mid - clipStart) / (s.end - clipStart));
    const fx = (spot.x - R.x) / R.w, fy = (spot.y - R.y) / R.h;
    return patch(story[i].url.startsWith('/') ? base + story[i].url : story[i].url, null, `crop=iw*${(spot.w / R.w).toFixed(5)}:ih*${(spot.h / R.h).toFixed(5)}:iw*${fx.toFixed(5)}:ih*${fy.toFixed(5)}`);
  });
  const dist = (a, b) => a.reduce((acc, v, k) => acc + Math.abs(v - b[k]), 0);
  const seen = shots.map((s, i) => {
    const f = patch(mp4, I + (s.start + s.end) / 2, `crop=iw*${spot.w / CW}:ih*${spot.h / CH}:iw*${spot.x / CW}:ih*${spot.y / CH}`);
    const d = expected.map((e) => dist(e, f));
    return d[i] <= Math.min(...d) ? i : d.indexOf(Math.min(...d)); // ties (repeats) count as a match
  });
  check(seen.every((idx, i) => idx === i), 'each shot in the MP4 shows the expected part of the photo in that strip position (fills, repeats and imports included)', `matched ${JSON.stringify(seen)}`);

  // ---- The same story without the intro ----
  await page.uncheck('#intro');
  check((await page.textContent('#render')) === 'Make the video', 'turning the intro off asks for a new video');
  await page.click('#render');
  await page.waitForSelector('#download:not([hidden])', { timeout: 15 * 60e3 });
  const [download2] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  const mp4b = path.join(work, `no-intro-${await download2.suggestedFilename()}`);
  await download2.saveAs(mp4b);
  check(near(Number(JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', mp4b])).format.duration), 304, 0.05), 'without the intro the video is exactly the excerpt long');
  // The story is the same in both, just I seconds later with the intro: compare frames.
  const grey = (f, t) => execFileSync(ffmpeg, ['-v', 'fatal', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', 'scale=27:48,crop=27:34:0:0,format=gray', '-f', 'rawvideo', '-']);
  const offsets = [5, 60, 150, 250].map((t) => dist(grey(mp4, I + t), grey(mp4b, t)) / (27 * 34));
  check(offsets.every((d) => d < 4), 'the story in the intro video is the no-intro story, shifted by exactly the intro', offsets.map((d) => d.toFixed(1)).join(', '));
  await page.check('#intro');

  // Changing anything puts "Make the video" back in front, and keeps the earlier file reachable.
  await page.$eval('#step-episode', (d) => { d.open = true; });
  await page.fill('#guest', 'Rustee & Levi!');
  const edited = await page.evaluate(() => ({ btn: document.querySelector('#render').textContent, primary: document.querySelector('#render').classList.contains('primary'), dl: document.querySelector('#download').hidden, earlier: !document.querySelector('#earlier').hidden, stage: !document.querySelector('#stage').hidden }));
  check(edited.btn === 'Make the video' && edited.primary && edited.dl && edited.earlier && edited.stage, 'after an edit: Make the video again, live preview back, earlier file still offered');
  check(!/^Ready/.test(await page.textContent('#job-status')), 'and the "Ready" line goes, since it no longer is');

  // Smaller Mac screens: one page scroll, and the render button stays in reach beside the strip.
  for (const [w, h] of [[1280, 720], [1440, 800]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.locator('#strip-wrap').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const fit = await page.evaluate(() => { const b = document.querySelector('#render').getBoundingClientRect(); const ph = document.querySelector('.phone').getBoundingClientRect(); return { btn: b.top >= 0 && b.bottom <= innerHeight, phone: ph.height > 250 && ph.top > -1 }; });
    await page.screenshot({ path: path.join(work, `arrange-${w}x${h}.png`) });
    check(fit.btn && fit.phone, `${w}×${h}: preview and Make the video in view while arranging the story`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // ---- Removing imported photos ----
  const removeByName = async (n) => {
    const item = page.locator('#gallery .gitem').nth(await gIndex(n));
    await item.scrollIntoViewIfNeeded();
    await item.hover();
    await item.locator('.remove').click();
  };
  await removeByName(path.basename(bars));
  check(!(await page.evaluate((n) => window.pocketace.library.some((p) => p.name === n), path.basename(bars))), 'an imported photo can be removed from the gallery');
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); d.accept(); });
  await removeByName('studio.png');
  const after = await storyUrls();
  check(asked.includes('in your story') && after.length === finalOrder.length - 1 && after.every((u) => !u.endsWith('.png')), 'removing one that is in the story asks first, then takes it out of the story too', asked);
  // A file that has vanished from the computer is shown as missing, not silently broken.
  const id = ph.url.slice('/uploads/'.length, '/uploads/'.length + 64);
  for (const f of readdirSync(path.join(data, 'uploads')).filter((f) => f.startsWith(id))) rmSync(path.join(data, 'uploads', f));
  await page.reload();
  await page.$eval('#step-photos', (d) => { d.open = true; });
  await page.waitForTimeout(1500);
  check((await page.locator('#gallery .gitem.missing').count()) === 1, 'an imported file that has gone is marked "Missing"');
  const warn = await page.textContent('#warnings');
  check(/no longer on this computer/.test(warn), 'and the story says so before any render', warn.slice(0, 80));
  writeFileSync(path.join(work, 'order.json'), JSON.stringify({ finalOrder, shots, mp4 }, null, 1));
  console.log(`\nVideo and screenshots: ${work}`);
} finally {
  check(errors.length === 0, 'no errors in the page', errors.join(' | '));
  await browser.close();
  srv.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;

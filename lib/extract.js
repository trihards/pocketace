// Episode lookup: given a public episode page URL, find the title, the photos
// and the audio. Runs on the server because Squarespace pages are not
// readable from another origin in the browser (CORS).
//
// Three independent sources, tried in order and merged:
//   1. <page>?format=json  Squarespace's built-in JSON view of a page
//   2. the page HTML       audio blocks, <img>, og: tags
//   3. the podcast RSS     <enclosure> is the most stable audio reference
// Every finding records where it came from, so a broken source is easy to
// spot when Squarespace changes something.

const AUDIO_RE = /\.(mp3|m4a|aac|wav|ogg)(?:$|[?#/])/i;
const SQS_IMAGE_RE = /^https?:\/\/(images\.squarespace-cdn\.com|static1\.squarespace\.com)\//i;
const PLAYER_HOSTS = /(libsyn|buzzsprout|anchor\.fm|spotify|soundcloud|simplecast|podbean|megaphone|captivate|transistor|spreaker)/i;

export async function lookupEpisode(pageUrl, { fetchText = defaultFetchText } = {}) {
  const url = new URL(pageUrl);
  const report = { url: url.href, title: null, guest: null, audio: [], images: [], players: [], rss: null, textLength: 0, transcript: null, sources: [] };

  // 1. Squarespace JSON
  const jsonUrl = new URL(url.href);
  jsonUrl.searchParams.set('format', 'json');
  const j = await attempt(report, 'json', jsonUrl.href, fetchText, (body) => {
    const data = JSON.parse(body);
    const item = data.item || data;
    if (item.title) report.title ||= decode(item.title);
    walkStrings(item, (s, key) => {
      if (AUDIO_RE.test(s) && /^https?:/.test(s)) addAudio(report, s, `json:${key}`);
      // Skip the post author's profile picture (seen on the live site as avatarUrl).
      if (/avatar/i.test(key) || /memberAccountAvatars/.test(s)) return;
      if (SQS_IMAGE_RE.test(s) && !AUDIO_RE.test(s) && looksLikeImage(s)) addImage(report, s, `json:${key}`);
    });
    if (typeof item.body === 'string') scanHtml(report, item.body, 'json:body');
    return true;
  });

  // 2. HTML page (always fetched: it is the human-facing truth and has og: tags)
  await attempt(report, 'html', url.href, fetchText, (html) => {
    report.title ||= meta(html, 'og:title') || tag(html, 'h1') || tag(html, 'title');
    report.title = report.title?.replace(/\s+/g, ' ').trim() || null;
    const main = html.match(/<article[\s\S]*?<\/article>/i)?.[0] || html.match(/<main[\s\S]*?<\/main>/i)?.[0];
    // Without an <article>, scanning the whole page would pull in site chrome
    // (logo, footer art), so only fall back to it when the JSON gave nothing.
    if (main || !j) scanHtml(report, main || html, main ? 'html:article' : 'html:page');
    // og:image repeats the JSON thumbnail under a different host and path, so
    // it is only useful when the JSON view failed.
    const ogImage = meta(html, 'og:image');
    if (ogImage && !j) addImage(report, ogImage, 'html:og:image');
    const ogAudio = meta(html, 'og:audio');
    if (ogAudio) addAudio(report, ogAudio, 'html:og:audio');
    const rssHref = html.match(/<link[^>]+type="application\/rss\+xml"[^>]*>/i)?.[0]?.match(/href="([^"]+)"/)?.[1];
    if (rssHref) report.rss = new URL(decode(rssHref), url).href;
    return true;
  });

  // 3. RSS: the episode's <item> is matched by its <link>.
  const rssUrl = report.rss || new URL(`/${url.pathname.split('/')[1]}?format=rss`, url).href;
  await attempt(report, 'rss', rssUrl, fetchText, (xml) => {
    report.rss = rssUrl;
    const items = xml.split(/<item[\s>]/i).slice(1);
    const want = url.pathname.replace(/\/$/, '');
    const hit = items.find((it) => {
      const link = it.match(/<link>([^<]+)<\/link>/i)?.[1]?.trim();
      return link && new URL(decode(link), url).pathname.replace(/\/$/, '') === want;
    });
    if (!hit) return 'feed loaded, episode not found in it';
    const enc = hit.match(/<enclosure[^>]+url="([^"]+)"/i)?.[1];
    if (enc) addAudio(report, decode(enc), 'rss:enclosure');
    const img = hit.match(/<itunes:image[^>]+href="([^"]+)"/i)?.[1];
    if (img) addImage(report, decode(img), 'rss:itunes:image');
    const tr = hit.match(/<podcast:transcript[^>]+url="([^"]+)"[^>]*>/i);
    if (tr) report.transcript = { url: decode(tr[1]), source: 'rss:podcast:transcript' };
    report.title ||= cdata(hit.match(/<title>([\s\S]*?)<\/title>/i)?.[1]);
    return true;
  });

  // Rank audio: RSS enclosure first (that is what podcast apps play), then the rest.
  report.audio.sort((a, b) => rank(a) - rank(b));
  report.textLength = report.textLength || 0;
  report.guest = guessGuest(report.title);
  return report;
}

function rank(a) { return a.sources.some((s) => s.startsWith('rss')) ? 0 : a.sources.some((s) => s.includes('audio')) ? 1 : 2; }

async function attempt(report, name, url, fetchText, parse) {
  const entry = { name, url, ok: false, status: null, note: null };
  report.sources.push(entry);
  try {
    const res = await fetchText(url);
    entry.status = res.status;
    entry.cors = res.headers?.['access-control-allow-origin'] ?? null;
    if (res.status !== 200) { entry.note = `HTTP ${res.status}`; return false; }
    const out = parse(res.text);
    entry.ok = out === true;
    if (typeof out === 'string') entry.note = out;
    return entry.ok;
  } catch (err) {
    entry.note = err.message;
    return false;
  }
}

function scanHtml(report, html, source) {
  // Squarespace audio block: <div class="sqs-audio-embed" data-url="...mp3">
  for (const m of html.matchAll(/data-url="([^"]+)"/gi)) if (AUDIO_RE.test(m[1])) addAudio(report, decode(m[1]), `${source}:audio-block`);
  for (const m of html.matchAll(/<(?:audio|source)[^>]+src="([^"]+)"/gi)) if (AUDIO_RE.test(m[1])) addAudio(report, decode(m[1]), `${source}:audio-tag`);
  for (const m of html.matchAll(/href="([^"]+)"/gi)) if (AUDIO_RE.test(m[1])) addAudio(report, decode(m[1]), `${source}:link`);
  for (const m of html.matchAll(/<iframe[^>]+src="([^"]+)"/gi)) if (PLAYER_HOSTS.test(m[1])) report.players.push(decode(m[1]));
  // Images: Squarespace lazy-loads, so the real URL is often in data-src/data-image.
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const el = m[0];
    const src = attr(el, 'data-src') || attr(el, 'data-image') || attr(el, 'src');
    if (src && !src.startsWith('data:')) addImage(report, decode(src), `${source}:img`, dims(attr(el, 'data-image-dimensions')));
  }
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  report.textLength = Math.max(report.textLength, text.length);
}

function addAudio(report, url, source) {
  const key = url.split('?')[0];
  const hit = report.audio.find((a) => a.url.split('?')[0] === key);
  if (hit) { if (!hit.sources.includes(source)) hit.sources.push(source); return; }
  report.audio.push({ url, sources: [source] });
}

function addImage(report, url, source, size = null) {
  const clean = normalizeImage(url);
  const key = clean.split('?')[0];
  const hit = report.images.find((i) => i.key === key);
  if (hit) {
    if (!hit.sources.includes(source)) hit.sources.push(source);
    hit.width ||= size?.width; hit.height ||= size?.height;
    return;
  }
  report.images.push({ key, url: clean, original: url, sources: [source], width: size?.width ?? null, height: size?.height ?? null });
}

// Squarespace CDN serves resized copies via ?format=<width>w; 2500w is the
// largest standard size. Other hosts are left untouched.
export function normalizeImage(url) {
  if (!SQS_IMAGE_RE.test(url)) return url;
  return `${url.split('?')[0]}?format=2500w`;
}

function looksLikeImage(s) { return /\.(jpe?g|png|webp|gif)(?:$|\?)/i.test(s) || /content\/v1\//.test(s); }
function walkStrings(v, fn, key = '') {
  if (typeof v === 'string') fn(v, key);
  else if (Array.isArray(v)) v.forEach((x) => walkStrings(x, fn, key));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walkStrings(x, fn, k);
}
function attr(el, name) { return el.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'))?.[1] || null; }
function meta(html, prop) {
  const el = html.match(new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]*>`, 'i'))?.[0];
  return el ? decode(attr(el, 'content') || '') || null : null;
}
function tag(html, name) { const t = html.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1]; return t ? decode(t.replace(/<[^>]+>/g, '').trim()) || null : null; }
function dims(s) { const m = s?.match(/^(\d+)x(\d+)$/); return m ? { width: +m[1], height: +m[2] } : null; }
function cdata(s) { return s ? decode(s.replace(/^<!\[CDATA\[|\]\]>$/g, '').trim()) : null; }
function decode(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}

// "Ep 32: Linda Shider [P-FUNK/GARRY SHIDER]" → "Linda Shider". A guess Ace can overwrite.
export function guessGuest(title) {
  if (!title) return null;
  return title.replace(/\s*[—–-]\s*Aced Out Podcast\s*$/i, '').replace(/^\s*(?:ep(?:isode)?\.?\s*\d+\s*[:.\-–—]\s*)/i, '').replace(/\s*\[[^\]]*\]\s*$/, '').trim() || null;
}

async function defaultFetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'PocketAce/0.1 (episode lookup)', accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  return { status: res.status, text: await res.text(), headers: Object.fromEntries(res.headers) };
}

// Finds an FFmpeg that can actually make the video, and says plainly what is
// missing when none can.
//
// Why this exists: in January 2026 Homebrew slimmed its `ffmpeg` formula.
// FFmpeg 8 from `brew install ffmpeg` has no libfreetype (so no `drawtext`,
// which draws the wordmark and guest name) and no libass (captions). The old
// full build became `ffmpeg-full`, which is keg-only: installed, but not on
// PATH. So we look for it ourselves instead of asking anyone to relink.
//
// Order tried: $FFMPEG_PATH, `ffmpeg` on PATH, then Homebrew's ffmpeg-full
// (Apple Silicon and Intel prefixes). The first one with everything wins.

import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';

// Everything lib/render.js asks of FFmpeg. Keep in step with the filtergraphs there.
const NEEDS = {
  filters: ['drawtext', 'zoompan', 'xfade', 'gblur', 'overlay', 'loudnorm', 'geq', 'eq', 'scale', 'crop', 'split', 'loop',
    'fade', 'afade', 'atrim', 'asetpts', 'aresample', 'setpts', 'setsar', 'trim', 'format', 'null', 'color'],
  encoders: ['libx264', 'aac'],
  decoders: ['mjpeg', 'png', 'webp', 'gif', 'mp3float'],
  demuxers: ['concat', 'image2', 'mp3'],
};
const CAPTIONS = 'ass'; // optional: only needed when a captions file is used
const WHY = { drawtext: 'libfreetype', ass: 'libass', libx264: 'x264' };

export function defaultCandidates(env = process.env) {
  const brew = [env.HOMEBREW_PREFIX, '/opt/homebrew', '/usr/local'].filter(Boolean)
    .map((p) => path.join(p, 'opt', 'ffmpeg-full', 'bin', 'ffmpeg'));
  return [...new Set([env.FFMPEG_PATH, 'ffmpeg', ...brew].filter(Boolean))];
}

let cached = null;
/** Resolves once per process. `candidates` is for tests. */
export function findFFmpeg({ candidates = defaultCandidates(), fresh = false } = {}) {
  if (!cached || fresh) cached = resolve(candidates);
  return cached;
}
/** The binaries to call. Falls back to plain names so callers never crash here. */
export async function tools() {
  const r = await findFFmpeg();
  return { ffmpeg: r.ffmpeg || 'ffmpeg', ffprobe: r.ffprobe || 'ffprobe' };
}

async function resolve(candidates) {
  const tried = [];
  for (const c of candidates) {
    const bin = await locate(c);
    if (!bin) { tried.push({ bin: c, found: false }); continue; }
    tried.push(await inspect(bin));
  }
  const usable = tried.filter((t) => t.found && !t.error);
  const best = usable.find((t) => !t.missing.length) || usable.sort((a, b) => a.missing.length - b.missing.length)[0] || null;
  const ok = !!best && !best.missing.length;
  return {
    ok,
    ffmpeg: best?.bin ?? null,
    ffprobe: best ? await sibling(best.bin, 'ffprobe') : null,
    version: best?.version ?? null,
    missing: best?.missing ?? [],
    captions: !!best?.captions,
    tried,
    advice: ok ? null : advise(best),
  };
}

async function inspect(bin) {
  try {
    const [version, filters, encoders, decoders, demuxers] = await Promise.all(
      ['-version', '-filters', '-encoders', '-decoders', '-demuxers'].map((f) => run(bin, ['-hide_banner', f])));
    const have = { filters: names(filters), encoders: names(encoders), decoders: names(decoders), demuxers: names(demuxers) };
    const missing = Object.entries(NEEDS).flatMap(([kind, list]) => list.filter((n) => !have[kind].has(n)));
    return { bin, found: true, version: version.match(/ffmpeg version (\S+)/)?.[1] ?? 'unknown', missing, captions: have.filters.has(CAPTIONS) };
  } catch (err) {
    return { bin, found: true, error: err.message.split('\n')[0] };
  }
}

// Lines look like " T.C drawtext   V->V  Draw text…" or " V....D libx264  …":
// a short run of flag characters, then the name.
function names(listing) {
  const out = new Set();
  for (const line of listing.split('\n')) {
    const m = line.match(/^\s*[A-Z.|]{1,6}\s+([a-z0-9_,-]+)\s/i);
    if (m) for (const n of m[1].split(',')) out.add(n);
  }
  return out;
}

function advise(best) {
  const mac = process.platform === 'darwin';
  if (!best) {
    return mac
      ? 'FFmpeg was not found. Install it with: brew install ffmpeg-full   (PocketAce finds it automatically, then restart npm start).'
      : 'FFmpeg was not found. Install a full build (Debian/Ubuntu: apt install ffmpeg), or set FFMPEG_PATH to one.';
  }
  const list = best.missing.map((n) => (WHY[n] ? `${n} (needs ${WHY[n]})` : n)).join(', ');
  const head = `The FFmpeg at ${best.bin} (version ${best.version}) can't make the video. Missing: ${list}.`;
  return mac
    ? `${head} Homebrew's standard ffmpeg left these out in January 2026. Fix: brew install ffmpeg-full   PocketAce finds it automatically, no linking needed; then restart npm start. Or set FFMPEG_PATH to another full FFmpeg.`
    : `${head} Install a full FFmpeg build (Debian/Ubuntu: apt install ffmpeg), or set FFMPEG_PATH to one.`;
}

export function captionsAdvice(r) {
  return `Captions need FFmpeg's "ass" filter (libass), which ${r.ffmpeg} doesn't have.` +
    (process.platform === 'darwin' ? ' Fix: brew install ffmpeg-full.' : ' Install a full FFmpeg build.') + ' Or make the video without a captions file.';
}

async function locate(name) {
  if (name.includes('/')) return (await executable(name)) ? path.resolve(name) : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, name);
    if (await executable(p)) return p;
  }
  return null;
}
async function sibling(bin, name) {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  const p = path.join(path.dirname(bin), name);
  return (await executable(p)) ? p : name;
}
async function executable(p) { try { await access(p, constants.X_OK); return true; } catch { return false; } }
function run(cmd, args) {
  return new Promise((ok, fail) => execFile(cmd, args, { maxBuffer: 1e7, timeout: 20000 }, (err, stdout) => (err ? fail(err) : ok(stdout))));
}

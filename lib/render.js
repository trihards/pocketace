// Turns stills + an audio excerpt into a vertical MP4 with FFmpeg, in two passes.
//
// Pass 1, one short FFmpeg run per shot (a few run side by side), laid out by
// public/look.js:
//   whole photo:  photo over a dark blurred copy of itself, composed once, held
//   fill, still:  cover the frame, crop at Ace's focus point, held
//   fill, pan:    cover, then a frame-sized window slides across
//   fill, push:   cover, crop at the focus, zoompan in towards it
//   The last moments of each segment crossfade into the next photo, so every
//   segment holds at most two photos in memory, however many photos there are.
// Pass 2, one FFmpeg run:
//   segments joined end to end → shade gradient → wordmark → guest/episode
//   lines → captions → fade in/out → x264, with the audio excerpt
//   (loudness-normalised) → AAC.
//
// Moving shots work at 2.5× size: zoompan and crop move in whole pixels, and
// at 2.5× a step is well under an output pixel, so motion stays smooth.

import { spawn, execFile } from 'node:child_process';
import { writeFile, rm, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipCues } from '../public/captions.js';
import { layout, motionFor, transitionFor, W as CW, H as CH, BACKDROP, WRAP, wrapLines as wrap, INTRO, splashRect } from '../public/look.js';
import { tools } from './ffmpeg.js';
import { exifOrientation, UPRIGHT, swapsSides } from './photos.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FONTS = path.join(ROOT, 'assets', 'fonts');
export const BRAND = {
  wordmark: 'Aced Out',
  accent: '0xF2B233', // warm gold; swap for the official brand colour
  ink: '0xFFFFFF',
};

const PRESETS = {
  draft: { w: 540, h: 960, crf: 26, preset: 'ultrafast', up: 2 },
  final: { w: 1080, h: 1920, crf: 20, preset: 'veryfast', up: 2.5 },
};
const FPS = 30;
const PARALLEL = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));

// Pass 1 reads photos with the still-image readers (-framerate), which only
// JPEG, PNG and WebP go through. Anything else (the live site has two GIFs)
// is swapped for a PNG of its first frame, returned as `file`.
//
// Phone JPEGs are often stored sideways with an EXIF tag saying which way up
// they go. Browsers obey it, and FFmpeg 6 and 8 do too when decoding, but
// ffprobe reports the stored size, so the frame would be laid out for the
// wrong shape. Such photos are swapped for an upright copy (no tag) and the
// size reported is the upright one.
const STILL_CODECS = new Set(['mjpeg', 'png', 'webp']);
export async function probeImage(file) {
  const { ffmpeg, ffprobe } = await tools();
  const out = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', file]);
  const [codec, w, h] = out.trim().split(',');
  let width = Number(w), height = Number(h);
  if (!width || !height) throw new Error(`Could not read image size: ${path.basename(file)}`);
  const orientation = codec === 'mjpeg' ? exifOrientation(await readHead(file)) : 1;
  if (orientation !== 1) {
    const upright = `${file}.upright.jpg`;
    await run(ffmpeg, ['-v', 'error', '-y', '-noautorotate', '-i', file, '-vf', UPRIGHT[orientation], '-frames:v', '1', '-q:v', '1', upright]);
    if (swapsSides(orientation)) [width, height] = [height, width];
    return { file: upright, width, height };
  }
  if (STILL_CODECS.has(codec)) return { width, height };
  const still = `${file}.still.png`;
  await run(ffmpeg, ['-v', 'error', '-y', '-i', file, '-frames:v', '1', still]);
  return { file: still, width, height };
}

// EXIF sits at the start of a JPEG; 256 KB covers it (thumbnails included).
async function readHead(file, bytes = 256 * 1024) {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

/**
 * @param {object} o
 * @param {string} o.dir          job directory (scratch files + output)
 * @param {string} o.audio        local audio file
 * @param {number} o.start        excerpt start, seconds into the episode
 * @param {number} o.end          excerpt end
 * @param {Array}  o.shots        from schedule(): [{id,start,end}]
 * @param {Map}    o.photos       id → {file,width,height}
 * @param {string} o.guest        big lower-third line
 * @param {string} o.subtitle     small line under it
 * @param {Array}  [o.cues]       caption cues in episode time
 * @param {'draft'|'final'} [o.quality]
 * @param {object} [o.intro]      show intro: {splash, audio, duration, width, height}.
 *                                Played before the story; the story is unchanged.
 * @param {(fraction:number)=>void} [o.onProgress]
 */
export async function renderVideo(o) {
  const P = PRESETS[o.quality || 'final'];
  const W = P.w, H = P.h, k = W / 1080;
  const D = o.end - o.start;
  const shots = o.shots;
  const T = transitionFor(shots, FPS);
  const Tf = Math.round(T * FPS);
  const out = path.join(o.dir, 'video.mp4');
  const report = (pass1, pass2) => o.onProgress?.(0.75 * pass1 + 0.25 * pass2);

  // ---- Pass 1: one segment per shot ----
  // Clip i is shot i's full camera move. It starts T before the shot (that
  // part plays under the previous crossfade), so segment i shows clip i from
  // T onward and, in its last T seconds, fades into the first T of clip i+1.
  // Each transition ends exactly as the next shot starts, so every photo is
  // fully on screen at the moment the story strip shows it starting.
  const clipFrames = shots.map((s, i) => Math.max(2, Math.round((s.end - s.start + (i > 0 ? T : 0)) * FPS)));
  const segFiles = shots.map((_, i) => path.join(o.dir, `seg${String(i).padStart(3, '0')}.mp4`));
  const done = new Array(shots.length).fill(0);
  let next = 0;
  const worker = async () => {
    while (next < shots.length) {
      const i = next++;
      const segFrames = Math.round((shots[i].end - shots[i].start) * FPS);
      const hasNext = i + 1 < shots.length;
      const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', '-framerate', String(FPS), '-i', o.photos.get(shots[i].id).file];
      if (hasNext) args.push('-framerate', String(FPS), '-i', o.photos.get(shots[i + 1].id).file);
      const f = [clipFilter(0, i, o.photos.get(shots[i].id), clipFrames[i], P, 'a')];
      f.push(`[a]trim=start_frame=${i > 0 ? Tf : 0},setpts=PTS-STARTPTS[a1]`);
      if (hasNext) {
        f.push(clipFilter(1, i + 1, o.photos.get(shots[i + 1].id), clipFrames[i + 1], P, 'b'));
        f.push(`[b]trim=end_frame=${Tf},setpts=PTS-STARTPTS[b1]`);
        f.push(`[a1][b1]xfade=transition=fade:duration=${(Tf / FPS).toFixed(4)}:offset=${((segFrames - Tf) / FPS).toFixed(4)}[v]`);
      } else f.push('[a1]null[v]');
      args.push('-filter_complex', f.join(';'), '-map', '[v]', '-frames:v', String(segFrames),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', o.quality === 'draft' ? '20' : '14', '-pix_fmt', 'yuv420p', '-r', String(FPS), segFiles[i]);
      await ffmpeg(args, o.dir, (sec) => { done[i] = Math.min(sec * FPS, segFrames); report(done.reduce((x, y) => x + y, 0) / (D * FPS), 0); });
      done[i] = segFrames;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, shots.length) }, worker));

  // ---- Pass 2: join, dress, add audio ----
  // Texts go through files; nothing typed by a person is spliced into the
  // filtergraph, so no quoting or escaping surprises.
  await writeFile(path.join(o.dir, 'segments.txt'), segFiles.map((f) => `file '${path.basename(f)}'`).join('\n'));
  await writeFile(path.join(o.dir, 'guest.txt'), wrap((o.guest || '').toUpperCase(), WRAP.guest).join('\n'));
  await writeFile(path.join(o.dir, 'subtitle.txt'), wrap(o.subtitle || '', WRAP.subtitle).join('\n'));
  await writeFile(path.join(o.dir, 'brand.txt'), BRAND.wordmark);
  const cues = o.cues?.length ? clipCues(o.cues, o.start, o.end) : [];
  if (cues.length) await writeFile(path.join(o.dir, 'captions.ass'), toASS(cues, W, H));

  // Loudness: the episodes are mastered quiet (Ep 32 measures about -29 LUFS),
  // and YouTube only turns loud videos down, never quiet ones up. Measure the
  // excerpt, then normalise to -16 LUFS (a common speech target) in pass 2.
  const audioIn = `atrim=start=${o.start}:end=${o.end},asetpts=PTS-STARTPTS`;
  const m = await measureLoudness(o.audio, audioIn, o.dir);
  const norm = m ? `,loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000` : '';

  const dt = (font, file, size, color, y, extra = '') =>
    `drawtext=fontfile='${path.join(FONTS, font)}':textfile='${path.join(o.dir, file)}':fontsize=${Math.round(size * k)}:fontcolor=${color}:x=(w-text_w)/2:y=${Math.round(y * k)}:line_spacing=${Math.round(6 * k)}${extra}`;
  const fadeIn = (t0) => `:alpha='min(1,max(0,(t-${t0})/0.6))'`;
  const lines = wrap((o.guest || '').toUpperCase(), WRAP.guest).length;
  // With the show intro, the story's fade from black is replaced by a crossfade
  // from the splash (below); everything else about the story stays as it is.
  const I = o.intro ? o.intro.duration : 0;
  const f = [
    // Shade top and bottom so type stays readable on any photo.
    `color=black:s=${W}x${H}:r=1:d=1,format=rgba,geq=r=0:g=0:b=0:a='if(lt(Y,${H * 0.16}),150*(1-Y/${H * 0.16}),if(gt(Y,${H * 0.6}),230*pow((Y-${H * 0.6})/${H * 0.4},1.1),0))'[shade]`,
    `[0:v][shade]overlay=0:0:eof_action=repeat,` +
      dt('Shrikhand-Regular.ttf', 'brand.txt', 64, BRAND.accent, 92) + ',' +
      dt('Archivo-Black.ttf', 'guest.txt', 84, BRAND.ink, 1480, fadeIn(0.4)) + ',' +
      dt('Archivo-SemiBold.ttf', 'subtitle.txt', 40, BRAND.accent, 1480 + lines * 96 + 14, fadeIn(0.8)) +
      (cues.length ? `,ass=filename='${path.join(o.dir, 'captions.ass')}':fontsdir='${FONTS}'` : '') +
      `${I ? '' : ',fade=t=in:d=0.4'},fade=t=out:st=${(D - 1).toFixed(3)}:d=1,format=yuv420p${I ? '[story]' : '[vout]'}`,
    `[1:a]${audioIn}${norm},afade=t=in:d=0.3,afade=t=out:st=${(D - 1.2).toFixed(3)}:d=1.2,aformat=sample_rates=48000:channel_layouts=stereo${I ? '[sa]' : '[aout]'}`,
  ];
  const inputs = ['-f', 'concat', '-safe', '0', '-i', 'segments.txt', '-i', o.audio];
  if (o.intro) {
    // Show intro: the splash, whole and centred on the show's purple, for the
    // length of the intro audio. In its last X seconds it crossfades into the
    // story's first frame (held still for those X seconds), so the story and
    // the interview audio start exactly at I. Intro audio is levelled to the
    // same -16 LUFS as the interview, so there's no jump between them.
    const X = Math.min(INTRO.fade, I / 2);
    const r = splashRect(o.intro.width, o.intro.height);
    const im = await measureLoudness(o.intro.audio, 'anull', o.dir);
    const inorm = im ? `,loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${im.input_i}:measured_TP=${im.input_tp}:measured_LRA=${im.input_lra}:measured_thresh=${im.input_thresh}:offset=${im.target_offset}:linear=true` : '';
    inputs.push('-loop', '1', '-framerate', String(FPS), '-t', I.toFixed(4), '-i', o.intro.splash, '-i', o.intro.audio);
    f.push(
      `color=c=${INTRO.background.replace('#', '0x')}:s=${W}x${H}:r=${FPS}:d=${I.toFixed(4)}[ibg]`,
      `[2:v]scale=${even(r.w * k)}:${even(r.h * k)}:flags=lanczos,setsar=1[isp]`,
      `[ibg][isp]overlay=${Math.round(r.x * k)}:${Math.round(r.y * k)}:shortest=1,fade=t=in:d=0.4,format=yuv420p,fps=${FPS},settb=1/${FPS}[intro]`,
      `[story]tpad=start_duration=${X.toFixed(4)}:start_mode=clone,fps=${FPS},settb=1/${FPS}[st]`,
      // xfade drops the story's last frame; hold it a moment (-t trims to the exact total).
      `[intro][st]xfade=transition=fade:duration=${X.toFixed(4)}:offset=${(I - X).toFixed(4)},tpad=stop_mode=clone:stop_duration=${(2 / FPS).toFixed(4)},format=yuv420p[vout]`,
      `[3:a]aformat=sample_rates=48000:channel_layouts=stereo${inorm},aresample=48000,apad,atrim=end=${I.toFixed(4)},afade=t=out:st=${(I - 0.08).toFixed(4)}:d=0.08,aformat=sample_rates=48000:channel_layouts=stereo[ia]`,
      `[ia][sa]concat=n=2:v=0:a=1[aout]`,
    );
  }
  const total = I + D;
  const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', ...inputs,
    '-filter_complex', f.join(';\n'), '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', P.preset, '-crf', String(P.crf), '-r', String(FPS), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', total.toFixed(3), '-movflags', '+faststart', out];
  await writeFile(path.join(o.dir, 'ffmpeg-final-args.json'), JSON.stringify(args, null, 1));
  await ffmpeg(args, o.dir, (sec) => report(1, Math.min(1, sec / total)));
  await Promise.all(segFiles.map((s) => rm(s, { force: true })));
  return out;
}

// One shot's camera move as a filter chain: input #inp → [label], F frames.
// One clip: shot `shotIndex`'s photo for F frames, as look.js lays it out.
// Every path ends with exactly F frames at the output size.
function clipFilter(inp, shotIndex, img, F, P, label) {
  const k = P.w / CW, u = P.up;
  const L = layout(img);
  const M = motionFor(L, F / FPS, shotIndex);
  const r = L.rect;
  const hold = `loop=loop=${F - 1}:size=1,setpts=N/(${FPS}*TB)`;
  if (L.fit === 'whole') {
    // The whole photo, still, over a dark blurred copy of itself: composed once, then held.
    const bw = even(P.w / 4), bh = even(P.h / 4);
    return `[${inp}:v]split[${label}b][${label}f];` +
      `[${label}b]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=${BACKDROP.blur * k},` +
      `format=yuv444p,lutyuv=y='16+(val-16)*${BACKDROP.dim}':u='128+(val-128)*${BACKDROP.dim * BACKDROP.saturation}':v='128+(val-128)*${BACKDROP.dim * BACKDROP.saturation}',` +
      `scale=${P.w}:${P.h},setsar=1[${label}bg];` +
      `[${label}f]scale=${even(r.w * k)}:${even(r.h * k)}:flags=lanczos,setsar=1[${label}fg];` +
      `[${label}bg][${label}fg]overlay=x=${Math.round(r.x * k)}:y=${Math.round(r.y * k)},format=yuv420p,${hold}[${label}]`;
  }
  // Fill: the photo covers the frame; a frame-sized window is cut from it.
  const at = (sw, sh, x, y, ww, wh) => [Math.round(clampN(-x, 0, sw - ww)), Math.round(clampN(-y, 0, sh - wh))];
  if (M.kind === 'still') {
    const sw = even(r.w * k), sh = even(r.h * k);
    const [x, y] = at(sw, sh, r.x * k, r.y * k, P.w, P.h);
    return `[${inp}:v]scale=${sw}:${sh}:flags=lanczos,crop=${P.w}:${P.h}:${x}:${y},setsar=1,format=yuv420p,${hold}[${label}]`;
  }
  // Moving shots work at u× size, so the window moves in fractions of an output pixel.
  const sw = even(r.w * k * u), sh = even(r.h * k * u), ww = even(P.w * u), wh = even(P.h * u);
  if (M.kind === 'pan') {
    const [x0] = at(sw, sh, M.x0 * k * u, 0, ww, wh), [x1] = at(sw, sh, M.x1 * k * u, 0, ww, wh);
    const [, y] = at(sw, sh, 0, r.y * k * u, ww, wh);
    return `[${inp}:v]scale=${sw}:${sh}:flags=lanczos,setsar=1,${hold},` +
      `crop=${ww}:${wh}:x='${x0}+(${x1 - x0})*n/${Math.max(1, F - 1)}':y=${y},scale=${P.w}:${P.h},format=yuv420p[${label}]`;
  }
  // Push: zoom in about the focus point (zoompan scales its window about ax, ay).
  const [x, y] = at(sw, sh, r.x * k * u, r.y * k * u, ww, wh);
  return `[${inp}:v]scale=${sw}:${sh}:flags=lanczos,crop=${ww}:${wh}:${x}:${y},setsar=1,` +
    `zoompan=z='${M.z0}+(${M.z1 - M.z0})*on/${Math.max(1, F - 1)}':x='(iw-iw/zoom)*${(M.ax / CW).toFixed(5)}':y='(ih-ih/zoom)*${(M.ay / CH).toFixed(5)}':d=${F}:s=${P.w}x${P.h}:fps=${FPS},` +
    `setpts=PTS-STARTPTS,format=yuv420p[${label}]`;
}
const clampN = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// First half of two-pass loudnorm: returns the measured values, or null if
// the measurement fails (the render then keeps the original level).
// Integrated loudness (LUFS) of a file or URL, or of the stretch from `start`
// to `end` of it (read with input seeking, so a long episode isn't decoded
// from the top). The preview uses it to level the intro against the excerpt.
export async function loudness(input, { start, end } = {}) {
  const { ffmpeg: bin } = await tools();
  const seek = Number.isFinite(start) && Number.isFinite(end) ? ['-ss', String(start), '-t', String(end - start)] : [];
  const out = await new Promise((resolve, reject) => execFile(bin, ['-hide_banner', '-nostats', ...seek, '-i', input, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'],
    { maxBuffer: 1e7, timeout: 120000 }, (err, _o, stderr) => (err ? reject(new Error('could not measure loudness')) : resolve(stderr))));
  const v = Number(JSON.parse(out.slice(out.lastIndexOf('{'), out.lastIndexOf('}') + 1)).input_i);
  return Number.isFinite(v) ? v : null;
}

async function measureLoudness(file, trim, cwd) {
  try {
    const { ffmpeg: bin } = await tools();
    const out = await new Promise((resolve, reject) => execFile(bin, ['-hide_banner', '-nostats', '-i', file, '-af', `${trim},loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-'],
      { cwd, maxBuffer: 1e7 }, (err, _o, stderr) => (err ? reject(err) : resolve(stderr))));
    const m = JSON.parse(out.slice(out.lastIndexOf('{'), out.lastIndexOf('}') + 1));
    return Number.isFinite(Number(m.input_i)) ? m : null;
  } catch { return null; }
}

async function ffmpeg(args, cwd, onSeconds) {
  const { ffmpeg: bin } = await tools();
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd });
    let err = '';
    p.stdout.on('data', (b) => {
      const m = String(b).match(/out_time_us=(\d+)/g);
      if (m) onSeconds(Number(m[m.length - 1].split('=')[1]) / 1e6);
    });
    p.stderr.on('data', (b) => { err = (err + b).slice(-4000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.trim().split('\n').slice(-6).join(' | ')}`))));
  });
}

const even = (n) => Math.round(n / 2) * 2;

export function toASS(cues, W, H) {
  const k = W / 1080;
  const t = (s) => {
    const cs = Math.round(s * 100);
    return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
  };
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/[{}]/g, (c) => `\\${c}`).replace(/\n/g, '\\N');
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Archivo,${Math.round(64 * k)},&H00FFFFFF,&H00FFFFFF,&H50000000,&H00000000,-1,0,0,0,100,100,0,0,3,${Math.round(14 * k)},0,2,${Math.round(90 * k)},${Math.round(90 * k)},${Math.round(560 * k)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${cues.map((c) => `Dialogue: 0,${t(c.start)},${t(c.end)},Cap,,0,0,0,,${esc(c.text)}`).join('\n')}
`;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))));
}

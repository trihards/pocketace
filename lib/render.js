// Turns stills + an audio excerpt into a vertical MP4 with FFmpeg, in two passes.
//
// Pass 1, one short FFmpeg run per shot (a few run side by side):
//   photo ─┬─ cover + blur + darken, computed once and held ──┐
//          └─ upscale → zoompan (slow push/pull/drift) ───────┴─ overlay
//   The last moments of each segment crossfade into the next photo, so every
//   segment holds at most two photos in memory, however many photos there are.
// Pass 2, one FFmpeg run:
//   segments joined end to end → shade gradient → wordmark → guest/episode
//   lines → captions → fade in/out → x264, with the audio excerpt
//   (loudness-normalised) → AAC.
//
// Upscaling before zoompan matters: zoompan crops on whole pixels, and at
// 2.5× one source pixel is well under an output pixel, so motion stays smooth.

import { spawn, execFile } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipCues } from '../public/captions.js';
import { motion, placement, transitionFor } from '../public/look.js';
import { tools } from './ffmpeg.js';

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
const STILL_CODECS = new Set(['mjpeg', 'png', 'webp']);
export async function probeImage(file) {
  const out = await run((await tools()).ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', file]);
  const [codec, w, h] = out.trim().split(',');
  const width = Number(w), height = Number(h);
  if (!width || !height) throw new Error(`Could not read image size: ${path.basename(file)}`);
  if (STILL_CODECS.has(codec)) return { width, height };
  const still = `${file}.still.png`;
  await run((await tools()).ffmpeg, ['-v', 'error', '-y', '-i', file, '-frames:v', '1', still]);
  return { file: still, width, height };
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
  await writeFile(path.join(o.dir, 'guest.txt'), wrap((o.guest || '').toUpperCase(), 18).join('\n'));
  await writeFile(path.join(o.dir, 'subtitle.txt'), wrap(o.subtitle || '', 36).join('\n'));
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
  const lines = wrap((o.guest || '').toUpperCase(), 18).length;
  const f = [
    // Shade top and bottom so type stays readable on any photo.
    `color=black:s=${W}x${H}:r=1:d=1,format=rgba,geq=r=0:g=0:b=0:a='if(lt(Y,${H * 0.16}),150*(1-Y/${H * 0.16}),if(gt(Y,${H * 0.6}),230*pow((Y-${H * 0.6})/${H * 0.4},1.1),0))'[shade]`,
    `[0:v][shade]overlay=0:0:eof_action=repeat,` +
      dt('Shrikhand-Regular.ttf', 'brand.txt', 64, BRAND.accent, 92) + ',' +
      dt('Archivo-Black.ttf', 'guest.txt', 84, BRAND.ink, 1480, fadeIn(0.4)) + ',' +
      dt('Archivo-SemiBold.ttf', 'subtitle.txt', 40, BRAND.accent, 1480 + lines * 96 + 14, fadeIn(0.8)) +
      (cues.length ? `,ass=filename='${path.join(o.dir, 'captions.ass')}':fontsdir='${FONTS}'` : '') +
      `,fade=t=in:d=0.4,fade=t=out:st=${(D - 1).toFixed(3)}:d=1,format=yuv420p[vout]`,
    `[1:a]${audioIn}${norm},afade=t=in:d=0.3,afade=t=out:st=${(D - 1.2).toFixed(3)}:d=1.2[aout]`,
  ];
  const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', '-f', 'concat', '-safe', '0', '-i', 'segments.txt', '-i', o.audio,
    '-filter_complex', f.join(';\n'), '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', P.preset, '-crf', String(P.crf), '-r', String(FPS), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', D.toFixed(3), '-movflags', '+faststart', out];
  await writeFile(path.join(o.dir, 'ffmpeg-final-args.json'), JSON.stringify(args, null, 1));
  await ffmpeg(args, o.dir, (sec) => report(1, Math.min(1, sec / D)));
  await Promise.all(segFiles.map((s) => rm(s, { force: true })));
  return out;
}

// One shot's camera move as a filter chain: input #inp → [label], F frames.
function clipFilter(inp, shotIndex, img, F, P, label) {
  const W = P.w, H = P.h, k = W / 1080;
  const mv = motion(shotIndex);
  const z = `${mv.z0}+(${mv.z1 - mv.z0})*on/${F - 1}`;
  const x = `(iw-iw/zoom)*(${mv.x0}+(${mv.x1 - mv.x0})*on/${F - 1})`;
  const y = `(ih-ih/zoom)*(${mv.y0}+(${mv.y1 - mv.y0})*on/${F - 1})`;
  const place = placement(img.width, img.height);
  if (place.fill) {
    // Tall, large photo, close to 9:16: fill the frame and drift. Anything
    // wider is framed instead, so nobody at the edge of a group shot gets cropped out.
    const uw = even(W * P.up), uh = even(H * P.up);
    return `[${inp}:v]scale=${uw}:${uh}:force_original_aspect_ratio=increase,crop=${uw}:${uh},setsar=1,` +
      `zoompan=z='${z}':x='${x}':y='${y}':d=${F}:s=${W}x${H}:fps=${FPS},setpts=PTS-STARTPTS,format=yuv420p[${label}]`;
  }
  // Shown whole, over a blurred copy of itself, never enlarged past MAX_UPSCALE.
  const fw = even(place.w * k), fh = even(place.h * k);
  const cy = Math.round(place.y * k);
  const bw = even(W / 4), bh = even(H / 4);
  return `[${inp}:v]split[${label}b][${label}f];` +
    `[${label}b]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=${12 * k},` +
    `eq=brightness=-0.18:saturation=0.8,scale=${W}:${H},setsar=1,format=yuv420p,loop=loop=${F - 1}:size=1,setpts=N/(${FPS}*TB)[${label}bg];` +
    `[${label}f]scale=${even(fw * P.up)}:${even(fh * P.up)},setsar=1,` +
    `zoompan=z='${z}':x='${x}':y='${y}':d=${F}:s=${fw}x${fh}:fps=${FPS},setpts=PTS-STARTPTS,format=yuv420p[${label}fg];` +
    `[${label}bg][${label}fg]overlay=x=(W-w)/2:y=${cy}:shortest=1[${label}]`;
}

// First half of two-pass loudnorm: returns the measured values, or null if
// the measurement fails (the render then keeps the original level).
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

function wrap(text, max) {
  const out = [];
  let line = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + w).length > max) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.slice(0, 3);
}

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

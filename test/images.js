// Test images: a 300x200 JPEG in four coloured quadrants (red, green / blue,
// white), optionally tagged with an EXIF orientation, and a reader that says
// which colour sits in each quadrant of a decoded image.
import { execFileSync } from 'node:child_process';
import { tools } from '../lib/ffmpeg.js';

const { ffmpeg } = await tools();

export function quadrantsJpeg() {
  return execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i',
    'color=red:s=150x100[a];color=lime:s=150x100[b];color=blue:s=150x100[c];color=white:s=150x100[d];[a][b]hstack[t];[c][d]hstack[u];[t][u]vstack',
    '-frames:v', '1', '-q:v', '2', '-f', 'image2pipe', '-c:v', 'mjpeg', '-']);
}

export function withOrientation(jpeg, o) {
  const tiff = Buffer.alloc(26);
  tiff.write('MM\0*', 0, 'latin1'); tiff.writeUInt32BE(8, 4); tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10); tiff.writeUInt16BE(3, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(o, 18); tiff.writeUInt32BE(0, 22);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = body.length + 2;
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1, len >> 8, len & 255]), body, jpeg.subarray(2)]);
}

// "RGBW" = red top-left, green top-right, blue bottom-left, white bottom-right. Plus the size.
export function quadrants(fileOrUrl, { pre = [], vf = null } = {}) {
  const out = execFileSync(ffmpeg, ['-v', 'error', ...pre, '-i', fileOrUrl, ...(vf ? ['-vf', vf] : []), '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'ppm', '-']);
  const m = out.toString('latin1', 0, 20).match(/P6\s+(\d+)\s+(\d+)\s+255\s/);
  const w = +m[1], h = +m[2], px = out.subarray(m[0].length);
  const name = (k) => { const [r, g, b] = [px[k], px[k + 1], px[k + 2]]; return r > 200 && g > 200 && b > 200 ? 'W' : r > 200 ? 'R' : g > 200 ? 'G' : b > 200 ? 'B' : '?'; };
  const q = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([x, y]) => name((Math.floor(y * h) * w + Math.floor(x * w)) * 3)).join('');
  return { q, w, h };
}

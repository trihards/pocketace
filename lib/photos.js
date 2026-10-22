// Small facts about image files, read straight from their bytes: what kind of
// file it is, and which way up a camera meant it to be shown.

// The first bytes of a file decide its type, whatever its name or the
// browser claims. HEIC is recognised so it can be refused politely.
export function sniffType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'gif';
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1|avif)$/.test(buf.toString('latin1', 8, 12))) return 'heic';
  return null;
}

// EXIF orientation (1–8) of a JPEG, or 1. Phones store photos sideways and
// set this tag; browsers obey it, and so must the render.
export function exifOrientation(buf) {
  if (sniffType(buf) !== 'jpg') return 1;
  let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xe1 && buf.toString('latin1', i + 4, i + 10) === 'Exif\0\0') {
      const t = i + 10; // TIFF header
      const le = buf.toString('latin1', t, t + 2) === 'II';
      const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
      const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
      const ifd = t + u32(t + 4);
      if (ifd + 2 > buf.length) return 1;
      for (let n = u16(ifd), e = ifd + 2; n > 0 && e + 12 <= buf.length; n--, e += 12) {
        if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
      }
      return 1;
    }
    if (marker === 0xda) break; // image data starts; no EXIF beyond here
    i += 2 + len;
  }
  return 1;
}

// FFmpeg filters that turn a stored image into the way it should be seen.
export const UPRIGHT = { 2: 'hflip', 3: 'hflip,vflip', 4: 'vflip', 5: 'transpose=0', 6: 'transpose=1', 7: 'transpose=3', 8: 'transpose=2' };
export const swapsSides = (o) => o >= 5;

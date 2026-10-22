// Can this machine make videos? Prints which FFmpeg PocketAce will use and
// anything it is missing, with the fix.
//
//   npm run doctor

import { findFFmpeg } from '../lib/ffmpeg.js';

const r = await findFFmpeg();
for (const t of r.tried) {
  const what = !t.found ? 'not found' : t.error ? `could not run: ${t.error}` : t.missing.length ? `${t.version}, missing ${t.missing.join(', ')}` : `${t.version}, complete`;
  console.log(`  ${t.bin.padEnd(44)} ${what}`);
}
if (r.ok) {
  console.log(`\nOK: PocketAce will render with ${r.ffmpeg}${r.captions ? '' : '\n(no libass, so captions files are switched off)'}`);
} else {
  console.log(`\nNot ready. ${r.advice}`);
  process.exitCode = 1;
}

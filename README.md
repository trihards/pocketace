# PocketAce

Proof of concept for Ace Alan's [Aced Out Podcast](https://www.acedoutpodcast.com/episodes): turn a 5–10 minute excerpt of an episode into an illustrated vertical (1080×1920) MP4 for YouTube.

Paste an episode page address, set a start and an end, tap photos in the order you want, optionally pin a photo to a moment, preview, and render. All photo timing, framing, motion and transitions follow fixed rules. There is no AI or speech recognition anywhere in the app.

**Status:** prototype. Verified against the live site on 22 Oct 2026 (`npm run sweep`):

- All 33 feed items look up cleanly from all three sources (Squarespace JSON, page HTML, RSS). Audio is found for all 32 episodes; the 33rd item is a tribute post with no audio.
- Audio: 30 episodes are MP3s in the S3 bucket `www.davekostiuk.com` (us-west-1), 2 are on Squarespace. They serve byte ranges, so browsers can seek. Ep 32 is 118 MB, 82 min.
- Photos: 446 across the catalogue (469 before folding episode thumbnails into the body photo they repeat; 23 of 27 thumbnails are such twins, matched by file name). Of the 441 with sizes in the page markup, the median long side is 726 px and 341 are under 1080 px. The render never enlarges a photo more than 25% (`public/look.js`), so small photos sit smaller on screen instead of going soft.
- Transcripts: none. Episode pages carry long narrative show notes (Ep 32: ~1,500 words), credits and a track list.
- Loudness: episodes are mastered quiet (Ep 32: −29 LUFS). Renders are normalised to −16 LUFS.
- A real render (Ep 32 audio from S3, 60 s, 1080×1920) took 54 s including the 118 MB download, and the cut is sample-accurate.
- Photo files (all 469 downloaded and decoded, 22 Oct 2026): every one downloads, with `CORS: *`. The markup sizes are exact: 429 match, 12 differ only because the CDN caps at 2500 px, none are rotated. The CDN content-negotiates, so the server receives WebP for 445 of them, which FFmpeg 6.1 reads fine. Two are GIFs (Ep 23, Ep 26), which crashed the whole render until `probeImage` began swapping them for a PNG still. 66 PNG/WebP files have transparency, mostly a one-pixel edge; the render flattens it onto black and the preview now shows the same.
- A live end-to-end render through the server (Ep 26, all 16 photos including the GIF, 2 min at 1080×1920) took 129 s including the audio download: exactly 120.000 s, −16.0 LUFS.

## Run it

Needs Node 22+ and FFmpeg (with libass, which standard builds include).

```sh
npm start                 # http://localhost:8080
npm test                  # unit tests + an end-to-end render against a local stand-in site
npm run demo -- 45 final  # renders a 45 s sample from generated test patterns, prints the file path
npm run probe -- https://www.acedoutpodcast.com/episodes/32/linda-shider
npm run sweep             # look up every episode in the feed, one line each
```

`probe` checks individual episodes in depth. For each episode URL it reports which lookup sources work (Squarespace JSON, page HTML, RSS), the real pixel size of every photo, the audio file's type, size, duration and range support, browser CORS headers, and whether there is a transcript or only show notes. It also writes `probe-report.json`.

Or with Docker:

```sh
docker build -t pocketace . && docker run -p 8080:8080 pocketace
```

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `ALLOWED_HOSTS` | `acedoutpodcast.com,squarespace-cdn.com,squarespace.com,amazonaws.com` | The only hosts the server will fetch from (subdomains included). Add the audio host here if episodes live elsewhere. |
| `JOB_TTL_HOURS` | `6` | Rendered videos and downloaded media are deleted after this long |
| `WORK_DIR` | system temp | Scratch space. Wiped on start. |

## How it works

```
browser (public/)                       server (server.js)                    FFmpeg
───────────────────                     ──────────────────                    ──────
paste URL  ───────────────────────────▶ /api/episode → lib/extract.js
                                        (JSON → HTML → RSS, server-side,
                                         so browser CORS never matters)
pick excerpt, photos, pins
live preview (CSS, same rules)
"Make the video" ─────────────────────▶ /api/render → queue (one at a time)
                                        download audio + photos (cached)
                                        schedule() again (same code)  ─────▶ pass 1: one segment per shot
                                                                             pass 2: join, type, captions, audio
poll /api/jobs/:id ◀──────────────────  progress, then the MP4
```

Files worth knowing:

- `public/schedule.js`: where photos go and for how long. Shared by browser and server, so the preview matches the render. Rules are in the header comment.
- `public/look.js`: the visual rules (when a photo fills the frame vs. is framed, margins, crossfade length, camera moves). Change a number here and both preview and render follow.
- `public/captions.js`: SRT/VTT parsing, clipping to the excerpt, SRT output.
- `lib/render.js`: the FFmpeg command builder. Each render writes its final FFmpeg arguments to `ffmpeg-final-args.json` in the job folder, for debugging.
- `lib/extract.js`: episode lookup. Every finding records which source it came from.

## Measured (4 vCPU / 15 GB sandbox, FFmpeg 6.1)

- 10-minute excerpt, 30 photos, final 1080×1920: **309 s** (about 1.9× realtime), 108 MB MP4.
- Peak memory: about **540 MB** across all FFmpeg processes with 30 photos, and flat as photos are added (the first single-pass design peaked at 1.9 GB and grew with every photo).
- 45 s draft at 540×960: about 8 s.

## Not in this prototype (on purpose)

Accounts, a media library, uploads from disk, publishing to YouTube, a caption editor, waveform display, saving projects. See the findings report for what to build next and what to defer.

Fonts: Archivo and Shrikhand, both SIL Open Font License (see `assets/fonts/`).

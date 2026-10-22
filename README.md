# PocketAce

Proof of concept for Ace Alan's [Aced Out Podcast](https://www.acedoutpodcast.com/episodes): turn a 5–10 minute excerpt of an episode into an illustrated vertical (1080×1920) MP4 for YouTube.

Paste an episode page address, set a start and an end, tap photos in the order you want, optionally pin a photo to a moment, preview, and render. All photo timing, framing, motion and transitions follow fixed rules. There is no AI or speech recognition anywhere in the app.

**Status:** prototype. The render pipeline, scheduler, captions and server are working and tested. Episode lookup is written for Squarespace's standard page/JSON/RSS conventions but has **not yet been run against the live acedoutpodcast.com site**. The development sandbox could not reach it. Run `npm run probe` (below) to check that first.

## Run it

Needs Node 22+ and FFmpeg (with libass, which standard builds include).

```sh
npm start                 # http://localhost:8080
npm test                  # unit tests + an end-to-end render against a local stand-in site
npm run demo -- 45 final  # renders a 45 s sample from generated test patterns, prints the file path
npm run probe -- https://www.acedoutpodcast.com/episodes/32/linda-shider
```

`probe` is the first thing to run on a machine with normal internet access. For each episode URL it reports which lookup sources work (Squarespace JSON, page HTML, RSS), the real pixel size of every photo, the audio file's type, size, duration and range support, browser CORS headers, and whether there is a transcript or only show notes. It also writes `probe-report.json`.

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

# PocketAce

Proof of concept for Ace Alan's [Aced Out Podcast](https://www.acedoutpodcast.com/episodes): turn a 5–10 minute excerpt of an episode into an illustrated vertical (1080×1920) MP4 for YouTube.

Paste an episode page address, drag the excerpt handles over the episode, tap photos in the gallery to add them to the story (a photo can be used more than once), drag them into order on the story strip, preview, and render. PocketAce shares the excerpt out evenly between the photos. Work is saved in the browser as you go. All photo timing, framing, motion and transitions follow fixed rules. There is no AI or speech recognition anywhere in the app.

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

Needs Node 22+ and a full FFmpeg: one with `drawtext` (libfreetype) for the on-screen type, and libass if you use a captions file.

**On a Mac:** `brew install ffmpeg-full`. Since January 2026 Homebrew's plain `ffmpeg` is a slim build without libfreetype or libass, and rendering fails with `No such filter: 'drawtext'`. `ffmpeg-full` is keg-only (not on PATH), but PocketAce looks for it in Homebrew's prefix itself, so there is nothing to link. Debian/Ubuntu's `apt install ffmpeg` is already complete.

```sh
npm run doctor            # which FFmpeg will be used, and what (if anything) it lacks
npm start                 # http://localhost:8080
npm test                  # unit tests + an end-to-end render against a local stand-in site
npm run demo -- 45 final  # renders a 45 s sample from generated test patterns, prints the file path
npm run probe -- https://www.acedoutpodcast.com/episodes/32/linda-shider
npm run sweep             # look up every episode in the feed, one line each
node tools/ui-check.js    # browser acceptance check against a real episode (see below)
```

The server checks FFmpeg when it starts (the result is in its first line of output), the app shows a notice instead of a working **Make the video** button when rendering can't work, and `/api/render` refuses a job up front rather than failing halfway. FFmpeg is looked for in this order: `$FFMPEG_PATH`, `ffmpeg` on PATH, then Homebrew's `ffmpeg-full`; the first complete one wins.

`tools/ui-check.js` drives the page in a real browser against a live episode (Ep 29 by default): the excerpt handles and fields, Play excerpt, reordering by drag, keyboard and buttons, sections, reload, then a render, checking that each shot in the MP4 is the photo in that strip position. It needs Playwright, which is deliberately not a dependency: `npm i --no-save playwright && npx playwright install webkit`, then `node tools/ui-check.js --browser webkit` to run it in Safari's engine. Add `--quality final` for a full-size render.

`probe` checks individual episodes in depth. For each episode URL it reports which lookup sources work (Squarespace JSON, page HTML, RSS), the real pixel size of every photo, the audio file's type, size, duration and range support, browser CORS headers, and whether there is a transcript or only show notes. It also writes `probe-report.json`.

Or with Docker:

```sh
docker build -t pocketace . && docker run -p 8080:8080 -v pocketace-data:/app/data pocketace   # the volume keeps imported photos
```

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `ALLOWED_HOSTS` | `acedoutpodcast.com,squarespace-cdn.com,squarespace.com,amazonaws.com` | The only hosts the server will fetch from (subdomains included). Add the audio host here if episodes live elsewhere. |
| `JOB_TTL_HOURS` | `6` | Rendered videos and downloaded media are deleted after this long |
| `WORK_DIR` | system temp | Scratch space. Wiped on start. |
| `DATA_DIR` | `./data` | Imported photos live in `uploads/` here. Kept across restarts; not in git. |
| `FFMPEG_PATH` | (search) | Use this FFmpeg. `ffprobe` is taken from the same folder, or from `FFPROBE_PATH`. |

## How it works

```
browser (public/)                       server (server.js)                    FFmpeg
───────────────────                     ──────────────────                    ──────
paste URL  ───────────────────────────▶ /api/episode → lib/extract.js
                                        (JSON → HTML → RSS, server-side,
                                         so browser CORS never matters)
pick excerpt, arrange photos on the strip (autosaved)
live preview (CSS, same rules)
"Make the video" ─────────────────────▶ /api/render → queue (one at a time)
                                        download audio + photos (cached)
                                        schedule() again (same code)  ─────▶ pass 1: one segment per shot
                                                                             pass 2: join, type, captions, audio
poll /api/jobs/:id ◀──────────────────  progress, then the MP4
```

Files worth knowing:

- `public/schedule.js`: how long each photo stays on screen. Photos play in exactly the strip order; the excerpt is split by weight (all 1 for now, so evenly). Shared by browser and server, so the preview matches the render. Weights are the hook for dragging the boundaries between tiles later.
- `public/look.js`: the visual rules (when a photo fills the frame vs. is framed, margins, crossfade length, camera moves). Change a number here and both preview and render follow.
- `public/captions.js`: SRT/VTT parsing, clipping to the excerpt, SRT output.
- `lib/render.js`: the FFmpeg command builder. Each render writes its final FFmpeg arguments to `ffmpeg-final-args.json` in the job folder, for debugging.
- `lib/extract.js`: episode lookup. Every finding records which source it came from.
- `lib/photos.js`: reads a file's real type and its EXIF orientation from its bytes.
- `lib/ffmpeg.js`: finds a complete FFmpeg and explains what's missing when there isn't one. Also behind `npm run doctor`.
- `public/app.js`: the editor: excerpt range bar, story strip (drag, keyboard: arrows choose, Option/Alt+arrows move, Delete removes), preview, autosave.

## Using it

- **Two kinds of listening.** The episode player in Excerpt is for exploring the whole recording: it plays and jumps freely, and **Use current time** takes its position. **▶ Play excerpt** under the preview plays only the selection: from Start (or from the photo last clicked on the strip) to End, and the preview, strip playhead and clock follow it. Moving Start or End sends the excerpt back to its start. Jumping around in the episode player while the excerpt plays lets go of the excerpt and leaves the preview where it was.
- **The gallery is a supply.** Every tap adds that photo once more to the end of the story; the badge (×2, ×3…) counts how often it's used. Each copy is its own tile: drag it, or take it out with its **✕** on the strip (or select it and press Remove or Delete).
- **One page scroll.** On a desktop the preview stays pinned beside the builder. When a video is ready it plays in the phone frame and the main button becomes **Download MP4**, with **Make it again** next to it. Change anything and **Make the video** comes back, with a link to the earlier file. After a reload the last video is offered again while the server still has it.

## Photos from your computer

**Add photos…** in the Photos section opens the file picker, or drop photos anywhere on that section (several at once is fine). JPEG, PNG and WebP are taken as they are. HEIC, the iPhone's format, works from Safari, which can open it: PocketAce turns it into a full-size JPEG before sending it. Other browsers can't open HEIC, so they explain that and how to export a JPEG from Photos instead.

Imported photos sit at the end of the gallery with a small "Yours" tag and are used exactly like the website's: tap to add, drag on the strip, preview, render. Hover one (or look at its corner on a touch screen) for **✕** to take it out of the project; if it's in the story, PocketAce asks first.

Where they go: each file is sent once to the PocketAce server and kept, untouched and at full resolution, in `data/uploads/` (or `$DATA_DIR/uploads`), named by a fingerprint of its contents (SHA-256). The saved project only records that name, so a refresh, a restored session or a restart of the server finds the same file, and the same photo imported twice is stored once. A small upright thumbnail is made next to it for the gallery. Phone photos stored sideways with an EXIF "rotate" tag are shown and rendered the right way up.

Limits:

- Taking a photo out of the project doesn't delete its file (another project in another browser may use it). Clearing out `data/uploads/` is safe whenever no project needs those photos; any that do then show as **Missing**, and the story says which.
- 60 MB per file.
- Once PocketAce is hosted, anyone who can open its address can add files to that folder. Fine for a private address; something to close before it's public.

## Saved work

The project autosaves a third of a second after every change, in the browser's `localStorage` under the key `pocketace.project.v1`: episode address and title, the gallery (the photos the lookup found, and the addresses of photos you imported), audio address, start and end, the story in order (each copy of a repeated photo separately), the last finished video, guest name and line underneath, draft/final choice, which sections are open, and a captions file's text if one is loaded. Reloading or reopening the page puts all of it back. **Start over** (top right) clears it. The header shows when it last saved.

Limits, all from living in one browser:

- One project at a time, on one browser on one computer. Safari and Chrome on the same Mac each have their own; so do `localhost:8080` and `localhost:3000`.
- Clearing website data, or a private window, loses it.
- Safari deletes script-written storage for a site that hasn't been used for 7 days of Safari use (WebKit's tracking prevention). A project left alone for a week or more may be gone.
- Imported photos themselves are on the server, not in the browser, so they outlast all of the above (see Photos from your computer).
- Rendered videos are not saved: download the MP4 (the server deletes renders after `JOB_TTL_HOURS`).

The step past this is one small JSON file on the server (a `GET`/`PUT /api/project` pair). It would survive browser cleanups and the 7-day rule, but once PocketAce is hosted, everyone who can open the address shares and overwrites that one project until there is some form of login. That's why it isn't built yet.

## Measured (4 vCPU / 15 GB sandbox, FFmpeg 6.1)

- 10-minute excerpt, 30 photos, final 1080×1920: **309 s** (about 1.9× realtime), 108 MB MP4.
- Peak memory: about **540 MB** across all FFmpeg processes with 30 photos, and flat as photos are added (the first single-pass design peaked at 1.9 GB and grew with every photo).
- 45 s draft at 540×960: about 8 s.

## Not in this prototype (on purpose)

Accounts, a media library (beyond importing stills), video clips, publishing to YouTube, a caption editor, waveform display, adjustable photo durations, more than one saved project. See the findings report for what to build next and what to defer.

Fonts: Archivo and Shrikhand, both SIL Open Font License (see `assets/fonts/`).

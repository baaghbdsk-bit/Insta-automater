# YouTube-only music

Tracks in here are muxed into a **second** render that goes to YouTube. Instagram
and Facebook keep the song from Instagram's Audio API — this pool exists because
a baked-in commercial song is always claimed on YouTube, and the YouTube Data API
has no way to attach an Audio Library track at upload time.

## Where to get them

[youtube.com/audiolibrary](https://www.youtube.com/audiolibrary) → Music →
filter **Attribution: not required** → download the ones that fit the mood.

Taking only "attribution not required" tracks is what keeps the description
clean: the uploader credits the pool as `Music: YouTube Audio Library` and no
per-track attribution is needed. If you pick tracks that *do* require
attribution, add the credit to `assets/music/CREDITS.json` yourself — nothing
reads that file for YouTube today.

## Getting the tracks (one-time sign-in)

Run `npm run yt:login` on this machine. It opens Chrome/Edge at the Audio
Library with a persistent profile in `.auth/`; log in, select the **Music** tab,
click DOWNLOAD on the tracks you want, then press Enter in the terminal. The
script saves the page's data and any downloaded MP3s under `_captured/`, both
gitignored. I read that capture to turn the tracks into the mood folders below.
The sign-in itself is never committed.

The script starts a real Chrome/Edge window and attaches over the DevTools
protocol instead of using Playwright's own launch flags. That matters: Playwright
adds `--enable-automation` and `navigator.webdriver`, which is what triggers
Google's "This browser or app may not be secure" sign-in error. If you see that
error, close any leftover Chrome windows using `.auth/yt-audio-profile` and run
`npm run yt:login` again — do not sign in through the old window.

## How it is used

- `library.pickYtTrack(mood)` prefers `<mood>/` here, then falls back to the
  CC BY 4.0 bed in `assets/music/<mood>/`.
- The track is muxed over the rendered video with the video stream copied, not
  re-encoded (~2 s).
- Rotation is least-recently-used across the pool, tracked in `used_assets`.
- `custom/` is never used for YouTube: those files are of unknown provenance.

## Format

`.mp3`, `.m4a`, `.wav` or `.ogg`. 8–12 tracks per mood is plenty: the pipeline
picks one per post and will not repeat until the pool is exhausted. Keep the
count modest — these files are committed, because the GitHub Actions runner
needs them present.

Set `YT_AUDIO_MODE=same` to turn this off and upload the Instagram mix instead.

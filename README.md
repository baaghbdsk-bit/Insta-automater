# reel-engine

Autonomous Instagram Reels for **@justspeak_1999**.

GitHub Actions wakes up four times a day, invents a hard-hitting English quote, finds a
photo, picks licensed music, renders a 1080×1920 Reel with FFmpeg, uploads it to
Cloudflare R2, publishes it through the Instagram Graph API, records the result
in SQLite, and commits that database back to the repository.

No laptop, no Task Scheduler, no server.

```
GitHub Actions (4 crons, IST)
   │
   ├─ ffmpeg (system build, libass)          ← text rendering
   ├─ theme picked by past reach (insights)
   ├─ quote written by Gemini (deduped)      ← original lines, not a fixed list
   ├─ photo: Pexels → Openverse → Gemini image → local pool
   ├─ music: Instagram Audio API (native); YouTube gets a claim-free re-track
   ├─ render 1080×1920, 10–15 s, slow push/drift, scrim, watermark
   ├─ validate the MP4 locally (codec, size, duration, faststart, audio)
   ├─ upload via direct resumable upload (no hosting)  [R2 fallback available]
   ├─ POST /media → poll status_code → POST /media_publish → permalink
   ├─ delete the hosted object
   └─ commit data/engine.db  [skip ci]
```

---

## What is automated, and what is not

| Automated | Still manual |
|---|---|
| Theme selection, weighted by measured reach | Initial Meta app + token setup |
| Quote writing, caption writing, hashtags | Keeping the token alive (see expiry) |
| Photo discovery and fallback | Profile name, bio, avatar (not writable via API) |
| Music matched to the line's attitude | Nothing else, once secrets are set |
| Rendering, validation, hosting, publishing | |
| Insight collection and theme weighting | |
| Failure notification, retry, dedupe | |

**Music comes from Instagram's Audio API.** The container is created with
`audio_configuration`, so the Reel carries the real track — Eminem, The Script,
slowed/reverb edits — and Instagram credits it. YouTube cannot attach that
audio: the Data API has no field for a library track, and a baked-in commercial
song is claimed on upload. So YouTube gets a **second render** whose audio
stream is swapped for a claim-free track from `assets/music/youtube/` (YouTube
Audio Library), with the video stream copied rather than re-encoded. Instagram
and Facebook keep the real song. See [Music](#music) below.

---

## Repository layout

```
src/
  index.js            CLI entry point
  run.js              one autonomous execution (the orchestrator)
  lines.js            quote + caption generation, dedupe, seed bank
  themes.js           14 content themes → music pool, tone, image queries
  library.js          photo providers, music pool, temp cleanup
  quote.js            FFmpeg renderer (layout, ASS, scrim, camera move)
  video.js            pre-publish validation
  host.js             Cloudflare R2 client (hand-rolled SigV4)
  publish/
    instagram.js      Graph API: container, poll, publish, insights
    index.js          validate → upload → publish → delete
  insights.js         metric collection and per-theme aggregation
  notify.js           Actions annotations, step summary, optional webhook
  db.js               SQLite state (node:sqlite)
  net.js              retry/backoff HTTP helpers
  util.js             ffmpeg paths, logging, probing
  captions.js         ASS primitives shared with the renderer
  config.js           .env + config/config.json
  setup/token.js      Meta token exchange and inspection
assets/
  fonts/              Anton, Archivo Black, Barlow, Noto Devanagari
  music/              CC BY 4.0 fallback bed; custom/ holds user-supplied songs
  photos/             curated fallback pool, per mood
archive/              the retired political/clip engine, kept for reference
data/engine.db        committed state: posts, lines, insights, runs, usage
.github/workflows/publish.yml
```

`archive/` holds the old feed→script→TTS→video pipeline and the clip compositor.
They are not imported anywhere and not part of the build.

---

## One-time setup

### 1. Push the repository

```bash
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

The default branch must be `main`; scheduled workflows only run from the default
branch.

### 2. Repository secrets

Settings → Secrets and variables → Actions → **New repository secret**.

| Secret | Required | Value |
|---|---|---|
| `IG_USER_ID` | yes | `17841436902515070` |
| `IG_ACCESS_TOKEN` | yes | long-lived user token (used for expiry checks and fallback) |
| `FB_PAGE_TOKEN` | yes | long-lived **Page** access token with `instagram_content_publish` (used for publishing) |
| `R2_ACCOUNT_ID` | optional | only needed if `IG_UPLOAD_MODE=url` |
| `R2_ACCESS_KEY_ID` | optional | only needed if `IG_UPLOAD_MODE=url` |
| `R2_SECRET_ACCESS_KEY` | optional | only needed if `IG_UPLOAD_MODE=url` |
| `R2_BUCKET` | optional | only needed if `IG_UPLOAD_MODE=url` |
| `R2_PUBLIC_BASE` | optional | only needed if `IG_UPLOAD_MODE=url` |
| `LLM_BASE_URL` | yes | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `LLM_API_KEY` | yes | Gemini API key |
| `LLM_MODEL` | yes | `gemini-3-flash-preview,gemini-3.6-flash,gemini-3.8-flash` |
| `FB_APP_ID` | optional | enables token-expiry reporting |
| `FB_APP_SECRET` | optional | same |
| `FB_PAGE_ID` | optional | only needed by `token:exchange` |
| `PEXELS_API_KEY` | optional | better photos; otherwise Openverse (CC0) |
| `GEMINI_IMAGE_MODEL` | optional | enables AI image generation when quota allows |
| `NOTIFY_WEBHOOK_URL` | optional | Discord/Slack webhook for failures |

`R2_PUBLIC_BASE` must be a public, unauthenticated HTTPS URL that returns the MP4
with `Content-Type: video/mp4`. Instagram fetches it from Meta's infrastructure,
not from your machine.

### 3. Cloudflare R2

1. Create a bucket (`reel-videos`).
2. Settings → **Public access** → connect a **custom domain**
   (`cdn.yourdomain.com`). The `r2.dev` development URL works for a trial but is
   rate-limited and not meant for production.
3. Manage R2 API Tokens → **Create API token** → permission *Object Read & Write*
   → scope it to this one bucket. Copy the access key id and secret.
4. Add a **lifecycle rule**: prefix `reels/`, delete objects after **2 days**.
   The engine deletes each video right after publishing; the rule is the safety
   net for a run that dies between upload and publish.
5. Verify from your machine:

```bash
npm run r2:check      # uploads a 20-byte object, reads it over the public URL, deletes it
```

Free tier: 10 GB storage, 1 M writes, 10 M reads per month, no egress fees. At
four Reels a day this uses well under 1% of it.

### 4. Meta / Instagram

Already configured for this account, but for the record the app needs:

- Instagram **Business or Creator** account linked to a Facebook Page.
- App permissions: `instagram_basic`, `instagram_content_publish`,
  `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`.
- A long-lived token. `npm run token:status` prints expiry and scopes.

**Token expiry:** the current token has `expires_at: 0` (no refresh needed) but
`data_access_expires_at` around **12 Feb 2027**. A workflow cannot write
repository secrets without a separate PAT, so that date is a manual re-auth.
Runs start warning 21 days before it and fail loudly once it has passed.

### 5. Workflow permissions

Settings → Actions → General → **Workflow permissions** → *Read and write*.
The workflow commits `data/engine.db` back to the repo.

---

## Activating the schedule

The cron entries are already in `.github/workflows/publish.yml`:

| Intended (IST) | Cron (UTC) | Fires (IST) |
|---|---|---|
| 10:00 | `20 4 * * *` | 09:50 |
| 18:30 | `50 12 * * *` | 18:20 |
| 21:00 | `20 15 * * *` | 20:50 |

The cron fires ten minutes early on purpose: GitHub cron is best-effort with
5–30 minute delays, and rendering plus publishing take a few more minutes, so
the upload normally lands close to the intended time rather than after it.

Occasional dropped runs still happen. The engine is built for that — a late or
duplicated trigger cannot double-post, because it checks the daily cap and the
minimum gap between posts.

**Test it before trusting cron:**

1. Actions → *reel-engine* → **Run workflow** → tick `dry_run` → Run.
   It builds and validates a Reel but publishes nothing. Download the artifact
   or read the step summary.
2. Run it again with `dry_run` unticked. That is your first real publish.
3. Only then let the schedule take over.

Committing state on every run also keeps the repository active, which is what
stops GitHub from disabling the schedule after 60 days of inactivity.

---

## Local commands

```bash
npm install                 # full install, downloads the bundled ffmpeg
npm test                    # unit tests (no network)
RUN_RENDER_TEST=1 npm test  # also renders a real 8-second Reel

npm run doctor              # ffmpeg filters, fonts, DB, keys, R2, Instagram
npm run dry                 # full run without publishing
npm run run                 # full run, publishes if R2 is configured
npm run status              # recent posts, statuses, today's count
npm run insights            # reach / saves / shares per post and per theme
npm run quote -- --theme discipline --variant lower
npm run library             # photo, music and line inventory
npm run cleanup             # delete temp files, checkpoint the DB
npm run token:status
```

Windows has no system ffmpeg by default; `util.js` falls back to the
`ffmpeg-static` package. In CI, `FFMPEG_PATH=/usr/bin/ffmpeg` points at the
distro build, which is compiled with libass.

---

## How the engine decides

**Theme.** 14 themes (`heartbreak`, `loneliness`, `letting_go`, `self_respect`,
`growth`, `discipline`, `ambition`, `confidence`, `success`, `motivation`,
`life_lessons`, `reality`, `friendship`, `emotional_intelligence`). Selection is
weighted by the median reach each theme has actually produced, multiplied by a
random factor, with a heavy penalty for the last few themes used. A theme that
reaches 2× the median gets proportionally more airtime — and nothing is ever
locked in.

**Quote.** Generated by Gemini for the chosen theme, filtered hard: Roman script
only, 18–118 characters, Roman script only, no emoji, no
hashtags, no known cliché, and not within 0.62 Jaccard similarity of any seed,
recent or already-used line. Survivors go into `generated_lines` with a unique
normalised form. A hand-written bank of 80 lines is the offline fallback.

**Photo.** Pexels (if keyed) → Openverse (CC0/public domain) → Gemini image
generation (if a model is configured and quota allows) → curated local pool.
Remote photos are downloaded per run and not committed, so the repository does
not grow and the same photo is not reused.

**Music.** The track is matched to the *attitude* of the line, not its topic:
hard truth → rap, quiet hurt → slowed + reverb, rising up → anthemic. Three
layers, in priority order:

1. `assets/music/custom/<mood>/` — drop any mp3 here and it is used first, on
   both platforms, exactly as supplied.
2. `src/music-picks.js` — a curated pool of `original_sound` ids from Instagram's
   Audio API (real songs and edits, not the stock `music` catalogue). Each id is
   re-resolved at run time, because Meta's `download_url` expires after ~1.5
   days; the least-recently-used track is picked.
3. Keyword search on the same API, then the local CC BY 4.0 bed as a last
   resort.

**Per platform.** Instagram and Facebook get the track above. YouTube gets its
own audio, because the Data API cannot attach a library track and a baked-in
commercial song is claimed the moment it uploads:

- `assets/music/youtube/<mood>/` — download claim-free tracks from the
  [Audio Library](https://www.youtube.com/audiolibrary) (filter *attribution not
  required*) and drop them in. `library.pickYtTrack(mood)` prefers these.
- Fallback: the CC BY 4.0 bed in `assets/music/<mood>/`, credited in the YouTube
  description as before. `custom/` is never used here.
- `YT_AUDIO_MODE=same` opts out and uploads the Instagram mix unchanged.

The swap is a remux (`quote.retrackVideo`): the video stream is copied, so it
costs roughly two seconds per post and nothing is re-rendered. Picks rotate
least-recently-used, independent of the Instagram pool.

`npm run audio:verify` validates the pool without posting: duration, leading
silence (native audio starts at 0, so an intro is dead air), hook loudness in the
first three seconds, true peak and channel layout. It exits 1 when a pick would
sound broken on a reel.

`npm run music:audit` checks the local beds: where the clip actually starts,
how loud the first two seconds are against the body, source level and true peak.
It flags clipped masters, slow intros and files that need a huge boost.

Every bed is measured over the exact segment that plays, then gets a **fixed**
gain towards -14 LUFS and a lookahead limiter at -2 dBTP. `loudnorm`'s single
pass was dynamic mode — it kept re-deciding the level inside a ten-second clip;
even two-pass fell back to dynamic on most of this pool, landing between -16.4
and -12.8 LUFS. A 95 Hz high-pass and a gentle low shelf clear the phone-speaker
mud. Gain is capped so the limiter never removes more than 6 dB, which leaves
dynamic material a little under -14 instead of squashing it. Start points are
picked by energy rather than by silence: `five-armies` used to open 13 dB below
its own body, now it opens level. The same chain feeds the first render and the
YouTube re-track.

`npm run audio:audition` renders 12-second clips of the whole curated
pool to `output/audition/index.html` so the set can be heard and edited before
it reaches the account. Clips start at 0, which is what Instagram plays.

**Layout.** Font size is chosen so the quote fills the frame without orphans,
capped at four lines. Text sits high, centred or low (rotating), on a generated
gaussian scrim. Camera motion is one of five slow pushes/drifts, chosen at
random.

**First frame.** The whole quote is fully opaque on frame 1 — no fade, no
staggered reveal — because that frame is the Shorts thumbnail and the only thing
a viewer sees before deciding to swipe. The camera push supplies the motion. The
audio hook gets the same treatment: the bed fades in over 0.12 s, not 0.9 s, and
the track starts at the first audible sample instead of a random point 12–50 %
into the song. The tail fade is 0.35 s so a loop restarts on sound rather than
dead air.

When the bank entry carries an author, a smaller italic byline ("— Nelson
Mandela") is drawn just under the last line, in the accent colour, also visible
on frame 1. Lines without an author render with no byline at all.

**Held lines.** The 448 imported classics (batch 14) are `status: "held"`, not
deleted. They stay in `assets/quotes/bank.json` but the picker skips them, so
the feed is back to the original second-person lines — the ones that held
37–44 % of viewers instead of 18–20 %. Because every authored line is in that
batch, no byline is currently drawn; move one entry back to `"approved"` to test
it, and the byline comes back with it. `node src/index.js lines:bank` lists every
held line and why it is held.

**Line shape.** Batch 15 is the counterweight to the classics: second person, one
concrete noun from ordinary life, a deadline, and no moral attached. Eighteen
lines, interleaved at one new line per two originals starting at the current
rotation point of each mood, so the shape is measured against the original lines
within days instead of sitting at the end of the queue for months. If it holds
better, the same constraints get applied to the weakest of the original 742;
if it does not, nothing else changes.

---

## Reliability

- **Retries** with exponential backoff and jitter on every network call.
  Instagram rate-limit codes (4, 17, 32, 613) are retried; validation errors are
  not, because retrying a bad request only burns publishing quota.
- **Pre-publish validation**: h264, yuv420p, 1080×1920, AAC audio, 7–18 s,
  `moov` before `mdat`, size under 100 MB.
- **Duplicate protection, three layers**: a `publishing` row written *before* the
  API call; a min-gap and daily-cap check; and a comparison of the caption's
  first line against the account's last 12 posts.
- **Crash reconciliation**: rows still `publishing` after 30 minutes are checked
  against the live account. If the Reel exists it is recorded as published; if
  not, the row is failed. Never double-posted.
- **Auth reporting**: `debug_token` runs every execution; under 21 days left
  produces a warning, and an expired token fails the run with an explicit
  re-authorisation message.
- **Notification**: `::error::` annotations, the run step summary, and an
  optional webhook. A run that fails never reports success.
- **Cleanup**: the hosted object is deleted after publish (R2 lifecycle rule as
  backstop); `assets/tmp` is pruned every run.

---

## Costs

| Component | Free tier | This project |
|---|---|---|
| GitHub Actions (public repo) | unlimited | ~300 min/month |
| GitHub Actions (private repo) | 2,000 min/month | ~300 min/month |
| Cloudflare R2 | 10 GB, 1 M writes, 10 M reads | <1 GB, <400 ops/month |
| Instagram Graph API | free | 3 publishes/day |
| Gemini free tier | yes | ~4 calls/day |
| Domain for the R2 custom domain | — | ₹800–1,200/year (optional but recommended) |

`₹0/month` is realistic; the domain is the only optional spend.

---

## Known limitations

1. **One real publish has not been performed yet.** R2 credentials were not
   available during implementation, so the upload → container → publish path is
   written and unit-tested (SigV4 matches AWS's published test vector) but has
   not touched the live account.
2. **Content ID claims on YouTube.** Since the YouTube upload uses the
   `assets/music/youtube/` pool, a claim should now be the exception rather than
   the rule. Before that pool is populated the CC BY 4.0 bed is used instead — and
   CC BY is a *licence*, not an absence of claims: Kevin MacLeod's catalogue is
   registered with Content ID, which is where the Belarus/Russia restrictions came
   from. Observed effect on the live account: visibility unaffected, revenue to
   the claimant. A pick can still be muted or blocked in a market that matters,
   which is why the Audio Library pool is the better source. Instagram remains the
   primary platform.
3. **Profile fields are not writable** by the Graph API (`code 100,
   subcode 33`). Name, bio and avatar stay manual.
4. **Cron is best-effort.** A slot can drift by up to ~30 minutes or be dropped.
   The crons fire ten minutes early to absorb that; the daily cap is 3, so a
   dropped slot is not replaced automatically.
5. **Gemini image generation is quota-blocked** on the current key (HTTP 429 on
   every image model). The provider is implemented and stays dormant until
   `GEMINI_IMAGE_MODEL` is set to a model the key can use.
6. **Pexels key issuance is paused.** Without it, photos come from Openverse at
   960–1024 px, upscaled to 2160 for the crop. Fine, but softer than Pexels.
7. **Token re-auth is manual**, before 12 Feb 2027.

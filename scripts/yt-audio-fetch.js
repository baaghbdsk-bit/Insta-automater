'use strict';
/**
 * Step 2 of filling assets/music/youtube/: download the selected tracks.
 *
 *   node scripts/yt-audio-fetch.js --dry-run   # show the picks, download nothing
 *   node scripts/yt-audio-fetch.js             # fill the three mood folders
 *
 * Uses the signed-in profile from `npm run yt:login`. It reads the Audio
 * Library's own list_tracks endpoint, scores every track by mood/genre/
 * instrument, then uses the UI's search + DOWNLOAD button so each file comes
 * from YouTube's own signed URL. No scraping of random "no copyright" sites.
 *
 * All 1200 tracks here come back as CREATOR_MUSIC_LICENSE_TYPE_YOUTUBE, i.e.
 * the standard Audio Library license: no Content ID claim and no attribution
 * required. SOURCES.json records them anyway for provenance.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const { ROOT } = require('../src/config');
const { FFMPEG, run } = require('../src/util');
const mix = require('../src/music-mix');

const PROFILE = path.join(ROOT, '.auth', 'yt-audio-profile');
const CAPTURE = path.join(ROOT, 'assets', 'music', 'youtube', '_captured');
const TARGET = path.join(ROOT, 'assets', 'music', 'youtube');
const CHANNEL_URL = 'https://studio.youtube.com/channel/UCVbGRGT1traAXmj-bsTCfcg/music';
const CHROME = process.env.YT_BROWSER_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9338;
const PER_MOOD = 8;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let LIST_CONTEXT = null;
let LIST_HEADERS = {};

const RULES = {
  heartbreak: {
    moods: { SAD: 12, ROMANTIC: 7, CALM: 5, DARK: 4 },
    genres: { CLASSICAL: 8, AMBIENT: 8, JAZZ_AND_BLUES: 7, CINEMATIC: 4, COUNTRY_AND_FOLK: 3 },
    instruments: { PIANO: 12, STRINGS: 8, ACOUSTIC_GUITAR: 7, SYNTH: 2, DRUMS: -8, ELECTRIC_GUITAR: -5 },
    need: (t) => (t.attributes.moods || []).some((m) => /SAD|ROMANTIC|CALM/.test(m)),
  },
  growth: {
    moods: { CALM: 12, INSPIRATIONAL: 8, HAPPY: 4, BRIGHT: 4 },
    genres: { AMBIENT: 10, CLASSICAL: 8, JAZZ_AND_BLUES: 6, COUNTRY_AND_FOLK: 6, CINEMATIC: 3 },
    instruments: { PIANO: 10, STRINGS: 8, ACOUSTIC_GUITAR: 8, SYNTH: 3, DRUMS: -6, ELECTRIC_GUITAR: -4 },
    need: (t) => (t.attributes.moods || []).some((m) => /CALM|INSPIRATIONAL|HAPPY|BRIGHT/.test(m)),
  },
  motivation: {
    moods: { INSPIRATIONAL: 12, DRAMATIC: 10, BRIGHT: 8, HAPPY: 5, ANGRY: 3 },
    genres: { CINEMATIC: 10, ROCK: 8, POP: 6, CLASSICAL: 6, DANCE_AND_ELECTRONICS: 4 },
    instruments: { DRUMS: 6, STRINGS: 6, SYNTH: 4, ELECTRIC_GUITAR: 3, PIANO: 2 },
    need: (t) => (t.attributes.moods || []).some((m) => /INSPIRATIONAL|DRAMATIC|BRIGHT|HAPPY/.test(m)),
  },
};

function short(value, prefix) {
  return String(value).replace(prefix, '');
}

function scoreTrack(t, rule) {
  let score = 0;
  for (const x of t.attributes.moods || []) score += rule.moods[short(x, 'CREATOR_MUSIC_MOOD_')] || 0;
  for (const x of t.attributes.genres || []) score += rule.genres[short(x, 'CREATOR_MUSIC_GENRE_')] || 0;
  for (const x of t.attributes.instruments || []) score += rule.instruments[short(x, 'CREATOR_MUSIC_INSTRUMENT_')] || 0;
  const seconds = Number(t.duration && t.duration.seconds);
  if (!Number.isFinite(seconds) || seconds < 80 || seconds > 260) return -100;
  return score;
}

function select(all) {
  const out = {};
  const used = new Set();
  for (const [mood, rule] of Object.entries(RULES)) {
    const ranked = all
      .filter((t) => t.licenseType === 'CREATOR_MUSIC_LICENSE_TYPE_YOUTUBE' && rule.need(t))
      .map((t) => ({ t, score: scoreTrack(t, rule) }))
      .filter((x) => x.score > 8 && !used.has(x.t.trackId))
      .sort((a, b) => b.score - a.score);
    const chosen = [];
    const artistCounts = new Map();
    for (const { t, score } of ranked) {
      const artist = (t.artist && t.artist.name) || 'Unknown';
      if ((artistCounts.get(artist) || 0) >= 2) continue;
      artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
      used.add(t.trackId);
      chosen.push({
        mood,
        trackId: t.trackId,
        viperId: t.viperId,
        title: t.title,
        artist,
        seconds: Number(t.duration.seconds),
        genres: (t.attributes.genres || []).map((g) => short(g, 'CREATOR_MUSIC_GENRE_')),
        moods: (t.attributes.moods || []).map((m) => short(m, 'CREATOR_MUSIC_MOOD_')),
        score,
      });
      if (chosen.length === PER_MOOD) break;
    }
    out[mood] = chosen;
  }
  return out;
}

async function openBrowser() {
  const child = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    CHANNEL_URL,
  ], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();

  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    try {
      ready = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok;
    } catch {
      // still starting
    }
    if (ready) break;
    await sleep(500);
  }
  if (!ready) throw new Error(`Chrome did not open a debug port on ${PORT}. Log in again with npm run yt:login first.`);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  return { browser, context: browser.contexts()[0] };
}

async function listAll(page) {
  let template = null;
  let headers = {};
  page.on('request', (r) => {
    if (r.url().includes('creator_music/list_tracks') && !template) {
      template = JSON.parse(r.postData() || '{}');
      headers = r.headers();
    }
  });
  await page.goto(CHANNEL_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(6000);
  if (!template) throw new Error('could not capture the list_tracks request from the Audio Library');
  LIST_CONTEXT = template.context;
  LIST_HEADERS = headers;

  const all = await page.evaluate(async ({ tpl, hdrs }) => {
    const out = [];
    let token = null;
    for (let i = 0; i < 80; i += 1) {
      const body = JSON.parse(JSON.stringify(tpl));
      body.pageInfo = { pageSize: 30, ...(token ? { pageToken: token } : {}) };
      const res = await fetch('https://studio.youtube.com/youtubei/v1/creator_music/list_tracks?alt=json', {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!Array.isArray(j.tracks)) break;
      out.push(...j.tracks);
      token = j.pageInfo && j.pageInfo.nextPageToken;
      if (!token) break;
    }
    return out;
  }, { tpl: template, hdrs: headers });

  fs.writeFileSync(path.join(CAPTURE, 'all-tracks.json'), JSON.stringify(all, null, 2), 'utf8');
  return all;
}

function safeFile(title) {
  return String(title).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 90);
}

/** Ask the Studio API for signed MP3 URLs for a batch of track ids. */
async function signedUrls(page, tracks) {
  return page.evaluate(async ({ context, hdrs, ids, channelId }) => {
    const body = { context, trackIds: ids, channelId, mask: { includeDownloadUrl: true } };
    const res = await fetch('https://studio.youtube.com/youtubei/v1/creator_music/get_tracks?alt=json', {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (!Array.isArray(j.tracks)) return { error: JSON.stringify(j).slice(0, 300) };
    return j.tracks.map((t) => ({ trackId: t.trackId, url: t.downloadAudioUrl, title: t.title }));
  }, {
    context: LIST_CONTEXT,
    hdrs: LIST_HEADERS,
    ids: tracks.map((t) => t.trackId),
    channelId: 'UCVbGRGT1traAXmj-bsTCfcg',
  });
}

async function saveTrack(url, dest) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
      Referer: 'https://studio.youtube.com/',
    },
  });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100_000) throw new Error(`download too small (${buf.length} bytes)`);

  // A 10-15 s reel never needs a 6-minute master. Keep the first 60 s (the
  // energy picker scans at most 30 s before choosing a start), re-encoded at
  // 128 kbps so 24 tracks are ~17 MB in git instead of ~156 MB.
  const raw = path.join(CAPTURE, 'incoming.mp3');
  fs.writeFileSync(raw, buf);
  try {
    await run(FFMPEG, ['-y', '-v', 'error', '-i', raw, '-t', '60', '-c:a', 'libmp3lame', '-b:a', '128k', dest], {
      timeout: 120_000,
    });
  } finally {
    fs.rmSync(raw, { force: true });
  }
  const size = fs.statSync(dest).size;
  if (size < 50_000) throw new Error(`trimmed file too small (${size} bytes)`);
  return `${(size / 1048576).toFixed(1)} MB`;
}

async function main() {
  fs.mkdirSync(CAPTURE, { recursive: true });
  const dryRun = process.argv.includes('--dry-run');
  const { browser, context } = await openBrowser();
  const page = context.pages()[0] || (await context.newPage());
  const cdp = await context.newCDPSession(page);

  const all = await listAll(page);
  const chosen = select(all);
  fs.writeFileSync(path.join(CAPTURE, 'selection.json'), JSON.stringify(chosen, null, 2), 'utf8');

  for (const [mood, list] of Object.entries(chosen)) {
    console.log(`\n${mood} (${list.length}):`);
    for (const t of list) console.log(`  ${String(t.seconds).padStart(3)}s  ${t.title} - ${t.artist}`);
  }

  if (dryRun) {
    console.log('\nDry run: nothing downloaded.');
    try { await cdp.send('Browser.close'); } catch { await browser.close(); }
    return;
  }

  const okBtn = page.locator('text=OK').first();
  if (await okBtn.count().catch(() => 0)) {
    await okBtn.click().catch(() => {});
    await page.waitForTimeout(600);
  }

  const flat = Object.values(chosen).flat();
  const urls = await signedUrls(page, flat);
  if (urls.error) throw new Error(`get_tracks failed: ${urls.error}`);
  const byId = new Map(urls.map((u) => [u.trackId, u.url]));
  console.log(`\nsigned URLs: ${byId.size}/${flat.length}`);

  const results = [];
  const limit = Number(process.env.YT_LIMIT || 0);
  let done = 0;
  outer: for (const [mood, list] of Object.entries(chosen)) {
    fs.mkdirSync(path.join(TARGET, mood), { recursive: true });
    for (const track of list) {
      const dest = path.join(TARGET, mood, `${safeFile(track.title)}.mp3`);
      if (fs.existsSync(dest)) {
        console.log(`skip (exists): ${path.basename(dest)}`);
        results.push({ ...track, file: path.relative(ROOT, dest), status: 'exists' });
        continue;
      }
      try {
        const url = byId.get(track.trackId);
        if (!url) throw new Error('no signed URL for this track');
        const size = await saveTrack(url, dest);
        console.log(`ok  ${mood}/${path.basename(dest)}  (${size})`);
        results.push({ ...track, file: path.relative(ROOT, dest), status: 'downloaded' });
      } catch (e) {
        console.log(`FAIL ${mood}/${track.title}: ${String(e.message).slice(0, 110)}`);
        results.push({ ...track, status: 'failed', error: String(e.message).slice(0, 160) });
      }
      done += 1;
      if (limit && done >= limit) break outer;
    }
  }

  const sources = path.join(TARGET, 'SOURCES.json');
  fs.writeFileSync(sources, JSON.stringify({ source: 'YouTube Audio Library', license: 'YouTube (no attribution required)', tracks: results }, null, 2), 'utf8');

  console.log('\nAudit:');
  for (const r of results.filter((x) => x.file)) {
    const a = await mix.audit(path.join(ROOT, r.file));
    console.log(`  ${path.basename(r.file).padEnd(34)} start ${a.start.toFixed(2)}s  hook ${a.hook.toFixed(1)}dB  src ${a.source.toFixed(1)}dB  ${a.verdict}`);
  }

  try { await cdp.send('Browser.close'); } catch { await browser.close(); }
}

main().catch((e) => {
  console.error(`\n${String(e && e.message ? e.message : e)}`);
  process.exitCode = 1;
});

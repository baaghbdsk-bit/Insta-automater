'use strict';
/**
 * Step 1 of filling assets/music/youtube/: sign in and capture the Audio Library.
 *
 * Run it locally, in a real browser window:
 *
 *   npm run yt:login
 *
 * A Chrome/Edge window opens at the Audio Library. Log in, click the Music tab,
 * browse a little (and click DOWNLOAD on anything you want), then press Enter in
 * this terminal. The script saves:
 *
 *   assets/music/youtube/_captured/manifest.json   - what the page returned
 *   assets/music/youtube/_captured/*.json          - raw API payloads
 *   assets/music/youtube/_captured/downloads/      - any MP3s you clicked
 *
 * The browser profile lives in .auth/yt-audio-profile and is gitignored. Nothing
 * here uploads, publishes or changes the bank. Step 2 (turning the capture into
 * claim-free track files) comes after I read the manifest.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { chromium } = require('playwright-core');
const { ROOT } = require('../src/config');

const PROFILE = path.join(ROOT, '.auth', 'yt-audio-profile');
const CAPTURE = path.join(ROOT, 'assets', 'music', 'youtube', '_captured');
const DOWNLOADS = path.join(CAPTURE, 'downloads');
const AUDIO_LIBRARY_URL = 'https://www.youtube.com/audiolibrary';

function browserPath() {
  if (process.env.YT_BROWSER_PATH) return process.env.YT_BROWSER_PATH;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      'No Chrome or Edge found. Set YT_BROWSER_PATH to your browser executable, ' +
        'or install playwright browsers with: npx playwright install chromium'
    );
  }
  return found;
}

function safeName(url) {
  return String(url)
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
}

function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

async function main() {
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE, {
    executablePath: browserPath(),
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });

  const payloads = [];
  const mp3Urls = new Set();

  const watch = (page) => {
    page.on('response', async (res) => {
      const url = res.url();
      if (/\.mp3(\?|$)/i.test(url)) mp3Urls.add(url);

      const type = String(res.headers()['content-type'] || '');
      if (!type.includes('json')) return;
      if (!/audiolibrary|youtubei|browse|music/i.test(url)) return;

      try {
        const text = await res.text();
        if (text.length < 200 || text.length > 4_000_000) return;
        const useful = /audiolibrary|get_audio_library/i.test(url) || /"(tracks|music|audioTrack|downloadUrl|trackId)"/i.test(text);
        if (!useful) return;

        const name = `${String(payloads.length).padStart(3, '0')}-${safeName(url)}.json`;
        fs.writeFileSync(path.join(CAPTURE, name), text, 'utf8');
        let keys = [];
        try {
          keys = Object.keys(JSON.parse(text)).slice(0, 24);
        } catch {
          keys = ['(not a JSON object)'];
        }
        payloads.push({ url, file: name, bytes: text.length, keys });
        console.log(`captured ${name} (${(text.length / 1024).toFixed(0)} KB)`);
      } catch {
        // A response can be cancelled while navigating; ignore it.
      }
    });

    page.on('download', async (download) => {
      const name = download.suggestedFilename() || `track-${Date.now()}.mp3`;
      const dest = path.join(DOWNLOADS, name);
      try {
        await download.saveAs(dest);
        console.log(`download saved: ${dest}`);
      } catch (e) {
        console.log(`download failed: ${String(e.message)}`);
      }
    });
  };

  for (const page of context.pages()) watch(page);
  context.on('page', watch);

  const page = context.pages()[0] || (await context.newPage());
  console.log('\nOpening the Audio Library in a browser window...');
  await page.goto(AUDIO_LIBRARY_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((e) => {
    console.log(`navigation warning: ${String(e.message).slice(0, 120)}`);
  });

  console.log('\n------------------------------------------------------------');
  console.log('1. Log in to YouTube in the browser window that just opened.');
  console.log('2. Make sure the MUSIC tab is selected (not Sound effects).');
  console.log('3. Scroll a bit, and click DOWNLOAD on any track you want.');
  console.log('4. Come back here and press Enter.');
  console.log('------------------------------------------------------------\n');
  await ask('Ready? Press Enter to pull the data: ');

  // Re-opening after login triggers the signed-in API calls. Scrolling loads
  // the rest of the list (the table is virtualised).
  await page.goto(AUDIO_LIBRARY_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(8000);
  for (let i = 0; i < 8; i += 1) {
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(900);
  }

  const manifest = {
    capturedAt: new Date().toISOString(),
    url: page.url(),
    title: await page.title().catch(() => ''),
    note: 'Browser profile is .auth/yt-audio-profile (gitignored). No tokens are stored here.',
    payloads,
    mp3Urls: [...mp3Urls],
    downloads: fs.existsSync(DOWNLOADS)
      ? fs.readdirSync(DOWNLOADS).filter((f) => /\.(mp3|m4a|wav|ogg)$/i.test(f))
      : [],
  };
  const manifestPath = path.join(CAPTURE, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  await context.close();

  console.log(`\nDone. ${payloads.length} payload(s), ${mp3Urls.size} mp3 URL(s), ${manifest.downloads.length} downloaded file(s).`);
  console.log(`Manifest: ${manifestPath}`);
  console.log('Send me that manifest (or paste it) and I will write the track downloader.');
}

main().catch((e) => {
  console.error(`\n${String(e && e.message ? e.message : e)}`);
  process.exitCode = 1;
});

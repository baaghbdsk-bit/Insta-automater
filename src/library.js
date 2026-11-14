'use strict';
/**
 * Asset library.
 *
 * Photos come from a chain of providers, in order:
 *   1. Pexels        (needs PEXELS_API_KEY, best quality, licence: free commercial)
 *   2. Openverse     (keyless, CC0 / public domain only)
 *   3. Gemini image  (AI generation, only if GEMINI_IMAGE_MODEL is set and quota allows)
 *   4. local pool    (assets/photos/<mood>/ — curated, always available offline)
 *
 * Remote photos are downloaded per run into assets/tmp and are NOT committed:
 * the runner is ephemeral, so a fresh photo per post costs nothing and the
 * repository never grows. The local pool is the offline fallback.
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, paths, env, llm } = require('./config');
const { log, ensureDir, IMAGE_EXT, slug, probeSize, sleep } = require('./util');
const { withRetry } = require('./net');
const store = require('./db');

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.flac']);
const PHOTOS = path.join(ROOT, 'assets', 'photos');
const MUSIC = path.join(ROOT, 'assets', 'music');
const REMOTE_DIR = path.join(paths.tmp, 'photos');

const MIN_SHORT_SIDE = 900;
const MIN_TALL_RATIO = 1.05; // height / width
const MAX_BYTES = 12 * 1024 * 1024;

function walk(dir, exts) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, exts));
    else if (exts.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out.sort();
}

function moodPool(root, mood, exts) {
  const specific = walk(path.join(root, mood), exts);
  if (specific.length) return specific;
  return walk(root, exts);
}

function photoCount(mood) {
  return moodPool(PHOTOS, mood, IMAGE_EXT).length;
}

function trackCount(mood) {
  return moodPool(MUSIC, mood, AUDIO_EXT).length;
}

// ------------------------------------------------------------ local pool

function readCredits() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PHOTOS, 'credits.json'), 'utf8'));
  } catch {
    return {};
  }
}

function describeLocal(file) {
  const credits = readCredits();
  const key = path.relative(ROOT, file).split(path.sep).join('/');
  const meta = credits[key] || {};
  return {
    path: file,
    provider: 'local',
    id: key,
    source: meta.page || meta.source || null,
    license: meta.license || 'see assets/photos/credits.json',
    credit: meta.creator || meta.photographer || '',
  };
}

/** Pick an unused local photo for the mood (falls back to any mood). */
function pickPhoto(mood) {
  const pool = moodPool(PHOTOS, mood, IMAGE_EXT);
  if (!pool.length) return null;
  const chosen = store.pickAsset('photo', pool);
  if (chosen) store.markAsset('photo', chosen);
  return chosen;
}

/** Pick an unused track for the mood (falls back to any mood). */
function pickTrack(mood) {
  const pool = moodPool(MUSIC, mood, AUDIO_EXT);
  if (!pool.length) return null;
  const chosen = store.pickAsset('music', pool);
  if (chosen) store.markAsset('music', chosen);
  return chosen;
}

// ------------------------------------------------------------ providers

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function searchPexels(query, { perPage = 20 } = {}) {
  const key = String(env.PEXELS_API_KEY || '').trim();
  if (!key) return [];
  const page = 1 + Math.floor(Math.random() * 4);
  const u = new URL('https://api.pexels.com/v1/search');
  u.searchParams.set('query', query);
  u.searchParams.set('orientation', 'portrait');
  u.searchParams.set('per_page', String(perPage));
  u.searchParams.set('page', String(page));

  const res = await fetch(u, {
    headers: { Authorization: key },
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) throw new Error(`pexels HTTP ${res.status}`);
  const json = await res.json();
  return (json.photos || []).map((p) => ({
    provider: 'pexels',
    id: String(p.id),
    key: `pexels:${p.id}`,
    url: `${String(p.src.original).split('?')[0]}?auto=compress&cs=tinysrgb&w=1600`,
    source: p.url,
    license: 'Pexels License (free commercial use)',
    credit: p.photographer || '',
  }));
}

async function searchOpenverse(query, { perPage = 20 } = {}) {
  const page = 1 + Math.floor(Math.random() * 3);
  const u = new URL('https://api.openverse.org/v1/images/');
  u.searchParams.set('q', query);
  u.searchParams.set('license', 'cc0,pdm');
  u.searchParams.set('aspect_ratio', 'tall');
  u.searchParams.set('size', 'large');
  u.searchParams.set('page_size', String(perPage));
  u.searchParams.set('page', String(page));

  const res = await fetch(u, {
    headers: { 'User-Agent': 'InstaAutomater/1.0 (personal project)' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`openverse HTTP ${res.status}`);
  const json = await res.json();
  return (json.results || [])
    .filter((r) => {
      const w = r.width || 0;
      const h = r.height || 0;
      if (!w || !h) return true; // validate after download
      return w >= 900 && h >= 1300 && h / w >= 1.2;
    })
    .map((r) => ({
      provider: 'openverse',
      id: String(r.id),
      key: `openverse:${r.id}`,
      url: r.url,
      source: r.foreign_landing_url || null,
      license: `CC ${String(r.license || '').toUpperCase()}${r.license_version ? ' ' + r.license_version : ''}`,
      credit: r.creator || '',
    }));
}

let geminiImageDisabled = false;

function geminiNativeBase() {
  return String(llm.baseUrl || '').replace(/\/openai\/?$/, '').replace(/\/+$/, '');
}

/**
 * AI image generation through the Gemini native API. Disabled by default:
 * unless GEMINI_IMAGE_MODEL names a model the key can actually use, this is
 * skipped, and a single 429 disables it for the rest of the process.
 */
class GeminiImageProvider {
  static get name() {
    return 'gemini-image';
  }

  static get enabled() {
    return !!(llm.apiKey && String(env.GEMINI_IMAGE_MODEL || '').trim() && !geminiImageDisabled);
  }

  static async search(query, { mood } = {}) {
    if (!this.enabled) return [];
    const model = String(env.GEMINI_IMAGE_MODEL).trim();
    const prompt = `Vertical 9:16 cinematic photograph for an Instagram quote reel about ${mood}. Subject: ${query}. Moody natural light, shallow depth of field, dark negative space in the upper third for text, muted film colours, no people looking at camera, no text, no watermark, no logos.`;

    const url = `${geminiNativeBase()}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(llm.apiKey)}`;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE'] },
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      log.warn(`photos: gemini-image network error (${e.message.slice(0, 80)})`);
      return [];
    }

    const text = await res.text();
    if (!res.ok) {
      if (res.status === 429 || /quota/i.test(text)) {
        geminiImageDisabled = true;
        log.warn('photos: gemini-image quota exhausted, disabling for this run');
      } else {
        log.warn(`photos: gemini-image HTTP ${res.status}`);
      }
      return [];
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return [];
    }
    const parts = json?.candidates?.[0]?.content?.parts || [];
    const image = parts.find((p) => p.inlineData || p.inline_data);
    if (!image) return [];
    const data = image.inlineData || image.inline_data;
    const id = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return [
      {
        provider: 'gemini-image',
        id,
        key: `gemini:${id}`,
        inline: Buffer.from(data.data, 'base64'),
        mime: data.mimeType || data.mime_type || 'image/png',
        source: `gemini:${model}`,
        license: 'AI generated (Google Gemini)',
        credit: '',
      },
    ];
  }
}

function activeProviders() {
  const out = [];
  if (String(env.PEXELS_API_KEY || '').trim()) out.push({ name: 'pexels', search: searchPexels });
  out.push({ name: 'openverse', search: searchOpenverse });
  if (GeminiImageProvider.enabled) {
    out.push({ name: GeminiImageProvider.name, search: GeminiImageProvider.search });
  }
  return out;
}

// ------------------------------------------------------------ download

function extensionFor(url, mime) {
  const fromUrl = path.extname(String(url || '').split('?')[0]).toLowerCase();
  if (IMAGE_EXT.has(fromUrl)) return fromUrl;
  if (/png/i.test(mime || '')) return '.png';
  if (/webp/i.test(mime || '')) return '.webp';
  return '.jpg';
}

async function downloadCandidate(cand) {
  ensureDir(REMOTE_DIR);
  const file = path.join(REMOTE_DIR, `${slug(cand.key, 40)}${extensionFor(cand.url, cand.mime)}`);

  if (cand.inline) {
    fs.writeFileSync(file, cand.inline);
    return file;
  }

  const buf = await withRetry(
    async () => {
      const res = await fetch(cand.url, {
        headers: { 'User-Agent': 'InstaAutomater/1.0', Accept: 'image/*' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return Buffer.from(await res.arrayBuffer());
    },
    {
      attempts: 3,
      baseMs: 800,
      label: `photo ${cand.provider}`,
      isRetryable: (e) => !e.status || e.status === 429 || e.status >= 500,
    }
  );

  if (buf.length < 15_000) throw new Error(`too small (${buf.length} bytes)`);
  if (buf.length > MAX_BYTES) throw new Error(`too large (${(buf.length / 1048576).toFixed(1)} MB)`);
  fs.writeFileSync(file, buf);
  return file;
}

/** Reject images that would look bad after a 9:16 crop. */
async function acceptable(file) {
  let size;
  try {
    size = await probeSize(file);
  } catch {
    return false;
  }
  if (!size.width || !size.height) return false;
  if (Math.min(size.width, size.height) < MIN_SHORT_SIDE) return false;
  if (size.height / size.width < MIN_TALL_RATIO) return false;
  return true;
}

// ------------------------------------------------------------ ensurePhoto

/**
 * Produce a usable photo for one post, trying every provider before falling
 * back to the local pool. Always returns something or throws — it never returns
 * a path that does not exist.
 */
async function ensurePhoto({ mood = 'motivation', theme = '', queries = [], preferLocal = false } = {}) {
  if (preferLocal) {
    const local = pickPhoto(mood);
    if (local) return describeLocal(local);
  }

  const terms = shuffle((queries && queries.length ? queries : [`${mood} aesthetic`]).slice(0, 6)).slice(0, 2);
  const providers = activeProviders();
  const failures = [];

  for (const term of terms) {
    for (const provider of providers) {
      let candidates = [];
      try {
        candidates = await provider.search(term, { mood });
      } catch (e) {
        failures.push(`${provider.name}:"${term}" ${String(e.message).slice(0, 60)}`);
        continue;
      }
      for (const cand of candidates.slice(0, 8)) {
        if (store.isAssetUsed('remote_photo', cand.key)) continue;
        let file;
        try {
          file = await downloadCandidate(cand);
        } catch (e) {
          failures.push(`${provider.name} download ${String(e.message).slice(0, 60)}`);
          continue;
        }
        if (!(await acceptable(file))) {
          fs.rmSync(file, { force: true });
          failures.push(`${provider.name} rejected aspect/size`);
          continue;
        }
        store.markAsset('remote_photo', cand.key);
        log.ok(
          `photo: ${provider.name} "${term}" -> ${path.basename(file)} [${cand.license}]`
        );
        return { ...cand, path: file };
      }
      if (candidates.length) log.info(`photos: ${provider.name} "${term}" -> no unused candidate`);
      await sleep(400);
    }
  }

  if (failures.length) {
    log.warn(`photos: all remote providers failed (${failures.slice(0, 3).join(' | ')})`);
  }

  const local = pickPhoto(mood);
  if (local) {
    log.warn('photos: using local pool fallback');
    return describeLocal(local);
  }

  const anyLocal = walk(PHOTOS, IMAGE_EXT);
  if (anyLocal.length) {
    const chosen = store.pickAsset('photo', anyLocal);
    return describeLocal(chosen);
  }

  throw new Error(
    `no photo available for ${theme || mood}: every provider failed and assets/photos is empty`
  );
}

// ------------------------------------------------------------- music

/**
 * Kevin MacLeod / incompetech. CC BY 4.0 — attribution required, written into
 * assets/music/CREDITS.json and appended to every caption that uses a track.
 */
const MUSIC_CATALOG = {
  heartbreak: ['Heartbreaking', 'Sad Trio', 'Ossuary 6 - Air', 'Dreamy Flashback', 'Lost Frontier'],
  growth: ['Deliberate Thought', 'Inspired', 'Blue Feather', 'Static Motion', 'Meditation Impromptu 01'],
  motivation: ['Impact Prelude', 'Heroic Age', 'Five Armies', 'Clash Defiant', 'Volatile Reaction'],
};

const MUSIC_BASE = 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/';
const MUSIC_CREDIT = 'Music: Kevin MacLeod (incompetech.com) — CC BY 4.0';

async function fetchMusic({ force = false } = {}) {
  const creditsFile = path.join(MUSIC, 'CREDITS.json');
  let credits = {};
  try {
    credits = JSON.parse(fs.readFileSync(creditsFile, 'utf8'));
  } catch {
    /* first run */
  }

  let downloaded = 0;
  for (const [mood, names] of Object.entries(MUSIC_CATALOG)) {
    const dir = ensureDir(path.join(MUSIC, mood));
    for (const name of names) {
      const file = path.join(dir, `${slug(name, 40)}.mp3`);
      if (fs.existsSync(file) && fs.statSync(file).size > 200_000 && !force) continue;
      const url = MUSIC_BASE + encodeURIComponent(name) + '.mp3';
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 200_000) throw new Error(`too small (${buf.length} bytes)`);
        fs.writeFileSync(file, buf);
        credits[path.relative(ROOT, file).split(path.sep).join('/')] = {
          title: name,
          author: 'Kevin MacLeod',
          source: url,
          license: 'CC BY 4.0',
          credit: MUSIC_CREDIT,
        };
        downloaded++;
        log.ok(`music: ${mood}/${path.basename(file)} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
      } catch (e) {
        log.warn(`music: ${name} failed (${e.message.slice(0, 60)})`);
      }
    }
  }
  fs.writeFileSync(creditsFile, JSON.stringify(credits, null, 2), 'utf8');
  return downloaded;
}

// ------------------------------------------------------- bulk photo fetch

const PEXELS_QUERIES = {
  heartbreak: [
    'sad man rain window',
    'alone night city lights',
    'couple silhouette sunset',
    'woman looking away window',
    'rainy street night',
  ],
  growth: [
    'man running sunrise',
    'gym workout dark mood',
    'hiker mountain top',
    'working late night laptop',
    'empty road morning fog',
  ],
  motivation: [
    'man silhouette mountain',
    'boxer training dark',
    'stormy sea waves',
    'sunrise desert road',
    'man standing cliff edge',
  ],
};

const OPENVERSE_QUERIES = {
  heartbreak: ['rain window', 'sad', 'alone', 'night street', 'empty bench', 'sunset silhouette', 'fog', 'lonely'],
  growth: ['sunrise', 'running', 'mountain', 'road fog', 'desk night', 'staircase', 'city morning', 'forest path'],
  motivation: ['silhouette', 'storm', 'cliff', 'boxing', 'ocean wave', 'desert road', 'thundercloud', 'mountain top'],
};

async function fetchPhotosOpenverse({ mood, perQuery = 20 } = {}) {
  const moods = mood ? [mood] : Object.keys(OPENVERSE_QUERIES);
  const metaFile = path.join(PHOTOS, 'credits.json');
  let meta = readCredits();
  const seen = new Set();
  let saved = 0;

  for (const m of moods) {
    const dir = ensureDir(path.join(PHOTOS, m));
    for (const q of OPENVERSE_QUERIES[m] || []) {
      let results = [];
      try {
        results = (await searchOpenverse(q, { perPage: perQuery })).map((c) => ({
          ...c,
          id: c.id,
          width: 1000,
          height: 1500,
          title: q,
        }));
      } catch (e) {
        log.warn(`photos: openverse "${q}" failed (${e.message.slice(0, 50)})`);
        continue;
      }
      let got = 0;
      for (const r of results) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const file = path.join(dir, `ov-${r.id.slice(0, 12)}.jpg`);
        if (fs.existsSync(file) && fs.statSync(file).size > 20_000) continue;
        try {
          const buf = await downloadCandidate(r);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.copyFileSync(buf, file);
          meta[path.relative(ROOT, file).split(path.sep).join('/')] = {
            title: q,
            creator: r.credit,
            source: r.provider,
            license: r.license,
            page: r.source,
          };
          saved++;
          got++;
        } catch {
          /* skip broken links silently */
        }
      }
      log.info(`photos: ${m} "${q}" -> ${got}/${results.length} kept`);
      await sleep(1200);
    }
  }

  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');
  return saved;
}

async function fetchPhotos({ mood, perQuery = 12 } = {}) {
  if (!String(env.PEXELS_API_KEY || '').trim()) {
    log.warn('no PEXELS_API_KEY - falling back to Openverse (CC0, slower, smaller pool)');
    return fetchPhotosOpenverse({ mood, perQuery: 20 });
  }

  const moods = mood ? [mood] : Object.keys(PEXELS_QUERIES);
  const seen = new Set();
  let saved = 0;
  const metaFile = path.join(PHOTOS, 'credits.json');
  const meta = readCredits();

  for (const m of moods) {
    const dir = ensureDir(path.join(PHOTOS, m));
    for (const q of PEXELS_QUERIES[m] || []) {
      let results = [];
      try {
        results = await searchPexels(q, { perPage: perQuery });
      } catch (e) {
        log.warn(`photos: pexels "${q}" failed (${e.message.slice(0, 60)})`);
        continue;
      }
      for (const p of results) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        const file = path.join(dir, `pexels-${p.id}.jpg`);
        if (fs.existsSync(file) && fs.statSync(file).size > 30_000) continue;
        try {
          const tmp = await downloadCandidate(p);
          fs.copyFileSync(tmp, file);
          meta[path.relative(ROOT, file).split(path.sep).join('/')] = {
            id: p.id,
            photographer: p.credit,
            page: p.source,
            license: p.license,
          };
          saved++;
        } catch (e) {
          log.warn(`photos: ${p.id} download failed (${e.message.slice(0, 40)})`);
        }
      }
      log.info(`photos: ${m} "${q}" -> ${results.length} results`);
    }
  }
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');
  return saved;
}

// ------------------------------------------------------------------ summary

function libraryStatus() {
  const moods = ['heartbreak', 'growth', 'motivation'];
  const photos = Object.fromEntries(moods.map((m) => [m, walk(path.join(PHOTOS, m), IMAGE_EXT).length]));
  photos.anywhere = walk(PHOTOS, IMAGE_EXT).length;

  const music = Object.fromEntries(moods.map((m) => [m, walk(path.join(MUSIC, m), AUDIO_EXT).length]));
  music.anywhere = walk(MUSIC, AUDIO_EXT).length;

  return {
    photos,
    music,
    musicCredit: MUSIC_CREDIT,
    providers: activeProviders().map((p) => p.name),
  };
}

/** Remove temp photos older than `hours`; called at the end of every run. */
function cleanupTemp({ hours = 24 } = {}) {
  const cutoff = Date.now() - hours * 3_600_000;
  let removed = 0;
  for (const dir of [REMOTE_DIR, path.join(paths.tmp)]) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs >= cutoff) continue;
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

module.exports = {
  PHOTOS,
  MUSIC,
  MUSIC_CREDIT,
  MUSIC_CATALOG,
  fetchMusic,
  fetchPhotos,
  fetchPhotosOpenverse,
  pickPhoto,
  pickTrack,
  ensurePhoto,
  photoCount,
  trackCount,
  libraryStatus,
  cleanupTemp,
  walk,
  AUDIO_EXT,
  searchPexels,
  searchOpenverse,
  activeProviders,
};

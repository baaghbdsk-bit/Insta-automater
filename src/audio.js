'use strict';
/**
 * Instagram native audio (Meta Audio API, June 2026).
 *
 * The Reels publishing API can attach a licensed track from Instagram's own
 * catalogue to a container:
 *
 *   GET  /{version}/ig_audio?audio_type=music&user_id={ig-user}&search_query=...
 *        (omit search_query for the trending list)
 *   POST /{ig-user}/media  audio_configuration={"audio_id":...,"audio_volume":100}
 *
 * Why the ordering below matters: native audio always starts at 0, so unlike
 * the embedded bed there is no way to skip a quiet intro. Candidates are
 * therefore ranked by the loudness of their first seconds before rotation.
 *
 * Everything here is optional. When IG_NATIVE_AUDIO is not '1' the engine
 * renders and publishes exactly as before, with the local CC-BY bed.
 */
const fs = require('node:fs');
const path = require('node:path');
const { env, paths } = require('./config');
const { log, run, ensureDir, FFMPEG } = require('./util');
const store = require('./db');
const ig = require('./publish/instagram');
const picks = require('./music-picks');

// Search terms per mood. Rotated so the same keyword is not reused every post.
const MOOD_QUERIES = {
  heartbreak: ['sad', 'emotional', 'heartbreak', 'piano', 'alone'],
  growth: ['motivation', 'inspirational', 'lofi', 'emotional', 'focus'],
  motivation: ['motivation', 'epic', 'powerful', 'workout', 'triumphant'],
};

// Tracks that are obviously wrong for a quote page regardless of mood.
const GLOBAL_BLOCK =
  /\b(kid|kids|nursery|cartoon|comedy|funny|prank|meme|birthday|christmas|holiday|jingle|festive|halloween|horror|spooky|sound effect|sfx)\b/i;

// Vibe counter-signals: a "sad" search can still return a party track.
const MOOD_BLOCK = {
  heartbreak: /\b(happy|party|dance|dancing|workout|upbeat|celebration|bhangra|dhol|festival|good vibes|sunny|sunshine|joy|smile|uplifting)\b/i,
  growth: /\b(funeral|gore|scream|terror)\b/i,
  motivation: /\b(lullaby|funeral|dirge|sleep|meditation)\b/i,
};

const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map();

function num(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function enabled() {
  return String(env.IG_NATIVE_AUDIO || '0') === '1';
}

function minMs() {
  return num('IG_AUDIO_MIN_MS', 20_000);
}

function floorMs() {
  return num('IG_AUDIO_FLOOR_MS', 15_000);
}

function trendingShare() {
  // Trending is localised to the account's audience and often returns regional
  // tracks that do not fit English quotes. Mood search is the default; set
  // IG_AUDIO_TRENDING_SHARE=0.3 to mix it back in.
  return Math.min(1, Math.max(0, num('IG_AUDIO_TRENDING_SHARE', 0)));
}

function energyEnabled() {
  return num('IG_AUDIO_ENERGY', 1) !== 0;
}

/** Curated picks come first; set IG_AUDIO_CURATED=0 to go back to raw search. */
function curatedEnabled() {
  return num('IG_AUDIO_CURATED', 1) !== 0;
}

/** User-supplied tracks in assets/music/custom win over everything. */
function customEnabled() {
  return num('MUSIC_CUSTOM', 1) !== 0;
}

/**
 * `music` is the licensed stock catalogue (ad-music). `original_sound` is real
 * songs and edits already used on Reels, which is what actually fits quotes.
 */
function audioType() {
  const t = String(env.IG_AUDIO_TYPE || 'original_sound').trim();
  return t === 'music' ? 'music' : 'original_sound';
}

function energyCandidates() {
  return Math.max(1, Math.min(12, num('IG_AUDIO_ENERGY_CANDIDATES', 6)));
}

function queriesFor(mood) {
  return (MOOD_QUERIES[mood] || MOOD_QUERIES.motivation).slice();
}

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Filter the raw API list down to tracks that can carry a 9-15s reel.
 * `minMs` is relaxed to the floor on a second pass when a query is thin.
 */
function isUsable(track, mood = 'motivation', minimum = minMs()) {
  if (!track || !track.audio_id) return false;
  // The same file is muxed into the render for YouTube, so a track without a
  // downloadable preview cannot be used even though Instagram could play it.
  if (!track.download_url) return false;
  const ms = Number(track.duration_in_ms) || 0;
  if (ms < minimum) return false;
  const label = `${track.title || ''} ${track.display_artist || ''} ${track.ig_username || ''}`;
  if (GLOBAL_BLOCK.test(label)) return false;
  const block = MOOD_BLOCK[mood];
  if (block && block.test(label)) return false;
  return true;
}

/** One search call. Returns raw audio objects, cached briefly per query. */
async function searchAudio(query, { account = 0 } = {}) {
  const key = `${account}:${query || '*'}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.items;

  const params = { audio_type: audioType(), user_id: ig.igUser(account) };
  if (query) params.search_query = query;

  const r = await ig.request('GET', 'ig_audio', params, { account, attempts: 2 });
  const items = Array.isArray(r.audio) ? r.audio : [];
  cache.set(key, { at: Date.now(), items });
  return items;
}

/**
 * Mean RMS level (dB) of the first seconds of a preview. Louder intro = the
 * track announces itself instead of fading in. Returns null when the preview
 * cannot be measured (no URL, ffmpeg missing, network block).
 */
async function introEnergy(url) {
  if (!url) return null;
  try {
    const { stderr } = await run(
      FFMPEG,
      [
        '-hide_banner',
        '-nostats',
        '-t', String(num('IG_AUDIO_ENERGY_SECONDS', 12)),
        '-i', url,
        '-af', 'astats=metadata=1:reset=0',
        '-f', 'null', '-',
      ],
      { timeout: 25_000 }
    );
    const matches = [...String(stderr).matchAll(/RMS level dB:\s*(-?\d+(?:\.\d+)?)/g)];
    if (!matches.length) return null;
    const level = Number(matches[matches.length - 1][1]);
    return Number.isFinite(level) ? level : null;
  } catch {
    return null;
  }
}

/** Rank the top candidates by intro energy; unknown levels sort last. */
async function rankCandidates(list) {
  if (!energyEnabled() || !list.length) return list.slice();

  const head = list.slice(0, energyCandidates());
  const scored = [];
  for (const track of head) {
    const level = await introEnergy(track.download_url);
    scored.push({ track, level });
  }
  scored.sort((a, b) => {
    const av = a.level === null ? -Infinity : a.level;
    const bv = b.level === null ? -Infinity : b.level;
    return bv - av;
  });

  return [...scored.map((s) => ({ ...s.track, _energy: s.level })), ...list.slice(head.length)];
}

/** Fresh metadata (and a fresh download link) for one catalogue id. */
async function trackMeta(audioId, account = 0) {
  const r = await ig.request(
    'GET',
    String(audioId),
    { user_id: ig.igUser(account) },
    { account, attempts: 2 }
  );
  return r && r.audio_id ? r : null;
}

/**
 * Curated pool first: hand-picked tracks, least-recently-used rotation. Only
 * one metadata call is needed per pick because the loop stops at the first
 * candidate that still resolves.
 */
async function pickCurated({ mood = 'motivation', theme = '', account = 0 } = {}) {
  const pool = picks.forMood(mood);
  if (!pool.length) return null;

  const used = new Map(store.assetUsage('audio').map((r) => [String(r.key), String(r.used_at || '')]));
  const fresh = shuffle(pool.filter((p) => !used.has(p.id)));
  const old = pool
    .filter((p) => used.has(p.id))
    .sort((a, b) => String(used.get(a.id) || '').localeCompare(String(used.get(b.id) || '')));

  for (const p of [...fresh, ...old]) {
    let meta;
    try {
      meta = await trackMeta(p.id, account);
    } catch {
      continue;
    }
    if (!isUsable(meta, mood)) continue;

    store.markAsset('audio', String(meta.audio_id));
    return {
      audioId: String(meta.audio_id),
      title: meta.title || p.title,
      artist: meta.display_artist || meta.ig_username || p.artist,
      audioType: p.type || audioType(),
      durationMs: Number(meta.duration_in_ms) || 0,
      downloadUrl: meta.download_url || '',
      energy: null,
      query: null,
      trending: false,
      curated: true,
      mood,
      theme,
    };
  }
  return null;
}

const CUSTOM_AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|flac)$/i;

/** Folders checked for user-supplied music, mood folder first. */
function customFolders(mood) {
  return [path.join(paths.music, 'custom', mood), path.join(paths.music, 'custom')];
}

function listCustom(mood) {
  for (const dir of customFolders(mood)) {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && CUSTOM_AUDIO_EXT.test(e.name))
        .map((e) => path.join(dir, e.name))
        .sort();
    } catch {
      continue;
    }
    if (names.length) return names;
  }
  return [];
}

/**
 * A track the user dropped into assets/music/custom. These are used exactly as
 * supplied (no download, no native attach) and rotated like the local library.
 */
function pickCustom(mood) {
  if (!customEnabled()) return null;
  const pool = listCustom(mood);
  if (!pool.length) return null;
  const chosen = store.pickAsset('music', pool);
  if (chosen) store.markAsset('music', chosen);
  return chosen;
}

/**
 * Pick one track for a mood. Order:
 *   1. curated picks rotated least-recently-used (IG_AUDIO_CURATED=1)
 *   2. rotated mood queries (70%) or the trending list first (30%)
 *   3. duration + vibe filter
 *   4. intro-energy ranking
 *   5. least-recently-used rotation on audio_id
 *
 * Throws when nothing usable is returned; callers fall back to the embedded bed.
 */
async function pickAudio({ mood = 'motivation', theme = '', account = 0 } = {}) {
  const failures = [];

  if (curatedEnabled()) {
    const curated = await pickCurated({ mood, theme, account });
    if (curated) return curated;
    failures.push('curated: no usable track');
  }

  const queries = shuffle(queriesFor(mood));
  if (Math.random() < trendingShare()) queries.unshift(null);

  const used = new Map(store.assetUsage('audio').map((r) => [String(r.key), String(r.used_at || '')]));

  for (const query of queries) {
    const label = query || 'trending';
    let items;
    try {
      items = await searchAudio(query, { account });
    } catch (e) {
      failures.push(`${label}: ${String(e.message || e).slice(0, 80)}`);
      continue;
    }

    let usable = items.filter((t) => isUsable(t, mood, minMs()));
    if (!usable.length) usable = items.filter((t) => isUsable(t, mood, floorMs()));
    if (!usable.length) {
      failures.push(`${label}: 0 usable of ${items.length}`);
      continue;
    }

    const ranked = await rankCandidates(usable);
    const fresh = ranked.filter((t) => !used.has(String(t.audio_id)));
    const chosen =
      fresh[0] ||
      ranked
        .slice()
        .sort((a, b) =>
          String(used.get(String(a.audio_id)) || '').localeCompare(
            String(used.get(String(b.audio_id)) || '')
          )
        )[0];

    if (!chosen) {
      failures.push(`${label}: no candidate`);
      continue;
    }

    store.markAsset('audio', String(chosen.audio_id));
    return {
      audioId: String(chosen.audio_id),
      title: chosen.title || '',
      artist: chosen.display_artist || chosen.ig_username || '',
      audioType: audioType(),
      durationMs: Number(chosen.duration_in_ms) || 0,
      downloadUrl: chosen.download_url || '',
      energy: Number.isFinite(chosen._energy) ? chosen._energy : null,
      query: query || null,
      trending: !query,
      mood,
      theme,
    };
  }

  throw new Error(`no native audio found (${failures.join('; ') || 'no queries'})`);
}

/**
 * Download the preview Meta exposes for a chosen track. The same audio file is
 * muxed into the render so YouTube (which cannot attach catalogue audio) plays
 * the exact same song. The preview is the full track at ~48 kbps AAC, which is
 * fine for a 9-15s bed under a quote.
 */
async function downloadTrack(audio, { force = false } = {}) {
  if (!audio || !audio.audioId) throw new Error('no audio id');
  if (!audio.downloadUrl) throw new Error('audio has no download_url');

  const dir = ensureDir(path.join(paths.tmp, 'audio'));
  const file = path.join(dir, `${audio.audioId}.mp4`);
  if (!force && fs.existsSync(file) && fs.statSync(file).size > 32 * 1024) return file;

  const res = await fetch(audio.downloadUrl, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`audio download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 32 * 1024) throw new Error(`audio download too small (${buf.length} bytes)`);

  fs.writeFileSync(file, buf);
  log.info(`audio: cached ${path.basename(file)} (${(buf.length / 1048576).toFixed(1)} MB)`);
  return file;
}

/** `audio_configuration` payload for the media container, or null. */
function payload(audio) {
  if (!audio || !audio.audioId) return null;
  const out = {
    audio_id: String(audio.audioId),
    audio_volume: Math.min(100, Math.max(0, num('IG_AUDIO_VOLUME', 100))),
  };
  // 1 silences the embedded bed so only Instagram's track is heard. Meta
  // documents video_volume as 1-100; 0 made the API accept the container but
  // publish it as "Original audio" instead of the licensed track.
  const videoVolume = num('IG_NATIVE_AUDIO_VIDEO_VOLUME', 1);
  out.video_volume = Math.min(100, Math.max(0, videoVolume));
  return out;
}

function describe(audio) {
  if (!audio) return 'embedded music';
  const who = audio.artist ? ` — ${audio.artist}` : '';
  const src = audio.curated ? 'curated' : audio.trending ? 'trending' : `"${audio.query}"`;
  return `${audio.title}${who} (${src})`;
}

function status() {
  return {
    enabled: enabled(),
    curated: curatedEnabled(),
    custom: customEnabled(),
    trendingShare: trendingShare(),
    minMs: minMs(),
    energy: energyEnabled(),
    queries: MOOD_QUERIES,
  };
}

module.exports = {
  MOOD_QUERIES,
  enabled,
  curatedEnabled,
  customEnabled,
  queriesFor,
  isUsable,
  searchAudio,
  trackMeta,
  pickCurated,
  pickCustom,
  listCustom,
  pickAudio,
  downloadTrack,
  payload,
  describe,
  status,
};

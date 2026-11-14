'use strict';
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ensureDir, log } = require('./util');
const { paths } = require('./config');

ensureDir(paths.data);
const db = new DatabaseSync(path.join(paths.data, 'engine.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 15000;

CREATE TABLE IF NOT EXISTS seen (
  key TEXT PRIMARY KEY,
  title TEXT,
  link TEXT,
  seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  topic_key TEXT,
  title TEXT,
  source_url TEXT,
  script_json TEXT,
  video_path TEXT,
  caption_text TEXT,
  status TEXT NOT NULL,
  ig_id TEXT,
  fb_id TEXT,
  yt_id TEXT,
  error TEXT,
  bg_path TEXT
);

CREATE TABLE IF NOT EXISTS used_backgrounds (
  path TEXT PRIMARY KEY,
  used_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS used_assets (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  used_at TEXT NOT NULL,
  PRIMARY KEY (kind, key)
);

CREATE TABLE IF NOT EXISTS generated_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  theme TEXT NOT NULL,
  line TEXT NOT NULL,
  norm TEXT NOT NULL UNIQUE,
  caption TEXT,
  hashtags TEXT,
  engine TEXT,
  created_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS insights (
  media_id TEXT PRIMARY KEY,
  post_id INTEGER,
  reach INTEGER,
  views INTEGER,
  saves INTEGER,
  shares INTEGER,
  likes INTEGER,
  comments INTEGER,
  avg_watch_ms INTEGER,
  collected_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  slot TEXT,
  status TEXT NOT NULL,
  post_id INTEGER,
  error TEXT
);
`);

// ---- schema migrations -----------------------------------------------------
function ensureColumn(table, name, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    log.info(`db: added ${table}.${name}`);
  }
}
ensureColumn('posts', 'theme', 'TEXT');
ensureColumn('posts', 'variant', 'TEXT');
ensureColumn('posts', 'music_path', 'TEXT');
ensureColumn('posts', 'published_at', 'TEXT');
ensureColumn('posts', 'permalink', 'TEXT');
ensureColumn('posts', 'creation_id', 'TEXT');
ensureColumn('posts', 'ig_id_2', 'TEXT');
ensureColumn('posts', 'permalink_2', 'TEXT');
ensureColumn('posts', 'creation_id_2', 'TEXT');
ensureColumn('posts', 'ig_id_3', 'TEXT');
ensureColumn('posts', 'permalink_3', 'TEXT');
ensureColumn('posts', 'creation_id_3', 'TEXT');

// ---- state -----------------------------------------------------------------
function getState(key, fallback = null) {
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setState(key, value) {
  db.prepare(
    'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

function hasSeen(key) {
  return !!db.prepare('SELECT 1 FROM seen WHERE key = ?').get(key);
}

function markSeen(key, title = '', link = '') {
  db.prepare(
    'INSERT INTO seen (key, title, link, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING'
  ).run(key, title, link, new Date().toISOString());
}

// ---- posts -----------------------------------------------------------------
function insertPost(p) {
  const stmt = db.prepare(`
    INSERT INTO posts (created_at, topic_key, title, source_url, script_json, video_path,
                       caption_text, status, error, bg_path, theme, variant, music_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    p.createdAt || new Date().toISOString(),
    p.topicKey || null,
    p.title || null,
    p.sourceUrl || null,
    p.scriptJson ? JSON.stringify(p.scriptJson) : null,
    p.videoPath || null,
    p.captionText || null,
    p.status || 'built',
    p.error || null,
    p.bgPath || null,
    p.theme || null,
    p.variant || null,
    p.musicPath || null
  );
  return Number(info.lastInsertRowid);
}

function updatePost(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const set = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE posts SET ${set} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
}

/** Start of the current local day (TZ is set to Asia/Kolkata in CI). */
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function countPublishedToday() {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM posts WHERE status = 'published' AND COALESCE(published_at, created_at) >= ?`
    )
    .get(startOfToday());
  return row ? Number(row.n) : 0;
}

function lastPublishedAt() {
  const row = db
    .prepare(
      `SELECT COALESCE(published_at, created_at) AS t FROM posts
        WHERE status = 'published' ORDER BY COALESCE(published_at, created_at) DESC LIMIT 1`
    )
    .get();
  return row ? row.t : null;
}

/** Rows stuck in 'publishing' mean a previous run died mid-publish. */
function stalePublishing(olderThanMinutes = 0) {
  if (!olderThanMinutes) {
    return db.prepare(`SELECT * FROM posts WHERE status IN ('publishing', 'partial')`).all();
  }
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  return db
    .prepare(`SELECT * FROM posts WHERE status IN ('publishing', 'partial') AND created_at < ?`)
    .all(cutoff);
}

function recentPosts(limit = 10) {
  return db.prepare('SELECT * FROM posts ORDER BY id DESC LIMIT ?').all(limit);
}

function publishedPosts(limit = 30) {
  return db
    .prepare(`SELECT * FROM posts WHERE status = 'published' ORDER BY id DESC LIMIT ?`)
    .all(limit);
}

// ---- assets ----------------------------------------------------------------
/**
 * Least-recently-used pick from a candidate list. A key is never repeated
 * until the whole pool has been used once.
 */
function pickAsset(kind, candidates) {
  if (!candidates || !candidates.length) return null;
  const used = new Map(
    db
      .prepare('SELECT key, used_at FROM used_assets WHERE kind = ?')
      .all(kind)
      .map((r) => [r.key, r.used_at])
  );
  const fresh = candidates.filter((c) => !used.has(c));
  if (fresh.length) return fresh[0];
  return candidates
    .slice()
    .sort((a, b) => String(used.get(a) || '').localeCompare(String(used.get(b) || '')))[0];
}

function markAsset(kind, key) {
  db.prepare(
    'INSERT INTO used_assets (kind, key, used_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(kind, key) DO UPDATE SET used_at = excluded.used_at'
  ).run(kind, String(key), new Date().toISOString());
}

function usedAssetCount(kind) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM used_assets WHERE kind = ?').get(kind);
  return row ? Number(row.n) : 0;
}

function isAssetUsed(kind, key) {
  return !!db.prepare('SELECT 1 FROM used_assets WHERE kind = ? AND key = ?').get(kind, String(key));
}

function assetUsage(kind) {
  return db.prepare('SELECT key, used_at FROM used_assets WHERE kind = ?').all(kind);
}

// ---- generated lines -------------------------------------------------------
function lineExists(norm) {
  return !!db.prepare('SELECT 1 FROM generated_lines WHERE norm = ?').get(norm);
}

function insertLine({ theme, line, norm, caption = '', hashtags = '', engine = '' }) {
  const info = db
    .prepare(
      `INSERT INTO generated_lines (theme, line, norm, caption, hashtags, engine, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(norm) DO NOTHING`
    )
    .run(theme, line, norm, caption, hashtags, engine, new Date().toISOString());
  return Number(info.changes) > 0;
}

function markLineUsed(norm) {
  db.prepare('UPDATE generated_lines SET used_at = ? WHERE norm = ? AND used_at IS NULL').run(
    new Date().toISOString(),
    norm
  );
  markAsset('line', `gen::${norm}`);
}

function recentLines(limit = 40) {
  return db
    .prepare(`SELECT line FROM generated_lines ORDER BY id DESC LIMIT ?`)
    .all(limit)
    .map((r) => r.line);
}

function availableGenerated(theme) {
  return db
    .prepare(`SELECT * FROM generated_lines WHERE theme = ? AND used_at IS NULL ORDER BY id ASC`)
    .all(theme);
}

function lineCount() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM generated_lines').get();
  return row ? Number(row.n) : 0;
}

// ---- insights --------------------------------------------------------------
function upsertInsight(row) {
  db.prepare(
    `INSERT INTO insights (media_id, post_id, reach, views, saves, shares, likes, comments,
                           avg_watch_ms, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(media_id) DO UPDATE SET
       reach = excluded.reach, views = excluded.views, saves = excluded.saves,
       shares = excluded.shares, likes = excluded.likes, comments = excluded.comments,
       avg_watch_ms = excluded.avg_watch_ms, collected_at = excluded.collected_at`
  ).run(
    row.mediaId,
    row.postId ?? null,
    row.reach ?? null,
    row.views ?? null,
    row.saves ?? null,
    row.shares ?? null,
    row.likes ?? null,
    row.comments ?? null,
    row.avgWatchMs ?? null,
    new Date().toISOString()
  );
}

function insightFor(mediaId) {
  return db.prepare('SELECT * FROM insights WHERE media_id = ?').get(mediaId) || null;
}

/** Reach per theme, used to weight future theme selection. */
function themePerformance() {
  const rows = db
    .prepare(
      `SELECT p.theme AS theme, i.reach AS reach, i.saves AS saves, i.shares AS shares
         FROM posts p JOIN insights i ON i.post_id = p.id
        WHERE p.status = 'published' AND p.theme IS NOT NULL AND i.reach > 0`
    )
    .all();
  const byTheme = new Map();
  for (const r of rows) {
    if (!byTheme.has(r.theme)) byTheme.set(r.theme, []);
    byTheme.get(r.theme).push(r.reach);
  }
  const out = {};
  for (const [theme, values] of byTheme) {
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    out[theme] = {
      n: values.length,
      medianReach: values.length % 2 ? values[mid] : Math.round((values[mid - 1] + values[mid]) / 2),
    };
  }
  return out;
}

// ---- runs ------------------------------------------------------------------
function startRun(slot) {
  const info = db
    .prepare('INSERT INTO runs (started_at, slot, status) VALUES (?, ?, ?)')
    .run(new Date().toISOString(), slot || '', 'running');
  return Number(info.lastInsertRowid);
}

function finishRun(id, { status, postId = null, error = '' }) {
  db.prepare(
    'UPDATE runs SET finished_at = ?, status = ?, post_id = ?, error = ? WHERE id = ?'
  ).run(new Date().toISOString(), status, postId, error ? String(error).slice(0, 900) : null, id);
}

// ---- maintenance -----------------------------------------------------------
/** Flush the WAL so the main .db file is self-contained (needed for git commits). */
function checkpoint() {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return true;
  } catch (e) {
    log.warn(`db: checkpoint failed (${e.message.slice(0, 60)})`);
    return false;
  }
}

module.exports = {
  db,
  getState,
  setState,
  hasSeen,
  markSeen,
  insertPost,
  updatePost,
  countPublishedToday,
  lastPublishedAt,
  stalePublishing,
  recentPosts,
  publishedPosts,
  pickAsset,
  markAsset,
  usedAssetCount,
  isAssetUsed,
  assetUsage,
  lineExists,
  insertLine,
  markLineUsed,
  recentLines,
  availableGenerated,
  lineCount,
  upsertInsight,
  insightFor,
  themePerformance,
  startRun,
  finishRun,
  checkpoint,
  startOfToday,
};

'use strict';
/**
 * Curated quote bank.
 *
 * The bank is the source of truth for published lines: a plain JSON file in
 * assets/quotes, committed to git, so every line is reviewed and diffable.
 * The database only remembers when a line was last used (assets/used_assets),
 * which keeps rotation across GitHub Actions runs.
 *
 * Only entries with status "approved" are served. "held" lines are kept for
 * review and can be promoted by changing one field in the JSON file.
 */

const fs = require('node:fs');
const path = require('node:path');
const { paths, env } = require('./config');
const store = require('./db');
const { MUSIC_MOODS } = require('./themes');

const BANK_FILE = path.join(paths.root, 'assets', 'quotes', 'bank.json');
const USED_KIND = 'bank_quote';
const STRUCTURE_KIND = 'bank_structure';
const STRUCTURES = new Set(['reversal', 'observation', 'insight', 'visual', 'minimal']);
const STATUSES = new Set(['approved', 'held', 'retired']);

function cooldownDays() {
  const n = Number(env.LINE_COOLDOWN_DAYS);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

function load() {
  const raw = JSON.parse(fs.readFileSync(BANK_FILE, 'utf8'));
  if (!raw || !Array.isArray(raw.lines)) throw new Error('quote bank: missing lines array');
  return raw;
}

/** Return human-readable problems; empty array means the bank is healthy. */
function problems() {
  const out = [];
  let raw;
  try {
    raw = load();
  } catch (e) {
    return [String(e.message)];
  }
  const ids = new Map();
  const norms = new Map();
  for (const e of raw.lines) {
    const tag = e.id || '(no id)';
    if (!e.id || ids.has(e.id)) out.push(`${tag}: missing/duplicate id`);
    ids.set(e.id, true);

    const text = String(e.line || '');
    if (text.length < 18 || text.length > 160) out.push(`${tag}: ${text.length} chars (want 18-160)`);
    const norm = text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    if (norms.has(norm)) out.push(`${tag}: duplicate of ${norms.get(norm)}`);
    norms.set(norm, tag);

    if (!MUSIC_MOODS.includes(e.mood)) out.push(`${tag}: unknown mood ${e.mood}`);
    if (!STRUCTURES.has(e.structure)) out.push(`${tag}: unknown structure ${e.structure}`);
    if (!STATUSES.has(e.status)) out.push(`${tag}: unknown status ${e.status}`);
    if (!Number.isInteger(e.score) || e.score < 1 || e.score > 10) out.push(`${tag}: bad score`);
    if (!Array.isArray(e.flags)) out.push(`${tag}: flags must be an array`);
  }
  return out;
}

function approved(mood) {
  return load().lines.filter((e) => e.status === 'approved' && (!mood || e.mood === mood));
}

function lastUsed(kind) {
  const rows = store.assetUsage(kind).slice().sort((a, b) => String(b.used_at).localeCompare(String(a.used_at)));
  return rows.length ? rows[0].key : null;
}

/**
 * Least-recently-used pick inside the chosen theme's mood.
 * - a line cannot repeat until the cooldown has passed (default 60 days)
 * - never-used lines go first, and a line matching the chosen theme wins ties
 * - two consecutive posts never share a sentence structure
 */
function pick(theme, mood) {
  let pool = approved(mood);
  if (!pool.length) return null;

  const usage = new Map(store.assetUsage(USED_KIND).map((r) => [r.key, r.used_at]));
  const cutoff = Date.now() - cooldownDays() * 86_400_000;
  const cooled = pool.filter((e) => {
    const at = usage.get(e.id);
    return !at || Date.parse(at) <= cutoff;
  });
  if (cooled.length) pool = cooled; // when everything is on cooldown, recycle the oldest

  const lastStructure = lastUsed(STRUCTURE_KIND);
  const freshStructure = pool.filter((e) => e.structure !== lastStructure);
  if (freshStructure.length) pool = freshStructure;

  const fresh = pool.filter((e) => !usage.has(e.id));
  if (fresh.length) {
    const themed = fresh.filter((e) => e.theme === theme);
    const list = themed.length ? themed : fresh;
    return list[Math.floor(Math.random() * list.length)];
  }

  pool.sort((a, b) => String(usage.get(a.id)).localeCompare(String(usage.get(b.id))));
  return pool[0];
}

function markUsed(entry) {
  store.markAsset(USED_KIND, entry.id);
  store.markAsset(STRUCTURE_KIND, entry.structure);
}

function report() {
  const all = load().lines;
  const usage = new Map(store.assetUsage(USED_KIND).map((r) => [r.key, r.used_at]));
  const byStatus = {};
  const byMood = {};
  for (const e of all) {
    byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    if (e.status === 'approved') byMood[e.mood] = (byMood[e.mood] || 0) + 1;
  }
  return {
    total: all.length,
    byStatus,
    byMood,
    used: all.filter((e) => usage.has(e.id)).length,
    cooldownDays: cooldownDays(),
    problems: problems(),
    held: all
      .filter((e) => e.status === 'held')
      .map((e) => `${e.id} [${e.score}] ${e.flags.join(',') || 'low score'} ${e.line.slice(0, 62)}`),
  };
}

module.exports = { load, problems, approved, pick, markUsed, report, BANK_FILE, cooldownDays };

'use strict';
/**
 * Curated quote bank.
 *
 * The bank is the source of truth for published lines: a plain JSON file in
 * assets/quotes, committed to git, so every line is reviewed and diffable.
 * The database only remembers which line was used last, so the picker can
 * avoid serving the same line twice in a row across GitHub Actions runs.
 *
 * Selection walks the approved lines of the chosen mood one by one, in file
 * order. A line is used once before the picker moves to the next; the whole
 * pool is exhausted before anything repeats. No rating filter or cooldown.
 */

const fs = require('node:fs');
const path = require('node:path');
const { paths } = require('./config');
const store = require('./db');
const { MUSIC_MOODS } = require('./themes');

const BANK_FILE = path.join(paths.root, 'assets', 'quotes', 'bank.json');
const USED_KIND = 'bank_quote';
const seqKind = (mood) => `bank_seq_${mood}`;
const STRUCTURES = new Set(['reversal', 'observation', 'insight', 'visual', 'minimal']);
const STATUSES = new Set(['approved', 'held', 'retired']);

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
    if (text.length < 18 || text.length > 220) out.push(`${tag}: ${text.length} chars (want 18-220)`);
    const norm = text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    if (norms.has(norm)) out.push(`${tag}: duplicate of ${norms.get(norm)}`);
    norms.set(norm, tag);

    if (!MUSIC_MOODS.includes(e.mood)) out.push(`${tag}: unknown mood ${e.mood}`);
    if (!STRUCTURES.has(e.structure)) out.push(`${tag}: unknown structure ${e.structure}`);
    if (!STATUSES.has(e.status)) out.push(`${tag}: unknown status ${e.status}`);
    if (e.score !== null && e.score !== undefined && (!Number.isInteger(e.score) || e.score < 1 || e.score > 10)) {
      out.push(`${tag}: bad score`);
    }
    if (!Array.isArray(e.flags)) out.push(`${tag}: flags must be an array`);
  }
  return out;
}

function approved(mood) {
  return load().lines.filter((e) => e.status === 'approved' && (!mood || e.mood === mood));
}

/**
 * Next approved line in file order for this mood, tracked in used_assets.
 * pickAsset returns the first never-used line, then the least recently used
 * once the pool has been exhausted - so nothing repeats until every line in
 * the mood has been published once.
 * `theme` is accepted for API compatibility but does not bias the pick.
 */
function pick(theme, mood) {
  const pool = approved(mood);
  if (!pool.length) return null;
  const id = store.pickAsset(seqKind(mood), pool.map((e) => e.id));
  return pool.find((e) => e.id === id) || null;
}

function markUsed(entry) {
  store.markAsset(USED_KIND, entry.id);
  store.markAsset(seqKind(entry.mood), entry.id);
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
    selection: 'sequential',
    problems: problems(),
    held: all
      .filter((e) => e.status === 'held')
      .map((e) => {
        const why = e.flags.join(',') || (e.score != null && e.score <= 4 ? 'low score' : 'held');
        return `${e.id} [${e.score}] ${why} ${e.line.slice(0, 62)}`;
      }),
  };
}

module.exports = { load, problems, approved, pick, markUsed, report, BANK_FILE };

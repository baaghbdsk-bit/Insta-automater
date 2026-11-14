'use strict';
/**
 * Insights collection. Runs once per scheduled execution (cheap: a handful of
 * Graph reads) and feeds theme weighting in src/run.js.
 */
const { log } = require('./util');
const store = require('./db');
const ig = require('./publish/instagram');

/**
 * Refresh insights for the most recent published posts.
 * Posts are re-read at most every `minAgeHours`, so a 4x/day schedule does not
 * hammer the API for numbers that barely move.
 */
async function collectRecent({ limit = 12, minAgeHours = 6 } = {}) {
  const posts = store.publishedPosts(40);
  const accounts = ig.configuredAccounts();

  // Build list of {mediaId, postId, account} for all configured accounts
  const targets = [];
  for (const p of posts) {
    for (const acct of accounts) {
      const suffix = acct === 0 ? '' : `_${acct + 1}`;
      const igId = acct === 0 ? p.ig_id : p[`ig_id${suffix}`];
      if (igId) targets.push({ mediaId: igId, postId: p.id, account: acct });
    }
  }
  const sliced = targets.slice(0, limit * accounts.length);

  let updated = 0;
  for (const t of sliced) {
    const existing = store.insightFor(t.mediaId);
    if (existing) {
      const age = (Date.now() - new Date(existing.collected_at).getTime()) / 3_600_000;
      if (age < minAgeHours) continue;
    }
    try {
      const m = await ig.fetchInsights(t.mediaId, t.account);
      store.upsertInsight({
        mediaId: t.mediaId,
        postId: t.postId,
        reach: m.reach,
        views: m.views,
        saves: m.saves,
        shares: m.shares,
        likes: m.likes,
        comments: m.comments,
        avgWatchMs: m.avgWatchMs,
      });
      updated++;
      log.info(
        `insights: ${t.mediaId} (acct ${t.account}) reach=${m.reach ?? '-'} views=${m.views ?? '-'} saves=${m.saves ?? '-'}`
      );
    } catch (e) {
      log.warn(`insights: ${t.mediaId} failed (${String(e.message).slice(0, 140)})`);
    }
  }
  return { checked: sliced.length, updated };
}

/** Aggregated view used outside the engine (CLI `insights` command, reports). */
function report() {
  const rows = store.db
    .prepare(
      `SELECT p.id, p.theme, p.published_at, p.ig_id, p.permalink, p.title,
              i.reach, i.views, i.saves, i.shares, i.likes, i.comments, i.avg_watch_ms
         FROM posts p LEFT JOIN insights i ON i.post_id = p.id
        WHERE p.status = 'published'
        ORDER BY p.id DESC`
    )
    .all();

  const byTheme = store.themePerformance();
  const withReach = rows.filter((r) => r.reach > 0);
  const median = (arr) => {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  };

  return {
    posts: rows,
    byTheme,
    overall: {
      published: rows.length,
      measured: withReach.length,
      medianReach: median(withReach.map((r) => r.reach)),
      medianSaves: median(withReach.map((r) => r.saves || 0)),
      medianShares: median(withReach.map((r) => r.shares || 0)),
    },
  };
}

module.exports = { collectRecent, report };

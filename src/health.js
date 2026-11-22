'use strict';
/**
 * Cross-platform publish health check.
 *
 * Verifies the two things that can silently break the engine:
 *   1. credentials — Instagram data-access expiry, YT OAuth refresh token
 *   2. coverage — the latest published post reached both configured platforms
 *
 * Exits 1 and emits an annotation/webhook when anything is wrong, so it is
 * safe to run as a workflow step (with continue-on-error) or from cron.
 */
const { log } = require('./util');
const { env } = require('./config');
const store = require('./db');
const ig = require('./publish/instagram');
const yt = require('./publish/youtube');
const fb = require('./publish/facebook');
const notify = require('./notify');

function daysLeft(seconds) {
  return Math.floor((seconds * 1000 - Date.now()) / 86_400_000);
}

async function check() {
  const problems = [];

  // ---- Instagram credentials -------------------------------------------------
  const accounts = ig.configuredAccounts();
  if (!accounts.length) {
    problems.push('instagram: no accounts configured');
  } else {
    for (const acct of accounts) {
      try {
        const me = await ig.preflight(acct);
        log.ok(`instagram ${acct}: authenticated as @${me.username || me.id}`);
      } catch (e) {
        problems.push(`instagram account ${acct}: ${String(e.message).slice(0, 200)}`);
      }
    }
  }

  try {
    if (env.FB_APP_ID && env.FB_APP_SECRET) {
      const d = await ig.debugToken();
      const deadline = d && (d.expires_at > 0 ? d.expires_at : d.data_access_expires_at);
      if (deadline) {
        const days = daysLeft(deadline);
        if (days <= 0) {
          problems.push(`instagram: data access expired on ${new Date(deadline * 1000).toISOString()}`);
        } else if (days <= 21) {
          log.warn(`instagram: data access expires in ${days} day(s) - re-authorize now`);
        } else {
          log.ok(`instagram: data access valid for ${days} day(s)`);
        }
      }
    }
  } catch (e) {
    problems.push(`instagram token check: ${String(e.message).slice(0, 200)}`);
  }

  // ---- YouTube credentials ---------------------------------------------------
  const ytOn = yt.isConfigured();
  if (ytOn) {
    try {
      await yt.accessToken();
      log.ok('youtube: OAuth refresh OK');
    } catch (e) {
      problems.push(`youtube: ${String(e.message).slice(0, 200)}`);
    }
  } else {
    log.warn('youtube: not configured (skipping coverage check)');
  }

  // ---- Facebook cross-post credentials --------------------------------------
  const fbOn = fb.enabled() && fb.isConfigured();
  if (fbOn) {
    try {
      const u = new URL('https://graph.facebook.com/debug_token');
      u.searchParams.set('input_token', env.FB_PAGE_TOKEN);
      u.searchParams.set('access_token', `${env.FB_APP_ID}|${env.FB_APP_SECRET}`);
      const r = await fetch(u, { signal: AbortSignal.timeout(30_000) });
      const j = await r.json().catch(() => ({}));
      const scopes = (j.data && j.data.scopes) || [];
      if (!scopes.includes('pages_manage_posts')) {
        problems.push('facebook: Page token lacks pages_manage_posts - Page Reel cross-post will fail');
      } else {
        log.ok('facebook: Page token has pages_manage_posts');
      }
    } catch (e) {
      problems.push(`facebook token check: ${String(e.message).slice(0, 200)}`);
    }
  }

  // ---- Coverage of the most recent publish ----------------------------------
  // Posts made before cross-posting was deployed are not failures. The marker
  // is set once when the feature goes live; only newer posts are checked.
  const since = store.getState('crossPostSince', '1970-01-01T00:00:00Z');
  const last = store.db
    .prepare("SELECT id, status, ig_id, yt_id, yt_error, fb_id, fb_error, published_at FROM posts WHERE status IN ('published','partial') AND created_at >= ? ORDER BY id DESC LIMIT 1")
    .get(since);
  if (last) {
    log.info(`last publish: post #${last.id} (${last.published_at || 'no timestamp'})`);
    if (!last.ig_id) problems.push(`post #${last.id}: missing ig_id`);
    if (ytOn && !last.yt_id) {
      problems.push(`post #${last.id}: missing yt_id (${last.yt_error || 'no error recorded'})`);
    }
    if (fbOn && !last.fb_id) {
      problems.push(`post #${last.id}: missing fb_id (${last.fb_error || 'no error recorded'})`);
    }
  }

  // Any YT failure recorded in the last 24 hours is a problem even if a later
  // post recovered, because it means one Short never reached YouTube.
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const recentErrors = store.db
    .prepare('SELECT id, yt_error FROM posts WHERE yt_error IS NOT NULL AND created_at >= ? ORDER BY id DESC LIMIT 10')
    .all(since);
  for (const row of recentErrors) {
    problems.push(`post #${row.id}: yt_error ${String(row.yt_error).slice(0, 160)}`);
  }

  if (problems.length) {
    notify.error(`publish health check failed: ${problems.join(' | ')}`);
    process.exitCode = 1;
  } else {
    log.ok('publish health check: instagram + youtube OK');
  }
  return problems;
}

module.exports = { check };

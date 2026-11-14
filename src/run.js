'use strict';
/**
 * One autonomous execution: pick a theme, write a quote, find a photo, choose
 * music, render, validate, host, publish, record, clean up.
 *
 * Designed to be idempotent-ish: every guard exists so that a duplicated cron
 * trigger, a delayed runner or a mid-publish crash cannot produce a second post
 * for the same slot.
 */
const fs = require('node:fs');
const path = require('node:path');
const { config, paths, env } = require('./config');
const { log, slug } = require('./util');
const store = require('./db');
const lines = require('./lines');
const library = require('./library');
const quotes = require('./quote');
const insights = require('./insights');
const notify = require('./notify');
const host = require('./host');
const ig = require('./publish/instagram');
const { publishVideo, normalise, firstLine, uploadMode } = require('./publish');
const { validateVideo } = require('./video');
const { THEMES, THEME_KEYS, VISUAL_VARIANTS } = require('./themes');

// ---------------------------------------------------------------- guards

function killSwitchOn() {
  return String(env.KILL_SWITCH || '') === '1' || fs.existsSync(path.join(paths.data, 'KILL_SWITCH'));
}

function chooseTheme(explicit) {
  if (explicit && THEMES[explicit]) return explicit;

  const perf = store.themePerformance();
  const medians = Object.values(perf)
    .map((p) => p.medianReach)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const baseline = medians.length ? medians[Math.floor(medians.length / 2)] : 0;

  const recent = store.recentPosts(10).map((p) => p.theme).filter(Boolean);
  let best = null;

  for (const theme of THEME_KEYS) {
    let weight = 1;

    // Nudge toward themes that historically reached further, without letting a
    // single viral post permanently monopolise the page.
    if (baseline > 0 && perf[theme]) {
      weight *= Math.max(0.45, Math.min(2.4, perf[theme].medianReach / baseline));
    }
    // Strong penalty for repetition of the last few themes.
    const idx = recent.indexOf(theme);
    if (idx === 0) weight *= 0.1;
    else if (idx >= 0) weight *= 0.5;

    const score = weight * (0.55 + Math.random() * 0.9);
    if (!best || score > best.score) best = { theme, score };
  }

  log.info(
    `theme: ${best.theme} (${baseline > 0 ? `median reach baseline ${baseline}` : 'no insight data yet'})`
  );
  return best.theme;
}

function chooseVariant() {
  const recent = store
    .recentPosts(4)
    .map((p) => p.variant)
    .filter(Boolean);
  const pool = VISUAL_VARIANTS.filter((v) => !recent.includes(v));
  const list = pool.length ? pool : VISUAL_VARIANTS;
  return list[Math.floor(Math.random() * list.length)];
}

function randomDuration() {
  // 9–15s, biased away from the extremes.
  return Number((9 + Math.random() * 6).toFixed(1));
}

// ---------------------------------------------------------------- reconcile

/**
 * A row left in 'publishing' means a previous execution died between the
 * media_publish call and the DB write. Ask Instagram what is actually live
 * before writing the row off, so a successful publish is never repeated.
 */
async function reconcileStale() {
  const stale = store.stalePublishing(0);
  if (!stale.length) return { checked: 0, recovered: 0, deferred: 0, blocked: false };

  let recent = null;
  try {
    recent = await ig.recentMedia(25);
  } catch (e) {
    log.warn(`reconcile: cannot read recent media (${String(e.message).slice(0, 120)})`);
  }

  // Without visibility into the account we cannot tell a lost publish from a
  // failed one. Defer every row rather than guessing: the run will not publish
  // another reel while state is uncertain, and the next execution retries.
  if (!recent) {
    log.warn(`reconcile: ${stale.length} row(s) still unresolved, deferring to the next run`);
    return { checked: 0, recovered: 0, deferred: stale.length, blocked: true };
  }

  let recovered = 0;
  let deferred = 0;
  let failed = 0;
  for (const row of stale) {
    const mine = normalise(firstLine(row.caption_text));
    const hit = recent.find((m) => normalise(firstLine(m.caption)) === mine);

    // Case 1: Instagram already has the caption -> the publish succeeded.
    if (hit) {
      store.updatePost(row.id, {
        status: 'published',
        ig_id: hit.id,
        permalink: hit.permalink || null,
        published_at: hit.timestamp || new Date().toISOString(),
        creation_id: row.creation_id || null,
      });
      recovered++;
      log.ok(`reconcile: post #${row.id} was actually live as ${hit.id}`);
      continue;
    }

    // Case 2: container id known -> ask Instagram what happened to it.
    if (row.creation_id) {
      let status = null;
      try {
        status = await ig.containerStatus(row.creation_id);
      } catch (e) {
        log.warn(`reconcile: container status failed for #${row.id} (${String(e.message).slice(0, 120)})`);
      }

      const code = status && status.code ? String(status.code).toUpperCase() : '';
      if (code === 'PUBLISHED') {
        // Published but the media has not surfaced in the recent list yet.
        // Defer: do not risk a second post.
        deferred++;
        log.warn(`reconcile: post #${row.id} container ${row.creation_id} is PUBLISHED but media not listed yet, deferring`);
        continue;
      }
      if (code === 'FINISHED') {
        // Container is ready but never got published: publish it now. This is
        // safe because media_publish only succeeds once per container.
        try {
          const mediaId = await ig.publishContainer(row.creation_id);
          let permalink = '';
          try {
            const info = await ig.mediaInfo(mediaId);
            permalink = info.permalink || '';
          } catch (e) {
            log.warn(`ig: published but permalink lookup failed (${String(e.message).slice(0, 120)})`);
          }
          store.updatePost(row.id, {
            status: 'published',
            ig_id: mediaId,
            permalink: permalink || null,
            published_at: new Date().toISOString(),
          });
          recovered++;
          log.ok(`reconcile: post #${row.id} recovered via container ${row.creation_id} -> ${mediaId}`);
          continue;
        } catch (e) {
          log.warn(`reconcile: could not publish recovered container for #${row.id} (${String(e.message).slice(0, 120)})`);
          if (e && e.uncertain) {
            deferred++;
            continue;
          }
          store.updatePost(row.id, {
            status: 'failed',
            error: String(e.message || e).slice(0, 900),
          });
          failed++;
          continue;
        }
      }
      if (code === 'IN_PROGRESS') {
        deferred++;
        log.warn(`reconcile: post #${row.id} container still IN_PROGRESS, deferring`);
        continue;
      }
      if (code === 'ERROR' || code === 'EXPIRED' || code === '') {
        store.updatePost(row.id, {
          status: 'failed',
          error: `execution interrupted during publish; container ended ${code || 'unknown'}`,
        });
        log.warn(`reconcile: post #${row.id} marked failed (container ${code || 'unknown'})`);
        failed++;
        continue;
      }
      // Unknown status code: defer rather than guess.
      deferred++;
      log.warn(`reconcile: post #${row.id} container status ${code} not understood, deferring`);
      continue;
    }

    // Case 3: no container id and no matching media -> crash before container
    // creation. Safe to fail.
    store.updatePost(row.id, {
      status: 'failed',
      error: 'execution interrupted before container creation; no matching media on Instagram',
    });
    log.warn(`reconcile: post #${row.id} marked failed (no container, not found on Instagram)`);
    failed++;
  }

  const blocked = deferred > 0;
  return { checked: stale.length, recovered, deferred, failed, blocked };
}

// -------------------------------------------------------------- preflight

async function tokenHealth() {
  if (!env.FB_APP_ID || !env.FB_APP_SECRET) return null;
  try {
    const d = await ig.debugToken();
    if (!d) return null;
    const deadline = d.expires_at && d.expires_at > 0 ? d.expires_at : d.data_access_expires_at;
    const daysLeft = deadline ? Math.floor((deadline * 1000 - Date.now()) / 86_400_000) : null;
    return { daysLeft, deadline: deadline ? new Date(deadline * 1000).toISOString() : null, scopes: d.scopes || [] };
  } catch (e) {
    log.warn(`token: debug_token failed (${String(e.message).slice(0, 120)})`);
    return null;
  }
}

async function preflight({ dryRun }) {
  if (!ig.isConfigured()) throw new Error('IG_USER_ID / IG_ACCESS_TOKEN missing');

  let me;
  try {
    me = await ig.preflight();
  } catch (e) {
    if (e instanceof ig.IgError && e.authProblem) {
      throw new Error(
        `Instagram authorization expired or was revoked. Re-authorize and update the IG_ACCESS_TOKEN secret. (${e.message})`
      );
    }
    throw e;
  }
  log.ok(`ig: authenticated as @${me.username || me.id}`);

  if (!dryRun && uploadMode() === 'url' && !host.isConfigured()) {
    throw new Error(`R2 hosting is not configured, missing: ${host.missing().join(', ')}`);
  }
  if (!dryRun) {
    log.info(`upload: ${uploadMode()}${uploadMode() === 'url' ? ' (R2)' : ' (resumable, no hosting)'}`);
  }

  if (!dryRun) {
    try {
      const limit = await ig.publishingLimit();
      if (limit.usage >= 45) {
        log.warn(`ig: publishing quota almost used (${limit.usage})`);
      } else {
        log.info(`ig: publishing quota used ${limit.usage}`);
      }
    } catch (e) {
      log.warn(`ig: quota check failed (${String(e.message).slice(0, 120)})`);
    }
  }

  return me;
}

// ----------------------------------------------------------------- build

async function buildPost({ theme, slot = '' }) {
  const picked = await lines.compose(theme);
  const meta = lines.themeMeta(picked.theme);
  const variant = chooseVariant();
  const duration = randomDuration();

  log.step(`building: ${meta.theme} / ${variant} / ${duration}s`);
  log.info(`line (${picked.engine}): ${picked.line}`);

  const postId = store.insertPost({
    status: 'building',
    theme: meta.theme,
    variant,
    title: picked.line,
    scriptJson: { theme: meta.theme, mood: meta.mood, engine: picked.engine, slot },
  });

  try {
    const photo = await library.ensurePhoto({
      mood: meta.mood,
      theme: meta.theme,
      queries: meta.queries,
      preferLocal: String(env.PHOTO_FROM_LOCAL || '') === '1',
    });
    const track = library.pickTrack(meta.mood);

    const stamp = new Date().toISOString().slice(0, 10);
    const outPath = path.join(paths.output, `${stamp}-${meta.theme}-${postId}-${slug(picked.line, 24)}.mp4`);

    const render = await quotes.renderQuote({
      image: photo.path,
      text: picked.line,
      mood: meta.mood,
      music: track,
      outPath,
      duration,
      variant,
      watermark: true,
    });

    const check = await validateVideo(outPath);
    if (!check.ok) {
      throw new Error(`rendered video failed validation: ${check.reasons.join('; ')}`);
    }
    log.ok(
      `validated: ${check.info.duration.toFixed(1)}s ${check.info.width}x${check.info.height} ` +
        `${(check.info.bytes / 1048576).toFixed(1)} MB`
    );

    const cap = await lines.buildCaption({
      theme: meta.theme,
      mood: meta.mood,
      line: picked.line,
      credit: config.music.creditInCaption ? library.MUSIC_CREDIT : '',
    });

    store.updatePost(postId, {
      status: 'built',
      video_path: outPath,
      caption_text: cap.caption,
      bg_path: photo.path,
      music_path: track,
    });

    return {
      postId,
      outPath,
      caption: cap.caption,
      hashtags: cap.hashtags,
      theme: meta.theme,
      mood: meta.mood,
      line: picked.line,
      engine: picked.engine,
      variant,
      motion: render.motion,
      duration: render.total,
      photo,
      track,
      bytes: check.info.bytes,
    };
  } catch (e) {
    store.updatePost(postId, { status: 'failed', error: String(e.message).slice(0, 900) });
    throw e;
  }
}

// ------------------------------------------------------------------- main

async function run({ slot = '', theme = '', dryRun = false, force = false } = {}) {
  const runId = store.startRun(slot);
  const startedAt = new Date();
  const result = {
    ok: false,
    status: 'failed',
    slot,
    dryRun,
    postId: null,
    mediaId: null,
    permalink: null,
    theme: null,
    line: null,
    error: null,
    notes: [],
  };

  try {
    if (killSwitchOn()) {
      result.status = 'skipped';
      result.ok = true;
      result.notes.push('KILL_SWITCH is present; nothing was done');
      log.warn(result.notes[0]);
      store.finishRun(runId, { status: 'skipped' });
      return result;
    }

    const me = await preflight({ dryRun });
    result.notes.push(`account @${me.username || me.id}`);

    const token = await tokenHealth();
    if (token && token.daysLeft !== null) {
      if (token.daysLeft <= 0) {
        throw new Error(
          `Instagram data-access token expired on ${token.deadline}. Re-authorize before the next run.`
        );
      }
      result.notes.push(`token valid for ${token.daysLeft} more day(s) (until ${token.deadline})`);
      if (token.daysLeft <= 21) {
        notify.warn(
          `Instagram token expires in ${token.daysLeft} day(s) (${token.deadline}). Re-authorize and update IG_ACCESS_TOKEN.`
        );
      }
    }

    // -------- duplicate / cadence guards
    const reconciled = await reconcileStale();
    if (reconciled.checked) {
      result.notes.push(
        `reconciled ${reconciled.checked} interrupted publish(es): ${reconciled.recovered} recovered, ${reconciled.failed || 0} failed, ${reconciled.deferred || 0} deferred`
      );
    }
    if (reconciled.blocked) {
      result.status = 'skipped';
      result.ok = true;
      result.notes.push('publishing state still unresolved; refusing to publish another reel');
      log.warn(result.notes[result.notes.length - 1]);
      store.finishRun(runId, { status: 'skipped', postId: result.postId });
      return result;
    }

    if (!dryRun) {
      const maxPerDay = Number(config.schedule.maxPerDay) || 4;
      const doneToday = store.countPublishedToday();
      if (doneToday >= maxPerDay) {
        result.status = 'skipped';
        result.ok = true;
        result.notes.push(`daily cap reached (${doneToday}/${maxPerDay})`);
        log.info(result.notes[result.notes.length - 1]);
        store.finishRun(runId, { status: 'skipped' });
        return result;
      }

      const minGap = Number(config.schedule.minGapMinutes) || 120;
      const last = store.lastPublishedAt();
      if (last) {
        const gap = (Date.now() - new Date(last).getTime()) / 60_000;
        if (gap < minGap) {
          result.status = 'skipped';
          result.ok = true;
          result.notes.push(
            `last post was ${Math.round(gap)} min ago (minimum gap ${minGap} min)`
          );
          log.info(result.notes[result.notes.length - 1]);
          store.finishRun(runId, { status: 'skipped' });
          return result;
        }
      }
    }

    // -------- insight refresh feeds theme weighting
    try {
      const ins = await insights.collectRecent({ limit: 8, minAgeHours: 6 });
      if (ins.updated) result.notes.push(`refreshed insights for ${ins.updated} post(s)`);
    } catch (e) {
      log.warn(`insights: skipped (${String(e.message).slice(0, 120)})`);
    }

    // -------- build
    const chosen = chooseTheme(theme);
    const built = await buildPost({ theme: chosen, slot });
    result.postId = built.postId;
    result.theme = built.theme;
    result.line = built.line;
    result.notes.push(`line engine: ${built.engine}, variant: ${built.variant}, ${built.duration}s`);
    result.notes.push(`photo: ${built.photo.provider} [${built.photo.license}]`);

    store.updatePost(built.postId, { status: dryRun ? 'built' : 'publishing' });

    if (dryRun) {
      result.ok = true;
      result.status = 'dry-run';
      result.notes.push(`dry run: video at ${built.outPath}`);
      store.finishRun(runId, { status: 'dry-run', postId: built.postId });
      return result;
    }

    // -------- publish
    let published;
    try {
      published = await publishVideo({
        postId: built.postId,
        videoPath: built.outPath,
        caption: built.caption,
        onContainer: (creationId) => store.updatePost(built.postId, { creation_id: creationId }),
      });
    } catch (e) {
      if (e && e.uncertain) {
        // The publish may or may not have landed. Leave the row in 'publishing'
        // with the container id so the next run can reconcile; never mark failed.
        const pubFields = { status: 'publishing', error: String(e.message || e).slice(0, 900) };
        if (e.creationId) pubFields.creation_id = e.creationId;
        store.updatePost(built.postId, pubFields);
      } else {
        store.updatePost(built.postId, { status: 'failed', error: String(e.message || e).slice(0, 900) });
      }
      throw e;
    }

    try {
      store.updatePost(built.postId, {
        status: 'published',
        ig_id: published.mediaId,
        permalink: published.permalink || null,
        published_at: new Date().toISOString(),
        creation_id: published.creationId || null,
      });
    } catch (e) {
      // Published but we could not record it. Leave the row 'publishing' so the
      // next run reconciles instead of (possibly) publishing a second reel.
      store.updatePost(built.postId, {
        status: 'publishing',
        creation_id: published.creationId || null,
        error: `published as ${published.mediaId} but DB write failed: ${String(e.message).slice(0, 300)}`,
      });
      log.error(`run: published ${published.mediaId} but DB update failed; will reconcile next run`);
    }

    result.ok = true;
    result.status = 'published';
    result.mediaId = published.mediaId;
    result.permalink = published.permalink || null;
    result.notes.push(`published ${published.mediaId}`);
    store.finishRun(runId, { status: 'published', postId: built.postId });
    return result;
  } catch (e) {
    result.error = String(e.message || e);
    notify.error(`reel run failed: ${result.error}`);
    store.finishRun(runId, { status: 'failed', postId: result.postId, error: result.error });
    throw e;
  } finally {
    try {
      const removed = library.cleanupTemp({ hours: 24 });
      if (removed) log.info(`cleanup: removed ${removed} temp item(s)`);
    } catch (e) {
      log.warn(`cleanup: ${String(e.message).slice(0, 100)}`);
    }
    await summaryFor(result, startedAt);
  }
}

async function summaryFor(result, startedAt) {
  const minutes = ((Date.now() - startedAt.getTime()) / 60_000).toFixed(1);
  const linesOut = [
    '## Reel engine run',
    '',
    `| field | value |`,
    `|---|---|`,
    `| status | **${result.status}** |`,
    `| slot | ${result.slot || '-'} |`,
    `| theme | ${result.theme || '-'} |`,
    `| post id | ${result.postId ?? '-'} |`,
    `| media id | ${result.mediaId || '-'} |`,
    `| permalink | ${result.permalink || '-'} |`,
    `| duration | ${minutes} min |`,
    `| published today | ${safe(() => store.countPublishedToday())} |`,
  ];
  if (result.line) linesOut.push('', `> ${result.line}`);
  if (result.error) linesOut.push('', `**error:** ${result.error}`);
  if (result.notes.length) {
    linesOut.push('', ...result.notes.map((n) => `- ${n}`));
  }
  await notify.summary(linesOut.join('\n'));
  notify.setOutput('status', result.status);
  notify.setOutput('post_id', result.postId ?? '');
  notify.setOutput('media_id', result.mediaId ?? '');
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return '-';
  }
}

module.exports = { run, buildPost, chooseTheme, chooseVariant, reconcileStale, tokenHealth };

'use strict';
/**
 * Publish orchestrator: validate -> upload to R2 -> container -> poll ->
 * media_publish -> permalink -> delete hosted object.
 *
 * Duplicate protection happens in src/run.js before this is called (a row with
 * status='publishing' is written first), and again here against the account's
 * most recent captions.
 */
const path = require('node:path');
const crypto = require('node:crypto');
const { log } = require('../util');
const { slug } = require('../util');
const host = require('../host');
const ig = require('./instagram');
const { validateVideo } = require('../video');
const { env, config } = require('../config');
const audio = require('../audio');

function uploadMode() {
  return String(env.IG_UPLOAD_MODE || (config.instagram && config.instagram.uploadMode) || 'direct').trim().toLowerCase();
}

function firstLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) || '';
}

function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Refuse to publish a caption whose opening line is already the opening line of
 * one of the last `lookback` posts. Cheap insurance against a state rollback
 * re-publishing the same quote.
 */
async function findDuplicate(caption, lookback = 12, account = 0) {
  const mine = normalise(firstLine(caption));
  if (mine.length < 8) return null;
  let recent;
  try {
    recent = await ig.recentMedia(lookback, account);
  } catch (e) {
    log.warn(`ig: duplicate check skipped (${String(e.message).slice(0, 120)})`);
    return null;
  }
  for (const m of recent) {
    if (normalise(firstLine(m.caption)) === mine) return m;
  }
  return null;
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * @returns {{mediaId, permalink, creationId, url, key}}
 */
async function publishVideo({
  postId,
  videoPath,
  caption,
  keepHosted = false,
  onContainer,
  account = 0,
  audioTrack = null,
} = {}) {
  const check = await validateVideo(videoPath);
  if (!check.ok) {
    throw new Error(`video rejected before upload: ${check.reasons.join('; ')}`);
  }
  if (!ig.isConfigured()) {
    throw new Error('Instagram credentials missing (IG_USER_ID / IG_ACCESS_TOKEN)');
  }

  const mode = uploadMode();
  if (mode !== 'direct' && mode !== 'url') {
    throw new Error(`unknown IG upload mode: ${mode}`);
  }
  if (mode === 'url' && !host.isConfigured()) {
    throw new Error(`R2 not configured, missing: ${host.missing().join(', ')}`);
  }

  const dup = await findDuplicate(caption, 12, account);
  if (dup) {
    throw new Error(
      `refusing to publish: identical opening line already live as ${dup.id} ${dup.permalink || ''}`.trim()
    );
  }

  const audioConfig = audio.enabled() ? audio.payload(audioTrack) : null;

  if (mode === 'direct') {
    log.info('publish: using direct resumable upload (no R2)');
    const res = await ig.publishReel({ filePath: videoPath, caption, onContainer, account, audioConfig });
    return { ...res, uploadMode: 'direct' };
  }

  const key = `reels/${dateStamp()}/${postId}-${slug(path.basename(videoPath, '.mp4'), 32)}-${crypto
    .randomBytes(3)
    .toString('hex')}.mp4`;

  const uploaded = await host.uploadFile(key, videoPath);
  log.info(`hosted: ${uploaded.url}`);

  try {
    const res = await ig.publishReel({ videoUrl: uploaded.url, caption, onContainer, account, audioConfig });
    return { ...res, url: uploaded.url, key, uploadMode: 'url' };
  } finally {
    if (!keepHosted) {
      // Safe: media_publish only returns once Instagram has ingested the file.
      await host.deleteObject(key);
    } else {
      log.info(`hosted object kept for inspection: ${key}`);
    }
  }
}

module.exports = { publishVideo, findDuplicate, normalise, firstLine, uploadMode };

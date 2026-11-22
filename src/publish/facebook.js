'use strict';
/**
 * Facebook Page Reels publishing (the cross-post half of an Instagram Reel).
 *
 * Meta has no single "also post to Facebook" flag on the IG container, so the
 * reel is uploaded to the connected Page through the Page Reels API:
 *   POST /{page}/video_reels?upload_phase=start  -> video_id + upload_url
 *   POST rupload.facebook.com/video-upload/...   -> bytes
 *   POST /{page}/video_reels?upload_phase=finish&video_state=PUBLISHED
 *
 * Requires a Page token with `pages_manage_posts`. Additive: failures never
 * affect the Instagram publish.
 */
const fs = require('node:fs');
const { env, config } = require('../config');
const { log } = require('../util');

const GRAPH = 'https://graph.facebook.com';

function version() {
  return String(env.IG_API_VERSION || (config.instagram && config.instagram.apiVersion) || 'v27.0');
}

function enabled() {
  const raw = env.CROSS_POST_FACEBOOK;
  if (raw !== undefined && raw !== '') return String(raw) !== '0' && String(raw).toLowerCase() !== 'false';
  return !(config.crossPost && config.crossPost.facebook === false);
}

function isConfigured() {
  return !!(String(env.FB_PAGE_ID || '').trim() && String(env.FB_PAGE_TOKEN || '').trim());
}

async function graph(method, pathname, params = {}) {
  const url = `${GRAPH}/${version()}/${pathname}`;
  const body = new URLSearchParams({ ...params, access_token: env.FB_PAGE_TOKEN });
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const msg = (json.error && json.error.message) || `HTTP ${res.status}`;
    const err = new Error(`facebook: ${msg}`);
    err.code = json.error && json.error.code;
    err.permission = /permission/i.test(msg);
    throw err;
  }
  return json;
}

/** Publish a local MP4 as a Facebook Page Reel. Returns { videoId, url }. */
async function publishReel({ videoPath, description = '', title = '' } = {}) {
  if (!isConfigured()) throw new Error('facebook: FB_PAGE_ID / FB_PAGE_TOKEN not configured');
  if (!fs.existsSync(videoPath)) throw new Error(`facebook: video not found: ${videoPath}`);

  const buf = fs.readFileSync(videoPath);
  const started = await graph('POST', `${env.FB_PAGE_ID}/video_reels`, { upload_phase: 'start' });
  const videoId = started.video_id;
  const uploadUrl = started.upload_url;
  if (!videoId || !uploadUrl) throw new Error('facebook: no video_id / upload_url returned by start');

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${env.FB_PAGE_TOKEN}`,
      'content-type': 'application/octet-stream',
      offset: '0',
      file_size: String(buf.length),
    },
    body: buf,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const uploaded = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok || uploaded.success !== true) {
    throw new Error(`facebook: upload failed: ${JSON.stringify(uploaded).slice(0, 250)}`);
  }
  log.info(`facebook: uploaded ${(buf.length / 1048576).toFixed(1)} MB (video ${videoId})`);

  const finish = await graph('POST', `${env.FB_PAGE_ID}/video_reels`, {
    upload_phase: 'finish',
    video_id: videoId,
    video_state: 'PUBLISHED',
    description: description || '',
    ...(title ? { title: title.slice(0, 100) } : {}),
  });
  if (!finish.success) throw new Error(`facebook: publish rejected: ${JSON.stringify(finish).slice(0, 250)}`);

  const url = `https://www.facebook.com/${env.FB_PAGE_ID}/videos/${videoId}`;
  log.ok(`facebook: published Page Reel ${videoId} -> ${url}`);
  return { videoId, url };
}

module.exports = { enabled, isConfigured, publishReel, graph };

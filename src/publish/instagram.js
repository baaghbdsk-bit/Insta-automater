'use strict';
/**
 * Instagram Graph API — Reels publishing and insights.
 *
 * Flow (the only one Meta supports for API-published reels):
 *   POST /{ig-user}/media (media_type=REELS, video_url, caption, share_to_feed)
 *     -> creation_id
 *   GET  /{creation_id}?fields=status_code   (poll until FINISHED)
 *   POST /{ig-user}/media_publish?creation_id=...
 *     -> media id
 *   GET  /{media-id}?fields=permalink
 *
 * Nothing here invents capabilities: trending audio, profile edits and
 * scheduling-at-Instagram are not exposed by this API and are not attempted.
 */
const { env, config } = require('../config');
const { log } = require('../util');
const { withRetry, sleep } = require('../net');

const GRAPH = 'https://graph.facebook.com';
const RUPLOAD = 'https://rupload.facebook.com';

// Meta error codes that mean "try again shortly" rather than "your request is wrong".
const RETRY_CODES = new Set([1, 2, 4, 17, 32, 613, 80000, 80001, 80002]);
const AUTH_CODES = new Set([102, 190, 463, 467]);
// 9 = "user has reached the maximum number of published posts" (publishing quota)
const QUOTA_CODES = new Set([9]);

class IgError extends Error {
  constructor(payload, context) {
    const e = (payload && payload.error) || {};
    const bits = [context + ':', e.message || 'unknown Instagram error'];
    if (e.code) bits.push(`(code ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''})`);
    if (e.type) bits.push(`[${e.type}]`);
    if (e.fbtrace_id) bits.push(`trace ${e.fbtrace_id}`);
    super(bits.join(' '));
    this.name = 'IgError';
    this.code = e.code;
    this.subcode = e.error_subcode;
    this.type = e.type;
    this.fbtrace = e.fbtrace_id;
    this.status = (payload && payload.status) || 0;
  }

  get retryable() {
    return this.status === 429 || this.status >= 500 || RETRY_CODES.has(this.code);
  }

  get authProblem() {
    return AUTH_CODES.has(this.code);
  }

  get quotaProblem() {
    return QUOTA_CODES.has(this.code);
  }
}

function version() {
  return String(env.IG_API_VERSION || (config.instagram && config.instagram.apiVersion) || 'v23.0');
}

function accountSuffix(account = 0) {
  return account === 0 ? '' : `_${account + 1}`;
}

function token(account = 0) {
  const s = accountSuffix(account);
  // A Page access token is the documented token for Instagram content publishing;
  // use it when present, fall back to the user token otherwise.
  const t = String(env[`FB_PAGE_TOKEN${s}`] || env[`IG_ACCESS_TOKEN${s}`] || '').trim();
  if (!t) throw new Error(`IG_ACCESS_TOKEN${s} is not set`);
  return t;
}

function igUser(account = 0) {
  const s = accountSuffix(account);
  const id = String(env[`IG_USER_ID${s}`] || '').trim();
  if (!id) throw new Error(`IG_USER_ID${s} is not set`);
  return id;
}

function isConfigured(account = 0) {
  const s = accountSuffix(account);
  return !!(
    String(env[`IG_ACCESS_TOKEN${s}`] || env[`FB_PAGE_TOKEN${s}`] || '').trim() &&
    String(env[`IG_USER_ID${s}`] || '').trim()
  );
}

/** List of configured account indices (0 = primary, 1 = second, 2 = third). */
function configuredAccounts() {
  const out = [];
  for (let a = 0; a < 3; a++) {
    if (isConfigured(a)) out.push(a);
  }
  return out;
}

/**
 * One Graph call. The access token is never placed in a log line or an error
 * message, so this is safe to run in a public repository's Actions log.
 */
async function request(method, pathname, params = {}, opts = {}) {
  const account = opts.account || 0;
  const url = `${GRAPH}/${version()}/${pathname}`;
  const label = `ig ${method} ${pathname.split('?')[0]}`;

  return withRetry(
    async () => {
      const payload = { ...params, access_token: token(account) };
      let res;
      if (method === 'GET') {
        const u = new URL(url);
        for (const [k, v] of Object.entries(payload)) {
          if (v === undefined || v === null) continue;
          u.searchParams.set(k, String(v));
        }
        res = await fetch(u, { signal: AbortSignal.timeout(opts.timeout || 60_000) });
      } else {
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries(payload)) {
          if (v === undefined || v === null) continue;
          body.set(k, String(v));
        }
        res = await fetch(url, {
          method,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(opts.timeout || 60_000),
        });
      }

      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) throw new IgError({ ...json, status: res.status }, label);
      return json;
    },
    {
      attempts: opts.attempts || 4,
      baseMs: 2_500,
      label,
      isRetryable: (e) => (e instanceof IgError ? e.retryable : true),
    }
  );
}

// ---------------------------------------------------------------- account

/** Cheap token/account check. Throws IgError (code 190) when re-auth is needed. */
async function preflight(account = 0) {
  const me = await request('GET', igUser(account), { fields: 'id,username' }, { account });
  return me;
}

async function publishingLimit(account = 0) {
  const r = await request('GET', `${igUser(account)}/content_publishing_limit`, {
    fields: 'quota_usage,config',
  }, { account });
  const row = (r.data && r.data[0]) || {};
  return { usage: Number(row.quota_usage || 0), config: row.config || null };
}

/** Most recent media, used for duplicate-caption detection and reconciliation. */
async function recentMedia(limit = 15, account = 0) {
  const r = await request('GET', `${igUser(account)}/media`, {
    fields: 'id,caption,permalink,timestamp,media_type,media_product_type',
    limit,
  }, { account });
  return r.data || [];
}

// ---------------------------------------------------------------- publish

/**
 * Meta expects audio_configuration as a JSON-encoded string on the container.
 * Accepts either the audio module's payload object or an already-encoded value.
 */
function audioConfiguration(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (!value.audio_id) return '';
  return JSON.stringify(value);
}

async function createUrlContainer({ videoUrl, caption, shareToFeed = true, account = 0, audioConfig = null }) {
  const params = {
    media_type: 'REELS',
    video_url: videoUrl,
    caption,
    share_to_feed: shareToFeed ? 'true' : 'false',
  };
  const audio = audioConfiguration(audioConfig);
  if (audio) params.audio_configuration = audio;

  const r = await request('POST', `${igUser(account)}/media`, params, { account });
  if (!r.id) throw new Error('Instagram did not return a container id');
  log.info(`ig: container ${r.id} created (url upload, account ${account})`);
  return r.id;
}

/**
 * Create a Reels container for a resumable upload. Meta returns the container id
 * and the rupload URI to POST the bytes to. No video_url is sent: the video is
 * uploaded separately via uploadResumable().
 */
async function createResumableContainer({ caption, shareToFeed = true, account = 0, audioConfig = null }) {
  const params = {
    media_type: 'REELS',
    upload_type: 'resumable',
    caption,
    share_to_feed: shareToFeed ? 'true' : 'false',
  };
  const audio = audioConfiguration(audioConfig);
  if (audio) params.audio_configuration = audio;

  const r = await request('POST', `${igUser(account)}/media`, params, { account });
  if (!r.id) throw new Error('Instagram did not return a container id');
  const uri =
    r.uri ||
    `${RUPLOAD}/ig-api-upload/${version()}/${r.id}`;
  log.info(`ig: container ${r.id} created (resumable upload, account ${account})`);
  return { id: r.id, uri };
}

/**
 * Upload the rendered MP4 to Meta's rupload endpoint. Returns nothing on success;
 * throws on any failure so the caller can decide whether the attempt is
 * recoverable.
 */
async function uploadResumable({ uri, filePath, account = 0 }) {
  const fs = require('node:fs');
  if (!fs.existsSync(filePath)) throw new Error(`upload source missing: ${filePath}`);
  const buf = fs.readFileSync(filePath);
  const url = String(uri || '').trim();
  if (!url) throw new Error('resumable upload URI is empty');

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${token(account)}`,
        offset: '0',
        file_size: String(buf.length),
      },
      body: buf,
      signal: AbortSignal.timeout(10 * 60_000),
    });
  } catch (e) {
    throw new Error(`resumable upload network error: ${e.message}`);
  }

  const text = await res.text().catch(() => '');
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }

  if (!res.ok || json.success === false || (json.error && json.error.message)) {
    const msg =
      (json.error && json.error.message) ||
      json.message ||
      json.debug_info?.message ||
      `HTTP ${res.status} ${String(text).slice(0, 300)}`;
    const err = new Error(`resumable upload failed: ${msg}`);
    err.status = res.status;
    err.uncertain = res.status === 429 || res.status >= 500;
    throw err;
  }
  log.ok(`ig: resumable upload complete (${(buf.length / 1048576).toFixed(1)} MB)`);
  return { size: buf.length };
}

// Backwards-compatible alias.
async function createContainer(opts) {
  return createUrlContainer(opts);
}

async function containerStatus(creationId) {
  const r = await request(
    'GET',
    creationId,
    { fields: 'status_code,status' },
    { attempts: 3, timeout: 45_000 }
  );
  return { code: r.status_code, detail: r.status || '' };
}

async function waitForContainer(creationId, { timeoutMs = 6 * 60_000, intervalMs = 10_000 } = {}) {
  const started = Date.now();
  let last = '';
  for (;;) {
    const { code, detail } = await containerStatus(creationId);
    if (code !== last) {
      log.info(`ig: container status ${code}${detail ? ` (${String(detail).slice(0, 120)})` : ''}`);
      last = code;
    }
    if (code === 'FINISHED' || code === 'PUBLISHED') return code;
    if (code === 'ERROR' || code === 'EXPIRED') {
      throw new Error(
        `Instagram container ${creationId} ended in ${code}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`
      );
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `Instagram container ${creationId} still ${code} after ${Math.round(timeoutMs / 1000)}s`
      );
    }
    await sleep(intervalMs);
  }
}

async function publishContainer(creationId, account = 0) {
  // media_publish is intentionally single-shot: retrying a successful-but-unacknowledged
  // publish would risk a double post, and reconcile() handles the ambiguous case.
  const r = await request('POST', `${igUser(account)}/media_publish`, { creation_id: creationId }, { attempts: 1, account });
  if (!r.id) throw new Error('Instagram did not return a media id on publish');
  log.ok(`ig: published media ${r.id}`);
  return r.id;
}

async function mediaInfo(mediaId, account = 0) {
  return request('GET', mediaId, {
    fields: 'id,permalink,media_type,media_product_type,timestamp',
  }, { account });
}

/** Full publish. Returns { creationId, mediaId, permalink }. */
async function publishReel({
  videoUrl,
  filePath,
  caption,
  shareToFeed = true,
  onContainer,
  account = 0,
  audioConfig = null,
} = {}) {
  const direct = !videoUrl && !!filePath;
  let creationId;
  let uri;

  const create = (withAudio) =>
    direct
      ? createResumableContainer({ caption, shareToFeed, account, audioConfig: withAudio })
      : createUrlContainer({ videoUrl, caption, shareToFeed, account, audioConfig: withAudio });

  try {
    const created = await create(audioConfig);
    if (direct) {
      creationId = created.id;
      uri = created.uri;
    } else {
      creationId = created;
    }
  } catch (e) {
    const attach = audioConfiguration(audioConfig);
    const hard = e instanceof IgError && (e.authProblem || e.quotaProblem);
    if (!attach || hard) throw e;
    // The audio may not be licensed for this account, or the API may have
    // changed shape. The embedded bed is already in the file, so retrying
    // without audio_configuration is always safe.
    log.warn(`ig: native audio rejected (${String(e.message).slice(0, 120)}); retrying with embedded music only`);
    const created = await create(null);
    if (direct) {
      creationId = created.id;
      uri = created.uri;
    } else {
      creationId = created;
    }
  }

  if (typeof onContainer === 'function') {
    try {
      await onContainer(creationId);
    } catch (e) {
      const err = new Error(`could not persist container id ${creationId}: ${e.message}`);
      err.creationId = creationId;
      err.uncertain = true;
      throw err;
    }
  }

  let containerError = null;
  try {
    if (direct) await uploadResumable({ uri, filePath, account });
    await waitForContainer(creationId);
  } catch (e) {
    e.creationId = creationId;
    e.uncertain = true;
    throw e;
  }

  let mediaId;
  try {
    mediaId = await publishContainer(creationId, account);
  } catch (e) {
    e.creationId = creationId;
    // media_publish is single-shot; any failure is ambiguous.
    e.uncertain = true;
    throw e;
  }

  let permalink = '';
  try {
    const info = await mediaInfo(mediaId, account);
    permalink = info.permalink || '';
  } catch (e) {
    log.warn(`ig: published but permalink lookup failed (${String(e.message).slice(0, 120)})`);
  }

  return { creationId, mediaId, permalink };
}

// ---------------------------------------------------------------- insights

/**
 * Metric names have drifted across Graph versions, so try a rich set first and
 * degrade to whatever the account accepts. Never fabricate a zero.
 */
const METRIC_GROUPS = [
  ['reach', 'likes', 'comments', 'shares', 'saved', 'views', 'total_interactions', 'ig_reels_avg_watch_time'],
  ['reach', 'likes', 'comments', 'shares', 'saved', 'plays'],
  ['reach', 'likes', 'comments', 'shares', 'saved'],
  ['reach', 'likes', 'comments', 'shares'],
  ['reach'],
];

function metricValue(data, name) {
  const row = data.find((d) => d.name === name);
  if (!row) return null;
  const v = row.values && row.values[0] ? row.values[0].value : row.value;
  return typeof v === 'number' ? v : v === undefined || v === null ? null : Number(v);
}

async function fetchInsights(mediaId, account = 0) {
  let lastErr;
  for (const metrics of METRIC_GROUPS) {
    try {
      const r = await request(
        'GET',
        `${mediaId}/insights`,
        { metric: metrics.join(',') },
        { attempts: 2, account }
      );
      const data = r.data || [];
      return {
        reach: metricValue(data, 'reach'),
        views: metricValue(data, 'views') ?? metricValue(data, 'plays'),
        saves: metricValue(data, 'saved'),
        shares: metricValue(data, 'shares'),
        likes: metricValue(data, 'likes'),
        comments: metricValue(data, 'comments'),
        avgWatchMs: metricValue(data, 'ig_reels_avg_watch_time'),
        metrics: metrics.join(','),
      };
    } catch (e) {
      lastErr = e;
      if (e instanceof IgError && e.authProblem) break;
    }
  }
  throw lastErr || new Error('insights: no supported metric set');
}

// ------------------------------------------------------------ diagnostics

/** Long-lived tokens carry an expiry; report it so re-auth is never a surprise. */
async function debugToken() {
  const appToken = `${env.FB_APP_ID || ''}|${env.FB_APP_SECRET || ''}`;
  if (!env.FB_APP_ID || !env.FB_APP_SECRET) return null;
  const u = new URL(`${GRAPH}/debug_token`);
  u.searchParams.set('input_token', token());
  u.searchParams.set('access_token', appToken);
  const res = await fetch(u, { signal: AbortSignal.timeout(30_000) });
  const json = await res.json().catch(() => ({}));
  if (json.error) throw new IgError(json, 'debug_token');
  return json.data || null;
}

module.exports = {
  IgError,
  isConfigured,
  configuredAccounts,
  version,
  igUser,
  request,
  preflight,
  publishingLimit,
  recentMedia,
  createContainer,
  createUrlContainer,
  createResumableContainer,
  uploadResumable,
  containerStatus,
  waitForContainer,
  publishContainer,
  mediaInfo,
  publishReel,
  fetchInsights,
  debugToken,
  METRIC_GROUPS,
};

'use strict';
/**
 * Minimal Cloudflare R2 (S3-compatible) client.
 *
 * Only the three operations the pipeline needs are implemented: PutObject,
 * DeleteObject and HeadObject. SigV4 is hand-rolled with node:crypto so the
 * runner does not pull in the AWS SDK (~90 MB) for a job that lasts 3 minutes.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { env } = require('./config');
const { log } = require('./util');
const { withRetry } = require('./net');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

function credentials() {
  return {
    accountId: String(env.R2_ACCOUNT_ID || '').trim(),
    accessKeyId: String(env.R2_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: String(env.R2_SECRET_ACCESS_KEY || '').trim(),
    bucket: String(env.R2_BUCKET || '').trim(),
    publicBase: String(env.R2_PUBLIC_BASE || '').trim().replace(/\/+$/, ''),
    region: String(env.R2_REGION || 'auto').trim() || 'auto',
  };
}

const REQUIRED = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];

function missing() {
  const c = credentials();
  const out = REQUIRED.filter((k) => !process.env[k] || !String(process.env[k]).trim());
  if (!c.publicBase) out.push('R2_PUBLIC_BASE');
  return out;
}

function isConfigured() {
  return missing().length === 0;
}

function hostFor(c) {
  return `${c.accountId}.r2.cloudflarestorage.com`;
}

/** RFC 3986 encoding, per path segment so `/` survives. */
function encodeKey(key) {
  return String(key)
    .split('/')
    .map((seg) =>
      encodeURIComponent(seg).replace(
        /[!'()*]/g,
        (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase()
      )
    )
    .join('/');
}

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function amzStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Build the Authorization header. `extra` headers are signed too (anything the
 * caller sends that the server may care about must be in SignedHeaders when it
 * is not in the ignored list).
 */
function sign({ method, host, canonicalUri, payloadHash, extra = {}, c, date = new Date() }) {
  const stamp = amzStamp(date);
  const day = stamp.slice(0, 8);

  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
    ...extra,
  };

  const names = Object.keys(headers)
    .map((n) => n.toLowerCase())
    .sort();
  const lookup = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names.map((n) => `${n}:${String(lookup.get(n)).trim()}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    method,
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${day}/${c.region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    stamp,
    scope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${c.secretAccessKey}`, day), c.region), SERVICE), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    authorization: `${ALGORITHM} Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    headers,
    stamp,
  };
}

function endpoint(c, key) {
  return `https://${hostFor(c)}/${c.bucket}/${encodeKey(key)}`;
}

function publicUrl(key) {
  const c = credentials();
  if (!c.publicBase) throw new Error('R2_PUBLIC_BASE is not set');
  return `${c.publicBase}/${encodeKey(key)}`;
}

async function send(method, key, body, { contentType, cacheControl } = {}) {
  const c = credentials();
  const missingKeys = missing();
  if (missingKeys.length) throw new Error(`R2 not configured: missing ${missingKeys.join(', ')}`);

  const payloadHash = body && body.length ? sha256hex(body) : EMPTY_SHA256;
  const canonicalUri = `/${c.bucket}/${encodeKey(key)}`;
  const extra = {};
  if (contentType) extra['content-type'] = contentType;
  if (cacheControl) extra['cache-control'] = cacheControl;

  const signed = sign({
    method,
    host: hostFor(c),
    canonicalUri,
    payloadHash,
    extra,
    c,
  });

  // `host` is signed but must not be set by hand: the fetch implementation
  // writes it from the URL, and duplicating it can be rejected by undici.
  const headers = { ...signed.headers, authorization: signed.authorization };
  delete headers.host;

  const res = await fetch(endpoint(c, key), {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
    signal: AbortSignal.timeout(10 * 60_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`R2 ${method} ${key} -> HTTP ${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

function retryableR2(err) {
  if (!err || !err.status) return true;
  return err.status === 429 || err.status >= 500;
}

/** Upload a buffer. Returns the public HTTPS URL. */
async function putObject(key, body, opts = {}) {
  await withRetry(() => send('PUT', key, body, opts), {
    attempts: 4,
    baseMs: 1500,
    label: `r2 put ${path.basename(key)}`,
    isRetryable: retryableR2,
  });
  const url = publicUrl(key);
  log.ok(`r2: uploaded ${key} (${(body.length / 1024 / 1024).toFixed(1)} MB)`);
  return { key, url, size: body.length };
}

async function uploadFile(key, filePath, opts = {}) {
  if (!fs.existsSync(filePath)) throw new Error(`upload source missing: ${filePath}`);
  const body = fs.readFileSync(filePath);
  return putObject(key, body, { contentType: 'video/mp4', ...opts });
}

/** Best-effort delete. A failure here is logged, never fatal. */
async function deleteObject(key) {
  if (!isConfigured()) return false;
  try {
    await withRetry(() => send('DELETE', key), {
      attempts: 3,
      baseMs: 1000,
      label: `r2 delete ${path.basename(key)}`,
      isRetryable: retryableR2,
    });
    log.info(`r2: deleted ${key}`);
    return true;
  } catch (e) {
    log.warn(`r2: could not delete ${key} (${String(e.message).slice(0, 120)})`);
    return false;
  }
}

async function headObject(key) {
  const res = await send('HEAD', key);
  return { size: Number(res.headers.get('content-length') || 0) };
}

/**
 * End-to-end credential check: write a tiny object, read it back over the
 * public URL, delete it. Exercises signing, bucket policy and the public
 * domain in one shot.
 */
async function check() {
  const key = `_healthcheck/${Date.now()}.txt`;
  const body = Buffer.from(`ok ${new Date().toISOString()}\n`, 'utf8');
  const put = await putObject(key, body, { contentType: 'text/plain' });
  let reachable = false;
  let detail = '';
  try {
    const res = await fetch(put.url, { signal: AbortSignal.timeout(30_000) });
    reachable = res.ok;
    detail = `HTTP ${res.status}`;
  } catch (e) {
    detail = e.message;
  }
  await deleteObject(key);
  return { url: put.url, reachable, detail, bucket: credentials().bucket };
}

module.exports = {
  credentials,
  missing,
  isConfigured,
  putObject,
  uploadFile,
  deleteObject,
  headObject,
  publicUrl,
  check,
  encodeKey,
  sign,
};

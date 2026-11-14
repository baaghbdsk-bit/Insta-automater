'use strict';
const { log } = require('./util');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(status, body, url) {
    super(`HTTP ${status} from ${shortUrl(url)}: ${String(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

function shortUrl(u) {
  try {
    const url = new URL(u);
    return url.origin + url.pathname;
  } catch {
    return String(u).slice(0, 80);
  }
}

/** Retry on network errors, 429 and 5xx. Never retries 4xx validation errors. */
function retryable(err) {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  return true;
}

function jitteredBackoff(i, baseMs) {
  return Math.round(baseMs * 2 ** i * (0.7 + Math.random() * 0.6));
}

async function withRetry(
  fn,
  { attempts = 4, baseMs = 1200, label = 'request', isRetryable = retryable } = {}
) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      let again;
      try {
        again = isRetryable(e);
      } catch {
        again = false;
      }
      if (!again || i === attempts - 1) break;
      const delay = jitteredBackoff(i, baseMs);
      log.warn(
        `${label}: ${String(e.message).slice(0, 90)} - retry ${i + 1}/${attempts - 1} in ${delay}ms`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function fetchText(url, opts = {}) {
  const { timeout = 60000, ...rest } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text, url);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response from ${shortUrl(url)}: ${text.slice(0, 120)}`);
  }
}

async function postForm(url, params, opts = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) body.set(k, String(v));
  }
  return fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    ...opts,
  });
}

async function fetchBuffer(url, opts = {}) {
  const { timeout = 60000, ...rest } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ''), url);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  sleep,
  withRetry,
  jitteredBackoff,
  fetchText,
  fetchJson,
  fetchBuffer,
  postForm,
  HttpError,
  retryable,
};

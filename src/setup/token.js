'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, env, paths } = require('../config');
const { log } = require('../util');

const GRAPH = (v = 'v27.0') => `https://graph.facebook.com/${v}`;

function readEnvFile() {
  const p = path.join(ROOT, '.env');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function writeEnvValue(key, value) {
  const p = path.join(ROOT, '.env');
  let txt = readEnvFile();
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(txt)) txt = txt.replace(re, `${key}=${value}`);
  else txt += `${txt.endsWith('\n') ? '' : '\n'}${key}=${value}\n`;
  fs.writeFileSync(p, txt, 'utf8');
  process.env[key] = value;
}

async function graphJson(url) {
  const res = await fetch(url);
  const json = await res.json();
  return { ok: res.ok, status: res.status, json };
}

async function debugToken() {
  const appId = env.FB_APP_ID;
  const secret = env.FB_APP_SECRET;
  const token = env.IG_ACCESS_TOKEN;
  if (!token) return { error: 'IG_ACCESS_TOKEN not set' };

  // App access token is the documented route, but a user token can inspect itself.
  const accessToken = appId && secret ? `${appId}|${secret}` : token;
  const { ok, json } = await graphJson(
    `${GRAPH()}/debug_token?input_token=${token}&access_token=${accessToken}`
  );
  if (!ok) return { error: JSON.stringify(json).slice(0, 300) };
  return json.data;
}

async function status() {
  const info = await debugToken();
  if (info.error) {
    log.error(String(info.error));
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  if (!info.expires_at || info.expires_at === 0) {
    log.ok('token: never expires');
  } else {
    const days = ((info.expires_at - now) / 86400).toFixed(1);
    const when = new Date(info.expires_at * 1000).toISOString().slice(0, 16).replace('T', ' ');
    if (info.expires_at < now) log.error(`token EXPIRED on ${when}`);
    else if (days < 7) log.warn(`token expires in ${days} days (${when}) - refresh now`);
    else log.ok(`token valid for ${days} days (until ${when})`);
  }
  log.info(`type: ${info.type || '?'}  app: ${info.app_id || '?'}`);
  log.info(`scopes: ${(info.scopes || []).join(', ')}`);
  if (info.scopes && !info.scopes.includes('instagram_content_publish')) {
    log.warn('missing instagram_content_publish - cannot publish');
  }
}

async function exchange(shortToken, { persist = true } = {}) {
  const appId = env.FB_APP_ID;
  const secret = env.FB_APP_SECRET;
  if (!appId || !secret) throw new Error('Set FB_APP_ID and FB_APP_SECRET in .env first');

  const url =
    `${GRAPH()}/oauth/access_token?grant_type=fb_exchange_token` +
    `&client_id=${appId}&client_secret=${secret}&fb_exchange_token=${shortToken}`;
  const { ok, json } = await graphJson(url);
  if (!ok) throw new Error(`exchange failed: ${JSON.stringify(json).slice(0, 300)}`);

  const longToken = json.access_token;
  if (persist) writeEnvValue('IG_ACCESS_TOKEN', longToken);

  // Derive the page token for the configured page (used for IG publish/insights).
  const pages = await graphJson(
    `${GRAPH()}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${longToken}`
  );
  const page = (pages.json.data || []).find(
    (p) => p.id === env.FB_PAGE_ID || p.instagram_business_account?.id === env.IG_USER_ID
  );

  log.ok('long-lived token obtained');
  if (page) {
    if (persist) writeEnvValue('FB_PAGE_TOKEN', page.access_token);
    log.ok(`page token saved for "${page.name}" (@${page.instagram_business_account?.username || '?'})`);
  } else {
    log.warn('could not match a page to FB_PAGE_ID / IG_USER_ID');
  }

  const info = await debugToken();
  if (!info.error && info.expires_at) {
    const days = ((info.expires_at - Math.floor(Date.now() / 1000)) / 86400).toFixed(1);
    log.ok(`token now valid for ${days} days`);
  }
  return longToken;
}

module.exports = { status, exchange, debugToken, writeEnvValue };

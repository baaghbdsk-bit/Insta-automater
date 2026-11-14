'use strict';
/**
 * YouTube Data API v3 — Shorts publishing.
 *
 * Uploads the rendered MP4 directly to YouTube (no hosting needed). Designed
 * to be additive: a failure here is logged but never fails the Instagram run.
 *
 * Required secrets: YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN
 * OAuth scopes needed: https://www.googleapis.com/auth/youtube.upload
 */
const { env } = require('../config');
const { log } = require('../util');
const { withRetry, sleep } = require('../net');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const API_URL = 'https://www.googleapis.com/youtube/v3';

function isConfigured() {
  return !!(
    String(env.YT_CLIENT_ID || '').trim() &&
    String(env.YT_CLIENT_SECRET || '').trim() &&
    String(env.YT_REFRESH_TOKEN || '').trim()
  );
}

/** Exchange the refresh token for a short-lived access token. */
async function accessToken() {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.YT_CLIENT_ID,
      client_secret: env.YT_CLIENT_SECRET,
      refresh_token: env.YT_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`youtube token refresh failed: ${json.error_description || json.error || res.status}`);
  }
  return json.access_token;
}

/**
 * Publish a video as a YouTube Short.
 * Returns { videoId, url } on success.
 */
async function publishShort({ videoPath, title, description, tags = [] }) {
  const fs = require('node:fs');
  if (!fs.existsSync(videoPath)) throw new Error(`video not found: ${videoPath}`);

  const token = await accessToken();
  const stat = fs.statSync(videoPath);
  const fileSize = stat.size;

  // Build metadata
  const shortTitle = title.length > 100 ? title.slice(0, 97) + '...' : title;
  const fullDescription = `${description}\n\n#Shorts`;
  const metadata = {
    snippet: {
      title: shortTitle,
      description: fullDescription,
      tags: [...tags, 'Shorts'],
      categoryId: '24', // Entertainment
    },
    status: {
      privacyStatus: 'public',
      selfDeclaredMadeForKids: false,
    },
  };

  // Step 1: Initiate resumable upload
  const initRes = await fetch(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(fileSize),
      'X-Upload-Content-Type': 'video/mp4',
    },
    body: JSON.stringify(metadata),
    signal: AbortSignal.timeout(30_000),
  });

  if (!initRes.ok) {
    const text = await initRes.text().catch(() => '');
    throw new Error(`youtube upload init failed: HTTP ${initRes.status} ${text.slice(0, 300)}`);
  }

  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) throw new Error('youtube did not return an upload URL');

  log.info(`youtube: uploading ${(fileSize / 1048576).toFixed(1)} MB`);

  // Step 2: Upload the video bytes
  const buf = fs.readFileSync(videoPath);
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(fileSize),
    },
    body: buf,
    signal: AbortSignal.timeout(10 * 60_000),
  });

  const uploadJson = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok || !uploadJson.id) {
    const text = JSON.stringify(uploadJson).slice(0, 300);
    throw new Error(`youtube upload failed: HTTP ${uploadRes.status} ${text}`);
  }

  const videoId = uploadJson.id;
  const url = `https://www.youtube.com/shorts/${videoId}`;
  log.ok(`youtube: published Short ${videoId} -> ${url}`);
  return { videoId, url };
}

module.exports = { isConfigured, publishShort, accessToken };
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Load .env if present (Node 20.12+ has loadEnvFile)
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* no .env yet - fine */
}

function readJson(rel, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  } catch {
    return fallback;
  }
}

const DEFAULTS = {
  channel: { name: 'Bharat Brief', handle: '@bharatbrief', tagline: '' },
  video: {
    width: 1080,
    height: 1920,
    fps: 30,
    bgColorA: '0x0A0F1A',
    bgColorB: '0x17243B',
    accent: '0xFFC61A',
    tailSeconds: 0.7,
  },
  voice: { name: 'hi-IN-MadhurNeural', rate: '-4%', pitch: 'default' },
  limits: { maxLines: 7, maxSeconds: 50, maxCaptionCharsPerLine: 20 },
  backgrounds: { folder: 'assets/backgrounds', rotateEvery: 10, kenBurns: true },
  music: {
    creditInCaption: true,
    credit: 'Music: Kevin MacLeod (incompetech.com), CC BY 4.0',
  },
  schedule: {
    timezone: 'Asia/Kolkata',
    times: ['08:00', '14:00', '20:00', '23:00'],
    maxPerDay: 4,
    minGapMinutes: 120,
  },
  instagram: { apiVersion: 'v27.0', uploadMode: 'direct' },
  safety: {
    blockOnUngroundedNumbers: true,
    blockedTerms: [],
    maxFailuresBeforePause: 3,
  },
};

const user = readJson('config/config.json', {});

const config = {
  ...DEFAULTS,
  ...user,
  video: { ...DEFAULTS.video, ...(user.video || {}) },
  voice: { ...DEFAULTS.voice, ...(user.voice || {}) },
  limits: { ...DEFAULTS.limits, ...(user.limits || {}) },
  backgrounds: { ...DEFAULTS.backgrounds, ...(user.backgrounds || {}) },
  music: { ...DEFAULTS.music, ...(user.music || {}) },
  schedule: { ...DEFAULTS.schedule, ...(user.schedule || {}) },
  instagram: { ...DEFAULTS.instagram, ...(user.instagram || {}) },
  safety: { ...DEFAULTS.safety, ...(user.safety || {}) },
  channel: { ...DEFAULTS.channel, ...(user.channel || {}) },
};

const env = process.env;

const paths = {
  root: ROOT,
  output: path.join(ROOT, 'output'),
  data: path.join(ROOT, 'data'),
  tmp: path.join(ROOT, 'assets', 'tmp'),
  fonts: path.join(ROOT, 'assets', 'fonts'),
  bgm: path.join(ROOT, 'assets', 'bgm'),
  music: path.join(ROOT, 'assets', 'music'),
  backgrounds: path.join(ROOT, config.backgrounds.folder || 'assets/backgrounds'),
};

module.exports = {
  ROOT,
  config,
  env,
  paths,
  isDryRun: String(env.DRY_RUN || '0') === '1',
  llm: {
    baseUrl: (env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: env.LLM_API_KEY || '',
    models: (env.LLM_MODEL || 'gpt-4o-mini')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
  },
};

'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { EdgeTTS } = require('node-edge-tts');
const { config, paths } = require('./config');
const { log, probeDuration, ensureDir, sleep } = require('./util');

const cacheDir = () => ensureDir(path.join(paths.tmp, 'cache'));

function cacheKey(text, voice, rate, pitch) {
  return crypto
    .createHash('sha1')
    .update(`${voice}|${rate}|${pitch}|${text}`)
    .digest('hex')
    .slice(0, 20);
}

const VOICE_LANG = {
  'hi-IN': 'hi-IN',
  'en-IN': 'en-IN',
  'en-US': 'en-US',
};

function langFor(voice) {
  const prefix = String(voice).split('-').slice(0, 2).join('-');
  return VOICE_LANG[prefix] || 'hi-IN';
}

async function synthOnce(text, outPath, opts) {
  const tts = new EdgeTTS({
    voice: opts.voice,
    lang: langFor(opts.voice),
    outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
    rate: opts.rate,
    pitch: opts.pitch,
    timeout: 30000,
  });
  await tts.ttsPromise(text, outPath);
  const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  if (size < 1000) throw new Error('TTS returned empty audio');
  return size;
}

async function synthLine(text, outPath, opts = {}) {
  const voice = opts.voice || config.voice.name;
  const rate = opts.rate || config.voice.rate || 'default';
  const pitch = opts.pitch || config.voice.pitch || 'default';

  // Reuse audio for identical text so re-renders and retries never re-hit the service.
  const cached = path.join(cacheDir(), `${cacheKey(text, voice, rate, pitch)}.mp3`);
  if (fs.existsSync(cached) && fs.statSync(cached).size > 1000) {
    fs.copyFileSync(cached, outPath);
    return await probeDuration(outPath);
  }

  let lastErr;
  const backoff = [4000, 12000, 30000, 60000];
  for (let attempt = 1; attempt <= backoff.length + 1; attempt++) {
    try {
      await synthOnce(text, outPath, { voice, rate, pitch });
      fs.copyFileSync(outPath, cached);
      return await probeDuration(outPath);
    } catch (e) {
      lastErr = e;
      const wait = backoff[attempt - 1] || 0;
      if (attempt <= backoff.length) {
        log.warn(`TTS attempt ${attempt} failed (${e.message}) - retry in ${wait / 1000}s`);
        await sleep(wait);
      }
    }
  }
  throw new Error(`TTS failed: ${lastErr?.message}`);
}

/**
 * Synthesise every line, then lay them out on one timeline.
 * Returns { files: [{path,start,end,duration}], total }
 */
async function synthScript(script, workDir) {
  ensureDir(workDir);
  const LEAD_IN = 0.35;
  const GAP = 0.18;

  const files = [];
  let cursor = LEAD_IN;

  for (let i = 0; i < script.lines.length; i++) {
    const line = script.lines[i];
    const out = path.join(workDir, `line-${String(i).padStart(2, '0')}.mp3`);
    const duration = await synthLine(line.hi, out);
    files.push({ path: out, text: line.caption, start: cursor, duration, end: cursor + duration });
    cursor += duration + GAP;
    log.info(`line ${i + 1}: ${duration.toFixed(2)}s`);
  }

  const total = files[files.length - 1].end + (config.video.tailSeconds || 0.7);
  return { files, total };
}

module.exports = { synthScript, synthLine };

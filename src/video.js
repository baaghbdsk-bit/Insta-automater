'use strict';
/**
 * Pre-publish validation. A bad file burns Instagram publishing quota and
 * shows up as a failed container minutes later, so everything is checked
 * locally first.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FFMPEG, FFPROBE, run } = require('./util');
const { config, env } = require('./config');

async function probe(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-show_streams',
    '-show_format',
    '-of', 'json',
    file,
  ]);
  return JSON.parse(stdout);
}

/** True when the `moov` atom precedes `mdat` (i.e. the file is faststart). */
function faststart(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(1024 * 1024);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    let off = 0;
    const order = [];
    while (off + 8 <= read && order.length < 12) {
      let size = head.readUInt32BE(off);
      const type = head.toString('ascii', off + 4, off + 8);
      let headerSize = 8;
      if (size === 1) {
        if (off + 16 > read) break;
        size = Number(head.readBigUInt64BE(off + 8));
        headerSize = 16;
      } else if (size === 0) {
        size = read - off;
      }
      if (size < headerSize) break;
      order.push(type);
      off += size;
    }
    const m = order.indexOf('moov');
    const d = order.indexOf('mdat');
    return m !== -1 && (d === -1 || m < d);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Returns { ok, reasons, info }. `reasons` is always populated on failure and
 * is safe to print in a public log.
 */
async function validateVideo(file, opts = {}) {
  const W = opts.width || config.video.width;
  const H = opts.height || config.video.height;
  const minS = opts.minSeconds ?? 7;
  const maxS = opts.maxSeconds ?? 18;
  const reasons = [];

  if (!file || !fs.existsSync(file)) {
    return { ok: false, reasons: ['file does not exist'], info: null };
  }
  const bytes = fs.statSync(file).size;
  if (bytes < 150 * 1024) reasons.push(`file too small (${bytes} bytes)`);
  if (bytes > 100 * 1024 * 1024) reasons.push(`file too large for the Graph API (${bytes} bytes)`);

  let data;
  try {
    data = await probe(file);
  } catch (e) {
    return { ok: false, reasons: [`ffprobe failed: ${String(e.message).slice(0, 160)}`], info: null };
  }

  const streams = data.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  if (!video) reasons.push('no video stream');
  else {
    if (video.width !== W || video.height !== H) {
      reasons.push(`resolution ${video.width}x${video.height}, expected ${W}x${H}`);
    }
    if (!/h264/i.test(video.codec_name || '')) reasons.push(`codec ${video.codec_name}, expected h264`);
    if (video.pix_fmt !== 'yuv420p' && video.pix_fmt !== 'yuvj420p') {
      reasons.push(`pix_fmt ${video.pix_fmt}, expected yuv420p`);
    }
  }
  if (!audio) reasons.push('no audio stream');
  else if (!/aac/i.test(audio.codec_name || '')) reasons.push(`audio codec ${audio.codec_name}, expected aac`);

  const duration = Number(data.format && data.format.duration);
  if (!Number.isFinite(duration)) reasons.push('unreadable duration');
  else if (duration < minS || duration > maxS) {
    reasons.push(`duration ${duration.toFixed(2)}s outside ${minS}-${maxS}s`);
  }

  if (!faststart(file)) reasons.push('moov atom is not at the front (missing +faststart)');

  return {
    ok: reasons.length === 0,
    reasons,
    info: {
      bytes,
      duration,
      width: video && video.width,
      height: video && video.height,
      fps: video && video.r_frame_rate,
      videoCodec: video && video.codec_name,
      audioCodec: audio && audio.codec_name,
      bitrate: Number(data.format && data.format.bit_rate) || null,
    },
  };
}

/**
 * Optional Gemini Vision frame check for text-over-photo contrast, 9:16 safe-zone
 * clearance, and visual defects. Skips gracefully when LLM_API_KEY is unset.
 */
async function checkVisualQuality(file, durationSeconds = 10) {
  const apiKey = env.LLM_API_KEY || process.env.LLM_API_KEY || '';
  if (!apiKey || !file || !fs.existsSync(file)) {
    return { ok: true, skipped: true };
  }
  const mid = Math.max(0.5, Number(durationSeconds || 10) * 0.5).toFixed(2);
  const tmpPng = path.join(os.tmpdir(), `reel-vqa-${Date.now()}.png`);
  try {
    await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', mid, '-i', file, '-vframes', '1', tmpPng]);
    if (!fs.existsSync(tmpPng)) return { ok: true, skipped: true };
    const b64 = fs.readFileSync(tmpPng).toString('base64');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              text: 'Audit this 1080x1920 quote Reel frame. Score 0-100 on text legibility, photo contrast, 9:16 safe-zone margins, and visual polish. List any critical_defects (unreadable text, clipped words, glaring artifacts). Return ONLY JSON: {"score": <int>, "critical_defects": [<strings>], "summary": "<1-line>"}',
            },
            { inline_data: { mime_type: 'image/png', data: b64 } },
          ],
        }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) return { ok: true, skipped: true };
    const data = await res.json();
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(txt);
    const score = Number(parsed.score || 0);
    const defects = Array.isArray(parsed.critical_defects) ? parsed.critical_defects.filter(Boolean) : [];
    return { ok: score >= 75 && defects.length === 0, score, critical_defects: defects, summary: parsed.summary || '' };
  } catch {
    return { ok: true, skipped: true };
  } finally {
    fs.rmSync(tmpPng, { force: true });
  }
}

module.exports = { validateVideo, checkVisualQuality, probe, faststart };

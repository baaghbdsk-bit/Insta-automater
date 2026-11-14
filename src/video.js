'use strict';
/**
 * Pre-publish validation. A bad file burns Instagram publishing quota and
 * shows up as a failed container minutes later, so everything is checked
 * locally first.
 */
const fs = require('node:fs');
const { FFPROBE, run } = require('./util');
const { config } = require('./config');

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
    if (video.pix_fmt !== 'yuv420p') reasons.push(`pix_fmt ${video.pix_fmt}, expected yuv420p`);
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

module.exports = { validateVideo, probe, faststart };

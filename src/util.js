'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ffmpegPath = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

// CI images ship ffmpeg built with libass; the static npm build is only a
// fallback for machines without a system install. Both are overridable.
const FFMPEG = process.env.FFMPEG_PATH || ffmpegPath;
const FFPROBE = process.env.FFPROBE_PATH || ffprobeStatic.path;

const COLORS = {
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
};

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

const log = {
  info: (...a) => console.log(`${COLORS.dim}${stamp()}${COLORS.reset} ${a.join(' ')}`),
  ok: (...a) => console.log(`${COLORS.dim}${stamp()}${COLORS.reset} ${COLORS.green}ok${COLORS.reset} ${a.join(' ')}`),
  warn: (...a) => console.log(`${COLORS.dim}${stamp()}${COLORS.reset} ${COLORS.yellow}warn${COLORS.reset} ${a.join(' ')}`),
  error: (...a) => console.log(`${COLORS.dim}${stamp()}${COLORS.reset} ${COLORS.red}err${COLORS.reset} ${a.join(' ')}`),
  step: (...a) => console.log(`${COLORS.dim}${stamp()}${COLORS.reset} ${COLORS.cyan}->${COLORS.reset} ${a.join(' ')}`),
};

function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { maxBuffer: 1024 * 1024 * 64, windowsHide: true, ...opts },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          return reject(err);
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

async function probeDuration(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    file,
  ]);
  const n = parseFloat(String(stdout).trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Could not read duration of ${file}`);
  return n;
}

async function probeSize(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0:s=x',
    file,
  ]);
  const [w, h] = String(stdout).trim().split('x').map(Number);
  return { width: w, height: h };
}

function slug(s, max = 48) {
  const base = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, max)
    .replace(/^-+|-+$/g, '');
  // Devanagari titles slugify to almost nothing; add a hash so files never collide.
  if (base.length >= 12) return base;
  const hash = require('node:crypto').createHash('sha1').update(String(s)).digest('hex').slice(0, 6);
  return base ? `${base}-${hash}` : `post-${hash}`;
}

function wrapText(text, maxChars, maxLines = 3) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/[.,;:]$/, '') + '…';
    return kept;
  }
  return lines;
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);

function listFiles(dir, exts) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => exts.has(path.extname(f).toLowerCase()))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

module.exports = {
  FFMPEG,
  FFPROBE,
  log,
  run,
  sleep,
  ensureDir,
  probeDuration,
  probeSize,
  slug,
  wrapText,
  listFiles,
  IMAGE_EXT,
};

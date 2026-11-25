'use strict';
/**
 * The music bed, measured instead of guessed.
 *
 * Three problems this module fixes:
 *
 *   1. Loudness was set by `loudnorm` in single pass, which is dynamic mode: on
 *      a ten-second clip it keeps adapting inside the clip, so the bed pumps.
 *      Two-pass did not help enough on this pool - 12 of 15 beds have 13-18 dB
 *      of crest and cannot reach -14 LUFS at -2 dBTP without limiting, so
 *      loudnorm fell back to dynamic anyway and landed between -16.4 and -12.8.
 *      A measured static gain plus a lookahead limiter is fixed for the whole
 *      clip and lands every bed within 1.5 dB of -14.
 *   2. The beds sit up to 30 dB apart in source level. Boosting a sparse piano
 *      track by 25 dB brings its noise floor with it, so the audit reports the
 *      real number before a file reaches a render.
 *   3. Starting at the first non-silent sample still lands inside a slow swell:
 *      five-armies is 13 dB quieter in its first two seconds than its body, which
 *      reads as dead air on a Short. The start is now chosen by energy.
 */

const fs = require('node:fs');
const path = require('node:path');
const { paths } = require('./config');
const { FFMPEG, run, ensureDir, probeDuration } = require('./util');

const RATE = 8000;
const TARGET_I = -14;
// -2 dBTP leaves room for AAC overshoot; -1.5 lands at about -1.3 after encode.
const TARGET_TP = -2;
const TARGET_LRA = 11;

/** Trailer beds carry sub-bass that turns to mud on a phone speaker. */
const HIGH_PASS = 'highpass=f=95:poles=2';
const LOW_SHELF = 'lowshelf=f=160:g=-2.5';
const EQ = `${HIGH_PASS},${LOW_SHELF}`;

/** Peak ceiling as a linear amplitude: 0.794 is -2 dBFS. */
const LIMIT = Number((10 ** (TARGET_TP / 20)).toFixed(3));
const LIMITER = `alimiter=limit=${LIMIT}:attack=5:release=50:level=false:latency=true`;

/** Most peak reduction we will ask the limiter for before backing off. */
const MAX_REDUCTION = 6;

/**
 * Static gain that puts the segment at -14 LUFS, clamped so the limiter never
 * has to remove more than `maxReduction` dB of peaks. Dynamic material stops a
 * little below target instead of being squashed to reach it.
 */
function gainFor(measured, { integrated = TARGET_I, truePeak = TARGET_TP, maxReduction = MAX_REDUCTION } = {}) {
  if (!measured) return null;
  if (!Number.isFinite(measured.i) || !Number.isFinite(measured.tp)) return null;
  return Math.min(integrated - measured.i, truePeak - measured.tp + maxReduction);
}

function rmsDb(samples, from, to) {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += samples[i] * samples[i];
  const n = Math.max(1, to - from);
  return 20 * Math.log10(Math.sqrt(sum / n) + 1e-9);
}

/**
 * First half-second that is not a quiet intro. `dropDb` is how far below the
 * track's own median a window may sit and still count as "the music has
 * started"; `floorDb` keeps a near-silent file from starting at 0 by accident.
 */
function firstEnergeticWindow(samples, rate = RATE, { window = 0.5, dropDb = 8, floorDb = -45 } = {}) {
  const size = Math.max(1, Math.round(rate * window));
  const dbs = [];
  for (let i = 0; i + size <= samples.length; i += size) dbs.push(rmsDb(samples, i, i + size));
  if (!dbs.length) return 0;

  const sorted = dbs.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = Math.max(median - dropDb, floorDb);
  const idx = dbs.findIndex((db) => db >= threshold);
  return idx <= 0 ? 0 : Number((idx * window).toFixed(2));
}

/** Decode the head of a track to mono float samples, for onset detection. */
async function decode(file, seconds = 30, rate = RATE) {
  const out = path.join(ensureDir(paths.tmp), `mix-${process.pid}-${Date.now()}.f32`);
  try {
    await run(
      FFMPEG,
      ['-v', 'error', '-t', String(seconds), '-i', file, '-ac', '1', '-ar', String(rate), '-f', 'f32le', out],
      { timeout: 120_000 }
    );
    const buf = fs.readFileSync(out);
    const usable = buf.length - (buf.length % 4);
    const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable);
    return new Float32Array(copy);
  } finally {
    fs.rmSync(out, { force: true });
  }
}

/** Where the clip should start, in seconds. Falls back to 0 on any failure. */
async function pickStart(file, opts = {}) {
  if (!file || !fs.existsSync(file)) return 0;
  try {
    const samples = await decode(file, opts.scan ?? 30);
    return firstEnergeticWindow(samples, RATE, opts);
  } catch {
    return 0;
  }
}

/**
 * Integrated loudness and true peak of the exact segment that will be used,
 * measured after the EQ that will be applied. Returns null when the measurement
 * is unusable (silent file, ffmpeg failure) so the caller can fall back.
 */
async function measure(file, { start = 0, duration = 12, pre = EQ } = {}) {
  try {
    const { stderr } = await run(
      FFMPEG,
      [
        '-hide_banner', '-nostats',
        '-ss', String(start), '-t', String(duration),
        '-i', file,
        '-af', `${pre ? `${pre},` : ''}loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:print_format=json`,
        '-f', 'null', '-',
      ],
      { timeout: 120_000 }
    );
    const text = String(stderr);
    const from = text.lastIndexOf('{');
    const json = JSON.parse(text.slice(from, text.indexOf('}', from) + 1));
    const out = { i: Number(json.input_i), tp: Number(json.input_tp) };
    return Number.isFinite(out.i) && Number.isFinite(out.tp) ? out : null;
  } catch {
    return null;
  }
}

/**
 * The bed chain shared by the first render and the YouTube retrack.
 *
 * Loudness is fixed with a static gain plus a lookahead limiter, not with
 * `loudnorm`. Measured on this pool, loudnorm's two-pass still fell back to its
 * dynamic mode on 12 of 15 beds (crest 13-18 dB cannot reach -14 LUFS at
 * -2 dBTP without limiting), which left outputs between -16.4 and -12.8 LUFS.
 * Gain + limiter lands every one of them within 1.5 dB of -14 and never
 * re-decides the level mid-clip.
 */
function bedFilter({ total, measured = null, fadeIn = 0.12, fadeOut = 0.35, trim = true }) {
  const parts = [];
  if (trim) parts.push(`atrim=0:${Number(total).toFixed(2)}`, 'asetpts=PTS-STARTPTS');
  parts.push(HIGH_PASS, LOW_SHELF);

  const gain = gainFor(measured);
  if (gain === null) {
    // No measurement: fall back to the old single pass rather than silence.
    parts.push(`loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=${TARGET_LRA}`);
  } else {
    parts.push(`volume=${gain.toFixed(2)}dB`, LIMITER);
  }

  parts.push(`afade=t=in:st=0:d=${fadeIn}`);
  parts.push(`afade=t=out:st=${Math.max(0, Number(total) - fadeOut).toFixed(2)}:d=${fadeOut}`);
  parts.push('aresample=48000');
  return parts.join(',');
}

async function levels(file, start, seconds) {
  const { stderr } = await run(
    FFMPEG,
    [
      '-hide_banner', '-nostats',
      '-ss', String(start), '-t', String(seconds),
      '-i', file,
      '-af', 'volumedetect',
      '-f', 'null', '-',
    ],
    { timeout: 120_000 }
  );
  const mean = /mean_volume:\s*(-?[\d.]+)/.exec(String(stderr));
  const peak = /max_volume:\s*(-?[\d.]+)/.exec(String(stderr));
  return { mean: mean ? Number(mean[1]) : NaN, peak: peak ? Number(peak[1]) : NaN };
}

function verdictFor(a) {
  if (Number.isFinite(a.peak) && a.peak > -0.5) return 'clipping';
  if (Number.isFinite(a.gap) && a.gap < -6) return `weak hook (${a.gap.toFixed(1)} dB)`;
  if (Number.isFinite(a.source) && a.source < -35) return `quiet source (${(TARGET_I - a.source).toFixed(0)} dB gain)`;
  if (a.duration && a.duration < 45) return 'short: loops inside a clip';
  return 'ok';
}

/** Everything the audit command prints, in one pass. */
async function audit(file) {
  const duration = await probeDuration(file).catch(() => 0);
  const start = await pickStart(file);
  const span = Math.min(12, duration || 12);
  const [hook, body, source] = await Promise.all([
    levels(file, start, Math.min(2, span)),
    levels(file, start, span),
    levels(file, 0, span),
  ]);
  const out = {
    duration,
    start,
    hook: hook.mean,
    body: body.mean,
    source: source.mean,
    peak: body.peak,
    gap: hook.mean - body.mean,
  };
  out.verdict = verdictFor(out);
  return out;
}

module.exports = {
  pickStart,
  measure,
  gainFor,
  bedFilter,
  audit,
  levels,
  firstEnergeticWindow,
  verdictFor,
  TARGET_I,
  TARGET_TP,
};

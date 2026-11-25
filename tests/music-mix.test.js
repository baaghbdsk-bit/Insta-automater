'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mix = require('../src/music-mix');

/** Build mono float samples: a quiet stretch followed by a loud one. */
function ramp(rate, quietSeconds, loudSeconds, quietDb = -45, loudDb = -14) {
  const amp = (db) => 10 ** (db / 20);
  const out = new Float32Array(Math.round(rate * (quietSeconds + loudSeconds)));
  const edge = Math.round(rate * quietSeconds);
  for (let i = 0; i < out.length; i += 1) {
    const a = i < edge ? amp(quietDb) : amp(loudDb);
    out[i] = i % 2 === 0 ? a : -a; // alternating sign keeps the RMS predictable
  }
  return out;
}

test('start point skips a quiet intro and lands on the music', () => {
  const rate = 8000;
  const samples = ramp(rate, 3, 5);
  const start = mix.firstEnergeticWindow(samples, rate);
  assert.ok(start >= 2.5 && start <= 3.5, `expected ~3s, got ${start}`);
});

test('start point stays at zero when the track opens at full level', () => {
  const rate = 8000;
  const samples = ramp(rate, 0, 6);
  assert.equal(mix.firstEnergeticWindow(samples, rate), 0);
});

test('start point never runs past the decoded samples', () => {
  const rate = 8000;
  const samples = ramp(rate, 1, 1);
  const start = mix.firstEnergeticWindow(samples, rate);
  assert.ok(start >= 0 && start < 2, `got ${start}`);
});

test('empty audio falls back to zero instead of throwing', () => {
  assert.equal(mix.firstEnergeticWindow(new Float32Array(0), 8000), 0);
});

test('gain targets -14 LUFS when the peaks allow it', () => {
  assert.equal(mix.gainFor({ i: -20, tp: -6 }), 6);
});

test('gain backs off instead of squashing dynamic material', () => {
  // Crest 20 dB: reaching -14 would need +8 dB and more than 6 dB of peak
  // reduction, so the limiter is capped and the bed lands a little quiet.
  assert.equal(mix.gainFor({ i: -22, tp: -2 }), 6);
});

test('gain is null when the measurement is missing', () => {
  assert.equal(mix.gainFor(null), null);
  assert.equal(mix.gainFor({ i: NaN, tp: -3 }), null);
});

test('bed chain trims, cleans the low end, gains, limits and fades in that order', () => {
  const chain = mix.bedFilter({ total: 12, measured: { i: -20, tp: -6 } });
  const order = [
    'atrim=0:12.00',
    'highpass=f=95',
    'lowshelf=f=160',
    'volume=6.00dB',
    'alimiter=limit=0.794',
    'afade=t=in',
    'afade=t=out:st=11.65',
    'aresample=48000',
  ];
  let at = -1;
  for (const part of order) {
    const idx = chain.indexOf(part);
    assert.ok(idx > at, `${part} is out of order in ${chain}`);
    at = idx;
  }
});

test('bed chain falls back to loudnorm without a measurement', () => {
  const chain = mix.bedFilter({ total: 12, measured: null });
  assert.match(chain, /loudnorm=I=-14:TP=-2/);
  assert.ok(!chain.includes('alimiter'));
});

test('retrack chain leaves trimming to -t', () => {
  const chain = mix.bedFilter({ total: 12, measured: { i: -20, tp: -6 }, trim: false });
  assert.ok(!chain.includes('atrim='), chain);
  assert.ok(chain.includes('afade=t=out'));
});

test('verdicts name the actual problem', () => {
  assert.equal(mix.verdictFor({ peak: -1.2, gap: 0, source: -20, duration: 120 }), 'ok');
  assert.match(mix.verdictFor({ peak: -0.1, gap: 0, source: -20, duration: 120 }), /clipping/);
  assert.match(mix.verdictFor({ peak: -1.2, gap: -9, source: -20, duration: 120 }), /weak hook/);
  assert.match(mix.verdictFor({ peak: -1.2, gap: 0, source: -40, duration: 120 }), /quiet source/);
  assert.match(mix.verdictFor({ peak: -1.2, gap: 0, source: -20, duration: 30 }), /short/);
});

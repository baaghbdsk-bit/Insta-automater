'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { layout, VARIANTS, motionExpressions } = require('../src/quote');

const W = 1080;

test('layout never returns more than four lines', () => {
  const samples = [
    'Chhota sa jumla.',
    'Kisi ko itna pyar mat do ki woh tumhari kamzori ban jaye.',
    'a '.repeat(120),
    'Jo roz 1% sudhar gaya, woh saal mein 37 guna badh gaya, aur usne kabhi shikayat nahi ki.',
  ];
  for (const text of samples) {
    const out = layout(text, W);
    assert.ok(out.lines.length >= 1 && out.lines.length <= 4, `got ${out.lines.length} lines`);
    assert.ok(out.size >= 72 && out.size <= 120, `font ${out.size}`);
    for (const l of out.lines) assert.ok(l.length > 0);
  }
});

test('layout shrinks the font as the quote grows', () => {
  const short = layout('Din kharab tha, zindagi nahi.', W);
  const long = layout(
    'Tum woh nahi ho jo log bolte hain, tum woh ho jo tum roz karte ho, aur yahi sabse bada sach hai.',
    W
  );
  assert.ok(long.size <= short.size);
});

test('every visual variant resolves to a distinct vertical position', () => {
  const keys = Object.keys(VARIANTS);
  assert.deepEqual(keys.sort(), ['center', 'lower', 'upper']);
  assert.ok(VARIANTS.upper < VARIANTS.center);
  assert.ok(VARIANTS.center < VARIANTS.lower);
});

test('motion expressions stay inside the frame', () => {
  const moves = motionExpressions(360);
  assert.equal(moves.length, 5);
  for (const m of moves) {
    assert.ok(!/undefined|NaN/.test(m.x), m.x);
    assert.ok(!/undefined|NaN/.test(m.y), m.y);
  }
});

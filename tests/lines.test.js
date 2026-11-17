'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const lines = require('../src/lines');

test('normalise strips case, punctuation and spacing', () => {
  assert.equal(lines.normalise('Tumse   Pyaar, Hoga!'), 'tumse pyaar hoga');
});

test('similar catches paraphrases but not distinct lines', () => {
  assert.equal(
    lines.similar(
      'Kisi ko itna pyar mat do ki woh tumhari kamzori ban jaye',
      'Kisi ko itna pyar mat karo ki woh tumhari kamzori ban jaye'
    ),
    true
  );
  assert.equal(
    lines.similar('Maa-baap ke alawa koi free nahi', 'Neend aur focus ek hi cheez chura rahe hain'),
    false
  );
});

test('isCliche rejects the generic motivational vocabulary', () => {
  assert.equal(lines.isCliche('Never give up on your dreams'), true);
  assert.equal(lines.isCliche('Believe in yourself and stay strong'), true);
  assert.equal(lines.isCliche('Jo tumhare bina khush hai, uske liye tum aadat the'), false);
});

test('moodOf maps every theme to a real music pool', () => {
  assert.equal(lines.moodOf('heartbreak'), 'heartbreak');
  assert.equal(lines.moodOf('loneliness'), 'heartbreak');
  assert.equal(lines.moodOf('discipline'), 'growth');
  assert.equal(lines.moodOf('nope'), 'motivation');
});

test('seed bank has no exact duplicates', () => {
  for (const [mood, bank] of Object.entries(lines.SEED)) {
    const norms = bank.map(lines.normalise);
    assert.equal(new Set(norms).size, norms.length, `${mood} contains a duplicate line`);
  }
});

test('seed lines are Roman script and within reel length', () => {
  for (const [mood, bank] of Object.entries(lines.SEED)) {
    for (const line of bank) {
      assert.ok(!/[\u0900-\u097F]/.test(line), `${mood}: Devanagari in "${line}"`);
      assert.ok(line.length <= 118, `${mood}: line too long (${line.length})`);
      assert.ok(line.length >= 18, `${mood}: line too short (${line.length})`);
    }
  }
});

test('patternSignature groups structurally identical lines', () => {
  const a = lines.patternSignature('You are not stuck. You are comfortable.');
  const b = lines.patternSignature('You are not late. You are patient.');
  assert.equal(a, b, 'same skeleton should share a signature');

  const c = lines.patternSignature('She read the message twice and put the phone face down.');
  assert.notEqual(a, c, 'a different skeleton must not collide');
});

test('conceptSimilar flags a reused idea in fresh words', () => {
  assert.equal(
    lines.conceptSimilar(
      'The apology was for their guilt. You were just standing in the room.',
      'Their apology was guilt, you were the room.'
    ),
    true
  );
  assert.equal(
    lines.conceptSimilar(
      'The apology was for their guilt. You were just standing in the room.',
      'Your discipline decides how the next five years look.'
    ),
    false
  );
});

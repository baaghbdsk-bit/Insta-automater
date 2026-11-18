'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bank = require('../src/quote-bank');
const { MUSIC_MOODS } = require('../src/themes');

test('bank loads 550 unique lines with no validation problems', () => {
  const raw = bank.load();
  assert.equal(raw.lines.length, 550);
  assert.equal(new Set(raw.lines.map((l) => l.id)).size, 550);
  assert.deepEqual(bank.problems(), []);
});

test('every line is approved - no rating or attribution filter', () => {
  const all = bank.load().lines;
  assert.ok(all.every((l) => l.status === 'approved'));
  assert.ok(all.some((l) => l.score === null), 'unrated lines are present');
  assert.ok(all.some((l) => (l.score || 10) <= 4), 'low-rated lines are present');
  assert.ok(all.some((l) => l.flags.includes('attribution')), 'flagged lines are present');
});

test('every mood has approved lines and picks come from the requested mood', () => {
  for (const mood of MUSIC_MOODS) {
    assert.ok(bank.approved(mood).length > 0, `${mood} has no approved line`);
    const pick = bank.pick('motivation', mood);
    assert.ok(pick, `${mood} pick returned nothing`);
    assert.equal(pick.mood, mood);
    assert.equal(pick.status, 'approved');
    assert.ok(pick.line.length >= 18 && pick.line.length <= 220);
  }
});

test('random pick varies across repeated calls', () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(bank.pick('growth', 'growth').id);
  assert.ok(seen.size > 5, `expected varied picks, got ${seen.size}`);
});

test('report exposes counts, mood coverage and validation', () => {
  const r = bank.report();
  assert.equal(r.total, 550);
  assert.equal(r.byStatus.approved, 550);
  assert.equal(Object.keys(r.byMood).length, 3);
  assert.equal(r.selection, 'random');
  assert.deepEqual(r.problems, []);
});

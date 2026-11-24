'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bank = require('../src/quote-bank');
const { MUSIC_MOODS } = require('../src/themes');

test('bank loads 1190 unique lines with no validation problems', () => {
  const raw = bank.load();
  assert.equal(raw.lines.length, 1190);
  assert.equal(new Set(raw.lines.map((l) => l.id)).size, 1190);
  assert.deepEqual(bank.problems(), []);
});

test('every line is approved - no rating or attribution filter', () => {
  const all = bank.load().lines;
  assert.ok(all.every((l) => l.status === 'approved'));
  assert.ok(all.some((l) => l.score === null), 'unrated lines are present');
  assert.ok(all.some((l) => (l.score || 10) <= 4), 'low-rated lines are present');
  assert.ok(all.some((l) => l.flags.includes('attribution')), 'flagged lines are present');
  assert.ok(all.some((l) => l.author && l.author !== 'Unknown'), 'attributed lines are present');
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

test('sequential pick holds the next line until it is marked used', () => {
  const a = bank.pick('growth', 'growth');
  const b = bank.pick('growth', 'growth');
  assert.ok(a);
  assert.equal(a.id, b.id);
});

test('report exposes counts, mood coverage and validation', () => {
  const r = bank.report();
  assert.equal(r.total, 1190);
  assert.equal(r.byStatus.approved, 1190);
  assert.equal(Object.keys(r.byMood).length, 3);
  assert.equal(r.selection, 'sequential');
  assert.deepEqual(r.problems, []);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bank = require('../src/quote-bank');
const { MUSIC_MOODS } = require('../src/themes');

test('bank loads 1208 unique lines with no validation problems', () => {
  const raw = bank.load();
  assert.equal(raw.lines.length, 1208);
  assert.equal(new Set(raw.lines.map((l) => l.id)).size, 1208);
  assert.deepEqual(bank.problems(), []);
});

test('approved lines keep no rating or attribution filter', () => {
  const approved = bank.approved();
  assert.ok(approved.some((l) => l.score === null), 'unrated lines are present');
  assert.ok(approved.some((l) => (l.score || 10) <= 4), 'low-rated lines are present');
  assert.ok(approved.some((l) => l.flags.includes('attribution')), 'flagged lines are present');
});

test('held classics keep their author so a retest still renders a byline', () => {
  const held = bank.load().lines.filter((l) => l.status === 'held');
  assert.ok(held.some((l) => l.author && l.author !== 'Unknown'), 'held classics are attributed');
});

test('batch 15 is interleaved into the rotation, not appended to it', () => {
  const all = bank.load().lines;
  const fresh = all.filter((l) => l.batch === 15);
  assert.equal(fresh.length, 18);
  assert.ok(fresh.every((l) => l.status === 'approved'));

  for (const mood of MUSIC_MOODS) {
    const seq = all.filter((l) => l.status === 'approved' && l.mood === mood);
    const at = seq.reduce((acc, l, i) => (l.batch === 15 ? [...acc, i] : acc), []);
    assert.ok(at.length > 0, `${mood} has no batch 15 line`);
    assert.ok(at[0] < seq.length * 0.4, `${mood}: first new line is buried at ${at[0]}/${seq.length}`);
    for (let i = 1; i < at.length; i += 1) {
      assert.ok(at[i] - at[i - 1] >= 2, `${mood}: new lines are clustered at ${at[i - 1]}-${at[i]}`);
    }
  }
});

test('the imported classics stay held until they earn a retest', () => {
  const all = bank.load().lines;
  const held = all.filter((l) => l.status === 'held');
  assert.equal(held.length, 448);
  assert.ok(held.every((l) => l.batch === 14), 'only batch 14 is held');
  assert.ok(all.every((l) => l.status === 'approved' || l.status === 'held'));
  assert.ok(!bank.approved().some((l) => l.batch === 14), 'held classics are never picked');
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
  assert.equal(r.total, 1208);
  assert.equal(r.byStatus.approved, 760);
  assert.equal(r.byStatus.held, 448);
  assert.equal(Object.keys(r.byMood).length, 3);
  assert.equal(r.selection, 'sequential');
  assert.deepEqual(r.problems, []);
  assert.equal(r.held.length, 448);
});

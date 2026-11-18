'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bank = require('../src/quote-bank');
const { MUSIC_MOODS } = require('../src/themes');

test('bank loads with unique ids and no validation problems', () => {
  const raw = bank.load();
  assert.equal(raw.lines.length, 50);
  assert.equal(new Set(raw.lines.map((l) => l.id)).size, 50);
  assert.deepEqual(bank.problems(), []);
});

test('only approved lines are served, and held lines stay in the file', () => {
  const raw = bank.load();
  const approved = bank.approved();
  assert.equal(approved.length, 29);
  assert.ok(approved.every((l) => l.status === 'approved'));
  assert.equal(raw.lines.filter((l) => l.status === 'held').length, 21);
});

test('every mood has approved lines and picks come from the requested mood', () => {
  for (const mood of MUSIC_MOODS) {
    assert.ok(bank.approved(mood).length > 0, `${mood} has no approved line`);
    const pick = bank.pick('motivation', mood);
    assert.ok(pick, `${mood} pick returned nothing`);
    assert.equal(pick.mood, mood);
    assert.equal(pick.status, 'approved');
    assert.ok(pick.line.length >= 18 && pick.line.length <= 160);
  }
});

test('attribution and low-score lines are held, not published', () => {
  const held = bank.load().lines.filter((l) => l.status === 'held');
  assert.ok(held.some((l) => l.flags.includes('attribution')));
  assert.ok(held.every((l) => l.score < 6 || l.flags.length > 0));
});

test('report exposes status, mood coverage, cooldown and problems', () => {
  const r = bank.report();
  assert.equal(r.total, 50);
  assert.equal(r.byStatus.approved, 29);
  assert.equal(Object.keys(r.byMood).length, 3);
  assert.ok(r.cooldownDays >= 0);
  assert.deepEqual(r.problems, []);
});

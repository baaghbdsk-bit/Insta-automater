'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { THEMES, THEME_KEYS, MUSIC_MOODS, VISUAL_VARIANTS } = require('../src/themes');
const { validateVideo } = require('../src/video');
const store = require('../src/db');

test('every theme is complete', () => {
  assert.ok(THEME_KEYS.length >= 14, `only ${THEME_KEYS.length} themes`);
  for (const key of THEME_KEYS) {
    const t = THEMES[key];
    assert.ok(MUSIC_MOODS.includes(t.music), `${key}: bad music pool ${t.music}`);
    assert.ok(t.tone && t.tone.length > 10, `${key}: missing tone`);
    assert.ok(Array.isArray(t.queries) && t.queries.length >= 3, `${key}: too few queries`);
  }
});

test('visual variants cover upper and center safe-zone placements', () => {
  assert.deepEqual(VISUAL_VARIANTS.slice().sort(), ['center', 'upper']);
});

test('validateVideo rejects a missing file without throwing', async () => {
  const res = await validateVideo('assets/definitely-not-here.mp4');
  assert.equal(res.ok, false);
  assert.match(res.reasons.join(' '), /does not exist/);
});

test('validateVideo rejects a non-video file', async () => {
  const res = await validateVideo('package.json');
  assert.equal(res.ok, false);
  assert.ok(res.reasons.length > 0);
});

test('pickAsset prefers unused candidates', () => {
  const chosen = store.pickAsset('test-kind', ['a', 'b', 'c']);
  assert.equal(chosen, 'a');
  assert.equal(store.pickAsset('test-kind', []), null);
});

test('startOfToday is an ISO timestamp at local midnight', () => {
  const iso = store.startOfToday();
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const d = new Date(iso);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
});

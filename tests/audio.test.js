'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const audio = require('../src/audio');

const track = (over = {}) => ({
  audio_id: '123',
  title: 'Alone',
  display_artist: 'Halston Dare',
  duration_in_ms: 224_976,
  download_url: 'https://example.test/preview.mp4',
  ...over,
});

test('every mood has a rotating query list that includes a usable fallback', () => {
  for (const mood of ['heartbreak', 'growth', 'motivation']) {
    const queries = audio.queriesFor(mood);
    assert.ok(queries.length >= 3, `${mood} needs several queries`);
    assert.ok(queries.every((q) => typeof q === 'string' && q.length > 2));
  }
  assert.ok(audio.queriesFor('heartbreak').includes('sad'));
  // Unknown moods must not crash the picker.
  assert.deepEqual(audio.queriesFor('nope'), audio.queriesFor('motivation'));
});

test('queriesFor returns a copy so callers cannot mutate the map', () => {
  const first = audio.queriesFor('growth');
  first.push('mutated');
  assert.ok(!audio.queriesFor('growth').includes('mutated'));
});

test('isUsable drops short tracks, obvious wrong vibes and missing ids', () => {
  assert.equal(audio.isUsable(track(), 'heartbreak'), true);
  assert.equal(audio.isUsable(track({ duration_in_ms: 8_000 }), 'heartbreak'), false);
  assert.equal(audio.isUsable(track({ audio_id: '' }), 'heartbreak'), false);
  // No downloadable preview means YouTube cannot get the same song.
  assert.equal(audio.isUsable(track({ download_url: '' }), 'heartbreak'), false);
  assert.equal(audio.isUsable(track({ title: 'Happy Birthday Song' }), 'heartbreak'), false);
  assert.equal(audio.isUsable(track({ title: 'Kids Nursery Rhyme' }), 'motivation'), false);
  // A party track must not slip through a sad search.
  assert.equal(audio.isUsable(track({ title: 'Dance Party Anthem' }), 'heartbreak'), false);
  assert.equal(audio.isUsable(track({ title: 'Good Vibes' }), 'heartbreak'), false);
  assert.equal(audio.isUsable(track({ title: 'Holiday Bells' }), 'heartbreak'), false);
  // Generic words in the artist name are not a vibe signal on their own.
  assert.equal(audio.isUsable(track({ display_artist: 'Halston Dare' }), 'heartbreak'), true);
});

test('payload is a container-ready audio_configuration with a muted bed', () => {
  const previous = process.env.IG_NATIVE_AUDIO_VIDEO_VOLUME;
  delete process.env.IG_NATIVE_AUDIO_VIDEO_VOLUME;
  try {
    assert.deepEqual(audio.payload({ audioId: '384522768709202' }), {
      audio_id: '384522768709202',
      audio_volume: 100,
      video_volume: 0,
    });
    assert.equal(audio.payload(null), null);
    assert.equal(audio.payload({}), null);
    process.env.IG_NATIVE_AUDIO_VIDEO_VOLUME = '20';
    assert.equal(audio.payload({ audioId: '9' }).video_volume, 20);
  } finally {
    if (previous === undefined) delete process.env.IG_NATIVE_AUDIO_VIDEO_VOLUME;
    else process.env.IG_NATIVE_AUDIO_VIDEO_VOLUME = previous;
  }
});

test('describe names the track and where it came from', () => {
  assert.match(audio.describe({ title: 'Alone', artist: 'Halston Dare', query: 'sad' }), /Alone — Halston Dare \("sad"\)/);
  assert.match(audio.describe({ title: 'X', artist: 'Y', trending: true }), /trending/);
  assert.equal(audio.describe(null), 'embedded music');
});

'use strict';
/**
 * Slow, opt-in test: renders a real 4-second reel end to end.
 * Enable with:  RUN_RENDER_TEST=1 npm test
 * It needs a local photo, a local track and a working ffmpeg with libass.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const enabled = String(process.env.RUN_RENDER_TEST || '') === '1';

test('renders and validates a quote reel', { skip: !enabled, timeout: 180_000 }, async () => {
  const library = require('../src/library');
  const { renderQuote, retrackVideo } = require('../src/quote');
  const { validateVideo } = require('../src/video');
  const { IMAGE_EXT } = require('../src/util');

  const photos = library.walk(library.PHOTOS, IMAGE_EXT);
  assert.ok(photos.length, 'no photos in assets/photos');

  const track = library.pickTrack('motivation');
  const outPath = path.join(os.tmpdir(), `reel-test-${Date.now()}.mp4`);

  await renderQuote({
    image: photos[0],
    text: 'Din kharab tha, zindagi nahi.',
    music: track,
    outPath,
    duration: 8,
    variant: 'center',
    attribution: 'Nelson Mandela',
  });

  assert.ok(fs.existsSync(outPath));
  const ig = await validateVideo(outPath);
  assert.equal(ig.ok, true, ig.reasons.join('; '));
  assert.equal(ig.info.width, 1080);
  assert.equal(ig.info.height, 1920);

  // The YouTube variant swaps the audio stream only: same duration, same
  // picture, different track, still valid.
  const ytPath = outPath.replace(/\.mp4$/i, '-yt.mp4');
  await retrackVideo({
    video: outPath,
    music: track,
    outPath: ytPath,
    musicStart: 0,
    duration: ig.info.duration,
  });
  const yt = await validateVideo(ytPath);
  assert.equal(yt.ok, true, yt.reasons.join('; '));
  assert.ok(Math.abs(yt.info.duration - ig.info.duration) < 0.1, 'duration must not drift');
  assert.equal(yt.info.width, 1080);
  assert.equal(yt.info.bytes > 0, true);

  fs.rmSync(outPath, { force: true });
  fs.rmSync(ytPath, { force: true });
});

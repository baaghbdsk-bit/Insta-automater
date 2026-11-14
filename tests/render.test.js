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
  const { renderQuote } = require('../src/quote');
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
  });

  assert.ok(fs.existsSync(outPath));
  const check = await validateVideo(outPath);
  assert.equal(check.ok, true, check.reasons.join('; '));
  assert.equal(check.info.width, 1080);
  assert.equal(check.info.height, 1920);

  fs.rmSync(outPath, { force: true });
});

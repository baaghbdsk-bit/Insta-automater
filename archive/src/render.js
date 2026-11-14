'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { config, paths, ROOT } = require('./config');
const { FFMPEG, run, log, ensureDir, listFiles, IMAGE_EXT } = require('./util');
const { writeAss } = require('./captions');
const { pickBackground } = require('./db');

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function resolveBackground() {
  const images = listFiles(paths.backgrounds, IMAGE_EXT);
  if (!images.length) return { mode: 'gradient', file: null };
  const chosen = pickBackground(images, config.backgrounds.rotateEvery);
  return { mode: 'image', file: chosen };
}

/**
 * A soft bottom scrim (black -> transparent) keeps captions readable over any
 * photo without the hard edge a drawbox leaves behind. Generated once, cached.
 */
async function ensureScrim() {
  const dir = path.join(ROOT, 'assets', 'overlay');
  const file = path.join(dir, 'scrim.png');
  if (fs.existsSync(file)) return file;
  ensureDir(dir);

  const W = config.video.width;
  const H = config.video.height;
  const start = Math.round(H * 0.52);
  const span = Math.round(H * 0.34);

  await run(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=black:s=${W}x${H}:d=1`,
    '-vf',
    `format=rgba,geq=r=0:g=0:b=0:a='255*min(1,max(0,(Y-${start})/${span}))'`,
    '-frames:v', '1',
    file,
  ]);
  log.info('generated caption scrim overlay');
  return file;
}

async function renderVideo({ script, timed, workDir, outPath, brand }) {
  ensureDir(workDir);
  ensureDir(path.dirname(outPath));

  const W = config.video.width;
  const H = config.video.height;
  const FPS = config.video.fps;
  const total = timed.total;
  const frames = Math.ceil(total * FPS);

  const bg = resolveBackground();
  const scrim = await ensureScrim();
  const assFile = writeAss(workDir, {
    headline: script.headline,
    timed,
    total,
    brand: brand || config.channel.handle,
  });

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  let idx = 0;

  // --- input 0: background ------------------------------------------------
  if (bg.mode === 'image') {
    args.push('-i', rel(bg.file));
    log.info(`background: ${path.basename(bg.file)}`);
  } else {
    args.push(
      '-f', 'lavfi', '-i',
      `gradients=s=${W}x${H}:c0=${config.video.bgColorA}:c1=${config.video.bgColorB}:speed=0.012:d=${total.toFixed(2)}:r=${FPS}`
    );
    log.info('background: procedural gradient (drop images in assets/backgrounds for photos)');
  }
  const bgIdx = idx++;

  // --- audio inputs -------------------------------------------------------
  const audioIdx = [];
  for (const f of timed.files) {
    args.push('-i', rel(f.path));
    audioIdx.push(idx++);
  }

  // --- optional music -----------------------------------------------------
  const bgmFiles = listFiles(paths.bgm, new Set(['.mp3', '.m4a', '.wav']));
  let bgmIdx = -1;
  if (bgmFiles.length) {
    args.push('-stream_loop', '-1', '-i', rel(bgmFiles[0]));
    bgmIdx = idx++;
    log.info(`music: ${path.basename(bgmFiles[0])}`);
  }

  // --- scrim overlay ------------------------------------------------------
  args.push('-i', rel(scrim));
  const scrimIdx = idx++;

  const filters = [];

  // --- video chain --------------------------------------------------------
  if (bg.mode === 'image') {
    // Supersample, then a slow Ken Burns zoom so a still photo is never dead.
    const bw = W * 2;
    const bh = H * 2;
    filters.push(
      `[${bgIdx}:v]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},setsar=1,` +
        `zoompan=z='min(zoom+0.0009,1.22)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}[v0]`
    );
  } else {
    // Grain hides the banding that gradients produce on H.264.
    filters.push(`[${bgIdx}:v]setsar=1,noise=alls=6:allf=t+u[v0]`);
  }

  filters.push(`[v0][${scrimIdx}:v]overlay=0:0:format=auto[v1]`);
  filters.push(`[v1]ass=${rel(assFile)}:fontsdir=${rel(paths.fonts)},format=yuv420p[vout]`);

  // --- audio chain --------------------------------------------------------
  timed.files.forEach((f, i) => {
    const ms = Math.round(f.start * 1000);
    filters.push(`[${audioIdx[i]}:a]adelay=${ms}|${ms},volume=1.0[a${i}]`);
  });

  const voiceChain = audioIdx.map((_, i) => `[a${i}]`).join('');
  if (bgmIdx >= 0) {
    filters.push(
      `[${bgmIdx}:a]volume=0.07,atrim=0:${total.toFixed(2)},` +
        `afade=t=in:st=0:d=0.8,afade=t=out:st=${Math.max(0, total - 1.4).toFixed(2)}:d=1.4[bg]`
    );
    filters.push(
      `${voiceChain}amix=inputs=${audioIdx.length}:normalize=0:dropout_transition=0[loud];` +
        `[loud][bg]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`
    );
  } else {
    filters.push(
      `${voiceChain}amix=inputs=${audioIdx.length}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`
    );
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    '-t', total.toFixed(2),
    '-r', String(FPS),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level', '4.1',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',
    '-movflags', '+faststart',
    rel(outPath)
  );

  log.step('rendering video...');
  if (process.env.DEBUG) log.info(`ffmpeg ${args.join(' ')}`);
  const t0 = Date.now();
  try {
    await run(FFMPEG, args, { cwd: ROOT });
  } catch (e) {
    const msg = (e.stderr || e.message || '').slice(-4000);
    throw new Error(`ffmpeg failed:\n${msg}`);
  }
  const sizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  log.ok(
    `rendered ${path.basename(outPath)} (${sizeMb} MB, ${total.toFixed(1)}s, ${(
      (Date.now() - t0) / 1000
    ).toFixed(1)}s)`
  );

  return { outPath, background: bg.file || 'gradient' };
}

module.exports = { renderVideo, resolveBackground };

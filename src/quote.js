'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { config, paths, ROOT } = require('./config');
const { FFMPEG, log, run, ensureDir, probeDuration, wrapText } = require('./util');
const { assColor, assTime } = require('./captions');
const fonts = require('./fonts');
const mix = require('./music-mix');

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function esc(text) {
  return String(text).replace(/[{}\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

const SIZES = [100, 92, 84, 78, 72];
const MARGIN_X = 96;

/** Where the text block sits. Keeps the grid from looking identical every day. */
const VARIANTS = {
  upper: 0.32,
  center: 0.46,
};

/**
 * Fit a line into the frame: biggest font that keeps it to <= 4 lines.
 * Scans wrap widths so the block never ends in a 1-2 word orphan, and prefers
 * fewer lines when two widths are equally even.
 */
function layout(text, W, font = fonts.FONTS.anton) {
  const usable = W - MARGIN_X * 2;
  const clean = String(text).replace(/\s+/g, ' ').trim();
  const ratio = font.ratio || fonts.FONTS.anton.ratio;

  for (const size of SIZES) {
    const maxChars = Math.max(8, Math.floor(usable / (ratio * size)));
    const minTarget = Math.max(10, Math.ceil(clean.length / 4));

    const candidates = [];
    for (let t = maxChars; t >= minTarget; t--) {
      const ls = wrapText(clean, t, 5);
      if (ls.length > 4) continue;
      candidates.push({ lines: ls, evenness: Math.min(...ls.map((l) => l.length)) });
    }
    if (!candidates.length) continue;

    const best = Math.max(...candidates.map((c) => c.evenness));
    const good = candidates.filter((c) => c.evenness >= best * 0.85);
    good.sort((a, b) => a.lines.length - b.lines.length);
    return { size, lines: good[0].lines };
  }

  const size = SIZES[SIZES.length - 1];
  const maxChars = Math.max(8, Math.floor(usable / (ratio * size)));
  return { size, lines: wrapText(clean, maxChars, 4) };
}

function variantCenterY(variant, H) {
  const frac = VARIANTS[variant] || VARIANTS.center;
  return Math.round(H * frac);
}

const MOOD_GRADES = {
  heartbreak: 'eq=contrast=1.10:saturation=0.78:brightness=-0.05:gamma=0.96,colorbalance=bs=0.06:bm=0.02:rs=-0.03',
  growth: 'eq=contrast=1.10:saturation=0.92:brightness=-0.03:gamma=0.98,colorbalance=rs=0.02:gs=0.01:bh=0.02',
  motivation: 'eq=contrast=1.12:saturation=0.95:brightness=-0.03:gamma=0.97,colorbalance=rs=0.04:gs=0.02:bs=-0.03:rh=0.03',
};

function gradeForMood(mood) {
  return MOOD_GRADES[mood] || MOOD_GRADES.motivation;
}

function buildAss({ text, watermark, total, W, H, variant = 'center', font = fonts.FONTS.anton, attribution = '' }) {
  const accent = assColor(config.video.accent);
  const { size, lines } = layout(text, W, font);
  const lineH = Math.round(size * 1.24);
  const blockH = lineH * lines.length;
  const centerY = variantCenterY(variant, H);
  const topY = Math.round(centerY - blockH / 2 + lineH / 2);
  const author = String(attribution || '').replace(/\s+/g, ' ').trim();
  const authorSize = Math.max(36, Math.round(size * 0.36));

  // Crisp 88x4 editorial accent bar under the @handle masthead (layer 0, visible at t=0).
  const ruleY = 208;
  const events = [
    `Dialogue: 0,${assTime(0)},${assTime(total)},Rule,,0,0,0,,{\\an5\\pos(${W / 2},${ruleY})\\p1}m -44 -2 l 44 -2 44 2 -44 2{\\p0}`,
  ];

  // Every line is fully opaque at t=0. Frame 1 is the Shorts thumbnail and the
  // only thing a viewer sees before deciding to swipe; a staged fade turned it
  // into a half-empty photo (and, at two lines, half the quote). The camera
  // push already supplies motion.
  for (let i = 0; i < lines.length; i++) {
    const y = topY + i * lineH;
    const tags = `{\\an5\\pos(${W / 2},${y})}`;
    events.push(`Dialogue: 0,${assTime(0)},${assTime(total)},Quote,,0,0,0,,${tags}${esc(lines[i])}`);
  }

  if (author) {
    // Sits just under the last line, not centred as a separate block, so the
    // byline reads as part of the quote. Same frame-1 rule as the quote itself.
    const authorY = Math.round(topY + (lines.length - 1) * lineH + lineH * 0.72);
    events.push(
      `Dialogue: 0,${assTime(0)},${assTime(total)},Author,,0,0,0,,` +
        `{\\an5\\pos(${W / 2},${authorY})}${esc('— ' + author)}`
    );
  }

  if (watermark) {
    events.push(
      `Dialogue: 0,${assTime(0.15)},${assTime(total)},Mark,,0,0,0,,{\\an8\\pos(${W / 2},150)\\fad(200,0)}${esc(
        watermark
      )}`
    );
  }

  const style = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Quote,${font.name},${size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,${font.bold},0,0,0,100,100,1.5,0,1,2.5,6,5,${MARGIN_X},${MARGIN_X},0,1
Style: Rule,Arial,10,${accent},&H000000FF,&H00000000,&H60000000,0,0,0,0,100,100,0,0,1,0,2,5,0,0,0,1
Style: Mark,Anton,38,${accent},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,8,0,1,3,2,8,40,40,150,1
${author ? `Style: Author,${font.name},${authorSize},${accent},&H000000FF,&H00000000,&H9B000000,0,1,0,0,100,100,2,0,1,3,6,5,${MARGIN_X},${MARGIN_X},0,1\n` : ''}
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  return { ass: style + events.join('\n') + '\n', size, lines, lineH, blockH, centerY, author, authorSize };
}

/**
 * Soft dark band behind the text. Generated once per (size, position) and
 * reused. Gaussian across the vertical axis so text always sits on a slightly
 * darker patch regardless of how bright the photo is.
 */
async function ensureScrim(W, H, centerY) {
  const dir = path.join(ROOT, 'assets', 'overlay');
  const pct = Math.round((centerY / H) * 100);
  const file = path.join(dir, `quote-scrim-${W}x${H}-${pct}.png`);
  if (fs.existsSync(file)) return file;
  ensureDir(dir);

  const sigma = Math.round(H * 0.24);
  await run(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=black:s=${W}x${H}:d=1`,
    '-vf',
    `format=rgba,geq=r=0:g=0:b=0:a='255*min(1,0.13+0.55*exp(-pow((Y-${centerY})/${sigma},2)))'`,
    '-frames:v', '1',
    file,
  ]);
  log.info(`generated scrim overlay ${pct}%`);
  return file;
}

/**
 * Camera moves. Each one is a slow push or drift; `on` is the output frame
 * index inside zoompan, so dividing by the frame count normalises the travel.
 */
function motionExpressions(frames) {
  const d = Math.max(1, frames);
  return [
    { name: 'push-center', x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)' },
    { name: 'push-up', x: 'iw/2-(iw/zoom/2)', y: `(ih-ih/zoom)*(0.64-0.20*on/${d})` },
    { name: 'push-down', x: 'iw/2-(iw/zoom/2)', y: `(ih-ih/zoom)*(0.36+0.20*on/${d})` },
    { name: 'drift-left', x: `(iw-iw/zoom)*(0.64-0.20*on/${d})`, y: 'ih/2-(ih/zoom/2)' },
    { name: 'drift-right', x: `(iw-iw/zoom)*(0.36+0.20*on/${d})`, y: 'ih/2-(ih/zoom/2)' },
  ];
}

/**
 * One quote reel: photo + big line + music bed.
 */
async function renderQuote({
  image,
  text,
  mood = 'motivation',
  theme = '',
  music,
  outPath,
  duration = 12,
  watermark = true,
  variant = 'center',
  motion,
  musicStart,
  attribution = '',
}) {
  if (!image || !fs.existsSync(image)) throw new Error(`image not found: ${image}`);
  if (!text || !String(text).trim()) throw new Error('no text to render');
  const font = fonts.pick({ theme, text });

  const W = config.video.width;
  const H = config.video.height;
  const FPS = config.video.fps;
  const total = Math.max(6, Math.min(Number(duration) || 12, 60));
  const frames = Math.ceil(total * FPS);
  const pick = motion === undefined ? Math.random() : motion;

  const moves = motionExpressions(frames);
  const move = typeof pick === 'number' ? moves[Math.floor(pick * moves.length) % moves.length] : moves[0];

  const workDir = ensureDir(path.join(paths.tmp, `quote-${Date.now()}`));
  const { ass, size, lines, centerY, author } = buildAss({
    text: String(text).trim(),
    watermark: watermark ? config.channel.handle : '',
    total,
    W,
    H,
    variant,
    font,
    attribution,
  });
  const assFile = path.join(workDir, 'quote.ass');
  fs.writeFileSync(assFile, ass, 'utf8');

  const scrim = await ensureScrim(W, H, centerY);

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  args.push('-i', rel(path.resolve(image)));
  args.push('-i', rel(scrim));

  let musicIdx = -1;
  let offset = 0;
  let musicFile = null;
  let measured = null;
  if (music && fs.existsSync(music)) {
    musicFile = music;
    // A fixed start is required for native audio: Instagram always plays the
    // attached track from 0, so the embedded bed must match it. Callers pass a
    // measured start (past any quiet intro); the default is 0 rather than a
    // random point, because a hook that lands 6s into the clip is not a hook.
    const fixed = musicStart === undefined || musicStart === null ? 0 : Number(musicStart);
    offset = Number.isFinite(fixed) ? Math.max(0, fixed) : 0;
    args.push('-stream_loop', '-1', '-ss', String(offset), '-i', rel(path.resolve(music)));
    musicIdx = 2;
    // Measured over the exact segment that plays, so the gain is fixed for the
    // whole clip instead of being re-decided while it runs.
    measured = await mix.measure(music, { start: offset, duration: total });
    const gain = mix.gainFor(measured);
    log.info(
      `music: ${path.basename(music)} @ ${offset}s` +
        (gain === null
          ? ' (no measurement, loudnorm)'
          : ` (${measured.i.toFixed(1)} LUFS in, gain ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB)`)
    );
  } else {
    log.warn('no music - reel will be silent');
  }

  const filters = [];
  filters.push(
    `[0:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,` +
      `crop=${W * 2}:${H * 2},setsar=1,` +
      `zoompan=z='min(1+0.0007*on,1.22)':x='${move.x}':y='${move.y}':` +
      `d=${frames}:s=${W}x${H}:fps=${FPS},` +
      `${gradeForMood(mood)},unsharp=5:5:0.45:5:5:0.0,format=yuv420p[base]`
  );
  filters.push('[base][1:v]overlay=0:0:format=auto[v1]');
  filters.push(
    `[v1]vignette=PI/4.2,noise=alls=4:allf=t,` +
      `ass=${rel(assFile)}:fontsdir=${rel(paths.fonts)},format=yuv420p[vout]`
  );

  if (musicIdx >= 0) {
    // High-pass and low-shelf first, then the short fades, then one fixed gain.
    filters.push(`[${musicIdx}:a]${mix.bedFilter({ total, measured })}[aout]`);
  } else {
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${total.toFixed(2)}[aout]`);
  }

  ensureDir(path.dirname(outPath));
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    '-t', total.toFixed(2),
    '-r', String(FPS),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-color_range', 'tv',
    '-colorspace', 'bt709',
    '-profile:v', 'high',
    '-level', '4.1',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-movflags', '+faststart',
    rel(outPath)
  );

  log.step(
    `rendering quote (${mood}/${variant}/${move.name}, ${font.name} ${size}px, ${lines.length} lines` +
      `${author ? `, byline: ${author}` : ''}, ${total.toFixed(1)}s)`
  );
  if (process.env.DEBUG) log.info(`ffmpeg ${args.join(' ')}`);
  const t0 = Date.now();
  try {
    await run(FFMPEG, args, { cwd: ROOT });
  } catch (e) {
    throw new Error(`ffmpeg failed:\n${(e.stderr || e.message || '').slice(-3500)}`);
  }
  const mb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  log.ok(
    `done: ${outPath} (${total.toFixed(1)}s, ${mb} MB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`
  );

  return { outPath, total, size, lines, music: musicFile, offset, variant, motion: move.name };
}

/**
 * Replace a rendered video's audio without touching the video stream.
 *
 * YouTube gets a claim-free bed while Instagram keeps the licensed song. The
 * video is copied, not re-encoded, so this costs a couple of seconds: every
 * frame, every filter, every caption is already baked in.
 */
async function retrackVideo({ video, music, outPath, musicStart = 0, duration }) {
  if (!fs.existsSync(video)) throw new Error(`video not found: ${video}`);
  if (!music || !fs.existsSync(music)) throw new Error(`music not found: ${music}`);
  const total = Number(duration) || (await probeDuration(video));
  const start = Math.max(0, Number(musicStart) || 0);
  const measured = await mix.measure(music, { start, duration: total });

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  args.push('-i', rel(path.resolve(video)));
  args.push('-stream_loop', '-1', '-ss', String(start), '-i', rel(path.resolve(music)));
  args.push(
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-af',
    mix.bedFilter({ total, measured, trim: false }),
    '-t', total.toFixed(2),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-movflags', '+faststart',
    rel(outPath)
  );

  ensureDir(path.dirname(outPath));
  if (process.env.DEBUG) log.info(`ffmpeg ${args.join(' ')}`);
  try {
    await run(FFMPEG, args, { cwd: ROOT });
  } catch (e) {
    throw new Error(`retrack failed:\n${(e.stderr || e.message || '').slice(-2000)}`);
  }
  log.ok(`retracked: ${path.basename(outPath)} with ${path.basename(music)} @ ${start}s`);
  return { outPath, total, offset: start };
}

module.exports = { renderQuote, retrackVideo, buildAss, layout, VARIANTS, motionExpressions, fonts };

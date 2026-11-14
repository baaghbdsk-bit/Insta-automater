'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { config, paths, ROOT } = require('./config');
const { FFMPEG, log, run, ensureDir, probeDuration, wrapText } = require('./util');
const { assColor, assTime } = require('./captions');

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function esc(text) {
  return String(text).replace(/[{}\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

const SIZES = [120, 112, 104, 96, 88, 80, 72];
const CHAR_RATIO = 0.29; // Anton, measured
const MARGIN_X = 88;

/** Where the text block sits. Keeps the grid from looking identical every day. */
const VARIANTS = {
  upper: 0.30,
  center: 0.46,
  lower: 0.63,
};

/**
 * Fit a line into the frame: biggest font that keeps it to <= 4 lines.
 * Scans wrap widths so the block never ends in a 1-2 word orphan, and prefers
 * fewer lines when two widths are equally even.
 */
function layout(text, W) {
  const usable = W - MARGIN_X * 2;
  const clean = String(text).replace(/\s+/g, ' ').trim();

  for (const size of SIZES) {
    const maxChars = Math.max(8, Math.floor(usable / (CHAR_RATIO * size)));
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
  const maxChars = Math.max(8, Math.floor(usable / (CHAR_RATIO * size)));
  return { size, lines: wrapText(clean, maxChars, 4) };
}

function variantCenterY(variant, H) {
  const frac = VARIANTS[variant] || VARIANTS.center;
  return Math.round(H * frac);
}

function buildAss({ text, watermark, total, W, H, variant = 'center' }) {
  const accent = assColor(config.video.accent);
  const { size, lines } = layout(text, W);
  const lineH = Math.round(size * 1.16);
  const blockH = lineH * lines.length;
  const centerY = variantCenterY(variant, H);
  const topY = Math.round(centerY - blockH / 2 + lineH / 2);

  const events = lines.map((line, i) => {
    const y = topY + i * lineH;
    const start = 0.1 + i * 0.26;
    // rise 26px into place, then hold
    const tags = `{\\an5\\move(${W / 2},${y + 26},${W / 2},${y},0,420)\\fad(320,0)}`;
    return `Dialogue: 0,${assTime(start)},${assTime(total)},Quote,,0,0,0,,${tags}${esc(line)}`;
  });

  if (watermark) {
    events.push(
      `Dialogue: 0,${assTime(0.5)},${assTime(total)},Mark,,0,0,0,,{\\an8\\pos(${W / 2},150)\\fad(500,0)}${esc(
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
Style: Quote,Anton,${size},&H00FFFFFF,&H000000FF,&H00000000,&H9B000000,0,0,0,0,100,100,1,0,1,4,10,5,${MARGIN_X},${MARGIN_X},0,1
Style: Mark,Anton,38,${accent},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,8,0,1,3,2,8,40,40,150,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  return { ass: style + events.join('\n') + '\n', size, lines, lineH, blockH, centerY };
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

const DEVANAGARI = /[\u0900-\u097F]/;

/**
 * One quote reel: photo + big line + music bed.
 */
async function renderQuote({
  image,
  text,
  mood = 'motivation',
  music,
  outPath,
  duration = 12,
  watermark = true,
  variant = 'center',
  motion,
}) {
  if (!image || !fs.existsSync(image)) throw new Error(`image not found: ${image}`);
  if (!text || !String(text).trim()) throw new Error('no text to render');
  if (DEVANAGARI.test(String(text))) {
    log.warn('quote: text contains Devanagari; Anton has no glyphs for it');
  }

  const W = config.video.width;
  const H = config.video.height;
  const FPS = config.video.fps;
  const total = Math.max(6, Math.min(Number(duration) || 12, 60));
  const frames = Math.ceil(total * FPS);
  const pick = motion === undefined ? Math.random() : motion;

  const moves = motionExpressions(frames);
  const move = typeof pick === 'number' ? moves[Math.floor(pick * moves.length) % moves.length] : moves[0];

  const workDir = ensureDir(path.join(paths.tmp, `quote-${Date.now()}`));
  const { ass, size, lines, centerY } = buildAss({
    text: String(text).trim(),
    watermark: watermark ? config.channel.handle : '',
    total,
    W,
    H,
    variant,
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
  if (music && fs.existsSync(music)) {
    musicFile = music;
    const dur = await probeDuration(music).catch(() => 0);
    // start somewhere in the body of the track, never the same point twice
    offset = dur > 25 ? Number((dur * (0.12 + Math.random() * 0.38)).toFixed(2)) : 0;
    args.push('-stream_loop', '-1', '-ss', String(offset), '-i', rel(path.resolve(music)));
    musicIdx = 2;
    log.info(`music: ${path.basename(music)} @ ${offset}s`);
  } else {
    log.warn('no music - reel will be silent');
  }

  const filters = [];
  filters.push(
    `[0:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,` +
      `crop=${W * 2}:${H * 2},setsar=1,` +
      `zoompan=z='min(1+0.0007*on,1.22)':x='${move.x}':y='${move.y}':` +
      `d=${frames}:s=${W}x${H}:fps=${FPS},` +
      `eq=contrast=1.08:saturation=0.86:brightness=-0.04:gamma=0.98,format=yuv420p[base]`
  );
  filters.push('[base][1:v]overlay=0:0:format=auto[v1]');
  filters.push(
    `[v1]vignette=PI/4.2,noise=alls=5:allf=t,` +
      `ass=${rel(assFile)}:fontsdir=${rel(paths.fonts)},format=yuv420p[vout]`
  );

  if (musicIdx >= 0) {
    filters.push(
      `[${musicIdx}:a]atrim=0:${total.toFixed(2)},asetpts=PTS-STARTPTS,` +
        `afade=t=in:st=0:d=0.9,afade=t=out:st=${Math.max(0, total - 1.6).toFixed(2)}:d=1.6,` +
        `loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]`
    );
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
    '-profile:v', 'high',
    '-level', '4.1',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-movflags', '+faststart',
    rel(outPath)
  );

  log.step(
    `rendering quote (${mood}/${variant}/${move.name}, ${size}px, ${lines.length} lines, ${total.toFixed(1)}s)`
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

module.exports = { renderQuote, layout, VARIANTS, motionExpressions };

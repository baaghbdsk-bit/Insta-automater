'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { config, paths, ROOT } = require('./config');
const { FFMPEG, FFPROBE, log, run, ensureDir, probeDuration, wrapText, slug } = require('./util');
const { assColor } = require('./captions');

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

async function hasAudio(file) {
  try {
    const { stdout } = await run(FFPROBE, [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=index',
      '-of', 'csv=p=0',
      file,
    ]);
    return String(stdout).trim().length > 0;
  } catch {
    return false;
  }
}

function esc(text) {
  return String(text).replace(/[{}\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

function assTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${ss.toFixed(2).padStart(5, '0')}`;
}

/**
 * Pick the largest font size that keeps text within `maxLines`.
 * charRatio = average glyph width / font size (Anton is very condensed: ~0.26).
 */
function fitText(text, { width, marginX, sizes, maxLines, charRatio, fallbackLines = 3 }) {
  const usable = Math.max(200, width - marginX * 2);
  for (const size of sizes) {
    const maxChars = Math.max(8, Math.floor(usable / (charRatio * size)));
    const lines = wrapText(text, maxChars, maxLines + 2);
    if (lines.length <= maxLines) return { size, lines, maxChars };
  }
  const size = sizes[sizes.length - 1];
  const maxChars = Math.max(8, Math.floor(usable / (charRatio * size)));
  return { size, lines: wrapText(text, maxChars, fallbackLines), maxChars };
}

function buildAss({ claim, note, watermark, total, bandCenter }) {
  const accent = assColor(config.video.accent);
  const W = config.video.width;
  const H = config.video.height;

  const events = [];

  if (watermark) {
    events.push(
      `Dialogue: 0,0:00:00.00,${assTime(total)},Watermark,,0,0,0,,{\\an8\\pos(${W / 2},86)\\fad(250,0)}${esc(watermark)}`
    );
  }

  if (claim) {
    events.push(
      `Dialogue: 0,0:00:00.00,${assTime(total)},Claim,,0,0,0,,{\\an5\\pos(${W / 2},${bandCenter})\\fad(180,0)}${claim.assText}`
    );
  }

  if (note) {
    events.push(
      `Dialogue: 0,0:00:00.00,${assTime(total)},Note,,0,0,0,,{\\an2\\pos(${W / 2},1420)\\fad(180,0)}${note.assText}`
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
Style: Watermark,Anton,36,${accent},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,6,0,1,4,0,8,40,40,86,1
Style: Claim,Anton,${claim ? claim.size : 70},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,50,50,0,1
Style: Note,Barlow Semi Condensed,${note ? note.size : 44},&H00F2F2F2,&H000000FF,&H00000000,&HB4000000,0,0,0,0,100,100,1,0,3,16,0,2,50,50,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  return style + events.join('\n') + '\n';
}

/**
 * Compose 1-2 clips into a 9:16 reel.
 *
 * - clips are fit (not cropped) over a blurred copy of themselves, so broadcast
 *   footage keeps its full width
 * - stacked vertically with a claim band on the seam
 * - audio comes from one clip only (overlapping speech is unusable)
 */
async function composeClip({
  videos,
  line,
  note,
  outPath,
  duration,
  audio = 'first',
  watermark = true,
  hashtags = '',
  caption = '',
}) {
  if (!videos || !videos.length) throw new Error('pass at least one --video');
  if (videos.length > 2) throw new Error('max 2 clips');

  for (const v of videos) {
    if (!fs.existsSync(v)) throw new Error(`clip not found: ${v}`);
  }

  const W = config.video.width;
  const H = config.video.height;
  const FPS = config.video.fps;
  const clipCount = videos.length;

  const durations = [];
  for (const v of videos) durations.push(await probeDuration(v));

  const longest = Math.max(...durations);
  const total = Math.max(
    2,
    Math.min(Number(duration) || Math.min(longest, 30.5), 90)
  );

  const slot = clipCount === 2 ? Math.round(H / 2) : H;
  const bandCenter = clipCount === 2 ? slot : Math.round(H * 0.26);

  const claimText = line ? String(line).trim() : '';
  const noteText = note ? String(note).trim() : '';

  const claim = claimText
    ? (() => {
        const f = fitText(claimText, {
          width: W,
          marginX: 54,
          sizes: [70, 64, 58, 52, 46, 40],
          maxLines: 2,
          charRatio: 0.27,
        });
        return { size: f.size, lines: f.lines, assText: f.lines.map(esc).join('\\N') };
      })()
    : null;

  const noteFit = noteText
    ? (() => {
        const f = fitText(noteText, {
          width: W,
          marginX: 70,
          sizes: [46, 42, 38, 34, 30],
          maxLines: 3,
          charRatio: 0.44,
        });
        return { size: f.size, lines: f.lines, assText: f.lines.map(esc).join('\\N') };
      })()
    : null;

  const lineHeight = claim ? claim.size * 1.18 : 0;
  const bandH = claim ? Math.round(claim.lines.length * lineHeight + 62) : 0;
  const bandY = Math.round(bandCenter - bandH / 2);

  const workDir = ensureDir(path.join(paths.tmp, `clip-${Date.now()}`));
  const assFile = path.join(workDir, 'clip.ass');
  fs.writeFileSync(
    assFile,
    buildAss({
      claim,
      note: noteFit,
      watermark: watermark ? config.channel.handle : '',
      total,
      bandCenter,
    }),
    'utf8'
  );

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const v of videos) args.push('-i', rel(path.resolve(v)));

  const filters = [];
  for (let i = 0; i < clipCount; i++) {
    filters.push(`[${i}:v]split=2[src${i}a][src${i}b]`);
    filters.push(
      `[src${i}a]scale=${W}:${slot}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${slot},gblur=sigma=48,eq=brightness=-0.16:saturation=0.65,setsar=1[bg${i}]`
    );
    filters.push(
      `[src${i}b]scale=${W}:${slot}:force_original_aspect_ratio=decrease,` +
        `crop=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[fg${i}]`
    );
    filters.push(`[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2:format=yuv420[o${i}]`);
    filters.push(
      `[o${i}]fps=${FPS},tpad=stop_mode=clone:stop_duration=10,` +
        `trim=0:${total.toFixed(2)},setpts=PTS-STARTPTS[v${i}]`
    );
  }

  if (clipCount === 2) filters.push('[v0][v1]vstack=inputs=2[stk]');
  else filters.push('[v0]null[stk]');

  const accent = config.video.accent;
  let vchain = '[stk]';
  if (claim) {
    vchain +=
      `drawbox=x=0:y=${bandY}:w=iw:h=${bandH}:color=black@0.88:t=fill,` +
      `drawbox=x=0:y=${bandY}:w=iw:h=4:color=${accent}@0.95:t=fill,` +
      `drawbox=x=0:y=${bandY + bandH - 4}:w=iw:h=4:color=${accent}@0.95:t=fill,`;
  }
  vchain += `ass=${rel(assFile)}:fontsdir=${rel(paths.fonts)},format=yuv420p[vout]`;
  filters.push(vchain);

  // ---- audio -------------------------------------------------------------
  const audios = [];
  for (let i = 0; i < clipCount; i++) audios.push(await hasAudio(videos[i]));

  let audioFilter;
  if (audio === 'none') {
    audioFilter = `anullsrc=r=48000:cl=stereo,atrim=0:${total.toFixed(2)}[aout]`;
  } else if (audio === 'mix' && clipCount > 1) {
    const labels = [];
    for (let i = 0; i < clipCount; i++) {
      if (!audios[i]) continue;
      filters.push(
        `[${i}:a]atrim=0:${total.toFixed(2)},asetpts=PTS-STARTPTS,` +
          `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[am${i}]`
      );
      labels.push(`[am${i}]`);
    }
    audioFilter = labels.length
      ? `${labels.join('')}amix=inputs=${labels.length}:normalize=1:dropout_transition=0,` +
        `loudnorm=I=-14:TP=-1.5:LRA=11[aout]`
      : `anullsrc=r=48000:cl=stereo,atrim=0:${total.toFixed(2)}[aout]`;
  } else {
    // 'first' (default) or 'second': one source only, silence-padded
    const preferred = audio === 'second' && clipCount > 1 ? 1 : 0;
    const order = [preferred, ...Array.from({ length: clipCount }, (_, i) => i)];
    const pick = order.find((i) => audios[i]);
    if (pick === undefined) {
      audioFilter = `anullsrc=r=48000:cl=stereo,atrim=0:${total.toFixed(2)}[aout]`;
    } else {
      filters.push(
        `[${pick}:a]atrim=0:${total.toFixed(2)},asetpts=PTS-STARTPTS,apad,` +
          `atrim=0:${total.toFixed(2)},` +
          `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
          `loudnorm=I=-14:TP=-1.5:LRA=11[aout]`
      );
      audioFilter = null;
    }
  }
  if (audioFilter) filters.push(audioFilter);

  ensureDir(path.dirname(outPath));
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    '-t', total.toFixed(2),
    '-r', String(FPS),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '19',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level', '4.1',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '48000',
    '-movflags', '+faststart',
    rel(outPath)
  );

  log.step(`compositing ${clipCount} clip(s) -> ${path.basename(outPath)}`);
  if (process.env.DEBUG) log.info(`ffmpeg ${args.join(' ')}`);
  try {
    await run(FFMPEG, args, { cwd: ROOT });
  } catch (e) {
    throw new Error(`ffmpeg failed:\n${(e.stderr || e.message || '').slice(-3000)}`);
  }

  const mb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  log.ok(`done: ${outPath} (${total.toFixed(1)}s, ${mb} MB)`);

  // sidecar so `publish` can pick up the text without being told twice
  const sidecar = outPath.replace(/\.mp4$/i, '.json');
  fs.writeFileSync(
    sidecar,
    JSON.stringify(
      {
        video: outPath,
        claim: claimText,
        note: noteText,
        caption: caption || [claimText, noteText].filter(Boolean).join('\n\n'),
        hashtags,
        durationSeconds: total,
      },
      null,
      2
    ),
    'utf8'
  );

  return { outPath, total, sidecar };
}

module.exports = { composeClip };

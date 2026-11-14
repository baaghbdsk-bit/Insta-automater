'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { config, paths } = require('./config');
const { wrapText, ensureDir } = require('./util');

const W = () => config.video.width;
const H = () => config.video.height;

// ASS wants &HAABBGGRR
function assColor(hex) {
  const h = hex.replace(/^0x|^#/, '').padStart(6, '0');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

// Escape a single line of text. Never called on joined text, because ASS line
// breaks (\N) must stay intact.
function esc(text) {
  return String(text).replace(/[\\{}]/g, ' ').replace(/\s+/g, ' ').trim();
}

function multiline(lines, upper = false) {
  return lines.map((l) => (upper ? l.toUpperCase() : l)).map(esc).join('\\N');
}

function assTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${ss.toFixed(2).padStart(5, '0')}`;
}

function buildAss({ headline, timed, total, brand }) {
  const accent = assColor(config.video.accent);
  const maxChars = config.limits.maxCaptionCharsPerLine || 20;

  const headLines = wrapText(headline, 18, 4);
  const events = [];

  // Brand handle, top
  if (brand) {
    events.push(
      `Dialogue: 0,0:00:00.00,${assTime(total)},Brand,,0,0,0,,{\\fad(200,0)}${esc(brand)}`
    );
  }

  // Headline, centred
  events.push(
    `Dialogue: 0,0:00:00.00,${assTime(total)},Headline,,0,0,0,,{\\fad(180,0)}${multiline(
      headLines
    )}`
  );

  // Captions, timed to the voiceover
  const last = timed.files.length - 1;
  timed.files.forEach((f, i) => {
    const capLines = wrapText(f.text, maxChars, 3);
    const isLast = i === last;
    const override = isLast
      ? `{\\fad(120,140)\\c${accent}\\3c&H00000000&}`
      : '{\\fad(120,120)}';
    events.push(
      `Dialogue: 0,${assTime(f.start)},${assTime(f.end)},Caption,,0,0,0,,${override}${multiline(
        capLines,
        true
      )}`
    );
  });

  const style = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W()}
PlayResY: ${H()}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Brand,Anton,36,${accent},&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,4,0,1,3,2,8,60,60,100,1
Style: Headline,Archivo Black,80,&H00FFFFFF,&H000000FF,&H00000000,&H7F000000,0,0,0,0,100,100,0,0,1,8,5,5,80,80,0,1
Style: Caption,Anton,82,&H00FFFFFF,&H000000FF,&H00000000,&H8C000000,0,0,0,0,100,100,1,0,1,9,4,2,55,55,420,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  return style + events.join('\n') + '\n';
}

function writeAss(workDir, payload) {
  ensureDir(workDir);
  const file = path.join(workDir, 'captions.ass');
  fs.writeFileSync(file, buildAss(payload), 'utf8');
  return file;
}

module.exports = { buildAss, writeAss, assColor, assTime };

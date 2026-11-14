'use strict';
const { config } = require('./config');

function allText(script) {
  return [
    script.headline,
    script.ig_caption,
    ...(script.hashtags || []),
    ...(script.lines || []).flatMap((l) => [l.hi, l.caption]),
  ]
    .filter(Boolean)
    .join('\n');
}

function numbersIn(text) {
  const matches = String(text).match(/\d[\d,.]*/g) || [];
  return [...new Set(matches.map((m) => m.replace(/[.,]$/, '')))];
}

function check(script, sourceText) {
  const reasons = [];
  const text = allText(script);
  const lower = text.toLowerCase();

  // 1. Defamation / abuse guard. An auto-poster must never invent an accusation.
  for (const term of config.safety.blockedTerms || []) {
    if (!term) continue;
    if (lower.includes(term.toLowerCase())) {
      reasons.push(`blocked term: "${term}"`);
    }
  }

  // 2. Number grounding: any figure on screen must exist in the source.
  if (config.safety.blockOnUngroundedNumbers) {
    const src = String(sourceText || '');
    for (const n of numbersIn(text)) {
      const bare = n.replace(/,/g, '');
      if (!src.includes(n) && !src.replace(/,/g, '').includes(bare)) {
        reasons.push(`number "${n}" not found in source`);
      }
    }
  }

  // 3. Shape / length sanity.
  const lines = script.lines || [];
  if (lines.length < 3) reasons.push('fewer than 3 lines');
  if (lines.length > config.limits.maxLines) reasons.push(`more than ${config.limits.maxLines} lines`);
  for (const l of lines) {
    if (!l.hi || !l.caption) reasons.push('line missing hi/caption text');
    if ((l.caption || '').length > 90) reasons.push('caption line too long');
  }

  return { ok: reasons.length === 0, reasons };
}

module.exports = { check, numbersIn };

'use strict';
/**
 * Type system for quote reels.
 *
 * Every font is calibrated against Anton's measured 0.29 character ratio so
 * the line-fitting logic keeps producing four-line blocks that don't overflow.
 * The theme decides the voice; Devanagari always gets its own script.
 */

const DEVANAGARI = /[\u0900-\u097F]/;

const FONTS = {
  anton: { key: 'anton', name: 'Anton', ratio: 0.29, bold: 0 },
  archivo: { key: 'archivo', name: 'Archivo Black', ratio: 0.425, bold: 0 },
  barlow: { key: 'barlow', name: 'Barlow Semi Condensed', ratio: 0.303, bold: -1 },
  devanagari: { key: 'devanagari', name: 'Noto Sans Devanagari', ratio: 0.36, bold: -1 },
};

// Quiet themes get the lighter condensed face, statements get the heavy
// display faces. Anton remains the default for anything unmapped.
const THEME_FONT = {
  heartbreak: 'barlow',
  loneliness: 'barlow',
  letting_go: 'barlow',
  life_lessons: 'barlow',
  emotional_intelligence: 'barlow',
  self_respect: 'archivo',
  confidence: 'archivo',
  success: 'archivo',
  reality: 'archivo',
  growth: 'anton',
  discipline: 'anton',
  ambition: 'anton',
  motivation: 'anton',
  friendship: 'anton',
};

function forTheme(theme) {
  return FONTS[THEME_FONT[theme] || 'anton'];
}

/** Pick the typeface for one reel. Script wins over theme. */
function pick({ theme = '', text = '' } = {}) {
  if (DEVANAGARI.test(String(text))) return FONTS.devanagari;
  return forTheme(theme);
}

module.exports = { FONTS, THEME_FONT, forTheme, pick, DEVANAGARI };

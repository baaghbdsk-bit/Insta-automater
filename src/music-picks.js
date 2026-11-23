'use strict';
/**
 * Hand-picked sounds from Instagram, matched to the attitude of the line.
 *
 * There are two audio types in Meta's Audio API:
 *   - `music`: the licensed stock catalogue. Sounds like ad music. Rejected.
 *   - `original_sound`: real songs and edits already used on Reels — Eminem,
 *     The Script, Imagine Dragons, slowed/reverb versions. This is the pool.
 *
 * Only `audio_id` is stored. Meta's `download_url` expires after ~1.5 days, so
 * the link is refreshed from the metadata endpoint at run time; a dead id
 * degrades to the next pick instead of breaking a run.
 *
 * Selection rule (from the account owner's examples):
 *   hard truth  -> rap / hard beat        (Eminem, Till I Collapse, POWER)
 *   quiet hurt  -> emotional vocal        (Another Love, Arcade, Let Her Go)
 *   rising up   -> anthemic / cinematic   (Hall of Fame, Unstoppable, High Hopes)
 *
 * Every entry is checked by `npm run audio:verify`: duration, seconds of dead
 * air at 0 (native audio starts at the top), loudness of the first three
 * seconds, true peak and channel layout. Uploads that open with silence or have
 * no hook are dropped even when the song is right.
 *
 * Pool history (2026-11-23): the 13 quiet-intro picks the owner flagged as the
 * "wrong kind of music" were removed, together with the Lose Yourself x
 * Unstoppable edit. Replacements below were measured before being added: every
 * one has 0s of leading silence and a first-3s RMS above -20 dB.
 */
const TYPE = 'original_sound';

const PICKS = {
  heartbreak: [
    ['323240847404726', 'Another Love', 'Tom Odell'],
    ['627434937082245', 'Wildflower', 'Billie Eilish'],
    ['834262641203975', 'Soso', 'Omah Lay'],
    ['667162318236142', 'Lovely', 'Billie Eilish & Khalid'],
    ['676166840945437', 'Arcade', 'Duncan Laurence'],
    ['781338470751596', 'Let Her Go', 'Passenger'],
    ['814315207621272', 'Without Me', 'Halsey'],
    ['907219631086530', 'Lose You To Love Me', 'Selena Gomez'],
  ],
  growth: [
    ['642916667155384', 'Hall Of Fame', 'The Script ft. will.i.am'],
    ['366439462826609', 'Legends Never Die', 'Against The Current'],
    ['27137478635904664', 'Eyes Closed', 'Imagine Dragons'],
    ['354553290259617', 'Unstoppable', 'Sia'],
    ['36327110373600135', 'High Hopes', 'Panic! At The Disco'],
    ['1083563887210703', 'Immortals', 'Fall Out Boy'],
    ['357257645873841', 'Centuries', 'Fall Out Boy'],
    ['1121130739701924', 'Fight Song', 'Rachel Platten'],
  ],
  motivation: [
    ['1375412437508033', 'Till I Collapse', 'Eminem ft. Nate Dogg'],
    ['216865824673203', 'Sing For The Moment', 'Eminem'],
    ['919638282881821', 'POWER', 'Kanye West'],
    ['575857182007015', "Can't Hold Us", 'Macklemore & Ryan Lewis'],
    ['1703405753590384', 'Victory', 'Puff Daddy & Notorious B.I.G.'],
    ['532453552918451', 'HUMBLE', 'Kendrick Lamar'],
  ],
};

/**
 * Vocal tracks with a real hook — the ones that actually carry a quote reel.
 * They get priority in rotation (see audio.pickCurated). Instrumental and
 * strings-only edits were removed from the pool entirely: they are the "flat,
 * nothing to sing" picks the audit could not catch by loudness alone.
 */
const PREFERRED = new Set([
  '366439462826609', // Legends Never Die — Against The Current
  '834262641203975', // Soso — Omah Lay
  '642916667155384', // Hall Of Fame — The Script
  '1375412437508033', // Till I Collapse — Eminem
  '323240847404726', // Another Love — Tom Odell
  '676166840945437', // Arcade — Duncan Laurence
  '814315207621272', // Without Me — Halsey
  '354553290259617', // Unstoppable — Sia
  '919638282881821', // POWER — Kanye West
  '36327110373600135', // High Hopes — Panic! At The Disco
]);

function list(mood) {
  return (PICKS[mood] || []).map(([id, title, artist]) => ({ id: String(id), title, artist, type: TYPE }));
}

function forMood(mood) {
  return list(mood);
}

function moods() {
  return Object.keys(PICKS);
}

/** Structural validation used by the test suite. */
function problems() {
  const out = [];
  const seen = new Map();
  for (const [mood, rows] of Object.entries(PICKS)) {
    for (const [id, title, artist] of rows) {
      if (!/^\d{6,20}$/.test(String(id))) out.push(`${mood}: bad audio id ${id}`);
      if (!title) out.push(`${mood}: ${id} has no title`);
      if (!artist) out.push(`${mood}: ${id} has no artist`);
      const key = String(id);
      if (seen.has(key)) out.push(`${key} appears in ${seen.get(key)} and ${mood}`);
      seen.set(key, mood);
    }
  }
  for (const id of PREFERRED) {
    if (!seen.has(id)) out.push(`preferred id ${id} is not in any mood pool`);
  }
  return out;
}

module.exports = { TYPE, PICKS, PREFERRED, list, forMood, moods, problems };

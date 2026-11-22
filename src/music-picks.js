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
 *   quiet hurt  -> slowed + reverb        (Yebba's Heartbreak, bye, Another Love)
 *   rising up   -> anthemic / cinematic   (Hall of Fame, Rise Up, Eye of the Tiger)
 *
 * Every entry is checked by `npm run audio:verify`: duration, seconds of dead
 * air at 0 (native audio starts at the top), loudness of the first three
 * seconds, true peak and channel layout. Uploads that open with silence or have
 * no hook are dropped even when the song is right.
 */
const TYPE = 'original_sound';

const PICKS = {
  heartbreak: [
    ['167434233049486', "Yebba's Heartbreak", 'Drake & Yebba'],
    ['26747970224861864', 'bye (Slowed)', 'justinfeca'],
    ['1571081900463772', 'Elastic Heart', 'Sia'],
    ['323240847404726', 'Another Love', 'Tom Odell'],
    ['627434937082245', 'Wildflower', 'Billie Eilish'],
    ['834262641203975', 'Soso', 'Omah Lay'],
    ['26339758578979492', 'Reflections', 'The Neighbourhood'],
    ['667162318236142', 'Lovely', 'Billie Eilish & Khalid'],
  ],
  growth: [
    ['642916667155384', 'Hall Of Fame', 'The Script ft. will.i.am'],
    ['254274160046909', 'Stronger', 'Kelly Clarkson'],
    ['1283113742781288', 'Rise Up', 'Andra Day'],
    ['297768938982507', 'Eye Of The Tiger', 'Survivor'],
    ['366439462826609', 'Legends Never Die', 'Against The Current'],
    ['27919155244416158', 'Warriors', 'Imagine Dragons'],
    ['552543731160111', 'Stronger', 'Kanye West'],
    ['752695924302048', 'Remember The Name', 'Fort Minor'],
    ['27137478635904664', 'Eyes Closed', 'Imagine Dragons'],
  ],
  motivation: [
    ['100113173193451', 'Lose Yourself', 'Eminem'],
    ['1375412437508033', 'Till I Collapse', 'Eminem ft. Nate Dogg'],
    ['153198434297429', 'The Way I Am', 'Eminem'],
    ['252126270877938', 'Lose Yourself x Unstoppable', 'prakash_musical'],
    ['934100598658090', 'Not Afraid', 'Eminem'],
    ['216865824673203', 'Sing For The Moment', 'Eminem'],
  ],
};

/**
 * Vocal tracks with a real hook — the ones that actually carry a quote reel.
 * They get priority in rotation (see audio.pickCurated). Instrumental and
 * strings-only edits were removed from the pool entirely: they are the "flat,
 * nothing to sing" picks the audit could not catch by loudness alone.
 */
const PREFERRED = new Set([
  '366439462826609', // Legends Never Die —Against The Current
  '834262641203975', // Soso — Omah Lay
  '642916667155384', // Hall Of Fame — The Script
  '297768938982507', // Eye Of The Tiger — Survivor
  '752695924302048', // Remember The Name — Fort Minor
  '27919155244416158', // Warriors — Imagine Dragons
  '1375412437508033', // Till I Collapse — Eminem
  '323240847404726', // Another Love — Tom Odell
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

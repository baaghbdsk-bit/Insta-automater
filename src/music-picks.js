'use strict';
/**
 * Hand-picked sounds from Instagram, matched to the attitude of the line.
 *
 * There are two audio types in Meta's Audio API:
 *   - `music`: the licensed stock catalogue. Sounds like ad music. Rejected.
 *   - `original_sound`: real songs and edits already used on Reels — Eminem,
 *     Drake, The Script, slowed/reverb versions. This is the pool we want.
 *
 * Only `audio_id` is stored. Meta's `download_url` expires after ~1.5 days, so
 * the link is refreshed from the metadata endpoint at run time; a dead id
 * degrades to the next pick instead of breaking a run.
 *
 * Selection rule (from the account owner's examples):
 *   hard truth  -> rap / hard beat        (Eminem, Till I Collapse)
 *   quiet hurt  -> slowed + reverb        (Yebba's Heartbreak, bye)
 *   rising up   -> anthemic / cinematic   (Hall of Fame, Rise Up)
 */
const TYPE = 'original_sound';

const PICKS = {
  heartbreak: [
    ['167434233049486', "Yebba's Heartbreak", 'Drake & Yebba'],
    ['154051524260807', "Yebba's Heartbreak (Strings)", 'stringsfromparis'],
    ['166692702837136', 'Sad Slowed Reverb Lofi', 'trendsofmusic'],
    ['26747970224861864', 'bye (Slowed)', 'justinfeca'],
    ['488119100104589', 'Mockingbird (Piano)', 'ben.joseph'],
    ['893418339594556', 'Memories (Slowed)', 'hidanparra'],
    ['792188256967572', 'Sad Piano Love Story', 'neurovisions.x'],
    ['27286113127696378', 'bye (Slowed)', 'aemilst'],
  ],
  growth: [
    ['642916667155384', 'Hall Of Fame', 'The Script ft. will.i.am'],
    ['254274160046909', 'Stronger', 'Kelly Clarkson'],
    ['363959679489749', 'Rise Up', 'im.vocals'],
    ['303572679277236', 'Believer', 'Imagine Dragons'],
    ['1619055698572939', 'Mockingbird (Piano)', 'pianoholic'],
    ['648108638182964', 'Hall of Fame (Acoustic)', 'maai.cares'],
    ['390401300738687', 'Rise Up (Cover)', 'ejike.mp3'],
    ['222895750366787', 'Lose Yourself', 'shady.ediit'],
  ],
  motivation: [
    ['100113173193451', 'Lose Yourself', 'Eminem'],
    ['1774680936465362', 'Till I Collapse', 'Eminem ft. Nate Dogg'],
    ['153198434297429', 'The Way I Am', 'Eminem'],
    ['252126270877938', 'Lose Yourself x Unstoppable', 'prakash_musical'],
    ['1255558695868009', 'Till I Collapse (Trailerized)', 'VERBATIM'],
    ['193021677030422', 'Unstoppable', 'MŪNTII & Alex Clare'],
    ['216865824673203', 'Sing For The Moment', 'amir_stunt'],
    ['746759628421977', 'Till I Collapse (Instrumental)', 'migasproductions'],
  ],
};

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
  return out;
}

module.exports = { TYPE, PICKS, list, forMood, moods, problems };

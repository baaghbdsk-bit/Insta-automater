'use strict';
/**
 * Quote and caption generation.
 *
 * Two sources, in this order:
 *   1. Lines an LLM already wrote and that have not been used yet (stored in
 *      the `generated_lines` table, unique on a normalised form).
 *   2. A hand-written seed bank. An LLM asked for "hard-hitting Hinglish" on a
 *      cold start produces cringe; the seed lines are the style anchor and the
 *      safety net when the model is down or the free quota is exhausted.
 *
 * Dedupe runs at three levels: exact (DB unique index), near-duplicate
 * (Jaccard over word sets) and "already posted" (used_assets).
 */
const { llm, config } = require('./config');
const { log } = require('./util');
const { THEMES, THEME_KEYS, themeFor } = require('./themes');
const store = require('./db');

// ------------------------------------------------------------- seed bank

const SEED = {
  heartbreak: [
    'The person who broke you is not waiting for you to heal.',
    'You did not lose them. You lost the version of yourself that needed them.',
    'Love is not enough when respect left first.',
    'Stop watering a dead plant and calling it loyalty.',
    'They did not change. You just finally saw them.',
    'The hardest part is not leaving. It is accepting they let you.',
    'You miss them. They miss being needed.',
    'Some people are lessons, not destinations.',
    'Healing is not forgetting. It is remembering without bleeding.',
    'You gave them your best and they called it not enough.',
    'Do not chase closure from someone who opened the wound.',
    'The right person does not make you beg for basic respect.',
    'Your worth was never on trial. You just put it there.',
    'They came back. Only because the replacement failed.',
    'Stop calling it love when it only hurts you.',
    'You are not hard to love. They were just not capable.',
    'The silence after they leave is louder than any fight.',
    'Let them go. The version of you that stayed was dying.',
    'You cannot heal in the same place you got sick.',
    'Their new happiness is not your failure.',
    'You stayed loyal to someone who was shopping.',
    'Grief is love with nowhere to go.',
    'Do not set yourself on fire to keep someone warm.',
    'The apology you never got is not your burden to carry.',
    'You were not too much. They were too little.',
    'Walking away is not weakness. Staying was.',
    'The person who leaves teaches you what you are worth.',
    'Stop romanticizing someone who only loved the idea of you.',
    'You do not need them to admit it. You already know.',
    'Some doors close so you stop bleeding on the floor.',
  ],
  growth: [
    'Discipline is choosing what you want most over what you want now.',
    'Nobody is coming to save you. That is your advantage.',
    'Your routine is your real resume.',
    'Motivation is a guest. Discipline lives here.',
    'You do not need more time. You need fewer excuses.',
    'The work you avoid is the life you want.',
    'Comfort is the enemy wearing a friendly face.',
    'Show up tired. Show up scared. Just show up.',
    'Your future is built in the hours nobody sees.',
    'Excuses sound smart until results do not come.',
    'You cannot outwork a bad habit. You have to kill it.',
    'The version of you that quits is not the one who wins.',
    'Small steps daily beat giant leaps never taken.',
    'Pain is temporary. Regret is permanent.',
    'You are one decision away from a different life.',
    'Stop waiting for the right moment. Make this one right.',
    'Your habits are voting for the person you become.',
    'The cost of discipline is less than the cost of regret.',
    'Nobody owes you anything. That is freedom.',
    'Work in silence. Let results make the noise.',
    'You do not rise to your goals. You fall to your systems.',
    'Tired is not an excuse. Tired is the test.',
    'The gym does not care about your feelings.',
    'Consistency beats talent when talent gets lazy.',
    'Your comfort zone is a slow death with good lighting.',
    'Every excuse is a brick in the wall of your failure.',
    'Discipline is self respect in action.',
    'You are not behind. You are just starting today.',
    'The grind does not care who you are. It only cares that you show up.',
    'Stop negotiating with yourself.',
  ],
  motivation: [
    'Nobody remembers the person who almost tried.',
    'Your potential is worthless until you use it.',
    'The world does not reward effort. It rewards results.',
    'Stop asking for permission to be great.',
    'Your excuses are more creative than your work.',
    'The only person you are competing with is yesterday you.',
    'Action cures fear. Thinking deepens it.',
    'You are not unlucky. You are unprepared.',
    'Dreams do not work unless you do.',
    'The hardest conversation is the one with yourself.',
    'Stop confusing motion with progress.',
    'Your talent is not rare. Your work ethic is.',
    'Failure is not the opposite of success. It is the path.',
    'You do not need a plan. You need to start.',
    'The person you want to be is built by the person you are today.',
    'Stop waiting to feel ready. You never will.',
    'Your time is the only currency you cannot earn back.',
    'Be so good they cannot ignore you.',
    'The only way out is through the work.',
    'You are not too old. You are just not started.',
    'Stop blaming the system for your lack of system.',
    'Greatness is boring. It is just showing up.',
    'Your network is your net worth only if you bring value.',
    'Stop collecting advice. Start collecting scars.',
    'The pain of discipline weighs ounces. The pain of regret weighs tons.',
    'You are one yes away. But you have to ask.',
    'Do not wait for motivation. Create momentum.',
    'Your comfort is costing you your calling.',
    'The world is not unfair. It is just not about you.',
    'Become the person who does not need motivation.',
  ],
};

const CTAS = {
  heartbreak: [
    'Tag someone who needs to read this.',
    'Save this for the night you cannot sleep.',
    'Which line hit hardest? Comment below.',
    'Send this to the person you are trying to forget.',
  ],
  growth: [
    'Save this. Read it tomorrow morning.',
    'Which line cut the deepest? Comment below.',
    'Tag someone who is about to quit.',
    'Save and reread in a week.',
  ],
  motivation: [
    'Send this to the friend who needs it.',
    'Hit like if this was for you.',
    'Comment which line was true for you.',
    'Save this for the day you want to quit.',
  ],
};

const HASHTAGS = {
  heartbreak: [
    '#heartbreak', '#breakup', '#sadquotes', '#relationshipquotes', '#movingon',
    '#emotional', '#lettinggo', '#realtalk', '#pain',
  ],
  growth: [
    '#growth', '#discipline', '#mindset', '#motivation', '#success',
    '#hustle', '#selfimprovement', '#dailyhabits', '#grind',
  ],
  motivation: [
    '#motivation', '#realtalk', '#lifequotes', '#inspiration',
    '#mindset', '#reality', '#strongmind', '#truth', '#success',
  ],
};

const CLICHE = [
  'never give up', 'believe in yourself', 'follow your dreams', 'you can do it',
  'stay strong', 'work hard', 'be yourself', 'everything happens for a reason',
  'let it go', 'positive vibes', 'alpha male', 'sigma male', 'chad',
  'trust the process', 'good things take time', 'your time will come',
  'keep going', 'stay humble', 'dream big', 'hustle hard', 'rise and grind',
  'good vibes only', 'live laugh love', 'no pain no gain', 'failure is success',
];

// ------------------------------------------------------------- helpers

function normalise(line) {
  return String(line)
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(line) {
  return new Set(normalise(line).split(' ').filter(Boolean));
}

/** Jaccard similarity over word sets. */
function similar(a, b, threshold = 0.62) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter) >= threshold;
}

function isCliche(line) {
  const low = ' ' + normalise(line) + ' ';
  return CLICHE.some((c) => low.includes(' ' + c + ' '));
}

const DEVANAGARI = /[\u0900-\u097F]/;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/u;

function moodOf(theme) {
  const t = THEMES[theme];
  return (t && t.music) || 'motivation';
}

function themeMeta(theme) {
  const key = THEMES[theme] ? theme : 'motivation';
  const t = THEMES[key];
  return { theme: key, mood: t.music, tone: t.tone, queries: t.queries };
}

function seedBank(mood) {
  return SEED[mood] || SEED.motivation;
}

const SEED_PREFIX = (mood) => `seed::${mood}::`;

function usedSeedNorms(mood) {
  const prefix = SEED_PREFIX(mood);
  return new Set(
    store.db
      .prepare("SELECT key FROM used_assets WHERE kind = 'line' AND key LIKE ?")
      .all(prefix + '%')
      .map((r) => r.key.slice(prefix.length))
  );
}

function availableSeed(mood) {
  const used = usedSeedNorms(mood);
  return seedBank(mood).filter((l) => !used.has(normalise(l)));
}

// ------------------------------------------------------------- LLM calls

function extractJson(text) {
  const s = String(text || '').trim();
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  const start = s.search(/[[{]/);
  if (start === -1) return null;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  const end = s.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Gemini is configured through its OpenAI-compatible surface, so this is a
 * plain chat completion. Models are tried in order; the first usable JSON wins.
 *
 * No max_tokens is sent: these are reasoning models and a tight completion
 * budget is spent on internal thinking, returning an empty or truncated body.
 */
async function chatJson(prompt, { temperature = 1.0, maxTokens = 0 } = {}) {
  if (!llm.apiKey) return null;
  for (const model of llm.models) {
    const started = Date.now();
    try {
      const payload = {
        model,
        temperature,
        messages: [{ role: 'user', content: prompt }],
      };
      if (maxTokens > 0) payload.max_tokens = maxTokens;

      const res = await fetch(`${llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${llm.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(90_000),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${text.replace(/\s+/g, ' ').slice(0, 140)}`);
      }
      const json = JSON.parse(text);
      const choice = (json.choices && json.choices[0]) || {};
      const raw = choice.message && choice.message.content;
      const content = Array.isArray(raw)
        ? raw.map((p) => p.text || p.content || '').join('')
        : String(raw || '');

      if (choice.finish_reason === 'length') {
        throw new Error(`reply truncated (finish_reason=length) after ${content.length} chars`);
      }
      const parsed = extractJson(content);
      if (!parsed) {
        throw new Error(`no parsable JSON in reply (${content.length} chars)`);
      }
      log.info(`llm: ${model} ok in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return parsed;
    } catch (e) {
      log.warn(`llm: ${model} failed (${String(e.message).replace(/\s+/g, ' ').slice(0, 130)})`);
    }
  }
  return null;
}

// ------------------------------------------------------------- generation

function acceptLine(line, { mood, recent }) {
  const text = String(line || '').trim().replace(/^["'`“”]|["'`“”]$/g, '').trim();
  if (text.length < 18 || text.length > 118) return null;
  if (DEVANAGARI.test(text)) return null;
  if (EMOJI.test(text)) return null;
  if (/[#@]/.test(text)) return null;
  if (isCliche(text)) return null;
  if (store.lineExists(normalise(text))) return null;

  const pool = [...seedBank(mood), ...recent];
  if (pool.some((p) => similar(p, text))) return null;

  // English only: reject anything that is not Roman script (already handled
  // above via the Devanagari check) and anything too short to be a real line.
  return text;
}

/**
 * Ask for fresh lines for a theme, filter hard, persist the survivors.
 * Returns the number of lines stored.
 */
async function expand(theme, count = 14) {
  const { mood, tone } = themeMeta(theme);
  const recent = store.recentLines(30);
  const avoid = [...seedBank(mood).slice(0, 14), ...recent.slice(0, 10)];

  const prompt = `You write original one-line quotes for an Instagram Reels page. Language: ENGLISH ONLY. No Hindi, no Hinglish, no other language.

THEME: ${theme.replace(/_/g, ' ')}
EMOTIONAL ANGLE: ${tone}

Write ${count} brand-new lines on this angle.

STYLE
- Hard-hitting, direct, uncomfortable truth. Short sentences that land like a punch.
- 8 to 16 words. Exactly one sentence. No emojis, no hashtags, no quotation marks, no em dashes.
- Specific and concrete. Second person ("you") or first person. Real detail beats abstract advice.
- A person should want to send it to someone at 1 AM.
- No motivational poster fluff. Say the thing people are afraid to say.

HARD RULES
- Never use: ${CLICHE.join(', ')}.
- No politics, religion, caste, festivals, celebrities, brands, or money figures.
- No abuse, slurs, threats, or anything about self-harm.
- No famous proverb reused. Original wording only.
- Do not paraphrase any line listed below.

ALREADY WRITTEN (avoid these):
${avoid.map((l) => `- ${l}`).join('\n')}

Return JSON only: {"lines":["...","...","..."]}`;

  const out = await chatJson(prompt, { temperature: 1.05 });
  if (!out || !Array.isArray(out.lines)) {
    log.warn(`lines: ${theme} generation returned nothing`);
    return 0;
  }

  let stored = 0;
  for (const raw of out.lines) {
    const line = acceptLine(raw, { mood, recent });
    if (!line) continue;
    if (store.insertLine({ theme, line, norm: normalise(line), engine: 'llm' })) stored++;
  }
  log.info(`lines: ${theme} -> ${stored}/${out.lines.length} kept`);
  return stored;
}

// ------------------------------------------------------------- picking

function claimGenerated(row) {
  store.markLineUsed(row.norm);
  return row.line;
}

/**
 * Pick the next line for a theme and mark it used.
 *
 * Theme-first on purpose: the image queries and the caption are chosen from the
 * theme, so a discipline line must not end up on a "calm water" photo. The seed
 * bank is the offline fallback and is mapped back to the canonical theme for
 * its mood, so analytics stay honest.
 */
async function compose(theme, { allowGenerate = true } = {}) {
  const meta = themeMeta(theme);

  const ready = store.availableGenerated(meta.theme);
  if (ready.length) {
    const pick = ready[Math.floor(Math.random() * Math.min(ready.length, 5))];
    return { theme: meta.theme, mood: meta.mood, line: claimGenerated(pick), engine: 'llm' };
  }

  if (allowGenerate) {
    log.info(`lines: ${meta.theme} pool empty, generating fresh lines`);
    await expand(meta.theme, 12);
    const after = store.availableGenerated(meta.theme);
    if (after.length) {
      const pick = after[Math.floor(Math.random() * Math.min(after.length, 4))];
      return { theme: meta.theme, mood: meta.mood, line: claimGenerated(pick), engine: 'llm' };
    }
  }

  const canonical = themeFor(meta.mood);
  const fallback = themeMeta(canonical);
  const fresh = availableSeed(fallback.mood);
  if (fresh.length) {
    const line = fresh[0];
    store.markAsset('line', SEED_PREFIX(fallback.mood) + normalise(line));
    log.warn(`lines: ${meta.theme} unavailable, using the ${canonical} seed bank`);
    return { theme: canonical, mood: fallback.mood, line, engine: 'seed' };
  }

  // Last resort: recycle the least recently used seed line rather than fail.
  const all = seedBank(fallback.mood);
  const key = store.pickAsset(
    'recycle_line',
    all.map((l) => SEED_PREFIX(fallback.mood) + normalise(l))
  );
  const line = all.find((l) => SEED_PREFIX(fallback.mood) + normalise(l) === key) || all[0];
  store.markAsset('recycle_line', SEED_PREFIX(fallback.mood) + normalise(line));
  log.warn(`lines: ${canonical} has no fresh lines, recycling an old one`);
  return { theme: canonical, mood: fallback.mood, line, engine: 'recycled' };
}

// ------------------------------------------------------------- captions

function themeTag(theme) {
  return '#' + theme.replace(/_/g, '');
}

function cleanHashtags(list, { max = 12 } = {}) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    const tag = String(raw).trim().replace(/^#*/, '#');
    if (!/^#[a-z0-9_]{2,28}$/i.test(tag)) continue;
    const low = tag.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(low);
    if (out.length >= max) break;
  }
  return out;
}

function fallbackHashtags(mood, theme) {
  const base = HASHTAGS[mood] || HASHTAGS.motivation;
  return cleanHashtags([themeTag(theme), ...base]);
}

/**
 * Caption = the line, a hook/CTA, hashtags, music credit.
 * The model writes the middle part so captions do not read like a template;
 * the curated CTA pool is used when it is unavailable.
 */
async function buildCaption({ theme, mood, line, credit = '' }) {
  let hashtags = null;
  let hook = '';

  const out = await chatJson(
    `You manage the Instagram page @${String(config.channel.handle || '').replace('@', '')} (hard-hitting English quotes).

Quote for this Reel:
"${line}"

Write the post caption.

RULES
- 1 or 2 short sentences. Maximum 140 characters total. English only, matching the quote's language.
- Do not repeat the quote. Do not start with "This quote".
- It should feel like a caption a real person wrote, not a motivational page.
- Optionally one short call to action (save, send to someone, comment). At most one.
- No emojis at the start. Maximum one emoji, only if it truly fits.
- Then 9 hashtags: 2 broad quote tags, 3 specific to this theme, 2 about feelings/mindset, 2 discovery tags. Lowercase, no spaces, no duplicates.

Return JSON only:
{"hook":"...","hashtags":["#...","#..."]}`,
    { temperature: 0.95 }
  );

  if (out) {
    hook = String(out.hook || '').trim().replace(/\s+/g, ' ').slice(0, 200);
    hashtags = cleanHashtags(out.hashtags, { max: 12 });
  }

  if (!hashtags || hashtags.length < 5) hashtags = fallbackHashtags(mood, theme);

  if (!hook) {
    const ctaPool = CTAS[mood] || CTAS.motivation;
    hook = store.pickAsset('cta', ctaPool) || ctaPool[0];
    store.markAsset('cta', hook);
  }

  const parts = [String(line).trim(), '', hook, '', hashtags.join(' ')];
  if (credit) parts.push('', credit);

  const text = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // Instagram caption hard limit is 2200 characters.
  return { caption: text.slice(0, 2200), hook, hashtags };
}

// ------------------------------------------------------------- status

function bankStatus() {
  const moods = Object.keys(SEED);
  return moods.map((m) => {
    const total = seedBank(m).length;
    const left = availableSeed(m).length;
    return { mood: m, total, left, used: total - left };
  });
}

function themeStatus() {
  return THEME_KEYS.map((theme) => ({
    theme,
    mood: moodOf(theme),
    seedLeft: availableSeed(moodOf(theme)).length,
    generatedReady: store.availableGenerated(theme).length,
  }));
}

module.exports = {
  SEED,
  BANK: SEED,
  CTAS,
  HASHTAGS,
  compose,
  nextLine: compose,
  buildCaption,
  availableSeed,
  availableLines: availableSeed,
  bankStatus,
  themeStatus,
  expand,
  normalise,
  similar,
  isCliche,
  moodOf,
  themeMeta,
  chatJson,
};

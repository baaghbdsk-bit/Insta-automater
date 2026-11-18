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
const { llm, config, env } = require('./config');
const { log } = require('./util');
const { THEMES, THEME_KEYS, themeFor } = require('./themes');
const store = require('./db');
const quoteBank = require('./quote-bank');

// A/B: v1 is the original pipeline and stays the default. v2 adds writing
// structures, an impact judge and claim verification. Nothing outside the
// v2 branch changes behaviour.
const V2 = process.env.LINES_V2 === '1';

// ------------------------------------------------------------- seed bank

/**
 * Fallback bank for when the LLM is unavailable and the generated pool is
 * empty. Written to the same standard as the v2 writer: one clear feeling and
 * one concrete detail the reader understands instantly. No riddles.
 */
const SEED_FRESH = {
  heartbreak: [
    'He still has the spare key. You still check the lock.',
    'The last message you sent is still on delivered.',
    'You learned his coffee order and forgot your own.',
    'The playlist you made for her is still called us.',
    'You moved the photo frame before you moved on.',
    'He said he needed space. You are still standing in it.',
    'Your friends stopped asking about him months ago.',
    'You sleep on your side and leave the other half made.',
    'The hoodie in your closet still smells like someone else.',
    'You type his name and delete it before the search finishes.',
    'She returned your books but kept the note inside.',
    'The restaurant you avoid is the one you both liked.',
    'You kept the ticket stub and threw away the reason.',
    'You still call his apartment home when you give directions.',
    'You waited two hours so he could cancel in one line.',
    'The song ended. You kept the earphones in.',
  ],
  growth: [
    'You made the bed before you felt like it.',
    'The gym bag is by the door, not in the closet.',
    'You studied for forty minutes and called it a start.',
    'Your alarm went off at five. You did not negotiate.',
    'You walked past the cigarette shop without slowing down.',
    'Nobody clapped when you kept the promise to yourself.',
    'You opened the laptop before the excuses woke up.',
    'The dishes were done before your phone left the pocket.',
    'You said no once and the sky did not fall.',
    'You left the party when you said you would.',
    'The run was slow. You still went.',
    'You kept the receipt for the course you finished.',
    'The book sat on your desk until you read ten pages.',
    'You chose the cheaper option and told no one.',
    'Your shoes are by the door again, still wet.',
  ],
  motivation: [
    'You missed the deadline and opened the file again.',
    'The message you are afraid to send is one sentence.',
    'You practiced the pitch in the car before the room.',
    'Your first draft was bad. You wrote a second.',
    'You asked for the raise before you felt ready.',
    'The application sat unfinished for nine days.',
    'You showed up with a shaky voice and stayed.',
    'Nobody saw the ten versions before the yes.',
    'You ran the last kilometre angry and still finished.',
    'You started again on a Tuesday that felt like nothing.',
    'The gym at six was empty. You still showed up.',
    'You sent the work before the fear finished talking.',
    'Your hands shook during the interview. You answered anyway.',
    'You kept the habit on the day it stopped being fun.',
    'You told the truth in a room that preferred comfort.',
  ],
};

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

// Best lines first: the fresh bank is drawn before the older seed lines.
for (const mood of Object.keys(SEED_FRESH)) {
  SEED[mood] = [...SEED_FRESH[mood], ...SEED[mood]];
}

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

// ------------------------------------------------------------- impact (v2)

const STRUCTURES = ['reversal', 'observation', 'insight', 'visual', 'minimal'];

const TIRED_OPENERS = [
  /^if you\b/i,
  /^when you\b/i,
  /^(most|some|many) people\b/i,
  /^the moment\b/i,
  /^in a world\b/i,
  /^you (are|were|have|had|lose|waste|keep|need)\b/i,
];

// Negations ("not", "never", "no") are deliberately absent: they carry meaning.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'if', 'when', 'while', 'of', 'to', 'in', 'on',
  'for', 'with', 'from', 'by', 'at', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'this', 'that', 'it', 'its', 'your', 'yours', 'their', 'them', 'his',
  'her', 'hers', 'our', 'ours', 'my', 'me', 'do', 'does', 'did', 'so', 'than',
  'then', 'there', 'here', 'what', 'which', 'who', 'how', 'why', 'just', 'only',
  'still', 'even', 'into', 'over', 'under', 'own', 'same', 'about',
]);

const PRON_FIRST = new Set([
  'i', 'you', 'he', 'she', 'they', 'we', 'it', 'someone', 'some', 'everyone',
  'nobody', 'nothing', 'the', 'this', 'that', 'most', 'many',
]);

/**
 * Structural signature: opener class | clause link | sentence count | shape.
 * Shape maps each word to s (<=3), m (<=6) or l (7+ chars) and collapses runs,
 * so "you waste your best words" and "you lose the game" read as the same
 * skeleton — which is exactly what the first-two-words check kept missing.
 */
function patternSignature(line) {
  const ws = normalise(line).split(' ').filter(Boolean);
  const first = ws[0] || '';
  const opener = PRON_FIRST.has(first) ? first : 'other';
  const link = /\b(but|because|until|when|if|and|yet)\b/i.test(line) ? 'link' : 'nolink';
  const sentences = String(line).split(/(?<=[.!?])\s+/).filter(Boolean).length;
  const shape = ws
    .map((w) => (w.length <= 3 ? 's' : w.length <= 6 ? 'm' : 'l'))
    .join('')
    .replace(/(.)\1+/g, '$1');
  return `${opener}|${link}|${sentences}|${shape}`;
}

/** Content words only. Used to catch the same idea wearing different words. */
function conceptKey(line) {
  return new Set(
    normalise(line)
      .split(' ')
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

/** Soft idea-level similarity at a lower bar than similar()'s 0.62. */
function conceptSimilar(a, b, threshold = 0.35) {
  const A = conceptKey(a);
  const B = conceptKey(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter) >= threshold;
}

/** Ranking tie-breaker only. The impact judge decides the order. */
function structureScore(line, structure, structCount) {
  let s = 0;
  if (TIRED_OPENERS.some((re) => re.test(String(line).trim()))) s -= 2;
  const n = normalise(line).split(' ').filter(Boolean).length;
  if (n >= 8 && n <= 14) s += 1;
  if (n > 18) s -= 1;
  if (!(structCount[structure] || 0)) s += 1;
  return s;
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
 * Ask for fresh lines for a theme and persist the survivors.
 * Dispatches to the legacy pipeline by default, or to v2 when LINES_V2=1.
 */
async function expand(theme, count = 14) {
  return V2 ? expandV2(theme, count) : expandLegacy(theme, count);
}

/**
 * v1 pipeline — original behaviour, untouched. Filter hard, keep survivors.
 */
async function expandLegacy(theme, count = 14) {
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

// ------------------------------------------------------------- v2 pipeline

/**
 * The v2 writing brief. Quality of the line outranks originality of the idea:
 * a familiar truth said precisely beats a strange thought said blandly. The
 * five structures exist so the batch cannot collapse into one rhythm.
 */
const PROMPT_V2 = (theme, tone, count, avoid) => `You write one-line quotes that stop a thumb mid-scroll.
Quality of the line matters more than originality of the idea.

THEME: ${theme.replace(/_/g, ' ')}
EMOTIONAL ANGLE: ${tone || ''}

Write ${count} lines.

THE TARGET REACTION
Someone reads it once, stops, and thinks: that is me. Or: how did you know.
Recognition, not confusion. The meaning must be obvious on the first read.
Depth can arrive on the second read; the meaning cannot. Never make the reader
decode a riddle, solve an image, or work out what you were trying to say.

FIVE STRUCTURES — pick whichever makes each thought land hardest. Use at least
three of the five in this batch; no structure may be more than 40% of your lines.

1. UNEXPECTED REVERSAL — beat one sets an expectation, beat two flips it.
   - They did not apologize to heal you. They apologized to stop feeling like a bad person.
   - You were not the love of their life. You were the wait between two people who were.

2. BRUTAL OBSERVATION — the uncomfortable thing, said outright, no cushioning.
   - Everyone wants your truth until it becomes inconvenient for them.
   - Your comfort zone is not free. You pay for it in years.

3. PSYCHOLOGICAL INSIGHT — the hidden motive behind visible behaviour.
   - They do not miss you. They miss feeling important to you.
   - The apology was for their guilt. You were just standing in the room.

4. VISUAL STORYTELLING — a scene carries an emotion that is obvious at a
   glance, never explained.
   - She read the message twice and put the phone face down.
   - He set two plates, then put one back.

5. MINIMALIST PUNCHLINE — 5 to 8 words, one sentence, hard stop.
   - You are not stuck. You are comfortable.
   - You were someone's backup plan.

BAD — flat lines we are replacing (every theme produces these):
- People show you exactly who they are the moment they no longer need anything from you.  (no edge)
- Your potential is worthless until you use it.  (fortune cookie)
- Your future is built in the hours nobody sees.  (poster line)
- You waste your best words on people who only understand the language of being ignored.  (reads deep, says nothing)
- Your phone battery lasted for three uninterrupted days.  (riddle: the reader has to work out that nobody called)

DETAIL — THE MIDDLE PATH
There are three ways a line fails:
1. No detail, pure assertion: "Nobody is coming to check on you." True, but flat.
2. Hidden detail: "Your phone battery lasted for three uninterrupted days." A
   riddle: the reader must work out that nobody called.
3. Working detail: "He walked home slowly just to delay opening the empty front
   door." One concrete action, understood at a glance, carrying the feeling.
Aim for 3 every time. The detail does the emotional work. Never explain it,
and never make the reader assemble it.

WHAT SEPARATES GOOD FROM BAD
- Say it straight, but show one real detail. Never trade texture for bluntness.
- Specific beats general. One exact detail is worth ten adjectives.
- Say the thing people think but will not post.
- Do not explain the meaning, but do not hide it either. The line carries one
  clear feeling; it never asks the reader to solve it.
- Cut the last four words of any line that starts wrapping up neatly.
- A familiar truth said precisely beats a strange idea said blandly. Never
  trade impact for novelty.

RULES
- Every line 18-118 characters.
- At least ${Math.ceil(count * 0.7)} of the ${count} lines must contain a
  physical detail: an object, an action, a place or a time. The rest may be
  direct statements, but they still need a specific angle, not generic advice.
- Per structure: reversal 8-16 words in two sentences (second sentence 3-8
  words); observation and insight 6-16 words; visual 5-14 words with no
  explanatory second half; minimal 5-8 words, one sentence.
- Imagery is optional. Use a concrete, photographable image only where it
  sharpens the thought and its meaning is instant. Never force a scene onto a
  line that lands harder as a statement. If a reader could ask "what does that
  mean?", cut the image and say the feeling directly.
- Vary openings. Never start a line with: "If you", "When you", "Most people",
  "Some people", "The moment", "In a world".
- Second person ("you") OR first person ("I"), never both in one line.
- No emojis, hashtags, quotation marks, parentheses, em dashes, semicolons.

CLAIMS — tag every line with exactly one tag:
- "none"       anything written TO or ABOUT the reader: what you feel, what
               you remember, what you do alone at night, what you cannot say.
               Second-person statements about the reader's inner life are
               ALWAYS "none". Metaphors, opinions and advice are "none" too.
- "behavioral" a general claim about how PEOPLE behave or what motivates them,
               e.g. "people apologise to relieve their own guilt". Observable
               behaviour only. No clinical labels (narcissist, sociopath,
               trauma response, attachment style).
- "factual"    anything checkable: statistics, science, history, medical,
               "studies show", named diagnoses.
- NEVER write "factual" lines. They are rejected by the system.
- When torn between "none" and "behavioral", choose "none".

HARD RULES
- Never use: ${CLICHE.join(', ')}.
- Never restate these ideas even in fresh words:
    - people show you who they are when they need nothing from you
    - nobody is coming to save you
    - you were not too much / not hard to love
    - know your worth / your worth was never on trial
    - actions speak louder than words
    - some people are lessons, not destinations
- No politics, religion, caste, festivals, celebrities, brands, money figures.
- No abuse, slurs, threats, self-harm.
- Do not copy or lightly reword any line below.

ALREADY WRITTEN (avoid the wording and the underlying idea):
${avoid.map((l) => `- ${l}`).join('\n')}

Return JSON only:
{"lines":[{"line":"...","structure":"reversal|observation|insight|visual|minimal","claim":"none|behavioral|factual"}]}`;

/**
 * Impact judgement. Code cannot measure this: a contrast word is not an earned
 * turn and a three-word clause is not rhythm. One extra call per expansion,
 * and expansions are rare because the pool refills roughly every 14 posts.
 * Returns a Map(line -> 1..10), or null when the judge is unavailable.
 */
async function judgeLines(lines) {
  if (!llm.apiKey || !lines.length) return null;
  const out = await chatJson(
    `You are a ruthless social media editor. Score each line 1-10 for IMPACT.

FIRST GATE — clarity. Would a stranger know exactly what the line means after
one read, in two seconds? If the meaning is a riddle, a decoded image, or a
sentence that needs re-reading to make sense, score 1-4 no matter how clever
it looks. Confusion is not depth.

SECOND GATE — texture. Does the line contain one concrete detail (an object,
an action, a place, a time) that is instantly understood? A line with no
detail is a poster line: cap it at 5. A line whose detail needs decoding is a
riddle: cap it at 4.

Then ask: would a stranger stop scrolling, screenshot this, and send it to a
friend at 1 AM?

Punish: generic wisdom, corporate phrasing, ideas seen a thousand times,
riddle lines, lines that explain instead of showing, anything that reads like
a caption factory wrote it.
Reward: a jolt of recognition, an earned turn, one precise detail that lands
instantly, and a line with mouth-feel when read aloud.

${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}

Return JSON only: {"scores":[{"n":1,"score":7},{"n":2,"score":4}]}`,
    { temperature: 0.2 }
  );
  if (!out || !Array.isArray(out.scores)) {
    log.warn('lines: impact judge unavailable, ranking by structure only');
    return null;
  }
  const map = new Map();
  for (const s of out.scores) {
    const line = lines[Number(s.n) - 1];
    const score = Number(s.score);
    if (line && Number.isFinite(score)) map.set(line, score);
  }
  return map;
}

/**
 * Claim verification, deliberately a separate prompt from the writer so the
 * model cannot rubber-stamp itself. Behavioural claims that cannot be verified
 * are dropped rather than published unvetted.
 */
async function verifyClaims(candidates) {
  const flagged = candidates.filter((c) => c.claim === 'behavioral');
  if (!flagged.length) return candidates;

  if (!llm.apiKey) {
    log.warn('claims: no LLM key, dropping behavioural claims');
    return candidates.filter((c) => c.claim !== 'behavioral');
  }

  const out = await chatJson(
    `You are a fact-checker for an Instagram quotes page. For each line, decide
if its claim about human behaviour is a defensible observation or an overreach:
pseudo-science, clinical diagnosis, a universal claim with obvious
counterexamples, or something that would embarrass the page if challenged.

${flagged.map((c, i) => `${i + 1}. ${c.line}`).join('\n')}

Return JSON only:
{"verdicts":[{"n":1,"verdict":"keep","reason":"short"},{"n":2,"verdict":"drop","reason":"short"}]}`,
    { temperature: 0 }
  );

  if (!out || !Array.isArray(out.verdicts)) {
    log.warn('claims: verifier unavailable, dropping behavioural claims');
    return candidates.filter((c) => c.claim !== 'behavioral');
  }

  const drop = new Set();
  for (const v of out.verdicts) {
    const c = flagged[Number(v.n) - 1];
    if (c && String(v.verdict).toLowerCase() === 'drop') {
      drop.add(c.line);
      log.info(`claims: dropped "${c.line.slice(0, 55)}..." (${v.reason || 'unverified'})`);
    }
  }
  return candidates.filter((c) => !drop.has(c.line));
}

/**
 * v2 pipeline: structure-aware generation, impact judged by a second prompt,
 * behavioural claims checked by a third, then ranked with enough diversity
 * pressure that no single skeleton dominates the batch.
 */
async function expandV2(theme, count = 14) {
  const { mood, tone } = themeMeta(theme);
  const recent = store.recentLines(30);
  const avoid = [...seedBank(mood).slice(0, 14), ...recent.slice(0, 10)];

  const out = await chatJson(PROMPT_V2(theme, tone, count + 6, avoid), {
    temperature: 1.05,
  });
  if (!out || !Array.isArray(out.lines)) {
    log.warn(`lines: ${theme} generation returned nothing`);
    return 0;
  }

  // Tier 1 — the original safety filters, called unchanged.
  const survivors = [];
  for (const entry of out.lines) {
    const text = typeof entry === 'string' ? entry : entry && entry.line;
    const structure = (entry && entry.structure) || 'observation';
    const claim = (entry && entry.claim) || 'none';

    if (claim === 'factual') {
      log.warn(`lines: dropped factual claim: ${String(text).slice(0, 60)}`);
      continue;
    }
    if (!STRUCTURES.includes(structure)) continue;

    const line = acceptLine(text, { mood, recent });
    if (!line) continue;
    survivors.push({ line, structure, claim });
  }

  // Tier 4 — behavioural claims checked by the separate verifier.
  const verified = await verifyClaims(survivors);

  // Tier 3 — impact judgement is the primary sort.
  const scores = await judgeLines(verified.map((c) => c.line));
  for (const c of verified) {
    c.score = scores ? scores.get(c.line) ?? 5 : 5;
  }
  verified.sort(
    (a, b) =>
      b.score - a.score ||
      structureScore(b.line, b.structure, {}) - structureScore(a.line, a.structure, {})
  );

  // Tier 2 — structural + conceptual diversity, then a partial-fill rescue so
  // a strict diversity pass can never leave the pool short.
  const quota = Math.max(2, Math.ceil(count * 0.4));
  const picked = [];
  const denied = [];
  const seenSigs = new Set();
  const structCount = {};

  for (const c of verified) {
    if (picked.length >= count) break;
    if ((structCount[c.structure] || 0) >= quota) {
      denied.push(c);
      continue;
    }
    const sig = patternSignature(c.line);
    if (seenSigs.has(sig)) {
      denied.push(c);
      continue;
    }
    if (recent.some((r) => conceptSimilar(r, c.line))) {
      denied.push(c);
      continue;
    }
    if (picked.some((p) => conceptSimilar(p.line, c.line))) {
      denied.push(c);
      continue;
    }
    seenSigs.add(sig);
    structCount[c.structure] = (structCount[c.structure] || 0) + 1;
    picked.push(c);
  }

  for (const c of denied) {
    if (picked.length >= count) break;
    picked.push(c);
  }

  let stored = 0;
  const mix = {};
  for (const c of picked) {
    if (process.env.DEBUG) {
      log.info(`line: [${c.structure}/${c.claim}] ${c.score ?? '-'} ${c.line}`);
    }
    if (store.insertLine({ theme, line: c.line, norm: normalise(c.line), engine: 'llm' })) {
      stored++;
      mix[c.structure] = (mix[c.structure] || 0) + 1;
    }
  }

  const avg = picked.length
    ? (picked.reduce((a, b) => a + b.score, 0) / picked.length).toFixed(1)
    : 'n/a';
  log.info(
    `lines: ${theme} -> ${stored}/${out.lines.length} kept ` +
      `(avg impact ${avg}, structures ${JSON.stringify(mix)})`
  );
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

  // Curated lines are the default. Set LINE_SOURCE=llm to restore generation.
  if (String(env.LINE_SOURCE || 'bank') !== 'llm') {
    const curated = quoteBank.pick(meta.theme, meta.mood);
    if (curated) {
      quoteBank.markUsed(curated);
      return {
        theme: meta.theme,
        mood: meta.mood,
        line: curated.line,
        engine: 'bank',
        bankId: curated.id,
      };
    }
    log.warn(`lines: quote bank has no approved ${meta.mood} line, falling back to generated`);
  }

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
    bankReady: quoteBank.approved(moodOf(theme)).length,
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
  // v2 helpers (pure, exported for tests)
  STRUCTURES,
  patternSignature,
  conceptSimilar,
  conceptKey,
  structureScore,
};

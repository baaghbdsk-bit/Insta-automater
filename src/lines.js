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
    'Kisi ko itna pyar mat do ki woh tumhari kamzori ban jaye.',
    'Woh chala gaya, par uski aadat aaj tak nahi gayi.',
    'Sabse zyada wahi todte hain jinke liye hum sab kuch chhod dete hain.',
    'Pyar ka matlab nibhana hota hai, sirf kehna nahi.',
    'Tumse baat karna ab bhi accha lagta hai, bas ab tum meri nahi ho.',
    'Kuch log chhod kar nahi jaate, hum unhe dhoondna band kar dete hain.',
    'Dard woh nahi jo unhone diya, dard woh hai jo hum khud ko dete rahe.',
    'Mohabbat ka sabse bada jhooth: main hamesha rahunga.',
    'Jo tumhare bina khush hai, uske liye tum sirf ek aadat the.',
    'Raat bhar jaag kar socha, subah usne kisi aur ko good morning bhej diya.',
    'Aaj bhi uski profile dekhta hoon, jaise koi ilaaj ho.',
    'Uski yaadon se nafrat hai, par unhe bhoolna bhi nahi aata.',
    'Pyar mein haar tab hoti hai jab tum sab kuch do, aur woh kuch bhi na de.',
    'Woh lauta, par sirf apni zaroorat ke liye.',
    'Sabse mushkil kaam: usse bhoolna jo tumhare liye sab kuch tha.',
    'Ek din meri aadat ho jaoge, par main tab tak ja chuka hounga.',
    'Tumse door hokar samajh aaya, main akela bhi khush reh sakta hoon.',
    'Jise tum mera samajhte ho, woh kisi aur ka sabse accha hai.',
    'Chup rehna sabse bada jawab hai, par usse dard kam nahi hota.',
    'Jis rishte mein tumhe samjhana padta hai, woh rishta hi nahi.',
    'Uski muskurahat kisi aur ke naam ho gayi, mera sab kuch wahi reh gaya.',
    'Jo dil toda usne kaha move on karo, jaise koi switch ho.',
    'Mujhe uski aadat nahi thi, mujhe uske hone ki aadat thi.',
    'Woh mujhe bhool gaya, main khud ko nahi bhoola.',
    'Pyar ke baad dosti wahi nibhata hai jisne pyar jhootha kiya ho.',
    'Tumhare naam se ab bhi ruk jaata hoon, bas pehchanta nahi.',
    'Maine tumse pyar kiya tha, tumne mujhse waqt maanga tha.',
    'Uski shaadi ki khabar pe laga, mera naam bhi kisi aur ka ho gaya.',
  ],

  growth: [
    'Jo aaj takleef hai, wahi kal ki taakat hai.',
    'Motivation ek din ka hota hai, discipline har din ka.',
    'Log tab dekhte hain jab tum jeet jaate ho, koi nahi dekhta jab tum uth rahe hote ho.',
    'Tumhara 6 AM kisi aur ke 12 PM se zyada powerful hai.',
    'Jo kaam mushkil hai, wahi tumhe baaki sab se alag karta hai.',
    'Rone ke baad bhi kaam karna, yahi asli mansikta hai.',
    'Tumhari zindagi tumhare decisions ka hisaab hai, tumhare excuses ka nahi.',
    '5 saal baad tum apne aaj ke faislon se kaamyaab ya sharminda hoge.',
    'Jab tak khud pe invest nahi karoge, koi tumhe nahi khareedega.',
    'Mood ka intezar mat kar, mood kaam karne se aata hai.',
    'Tum woh nahi ho jo log bolte hain, tum woh ho jo tum roz karte ho.',
    'Din kharab tha, zindagi nahi.',
    'Sapne wahi poore hote hain jinpe roz kaam hota hai.',
    'Har kisi ko samjhana zaroori nahi, khud ko sabit karna hai.',
    'Ek saal ki mehnat, dus saal ki aadat badal deti hai.',
    'Duniya tumhari kahani tab sunegi jab tum result doge.',
    'Jo aadmi apne time pe control kar leta hai, usse koi nahi rok sakta.',
    'Tumhe koi nahi bachaega. Aur yahi tumhari sabse badi taakat hai.',
    'Shuru karna mushkil hai, kyunki sabse zyada dar wahi hota hai.',
    'Jo roz 1% sudhar gaya, woh saal mein 37 guna badh gaya.',
    'Perfect din ka intezar mat kar, aaj se shuru kar.',
    'Logon ko jawab mat do, result do.',
    'Mehnat chhupti nahi, bas der se dikhti hai.',
    'Tumhari neend aur tumhara focus, dono ek hi cheez chura rahe hain.',
    'Sasta khareed kar pachhtaoge, mehnga seekh kar aage nikal jaoge.',
    'Aaj ka aaram, kal ka pachhtawa hai.',
  ],

  motivation: [
    'Koi tumhare liye nahi aayega, khud ke liye aana padta hai.',
    'Log tumse jalte hain kyunki tum woh kar rahe ho jo unki himmat nahi hui.',
    'Har kisi ko jawab dena zaroori nahi, kuch log sirf bahane khareedte hain.',
    'Tumhari value tumhare kaam se hai, tumhari kahaniyon se nahi.',
    'Jis din samajh liya ki koi nahi aayega, us din jeetna shuru ho gaya.',
    'Maa-baap ke alawa koi bhi tumhare liye free nahi hai.',
    'Chup raho, jab tak tumhara kaam bolna shuru na kare.',
    'Jo tumhe neeche dikhata hai, woh tumhari aukaat nahi, uski nazar hai.',
    'Tumhe har kisi se pyar karne ki zaroorat nahi, sirf khud se mat karna band.',
    'Duniya tumhe tab respect degi jab tum khud ko respect dena shuru karoge.',
    'Sahi waqt ka intezar mat kar, sahi waqt banaya jaata hai.',
    'Log badalte nahi, bas tum unke liye pehle jaisa nahi rehte.',
    'Jise tum sab kuch batate ho, wahi ek din sab kuch use karta hai.',
    'Rishte tabhi mazboot hote hain jab dono ko zaroorat ho, ek ko nahi.',
    'Jo tumhe akela chhod gaya, woh tumhari taakat ka sabse bada sabak tha.',
    'Logon ki raay tumhari zindagi ka hisaab nahi.',
    'Himmat ka matlab dar ka na hona nahi, dar ke saath bhi chalna hai.',
    'Agar koi tumhe chhota samajhta hai, uski nazar chhoti hai, tum nahi.',
    'Tumhari zindagi tumhari hai, kisi aur ki script mat jiyo.',
    'Kuch log sirf tab yaad aate hain jab unka kaam padta hai.',
    'Aaj jo tumse door hai, kal wo tumhari misaal hogi.',
    'Mehnat karna imaan hai, dikhawa nahi.',
    'Jo tumhare saath sach bolta hai, usse kabhi mat chhodo.',
    'Tum har kisi ko khush nahi kar sakte, aur tumhe karna bhi nahi chahiye.',
    'Zindagi mein sabse bada risk: kuch bhi risk na lena.',
    'Jo apne aap se jhooth bolta hai, duniya usse sach nahi sunati.',
  ],
};

const CTAS = {
  heartbreak: [
    'Tag karo usko jo ye feel karata hai.',
    'Ek shabd mein batao: aaj kaise ho?',
    'Save karo, dil bhaari ho to padh lena.',
    'Aapki kahani kya hai? Comment karo.',
  ],
  growth: [
    'Save karo, kal subah padhna.',
    'Kaunsi line sabse zyada chubhi? Comment karo.',
    'Tag karo usko jo aaj haar maan raha hai.',
    'Save karo aur ek hafte baad dobara padhna.',
  ],
  motivation: [
    'Share karo us dost ke saath jise ye sunni thi.',
    'Sahi laga? Ek dil chhod do.',
    'Comment mein batao: kaunsi line sach lagi?',
    'Save karo, jab himmat toote tab padhna.',
  ],
};

const HASHTAGS = {
  heartbreak: [
    '#heartbreak', '#pyar', '#sadquotes', '#hindiquotes', '#breakup',
    '#emotional', '#dil', '#relationshipquotes', '#movingon',
  ],
  growth: [
    '#growth', '#discipline', '#mindset', '#motivation', '#hindiquotes',
    '#success', '#hustle', '#selfimprovement', '#dailyhabits',
  ],
  motivation: [
    '#motivation', '#zindagi', '#sach', '#hindiquotes', '#inspiration',
    '#mindset', '#lifequotes', '#reality', '#strongmind',
  ],
};

const CLICHE = [
  'never give up', 'believe in yourself', 'follow your dreams', 'you can do it',
  'stay strong', 'work hard', 'be yourself', 'everything happens for a reason',
  'let it go', 'positive vibes', 'alpha male', 'sigma male', 'chad',
  'trust the process', 'good things take time', 'your time will come',
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

  // Require at least one Hinglish marker, so the model cannot drift into plain
  // English motivational poster copy.
  if (!/\b(hai|hain|ho|hoga|hogi|kar|karo|karta|karti|nahi|na|tum|tumhe|main|mujhe|woh|wo|yeh|ye|aur|se|ko|ki|ka|tha|thi|raha|rahi|jaise|sirf|bas|bhi|jo)\b/i.test(text)) {
    return null;
  }
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

  const prompt = `You write original one-line quotes for an Instagram Reels page in Indian Hinglish (Roman script).

THEME: ${theme.replace(/_/g, ' ')}
EMOTIONAL ANGLE: ${tone}

Write ${count} brand-new lines on this angle.

STYLE
- Roman-script Hinglish: Hindi words spelled in English letters. Natural spoken Hindi, not translated English.
- 8 to 16 words. Exactly one sentence. No emojis, no hashtags, no quotation marks, no em dashes.
- Specific and concrete. Second person ("tum") or first person. Real detail beats abstract advice.
- A person should want to send it to someone at 1 AM.
- Rarely, a line may be fully English if it is genuinely stronger that way.

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
    `You manage the Instagram page @${String(config.channel.handle || '').replace('@', '')} (Hinglish quotes for young Indian adults).

Quote for this Reel:
"${line}"

Write the post caption.

RULES
- 1 or 2 short sentences. Maximum 140 characters total. Roman Hinglish or English, matching the quote's language.
- Do not repeat the quote. Do not start with "This quote" or "Ye quote".
- It should feel like a caption a real person wrote, not a motivational page.
- Optionally one short call to action (save, send to someone, comment). At most one.
- No emojis at the start. Maximum one emoji, only if it truly fits.
- Then 9 hashtags: 2 broad Hinglish quote tags, 3 specific to this theme, 2 about feelings/mindset, 2 discovery tags for Indian audiences. Lowercase, no spaces, no duplicates.

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

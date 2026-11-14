'use strict';
const { config, llm } = require('./config');
const { log } = require('./util');

function stripFences(s) {
  return String(s)
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

function extractJson(s) {
  const txt = stripFences(s);
  const start = txt.indexOf('{');
  const end = txt.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object in model output');
  return JSON.parse(txt.slice(start, end + 1));
}

const SYSTEM_PROMPT = `You write short vertical-video news explainers (Instagram Reels / YouTube Shorts).

HARD RULES:
- Use ONLY facts contained in the SOURCE text. Never add numbers, dates, quotes, or claims from memory.
- Never accuse any named person or organisation of a crime unless the SOURCE says so explicitly.
- No opinion, no sarcasm, no insults. Report what happened and why it matters.
- Neutral tone. Attribute contested claims ("report ke mutabik", "dawa kiya gaya").
- Do not editorialise about parties, religions, castes, or communities.

LANGUAGE:
- "hi" fields must be in Devanagari Hindi (this is read aloud by a TTS engine).
- "caption" fields must be Roman/Latin Hinglish (shown on screen).
- "headline" and "ig_caption" must ALSO be Roman Hinglish. Never plain English.
- Keep both versions saying the same thing.

STYLE:
- 15-25 seconds of speech total (about 45-70 words). Anything longer loses viewers.
- Line 1 is a hook that makes someone stop scrolling in the first 2 seconds.
- Each line: 6-12 words, one idea, punchy.
- End with a neutral forward-looking line, not a moral.

Return STRICT JSON only, no markdown:
{
  "headline": "on-screen headline, Roman Hinglish, max 6 words, no full stop",
  "lines": [ { "hi": "देवनागरी वाक्य", "caption": "Roman Hinglish sentence" } ],
  "ig_caption": "1-2 short lines for the Instagram caption + one genuine question to viewers",
  "hashtags": ["#politics", "#india"]
}`;

function buildUserPrompt(topic, maxLines) {
  return `SOURCE (headline: ${topic.title})

Article summary/description:
${topic.description || '(none provided - use only the headline above)'}

Write 4 to ${maxLines} lines. Return JSON.`;
}

async function callLlm(topic, maxLines, model) {
  const url = `${llm.baseUrl}/chat/completions`;
  const body = {
    model,
    temperature: 0.6,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(topic, maxLines) },
    ],
    response_format: { type: 'json_object' },
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 180000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${llm.apiKey}`,
        'HTTP-Referer': 'http://localhost',
        'X-Title': 'reel-engine',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    const content = json?.choices?.[0]?.message?.content;
    if (!content) throw new Error('empty content');
    return extractJson(content);
  } finally {
    clearTimeout(t);
  }
}

function templateScript(topic, maxLines) {
  // Deterministic fallback so the pipeline runs with no API key.
  const clean = String(topic.title).replace(/\s*[|\u2013\u2014-]\s*[^|]*$/, '').trim();
  const words = clean.split(/\s+/);
  const chunks = [];
  const per = Math.max(6, Math.ceil(words.length / Math.min(maxLines - 1, 4)));
  for (let i = 0; i < words.length; i += per) chunks.push(words.slice(i, i + per).join(' '));

  const lines = chunks.slice(0, maxLines).map((c) => ({
    hi: c,
    caption: c.replace(/[.?!]+$/, ''),
  }));
  if (lines.length < 2) {
    lines.push({ hi: 'Poori khabar comment section mein.', caption: 'Poori khabar comment section mein' });
  }

  return {
    headline: words.slice(0, 6).join(' '),
    lines,
    ig_caption: `${clean}\n\nAapki kya raay hai? Comment karein.`,
    hashtags: ['#politics', '#india', '#news', '#rajneeti'],
    _fallback: true,
  };
}

function normalise(raw, topic) {
  const out = {
    headline: String(raw.headline || topic.title).trim(),
    lines: Array.isArray(raw.lines) ? raw.lines : [],
    ig_caption: String(raw.ig_caption || '').trim(),
    hashtags: Array.isArray(raw.hashtags) ? raw.hashtags.filter((h) => /^#\w+/.test(h)) : [],
  };

  out.lines = out.lines
    .map((l) => ({
      hi: String(l.hi || l.tts || '').trim(),
      caption: String(l.caption || l.hi || '').trim(),
    }))
    .filter((l) => l.hi && l.caption);

  if (!out.lines.length) throw new Error('Script contained no usable lines');
  if (!out.ig_caption) out.ig_caption = out.headline;
  if (!out.hashtags.length) out.hashtags = ['#news'];
  return out;
}

async function makeScript(topic, { maxLines = config.limits.maxLines, useLlm = true } = {}) {
  const hasKey = !!(llm.apiKey && llm.apiKey.trim());
  if (useLlm && hasKey) {
    for (const model of llm.models) {
      try {
        log.step(`script via ${model}`);
        const raw = await callLlm(topic, maxLines, model);
        const script = normalise(raw, topic);
        if (looksHinglish(script)) return { ...script, _engine: model };
        log.warn(`${model}: captions are not Hinglish, trying next model`);
      } catch (e) {
        log.warn(`${model} failed (${e.message})`);
      }
    }
    log.warn('all models failed - falling back to template script');
  } else if (useLlm && !hasKey) {
    log.warn('no LLM_API_KEY set - using basic template script (quality will be poor)');
  }
  return { ...normalise(templateScript(topic, maxLines), topic), _engine: 'template' };
}

/**
 * Free-tier models sometimes answer in plain English despite instructions.
 * Hinglish captions should contain at least one recognisable Hindi word.
 */
function looksHinglish(script) {
  const text = script.lines.map((l) => l.caption).join(' ').toLowerCase();
  const hindiMarkers = [
    'hai', 'hain', 'ka', 'ki', 'ke', 'ko', 'ne', 'mein', 'se', 'aur', 'par',
    'kya', 'nahi', 'yeh', 'woh', 'aaj', 'abhi', 'bhi', 'kar', 'kiya', 'gaya',
    'hua', 'hoga', 'raha', 'rahi', 'sarkar', 'desh', 'log', 'baat',
  ];
  return hindiMarkers.some((w) => new RegExp(`\\b${w}\\b`).test(text));
}

module.exports = { makeScript, SYSTEM_PROMPT };

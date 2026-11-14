'use strict';
const { log } = require('./util');

function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

function pickTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = block.match(re);
  return m ? decodeEntities(m[1]) : '';
}

function parseRss(xml) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const b of blocks) {
    const cutoff = b.indexOf('</item>');
    const body = cutoff >= 0 ? b.slice(0, cutoff) : b;
    const title = pickTag(body, 'title');
    if (!title) continue;
    items.push({
      title,
      link: pickTag(body, 'link') || pickTag(body, 'guid'),
      pubDate: pickTag(body, 'pubDate'),
      description: pickTag(body, 'description').slice(0, 900),
      guid: pickTag(body, 'guid') || pickTag(body, 'link'),
    });
  }
  return items;
}

async function fetchFeed(feed, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
        accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseRss(xml);
  } finally {
    clearTimeout(t);
  }
}

async function collectTopics(sourceCfg) {
  const feeds = (sourceCfg.feeds || []).filter((f) => f.enabled !== false);
  const all = [];

  for (const feed of feeds) {
    try {
      const items = await fetchFeed(feed);
      log.info(`feed "${feed.name}": ${items.length} items`);
      for (const it of items) all.push({ ...it, feed: feed.name });
    } catch (e) {
      log.warn(`feed "${feed.name}" failed: ${e.message}`);
    }
  }

  const minLen = sourceCfg.minTitleLength || 25;
  const keywords = (sourceCfg.requireKeywords || []).map((k) => k.toLowerCase());

  return all
    .filter((t) => t.title.length >= minLen)
    .filter((t) => (keywords.length ? keywords.some((k) => t.title.toLowerCase().includes(k)) : true))
    .sort((a, b) => {
      const ta = Date.parse(a.pubDate) || 0;
      const tb = Date.parse(b.pubDate) || 0;
      return tb - ta;
    });
}

function topicKey(topic) {
  const raw = (topic.guid || topic.link || topic.title || '').toString();
  // Google News guids change formatting; normalise title for stable dedupe.
  const base = topic.title
    ? topic.title.toLowerCase().replace(/[^a-z0-9\u0900-\u097F]+/g, '').slice(0, 80)
    : raw;
  return base;
}

module.exports = { collectTopics, parseRss, topicKey };

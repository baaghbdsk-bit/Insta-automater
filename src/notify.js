'use strict';
/**
 * Failure reporting that works with zero configuration.
 *
 *  - GitHub Actions annotations (::error:: / ::warning::) show on the run page
 *    and trigger the built-in failure mail to the repository owner.
 *  - $GITHUB_STEP_SUMMARY gets a human-readable report per run.
 *  - NOTIFY_WEBHOOK_URL (optional) receives a JSON POST that suits both Discord
 *    (`content`) and Slack (`text`) incoming webhooks.
 *
 * A notification failure never fails the job.
 */
const { env } = require('./config');
const { log } = require('./util');

function inActions() {
  return !!env.GITHUB_ACTIONS;
}

function escapeCommand(value) {
  return String(value)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function annotate(kind, message) {
  if (!inActions()) return;
  // Annotations are single-line by design.
  console.log(`::${kind}::${escapeCommand(String(message).replace(/\s+/g, ' ').slice(0, 900))}`);
}

async function webhook(text) {
  const url = String(env.NOTIFY_WEBHOOK_URL || '').trim();
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text, text, username: 'reel-engine' }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch (e) {
    log.warn(`notify: webhook failed (${String(e.message).slice(0, 100)})`);
    return false;
  }
}

function error(message) {
  log.error(message);
  annotate('error', message);
  void webhook(`❌ ${message}`);
}

function warn(message) {
  log.warn(message);
  annotate('warning', message);
}

async function summary(markdown) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  try {
    const fs = require('node:fs');
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, markdown.endsWith('\n') ? markdown : markdown + '\n');
  } catch (e) {
    log.warn(`notify: could not write step summary (${String(e.message).slice(0, 80)})`);
  }
}

function setOutput(name, value) {
  if (!env.GITHUB_OUTPUT) return;
  try {
    const fs = require('node:fs');
    fs.appendFileSync(env.GITHUB_OUTPUT, `${name}=${String(value)}\n`);
  } catch {
    /* not fatal */
  }
}

module.exports = { error, warn, summary, webhook, setOutput, annotate, inActions };

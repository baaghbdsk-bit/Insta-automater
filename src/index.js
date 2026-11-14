'use strict';
const fs = require('node:fs');
const path = require('node:path');

const { config, paths, isDryRun, llm, env } = require('./config');
const { log, ensureDir, run, FFMPEG, slug } = require('./util');
const store = require('./db');
const token = require('./setup/token');
const quotes = require('./quote');
const lines = require('./lines');
const library = require('./library');
const host = require('./host');
const ig = require('./publish/instagram');
const insights = require('./insights');
const { validateVideo } = require('./video');
const { THEMES } = require('./themes');

function parseArgs(argv) {
  const out = { _: [] };
  const put = (key, val) => {
    if (out[key] === undefined) out[key] = val;
    else if (Array.isArray(out[key])) out[key].push(val);
    else out[key] = [out[key], val];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        put(key, next);
        i++;
      } else put(key, true);
    } else out._.push(a);
  }
  return out;
}

// ---------------------------------------------------------------- doctor

async function hasFilter(name) {
  try {
    await run(FFMPEG, ['-hide_banner', '-h', `filter=${name}`]);
    return true;
  } catch {
    return false;
  }
}

async function cmdDoctor() {
  log.step('environment check');
  let fails = 0;
  let warns = 0;

  try {
    const { stdout } = await run(FFMPEG, ['-hide_banner', '-version']);
    log.ok(`ffmpeg: ${stdout.split('\n')[0].slice(0, 90)}`);
  } catch {
    log.error('ffmpeg: not runnable');
    fails++;
  }

  for (const f of ['ass', 'zoompan', 'loudnorm']) {
    if (await hasFilter(f)) log.ok(`filter: ${f} available`);
    else {
      log.error(`filter: ${f} MISSING - text rendering will fail`);
      fails++;
    }
  }

  const fonts = fs.existsSync(paths.fonts) ? fs.readdirSync(paths.fonts) : [];
  if (fonts.length) log.ok(`fonts: ${fonts.join(', ')}`);
  else {
    log.error('fonts: assets/fonts is empty');
    fails++;
  }

  if (store.checkpoint()) log.ok(`database: ${path.join(paths.data, 'engine.db')}`);

  if (llm.apiKey) log.ok(`llm: ${llm.models.join(' -> ')} @ ${llm.baseUrl}`);
  else {
    log.warn('llm: no LLM_API_KEY - curated bank only, captions will use templates');
    warns++;
  }

  const accounts = ig.configuredAccounts();
  if (accounts.length === 0) {
    log.warn('instagram: no accounts configured');
    warns++;
  } else {
    for (const acct of accounts) {
      try {
        const me = await ig.preflight(acct);
        log.ok(`instagram: account ${acct} authenticated as @${me.username || me.id}`);
      } catch (e) {
        log.error(`instagram account ${acct}: ${e.message}`);
        fails++;
      }
    }
  }

  const { uploadMode } = require('./publish');
  const yt = require('./publish/youtube');
  const mode = uploadMode();
  log.info(`upload mode: ${mode}`);
  if (mode === 'url') {
    if (host.isConfigured()) {
      log.ok(`r2: bucket ${host.credentials().bucket} -> ${host.credentials().publicBase}`);
    } else {
      log.warn(`r2: missing ${host.missing().join(', ')}; publishing will fail`);
      warns++;
    }
  } else {
    log.ok('r2: not required (direct resumable upload)');
  }

  if (yt.isConfigured()) {
    log.ok('youtube: configured (Shorts publishing enabled)');
  } else {
    log.info('youtube: not configured (optional, set YT_CLIENT_ID/YT_CLIENT_SECRET/YT_REFRESH_TOKEN)');
  }

  const lib = library.libraryStatus();
  log.ok(`photos: ${lib.photos.anywhere} local, providers: ${lib.providers.join(', ')}`);
  log.ok(`music: ${lib.music.anywhere} tracks`);
  log.info(`daily cap: ${config.schedule.maxPerDay}, min gap: ${config.schedule.minGapMinutes} min`);
  log.info(`dry run: ${isDryRun ? 'ON (nothing will publish)' : 'off'}`);

  if (fails) {
    log.error(`${fails} blocking problem(s), ${warns} warning(s)`);
    process.exitCode = 1;
  } else if (warns) {
    log.warn(`ready with ${warns} warning(s)`);
  } else {
    log.ok('all good');
  }
}

// ---------------------------------------------------------------- status

async function cmdStatus() {
  const rows = store.recentPosts(20);
  if (!rows.length) return console.log('no posts yet');

  console.log('');
  for (const r of rows) {
    const when = String(r.created_at).slice(0, 16).replace('T', ' ');
    const theme = (r.theme || '-').padEnd(21);
    const status = r.status.padEnd(10);
    console.log(
      `${String(r.id).padStart(4)}  ${when}  ${theme} ${status} ${r.ig_id ? 'ig:' + r.ig_id : ''}${
        r.error ? '  ' + String(r.error).slice(0, 60) : ''
      }`
    );
    if (r.title) console.log(`      ${String(r.title).slice(0, 100)}`);
  }
  console.log('');
  console.log(`published today: ${store.countPublishedToday()}/${config.schedule.maxPerDay}`);
  console.log(`last published:  ${store.lastPublishedAt() || 'never'}`);
  console.log(`generated lines: ${store.lineCount()} stored`);
  console.log('');
}

async function cmdInsights() {
  const r = insights.report();
  if (!r.posts.length) return console.log('no published posts yet');
  console.log('');
  console.log(
    `published ${r.overall.published}, measured ${r.overall.measured}, ` +
      `median reach ${r.overall.medianReach}, median saves ${r.overall.medianSaves}`
  );
  console.log('');
  for (const [theme, p] of Object.entries(r.byTheme)) {
    console.log(`  ${theme.padEnd(22)} n=${String(p.n).padEnd(3)} median reach ${p.medianReach}`);
  }
  console.log('');
  for (const p of r.posts.slice(0, 25)) {
    const watch = p.avg_watch_ms ? `${(p.avg_watch_ms / 1000).toFixed(1)}s` : '-';
    console.log(
      `  ${String(p.id).padStart(4)} ${(p.theme || '-').padEnd(22)} ` +
        `reach ${String(p.reach ?? '-').padStart(6)} saves ${String(p.saves ?? '-').padStart(4)} ` +
        `shares ${String(p.shares ?? '-').padStart(4)} watch ${watch.padStart(6)}`
    );
  }
  console.log('');
}

// ----------------------------------------------------------------- quote

async function cmdQuote(argv) {
  const opts = parseArgs(argv);
  const theme = opts.theme && THEMES[String(opts.theme)] ? String(opts.theme) : 'motivation';
  const meta = lines.themeMeta(theme);

  const picked = opts.line
    ? { theme, mood: meta.mood, line: String(opts.line), engine: 'manual' }
    : await lines.compose(theme);

  const image = opts.image
    ? String(opts.image)
    : (
        await library.ensurePhoto({
          mood: picked.mood,
          theme,
          queries: meta.queries,
          preferLocal: String(env.PHOTO_FROM_LOCAL || '') === '1',
        })
      ).path;

  const track = opts.music ? String(opts.music) : library.pickTrack(picked.mood);
  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = opts.out
    ? String(opts.out)
    : path.join(paths.output, `${stamp}-${picked.mood}-${slug(picked.line)}.mp4`);

  log.info(`line (${picked.engine}): ${picked.line}`);

  const res = await quotes.renderQuote({
    image,
    text: picked.line,
    mood: picked.mood,
    music: track,
    outPath,
    duration: opts.duration ? Number(opts.duration) : 12,
    variant: opts.variant ? String(opts.variant) : 'center',
    watermark: !opts['no-watermark'],
  });

  const check = await validateVideo(outPath);
  if (!check.ok) log.error(`validation: ${check.reasons.join('; ')}`);
  else log.ok('validation passed');

  const cap = await lines.buildCaption({
    theme,
    mood: picked.mood,
    line: picked.line,
    credit: config.music.creditInCaption ? library.MUSIC_CREDIT : '',
  });

  const sidecar = outPath.replace(/\.mp4$/i, '.json');
  fs.writeFileSync(
    sidecar,
    JSON.stringify(
      {
        theme,
        mood: picked.mood,
        line: picked.line,
        caption: cap.caption,
        hashtags: cap.hashtags,
        video: outPath,
        image,
        music: res.music || null,
        musicOffset: res.offset,
        durationSeconds: res.total,
        fontPx: res.size,
        variant: res.variant,
        motion: res.motion,
      },
      null,
      2
    ),
    'utf8'
  );

  console.log('\n--- caption ---');
  console.log(cap.caption);
  console.log('---------------\n');
  log.ok(`wrote ${outPath}`);
}

// ------------------------------------------------------------------ main

const COMMANDS = {
  run: async (argv) => {
    const opts = parseArgs(argv);
    const { run } = require('./run');
    const res = await run({
      slot: opts.slot ? String(opts.slot) : env.SLOT || '',
      theme: opts.theme ? String(opts.theme) : env.THEME || '',
      dryRun: !!opts['dry-run'] || isDryRun,
    });
    if (!res.ok) process.exitCode = 1;
  },

  doctor: cmdDoctor,
  status: cmdStatus,
  insights: cmdInsights,
  quote: cmdQuote,

  'r2:check': async () => {
    if (!host.isConfigured()) {
      log.error(`R2 not configured, missing: ${host.missing().join(', ')}`);
      process.exitCode = 1;
      return;
    }
    const r = await host.check();
    log.ok(`r2: put+delete ok, bucket ${r.bucket}`);
    log.info(`r2: public URL ${r.url} -> ${r.reachable ? 'reachable' : 'NOT reachable'} (${r.detail})`);
    if (!r.reachable) {
      log.warn('public access is not working; Instagram will not be able to fetch videos');
      process.exitCode = 1;
    }
  },

  'ig:upload-check': async (argv) => {
    const opts = parseArgs(argv);
    const file = opts.file ? String(opts.file) : '';
    if (!file) throw new Error('pass --file <path-to-mp4>');
    if (!ig.isConfigured()) throw new Error('Instagram credentials missing');
    const { id, uri } = await ig.createResumableContainer({
      caption: 'upload check (not published)',
      shareToFeed: true,
    });
    log.info(`ig: container ${id} created, uploading...`);
    await ig.uploadResumable({ uri, filePath: file });
    let status;
    try {
      status = await ig.waitForContainer(id, { timeoutMs: 5 * 60_000, intervalMs: 10_000 });
    } catch (e) {
      log.warn(`ig: ${e.message}`);
      status = 'TIMEOUT';
    }
    log.ok(`ig: container ${id} status ${status} (container expires in 24h; not published)`);
    if (status !== 'FINISHED') process.exitCode = 1;
  },

  'photos:fetch': async (argv) => {
    const opts = parseArgs(argv);
    const n = await library.fetchPhotos({
      mood: opts.mood ? String(opts.mood) : undefined,
      perQuery: opts.per ? Number(opts.per) : 12,
    });
    log.ok(`${n} photo(s) saved`);
    for (const [mood, count] of Object.entries(library.libraryStatus().photos)) {
      log.info(`  ${mood.padEnd(12)} ${count}`);
    }
  },

  'music:fetch': async (argv) => {
    const opts = parseArgs(argv);
    const n = await library.fetchMusic({ force: !!opts.force });
    log.ok(`${n} track(s) downloaded`);
  },

  'library:status': async () => {
    const s = library.libraryStatus();
    console.log('\nphotos:');
    for (const [m, n] of Object.entries(s.photos)) console.log(`  ${m.padEnd(12)} ${n}`);
    console.log('\nmusic:');
    for (const [m, n] of Object.entries(s.music)) console.log(`  ${m.padEnd(12)} ${n}`);
    console.log('\nseed lines:');
    for (const r of lines.bankStatus()) {
      console.log(`  ${r.mood.padEnd(12)} ${r.used} used, ${r.left} left of ${r.total}`);
    }
    console.log('\nthemes:');
    for (const t of lines.themeStatus()) {
      console.log(`  ${t.theme.padEnd(22)} seed ${t.seedLeft}  generated ${t.generatedReady}`);
    }
    console.log(`\nproviders: ${s.providers.join(', ')}`);
    console.log(`${s.musicCredit}\n`);
  },

  cleanup: async () => {
    const hours = env.CLEANUP_HOURS !== undefined && env.CLEANUP_HOURS !== ''
      ? Number(env.CLEANUP_HOURS)
      : 2;
    const n = library.cleanupTemp({ hours: Number.isFinite(hours) ? hours : 2 });
    store.checkpoint();
    log.ok(`cleanup: removed ${n} temp item(s), database checkpointed`);
  },

  'token:status': async () => token.status(),

  'token:exchange': async (argv) => {
    const opts = parseArgs(argv);
    if (opts.app) token.writeEnvValue('FB_APP_ID', String(opts.app));
    if (opts.secret) token.writeEnvValue('FB_APP_SECRET', String(opts.secret));
    const shortToken = opts.token ? String(opts.token) : process.env.IG_ACCESS_TOKEN;
    if (!shortToken) throw new Error('no token: pass --token <short-lived> or set IG_ACCESS_TOKEN');
    if (opts.token) token.writeEnvValue('IG_ACCESS_TOKEN', shortToken);
    await token.exchange(shortToken);
  },

  'token:refresh': async () => {
    const current = process.env.IG_ACCESS_TOKEN;
    if (!current) throw new Error('IG_ACCESS_TOKEN not set');
    log.step('refreshing long-lived token');
    await token.exchange(current);
  },
};

const USAGE = `usage: node src/index.js <command>

  run             one autonomous execution (build + publish)   [--dry-run] [--slot morning]
  doctor          check ffmpeg filters, fonts, db, keys, R2, Instagram
  status          recent builds and publishes
  insights        reach/saves/shares per post and per theme
  quote           render one reel locally without publishing   [--theme] [--line] [--image] [--variant]
  r2:check        verify R2 upload + public URL reachability
  ig:upload-check verify a direct resumable upload without publishing  [--file path]
  photos:fetch    bulk-download photos into assets/photos
  music:fetch      download the CC-BY music bed
  library:status  photos / music / line and theme inventory
  cleanup         delete temp files and checkpoint the database
  token:status    token expiry, scopes, account
  token:exchange  turn a short-lived token into a long-lived one
  token:refresh   renew the long-lived token
`;

(async () => {
  const [, , cmd, ...rest] = process.argv;
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.log(USAGE);
    process.exit(1);
  }
  try {
    await fn(rest);
  } catch (e) {
    log.error(e.message);
    if (process.env.DEBUG) console.error(e.stack);
    process.exitCode = 1;
  }
})();

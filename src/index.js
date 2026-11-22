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
const audio = require('./audio');
const musicPicks = require('./music-picks');
const host = require('./host');
const ig = require('./publish/instagram');
const insights = require('./insights');
const quoteBank = require('./quote-bank');
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

  const audioStatus = audio.status();
  if (audioStatus.enabled) {
    log.ok(
      `instagram audio: native tracks on ` +
        `(trending ${Math.round(audioStatus.trendingShare * 100)}%, min ${audioStatus.minMs / 1000}s, ` +
        `intro-energy ${audioStatus.energy ? 'on' : 'off'})`
    );
  } else {
    log.info('instagram audio: off (embedded CC-BY bed; set IG_NATIVE_AUDIO=1 to use it)');
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

  /** Curated bank health: counts, runway, cooldown, validation, held lines. */
  'lines:bank': async () => {
    const r = quoteBank.report();
    console.log(`\nquote bank: ${r.total} lines (source: assets/quotes/bank.json)`);
    console.log(`  source:   ${String(env.LINE_SOURCE || 'bank')} (set to llm to use generation)`);
    console.log(`  status:   ${JSON.stringify(r.byStatus)}`);
    console.log(`  approved by mood: ${JSON.stringify(r.byMood)}`);
    console.log(`  used:     ${r.used} / ${r.total}`);
    console.log(`  pick:     ${r.selection} (one by one in file order, no duplicates until the pool runs out)`);
    console.log(`  problems: ${r.problems.length ? r.problems.join(' | ') : 'none'}`);
    if (r.held.length) {
      console.log('\nheld — promote in bank.json by setting status to "approved":');
      for (const h of r.held) console.log(`  ${h}`);
    }
    if (r.problems.length) process.exitCode = 1;
  },

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

  /**
   * Read-only diagnostic: what Instagram's licensed catalogue returns for each
   * mood, and which results survive the duration/vibe filters.
   */
  'audio:check': async (argv) => {
    const opts = parseArgs(argv);
    const moods = opts.mood ? [String(opts.mood)] : ['heartbreak', 'growth', 'motivation'];
    const st = audio.status();

    log.step(`native audio: ${st.enabled ? 'ON (IG_NATIVE_AUDIO=1)' : 'off (embedded CC-BY bed)'}`);
    log.info(
      `filters: min ${st.minMs / 1000}s, trending ${Math.round(st.trendingShare * 100)}%, ` +
        `intro-energy ${st.energy ? 'on' : 'off'}, curated ${st.curated ? 'on' : 'off'}, custom ${st.custom ? 'on' : 'off'}`
    );
    if (!ig.isConfigured()) throw new Error('Instagram credentials missing (IG_USER_ID / IG_ACCESS_TOKEN)');

    let usableTotal = 0;
    for (const mood of moods) {
      console.log(`\n${mood}`);
      const curated = musicPicks.forMood(mood);
      if (curated.length) {
        console.log(`  curated: ${curated.length} picks — ${curated.slice(0, 3).map((p) => p.title).join(' | ')}`);
      }
      for (const query of audio.queriesFor(mood)) {
        try {
          const items = await audio.searchAudio(query);
          const usable = items.filter((t) => audio.isUsable(t, mood));
          usableTotal += usable.length;
          const sample = usable
            .slice(0, 2)
            .map((t) => `${t.title} — ${t.display_artist || '?'}`);
          console.log(
            `  "${query}": ${items.length} returned, ${usable.length} usable` +
              (sample.length ? ` | ${sample.join(' | ')}` : '')
          );
        } catch (e) {
          console.log(`  "${query}": FAILED ${String(e.message).slice(0, 120)}`);
        }
      }
    }

    console.log('\ntrending');
    try {
      const items = await audio.searchAudio(null);
      const usable = items.filter((t) => audio.isUsable(t, 'motivation'));
      console.log(`  ${items.length} returned, ${usable.length} usable`);
      for (const t of usable.slice(0, 3)) {
        console.log(`    ${t.title} — ${t.display_artist || '?'} (${Math.round((t.duration_in_ms || 0) / 1000)}s)`);
      }
    } catch (e) {
      console.log(`  FAILED ${String(e.message).slice(0, 120)}`);
    }

    if (!usableTotal) process.exitCode = 1;
  },

  /**
   * Validate every curated pick with measurements, not keywords: duration,
   * leading silence (native audio starts at 0), hook loudness of the first 3s,
   * true peak and channel layout. Exit code 1 when any pick fails.
   */
  'audio:verify': async (argv) => {
    const opts = parseArgs(argv);
    const moods = opts.mood ? [String(opts.mood)] : musicPicks.moods();
    if (!ig.isConfigured()) throw new Error('Instagram credentials missing (IG_USER_ID / IG_ACCESS_TOKEN)');

    let total = 0;
    let failed = 0;
    let warned = 0;

    for (const mood of moods) {
      const list = musicPicks.forMood(mood);
      if (!list.length) continue;
      console.log(`\n${mood}`);
      for (const p of list) {
        total++;
        try {
          const meta = await audio.trackMeta(p.id);
          if (!meta) throw new Error('metadata missing');
          const file = await audio.downloadTrack({
            audioId: String(meta.audio_id),
            downloadUrl: meta.download_url,
          });
          const m = await audio.inspectTrack(file);
          const v = audio.audit(meta, m);
          const usable = audio.isUsable(meta, mood);
          const pass = v.ok && usable;
          if (!pass) failed++;
          else if (v.warns.length) warned++;

          const flags = [
            ...(usable ? [] : ['filtered']),
            ...v.fails,
            ...v.warns,
          ];
          const name = `${meta.title || p.title} — ${meta.display_artist || meta.ig_username || p.artist}`;
          console.log(
            `  ${pass ? (v.warns.length ? 'warn' : 'ok  ') : 'FAIL'} ${p.id} | ${name} | ` +
              `${Math.round((Number(meta.duration_in_ms) || 0) / 1000)}s ${m.kbps || '?'}k ${m.channels || '?'}ch | ` +
              `LUFS ${Number.isFinite(m.lufs) ? m.lufs.toFixed(1) : '?'} | ` +
              `hook ${Number.isFinite(m.rms3) ? m.rms3.toFixed(0) : '?'}dB | ` +
              `sil ${(m.leadSilence || 0).toFixed(1)}s | ` +
              `peak ${Number.isFinite(m.truePeak) ? m.truePeak.toFixed(1) : '?'}dB` +
              (flags.length ? ` | ${flags.join(', ')}` : '')
          );
        } catch (e) {
          failed++;
          console.log(`  FAIL ${p.id} | ${p.title} | ${String(e.message).slice(0, 120)}`);
        }
      }
    }

    log.info(`\nverified ${total}: ${total - failed} pass, ${warned} with warnings, ${failed} fail`);
    if (failed) process.exitCode = 1;
  },

  /**
   * Play the curated pool without posting: writes 12s clips to output/audition
   * plus an index.html with one player per track, so the set can be approved or
   * swapped before it reaches the account.
   *
   * Clips start at 0 because that is what Instagram plays: the native track
   * always begins at the top, so a quiet or silent intro is audible here too.
   * Pass --offset <seconds> to preview another part of the track.
   */
  'audio:audition': async (argv) => {
    const opts = parseArgs(argv);
    const moods = opts.mood ? [String(opts.mood)] : ['heartbreak', 'growth', 'motivation'];
    const seconds = Number(opts.seconds) || 12;
    const offsetOpt = opts.offset === undefined ? 0 : Number(opts.offset);
    const root = ensureDir(path.join(paths.output, 'audition'));
    if (!ig.isConfigured()) throw new Error('Instagram credentials missing (IG_USER_ID / IG_ACCESS_TOKEN)');

    const sections = [];
    for (const mood of moods) {
      const picks = musicPicks.forMood(mood);
      if (!picks.length) {
        log.warn(`audition: no curated picks for ${mood}`);
        continue;
      }
      const dir = ensureDir(path.join(root, mood));
      const rows = [];
      let n = 0;
      for (const p of picks) {
        n++;
        try {
          const meta = await audio.trackMeta(p.id);
          if (!meta || !meta.download_url) throw new Error('no download_url');
          const file = await audio.downloadTrack({
            audioId: String(meta.audio_id),
            downloadUrl: meta.download_url,
          });
          const name = `${String(n).padStart(2, '0')}-${slug(meta.title || p.title, 40)}.m4a`;
          const out = path.join(dir, name);
          const dur = (Number(meta.duration_in_ms) || 30_000) / 1000;
          const start = Number.isFinite(offsetOpt)
            ? Math.max(0, Math.min(offsetOpt, Math.max(0, dur - seconds)))
            : 0;
          await run(FFMPEG, [
            '-y', '-hide_banner', '-nostats',
            '-ss', String(start), '-t', String(seconds),
            '-i', file,
            '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
            '-c:a', 'aac', '-b:a', '160k',
            out,
          ], { timeout: 120_000 });
          rows.push({ name, title: meta.title || p.title, artist: meta.display_artist || p.artist });
          log.ok(`audition: ${mood}/${name}`);
        } catch (e) {
          log.warn(`audition: ${p.title} skipped (${String(e.message).slice(0, 120)})`);
        }
      }
      if (!rows.length) continue;
      sections.push(
        `<h2>${mood}</h2>\n` +
          rows
            .map(
              (r) =>
                `<figure><figcaption>${r.title} — ${r.artist}</figcaption>` +
                `<audio controls preload="none" src="${mood}/${encodeURIComponent(r.name)}"></audio></figure>`
            )
            .join('\n')
      );
    }

    if (!sections.length) throw new Error('no audition clips were produced');
    const html =
      '<!doctype html><meta charset="utf-8"><title>Music audition</title>' +
      '<style>body{font-family:system-ui;background:#111;color:#eee;max-width:720px;margin:40px auto;padding:0 20px}' +
      'h2{text-transform:capitalize;margin-top:36px}.rep{color:#f88;font-weight:600}' +
      'figure{margin:14px 0}figcaption{margin-bottom:6px;color:#bbb}audio{width:100%}</style>' +
      '<h1>Music audition</h1><p>Full list from <code>src/music-picks.js</code>.</p>' +
      sections.join('\n');
    const index = path.join(root, 'index.html');
    fs.writeFileSync(index, html);
    log.ok(`audition ready: ${index}`);
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

  pubcheck: async () => {
    await require('./health').check();
  },

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
  lines:bank      quote bank counts, runway, validation and held lines
  r2:check        verify R2 upload + public URL reachability
  ig:upload-check verify a direct resumable upload without publishing  [--file path]
  photos:fetch    bulk-download photos into assets/photos
  music:fetch      download the CC-BY music bed
  audio:check     what Instagram's licensed audio catalogue returns per mood  [--mood]
  audio:verify    measure every curated track: dead air, hook, clipping       [--mood]
  audio:audition  render 12s clips of the curated pool to output/audition  [--mood] [--seconds]
  library:status  photos / music / line and theme inventory
  cleanup         delete temp files and checkpoint the database
  token:status    token expiry, scopes, account
  pubcheck        verify Instagram + YouTube auth and latest post coverage
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

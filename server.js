// Hebits Stremio addon. Streams torrents from your own qBittorrent, no debrid service.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync, copyFileSync, truncateSync } from 'node:fs';
import { loadConfig, CONFIG_DIR } from './lib/config.js';
import { Store } from './lib/store.js';
import { Jackett } from './lib/jackett.js';
import { Notifier } from './lib/notify.js';
import { QBit } from './lib/qbit.js';
import { parseHebitsId } from './lib/library.js';
import { parseFindId } from './lib/search.js';
import { HebitsSite } from './lib/hebits.js';
import { createHealthTracker } from './lib/health.js';
import { HomeLibrary } from './lib/home.js';
import { TorrentMeta } from './lib/torrentmeta.js';
import { makeGrabber, UserError } from './lib/grab.js';
import { makeAddon } from './lib/addon.js';
import { makePlayer } from './lib/play.js';

const cfg = loadConfig();
const store = new Store(CONFIG_DIR, cfg.timezone);
const jackett = new Jackett(cfg);
const qbit = new QBit(cfg);
const site = new HebitsSite(cfg.jackettIndexerConfig);
const notifier = new Notifier(cfg.notify || {}, (store.data.notified ??= {}), () => store.save(), (m) => log(m));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const home = new HomeLibrary(qbit, log);
const torrentMeta = new TorrentMeta(qbit, log);
const LOG_FILE = cfg.logFile;
const GB = 1024 ** 3;
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version;

const { ensureTorrent, daily } = makeGrabber({ cfg, store, jackett, qbit, site, log });
const { health, noteLogin } = createHealthTracker(notifier, log);
const addon = makeAddon({ cfg, store, jackett, qbit, home, daily, version: VERSION, log, noteLogin });
const player = makePlayer({ cfg, store, qbit, home, torrentMeta, ensureTorrent, cachedItem: addon.cachedItem, log });

// ---- request handling -----------------------------------------------------

function tokenOk(given) {
  const a = Buffer.from(given || '');
  const b = Buffer.from(cfg.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const [, token, ...rest] = url.pathname.split('/');
  if (!tokenOk(token)) return json(res, 404, { error: 'not found' });
  const baseUrl = `http://${req.headers.host}/${token}`;
  const route = rest.join('/');
  try {
    if (!route.startsWith('play/')) log(`${req.method} ${route} origin=${req.headers.origin || '-'} ua=${req.headers['user-agent'] || '-'}`);
    if (req.method === 'OPTIONS') {
      // Private Network Access: lets an https web page fetch from this LAN address.
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Private-Network': 'true',
      });
      return res.end();
    }
    if (route === 'manifest.json') return json(res, 200, addon.manifest);
    let m = route.match(/^catalog\/(movie|series)\/(hebits-home|hebits-search)(?:-movies)?(?:\/([^/]*))?\.json$/);
    if (m) {
      // A malformed `%` in the search text is a bad request from whoever built the URL,
      // not a server error - decodeURIComponent throws URIError on it either way.
      let extra;
      try {
        extra = m[3] && decodeURIComponent(m[3]);
      } catch {
        return json(res, 404, { error: 'not found' });
      }
      const handler = m[2] === 'hebits-search' ? addon.handleSearchCatalog : addon.handleCatalog;
      return json(res, 200, { metas: await handler(m[1], extra, baseUrl) });
    }
    m = route.match(/^meta\/(movie|series)\/(.+)\.json$/);
    if (m) {
      // Same malformed-`%` guard as above: a bad id is a 404, not a 500.
      try {
        decodeURIComponent(m[2]);
      } catch {
        return json(res, 404, { error: 'not found' });
      }
      const find = parseFindId(m[2]);
      const meta = find ? await addon.handleFindMeta(m[1], find, baseUrl) : await addon.handleMeta(m[2], baseUrl);
      return meta ? json(res, 200, { meta }) : json(res, 404, { error: 'not found' });
    }
    m = route.match(/^stream\/(movie|series)\/(.+)\.json$/);
    if (m) {
      try {
        decodeURIComponent(m[2]);
      } catch {
        return json(res, 404, { error: 'not found' });
      }
      if (parseFindId(m[2])) return json(res, 200, { streams: await addon.handleFindStream(m[1], parseFindId(m[2]), baseUrl) });
      if (parseHebitsId(m[2])) return json(res, 200, { streams: await addon.handleLibraryStream(m[1], m[2], baseUrl) });
      return json(res, 200, { streams: await addon.handleStream(m[1], m[2], baseUrl) });
    }
    m = route.match(/^poster\/([0-9a-fA-F]{40}|[0-9a-fA-F]{64}|\d+)$/);
    if (m) return await addon.handlePoster(res, m[1]);
    m = route.match(/^play\/h\/([0-9a-fA-F]{40}|[0-9a-fA-F]{64})\/(\d+)\/(\d+)$/);
    if (m) return await player.handlePlayLocal(req, res, m[1].toLowerCase(), m[2], m[3]);
    // The search-failure `⚠️` stream's url (see streamsFor in lib/addon.js): tapping it
    // used to hit no route at all (a bare JSON 404). Give it a readable message instead,
    // through the same UserError path every other play failure already uses.
    if (route === 'play/error/0/0') throw new UserError('Hebits search failed - check Jackett (the login cookie may have expired).');
    m = route.match(/^play\/(\d+)\/(\d+)\/(\d+)$/);
    if (m) return await player.handlePlay(req, res, m[1], m[2], m[3], url.searchParams);
    if (route === 'notify-test') {
      const sent = await notifier.send('test', 'Hebits addon test', 'Notifications from the Hebits addon work.', { force: true });
      return json(res, sent ? 200 : 502, { sent, enabled: notifier.enabled });
    }
    if (route === 'status') {
      const d = await daily();
      const st = d.stats;
      return json(res, 200, {
        version: VERSION,
        account: st && {
          class: st.userClass,
          uploadedGB: +(st.uploaded / GB).toFixed(2),
          downloadedGB: +(st.downloaded / GB).toFixed(2),
          ratio: st.ratio,
          requiredRatio: st.requiredRatio,
          towardHebUser: `downloaded ${(st.downloaded / GB).toFixed(1)}/20 GB, ratio ${st.downloaded ? (st.uploaded / st.downloaded).toFixed(2) : '∞'}/1.25`,
        },
        downloadsToday: `${d.used}/${d.limit}`,
        health: { ...health, logFile: LOG_FILE },
        freeGB: Math.round(((await qbit.freeSpace()) || 0) / GB),
      });
    }
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    log(`${req.method} ${route}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(err instanceof UserError ? 409 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err.message);
    } else res.destroy();
  }
});

// launchd keeps the log file open in append mode: copy then truncate.
function rotateLog() {
  try {
    if (statSync(LOG_FILE).size < 20 * 1024 * 1024) return;
    copyFileSync(LOG_FILE, `${LOG_FILE}.1`);
    truncateSync(LOG_FILE, 0);
    log('log rotated');
  } catch {}
}

rotateLog();
setInterval(rotateLog, 3600_000);
const runRestoreFocus = () => player.restoreFocus().catch((e) => log(`restore focus: ${e.message}`));
runRestoreFocus();
setInterval(runRestoreFocus, 30_000);

// The default port collides with the AirPlay Receiver service on macOS (see the README),
// so a first run there is a likely EADDRINUSE - explain it instead of a raw stack dump.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`port ${cfg.port} is already in use. Change "port" in config.json (see the README) and try again.`);
    process.exit(1);
  }
  throw err;
});
server.listen(cfg.port, '0.0.0.0', () => log(`hebits addon v${VERSION} listening on :${cfg.port}`));

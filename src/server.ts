// Hebits Stremio addon. Streams torrents from your own qBittorrent, no debrid service.
import { timingSafeEqual } from 'node:crypto';
import { copyFileSync, statSync, truncateSync } from 'node:fs';
import type { HttpBindings } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { Hebits } from 'hebits-client';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { type MediaType, makeAddon } from './addon';
import { CONFIG_DIR, loadConfig, writeCookie } from './config';
import type { CookiePageReq, CookiePageRes } from './cookie-page';
import { handleCookiePage } from './cookie-page';
import { CoverCache } from './covers';
import { makeGrabber, UserError } from './grab';
import { createHealthTracker } from './health';
import { makeHebits } from './hebits';
import { HomeLibrary } from './home';
import { parseHebitsId } from './library';
import { Notifier } from './notify';
import { makePlayer } from './play';
import { QBit } from './qbit';
import { parseFindId } from './search';
import { Store } from './store';
import { TorrentMeta } from './torrentmeta';
import { VERSION } from './version';

const log = (...a: unknown[]): void => console.log(new Date().toISOString(), ...a);

const cfg = loadConfig();
const store = new Store(CONFIG_DIR, cfg.timezone, (m) => log(m));
// The cookie MUST be a provider, never a bound string - see hebits.ts's makeHebits() for
// why (a paste through /cookie must take effect on the very next call, not the next
// restart).
const hebits = makeHebits(cfg);
const qbit = new QBit(cfg);
store.data.notified ??= {};
const notifier = new Notifier(
  cfg.notify || {},
  store.data.notified,
  () => store.save(),
  (m) => log(m),
);
const home = new HomeLibrary(qbit, log);
const torrentMeta = new TorrentMeta(qbit, log);
const covers = new CoverCache();
const LOG_FILE = cfg.logFile;
const GB = 1024 ** 3;

const { ensureTorrent, daily } = makeGrabber({ cfg, store, hebits, qbit, log });
const { health, noteLogin } = createHealthTracker(notifier, log);
const addon = makeAddon({ cfg, store, hebits, qbit, home, covers, daily, version: VERSION, log, noteLogin });
const player = makePlayer({ cfg, store, qbit, home, torrentMeta, ensureTorrent, cachedItem: addon.cachedItem, log });

function isMediaType(x: string | undefined): x is MediaType {
  return x === 'movie' || x === 'series';
}

// ---- request handling -----------------------------------------------------

function tokenOk(given: string | undefined): boolean {
  const a = Buffer.from(given || '');
  const b = Buffer.from(cfg.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

type AppEnv = { Bindings: HttpBindings };

function json(c: Context<AppEnv>, code: ContentfulStatusCode, body: unknown): Response {
  return c.json(body, code, {
    // c.json()'s own default is a bare `application/json` (no charset); server.js always
    // sent the charset, so it's spelled out here rather than left to Hono's default.
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
  });
}

// A stray `%` in a route segment is a malformed request from whoever built the URL, not a
// server error - decodeURIComponent throws URIError on it either way. The handlers below
// take the RAW (still-encoded) id, exactly as server.js's `m[2]` did, so only whether this
// returns null is used by a caller, never the decoded string itself.
//
// Returns the decoded value (never a bare `decodeURIComponent(s);` statement, nor a
// tautology like `.length >= 0` that only exists to have *a* return value) because
// rolldown's dead-code elimination cannot see that decodeURIComponent can throw: a call
// whose result is provably unused - or whose result the optimizer can fold to a constant
// regardless of input - gets removed as "pure", taking the whole try/catch, and this guard,
// out of the shipped bundle. A caller branching on `=== null` genuinely depends on a value
// that cannot be computed without calling decodeURIComponent on a runtime string, so
// there's nothing left for an optimizer to fold away. See test/bundle.test.ts, which
// exercises dist/ for exactly this class of bug.
function decodeOrNull(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

// Private Network Access: lets an https web page fetch from this LAN address.
function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Private-Network': 'true',
    },
  });
}

// Adapts a Hono request into the minimal streaming-body shape handleCookiePage expects, so
// its own body-accumulation and 16KB cutoff (in cookie-page.ts) run unchanged.
function toCookiePageReq(c: Context<AppEnv>): CookiePageReq {
  return {
    method: c.req.method,
    async *[Symbol.asyncIterator]() {
      const reader = c.req.raw.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          yield decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

// handleCookiePage writes through a writeHead/end pair (its own CookiePageRes shape); this
// captures that into a real Response instead of a node ServerResponse.
async function runCookiePage(c: Context<AppEnv>): Promise<Response> {
  let statusCode = 200;
  let headers: Record<string, string> = {};
  let body = '';
  const res: CookiePageRes = {
    writeHead(code, h) {
      statusCode = code;
      headers = h;
    },
    end(b = '') {
      body = b;
    },
  };
  // The dependency list handleCookiePage takes is exactly {health, log, hebits,
  // writeCookie, noteLogin} - see cookie-page.ts's CookiePageDeps. Passing a subset would
  // throw a ReferenceError inside the one page that exists to recover from a broken
  // login, so every member is listed here explicitly.
  await handleCookiePage(toCookiePageReq(c), res, {
    health,
    log,
    // A fresh, disposable client bound to the candidate cookie - verifying a paste must
    // never touch the cookie the running server (`hebits` above) is already using. Still a
    // provider (never a bound string), matching CookiePageDeps' own doc comment and
    // hebits.ts's makeHebits() - consistency at this one boundary matters more than the
    // string form being harmless for a single verify-and-discard call.
    hebits: (cookie: string) => new Hebits({ cookie: () => cookie }),
    writeCookie: (cookie: string) => writeCookie(cfg.cookiePath, cookie),
    noteLogin,
  });
  return new Response(body, { status: statusCode, headers });
}

const app = new Hono<AppEnv>();

app.all('*', async (c) => {
  // Parsed from the raw URL, exactly as server.js's `new URL(req.url, 'http://x')` did -
  // never from Hono's own (decoding) path parser - so a malformed `%` in an id surfaces
  // through the same explicit decodeURIComponent/catch below, not through Hono's routing.
  const url = new URL(c.req.url);
  const [, token, ...rest] = url.pathname.split('/');
  if (!tokenOk(token)) return json(c, 404, { error: 'not found' });
  const baseUrl = `http://${c.req.header('host')}/${token}`;
  const route = rest.join('/');
  const { incoming, outgoing } = c.env;
  // Set once a handler starts writing straight to the raw node response (poster/play),
  // bypassing Hono's own Response entirely - the catch block below needs to know which
  // response object a failure must be reported through.
  let usedRaw = false;
  try {
    if (!route.startsWith('play/'))
      log(`${c.req.method} ${route} origin=${c.req.header('origin') || '-'} ua=${c.req.header('user-agent') || '-'}`);
    if (c.req.method === 'OPTIONS') return preflight();

    if (route === 'manifest.json') return json(c, 200, addon.manifest);

    let m = route.match(/^catalog\/(movie|series)\/(hebits-home|hebits-search)(?:-movies)?(?:\/([^/]*))?\.json$/);
    if (m) {
      const [, type, kind, extraRaw] = m;
      if (!isMediaType(type) || kind === undefined) return json(c, 404, { error: 'not found' });
      // A malformed `%` in the search text is a bad request from whoever built the URL,
      // not a server error - decodeURIComponent throws URIError on it either way.
      let extra: string | undefined;
      try {
        extra = extraRaw && decodeURIComponent(extraRaw);
      } catch {
        return json(c, 404, { error: 'not found' });
      }
      const handler = kind === 'hebits-search' ? addon.handleSearchCatalog : addon.handleCatalog;
      return json(c, 200, { metas: await handler(type, extra, baseUrl) });
    }

    m = route.match(/^meta\/(movie|series)\/(.+)\.json$/);
    if (m) {
      const [, type, rawId] = m;
      if (!isMediaType(type) || rawId === undefined) return json(c, 404, { error: 'not found' });
      // Same malformed-`%` guard as above: a bad id is a 404, not a 500.
      if (decodeOrNull(rawId) === null) return json(c, 404, { error: 'not found' });
      const find = parseFindId(rawId);
      const meta = find ? await addon.handleFindMeta(type, find, baseUrl) : await addon.handleMeta(rawId, baseUrl);
      return meta ? json(c, 200, { meta }) : json(c, 404, { error: 'not found' });
    }

    m = route.match(/^stream\/(movie|series)\/(.+)\.json$/);
    if (m) {
      const [, type, rawId] = m;
      if (!isMediaType(type) || rawId === undefined) return json(c, 404, { error: 'not found' });
      if (decodeOrNull(rawId) === null) return json(c, 404, { error: 'not found' });
      const findRef = parseFindId(rawId);
      if (findRef) return json(c, 200, { streams: await addon.handleFindStream(type, findRef, baseUrl) });
      if (parseHebitsId(rawId)) return json(c, 200, { streams: await addon.handleLibraryStream(type, rawId, baseUrl) });
      return json(c, 200, { streams: await addon.handleStream(type, rawId, baseUrl) });
    }

    m = route.match(/^poster\/([0-9a-fA-F]{40}|[0-9a-fA-F]{64}|\d+)$/);
    if (m) {
      const [, ref] = m;
      if (ref === undefined) return json(c, 404, { error: 'not found' });
      usedRaw = true;
      await addon.handlePoster(outgoing, ref);
      return RESPONSE_ALREADY_SENT;
    }

    m = route.match(/^play\/h\/([0-9a-fA-F]{40}|[0-9a-fA-F]{64})\/(\d+)\/(\d+)$/);
    if (m) {
      const [, hash, s, e] = m;
      if (hash === undefined || s === undefined || e === undefined) return json(c, 404, { error: 'not found' });
      usedRaw = true;
      await player.handlePlayLocal(incoming, outgoing, hash.toLowerCase(), s, e);
      return RESPONSE_ALREADY_SENT;
    }

    // The search-failure `⚠️` stream's url (see streamsFor in addon.ts): tapping it used
    // to hit no route at all (a bare JSON 404). Give it a readable message instead,
    // through the same UserError path every other play failure already uses.
    if (route === 'play/error/0/0') throw new UserError('Hebits search failed - check the Hebits login cookie (it may have expired).');

    m = route.match(/^play\/(\d+)\/(\d+)\/(\d+)$/);
    if (m) {
      const [, hebitsId, s, e] = m;
      if (hebitsId === undefined || s === undefined || e === undefined) return json(c, 404, { error: 'not found' });
      usedRaw = true;
      await player.handlePlay(incoming, outgoing, hebitsId, s, e, url.searchParams);
      return RESPONSE_ALREADY_SENT;
    }

    if (route === 'cookie') return runCookiePage(c);

    if (route === 'notify-test') {
      const sent = await notifier.send('test', 'Hebits addon test', 'Notifications from the Hebits addon work.', { force: true });
      return json(c, sent ? 200 : 502, { sent, enabled: notifier.enabled });
    }

    if (route === 'status') {
      const d = await daily();
      // Read separately from daily() - dailyDownloads() no longer carries stats - and
      // tolerated: /status must still render without an account section when the tracker
      // is unreachable, exactly as a missing d.stats degraded before.
      const st = await hebits.stats().catch((e: Error) => {
        // e.message is a transport/API error (HTTP status, schema mismatch, etc.), never
        // the cookie itself - see grab.ts's identical `hebits daily downloads: …` log for
        // the same pattern against the same client.
        log(`hebits stats: ${e.message}`);
        return undefined;
      });
      return json(c, 200, {
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
        // configIssues surfaces a config.json typo here, rather than leaving it buried in
        // the log as the only trace - see config.ts's loadConfig().
        health: { ...health, logFile: LOG_FILE, configIssues: cfg.configIssues },
        freeGB: Math.round(((await qbit.freeSpace()) || 0) / GB),
      });
    }

    return json(c, 404, { error: 'not found' });
  } catch (err) {
    const message = (err as Error).message;
    log(`${c.req.method} ${route}: ${message}`);
    const status = err instanceof UserError ? 409 : 500;
    if (usedRaw) {
      if (!outgoing.headersSent) {
        outgoing.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
        outgoing.end(message);
      } else {
        outgoing.destroy();
      }
      return RESPONSE_ALREADY_SENT;
    }
    return c.text(message, status, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

// launchd keeps the log file open in append mode: copy then truncate.
function rotateLog(): void {
  try {
    if (statSync(LOG_FILE).size < 20 * 1024 * 1024) return;
    copyFileSync(LOG_FILE, `${LOG_FILE}.1`);
    truncateSync(LOG_FILE, 0);
    log('log rotated');
  } catch {
    // best-effort; a rotation failure must not take the server down
  }
}

rotateLog();
setInterval(rotateLog, 3600_000);
const runRestoreFocus = (): void => {
  player.restoreFocus().catch((e: Error) => log(`restore focus: ${e.message}`));
};
runRestoreFocus();
setInterval(runRestoreFocus, 30_000);

const server = serve({ fetch: app.fetch, hostname: '0.0.0.0', port: cfg.port }, () =>
  log(`hebits addon v${VERSION} listening on :${cfg.port}`),
);

// The default port collides with the AirPlay Receiver service on macOS (see the README),
// so a first run there is a likely EADDRINUSE - explain it instead of a raw stack dump.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log(`port ${cfg.port} is already in use. Change "port" in config.json (see the README) and try again.`);
    process.exit(1);
  }
  throw err;
});

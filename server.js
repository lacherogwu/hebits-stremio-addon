// Hebits Stremio addon. Streams torrents from your own qBittorrent, no debrid service.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, copyFileSync, truncateSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig, CONFIG_DIR } from './lib/config.js';
import { Store } from './lib/store.js';
import { Jackett } from './lib/jackett.js';
import { Notifier } from './lib/notify.js';
import { QBit } from './lib/qbit.js';
import { buildTags, parseTags } from './lib/tags.js';
import { readTorrent } from './lib/bencode.js';
import { pickFile, VIDEO_EXT, showName, seasonInfo } from './lib/parse.js';
import { parseHebitsId, kindOf, catalogMetas, metaFor, matchesSearch } from './lib/library.js';
import { parseFindId, itemsFor, groupResults, findMeta } from './lib/search.js';
import { buildStreams } from './lib/streams.js';
import { serveFile } from './lib/streamer.js';
import { focusPlan, restorePlan, shouldRestore, NORMAL, TOP } from './lib/focus.js';
import { HebitsSite } from './lib/hebits.js';
import { createHealthTracker } from './lib/health.js';

const cfg = loadConfig();
const store = new Store(CONFIG_DIR, cfg.timezone);
const jackett = new Jackett(cfg);
const qbit = new QBit(cfg);
const site = new HebitsSite(cfg.jackettIndexerConfig);
const notifier = new Notifier(cfg.notify || {}, (store.data.notified ??= {}), () => store.save(), (m) => log(m));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const LOG_FILE = cfg.logFile;
const GB = 1024 ** 3;
const FOCUS_IDLE_MS = 20 * 60 * 1000;
const CINEMETA = 'https://v3-cinemeta.strem.io';
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version;

const manifest = {
  id: 'net.hebits.home',
  version: VERSION,
  name: 'Hebits (Home)',
  description: 'Hebits, no debrid: downloads with qBittorrent, seeds forever, streams over the home network.',
  logo: 'https://hebits.net/favicon.ico',
  resources: [
    'catalog',
    { name: 'meta', types: ['movie', 'series'], idPrefixes: ['hebits:'] },
    { name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt', 'hebits:'] },
  ],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'hebits:'],
  catalogs: [
    { type: 'series', id: 'hebits-home', name: '🏠 Hebits at home', showInHome: true, extra: [{ name: 'search' }] },
    { type: 'movie', id: 'hebits-home-movies', name: '🏠 Hebits movies at home', showInHome: true, extra: [{ name: 'search' }] },
    { type: 'series', id: 'hebits-search', name: '🔎 Hebits series', extra: [{ name: 'search', isRequired: true }] },
    { type: 'movie', id: 'hebits-search-movies', name: '🔎 Hebits movies', extra: [{ name: 'search', isRequired: true }] },
  ],
  behaviorHints: { configurable: false },
};

// Index .torrent files grabbed outside the addon (e.g. the seeding packs) so their
// results show as local.
function indexTorrentDir() {
  if (!existsSync(cfg.torrentDir)) return;
  for (const f of readdirSync(cfg.torrentDir)) {
    const id = f.match(/^hebits-(\d+)\.torrent$/)?.[1];
    if (!id || store.torrent(id)?.hash) continue;
    try {
      const t = readTorrent(readFileSync(join(cfg.torrentDir, f)));
      store.putTorrent(id, { hash: t.infoHash, name: t.name, files: t.files, pieceLength: t.pieceLength });
      log(`indexed ${f} -> ${t.infoHash}`);
    } catch (e) {
      log(`index ${f}: ${e.message}`);
    }
  }
}

class UserError extends Error {}

const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(key, run.finally(() => locks.get(key) === run && locks.delete(key)));
  return run;
}

// Downloads used/allowed today: Hebits' own counter when reachable, else local count.
async function daily({ fresh = false } = {}) {
  try {
    const s = await site.stats({ fresh });
    if (s.dailyLimit !== undefined) return { used: s.dailyUsed, limit: s.dailyLimit, stats: s };
  } catch (e) {
    log(`hebits stats: ${e.message}`);
  }
  return { used: store.grabsToday(), limit: store.limitToday(cfg) };
}

async function ensureTorrent(hebitsId, meta, { category = cfg.watchCategory, savePath = cfg.watchPath } = {}) {
  return withLock(hebitsId, async () => {
    let entry = store.torrent(hebitsId);
    if (entry?.hash && (await qbit.torrent(entry.hash))) {
      if (meta.imdb && !entry.imdb) store.putTorrent(hebitsId, meta);
      return store.torrent(hebitsId);
    }

    const file = join(cfg.torrentDir, `hebits-${hebitsId}.torrent`);
    let buf;
    if (existsSync(file)) {
      buf = readFileSync(file); // re-adding a torrent we already have doesn't touch Hebits
    } else {
      const d = await daily({ fresh: true });
      if (d.used >= d.limit) throw new UserError('daily download limit reached');
      const free = await qbit.freeSpace();
      if (meta.size && free !== undefined && meta.size > free - cfg.minFreeGB * GB) throw new UserError('not enough disk space');
      buf = await jackett.downloadTorrent(hebitsId);
      let parsed;
      try {
        parsed = readTorrent(buf);
      } catch {
        throw new UserError(`Hebits refused the download: ${buf.toString('utf8', 0, 200).replace(/\s+/g, ' ')}`);
      }
      if (!parsed.private) throw new UserError('torrent is not private; refusing');
      writeFileSync(file, buf, { mode: 0o600 });
      store.recordGrab(hebitsId);
      site.cached = null;
      log(`grabbed hebits ${hebitsId} (${meta.title}) into ${category}`);
    }

    const t = readTorrent(buf);
    await qbit.ensureCategory(category, savePath);
    if (!(await qbit.torrent(t.infoHash))) {
      await qbit.add(buf, `hebits-${hebitsId}.torrent`, { category, savePath });
    }
    store.putTorrent(hebitsId, { ...meta, hash: t.infoHash, name: t.name, files: t.files, pieceLength: t.pieceLength });
    for (let i = 0; i < 40 && !(await qbit.torrent(t.infoHash)); i++) await sleep(250);
    // Identity for anything reading qBittorrent later, including the account builder.
    await qbit.addTags(t.infoHash, buildTags({ hebitsId, imdb: meta.imdb })).catch((e) => log(`tag ${hebitsId}: ${e.message}`));
    return store.torrent(hebitsId);
  });
}

async function localStatus(ids) {
  const byHash = new Map();
  for (const id of ids) {
    const e = store.torrent(id);
    if (e?.hash) byHash.set(e.hash, id);
  }
  const out = new Map();
  for (const t of await qbit.torrents([...byHash.keys()]).catch(() => [])) {
    out.set(byHash.get(t.hash), { progress: t.progress, state: t.state, dlspeed: t.dlspeed });
  }
  return out;
}

async function handleStream(type, rawId, baseUrl) {
  const [imdb, s, e] = decodeURIComponent(rawId).split(':');
  const season = s ? Number(s) : undefined;
  const episode = e ? Number(e) : undefined;
  if (!/^tt\d+$/.test(imdb) || (type === 'series' && !(season && episode))) return [];

  let items = [];
  let searchError;
  try {
    items = (await jackett.forTitle(type, imdb, season)).filter((it) => !it.imdb || it.imdb === imdb);
    searchOk();
  } catch (err) {
    searchError = searchFailed(type, rawId, err);
  }
  // Keep titles already at home even if search fails or no longer lists them.
  const seen = new Set(items.map((it) => it.hebitsId));
  for (const t of store.torrentsFor(imdb)) {
    if (!seen.has(t.hebitsId) && t.title) {
      items.push({ hebitsId: t.hebitsId, title: t.title, size: t.size, files: t.fileCount, atHomeOnly: true });
    }
  }

  return streamsFor({ type, items, season, episode, searchError, baseUrl, query: `?imdb=${imdb}&type=${type}` });
}

// A Jackett search only returns results when the indexer login works (parseTorznab
// throws on a Torznab <error>), so a search that completes is evidence the cookie is
// still good - the mirror image of searchFailed below.
function searchOk() {
  noteLogin(true);
}

function searchFailed(type, id, err) {
  noteLogin(false, `Jackett search: ${err.message}`);
  log(`search ${type} ${id}: ${err.message}`);
  return err.message;
}

async function streamsFor({ type, items, season, episode, searchError, baseUrl, query }) {
  const local = await localStatus(items.map((it) => it.hebitsId));
  warmUp(local, type === 'series' ? { season, episode } : null);
  const d = await daily();
  const grabsLeft = Math.max(0, d.limit - d.used);
  const freeBytes = await qbit.freeSpace().catch(() => undefined);
  const suffix = type === 'series' ? `/${season}/${episode}` : '/0/0';
  const streams = buildStreams({
    items,
    local,
    type,
    season,
    episode,
    grabsLeft,
    dailyLimit: d.limit,
    freeBytes,
    minFreeBytes: cfg.minFreeGB * GB,
    playUrl: (id) => `${baseUrl}/play/${id}${suffix}${query}`,
  });
  if (searchError) {
    streams.push({
      name: '🏠 Hebits\n⚠️',
      description: `Hebits search failed: ${searchError}\nCheck Jackett (cookie may have expired).`,
      url: `${baseUrl}/play/error/0/0`,
    });
  }
  return streams;
}

// ---- search all of Hebits -------------------------------------------------

const filesOf = (hebitsId) => store.torrent(hebitsId)?.files;

async function handleSearchCatalog(type, extraPath, baseUrl) {
  const q = new URLSearchParams(extraPath || '').get('search')?.trim();
  if (!q) return [];
  try {
    const results = await jackett.search({ t: 'search', q });
    searchOk();
    return groupResults(results, type, { posterUrl: (id) => `${baseUrl}/poster/${id}` });
  } catch (err) {
    searchFailed(type, `"${q}"`, err);
    return [];
  }
}

const PAGE_SIZE = 50; // Hebits returns one page of results, no paging

// Uploads of one titled card. Big shows don't fit on one result page, so series also
// get season-scoped queries: the requested season, or (allSeasons) every season up to
// one past the highest seen.
async function findItems(name, type, { season, allSeasons = false } = {}) {
  const byId = new Map();
  const collect = (list) => {
    for (const it of itemsFor(list, name, type)) byId.set(it.hebitsId, it);
  };
  const bySeason = (n) => jackett.search({ t: 'tvsearch', q: name, season: String(n) });
  const [first] = await Promise.all([jackett.search({ t: 'search', q: name }), season && bySeason(season).then(collect)]);
  searchOk();
  collect(first);
  if (type === 'series' && allSeasons && first.length >= PAGE_SIZE) {
    const seasonOf = (it) => seasonInfo(it.title)?.season ?? seasonInfo(it.title)?.to ?? 0;
    const top = Math.min(30, Math.max(1, ...[...byId.values()].map(seasonOf)) + 1);
    const lists = await Promise.all(Array.from({ length: top }, (_, i) => bySeason(i + 1).catch(() => [])));
    lists.forEach(collect);
  }
  return [...byId.values()];
}

async function handleFindMeta(type, ref, baseUrl) {
  const items = await findItems(ref.name, type, { allSeasons: true });
  if (!items.length) return null;
  const imdb = items.find((it) => it.imdb)?.imdb;
  const extra = imdb ? await cinemeta(type, imdb) : undefined;
  return findMeta(ref.name, type, items, { posterUrl: (id) => `${baseUrl}/poster/${id}`, filesOf, extra });
}

async function handleFindStream(type, ref, baseUrl) {
  if (type === 'series' && !ref.season) return [];
  let items = [];
  let searchError;
  try {
    items = await findItems(ref.name, type, { season: ref.season });
  } catch (err) {
    searchError = searchFailed(type, ref.name, err);
  }
  return streamsFor({ type, items, season: ref.season, episode: ref.episode, searchError, baseUrl, query: `?type=${type}` });
}

// ---- home library -------------------------------------------------------

async function libraryEntries() {
  const all = Object.entries(store.data.torrents)
    .filter(([, t]) => t.hash)
    .map(([hebitsId, t]) => ({ hebitsId, ...t }));
  const present = await qbit.torrents(all.map((t) => t.hash)).catch(() => []);
  const progress = new Map();
  for (const t of present) {
    const e = all.find((x) => x.hash === t.hash);
    if (e) progress.set(e.hebitsId, t.progress);
  }
  return { entries: all.filter((e) => progress.has(e.hebitsId)), progress };
}

// Torrents grabbed outside the addon have no IMDb id or cover yet: look them up once.
async function enrich(entry) {
  if (entry.enrichedAt || (entry.imdb && entry.cover)) return;
  try {
    const items = await jackett.search({ t: 'search', q: showName(entry.name) });
    const it = items.find((x) => x.hebitsId === entry.hebitsId);
    const update = { enrichedAt: new Date().toISOString() };
    if (it) Object.assign(update, { imdb: entry.imdb || it.imdb, cover: it.cover, title: it.title, size: it.size, fileCount: it.files });
    store.putTorrent(entry.hebitsId, update);
    Object.assign(entry, update);
  } catch (err) {
    log(`enrich ${entry.hebitsId}: ${err.message}`);
  }
}

const cinemetaCache = new Map();
async function cinemeta(type, imdb) {
  const key = `${type}/${imdb}`;
  const hit = cinemetaCache.get(key);
  if (hit && Date.now() - hit.at < 864e5) return hit.meta;
  const meta = await fetch(`${CINEMETA}/meta/${key}.json`, { signal: AbortSignal.timeout(10_000) })
    .then((r) => (r.ok ? r.json() : {}))
    .then((j) => j.meta)
    .catch(() => undefined);
  cinemetaCache.set(key, { at: Date.now(), meta });
  return meta;
}

const posterUrl = (baseUrl) => (e) => (e.cover || e.imdb ? `${baseUrl}/poster/${e.hebitsId}` : undefined);

async function handleCatalog(type, extraPath, baseUrl) {
  const extra = new URLSearchParams(extraPath || '');
  const { entries, progress } = await libraryEntries();
  await Promise.all(entries.map(enrich));
  const metas = catalogMetas(entries, type, { progress, posterUrl: posterUrl(baseUrl) });
  const q = extra.get('search')?.trim();
  return q ? metas.filter((m) => matchesSearch(m, q)) : metas;
}

async function handleMeta(rawId, baseUrl) {
  const ref = parseHebitsId(rawId);
  const { entries, progress } = await libraryEntries();
  const entry = ref && entries.find((e) => e.hebitsId === ref.hebitsId);
  if (!entry) return null;
  await enrich(entry);
  const extra = entry.imdb ? await cinemeta(kindOf(entry), entry.imdb) : undefined;
  return metaFor(entry, { progress: progress.get(entry.hebitsId), posterUrl: posterUrl(baseUrl), extra });
}

async function handleLibraryStream(type, rawId, baseUrl) {
  const ref = parseHebitsId(rawId);
  const entry = ref && store.torrent(ref.hebitsId);
  if (!entry?.hash) return [];
  const local = await localStatus([ref.hebitsId]);
  if (!local.size) return [];
  const suffix = ref.season ? `/${ref.season}/${ref.episode}` : '/0/0';
  return buildStreams({
    items: [
      {
        hebitsId: ref.hebitsId,
        title: entry.title || entry.name,
        size: entry.size ?? entry.files.reduce((n, f) => n + f.length, 0),
        files: entry.fileCount ?? entry.files.length,
        atHomeOnly: true,
        pinned: true,
      },
    ],
    local,
    type,
    season: ref.season,
    episode: ref.episode,
    grabsLeft: 1,
    dailyLimit: store.limitToday(cfg),
    minFreeBytes: 0,
    playUrl: (id) => `${baseUrl}/play/${id}${suffix}`,
  });
}

const cachedItem = (hebitsId) => [...jackett.cache.values()].flatMap((c) => c.items).find((it) => it.hebitsId === hebitsId);

async function handlePoster(res, hebitsId) {
  const entry = store.torrent(hebitsId);
  const cover = entry?.cover || cachedItem(hebitsId)?.cover;
  if (cover) {
    const r = await fetch(cover, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (r?.ok) {
      res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'max-age=604800' });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
  }
  if (entry?.imdb) {
    res.writeHead(302, { Location: `https://images.metahub.space/poster/medium/${entry.imdb}/img` });
    return res.end();
  }
  res.writeHead(404);
  res.end();
}

async function handlePlay(req, res, hebitsId, s, e, query) {
  let entry = store.torrent(hebitsId);
  const known = entry?.hash && (await qbit.torrent(entry.hash));
  // Some players probe with HEAD; never grab a new torrent for a probe.
  if (req.method === 'HEAD' && !known) {
    res.writeHead(200, { 'Accept-Ranges': 'bytes', 'Content-Type': 'video/x-matroska' });
    return res.end();
  }

  const item = cachedItem(hebitsId);
  if (!known && item && !(item.seeders > 0)) throw new UserError('no seeders on Hebits right now; not using a download on it');
  entry = await ensureTorrent(hebitsId, {
    imdb: query.get('imdb') || undefined,
    type: query.get('type') || undefined,
    title: item?.title ?? entry?.title,
    size: item?.size ?? entry?.size,
    fileCount: item?.files ?? entry?.fileCount,
    cover: item?.cover ?? entry?.cover,
  });

  const ep = Number(s) ? { season: Number(s), episode: Number(e) } : null;
  const target = pickFile(entry.files, ep);
  if (!target) throw new UserError(`no video file for ${ep ? `S${s}E${e}` : 'movie'} in ${entry.name}`);

  const [qfiles, props, info] = await Promise.all([qbit.files(entry.hash), qbit.properties(entry.hash), qbit.torrent(entry.hash)]);
  const qf =
    qfiles.find((f) => f.name === target.path) ||
    qfiles.find((f) => f.size === target.length && f.name.split('/').pop() === target.path.split('/').pop());
  if (!qf) throw new UserError(`file not found in qBittorrent: ${target.path}`);
  if (qf.progress < 1) await focusOn(entry.hash, qf.index, qfiles, info);
  if (req.method !== 'HEAD') log(`play ${hebitsId} ${qf.name} (${(qf.progress * 100).toFixed(1)}%) range=${req.headers.range || '-'} ua=${req.headers['user-agent'] || '-'}`);

  // content_path is the torrent's current location (unfinished files may still sit in
  // a per-torrent download_path); qBittorrent file names start with the root folder.
  const location = info.content_path ? dirname(info.content_path) : props.save_path;
  await serveFile(
    req,
    res,
    {
      qbit,
      hash: entry.hash,
      path: join(location, qf.name),
      size: qf.size,
      offset: target.offset,
      pieceLength: entry.pieceLength || props.piece_size,
      complete: qf.progress >= 1,
    },
    log,
  );
}

// Opening a title in Nuvio starts fetching the matching file of torrents already at
// home, so playback has a head start. Never grabs anything new.
function warmUp(local, ep) {
  for (const [id, st] of local) {
    if (st.progress >= 1) continue;
    const entry = store.torrent(id);
    const target = entry && pickFile(entry.files, ep);
    if (!target) continue;
    (async () => {
      const [qfiles, info] = await Promise.all([qbit.files(entry.hash), qbit.torrent(entry.hash)]);
      const qf = qfiles.find((f) => f.name === target.path);
      if (qf && qf.progress < 1) await focusOn(entry.hash, qf.index, qfiles, info);
    })().catch((e) => log(`warm-up ${id}: ${e.message}`));
  }
}

async function focusOn(hash, fileIndex, qfiles, info) {
  const focus = (store.data.focus ??= {});
  const prev = focus[hash];
  const { raise } = focusPlan(qfiles, fileIndex);
  if (raise.length) {
    // A previous focus in the same torrent goes back to normal first.
    const others = qfiles.filter((f) => f.index !== fileIndex && f.priority === TOP).map((f) => f.index);
    await qbit.setFilePriority(hash, others, NORMAL);
    await qbit.setFilePriority(hash, raise, TOP);
  }
  // Sequential helps a single big file (movies); first/last-piece boost only for
  // single-video torrents, since in a pack it would chase the ends of every file.
  const videos = qfiles.filter((f) => VIDEO_EXT.test(f.name)).length;
  await qbit.setSequential(hash, true, info.seq_dl);
  await qbit.setFirstLastPiecePrio(hash, videos === 1, info.f_l_piece_prio);
  focus[hash] = {
    file: fileIndex,
    at: Date.now(),
    // remember what the torrent looked like before we touched it
    seq: prev ? prev.seq : Boolean(info.seq_dl),
    fl: prev ? prev.fl : Boolean(info.f_l_piece_prio),
  };
  store.save();
}

async function restoreFocus() {
  const focus = store.data.focus || {};
  for (const [hash, f] of Object.entries(focus)) {
    try {
      const info = await qbit.torrent(hash);
      if (!info) {
        delete focus[hash];
        continue;
      }
      const qfiles = await qbit.files(hash);
      if (!shouldRestore(f, qfiles, Date.now(), FOCUS_IDLE_MS)) continue;
      await qbit.setFilePriority(hash, restorePlan(qfiles), NORMAL);
      await qbit.setSequential(hash, f.seq, info.seq_dl);
      await qbit.setFirstLastPiecePrio(hash, f.fl, info.f_l_piece_prio);
      delete focus[hash];
      log(`focus restored on ${info.name}`);
    } catch (e) {
      log(`restore ${hash}: ${e.message}`);
    }
  }
  store.save();
}

// ---- request handling -----------------------------------------------------

const { health, noteLogin } = createHealthTracker(notifier, log);

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
    if (route === 'manifest.json') return json(res, 200, manifest);
    let m = route.match(/^catalog\/(movie|series)\/(hebits-home|hebits-search)(?:-movies)?(?:\/([^/]*))?\.json$/);
    if (m) {
      const handler = m[2] === 'hebits-search' ? handleSearchCatalog : handleCatalog;
      return json(res, 200, { metas: await handler(m[1], m[3] && decodeURIComponent(m[3]), baseUrl) });
    }
    m = route.match(/^meta\/(movie|series)\/(.+)\.json$/);
    if (m) {
      const find = parseFindId(m[2]);
      const meta = find ? await handleFindMeta(m[1], find, baseUrl) : await handleMeta(m[2], baseUrl);
      return meta ? json(res, 200, { meta }) : json(res, 404, { error: 'not found' });
    }
    m = route.match(/^stream\/(movie|series)\/(.+)\.json$/);
    if (m && parseFindId(m[2])) return json(res, 200, { streams: await handleFindStream(m[1], parseFindId(m[2]), baseUrl) });
    if (m && parseHebitsId(m[2])) return json(res, 200, { streams: await handleLibraryStream(m[1], m[2], baseUrl) });
    if (m) return json(res, 200, { streams: await handleStream(m[1], m[2], baseUrl) });
    m = route.match(/^poster\/(\d+)$/);
    if (m) return await handlePoster(res, m[1]);
    m = route.match(/^play\/(\d+)\/(\d+)\/(\d+)$/);
    if (m) return await handlePlay(req, res, m[1], m[2], m[3], url.searchParams);
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

indexTorrentDir();
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
restoreFocus();
setInterval(restoreFocus, 30_000);
server.listen(cfg.port, '0.0.0.0', () => log(`hebits addon v${VERSION} listening on :${cfg.port}`));

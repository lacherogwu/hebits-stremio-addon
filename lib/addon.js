// Everything Stremio asks for: manifest, catalogs, metas, streams and posters.
import { pickFile, seasonInfo } from './parse.js';
import { parseHebitsId, kindOf, catalogMetas, metaFor, matchesSearch } from './library.js';
import { itemsFor, groupResults, findMeta } from './search.js';
import { buildStreams } from './streams.js';
import { IdentityResolver, normalizeTitle } from './identity.js';
import { focusOn } from './play.js';

const GB = 1024 ** 3;
const CINEMETA = 'https://v3-cinemeta.strem.io';
const PAGE_SIZE = 50; // Hebits returns one page of results, no paging

export function makeAddon({ cfg, store, jackett, qbit, home, daily, version, log, noteLogin }) {
  const manifest = {
    id: 'net.hebits.home',
    version,
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

  const identity = new IdentityResolver({
    jackett,
    qbit,
    cinemetaSearch,
    cache: (store.data.identity ??= {}),
    save: () => store.save(),
    log,
  });

  // "Ready at home" for Jackett search results. Tags give an exact answer; the release
  // name covers torrents added before tagging, or by another tool.
  async function localStatus(ids, items = []) {
    const entries = await home.entries();
    const byId = new Map(entries.filter((e) => e.hebitsId).map((e) => [e.hebitsId, e]));
    const byName = new Map(entries.map((e) => [normalizeTitle(e.name), e]));
    const out = new Map();
    for (const id of ids) {
      const item = items.find((it) => it.hebitsId === id);
      const hit = byId.get(id) || (item && byName.get(normalizeTitle(item.title)));
      if (hit) out.set(id, { progress: hit.progress, state: hit.state, dlspeed: 0 });
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
    for (const atHome of await home.entries()) {
      if (atHome.imdb === imdb && atHome.hebitsId && !seen.has(atHome.hebitsId)) {
        items.push({ hebitsId: atHome.hebitsId, title: atHome.name, size: atHome.size, files: atHome.files.length, atHomeOnly: true });
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
    const local = await localStatus(items.map((it) => it.hebitsId), items);
    warmUp(local, type === 'series' ? { season, episode } : null).catch((e) => log(`warm-up: ${e.message}`));
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
    const entries = await home.entries();
    await Promise.all(entries.map((e) => identity.resolve(e).catch(() => e)));
    return entries;
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

  // Recover an IMDb id from a release name. Works for most English releases; Israeli
  // titles with no IMDb entry stay unidentified, which no source could fix.
  const cinemetaSearchCache = new Map();
  async function cinemetaSearch(name) {
    if (cinemetaSearchCache.has(name)) return cinemetaSearchCache.get(name);
    let imdb;
    for (const type of ['series', 'movie']) {
      const url = `${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(name)}.json`;
      const j = await fetch(url, { signal: AbortSignal.timeout(10_000) })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      imdb = j?.metas?.[0]?.imdb_id || j?.metas?.[0]?.id;
      if (imdb?.startsWith('tt')) break;
      imdb = undefined;
    }
    cinemetaSearchCache.set(name, imdb);
    return imdb;
  }

  const posterUrl = (baseUrl) => (e) => (e.imdb || e.hebitsId ? `${baseUrl}/poster/${e.hash}` : undefined);

  async function handleCatalog(type, extraPath, baseUrl) {
    const extra = new URLSearchParams(extraPath || '');
    const entries = await libraryEntries();
    const metas = catalogMetas(entries, type, { posterUrl: posterUrl(baseUrl) });
    const q = extra.get('search')?.trim();
    return q ? metas.filter((m) => matchesSearch(m, q)) : metas;
  }

  async function handleMeta(rawId, baseUrl) {
    const ref = parseHebitsId(rawId);
    if (!ref) return null;
    const entry = (await libraryEntries()).find((e) => e.hash === ref.hash);
    if (!entry) return null;
    const extra = entry.imdb ? await cinemeta(kindOf(entry), entry.imdb) : undefined;
    return metaFor(entry, { posterUrl: posterUrl(baseUrl), extra });
  }

  async function handleLibraryStream(type, rawId, baseUrl) {
    const ref = parseHebitsId(rawId);
    if (!ref) return [];
    const entry = (await libraryEntries()).find((e) => e.hash === ref.hash);
    if (!entry) return [];
    const suffix = ref.season ? `/${ref.season}/${ref.episode}` : '/0/0';
    return buildStreams({
      items: [
        {
          hebitsId: entry.hash,
          title: entry.name,
          size: entry.size,
          files: entry.files.length,
          atHomeOnly: true,
          pinned: true,
        },
      ],
      local: new Map([[entry.hash, { progress: entry.progress, state: entry.state }]]),
      type,
      season: ref.season,
      episode: ref.episode,
      grabsLeft: 1,
      dailyLimit: store.limitToday(cfg),
      minFreeBytes: 0,
      playUrl: () => `${baseUrl}/play/h/${entry.hash}${suffix}`,
    });
  }

  const cachedItem = (hebitsId) => [...jackett.cache.values()].flatMap((c) => c.items).find((it) => it.hebitsId === hebitsId);

  async function handlePoster(res, ref) {
    const entry = /^\d+$/.test(ref) ? undefined : await home.byHash(ref.toLowerCase());
    const hebitsId = entry?.hebitsId || (/^\d+$/.test(ref) ? ref : undefined);
    const cover = hebitsId && cachedItem(hebitsId)?.cover;
    if (cover) {
      const r = await fetch(cover, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (r?.ok) {
        res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'max-age=604800' });
        return res.end(Buffer.from(await r.arrayBuffer()));
      }
    }
    const imdb = entry?.imdb;
    if (imdb) {
      res.writeHead(302, { Location: `https://images.metahub.space/poster/medium/${imdb}/img` });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  }

  // Opening a title in Nuvio starts fetching the matching file of torrents already at
  // home, so playback has a head start. Never grabs anything new.
  async function warmUp(local, ep) {
    const pending = [...local].filter(([, st]) => st.progress < 1);
    if (!pending.length) return;
    const byId = new Map((await home.entries()).filter((e) => e.hebitsId).map((e) => [e.hebitsId, e]));
    for (const [id, st] of pending) {
      const entry = byId.get(id);
      const target = entry && pickFile(entry.files, ep);
      if (!target) continue;
      (async () => {
        const [qfiles, info] = await Promise.all([qbit.files(entry.hash), qbit.torrent(entry.hash)]);
        const qf = qfiles.find((f) => f.name === target.path);
        if (qf && qf.progress < 1) await focusOn(qbit, store, entry.hash, qf.index, qfiles, info);
      })().catch((e) => log(`warm-up ${id}: ${e.message}`));
    }
  }

  return {
    manifest,
    handleCatalog,
    handleMeta,
    handleStream,
    handleSearchCatalog,
    handleFindMeta,
    handleFindStream,
    handleLibraryStream,
    handlePoster,
    libraryEntries,
    localStatus,
    cinemetaSearch,
    cachedItem,
  };
}

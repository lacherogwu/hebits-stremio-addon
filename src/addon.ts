// Everything Stremio asks for: manifest, catalogs, metas, streams and posters.
import type { BrowseOptions, HebitsTorrent } from 'hebits-client';
import type { CoverCache } from './covers';
import { hebitsKey } from './hebits';
import type { HomeEntry } from './home';
import { type IdentityQBit, IdentityResolver, normalizeTitle, type ReleaseItem } from './identity';
import { type CatalogMeta, catalogMetas, type FullMeta, kindOf, matchesSearch, metaFor, parseHebitsId } from './library';
import { type Episode, pickFile, seasonInfo } from './parse';
import { type CachedItem, type FocusQBit, focusOn, type PlayStore } from './play';
import { findMeta, groupResults, itemsFor, type ParsedFindId, type SearchCatalogMeta, type SearchExtra, type SearchMeta } from './search';
import type { DailyLimitConfig, StoreData } from './store';
import { buildStreams, type LocalStatus, type StreamItem, type StremioStream } from './streams';

const GB = 1024 ** 3;
const CINEMETA = 'https://v3-cinemeta.strem.io';
const PAGE_SIZE = 50; // Hebits returns one page of results, no paging
// Same bound as CoverCache: a long-lived process must not grow a cache without limit.
const ITEM_CACHE_MAX = 500;
// lib/jackett.js expired its search cache after ten minutes; so does this one.
const ITEM_CACHE_MS = 10 * 60 * 1000;

// --- the slices of each collaborator this module reads ------------------------------
// Narrow on purpose (the house style in play.ts/home.ts/grab.ts): a test fake stands in
// without `as any`, and nothing here can quietly start using a method it never declared.

export interface AddonConfig extends DailyLimitConfig {
  minFreeGB: number;
}

// `browse` is the only tracker call this module makes, directly or through anything it
// wires up - the `search` alias hebits-client still carries is deliberately not here.
export interface AddonHebits {
  browse(options?: BrowseOptions): Promise<HebitsTorrent[]>;
}

export interface AddonQBit extends FocusQBit, IdentityQBit {
  freeSpace(): Promise<number>;
}

export interface AddonStore extends PlayStore {
  data: StoreData;
  limitToday(cfg: DailyLimitConfig): number;
}

export interface AddonHome {
  entries(): Promise<HomeEntry[]>;
  byHash(hash: string): Promise<HomeEntry | undefined>;
}

// The slice of node's ServerResponse the poster route writes to. The route answers with
// bytes, a redirect or a 404 rather than a value, exactly as lib/addon.js did.
export interface PosterResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(chunk?: Buffer): unknown;
}

export interface AddonDeps {
  cfg: AddonConfig;
  store: AddonStore;
  hebits: AddonHebits;
  qbit: AddonQBit;
  home: AddonHome;
  covers: CoverCache;
  daily: () => Promise<{ used: number; limit: number }>;
  version: string;
  log: (message: string) => void;
  noteLogin: (ok: boolean, error?: string) => void;
  // Cinemeta and the poster route are the only outbound HTTP this module does. Injected
  // (defaulting to the global) so tests reach no network at all - the same seam
  // identity.ts gives `cinemetaSearch` and `now`.
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface ManifestResource {
  name: string;
  types: string[];
  idPrefixes: string[];
}

export interface ManifestCatalog {
  type: string;
  id: string;
  name: string;
  showInHome?: boolean;
  extra: { name: string; isRequired?: boolean }[];
}

export interface Manifest {
  id: string;
  version: string;
  name: string;
  description: string;
  logo: string;
  resources: (string | ManifestResource)[];
  types: string[];
  idPrefixes: string[];
  catalogs: ManifestCatalog[];
  behaviorHints: { configurable: boolean };
}

// The search-failure row is not a playable stream: it carries no behaviorHints, and its
// url is the `play/error/0/0` route that answers with a readable message.
export interface NoticeStream {
  name: string;
  description: string;
  url: string;
}

export type AddonStream = StremioStream | NoticeStream;

export type MediaType = 'movie' | 'series';

// A tracker result as the caches read it: identity.ts's narrow ReleaseItem (id, name,
// cover - all a release-name lookup promises), plus the fields play.ts wants at grab time
// when a full HebitsTorrent is what arrived. For a ReleaseItem those stay undefined: the
// same "nothing known" a cache miss gives, never a wrong size or a phantom 0 seeders.
type RememberedItem = ReleaseItem & Partial<Pick<HebitsTorrent, 'size' | 'fileCount' | 'seeders'>>;

export function makeAddon({
  cfg,
  store,
  hebits,
  qbit,
  home,
  covers,
  daily,
  version,
  log,
  noteLogin,
  fetchImpl,
  now = Date.now,
}: AddonDeps) {
  const doFetch = fetchImpl ?? fetch;
  const manifest: Manifest = {
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

  // ---- what the tracker last said about an id -------------------------------
  // lib/addon.js rummaged through the indexer client's private search cache for this
  // (`[...jackett.cache.values()].flatMap(c => c.items).find(...)`). That client is gone,
  // so the two things that cache was read for are remembered here instead, at the one
  // point every tracker result passes through: the cover, in the injected CoverCache the
  // poster route reads, and the handful of fields play.ts's `cachedItem` reads (the
  // no-seeders guard, and the title/size/fileCount/cover written into the store at grab
  // time). A miss still means "nothing known" for both, exactly as a cache miss did.

  const itemCache = new Map<string, { at: number; item: CachedItem }>();

  function remember<T extends RememberedItem>(items: T[]): T[] {
    for (const it of items) {
      const key = hebitsKey(it);
      covers.remember(key, it.cover);
      if (!itemCache.has(key) && itemCache.size >= ITEM_CACHE_MAX) {
        const oldest = itemCache.keys().next().value;
        if (oldest !== undefined) itemCache.delete(oldest);
      }
      itemCache.set(key, { at: now(), item: itemOf(it) });
    }
    return items;
  }

  const itemOf = (it: RememberedItem): CachedItem => ({
    title: it.name,
    size: it.size,
    files: it.fileCount,
    cover: it.cover,
    seeders: it.seeders,
  });

  // ...and it expires, like lib/jackett.js's cache did. play.ts's no-seeders guard reads
  // this: without expiry a torrent seen once with no seeders would refuse its grab
  // forever, turning a transient refusal into a permanent one with no visible cause.
  const cachedItem = (hebitsId: string): CachedItem | undefined => {
    const hit = itemCache.get(hebitsId);
    if (!hit) return undefined;
    if (now() - hit.at >= ITEM_CACHE_MS) {
      itemCache.delete(hebitsId);
      return undefined;
    }
    return hit.item;
  };

  // Every tracker call this module makes goes through here - including the release-name
  // lookup IdentityResolver runs below, which is how a torrent nobody tagged gets its
  // cover onto the poster route - so nothing can reach the catalogue unremembered.
  const browse = (options: BrowseOptions): Promise<HebitsTorrent[]> => hebits.browse(options).then(remember);

  // The release-name lookup for torrents nobody tagged. It gets the WRAPPED browse, not
  // the client: these results are tracker results like any other, and lib/addon.js served
  // their covers on /poster/<hash> by way of the indexer client's own cache.
  // Created on first use, like play.ts does with `store.data.focus`.
  store.data.identity ??= {};
  const identity = new IdentityResolver({
    hebits: { browse },
    qbit,
    cinemetaSearch,
    cache: store.data.identity,
    save: () => store.save(),
    log,
  });

  // One tracker result as buildStreams reads it. The renames are the boundary's
  // (see hebits.ts): `hebitsKey(it)` not `String(it.id)`, `name` not `title`,
  // `fileCount` not `files`, and `leechers` straight through - never `peers - seeders`.
  const streamItem = (it: HebitsTorrent): StreamItem => ({
    hebitsId: hebitsKey(it),
    title: it.name,
    size: it.size,
    files: it.fileCount,
    seeders: it.seeders,
    leechers: it.leechers,
    downloadFactor: it.downloadFactor,
    uploadFactor: it.uploadFactor,
  });

  // "Ready at home" for Hebits search results. Tags give an exact answer; the release
  // name covers torrents added before tagging, or by another tool.
  async function localStatus(ids: string[], items: StreamItem[] = []): Promise<Map<string, LocalStatus>> {
    const entries = await home.entries();
    const byId = new Map<string, HomeEntry>();
    for (const e of entries) if (e.hebitsId) byId.set(e.hebitsId, e);
    const byName = new Map(entries.map((e) => [normalizeTitle(e.name), e]));
    const out = new Map<string, LocalStatus>();
    for (const id of ids) {
      const item = items.find((it) => it.hebitsId === id);
      const hit = byId.get(id) || (item && byName.get(normalizeTitle(item.title)));
      if (hit) out.set(id, { progress: hit.progress, dlspeed: 0 });
    }
    return out;
  }

  // lib/jackett.js's forTitle: movies by IMDb id, series by the IMDb id as free text plus
  // a season-scoped query so a big show isn't cut off by the 50-result page. `browse`'s
  // own `imdb` option is the "query = this IMDb id" convenience both Torznab queries were.
  async function forTitle(type: MediaType, imdb: string, season?: number): Promise<HebitsTorrent[]> {
    const queries: BrowseOptions[] = type === 'movie' ? [{ imdb }] : [{ imdb }, ...(season ? [{ imdb, season }] : [])];
    const results = await Promise.all(queries.map(browse));
    const byId = new Map<string, HebitsTorrent>();
    for (const it of results.flat()) byId.set(hebitsKey(it), it);
    return [...byId.values()];
  }

  async function handleStream(type: MediaType, rawId: string, baseUrl: string): Promise<AddonStream[]> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawId);
    } catch {
      return []; // a stray `%` is a malformed id, not a server error
    }
    const [imdb, s, e] = decoded.split(':');
    const season = s ? Number(s) : undefined;
    const episode = e ? Number(e) : undefined;
    if (imdb === undefined || !/^tt\d+$/.test(imdb) || (type === 'series' && !(season && episode))) return [];

    let items: StreamItem[] = [];
    let searchError: string | undefined;
    try {
      items = (await forTitle(type, imdb, season)).filter((it) => !it.imdb || it.imdb === imdb).map(streamItem);
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

  // hebits-client only returns results when the cookie still works (it throws
  // LoginExpiredError otherwise), so a browse that completes is evidence the login is
  // still good - the mirror image of searchFailed below.
  function searchOk(): void {
    noteLogin(true);
  }

  function searchFailed(type: MediaType, id: string, err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    noteLogin(false, `Hebits search: ${message}`);
    log(`search ${type} ${id}: ${message}`);
    return message;
  }

  interface StreamsForInput {
    type: MediaType;
    items: StreamItem[];
    season?: number;
    episode?: number;
    searchError?: string;
    baseUrl: string;
    query: string;
  }

  async function streamsFor({ type, items, season, episode, searchError, baseUrl, query }: StreamsForInput): Promise<AddonStream[]> {
    const local = await localStatus(
      items.map((it) => it.hebitsId),
      items,
    );
    // season and episode are always known together (both id formats carry both or
    // neither), so this is the `type === 'series' ? { season, episode } : null` of the
    // original with the pair spelled out for the type checker.
    const ep: Episode | null = type === 'series' && season !== undefined && episode !== undefined ? { season, episode } : null;
    warmUp(local, ep).catch((e: Error) => log(`warm-up: ${e.message}`));
    const d = await daily();
    const grabsLeft = Math.max(0, d.limit - d.used);
    const freeBytes = await qbit.freeSpace().catch(() => undefined);
    const suffix = type === 'series' ? `/${season}/${episode}` : '/0/0';
    const streams: AddonStream[] = buildStreams({
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
        description: `Hebits search failed: ${searchError}\nCheck the Hebits login cookie (it may have expired).`,
        url: `${baseUrl}/play/error/0/0`,
      });
    }
    return streams;
  }

  // ---- search all of Hebits -------------------------------------------------

  // search.ts keys its callbacks by HebitsTorrent's numeric id; the store is keyed by
  // strings, so the conversion goes through the boundary rather than String()/Number().
  const filesOf = (id: number) => store.torrent(hebitsKey({ id }))?.files;

  async function handleSearchCatalog(type: MediaType, extraPath: string | undefined, baseUrl: string): Promise<SearchCatalogMeta[]> {
    const q = new URLSearchParams(extraPath || '').get('search')?.trim();
    if (!q) return [];
    try {
      const results = await browse({ query: q });
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
  async function findItems(
    name: string,
    type: MediaType,
    { season, allSeasons = false }: { season?: number; allSeasons?: boolean } = {},
  ): Promise<HebitsTorrent[]> {
    const byId = new Map<string, HebitsTorrent>();
    const collect = (list: HebitsTorrent[]): void => {
      for (const it of itemsFor(list, name, type)) byId.set(hebitsKey(it), it);
    };
    const bySeason = (n: number) => browse({ query: name, season: n });
    const [first] = await Promise.all([browse({ query: name }), season ? bySeason(season).then(collect) : undefined]);
    searchOk();
    collect(first);
    if (type === 'series' && allSeasons && first.length >= PAGE_SIZE) {
      // The old `seasonInfo(t)?.season ?? seasonInfo(t)?.to ?? 0`: an episode names its
      // season, a season pack names the last season it covers, anything else counts as 0.
      const seasonOf = (it: HebitsTorrent): number => {
        const info = seasonInfo(it.name);
        if (info?.kind === 'episode') return info.season;
        if (info?.kind === 'season') return info.to;
        return 0;
      };
      const top = Math.min(30, Math.max(1, ...[...byId.values()].map(seasonOf)) + 1);
      // One season failing must not lose the whole card, but it must not vanish either:
      // this catch takes any error, including the RateLimitedError hebits-client throws
      // when the tracker itself asks us to slow down, and a silent [] would turn "the
      // tracker is pushing back" into "that season has no uploads" - a partial card that
      // looks complete, with nothing in the log to explain it.
      const lists = await Promise.all(
        Array.from({ length: top }, (_, i) =>
          bySeason(i + 1).catch((e: unknown): HebitsTorrent[] => {
            log(`find ${type} "${name}" season ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
            return [];
          }),
        ),
      );
      lists.forEach(collect);
    }
    return [...byId.values()];
  }

  async function handleFindMeta(type: MediaType, ref: ParsedFindId, baseUrl: string): Promise<SearchMeta | null> {
    let items: HebitsTorrent[];
    try {
      items = await findItems(ref.name, type, { allSeasons: true });
    } catch (err) {
      // The one tracker-touching handler that had no catch: the failure reached the route
      // as a 500 and never passed through searchFailed(), so there was no noteLogin(false)
      // and no alert - the owner learned nothing from the one call that failed. Catches any
      // error type, exactly like its siblings: no narrowing on the alert path, ever.
      searchFailed(type, ref.name, err);
      return null; // the route answers 404, which is what an unknown card already did
    }
    if (!items.length) return null;
    const imdb = items.find((it) => it.imdb)?.imdb;
    const extra = imdb ? await cinemeta(type, imdb) : undefined;
    return findMeta(ref.name, type, items, { posterUrl: (id) => `${baseUrl}/poster/${id}`, filesOf, extra });
  }

  async function handleFindStream(type: MediaType, ref: ParsedFindId, baseUrl: string): Promise<AddonStream[]> {
    if (type === 'series' && !ref.season) return [];
    let items: StreamItem[] = [];
    let searchError: string | undefined;
    try {
      items = (await findItems(ref.name, type, { season: ref.season })).map(streamItem);
    } catch (err) {
      searchError = searchFailed(type, ref.name, err);
    }
    return streamsFor({ type, items, season: ref.season, episode: ref.episode, searchError, baseUrl, query: `?type=${type}` });
  }

  // ---- home library -------------------------------------------------------

  async function libraryEntries(): Promise<HomeEntry[]> {
    const entries = await home.entries();
    await Promise.all(entries.map((e) => identity.resolve(e).catch(() => e)));
    return entries;
  }

  // Cinemeta's response is taken as-is, as it was before: every field the consumers read
  // is optional there, so an unexpected shape degrades to a missing field, never a throw.
  function metaOf(body: unknown): SearchExtra | undefined {
    if (typeof body !== 'object' || body === null) return undefined;
    const { meta } = body as { meta?: SearchExtra };
    return meta;
  }

  const cinemetaCache = new Map<string, { at: number; meta: SearchExtra | undefined }>();
  async function cinemeta(type: MediaType, imdb: string): Promise<SearchExtra | undefined> {
    const key = `${type}/${imdb}`;
    const hit = cinemetaCache.get(key);
    if (hit && Date.now() - hit.at < 864e5) return hit.meta;
    const meta = await doFetch(`${CINEMETA}/meta/${key}.json`, { signal: AbortSignal.timeout(10_000) })
      .then((r): Promise<unknown> => (r.ok ? r.json() : Promise.resolve({})))
      .then(metaOf)
      .catch(() => undefined);
    cinemetaCache.set(key, { at: Date.now(), meta });
    return meta;
  }

  function firstImdb(body: unknown): string | undefined {
    if (typeof body !== 'object' || body === null) return undefined;
    const { metas } = body as { metas?: { imdb_id?: string; id?: string }[] };
    const first = metas?.[0];
    return first?.imdb_id || first?.id;
  }

  // Recover an IMDb id from a release name. Works for most English releases; Israeli
  // titles with no IMDb entry stay unidentified, which no source could fix.
  const cinemetaSearchCache = new Map<string, string | undefined>();
  async function cinemetaSearch(name: string): Promise<string | undefined> {
    if (cinemetaSearchCache.has(name)) return cinemetaSearchCache.get(name);
    let imdb: string | undefined;
    for (const type of ['series', 'movie']) {
      const url = `${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(name)}.json`;
      const body = await doFetch(url, { signal: AbortSignal.timeout(10_000) })
        .then((r): Promise<unknown> => (r.ok ? r.json() : Promise.resolve(null)))
        .catch(() => null);
      imdb = firstImdb(body);
      if (imdb?.startsWith('tt')) break;
      imdb = undefined;
    }
    cinemetaSearchCache.set(name, imdb);
    return imdb;
  }

  const posterUrl =
    (baseUrl: string) =>
    (e: HomeEntry): string | undefined =>
      e.imdb || e.hebitsId ? `${baseUrl}/poster/${e.hash}` : undefined;

  async function handleCatalog(type: MediaType, extraPath: string | undefined, baseUrl: string): Promise<CatalogMeta[]> {
    const extra = new URLSearchParams(extraPath || '');
    const entries = await libraryEntries();
    const metas = catalogMetas(entries, type, { posterUrl: posterUrl(baseUrl) });
    const q = extra.get('search')?.trim();
    return q ? metas.filter((m) => matchesSearch(m, q)) : metas;
  }

  async function handleMeta(rawId: string, baseUrl: string): Promise<FullMeta | null> {
    const ref = parseHebitsId(rawId);
    if (!ref) return null;
    const entry = (await libraryEntries()).find((e) => e.hash === ref.hash);
    if (!entry) return null;
    const extra = entry.imdb ? await cinemeta(kindOf(entry), entry.imdb) : undefined;
    return metaFor(entry, { posterUrl: posterUrl(baseUrl), extra });
  }

  async function handleLibraryStream(type: MediaType, rawId: string, baseUrl: string): Promise<AddonStream[]> {
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
      local: new Map([[entry.hash, { progress: entry.progress }]]),
      type,
      season: ref.season,
      episode: ref.episode,
      grabsLeft: 1,
      dailyLimit: store.limitToday(cfg),
      minFreeBytes: 0,
      playUrl: () => `${baseUrl}/play/h/${entry.hash}${suffix}`,
    });
  }

  async function handlePoster(res: PosterResponse, ref: string): Promise<void> {
    const entry = /^\d+$/.test(ref) ? undefined : await home.byHash(ref.toLowerCase());
    const hebitsId = entry?.hebitsId || (/^\d+$/.test(ref) ? ref : undefined);
    // A miss here means "no poster", exactly as the old cache reach-in's miss did: nothing
    // is fetched to fill it, and no other cover stands in.
    const cover = hebitsId ? covers.get(hebitsId) : undefined;
    if (cover) {
      const r = await doFetch(cover, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (r?.ok) {
        res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'max-age=604800' });
        res.end(Buffer.from(await r.arrayBuffer()));
        return;
      }
    }
    const imdb = entry?.imdb;
    if (imdb) {
      res.writeHead(302, { Location: `https://images.metahub.space/poster/medium/${imdb}/img` });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  }

  // Opening a title in Nuvio starts fetching the matching file of torrents already at
  // home, so playback has a head start. Never grabs anything new.
  async function warmUp(local: Map<string, LocalStatus>, ep: Episode | null): Promise<void> {
    const pending = [...local].filter(([, st]) => st.progress < 1);
    if (!pending.length) return;
    const byId = new Map<string, HomeEntry>();
    for (const e of await home.entries()) if (e.hebitsId) byId.set(e.hebitsId, e);
    for (const [id] of pending) {
      const entry = byId.get(id);
      const target = entry && pickFile(entry.files, ep);
      if (!entry || !target) continue;
      (async () => {
        const qfiles = await qbit.files(entry.hash);
        const qf = qfiles.find((f) => f.name === target.path);
        if (qf && qf.progress < 1) await focusOn(qbit, store, entry.hash, qf.index);
      })().catch((e: Error) => log(`warm-up ${id}: ${e.message}`));
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

// "Search all of Hebits": free-text Hebits results grouped into one card per show/movie.
// Titles without an IMDb id get their own IDs: hebits:find:<name> for the card and
// hebits:find:<name>:<season>:<episode> for episodes (<name> is base64url).
import type { HebitsTorrent } from 'hebits-client';
import type { CoverCache } from './covers';
import { hebitsKey, isWantedCategory, uploadedAtMs } from './hebits';
import { type Episode, episodeOf, type FileEntry, isDiscOrRemux, seasonInfo, showName, videoFiles } from './parse';

// Hebits' own category id for TV (see hebits.ts's WANTED_CATEGORY_IDS: 1 Movies, 2 TV).
// There is no longer a Torznab-style parent-category range to round into - the tracker's
// categories are flat native numbers.
const TV_CATEGORY_ID = 2;
const MAX_ESTIMATED_EPISODES = 40;

const norm = (x: string | undefined): string =>
  (x || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const encodeName = (name: string): string => Buffer.from(name, 'utf8').toString('base64url');

export interface ParsedFindId {
  name: string;
  season?: number;
  episode?: number;
}

export function findId(name: string, season?: number, episode?: number): string {
  return `hebits:find:${encodeName(name)}${season ? `:${season}:${episode}` : ''}`;
}

export function parseFindId(id: string): ParsedFindId | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    return null; // a stray `%` is a malformed id, not a server error
  }
  const m = decoded.match(/^hebits:find:([A-Za-z0-9_-]+)(?::(\d+):(\d+))?$/);
  if (!m) return null;
  const [, encoded, season, episode] = m;
  if (encoded === undefined) return null;
  const name = Buffer.from(encoded, 'base64url').toString('utf8');
  return name ? { name, season: season ? +season : undefined, episode: episode ? +episode : undefined } : null;
}

export function kindOfItem(item: Pick<HebitsTorrent, 'name' | 'categoryId'>): 'series' | 'movie' {
  if (seasonInfo(item.name)) return 'series';
  return item.categoryId === TV_CATEGORY_ID ? 'series' : 'movie';
}

const wanted = (it: HebitsTorrent): boolean => isWantedCategory(it) && !isDiscOrRemux(it.name);

// Items of one show/movie, as named on its card.
export function itemsFor(items: HebitsTorrent[], name: string, type: 'series' | 'movie', covers?: CoverCache): HebitsTorrent[] {
  const out: HebitsTorrent[] = [];
  for (const it of items) {
    covers?.remember(hebitsKey(it), it.cover);
    if (wanted(it) && kindOfItem(it) === type && norm(showName(it.name)) === norm(name)) out.push(it);
  }
  return out;
}

export interface SearchCatalogMeta {
  id: string;
  type: string;
  name: string;
  poster: string | undefined;
  posterShape: 'poster';
  description: string;
}

interface ResultGroup {
  name: string;
  items: HebitsTorrent[];
  seeders: number;
}

// One card per (type, name). Movies with an IMDb id use it, so Nuvio shows its usual
// details page. Series always use their own id: Cinemeta often lacks Israeli shows or
// their episodes, so the episode list is built from the Hebits uploads.
export function groupResults(
  items: HebitsTorrent[],
  type: 'series' | 'movie',
  { posterUrl, covers }: { posterUrl: (id: number) => string; covers?: CoverCache },
): SearchCatalogMeta[] {
  const groups = new Map<string, ResultGroup>();
  for (const it of items) {
    covers?.remember(hebitsKey(it), it.cover);
    if (!wanted(it) || kindOfItem(it) !== type) continue;
    const name = showName(it.name);
    const key = norm(name);
    if (!key) continue;
    const g = groups.get(key) ?? { name, items: [], seeders: 0 };
    g.items.push(it);
    g.seeders += it.seeders || 0;
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.seeders - a.seeders || b.items.length - a.items.length)
    .map((g) => {
      const imdb = type === 'movie' ? g.items.find((it) => it.imdb)?.imdb : undefined;
      const withCover = g.items.find((it) => it.cover);
      return {
        id: imdb || findId(g.name),
        type,
        name: g.name,
        poster: withCover ? posterUrl(withCover.id) : imdb && `https://images.metahub.space/poster/medium/${imdb}/img`,
        posterShape: 'poster' as const,
        description: `On Hebits: ${g.items.length} ${g.items.length === 1 ? 'upload' : 'uploads'}\n${g.items[0]?.name ?? ''}`,
      };
    });
}

interface EpisodeGroup {
  season: number;
  episode: number;
  uploads: string[];
  seeders: number;
  released?: number;
}

// Episode list for a show card. Per-episode uploads name their episode; season packs
// use the file list when the torrent is known locally (`filesOf(id)`), else the
// season's episodes from Cinemeta (`listed`: [{season, episode}]), else one episode per
// file as an estimate.
export function episodesFor(
  items: HebitsTorrent[],
  filesOf: (id: number) => FileEntry[] | undefined = () => undefined,
  listed: Episode[] = [],
): EpisodeGroup[] {
  const seen = new Map<string, EpisodeGroup>();
  let it: HebitsTorrent;
  // Keeps the earliest upload date per episode and the uploads that have it. `uploadedAt`
  // is a Date (not Torznab's epoch-ms `pubDate`) - uploadedAtMs() keeps the comparison in
  // milliseconds, the unit `released` is later fed back into `new Date(...)` as.
  const add = (season: number, episode: number): void => {
    const key = `${season}:${episode}`;
    const ep = seen.get(key) ?? { season, episode, uploads: [], seeders: 0 };
    ep.seeders = Math.max(ep.seeders, it.seeders || 0);
    const releasedMs = uploadedAtMs(it);
    if (ep.released === undefined || releasedMs < ep.released) ep.released = releasedMs;
    ep.uploads.push(it.name);
    seen.set(key, ep);
  };
  for (it of items) {
    const info = seasonInfo(it.name);
    if (info?.kind === 'episode') {
      add(info.season, info.episode);
      continue;
    }
    const files = filesOf(it.id);
    if (files) {
      for (const f of videoFiles(files)) {
        const ep = episodeOf(f.path);
        if (ep) add(ep.season, ep.episode);
      }
    } else if (info?.kind === 'season' && listed.some((v) => v.season >= info.from && v.season <= info.to)) {
      for (const v of listed) if (v.season >= info.from && v.season <= info.to) add(v.season, v.episode);
    } else if (info?.kind === 'season' && info.from === info.to && it.fileCount > 0) {
      for (let e = 1; e <= Math.min(it.fileCount, MAX_ESTIMATED_EPISODES); e++) add(info.from, e);
    }
  }
  return [...seen.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
}

// Cinemeta's meta for the title's IMDb id when known, plus the found-card's own name/poster.
export interface SearchExtra {
  name?: string;
  poster?: string;
  background?: string;
  logo?: string;
  genres?: string[];
  releaseInfo?: string;
  description?: string;
  videos?: Episode[];
}

export interface SearchVideoMeta {
  id: string;
  title: string;
  season: number;
  episode: number;
  released: string;
  overview: string;
}

export interface SearchMeta {
  id: string;
  type: string;
  name: string;
  poster: string | undefined;
  posterShape: 'poster';
  background?: string;
  logo?: string;
  genres?: string[];
  releaseInfo?: string;
  description: string;
  imdb_id?: string;
  videos?: SearchVideoMeta[];
}

// `extra` is Cinemeta's meta for the title's IMDb id when known.
export function findMeta(
  name: string,
  type: 'series' | 'movie',
  items: HebitsTorrent[],
  {
    posterUrl,
    filesOf,
    extra,
  }: { posterUrl: (id: number) => string; filesOf?: (id: number) => FileEntry[] | undefined; extra?: SearchExtra },
): SearchMeta {
  const withCover = items.find((it) => it.cover);
  const listed = (extra?.videos ?? []).filter((v) => v.season > 0 && v.episode > 0);
  const eps = type === 'series' ? episodesFor(items, filesOf, listed) : [];
  const seasons = [...new Set(eps.map((e) => e.season))];
  const summary = [
    seasons.length && `${seasons.length === 1 ? 'Season' : 'Seasons'} ${seasons.join(', ')}`,
    eps.length && `${eps.length} episodes`,
    `${items.length} ${items.length === 1 ? 'upload' : 'uploads'} on Hebits`,
  ].filter(Boolean);
  const latest = [...items].sort((a, b) => uploadedAtMs(b) - uploadedAtMs(a)).slice(0, 3);
  const imdb = items.find((it) => it.imdb)?.imdb;
  const meta: SearchMeta = {
    id: findId(name),
    type,
    name: extra?.name || name,
    poster: withCover ? posterUrl(withCover.id) : extra?.poster,
    posterShape: 'poster',
    background: extra?.background,
    logo: extra?.logo,
    genres: extra?.genres,
    releaseInfo: extra?.releaseInfo,
    description: [summary.join(' · '), extra?.description, `Latest: ${latest.map((it) => it.name).join(', ')}`]
      .filter(Boolean)
      .join('\n\n'),
    ...(imdb && { imdb_id: imdb }),
  };
  if (type === 'series') {
    // Upload dates are always in the past, so every episode counts as released.
    const fallback = Date.UTC(2000, 0, 1);
    meta.videos = eps.map((ep) => ({
      id: findId(name, ep.season, ep.episode),
      title: `Episode ${ep.episode}${ep.seeders ? '' : ' 💀'}`,
      season: ep.season,
      episode: ep.episode,
      released: new Date(ep.released ?? fallback).toISOString(),
      overview: `${ep.seeders ? `🌱 ${ep.seeders} seeds` : '💀 No seeders right now'} · On Hebits: ${[...new Set(ep.uploads)].join(', ')}`,
    }));
  }
  return meta;
}

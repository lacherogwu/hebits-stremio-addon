// "Hebits at home": catalog rows and episode lists for the torrents qBittorrent holds.
// IDs: hebits:h:<infohash> for the title, hebits:h:<infohash>:<season>:<episode> for an
// episode. The infohash is used because it is the one identifier qBittorrent always has.
import { type Episode, episodeOf, type FileEntry, resolution, showName, videoFiles } from './parse';

const RES_LABEL: Record<number, string> = { 2160: '4K', 1080: '1080p', 720: '720p', 480: 'SD' };

// The slice of a home-library entry these functions read (kept narrow, like FocusFile in
// focus.ts, rather than importing home.ts's HomeEntry) - size/state/category/pieceLength
// are on that entry but nothing here uses them.
export interface LibraryEntry {
  hash: string;
  name: string;
  imdb?: string;
  progress?: number;
  files: FileEntry[];
}

export interface ParsedHebitsId {
  hash: string;
  season?: number;
  episode?: number;
}

// Cinemeta's meta for a known IMDb id - only the fields metaFor reads off it.
export interface CinemetaExtra {
  background?: string;
  logo?: string;
  genres?: string[];
  releaseInfo?: string;
  description?: string;
}

export interface CatalogMeta {
  id: string;
  type: string;
  name: string;
  poster: string;
  posterShape: 'poster';
  description: string;
}

export interface VideoMeta {
  id: string;
  title: string;
  season: number;
  episode: number;
  released: string;
}

export interface FullMeta {
  id: string;
  type: string;
  name: string;
  poster: string;
  posterShape: 'poster';
  background?: string;
  logo?: string;
  genres?: string[];
  releaseInfo?: string;
  description: string;
  imdb_id?: string;
  videos?: VideoMeta[];
}

export const libraryId = (entry: Pick<LibraryEntry, 'hash'>): string => `hebits:h:${entry.hash}`;

export function parseHebitsId(id: string): ParsedHebitsId | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    return null; // a stray `%` is a malformed id, not a server error
  }
  const m = decoded.match(/^hebits:h:([0-9a-f]{40}|[0-9a-f]{64})(?::(\d+):(\d+))?$/i);
  if (!m) return null;
  const [, hash, season, episode] = m;
  if (hash === undefined) return null;
  return { hash: hash.toLowerCase(), season: season ? +season : undefined, episode: episode ? +episode : undefined };
}

export function kindOf(entry: Pick<LibraryEntry, 'files'>): 'series' | 'movie' {
  return videoFiles(entry.files).some((f) => episodeOf(f.path)) ? 'series' : 'movie';
}

export function episodes(entry: Pick<LibraryEntry, 'files'>): Episode[] {
  const seen = new Map<string, Episode>();
  for (const f of videoFiles(entry.files)) {
    const ep = episodeOf(f.path);
    const key = ep && `${ep.season}:${ep.episode}`;
    if (key && !seen.has(key)) seen.set(key, ep);
  }
  return [...seen.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
}

function statusLine(progress: number | undefined): string {
  if (progress === undefined) return '';
  return progress >= 1 ? '▶️ Ready at home' : `⏬ Downloading ${(progress * 100).toFixed(0)}%`;
}

function displayName(entry: Pick<LibraryEntry, 'name'>): string {
  const res = RES_LABEL[resolution(entry.name)];
  return `${showName(entry.name)}${res ? ` (${res})` : ''}`;
}

export function catalogMetas(
  entries: LibraryEntry[],
  type: string,
  { posterUrl }: { posterUrl: (e: LibraryEntry) => string },
): CatalogMeta[] {
  return entries
    .filter((e) => kindOf(e) === type)
    .sort((a, b) => displayName(a).localeCompare(displayName(b)))
    .map((e) => ({
      id: libraryId(e),
      type,
      name: displayName(e),
      poster: posterUrl(e),
      posterShape: 'poster',
      description: [e.name, statusLine(e.progress)].filter(Boolean).join('\n'),
    }));
}

// `extra` is Cinemeta's meta for the IMDb id when known (description, background, ...).
export function metaFor(
  entry: LibraryEntry,
  { posterUrl, extra }: { posterUrl: (e: LibraryEntry) => string; extra?: CinemetaExtra },
): FullMeta {
  const type = kindOf(entry);
  const meta: FullMeta = {
    id: libraryId(entry),
    type,
    name: displayName(entry),
    poster: posterUrl(entry),
    posterShape: 'poster',
    background: extra?.background,
    logo: extra?.logo,
    genres: extra?.genres,
    releaseInfo: extra?.releaseInfo,
    description: [statusLine(entry.progress), extra?.description, entry.name].filter(Boolean).join('\n\n'),
    ...(entry.imdb && { imdb_id: entry.imdb }),
  };
  if (type === 'series') {
    // Fixed past dates keep every episode "released"; order comes from season/episode.
    const base = Date.UTC(2000, 0, 1);
    meta.videos = episodes(entry).map((ep, i) => ({
      id: `${libraryId(entry)}:${ep.season}:${ep.episode}`,
      title: `Episode ${ep.episode}`,
      season: ep.season,
      episode: ep.episode,
      released: new Date(base + i * 864e5).toISOString(),
    }));
  }
  return meta;
}

// Case- and punctuation-insensitive match on the display name and release name.
export function matchesSearch(meta: Pick<CatalogMeta, 'name' | 'description'>, query: string): boolean {
  const norm = (x: string | undefined): string =>
    (x || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const q = norm(query);
  return Boolean(q) && (norm(meta.name).includes(q) || norm(meta.description).includes(q));
}

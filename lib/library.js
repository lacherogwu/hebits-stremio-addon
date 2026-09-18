// "Hebits at home": catalog rows and episode lists for the torrents qBittorrent holds.
// IDs: hebits:h:<infohash> for the title, hebits:h:<infohash>:<season>:<episode> for an
// episode. The infohash is used because it is the one identifier qBittorrent always has.
import { videoFiles, episodeOf, showName, resolution } from './parse.js';

const RES_LABEL = { 2160: '4K', 1080: '1080p', 720: '720p', 480: 'SD' };

export const libraryId = (entry) => `hebits:h:${entry.hash}`;

export function parseHebitsId(id) {
  const m = decodeURIComponent(id).match(/^hebits:h:([0-9a-f]{40}|[0-9a-f]{64})(?::(\d+):(\d+))?$/i);
  return m && { hash: m[1].toLowerCase(), season: m[2] ? +m[2] : undefined, episode: m[3] ? +m[3] : undefined };
}

export function kindOf(entry) {
  return videoFiles(entry.files || []).some((f) => episodeOf(f.path)) ? 'series' : 'movie';
}

export function episodes(entry) {
  const seen = new Map();
  for (const f of videoFiles(entry.files || [])) {
    const ep = episodeOf(f.path);
    const key = ep && `${ep.season}:${ep.episode}`;
    if (key && !seen.has(key)) seen.set(key, ep);
  }
  return [...seen.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
}

function statusLine(progress) {
  if (progress === undefined) return '';
  return progress >= 1 ? '▶️ Ready at home' : `⏬ Downloading ${(progress * 100).toFixed(0)}%`;
}

function displayName(entry) {
  const res = RES_LABEL[resolution(entry.name)];
  return `${showName(entry.name)}${res ? ` (${res})` : ''}`;
}

export function catalogMetas(entries, type, { posterUrl }) {
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
export function metaFor(entry, { posterUrl, extra }) {
  const type = kindOf(entry);
  const meta = {
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
export function matchesSearch(meta, query) {
  const norm = (x) => (x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const q = norm(query);
  return Boolean(q) && (norm(meta.name).includes(q) || norm(meta.description).includes(q));
}

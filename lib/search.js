// "Search all of Hebits": free-text Hebits results grouped into one card per show/movie.
// Titles without an IMDb id get their own IDs: hebits:find:<name> for the card and
// hebits:find:<name>:<season>:<episode> for episodes (<name> is base64url).
import { showName, seasonInfo, isDiscOrRemux, videoFiles, episodeOf } from './parse.js';

const WANTED_CATEGORIES = [2000, 5000]; // Torznab movies / TV
const MAX_ESTIMATED_EPISODES = 40;

const norm = (x) => (x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const encodeName = (name) => Buffer.from(name, 'utf8').toString('base64url');

export function findId(name, season, episode) {
  return `hebits:find:${encodeName(name)}${season ? `:${season}:${episode}` : ''}`;
}

export function parseFindId(id) {
  let decoded;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    return null; // a stray `%` is a malformed id, not a server error
  }
  const m = decoded.match(/^hebits:find:([A-Za-z0-9_-]+)(?::(\d+):(\d+))?$/);
  if (!m) return null;
  const name = Buffer.from(m[1], 'base64url').toString('utf8');
  return name && { name, season: m[2] ? +m[2] : undefined, episode: m[3] ? +m[3] : undefined };
}

export function kindOfItem(item) {
  if (seasonInfo(item.title)) return 'series';
  return item.categories?.some((c) => c >= 5000 && c < 6000) ? 'series' : 'movie';
}

const wanted = (it) =>
  it.categories?.some((c) => WANTED_CATEGORIES.includes(c) || WANTED_CATEGORIES.includes(Math.floor(c / 1000) * 1000)) &&
  !isDiscOrRemux(it.title);

// Items of one show/movie, as named on its card.
export function itemsFor(items, name, type) {
  return items.filter((it) => wanted(it) && kindOfItem(it) === type && norm(showName(it.title)) === norm(name));
}

// One card per (type, name). Movies with an IMDb id use it, so Nuvio shows its usual
// details page. Series always use their own id: Cinemeta often lacks Israeli shows or
// their episodes, so the episode list is built from the Hebits uploads.
export function groupResults(items, type, { posterUrl }) {
  const groups = new Map();
  for (const it of items) {
    if (!wanted(it) || kindOfItem(it) !== type) continue;
    const name = showName(it.title);
    const key = norm(name);
    if (!key) continue;
    const g = groups.get(key) || { name, items: [], seeders: 0 };
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
        poster: withCover ? posterUrl(withCover.hebitsId) : imdb && `https://images.metahub.space/poster/medium/${imdb}/img`,
        posterShape: 'poster',
        description: `On Hebits: ${g.items.length} ${g.items.length === 1 ? 'upload' : 'uploads'}\n${g.items[0].title}`,
      };
    });
}

// Episode list for a show card. Per-episode uploads name their episode; season packs
// use the file list when the torrent is known locally (`filesOf(hebitsId)`), else the
// season's episodes from Cinemeta (`listed`: [{season, episode}]), else one episode per
// file as an estimate.
export function episodesFor(items, filesOf = () => undefined, listed = []) {
  const seen = new Map();
  let it;
  // Keeps the earliest upload date per episode and the uploads that have it.
  const add = (season, episode) => {
    const key = `${season}:${episode}`;
    const ep = seen.get(key) || { season, episode, uploads: [], seeders: 0 };
    ep.seeders = Math.max(ep.seeders, it.seeders || 0);
    if (it.pubDate && !(ep.released <= it.pubDate)) ep.released = it.pubDate;
    ep.uploads.push(it.title);
    seen.set(key, ep);
  };
  for (it of items) {
    const info = seasonInfo(it.title);
    if (info?.kind === 'episode') {
      add(info.season, info.episode);
      continue;
    }
    const files = filesOf(it.hebitsId);
    if (files) {
      for (const f of videoFiles(files)) {
        const ep = episodeOf(f.path);
        if (ep) add(ep.season, ep.episode);
      }
    } else if (info?.kind === 'season' && listed.some((v) => v.season >= info.from && v.season <= info.to)) {
      for (const v of listed) if (v.season >= info.from && v.season <= info.to) add(v.season, v.episode);
    } else if (info?.kind === 'season' && info.from === info.to && it.files > 0) {
      for (let e = 1; e <= Math.min(it.files, MAX_ESTIMATED_EPISODES); e++) add(info.from, e);
    }
  }
  return [...seen.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
}

// `extra` is Cinemeta's meta for the title's IMDb id when known.
export function findMeta(name, type, items, { posterUrl, filesOf, extra }) {
  const withCover = items.find((it) => it.cover);
  const listed = (extra?.videos || []).filter((v) => v.season > 0 && v.episode > 0);
  const eps = type === 'series' ? episodesFor(items, filesOf, listed) : [];
  const seasons = [...new Set(eps.map((e) => e.season))];
  const summary = [
    seasons.length && `${seasons.length === 1 ? 'Season' : 'Seasons'} ${seasons.join(', ')}`,
    eps.length && `${eps.length} episodes`,
    `${items.length} ${items.length === 1 ? 'upload' : 'uploads'} on Hebits`,
  ].filter(Boolean);
  const latest = [...items].sort((a, b) => (b.pubDate || 0) - (a.pubDate || 0)).slice(0, 3);
  const imdb = items.find((it) => it.imdb)?.imdb;
  const meta = {
    id: findId(name),
    type,
    name: extra?.name || name,
    poster: withCover ? posterUrl(withCover.hebitsId) : extra?.poster,
    posterShape: 'poster',
    background: extra?.background,
    logo: extra?.logo,
    genres: extra?.genres,
    releaseInfo: extra?.releaseInfo,
    description: [summary.join(' · '), extra?.description, `Latest: ${latest.map((it) => it.title).join(', ')}`].filter(Boolean).join('\n\n'),
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

// Release-name and file-list parsing.

export const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|ts|m2ts|webm|mov|wmv)$/i;

export function resolution(title: string): number {
  if (/2160p|\b4k\b|\buhd\b/i.test(title)) return 2160;
  if (/1080[pi]/i.test(title)) return 1080;
  if (/720p/i.test(title)) return 720;
  if (/480p|576p|\bsd\b|pdtv|xvid|dvdrip/i.test(title)) return 480;
  return 0;
}

// Untouched discs and remuxes: huge, and full discs aren't playable files at all.
export function isDiscOrRemux(title: string): boolean {
  return (
    /remux/i.test(title) ||
    /\bbdmv\b|\biso\b/i.test(title) ||
    /complete[ ._-]*(uhd[ ._-]*)?blu-?ray/i.test(title) ||
    // untouched discs name the disc codec (HEVC/AVC/VC-1) with no encoder (x264/x265/H.264)
    (/blu-?ray/i.test(title) && /\b(hevc|avc|vc-?1|mpeg-?2)\b/i.test(title) && !/x26[45]|h\.?26[45]/i.test(title))
  );
}

export type SeasonInfo =
  | { kind: 'episode'; season: number; episode: number }
  | { kind: 'season'; from: number; to: number }
  | { kind: 'complete' };

export function seasonInfo(title: string): SeasonInfo | null {
  const episodeMatch = title.match(/\bS(\d{1,2})[ ._-]?E(\d{1,3})(?!\d)/i);
  if (episodeMatch) {
    const [, season, episode] = episodeMatch;
    if (season !== undefined && episode !== undefined) {
      return { kind: 'episode', season: +season, episode: +episode };
    }
  }
  const rangeMatch = title.match(/\bS(\d{1,2})[ ._]?-[ ._]?S?(\d{1,2})\b/i);
  if (rangeMatch) {
    const [, from, to] = rangeMatch;
    if (from !== undefined && to !== undefined) {
      return { kind: 'season', from: +from, to: +to };
    }
  }
  const singleMatch = title.match(/\bS(\d{1,2})\b/i);
  if (singleMatch) {
    const [, season] = singleMatch;
    if (season !== undefined) {
      return { kind: 'season', from: +season, to: +season };
    }
  }
  if (/\bcomplete\b/i.test(title)) return { kind: 'complete' };
  return null;
}

export function coversEpisode(info: SeasonInfo | null, season: number, episode: number): boolean {
  if (!info) return false;
  if (info.kind === 'episode') return info.season === season && info.episode === episode;
  if (info.kind === 'season') return season >= info.from && season <= info.to;
  return info.kind === 'complete';
}

const isSample = (p: string): boolean => /(^|[/ ._-])sample([/ ._-]|$)/i.test(p);

export interface FileEntry {
  path: string;
  length: number;
}

export function videoFiles<T extends FileEntry>(files: T[]): T[] {
  return files.filter((f) => VIDEO_EXT.test(f.path) && !isSample(f.path));
}

export interface Episode {
  season: number;
  episode: number;
}

// Season/episode of a file inside a torrent, or null. Playback and the home library's
// episode lists both use this, so they always agree.
export function episodeOf(path: string): Episode | null {
  const parts = path.split('/');
  const base = parts.pop();
  if (base === undefined) return null;
  const dir = parts.join('/');

  const m = base.match(/s(\d{1,2})[ ._-]*e(\d{1,3})(?!\d)/i) || base.match(/(?<![\dx])(\d{1,2})x(\d{1,3})(?!\d)/i);
  if (m) {
    const [, season, episode] = m;
    if (season !== undefined && episode !== undefined) return { season: +season, episode: +episode };
  }

  // Episode-only names ("E05", "Episode 5", "פרק 5") inside a folder for a season.
  const seasons = [...dir.matchAll(/(?:season|עונה|\bs)[ ._-]*0*(\d{1,2})(?!\d)/gi)];
  const epMatch = base.match(/(?:\be|episode|ep|פרק)[ ._-]*0*(\d{1,3})(?!\d)/i);
  const lastSeason = seasons.at(-1);
  if (lastSeason && epMatch) {
    const season = lastSeason[1];
    const episode = epMatch[1];
    if (season !== undefined && episode !== undefined) return { season: +season, episode: +episode };
  }
  return null;
}

// Picks the file to play. `ep` is null for movies.
export function pickFile<T extends FileEntry>(files: T[], ep: Episode | null): T | null {
  const vids = videoFiles(files);
  if (!vids.length) return null;
  if (!ep) return vids.reduce((a, b) => (b.length > a.length ? b : a));

  const hit = vids.find((f) => {
    const x = episodeOf(f.path);
    return x && x.season === ep.season && x.episode === ep.episode;
  });
  if (hit) return hit;

  // A lone video file in a torrent whose name has no other episode info.
  const only = vids[0];
  if (vids.length === 1 && only !== undefined && !episodeOf(only.path)) return only;
  return null;
}

// "Game.of.Thrones.S01-S05.720p..." -> "Game of Thrones"
export function showName(torrentName: string): string {
  const cut = torrentName.search(/[ ._-](s\d{1,2}\b|s\d{1,2}e\d|complete\b|(19|20)\d{2}\b|\d{3,4}p\b|web|hdtv|pdtv|blu-?ray|dvdrip|xvid)/i);
  const name = (cut > 0 ? torrentName.slice(0, cut) : torrentName).replace(/[._]+/g, ' ').trim();
  return name || torrentName;
}

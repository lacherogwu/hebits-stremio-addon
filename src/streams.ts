// Turns Hebits search results + local torrent state into Stremio stream objects.
import { downloadingCount } from './hebits';
import { coversEpisode, isDiscOrRemux, resolution, type SeasonInfo, seasonInfo } from './parse';

const GB = 1024 ** 3;
const gb = (n: number): string => `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB`;
const RES_LABEL: Record<number, string> = { 2160: '4K', 1080: '1080p', 720: '720p', 480: 'SD', 0: '?' };
const KIND_RANK: Record<SeasonInfo['kind'], number> = { episode: 0, season: 1, complete: 2 };

function leechLabel(d: number, u: number): string {
  const parts: string[] = [];
  if (d === 0) parts.push('🆓 Freeleech');
  else if (d === 0.5) parts.push('½ Half-leech');
  else if (d > 0 && d < 1) parts.push(`${Math.round(d * 100)}% counts`);
  else parts.push('⚠️ Counts toward ratio');
  if (u > 1) parts.push(`⬆️ x${u} upload`);
  return parts.join(' · ');
}

function packLabel(info: SeasonInfo | null, files: number): string | null {
  if (!info || info.kind === 'episode') return null;
  const scope =
    info.kind === 'complete' ? 'Complete series' : info.from === info.to ? `Season ${info.from} pack` : `Seasons ${info.from}-${info.to}`;
  return `📦 ${scope}${files ? ` (${files} files)` : ''} · whole pack downloads`;
}

// What buildStreams reads off one Hebits search result. `files`/`size`/`title` are
// always known; the swarm/leech fields are only known for a live search hit - items
// carried over from local state only (`atHomeOnly`, e.g. a pack search no longer
// lists) never have them, hence optional rather than required.
//
// `leechers` - not `peers` - matches HebitsTorrent's own field (see hebits.ts):
// Torznab's `peers` was seeders+leechers, which is why the old code subtracted
// seeders back out; HebitsTorrent gives the leecher count directly, so that
// subtraction must not come back here - downloadingCount() below is the one place
// that turns it into the "N downloading" figure.
export interface StreamItem {
  hebitsId: string;
  title: string;
  size: number;
  files: number;
  seeders?: number;
  leechers?: number;
  downloadFactor?: number;
  uploadFactor?: number;
  atHomeOnly?: boolean;
  pinned?: boolean;
}

// `local` maps hebitsId -> what's known about a matching torrent already in qBittorrent.
export interface LocalStatus {
  progress: number;
  dlspeed?: number;
}

export interface BuildStreamsInput {
  items: StreamItem[];
  local: Map<string, LocalStatus>;
  type: string;
  season?: number;
  episode?: number;
  grabsLeft: number;
  dailyLimit: number;
  freeBytes?: number;
  minFreeBytes: number;
  playUrl: (hebitsId: string) => string;
}

export interface StremioStream {
  name: string;
  description: string;
  url: string;
  behaviorHints: {
    notWebReady: true;
    bingeGroup: string;
    filename?: string;
  };
}

type SortKey = [number, number, number, number, number];

// Filters and describes results. `local` maps hebitsId -> { progress, state }.
export function buildStreams({
  items,
  local,
  type,
  season,
  episode,
  grabsLeft,
  dailyLimit,
  freeBytes,
  minFreeBytes,
  playUrl,
}: BuildStreamsInput): StremioStream[] {
  const rows: { sort: SortKey; stream: StremioStream }[] = [];
  for (const it of items) {
    const here = local.get(it.hebitsId);
    const info = seasonInfo(it.title);
    // `pinned` items were chosen explicitly (home library), so skip name-based matching.
    if (!it.pinned && type === 'movie' && info) continue;
    // season/episode are only meaningful - and only ever passed - for type === 'series';
    // coversEpisode is never reached for a movie, so the 0 fallback below never fires.
    if (!it.pinned && type === 'series' && !coversEpisode(info, season ?? 0, episode ?? 0)) continue;
    if (!here && (it.atHomeOnly || isDiscOrRemux(it.title))) continue;

    const res = resolution(it.title);
    let status: string;
    let blocked = false;
    if (here && here.progress >= 1) status = '▶️ Ready at home';
    else if (here)
      status = `⏬ Downloading ${(here.progress * 100).toFixed(0)}%${here.dlspeed ? ` · ${(here.dlspeed / 1048576).toFixed(0)} MB/s` : ''}`;
    // Dead torrents stay visible (labelled) so a missing episode isn't a mystery.
    else if (!((it.seeders ?? 0) > 0)) {
      status = "💀 No seeders on Hebits right now, can't download";
      blocked = true;
    } else if (grabsLeft <= 0) {
      status = `⛔ Daily limit reached (${dailyLimit})`;
      blocked = true;
    } else if (freeBytes !== undefined && it.size > freeBytes - minFreeBytes) {
      status = `⛔ Not enough disk space (${gb(Math.max(0, freeBytes))} free)`;
      blocked = true;
    } else status = `🎟️ Uses 1 of ${grabsLeft} downloads left today`;

    // Items known only from local state have no fresh swarm/leech info to show.
    const lines = [
      `🎬 ${it.title}`,
      it.atHomeOnly
        ? `💾 ${gb(it.size)}`
        : `💾 ${gb(it.size)} · 🌱 ${it.seeders ?? 0} seeds · ⬇️ ${downloadingCount({ seeders: it.seeders ?? 0, leechers: it.leechers ?? 0 })} downloading`,
      !it.atHomeOnly && leechLabel(it.downloadFactor ?? 1, it.uploadFactor ?? 1),
      packLabel(info, it.files),
      status,
    ].filter(Boolean);

    rows.push({
      sort: [
        here ? (here.progress >= 1 ? 0 : 1) : blocked ? 3 : 2,
        it.downloadFactor ?? 0,
        -res,
        info ? KIND_RANK[info.kind] : 0,
        -(it.seeders ?? 0),
      ],
      stream: {
        name: `🏠 Hebits\n${RES_LABEL[res]}`,
        description: lines.join('\n'),
        url: playUrl(it.hebitsId),
        behaviorHints: {
          notWebReady: true,
          bingeGroup: `hebits-${it.hebitsId}`,
          ...(it.title && { filename: it.title }),
        },
      },
    });
  }
  rows.sort((a, b) => {
    for (let i = 0; i < a.sort.length; i++) {
      // sort is always a fully-populated 5-tuple; the ?? 0 is only for the type
      // checker's benefit (it can't see that a fixed-length tuple has no gaps).
      const av = a.sort[i] ?? 0;
      const bv = b.sort[i] ?? 0;
      if (av !== bv) return av - bv;
    }
    return 0;
  });
  return rows.map((r) => r.stream);
}

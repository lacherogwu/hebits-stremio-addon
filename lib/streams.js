// Turns Hebits search results + local torrent state into Stremio stream objects.
import { resolution, isDiscOrRemux, seasonInfo, coversEpisode } from './parse.js';

const GB = 1024 ** 3;
const gb = (n) => `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB`;
const RES_LABEL = { 2160: '4K', 1080: '1080p', 720: '720p', 480: 'SD', 0: '?' };
const KIND_RANK = { episode: 0, season: 1, complete: 2 };

function leechLabel(d, u) {
  const parts = [];
  if (d === 0) parts.push('🆓 Freeleech');
  else if (d === 0.5) parts.push('½ Half-leech');
  else if (d > 0 && d < 1) parts.push(`${Math.round(d * 100)}% counts`);
  else parts.push('⚠️ Counts toward ratio');
  if (u > 1) parts.push(`⬆️ x${u} upload`);
  return parts.join(' · ');
}

function packLabel(info, files) {
  if (!info || info.kind === 'episode') return null;
  const scope =
    info.kind === 'complete' ? 'Complete series' : info.from === info.to ? `Season ${info.from} pack` : `Seasons ${info.from}-${info.to}`;
  return `📦 ${scope}${files ? ` (${files} files)` : ''} · whole pack downloads`;
}

// Filters and describes results. `local` maps hebitsId -> { progress, state }.
export function buildStreams({ items, local, type, season, episode, grabsLeft, dailyLimit, freeBytes, minFreeBytes, playUrl }) {
  const rows = [];
  for (const it of items) {
    const here = local.get(it.hebitsId);
    const info = seasonInfo(it.title);
    // `pinned` items were chosen explicitly (home library), so skip name-based matching.
    if (!it.pinned && type === 'movie' && info) continue;
    if (!it.pinned && type === 'series' && !coversEpisode(info, season, episode)) continue;
    if (!here && (it.atHomeOnly || isDiscOrRemux(it.title))) continue;

    const res = resolution(it.title);
    let status;
    let blocked = false;
    if (here?.progress >= 1) status = '▶️ Ready at home';
    else if (here) status = `⏬ Downloading ${(here.progress * 100).toFixed(0)}%${here.dlspeed ? ` · ${(here.dlspeed / 1048576).toFixed(0)} MB/s` : ''}`;
    // Dead torrents stay visible (labelled) so a missing episode isn't a mystery.
    else if (!(it.seeders > 0)) {
      status = '💀 No seeders on Hebits right now, can\'t download';
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
      it.atHomeOnly ? `💾 ${gb(it.size)}` : `💾 ${gb(it.size)} · 🌱 ${it.seeders} seeds · ⬇️ ${Math.max(0, it.peers - it.seeders)} downloading`,
      !it.atHomeOnly && leechLabel(it.downloadFactor, it.uploadFactor),
      packLabel(info, it.files),
      status,
    ].filter(Boolean);

    rows.push({
      sort: [here ? (here.progress >= 1 ? 0 : 1) : blocked ? 3 : 2, it.downloadFactor ?? 0, -res, KIND_RANK[info?.kind] ?? 0, -(it.seeders ?? 0)],
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
    for (let i = 0; i < a.sort.length; i++) if (a.sort[i] !== b.sort[i]) return a.sort[i] - b.sort[i];
    return 0;
  });
  return rows.map((r) => r.stream);
}

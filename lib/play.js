// Playback: pick the file, raise its priority, serve it piece-gated over HTTP ranges.
import { join, dirname } from 'node:path';
import { pickFile, VIDEO_EXT } from './parse.js';
import { serveFile } from './streamer.js';
import { focusPlan, restorePlan, shouldRestore, NORMAL, TOP } from './focus.js';
import { UserError } from './grab.js';

const FOCUS_IDLE_MS = 20 * 60 * 1000;

// Exported standalone (rather than tucked inside makePlayer) so lib/addon.js's warmUp
// can raise a torrent's priority without needing a player instance - avoiding a circular
// import between the two modules, since streamsFor (addon) is what triggers warm-ups.
export async function focusOn(qbit, store, hash, fileIndex, qfiles, info) {
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

export function makePlayer({ cfg, store, qbit, home, torrentMeta, ensureTorrent, cachedItem, log }) {
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

    const meta = await torrentMeta.get(entry.hash);
    const ep = Number(s) ? { season: Number(s), episode: Number(e) } : null;
    const target = pickFile(meta?.files || entry.files, ep);
    if (!target) throw new UserError(`no video file for ${ep ? `S${s}E${e}` : 'movie'} in ${entry.name}`);
    return streamTarget(req, res, { hash: entry.hash, entry, target, pieceLength: meta?.pieceLength || entry.pieceLength, metaMissing: !meta });
  }

  // Playing something already at home. Unlike handlePlay, this never spends a download.
  async function handlePlayLocal(req, res, hash, s, e) {
    const entry = await home.byHash(hash);
    if (!entry) throw new UserError('not in qBittorrent any more');
    const meta = await torrentMeta.get(hash);
    const ep = Number(s) ? { season: Number(s), episode: Number(e) } : null;
    const target = pickFile(meta?.files || entry.files, ep);
    if (!target) throw new UserError(`no video file for ${ep ? `S${s}E${e}` : 'movie'} in ${entry.name}`);
    return streamTarget(req, res, { hash, entry, target, pieceLength: meta?.pieceLength || entry.pieceLength, metaMissing: !meta });
  }

  async function streamTarget(req, res, { hash, entry, target, pieceLength, metaMissing }) {
    const [qfiles, props, info] = await Promise.all([qbit.files(hash), qbit.properties(hash), qbit.torrent(hash)]);
    const qf =
      qfiles.find((f) => f.name === target.path) ||
      qfiles.find((f) => f.size === target.length && f.name.split('/').pop() === target.path.split('/').pop());
    if (!qf) throw new UserError(`file not found in qBittorrent: ${target.path}`);
    // Without the exported .torrent we have no byte offset, so an incomplete file can't be
    // piece-gated; the streamer will wait out its timeout and 503. Log why, so a spinner
    // that looks stuck has a cause in the log instead of nothing.
    if (metaMissing && qf.progress < 1) {
      log(`play ${hash}: torrent layout unavailable (exported .torrent could not be read), so byte offsets are unknown and ${qf.name} (${(qf.progress * 100).toFixed(1)}%) cannot be piece-gated`);
    }
    if (qf.progress < 1) await focusOn(qbit, store, hash, qf.index, qfiles, info);
    if (req.method !== 'HEAD') log(`play ${hash} ${qf.name} (${(qf.progress * 100).toFixed(1)}%) range=${req.headers.range || '-'} ua=${req.headers['user-agent'] || '-'}`);

    // content_path is the torrent's current location (unfinished files may still sit in
    // a per-torrent download_path); qBittorrent file names start with the root folder.
    const location = info.content_path ? dirname(info.content_path) : props.save_path;
    await serveFile(
      req,
      res,
      {
        qbit,
        hash,
        path: join(location, qf.name),
        size: qf.size,
        offset: target.offset,
        pieceLength: pieceLength || props.piece_size,
        complete: qf.progress >= 1,
      },
      log,
    );
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

  return { handlePlay, handlePlayLocal, restoreFocus };
}

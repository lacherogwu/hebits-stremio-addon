// Playback: pick the file, raise its priority, serve it piece-gated over HTTP ranges.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import type { Config } from './config';
import { focusPlan, NORMAL, restorePlan, shouldRestore, TOP } from './focus';
import { UserError } from './grab';
import { makeLock } from './lock';
import type { Episode, FileEntry } from './parse';
import { pickFile, VIDEO_EXT } from './parse';
import type { Properties, QFile, Torrent } from './qbit';
import type { FocusEntry, TorrentEntry } from './store';
import type { PieceStateSource } from './streamer';
import { serveFile } from './streamer';
import type { TorrentMetaEntry } from './torrentmeta';

const FOCUS_IDLE_MS = 20 * 60 * 1000;

// The slice of QBit that focusOn (standalone) reads.
export interface FocusQBit {
  torrent(hash: string): Promise<Torrent | undefined>;
  files(hash: string): Promise<QFile[]>;
  setFilePriority(hash: string, ids: number[], priority: number): Promise<unknown>;
  setSequential(hash: string, on: boolean, current: unknown): Promise<void>;
  setFirstLastPiecePrio(hash: string, on: boolean, current: unknown): Promise<void>;
}

// The slice of QBit that makePlayer's whole dependency surface reads: everything
// focusOn needs, plus `properties` (streamTarget's save-path lookup) and `pieceStates`
// (forwarded straight into serveFile for piece-gating).
export interface PlayQBit extends FocusQBit, PieceStateSource {
  properties(hash: string): Promise<Properties>;
}

// The slice of Store that focusOn/makePlayer read. Narrower than the Store class so a
// test fake needs no `as any` to stand in for it.
export interface PlayStore {
  data: { focus?: Record<string, FocusEntry> };
  torrent(hebitsId: string): TorrentEntry | undefined;
  save(): void;
}

// The slice of HomeLibrary that handlePlayLocal reads.
export interface PlayHomeEntry {
  hash: string;
  name?: string;
  files: FileEntry[];
  pieceLength?: number;
}

export interface PlayHome {
  byHash(hash: string): Promise<PlayHomeEntry | undefined>;
}

// The slice of TorrentMeta that play.ts reads.
export interface PlayTorrentMeta {
  get(hash: string): Promise<Pick<TorrentMetaEntry, 'files' | 'pieceLength'> | null>;
}

export type EnsureTorrentFn = (hebitsId: string, meta: Partial<TorrentEntry>) => Promise<TorrentEntry | undefined>;

// What the search cache (addon.ts's cachedItem) holds for a Hebits id, as read here.
export interface CachedItem {
  title?: string;
  size?: number;
  files?: number;
  cover?: string;
  seeders?: number;
}

export interface MakePlayerDeps {
  cfg: Pick<Config, 'watchCategory'>;
  store: PlayStore;
  qbit: PlayQBit;
  home: PlayHome;
  torrentMeta: PlayTorrentMeta;
  ensureTorrent: EnsureTorrentFn;
  cachedItem: (hebitsId: string) => CachedItem | undefined;
  log: (message: string) => void;
}

// A file entry with or without a known byte offset: torrentMeta's export carries one,
// home.js's own file listing (no exported .torrent needed) does not - see the
// metaMissing comment in streamTarget below for what happens when it's absent.
type PlayableFile = FileEntry & { offset?: number };

// TorrentEntry.hash is optional only for entries recorded before a grab; by the time
// ensureTorrent returns successfully (it throws UserError otherwise) the entry it just
// stored always has one - see grab.ts's ensureTorrent.
type GrabbedEntry = TorrentEntry & { hash: string };

// setSequential/setFirstLastPiecePrio are toggles decided from a snapshot of the
// torrent's state, so two focusOn calls on the same hash running seconds apart (a
// fire-and-forget warm-up racing a real play request is the routine case) can each
// decide to toggle from the same stale "off" snapshot - the second flips it right back
// off. Serializing per hash means the second call only starts once the first has fully
// applied, and re-reading state inside the lock means it decides from what's actually
// there instead of what it saw before it waited.
const withFocusLock = makeLock();

// Exported standalone (rather than tucked inside makePlayer) so lib/addon.js's warmUp
// can raise a torrent's priority without needing a player instance - avoiding a circular
// import between the two modules, since streamsFor (addon) is what triggers warm-ups.
export function focusOn(qbit: FocusQBit, store: PlayStore, hash: string, fileIndex: number): Promise<void> {
  return withFocusLock(hash, async () => {
    const [qfiles, info] = await Promise.all([qbit.files(hash), qbit.torrent(hash)]);
    if (!info) return; // torrent is gone; nothing to focus
    store.data.focus ??= {};
    const focus = store.data.focus;
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
  });
}

export function makePlayer({ cfg, store, qbit, home, torrentMeta, ensureTorrent, cachedItem, log }: MakePlayerDeps) {
  async function handlePlay(
    req: IncomingMessage,
    res: ServerResponse,
    hebitsId: string,
    s: string | undefined,
    e: string | undefined,
    query: URLSearchParams,
  ): Promise<void> {
    const entry = store.torrent(hebitsId);
    const known = entry?.hash && (await qbit.torrent(entry.hash));
    // Some players probe with HEAD; never grab a new torrent for a probe.
    if (req.method === 'HEAD' && !known) {
      res.writeHead(200, { 'Accept-Ranges': 'bytes', 'Content-Type': 'video/x-matroska' });
      res.end();
      return;
    }

    const item = cachedItem(hebitsId);
    if (!known && item && !((item.seeders ?? 0) > 0)) throw new UserError('no seeders on Hebits right now; not using a download on it');
    // ensureTorrent only returns undefined via a failed grab, which throws UserError
    // before ever getting here - the entry it just stored always has a hash.
    const grabbed = (await ensureTorrent(hebitsId, {
      imdb: query.get('imdb') || undefined,
      type: query.get('type') || undefined,
      title: item?.title ?? entry?.title,
      size: item?.size ?? entry?.size,
      fileCount: item?.files ?? entry?.fileCount,
      cover: item?.cover ?? entry?.cover,
    })) as GrabbedEntry;

    const meta = await torrentMeta.get(grabbed.hash);
    const ep: Episode | null = Number(s) ? { season: Number(s), episode: Number(e) } : null;
    // entry.files is optional only for entries recorded before a grab; grabbed here
    // always has one (see GrabbedEntry above).
    const files = (meta?.files || grabbed.files) as PlayableFile[];
    const target = pickFile(files, ep);
    if (!target) throw new UserError(`no video file for ${ep ? `S${s}E${e}` : 'movie'} in ${grabbed.name}`);
    return streamTarget(req, res, {
      hash: grabbed.hash,
      target,
      pieceLength: meta?.pieceLength || grabbed.pieceLength,
      metaMissing: !meta,
    });
  }

  // Playing something already at home. Unlike handlePlay, this never spends a download.
  async function handlePlayLocal(
    req: IncomingMessage,
    res: ServerResponse,
    hash: string,
    s: string | undefined,
    e: string | undefined,
  ): Promise<void> {
    const entry = await home.byHash(hash);
    if (!entry) throw new UserError('not in qBittorrent any more');
    const meta = await torrentMeta.get(hash);
    const ep: Episode | null = Number(s) ? { season: Number(s), episode: Number(e) } : null;
    const target = pickFile<PlayableFile>(meta?.files || entry.files, ep);
    if (!target) throw new UserError(`no video file for ${ep ? `S${s}E${e}` : 'movie'} in ${entry.name}`);
    return streamTarget(req, res, { hash, target, pieceLength: meta?.pieceLength || entry.pieceLength, metaMissing: !meta });
  }

  interface StreamTargetArgs {
    hash: string;
    target: PlayableFile;
    pieceLength: number | undefined;
    metaMissing: boolean;
  }

  async function streamTarget(
    req: IncomingMessage,
    res: ServerResponse,
    { hash, target, pieceLength, metaMissing }: StreamTargetArgs,
  ): Promise<void> {
    const [qfiles, props, infoMaybe] = await Promise.all([qbit.files(hash), qbit.properties(hash), qbit.torrent(hash)]);
    // streamTarget only runs once the caller has just confirmed (or grabbed) this
    // torrent moments earlier; like the original JS, this doesn't guard against it
    // vanishing from qBittorrent in that instant either.
    const info = infoMaybe as Torrent;
    // Exact path match first, size included: a name collision without a size match is not
    // the right file. Falling back to a basename+size match (older or layout-shifted
    // entries) is only trustworthy when exactly one file qualifies - more than one
    // candidate means we can't tell which file to gate the stream on, so it's a miss.
    const targetBase = target.path.split('/').pop();
    let qf = qfiles.find((f) => f.name === target.path && f.size === target.length);
    if (!qf) {
      const candidates = qfiles.filter((f) => f.size === target.length && f.name.split('/').pop() === targetBase);
      const [only] = candidates;
      if (candidates.length === 1 && only) qf = only;
    }
    if (!qf) throw new UserError(`file not found in qBittorrent: ${target.path}`);
    // Without the exported .torrent we have no byte offset, so an incomplete file can't be
    // piece-gated; the streamer will wait out its timeout and 503. Log why, so a spinner
    // that looks stuck has a cause in the log instead of nothing.
    if (metaMissing && qf.progress < 1) {
      log(
        `play ${hash}: torrent layout unavailable (exported .torrent could not be read), so byte offsets are unknown and ${qf.name} (${(qf.progress * 100).toFixed(1)}%) cannot be piece-gated`,
      );
    }
    if (qf.progress < 1) await focusOn(qbit, store, hash, qf.index);
    if (req.method !== 'HEAD')
      log(
        `play ${hash} ${qf.name} (${(qf.progress * 100).toFixed(1)}%) range=${req.headers.range || '-'} ua=${req.headers['user-agent'] || '-'}`,
      );

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
        // metaMissing (no exported .torrent) means no byte offset; NaN reproduces the
        // original code's `undefined` here, which pieceAt() turns into NaN and the
        // streamer waits out its timeout on - see the metaMissing log above.
        offset: target.offset ?? Number.NaN,
        pieceLength: pieceLength || props.piece_size,
        complete: qf.progress >= 1,
      },
      log,
    );
  }

  async function restoreFocus(): Promise<void> {
    const focus = store.data.focus || {};
    let changed = false;
    for (const [hash, f] of Object.entries(focus)) {
      try {
        const info = await qbit.torrent(hash);
        if (!info) {
          delete focus[hash];
          changed = true;
          continue;
        }
        const qfiles = await qbit.files(hash);
        if (!shouldRestore(f, qfiles, Date.now(), FOCUS_IDLE_MS)) continue;
        // Paused files are only put back for torrents this addon manages; see focus.ts.
        await qbit.setFilePriority(hash, restorePlan(qfiles, info.category === cfg.watchCategory), NORMAL);
        await qbit.setSequential(hash, f.seq, info.seq_dl);
        await qbit.setFirstLastPiecePrio(hash, f.fl, info.f_l_piece_prio);
        delete focus[hash];
        changed = true;
        log(`focus restored on ${info.name}`);
      } catch (e) {
        const err = e as Error;
        log(`restore ${hash}: ${err.message}`);
      }
    }
    if (changed) store.save();
  }

  return { handlePlay, handlePlayLocal, restoreFocus };
}

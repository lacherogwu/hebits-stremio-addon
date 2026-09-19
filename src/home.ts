// The home library, derived from qBittorrent. The client is the source of truth about
// what is on the disk; identity that a torrent file cannot carry comes from its tags.
import type { FileEntry } from './parse';
import { parseTags } from './tags';

const HEBITS = /hebits\.net/i;

// The slice of a qBittorrent torrent this module reads (kept narrow rather than
// importing qbit.ts's Torrent, so a test fake needs no unused fields).
export interface HomeTorrent {
  hash: string;
  name: string;
  tags: string;
  size: number;
  progress: number;
  state: string;
  category: string;
  piece_size: number;
  tracker?: string;
  magnet_uri?: string;
}

export interface HomeEntry {
  hash: string;
  hebitsId?: string;
  imdb?: string;
  name: string;
  size: number;
  progress: number;
  state: string;
  category: string;
  pieceLength: number;
  files: FileEntry[];
}

// The slice of a torrents/files entry filesOf reads.
export interface HomeQFile {
  name: string;
  size: number;
}

// The slice of QBit that HomeLibrary reads.
export interface HomeQBit {
  all(): Promise<HomeTorrent[]>;
  files(hash: string): Promise<HomeQFile[]>;
}

// `tracker` holds the currently-working tracker and is empty while none responds, so a
// stalled torrent would vanish from the rows. `magnet_uri` carries the whole announce
// list regardless, and both fields are already in the torrents/info response.
//
// We match the raw, still-percent-encoded `magnet_uri` rather than decoding it first.
// Percent-encoding in a magnet link escapes characters like `:` and `/`, but leaves a
// hostname's letters and dots untouched, so `hebits.net` is present literally in
// `&tr=https%3A%2F%2Ftracker.hebits.net%2FKEY%2Fannounce` with no decoding needed.
// decodeURIComponent throws URIError on a malformed percent-sequence anywhere in the
// string (e.g. a stray `%` in the torrent's own name, via `dn=`), and one such torrent
// from any source would take down the whole catalogue; skipping the decode avoids that
// class of failure entirely, rather than guarding it with a try/catch.
export function isHebitsTorrent(t: Pick<HomeTorrent, 'tracker' | 'magnet_uri'>): boolean {
  return HEBITS.test(t.tracker ?? '') || HEBITS.test(t.magnet_uri ?? '');
}

export function entryFrom(t: HomeTorrent, files: FileEntry[]): HomeEntry {
  const { hebitsId, imdb } = parseTags(t.tags);
  return {
    hash: t.hash,
    hebitsId,
    imdb,
    name: t.name,
    size: t.size,
    progress: t.progress,
    state: t.state,
    category: t.category,
    pieceLength: t.piece_size,
    files,
  };
}

export class HomeLibrary {
  qbit: HomeQBit;
  log: (message: string) => void;
  fileCache = new Map<string, FileEntry[]>(); // hash -> {path, length}[]

  constructor(qbit: HomeQBit, log: (message: string) => void = () => {}) {
    this.qbit = qbit;
    this.log = log;
  }

  // torrents/files omits pad-file entries, which is fine here: catalogs only need names
  // and sizes. Byte offsets for playback come from the exported .torrent instead.
  async filesOf(hash: string): Promise<FileEntry[]> {
    const cached = this.fileCache.get(hash);
    if (cached) return cached;
    // A failed call must not be cached: the empty list it returns here is a fallback
    // for callers, not a fact about the torrent, and a transient error must be retryable.
    let files: HomeQFile[];
    try {
      files = await this.qbit.files(hash);
    } catch (e) {
      this.log(`files ${hash}: ${(e as Error).message}`);
      return [];
    }
    const entry = files.map((f) => ({ path: f.name, length: f.size }));
    this.fileCache.set(hash, entry);
    return entry;
  }

  forget(hash: string): void {
    this.fileCache.delete(hash);
  }

  // Shared by entries() and byHash(): the raw qBittorrent torrent objects, not entries,
  // so byHash can find its one torrent before paying for any torrents/files call.
  async hebitsTorrents(): Promise<HomeTorrent[]> {
    const all = await this.qbit.all().catch((e: Error) => {
      this.log(`home library: ${e.message}`);
      return [] as HomeTorrent[];
    });
    return all.filter(isHebitsTorrent);
  }

  async entries(): Promise<HomeEntry[]> {
    const torrents = await this.hebitsTorrents();
    return Promise.all(torrents.map(async (t) => entryFrom(t, await this.filesOf(t.hash))));
  }

  // Looks the torrent up directly rather than building every entry via entries(): on a
  // library of N torrents that would mean N torrents/files calls to answer about one.
  async byHash(hash: string): Promise<HomeEntry | undefined> {
    const t = (await this.hebitsTorrents()).find((t) => t.hash === hash);
    return t && entryFrom(t, await this.filesOf(t.hash));
  }
}

// The home library, derived from qBittorrent. The client is the source of truth about
// what is on the disk; identity that a torrent file cannot carry comes from its tags.
import { parseTags } from './tags.js';

const HEBITS = /hebits\.net/i;

// `tracker` holds the currently-working tracker and is empty while none responds, so a
// stalled torrent would vanish from the rows. `magnet_uri` carries the whole announce
// list regardless, and both fields are already in the torrents/info response.
export function isHebitsTorrent(t) {
  return HEBITS.test(t.tracker || '') || HEBITS.test(decodeURIComponent(t.magnet_uri || ''));
}

export function entryFrom(t, files) {
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
  constructor(qbit, log = () => {}) {
    this.qbit = qbit;
    this.log = log;
    this.fileCache = new Map(); // hash -> {path, length}[]
  }

  // torrents/files omits pad-file entries, which is fine here: catalogs only need names
  // and sizes. Byte offsets for playback come from the exported .torrent instead.
  async filesOf(hash) {
    if (this.fileCache.has(hash)) return this.fileCache.get(hash);
    // A failed call must not be cached: the empty list it returns here is a fallback
    // for callers, not a fact about the torrent, and a transient error must be retryable.
    let files;
    try {
      files = await this.qbit.files(hash);
    } catch (e) {
      this.log(`files ${hash}: ${e.message}`);
      return [];
    }
    const entry = files.map((f) => ({ path: f.name, length: f.size }));
    this.fileCache.set(hash, entry);
    return entry;
  }

  forget(hash) {
    this.fileCache.delete(hash);
  }

  async entries() {
    const all = await this.qbit.all().catch((e) => {
      this.log(`home library: ${e.message}`);
      return [];
    });
    return Promise.all(all.filter(isHebitsTorrent).map(async (t) => entryFrom(t, await this.filesOf(t.hash))));
  }

  async byHash(hash) {
    return (await this.entries()).find((e) => e.hash === hash);
  }
}

// Byte-exact file layout, taken from the .torrent qBittorrent still holds.
// Needed because torrents/files omits pad-file entries, so summing its sizes gives
// wrong offsets on padded torrents — and a wrong offset means a wrong piece, which
// means the streamer waits for data that will never arrive.
import { readTorrent, type TorrentFile } from './bencode';

export interface TorrentMetaEntry {
  files: TorrentFile[];
  pieceLength: number;
  name: string;
}

// The slice of QBit that TorrentMeta needs.
export interface TorrentMetaSource {
  exportTorrent(hash: string): Promise<Buffer>;
}

export class TorrentMeta {
  qbit: TorrentMetaSource;
  log: (message: string) => void;
  cache: Map<string, TorrentMetaEntry>;

  constructor(qbit: TorrentMetaSource, log: (message: string) => void = () => {}) {
    this.qbit = qbit;
    this.log = log;
    this.cache = new Map(); // hash -> {files, pieceLength}
  }

  async get(hash: string): Promise<TorrentMetaEntry | null> {
    const cached = this.cache.get(hash);
    if (cached) return cached;
    try {
      const t = readTorrent(await this.qbit.exportTorrent(hash));
      const value: TorrentMetaEntry = { files: t.files, pieceLength: t.pieceLength, name: t.name };
      this.cache.set(hash, value); // a torrent's layout never changes
      return value;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`torrent meta ${hash}: ${message}`);
      return null; // not cached: a transient failure must not poison playback forever
    }
  }
}

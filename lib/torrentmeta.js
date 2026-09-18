// Byte-exact file layout, taken from the .torrent qBittorrent still holds.
// Needed because torrents/files omits pad-file entries, so summing its sizes gives
// wrong offsets on padded torrents — and a wrong offset means a wrong piece, which
// means the streamer waits for data that will never arrive.
import { readTorrent } from './bencode.js';

export class TorrentMeta {
  constructor(qbit, log = () => {}) {
    this.qbit = qbit;
    this.log = log;
    this.cache = new Map(); // hash -> {files, pieceLength}
  }

  async get(hash) {
    if (this.cache.has(hash)) return this.cache.get(hash);
    try {
      const t = readTorrent(await this.qbit.exportTorrent(hash));
      const value = { files: t.files, pieceLength: t.pieceLength, name: t.name };
      this.cache.set(hash, value); // a torrent's layout never changes
      return value;
    } catch (e) {
      this.log(`torrent meta ${hash}: ${e.message}`);
      return null; // not cached: a transient failure must not poison playback forever
    }
  }
}

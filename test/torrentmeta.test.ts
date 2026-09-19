import { expect, test } from 'vitest';
import { readTorrent } from '../src/bencode';
import { TorrentMeta } from '../src/torrentmeta';

// Two 100-byte files separated by a 24-byte pad file, piece length 64.
// qBittorrent's torrents/files hides the pad entry, so summing its sizes would put
// file 2 at offset 100 instead of 124. The exported .torrent does not lie.
function padded(): Buffer {
  const f = (path: string, len: number) => `d6:lengthi${len}e4:pathl${path.length}:${path}ee`;
  const files = f('a.mkv', 100) + `d4:attr1:p6:lengthi24e4:pathl7:.pad/24ee` + f('b.mkv', 100);
  const info = `d5:filesl${files}e4:name3:pak12:piece lengthi64e6:pieces0:7:privatei1ee`;
  return Buffer.from(`d4:info${info}e`);
}

test('offsets account for pad files', () => {
  const t = readTorrent(padded());
  const real = t.files.filter((x) => /\.mkv$/.test(x.path));
  expect(real[0]?.offset).toBe(0);
  expect(real[1]?.offset).toBe(124);
});

test('get exports once and caches', async () => {
  let calls = 0;
  const meta = new TorrentMeta({
    async exportTorrent() {
      calls++;
      return padded();
    },
  });
  const a = await meta.get('H');
  const b = await meta.get('H');
  expect(calls).toBe(1);
  expect(a?.pieceLength).toBe(64);
  expect(b?.files.length).toBe(a?.files.length);
});

test('get returns null when the export fails, and retries next time', async () => {
  let calls = 0;
  const meta = new TorrentMeta(
    {
      async exportTorrent() {
        calls++;
        throw new Error('HTTP 404');
      },
    },
    () => {},
  );
  expect(await meta.get('H')).toBe(null);
  expect(await meta.get('H')).toBe(null);
  expect(calls).toBe(2);
});

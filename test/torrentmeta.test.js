import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TorrentMeta } from '../lib/torrentmeta.js';
import { readTorrent } from '../lib/bencode.js';

// Two 100-byte files separated by a 24-byte pad file, piece length 64.
// qBittorrent's torrents/files hides the pad entry, so summing its sizes would put
// file 2 at offset 100 instead of 124. The exported .torrent does not lie.
function padded() {
  const f = (path, len) => `d6:lengthi${len}e4:pathl${path.length}:${path}ee`;
  const files = f('a.mkv', 100) + `d4:attr1:p6:lengthi24e4:pathl7:.pad/24ee` + f('b.mkv', 100);
  const info = `d5:filesl${files}e4:name3:pak12:piece lengthi64e6:pieces0:7:privatei1ee`;
  return Buffer.from(`d4:info${info}e`);
}

test('offsets account for pad files', () => {
  const t = readTorrent(padded());
  const real = t.files.filter((x) => /\.mkv$/.test(x.path));
  assert.equal(real[0].offset, 0);
  assert.equal(real[1].offset, 124);
});

test('get exports once and caches', async () => {
  let calls = 0;
  const meta = new TorrentMeta({ async exportTorrent() { calls++; return padded(); } });
  const a = await meta.get('H');
  const b = await meta.get('H');
  assert.equal(calls, 1);
  assert.equal(a.pieceLength, 64);
  assert.equal(b.files.length, a.files.length);
});

test('get returns null when the export fails, and retries next time', async () => {
  let calls = 0;
  const meta = new TorrentMeta(
    { async exportTorrent() { calls++; throw new Error('HTTP 404'); } },
    () => {},
  );
  assert.equal(await meta.get('H'), null);
  assert.equal(await meta.get('H'), null);
  assert.equal(calls, 2);
});

// Hebits search through Jackett's Torznab API.

const CACHE_MS = 10 * 60 * 1000;

const unescape = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? unescape(m[1]) : undefined;
}

function attr(xml, name) {
  const m = xml.match(new RegExp(`<torznab:attr name="${name}" value="([^"]*)"`));
  return m ? unescape(m[1]) : undefined;
}

export function parseTorznab(xml) {
  const err = xml.match(/<error code="(\d+)" description="([^"]*)"/);
  if (err) throw new Error(`Jackett: ${unescape(err[2])}`);
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const x = m[1];
    const id = (tag(x, 'comments') || tag(x, 'guid') || '').match(/(?:torrentid|[?&]id)=(\d+)/)?.[1];
    if (!id) continue;
    const num = (v) => (v === undefined ? undefined : Number(v));
    items.push({
      hebitsId: id,
      title: tag(x, 'title'),
      size: num(tag(x, 'size')),
      files: num(tag(x, 'files')),
      grabs: num(tag(x, 'grabs')),
      link: tag(x, 'link'),
      imdb: attr(x, 'imdbid'),
      cover: attr(x, 'coverurl'),
      pubDate: Date.parse(tag(x, 'pubDate') || '') || undefined,
      categories: [...x.matchAll(/<category>(\d+)<\/category>/g)].map((c) => Number(c[1])),
      seeders: num(attr(x, 'seeders')) ?? 0,
      peers: num(attr(x, 'peers')) ?? 0,
      downloadFactor: num(attr(x, 'downloadvolumefactor')) ?? 1,
      uploadFactor: num(attr(x, 'uploadvolumefactor')) ?? 1,
    });
  }
  return items;
}

export class Jackett {
  constructor({ jackettUrl, jackettIndexer, jackettApiKey }) {
    this.base = `${jackettUrl}/api/v2.0/indexers/${jackettIndexer}/results/torznab/api`;
    this.apiKey = jackettApiKey;
    this.cache = new Map();
    this.links = new Map(); // hebitsId -> latest Jackett download link
  }

  async search(params) {
    const qs = new URLSearchParams({ apikey: this.apiKey, ...params });
    const key = qs.toString();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.items;

    const res = await fetch(`${this.base}?${qs}`, { signal: AbortSignal.timeout(45_000) });
    if (!res.ok) throw new Error(`Jackett HTTP ${res.status}`);
    const items = parseTorznab(await res.text());
    for (const it of items) if (it.link) this.links.set(it.hebitsId, it.link);
    this.cache.set(key, { at: Date.now(), items });
    return items;
  }

  // Movies: IMDb search. Series: Hebits matches the IMDb id as free text; add a
  // season-scoped query so big shows aren't cut off by the 50-result page.
  async forTitle(type, imdb, season) {
    const queries =
      type === 'movie'
        ? [{ t: 'movie', imdbid: imdb }]
        : [{ t: 'search', q: imdb }, ...(season ? [{ t: 'tvsearch', q: imdb, season: String(season) }] : [])];
    const results = await Promise.all(queries.map((q) => this.search(q)));
    const byId = new Map();
    for (const it of results.flat()) byId.set(it.hebitsId, it);
    return [...byId.values()];
  }

  async downloadTorrent(hebitsId) {
    const link = this.links.get(hebitsId);
    if (!link) throw new Error('no download link cached; reopen the title');
    const res = await fetch(link, { signal: AbortSignal.timeout(45_000) });
    if (!res.ok) throw new Error(`Jackett download HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

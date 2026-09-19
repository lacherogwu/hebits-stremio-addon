// Poster covers for torrents we have seen in search results. Replaces a reach-in to the old
// indexer client's private cache; a miss means no poster, exactly as a cache miss did before.
export class CoverCache {
  readonly #max: number;
  readonly #map = new Map<string, string>();

  constructor(max = 500) {
    this.#max = max;
  }

  remember(id: string, cover: string | undefined): void {
    if (cover === undefined) return;
    if (!this.#map.has(id) && this.#map.size >= this.#max) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    this.#map.set(id, cover);
  }

  get(id: string): string | undefined {
    return this.#map.get(id);
  }
}

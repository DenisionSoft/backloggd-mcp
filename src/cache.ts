/**
 * Small TTL cache. Its real purpose is politeness: every hit here is a request that
 * Backloggd does not have to serve, which matters for a site this size.
 */
export class TtlCache<V> {
  private readonly store = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1000,
  ) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  async wrap(key: string, fn: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await fn();
    this.set(key, value);
    return value;
  }
}

/**
 * Cache lifetimes, chosen by how fast each thing actually changes.
 *
 * Slug→id is effectively permanent (ids are stable; slugs only move on game merges),
 * catalogue metadata changes rarely, and the user's own state must stay fresh enough
 * that a read straight after a write reflects it — hence the deliberately short TTL,
 * plus explicit invalidation on every write.
 */
export const CACHE_TTL = {
  slugToId: 24 * 3600_000,
  gameMetadata: 6 * 3600_000,
  userState: 20_000,
  /**
   * The all-lists reverse index. Expensive to build (one large page per list), so it
   * gets a much longer life than other user state — and every list write clears it
   * explicitly, so staleness cannot outlive an actual change made through this server.
   */
  listIndex: 5 * 60_000,
  publicPage: 5 * 60_000,
} as const;

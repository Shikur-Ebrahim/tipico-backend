type CacheEntry<T> = { at: number; data: T };

const store = new Map<string, CacheEntry<unknown>>();

/** Short TTL so repeat home/meta requests feel instant on a warm instance. */
const DEFAULT_TTL_MS = 45_000;

export function getCachedResponse<T>(key: string, ttlMs = DEFAULT_TTL_MS): T | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) {
    store.delete(key);
    return null;
  }
  return hit.data as T;
}

export function setCachedResponse<T>(key: string, data: T): void {
  store.set(key, { at: Date.now(), data });
}

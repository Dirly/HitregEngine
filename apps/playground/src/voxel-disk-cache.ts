/** Disposable, bounded derived terrain. IndexedDB keeps this off the JS heap. */
const LIMIT = 128 * 1024 * 1024;
interface Entry { key: string; bytes: number; time: number; value: unknown }

export function cacheBytes(value: unknown): number {
  if (value == null) return 4;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (typeof value === "string") return value.length * 2;
  if (typeof value !== "object") return 8;
  return 32 + Object.entries(value).reduce((n, [key, item]) => n + key.length * 2 + cacheBytes(item), 0);
}

export async function contentKey(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
}

export class VoxelDiskCache {
  private readonly db: Promise<IDBDatabase | null>;
  readonly stats = { hits: 0, misses: 0, writes: 0 };
  constructor(private readonly namespace: string, private readonly limit = LIMIT) {
    this.db = new Promise((resolve) => {
      try {
        if (typeof indexedDB === "undefined") { resolve(null); return; }
        const req = indexedDB.open("hitreg-voxel-cache", 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore("entries", { keyPath: "key" }).createIndex("time", "time");
          req.result.createObjectStore("meta");
        };
        req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }

  async get<T>(key: string): Promise<T | null> {
    const db = await this.db;
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const req = db.transaction("entries", "readonly").objectStore("entries").get(`${this.namespace}:${key}`);
        req.onsuccess = () => {
          const entry = req.result as Entry | undefined;
          if (entry) this.stats.hits++; else this.stats.misses++;
          resolve(entry ? entry.value as T : null);
        };
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }

  async put(key: string, value: unknown): Promise<void> {
    const db = await this.db;
    const bytes = cacheBytes(value);
    if (!db || bytes > this.limit) return;
    const fullKey = `${this.namespace}:${key}`;
    return new Promise((resolve) => {
      try {
        // A single read/write transaction serializes accounting across all
        // generation workers. Old recipes and old worlds share this budget.
        const tx = db.transaction(["entries", "meta"], "readwrite");
        const entries = tx.objectStore("entries"), meta = tx.objectStore("meta");
        tx.oncomplete = () => { this.stats.writes++; resolve(); };
        tx.onerror = tx.onabort = () => resolve();
        const totalRead = meta.get("bytes");
        totalRead.onsuccess = () => {
          const previous = entries.get(fullKey);
          previous.onsuccess = () => {
            let total = (Number(totalRead.result) || 0) - ((previous.result as Entry | undefined)?.bytes ?? 0) + bytes;
            entries.put({ key: fullKey, bytes, time: Date.now(), value } satisfies Entry);
            if (total <= this.limit) { meta.put(total, "bytes"); return; }
            const cursor = entries.index("time").openCursor();
            cursor.onsuccess = () => {
              const item = cursor.result;
              if (!item || total <= this.limit) { meta.put(total, "bytes"); return; }
              // a record with no value (a write torn by a crash) is evicted like any other, not tripped over
              if (item.primaryKey !== fullKey) { total -= (item.value as Entry | null)?.bytes ?? 0; item.delete(); }
              item.continue();
            };
          };
        };
      } catch { resolve(); }
    });
  }
}

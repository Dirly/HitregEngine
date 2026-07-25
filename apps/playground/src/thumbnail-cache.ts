/**
 * Persistent store for baked asset thumbnails, keyed by a content hash so a
 * thumbnail survives page reloads and only re-bakes when its source actually
 * changed. Without this, every reload (and, before the script-HMR boundary,
 * every AI script edit triggered one) re-ran a buildScene + offscreen render +
 * GPU pixel readback for every prefab, model, and material — the "all the
 * materials re-grab screenshots, all the GLBs reload" stall.
 *
 * Best-effort: if IndexedDB is unavailable (private mode, no browser), every
 * method degrades to a miss/no-op and baking simply proceeds as before.
 */

const DB_NAME = "hitreg-thumbs";
const STORE = "thumbs";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** Data URL for a content key, or undefined on a miss (or if IDB is unavailable). */
export async function getThumb(key: string): Promise<string | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : undefined);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** Persist a baked thumbnail. Fire-and-forget; failures are swallowed. */
export async function putThumb(key: string, dataUrl: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    db.transaction(STORE, "readwrite").objectStore(STORE).put(dataUrl, key);
  } catch {
    /* over-quota or closed db — the thumbnail just re-bakes next time */
  }
}

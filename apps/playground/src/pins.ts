import { createPins, type Pin, type Pins } from "@hitreg/editor";
import { mergePins } from "./pin-merge.js";

/**
 * Client side of the pin store: keeps the editor's `Pins` observable in sync
 * with `.hitreg/pins/<scene>.json` through the dev bridge.
 *
 * The file has two writers (this tab, and agents answering notes), so nothing
 * here REPLACES it: a save posts this tab's notes and the server merges them
 * per note id (`pin-merge.ts`), and the tab re-reads the file every few seconds
 * and merges what agents wrote (replies, `resolved`) into memory. Before that
 * the older copy silently erased the other side's work.
 *
 * Writes are debounced; a pending write is FLUSHED (never dropped) when the
 * scene changes or the page is hidden.
 */

const SAVE_DEBOUNCE_MS = 400;
/** How often the tab re-reads the file for what agents wrote. A local file read: cheap. */
const REFRESH_MS = 3000;

export interface PinStore {
  pins: Pins;
  /** Load the notes for a scene, replacing whatever is in memory. */
  load(scene: string): Promise<void>;
  create(point: [number, number, number], entityId: string | null): void;
  update(id: string, patch: Partial<Pin>): void;
  remove(id: string): void;
  /** Send every written, unsent, unresolved note to the agent inbox in one go; returns how many. */
  sendDrafts(): number;
}

export function createPinStore(): PinStore {
  const pins = createPins();
  let scene = "";
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  // a load must never be overwritten by a save queued for the previous scene
  let loadToken = 0;
  /** Bumped by every local change: a server answer older than the latest change is merged, never adopted whole. */
  let version = 0;
  /** Ids deleted here and not yet confirmed by the server. */
  let deleted: string[] = [];

  const adopt = (remote: Pin[]): void => {
    const merged = mergePins(pins.get(), remote, deleted); // the file laid over memory: a later local edit still wins, an agent's reply on the same stamp is taken
    if (JSON.stringify(merged) !== JSON.stringify(pins.get())) pins.set(merged);
  };

  const post = (forScene: string, list: Pin[], gone: string[]): void => {
    const at = version;
    void fetch("/__hitreg/pins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      keepalive: true, // survives the tab closing mid-write
      body: JSON.stringify({ scene: forScene, pins: list, deleted: gone }),
    })
      .then((r) => r.json() as Promise<{ pins?: Pin[] }>)
      .then((answer) => {
        if (forScene !== scene) return;
        deleted = deleted.filter((id) => !gone.includes(id));
        // nothing changed here since the post: the server's merged file IS the truth; otherwise merge it in
        if (Array.isArray(answer.pins)) (at === version ? pins.set(answer.pins) : adopt(answer.pins));
      })
      .catch(() => undefined);
  };

  const flush = (): void => {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    if (scene) post(scene, pins.get(), [...deleted]);
  };

  const save = (): void => {
    if (!scene) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  };

  const mutate = (next: Pin[]): void => {
    version++;
    pins.set(next);
    save();
  };

  const refresh = async (): Promise<void> => {
    if (!scene || saveTimer || document.hidden) return; // a pending save will bring the merged file back itself
    const forScene = scene, token = loadToken, at = version;
    try {
      const remote = (await (await fetch(`/__hitreg/pins?scene=${encodeURIComponent(forScene)}`)).json()) as Pin[];
      if (token !== loadToken || at !== version || !Array.isArray(remote)) return;
      adopt(remote);
    } catch {
      /* the bridge is down: keep what is in memory */
    }
  };
  setInterval(() => void refresh(), REFRESH_MS);
  // a tab going to the background or closing writes what it holds first
  addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
  addEventListener("pagehide", flush);

  const now = (): string => new Date().toISOString();

  return {
    pins,
    async load(name: string) {
      flush(); // the scene we are leaving keeps its last edits
      const token = ++loadToken;
      scene = name;
      deleted = [];
      pins.set([]);
      try {
        const response = await fetch(`/__hitreg/pins?scene=${encodeURIComponent(name)}`);
        const loaded = (await response.json()) as Pin[];
        if (token !== loadToken) return; // a newer load won
        // notes dropped while the file was still loading are kept
        pins.set(mergePins(pins.get(), Array.isArray(loaded) ? loaded : []));
      } catch {
        /* no notes yet, or the bridge is down: an empty list is correct */
      }
    },
    create(point, entityId) {
      mutate([
        ...pins.get(),
        {
          id: `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          point,
          entityId,
          text: "",
          createdAt: now(),
          updatedAt: now(),
          resolved: false,
          author: "human",
          sentAt: null,
        },
      ]);
    },
    update(id, patch) {
      mutate(pins.get().map((pin) => (pin.id === id ? { ...pin, ...patch, updatedAt: now() } : pin)));
    },
    remove(id) {
      deleted.push(id);
      mutate(pins.get().filter((pin) => pin.id !== id));
    },
    sendDrafts() {
      const at = now();
      let n = 0;
      const next = pins.get().map((pin) => {
        if (pin.sentAt || pin.resolved || pin.text.trim().length === 0) return pin;
        n++;
        return { ...pin, sentAt: at, updatedAt: at };
      });
      if (n > 0) mutate(next);
      return n;
    },
  };
}

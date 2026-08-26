import { createPins, type Pin, type Pins } from "@hitreg/editor";

/**
 * Client side of the pin store: keeps the editor's `Pins` observable in sync
 * with `.hitreg/pins/<scene>.json` through the dev bridge.
 *
 * Writes are debounced and always send the whole array — a scene has tens of
 * notes, not thousands, and a whole-array write means the file on disk is
 * always a complete, hand-readable document rather than something only this
 * code can reconstruct. An agent can therefore answer a note by editing that
 * file (or POSTing) without replaying a mutation log.
 */

const SAVE_DEBOUNCE_MS = 400;

export interface PinStore {
  pins: Pins;
  /** Load the notes for a scene, replacing whatever is in memory. */
  load(scene: string): Promise<void>;
  create(point: [number, number, number], entityId: string | null): void;
  update(id: string, patch: Partial<Pin>): void;
  remove(id: string): void;
}

export function createPinStore(): PinStore {
  const pins = createPins();
  let scene = "";
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  // a load must never be overwritten by a save queued for the previous scene
  let loadToken = 0;

  const save = (): void => {
    if (!scene) return;
    if (saveTimer) clearTimeout(saveTimer);
    const forScene = scene;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void fetch("/__hitreg/pins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scene: forScene, pins: pins.get() }),
      }).catch(() => undefined);
    }, SAVE_DEBOUNCE_MS);
  };

  const mutate = (next: Pin[]): void => {
    pins.set(next);
    save();
  };

  return {
    pins,
    async load(name: string) {
      const token = ++loadToken;
      scene = name;
      if (saveTimer) {
        clearTimeout(saveTimer); // belonged to the scene we just left
        saveTimer = null;
      }
      pins.set([]);
      try {
        const response = await fetch(`/__hitreg/pins?scene=${encodeURIComponent(name)}`);
        const loaded = (await response.json()) as Pin[];
        if (token !== loadToken) return; // a newer load won
        pins.set(Array.isArray(loaded) ? loaded : []);
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
          createdAt: new Date().toISOString(),
          resolved: false,
          author: "human",
          sentAt: null,
        },
      ]);
    },
    update(id, patch) {
      mutate(pins.get().map((pin) => (pin.id === id ? { ...pin, ...patch } : pin)));
    },
    remove(id) {
      mutate(pins.get().filter((pin) => pin.id !== id));
    },
  };
}

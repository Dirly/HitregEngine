import {
  CHARACTER_NETSTATE,
  DEFAULT_PROGRESSION,
  type CharacterSheet,
  type Item,
  type Progression,
} from "@hitreg/core";
import type { ScriptContext } from "./script.js";

/**
 * Where a character sheet lives at runtime, shared by the `character-sheet`
 * (authority) and `character-ui` (client) builtins.
 *
 * The answer is netState — `character/<bodyId>` — because that is the only
 * channel that is authority-gated AND replicated AND survives host migration.
 * A session without a NetStateStore (a bare test harness, an app that never
 * mounted networking) falls back to one in-memory store that behaves like an
 * always-authoritative replica, so the two scripts never need a second code
 * path; the fallback is process-local and clears when the last sheet script
 * disposes.
 */
export interface SheetStoreLike {
  isAuthority(): boolean;
  get(key: string): unknown;
  set(key: string, value: unknown): boolean;
  onChange(cb: (key: string, value: unknown) => void): () => void;
}

const localValues = new Map<string, unknown>();
const localHandlers = new Set<(key: string, value: unknown) => void>();

const localStore: SheetStoreLike = {
  isAuthority: () => true,
  get: (key) => localValues.get(key),
  set: (key, value) => {
    localValues.set(key, value);
    for (const cb of [...localHandlers]) cb(key, value);
    return true;
  },
  onChange: (cb) => {
    localHandlers.add(cb);
    return () => {
      localHandlers.delete(cb);
    };
  },
};

/** The replicated store when the session has one, the local fallback when it does not. */
export function sheetStoreOf(ctx: Pick<ScriptContext, "netState">): SheetStoreLike {
  return ctx.netState ?? localStore;
}

/** Forget a fallback-store sheet (the owning script disposed). No-op on a real store. */
export function forgetLocalSheet(actorId: string): void {
  localValues.delete(sheetKey(actorId));
}

export function sheetKey(actorId: string): string {
  return `${CHARACTER_NETSTATE}/${actorId}`;
}

/** The sheet a store holds for a body, or null. Values in netState are schema-validated on write. */
export function readSheet(store: SheetStoreLike, actorId: string): CharacterSheet | null {
  const value = store.get(sheetKey(actorId));
  return value && typeof value === "object" && "items" in value ? (value as CharacterSheet) : null;
}

/** Item definitions from the asset library (`item` data assets) — the reducers' catalog. */
export function catalogOf(ctx: Pick<ScriptContext, "getDataAsset">): (itemId: string) => Item | undefined {
  return (itemId) => {
    const asset = ctx.getDataAsset?.(itemId);
    return asset?.type === "item" ? (asset.data as Item) : undefined;
  };
}

/** A `progression` data asset by id, or the engine defaults when empty/unknown. */
export function progressionOf(ctx: Pick<ScriptContext, "getDataAsset">, id: string): Progression {
  if (!id) return DEFAULT_PROGRESSION;
  const asset = ctx.getDataAsset?.(id);
  if (asset?.type === "progression") return asset.data as Progression;
  console.warn(`[character] progression asset "${id}" not found — using engine defaults`);
  return DEFAULT_PROGRESSION;
}

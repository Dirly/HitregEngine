import { characterCreationSchema, itemSchema, type DataAssetDoc } from "@hitreg/core";

interface Deps {
  read(id: string): DataAssetDoc | undefined;
  write(asset: DataAssetDoc): void;
  playing(): boolean;
  invalidate(): void;
}

/** Keep running model targets and their equipment catalog on the same generation.
 * A mixed appearance/stat edit waits as a whole; stats-only edits remain live.
 */
export function createDeferredAppearanceAssets(deps: Deps) {
  const held = new Map<string, DataAssetDoc>();
  return {
    /** Returns false for data types outside this presentation boundary. Invalid writes throw before queuing. */
    update(asset: DataAssetDoc): boolean {
      if (asset.type !== "item" && asset.type !== "creation") return false;
      const data = asset.type === "item" ? itemSchema.parse(asset.data) : characterCreationSchema.parse(asset.data);
      const next = { ...asset, data };
      const previous = deps.read(asset.id);
      const changed = JSON.stringify(previous?.data) !== JSON.stringify(data);
      const oldAppearance = (previous?.data as { appearance?: unknown } | undefined)?.appearance;
      const appearance = (data as { appearance?: unknown }).appearance;
      const presentation = asset.type === "creation" || JSON.stringify(oldAppearance) !== JSON.stringify(appearance);
      if (changed && presentation && deps.playing()) {
        held.set(asset.id, next); // last valid complete document wins, including mixed stat edits
        return true;
      }
      held.delete(asset.id); // a later save can explicitly revert a queued appearance change
      if (changed) {
        deps.write(next);
        if (presentation) deps.invalidate();
      }
      return true;
    },
    /** Apply all catalog/mount changes before a scene can rebuild against them. */
    flush(): void {
      if (held.size === 0) return;
      for (const [id, asset] of held) {
        deps.write(asset); // upsert: a newly authored item's first save may have been deferred
        held.delete(id);
      }
      deps.invalidate();
    },
  };
}

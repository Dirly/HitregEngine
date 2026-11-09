import type { AssetChange } from "./asset-changes.js";

/** One scoped index refresh per file-save burst, before any JSON in that burst reaches live state. */
export function prepareAssetChanges(prepare: () => Promise<void>, deliver: (change: AssetChange) => void, quietMs = 40) {
  const pending = new Map<string, AssetChange>();
  let timer: ReturnType<typeof setTimeout> | undefined, running: Promise<void> | null = null;
  const flush = (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (running) return running.then(() => pending.size ? flush() : undefined);
    if (!pending.size) return Promise.resolve();
    const batch = new Map(pending); pending.clear();
    running = (async () => {
      try { await prepare(); }
      catch (error) { for (const [key, change] of batch) if (!pending.has(key)) pending.set(key, change); throw error; }
      // A save that arrives during the index read belongs to the next refresh.
      // Skip its superseded old value, rather than deliver a new reference
      // that the already-in-flight index snapshot could not have discovered.
      for (const [key, change] of batch) if (!pending.has(key)) deliver(change);
    })().finally(() => { running = null; });
    return running.then(() => pending.size ? flush() : undefined);
  };
  return {
    push(change: AssetChange): void {
      pending.set(`${change.project ?? ""}/${change.file}`, change);
      if (!timer) timer = setTimeout(() => { timer = undefined; void flush().catch(error => console.warn("[live-sync] asset preparation failed; changes remain queued", error)); }, quietMs);
    },
    flush,
  };
}

export interface AssetChange {
  file: string;
  content: string | null;
  /** Missing only for older bridge clients; null is the flat asset tree. */
  project?: string | null;
}

/** Tell the bridge our closure before loading the library's large JSON files. */
export function subscribeAssetScope(scope: ReadonlySet<string> | null): void {
  if (!import.meta.hot) return;
  const subscribe = (): void => import.meta.hot!.send("hitreg:asset-scope", { projects: scope ? [...scope] : null });
  subscribe();
  import.meta.hot.on("vite:ws:connect", subscribe);
}

/** An agent editing another world's lab must never rebuild this page's world. */
export function acceptsAssetChange(change: AssetChange, scope: ReadonlySet<string> | null): boolean {
  // Scene discovery is global; the receiver already applies only the open
  // scene and its loaded subscenes. Other libraries belong to their closure.
  return change.file.startsWith("scenes/") || change.project == null || scope === null || scope.has(change.project);
}

/** Collapse a file-save burst into one expensive scene/thumbnail invalidation. */
export function coalesceAssetChanges(notify: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; notify(); }, 40);
  };
}

/**
 * Apply only the LAST of a burst of writes, once the writes stop for `quietMs` (or `maxWaitMs` after the first, so a
 * writer that never stops still lands). A world recipe edit re-streams the whole world (a multi-second main-thread
 * block per apply on a big world), and installer tools save the recipe several times a few seconds apart (p-perf
 * 2026-11-02: 7 saves in 37 s, one of them a torn half-written file) — each one was a full world reload in every
 * open editor.
 */
export function settleBurst<T>(apply: (value: T) => void, quietMs: number, maxWaitMs: number, now: () => number = Date.now): { push(value: T): void; flush(): void; pending(): boolean } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first = 0;
  let latest: { value: T } | null = null;
  const fire = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const held = latest;
    latest = null;
    if (held) apply(held.value);
  };
  return {
    push(value: T): void {
      if (!latest) first = now();
      latest = { value };
      if (timer !== undefined) clearTimeout(timer);
      const wait = Math.max(0, Math.min(quietMs, first + maxWaitMs - now()));
      timer = setTimeout(fire, wait);
    },
    flush: fire,
    pending: () => latest !== null,
  };
}

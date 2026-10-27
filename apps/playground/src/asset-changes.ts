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

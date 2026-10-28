/**
 * Keep three's generated shader states alive after their last render object goes.
 *
 * three's NodeManager caches one "builder state" (the generated WGSL, bindings,
 * update lists) per material × geometry layout × scene-state key, and DROPS it
 * the moment its last render object is disposed. Render objects are disposed
 * whenever their geometry or material is disposed (a prop pool, particle batch
 * or moving-instances page regrowing its instance buffers; a supercell part
 * replaced by its consolidation) and whenever the scene-state key changes (a
 * light entering or leaving the visible set, a shadow flag flipping): a key
 * that flips back one frame later finds the cache empty and regenerates every
 * shader again, 20-70 ms each on the main thread. Measured on a 1060-cell load:
 * 541 of 909 synchronous shader builds were REBUILDS of a state that had
 * already existed, 12.5 s of the 22 s spent building (docs/performance-lessons.md).
 *
 * Builder states that reach zero users stay in the cache instead and are only
 * dropped, oldest first, once more than `max` sit idle. A retained state costs a
 * few tens of KB (strings plus binding templates); 1024 of them is well under
 * the size of one texture page.
 */
export const RETAINED_BUILDER_STATES = 1024;

export interface BuilderStateLike {
  usedTimes: number;
}

export class BuilderStateRetention<K> {
  /** Keys whose state reached zero users, oldest first (Map insertion order). */
  private readonly idle = new Map<K, true>();

  constructor(
    private readonly cache: Map<K, BuilderStateLike>,
    private readonly max = RETAINED_BUILDER_STATES,
  ) {}

  /** A state under `key` just lost its last user: keep it, and drop the oldest idle states beyond the cap. */
  release(key: K): void {
    const state = this.cache.get(key);
    if (!state || state.usedTimes > 0) return;
    this.idle.delete(key);
    this.idle.set(key, true);
    while (this.idle.size > this.max) {
      const oldest = this.idle.keys().next().value as K;
      this.idle.delete(oldest);
      const old = this.cache.get(oldest);
      // a state picked up again since it went idle is in use: forget it was ever idle
      if (old && old.usedTimes === 0) this.cache.delete(oldest);
    }
  }

  /** States currently kept past their last user (reused ones are counted until they age out of the list). */
  get retained(): number {
    return this.idle.size;
  }
}

/** The NodeManager surface the retention hooks: `delete` evicts, `get` finds a render object's state. */
export interface NodeManagerLike<K> {
  nodeBuilderCache: Map<K, BuilderStateLike>;
  delete: (object: unknown) => unknown;
  get: (object: unknown) => { nodeBuilderState?: BuilderStateLike };
  getForRenderCacheKey: (renderObject: unknown) => K;
}

/**
 * Wrap `nodes.delete` so a render object's disposal never evicts its builder
 * state: three sees a state that still has a user, decrements it back, and the
 * retention takes over the moment the count really reaches zero.
 */
export function retainBuilderStates<K>(nodes: NodeManagerLike<K>, max = RETAINED_BUILDER_STATES): BuilderStateRetention<K> {
  const retention = new BuilderStateRetention<K>(nodes.nodeBuilderCache, max);
  const original = nodes.delete;
  nodes.delete = function (this: NodeManagerLike<K>, object: unknown) {
    const renderObject = object as { isRenderObject?: boolean } | null;
    if (!renderObject?.isRenderObject) return original.call(this, object);
    const state = this.get(object).nodeBuilderState;
    if (state === undefined || state.usedTimes !== 1) return original.call(this, object);
    state.usedTimes++; // three decrements to 1 and keeps the cache entry
    const result = original.call(this, object);
    state.usedTimes--;
    if (state.usedTimes === 0) retention.release(this.getForRenderCacheKey(object));
    return result;
  };
  return retention;
}

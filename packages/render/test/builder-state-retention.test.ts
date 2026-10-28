import { describe, expect, it } from "vitest";
import { BuilderStateRetention, retainBuilderStates, type BuilderStateLike } from "../src/builder-state-retention.js";

/** A stand-in for three's NodeManager: `delete` evicts a zero-user state exactly as the real one does. */
function fakeNodes() {
  const cache = new Map<string, BuilderStateLike>();
  const data = new Map<unknown, { nodeBuilderState?: BuilderStateLike }>();
  const nodes = {
    nodeBuilderCache: cache,
    get: (object: unknown) => {
      let entry = data.get(object);
      if (!entry) data.set(object, (entry = {}));
      return entry;
    },
    getForRenderCacheKey: (renderObject: unknown) => (renderObject as { key: string }).key,
    delete(object: unknown) {
      const state = this.get(object).nodeBuilderState;
      if (state) {
        state.usedTimes--;
        if (state.usedTimes === 0) cache.delete(this.getForRenderCacheKey(object));
      }
      data.delete(object);
      return true;
    },
    /** three's getForRender, reduced to the cache lookup. */
    acquire(object: { key: string }) {
      let state = cache.get(object.key);
      if (!state) cache.set(object.key, (state = { usedTimes: 0 }));
      state.usedTimes++;
      this.get(object).nodeBuilderState = state;
      return state;
    },
  };
  return nodes;
}

describe("builder state retention", () => {
  it("keeps a state whose last render object is disposed, so the next one finds it", () => {
    const nodes = fakeNodes();
    const retention = retainBuilderStates(nodes);
    const a = { key: "bark|layout1", isRenderObject: true };
    const state = nodes.acquire(a);
    nodes.delete(a);
    expect(nodes.nodeBuilderCache.get("bark|layout1")).toBe(state);
    expect(state.usedTimes).toBe(0);
    expect(retention.retained).toBe(1);
    const b = { key: "bark|layout1", isRenderObject: true };
    expect(nodes.acquire(b)).toBe(state); // a cache hit: no shader regenerated
    expect(state.usedTimes).toBe(1);
  });

  it("leaves a state with other users alone and still removes the render object's data", () => {
    const nodes = fakeNodes();
    retainBuilderStates(nodes);
    const a = { key: "k", isRenderObject: true };
    const b = { key: "k", isRenderObject: true };
    const state = nodes.acquire(a);
    nodes.acquire(b);
    nodes.delete(a);
    expect(state.usedTimes).toBe(1);
    expect(nodes.get(a).nodeBuilderState).toBeUndefined();
  });

  it("drops the oldest idle states past the cap and never one picked up again", () => {
    const cache = new Map<string, BuilderStateLike>();
    const retention = new BuilderStateRetention(cache, 2);
    for (const k of ["a", "b", "c"]) cache.set(k, { usedTimes: 0 });
    retention.release("a");
    retention.release("b");
    cache.get("a")!.usedTimes = 1; // "a" found a new user while idle
    retention.release("c"); // over the cap: the oldest idle entry is "a", in use again, so it is skipped, not dropped
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
    cache.set("d", { usedTimes: 0 });
    retention.release("d"); // idle list is b, c, d: "b" goes
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(retention.retained).toBe(2);
  });

  it("ignores a state that is not idle and objects that are not render objects", () => {
    const nodes = fakeNodes();
    const retention = retainBuilderStates(nodes);
    expect(nodes.delete({ plain: true })).toBe(true);
    const cache = nodes.nodeBuilderCache;
    cache.set("busy", { usedTimes: 3 });
    retention.release("busy");
    expect(retention.retained).toBe(0);
  });
});

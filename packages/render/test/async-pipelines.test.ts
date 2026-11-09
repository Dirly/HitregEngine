import { afterEach, describe, expect, it } from "vitest";
import { asyncPipelines, deferDrawPipelines, spreadShaderBuilds, type PipelineGate } from "../src/async-pipelines.js";

describe("deferDrawPipelines", () => {
  const setup = () => {
    const calls: (Promise<void>[] | null)[] = [];
    let finish: () => void = () => undefined;
    const backend = {
      pipelineUtils: {
        createRenderPipeline(_renderObject: never, promises: Promise<void>[] | null) {
          calls.push(promises);
          promises?.push(new Promise<void>((resolve) => { finish = resolve; }));
        },
      },
    };
    return { backend, calls, gate: deferDrawPipelines(backend), finish: () => finish() };
  };
  const draw = { object: {} } as never;
  const quad = { object: { isQuadMesh: true } } as never;

  afterEach(() => { asyncPipelines.enabled = true; });

  it("compiles a frame's draw off the GPU process's critical path and counts it until ready", async () => {
    const { backend, calls, gate, finish } = setup();
    gate.active = true;
    backend.pipelineUtils.createRenderPipeline(draw, null);
    expect(calls[0]).toBeInstanceOf(Array);
    expect(gate.pending).toBe(1);
    finish();
    await new Promise((resolve) => setTimeout(resolve));
    expect(gate.pending).toBe(0);
  });

  it("stays synchronous outside the frame, so a one-shot render never skips its draw", () => {
    const { backend, calls, gate } = setup();
    backend.pipelineUtils.createRenderPipeline(draw, null);
    expect(calls).toEqual([null]);
    expect(gate.pending).toBe(0);
  });

  it("never defers a fullscreen pass, and leaves compileAsync's own promises alone", () => {
    const { backend, calls, gate } = setup();
    gate.active = true;
    backend.pipelineUtils.createRenderPipeline(quad, null);
    expect(calls[0]).toBeNull();
    const own: Promise<void>[] = [];
    backend.pipelineUtils.createRenderPipeline(draw, own);
    expect(calls[1]).toBe(own);
    expect(gate.pending).toBe(0);
  });

  it("can be switched off for an A/B", () => {
    const { backend, calls, gate } = setup();
    gate.active = true;
    asyncPipelines.enabled = false;
    backend.pipelineUtils.createRenderPipeline(draw, null);
    expect(calls).toEqual([null]);
  });

  describe("spreadShaderBuilds", () => {
    const setup = () => {
      const gate: PipelineGate = { active: true, pending: 0, buildMs: 0, budgetMs: 8 };
      const data = new Map<unknown, { nodeBuilderState?: unknown }>();
      const ready = new Set<unknown>();
      const drawn: unknown[] = [];
      const asked: unknown[] = [];
      const cache = new Map<unknown, unknown>();
      const renderer = {
        _currentRenderContext: {},
        _objects: { get: (object: unknown) => object },
        _pipelines: { isReady: (mesh: { material: unknown }) => ready.has(mesh.material) },
        _nodes: {
          get: (ro: unknown) => { if (!data.has(ro)) data.set(ro, {}); return data.get(ro)!; },
          getForRender: (ro: unknown) => { data.get(ro)!.nodeBuilderState = {}; return ro; },
          getForRenderCacheKey: (ro: unknown) => (ro as { key?: string }).key,
          nodeBuilderCache: cache,
        },
        _renderObjectDirect(object: unknown, material?: unknown) { drawn.push(object); asked.push(material); },
      };
      spreadShaderBuilds(renderer as never, gate);
      return { gate, renderer, drawn, data, cache, ready, asked };
    };

    it("holds a mesh with no shader once the frame's budget is spent, and draws it on a later frame", () => {
      const { gate, renderer, drawn } = setup();
      const mesh = {};
      gate.buildMs = 8;
      renderer._renderObjectDirect(mesh);
      expect(drawn).toEqual([]);
      gate.buildMs = 0;
      renderer._renderObjectDirect(mesh);
      expect(drawn).toEqual([mesh]);
    });

    it("never holds a built mesh, one sharing a cached shader, or a fullscreen pass", () => {
      const { gate, renderer, drawn, data, cache } = setup();
      gate.buildMs = 8;
      const built = {}, shared = { key: "k" }, fullscreen = { isQuadMesh: true };
      data.set(built, { nodeBuilderState: {} });
      cache.set("k", {});
      for (const mesh of [built, shared, fullscreen]) renderer._renderObjectDirect(mesh);
      expect(drawn).toEqual([built, shared, fullscreen]);
    });

    it("keeps a mesh on its last material until a new one's pipeline is ready, so it never goes blank", () => {
      const { renderer, ready, asked } = setup();
      const shared = { name: "shared" }, own = { name: "own" };
      const mesh = { material: shared as unknown };
      ready.add(shared);
      renderer._renderObjectDirect(mesh, shared);
      mesh.material = own;
      asked.length = 0;
      renderer._renderObjectDirect(mesh, own);
      expect(asked).toEqual([own, shared]);
      ready.add(own);
      asked.length = 0;
      renderer._renderObjectDirect(mesh, own);
      renderer._renderObjectDirect(mesh, own);
      expect(asked).toEqual([own, own]);
    });

    it("stands in for a mesh held by the budget, but never for a shadow pass's override material", () => {
      const { gate, renderer, ready, asked } = setup();
      const shared = { name: "shared" }, own = { name: "own" }, depth = { name: "depth" };
      const mesh = { material: shared as unknown };
      ready.add(shared);
      renderer._renderObjectDirect(mesh, shared);
      mesh.material = own;
      gate.buildMs = 8;
      asked.length = 0;
      renderer._renderObjectDirect(mesh, own);
      expect(asked).toEqual([shared]);
      gate.buildMs = 0;
      asked.length = 0;
      renderer._renderObjectDirect(mesh, depth);
      expect(asked).toEqual([depth]);
    });

    it("leaves renders outside the frame alone, so a bake never loses a draw", () => {
      const { gate, renderer, drawn } = setup();
      gate.active = false;
      gate.buildMs = 100;
      renderer._renderObjectDirect({});
      expect(drawn).toHaveLength(1);
    });
  });

  it("does nothing on a backend without pipeline utils (WebGL)", () => {
    expect(deferDrawPipelines({}).pending).toBe(0);
  });
});

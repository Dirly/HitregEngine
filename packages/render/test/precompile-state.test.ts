import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { EngineRenderer, PRECOMPILE_SLICE_MS } from "../src/renderer.js";
import { retainBuilderStates } from "../src/builder-state-retention.js";

function fixture(compile: (root: THREE.Object3D) => Promise<void>) {
  // Exercise the real precompile path without requiring a GPU in unit tests.
  const engine = Object.create(EngineRenderer.prototype) as EngineRenderer;
  // Object.create skips the field initializers: give the queue its default slice budget by hand
  Object.assign(engine, { renderer: { compileAsync: compile }, postUnavailable: true, precompileSliceMs: PRECOMPILE_SLICE_MS, shaderBuildsQueued: 0,
    precompileStats: { borrowed: 0, plain: 0, objects: 0, fallbacks: 0, healed: 0 } });
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  const water = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ transparent: true }));
  root.add(mesh, water);
  return { engine, root, mesh, water };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Models Three's separate projection and async RenderObjects.get calls. */
function borrowedFixture() {
  const { engine, root } = fixture(async () => undefined);
  const scene = new THREE.Scene(), canvas = {}, idleContext = {};
  let target: unknown = canvas, mrt: unknown = null;
  let projectionContext: unknown = {};
  const cache = new Map<unknown, { usedTimes: number }>();
  const states = new Map<unknown, { nodeBuilderState?: { usedTimes: number } }>();
  const objects = new Map<unknown, ReturnType<typeof makeObject>>();
  function makeObject(context: unknown) {
    const object = { context, drawRange: null, group: null, isRenderObject: true, dispose: vi.fn() };
    object.dispose.mockImplementation(() => { renderer._nodes.delete(object); });
    return object;
  }
  const originalAsync = vi.fn(async (_object: unknown) => undefined);
  const renderer = {
    getRenderTarget: () => target,
    setRenderTarget: (value: unknown) => { target = value; },
    getMRT: () => mrt,
    setMRT: (value: unknown) => { mrt = value; },
    _currentRenderContext: idleContext as unknown,
    _renderContexts: { get: (_target?: unknown, _mrt?: unknown) => projectionContext },
    _objects: { get: () => objects.get(projectionContext)! },
    _nodes: {
      getForRender: vi.fn((_object: unknown) => undefined),
      getForRenderAsync: originalAsync,
      get: (object: unknown) => states.get(object) ?? {},
      getForRenderCacheKey: (object: unknown) => object,
      nodeBuilderCache: cache,
      delete(object: unknown) {
        const state = states.get(object)?.nodeBuilderState;
        if (state && --state.usedTimes === 0) cache.delete(object);
        states.delete(object);
      },
    },
    _createObjectPipeline: (..._args: unknown[]) => undefined,
    work: async (_object: ReturnType<typeof makeObject>) => undefined,
    compileAsync(group: THREE.Object3D, camera: THREE.Camera) {
      const context = this._renderContexts.get(this.getRenderTarget(), this.getMRT());
      this._currentRenderContext = context;
      const mesh = group.children[0] as THREE.Mesh;
      this._createObjectPipeline(mesh, mesh.material, scene, camera, null, null, null, "main");
      this._currentRenderContext = idleContext;
      return this.work(objects.get(context)!);
    },
  };
  // Three's original method lives on its prototype; the temporary own hook
  // is deleted after projection, exactly as on the real renderer.
  Object.setPrototypeOf(renderer, { _createObjectPipeline: renderer._createObjectPipeline });
  delete (renderer as { _createObjectPipeline?: unknown })._createObjectPipeline;
  const shader = renderer._nodes.getForRender;
  Object.assign(engine, { renderer, postUnavailable: false, plan: ["bloom"], pipeline: {}, pipelineScene: scene, chainRendered: true });
  function pass() {
    const context = {}, renderTarget = {}, mrtNode = {};
    projectionContext = context;
    const object = makeObject(context);
    objects.set(context, object);
    Object.assign(engine, { chain: { scenePass: { renderTarget, getMRT: () => mrtNode } } });
    return { context, renderTarget, mrtNode, object };
  }
  return { engine, root, scene, renderer, pass, makeObject, originalAsync, shader, cache, states, canvas, idleContext };
}

describe("background shader preparation", () => {
  it("shares the shader-build budget across concurrent precompiles and yields before the next build", async () => {
    const { engine } = fixture(async () => undefined);
    const queue = engine as unknown as { enqueueShaderBuild(build: () => unknown): Promise<unknown> };
    let time = 0, builds = 0;
    const frames: Array<() => void> = [];
    const clock = vi.spyOn(performance, "now").mockImplementation(() => time);
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { frames.push(fn); });
    try {
      const build = () => { builds++; time += 4; };
      const first = queue.enqueueShaderBuild(build), second = queue.enqueueShaderBuild(build), third = queue.enqueueShaderBuild(build);
      await Promise.all([first, second]);
      expect(builds).toBe(2);
      expect(frames).toHaveLength(1);
      frames[0]!();
      await third;
      expect(builds).toBe(3);
    } finally { clock.mockRestore(); vi.unstubAllGlobals(); }
  });

  it("defers shader generation until the async pass and borrows the scene target for that build", async () => {
    const scene = new THREE.Scene();
    const target = {}, mrt = {}, canvas = {};
    const renderObject = { context: {}, drawRange: null, group: null };
    let currentTarget: unknown = canvas, currentMrt: unknown = null;
    const shader = vi.fn(() => {
      expect(currentTarget).toBe(target);
      expect(currentMrt).toBe(mrt);
    });
    const renderer = {
      getRenderTarget: () => currentTarget,
      setRenderTarget: (value: unknown) => { currentTarget = value; },
      getMRT: () => currentMrt,
      setMRT: (value: unknown) => { currentMrt = value; },
      _renderContexts: { get: (_target?: unknown, _mrt?: unknown) => renderObject.context },
      _currentRenderContext: null as unknown,
      _objects: { get: () => renderObject },
      _nodes: { getForRender: shader, getForRenderAsync: async () => undefined },
      _createObjectPipeline: (..._args: unknown[]) => undefined,
      compileAsync(root: THREE.Object3D, camera: THREE.Camera) {
        this._currentRenderContext = this._renderContexts.get(this.getRenderTarget(), this.getMRT());
        const mesh = root.children[0] as THREE.Mesh;
        this._createObjectPipeline(mesh, mesh.material, scene, camera, null, null, null, "main");
        expect(shader).not.toHaveBeenCalled();
        this._currentRenderContext = null;
        return Promise.resolve().then(() => this._nodes.getForRenderAsync(renderObject as never));
      },
    };
    const { engine, root } = fixture(async () => undefined);
    Object.assign(engine, { renderer, postUnavailable: false, plan: ["bloom"], pipeline: {}, pipelineScene: scene,
      chainRendered: true, chain: { scenePass: { renderTarget: target, getMRT: () => mrt } } });
    await engine.precompileGroup(root, new THREE.Camera(), scene);
    expect(shader).toHaveBeenCalledOnce();
    expect(currentTarget).toBe(canvas);
    expect(currentMrt).toBeNull();
  });

  it("restores draw visibility and frustum culling before waiting on GPU compilation", async () => {
    let finish!: () => void;
    const gpu = new Promise<void>((resolve) => { finish = resolve; });
    const compile = vi.fn((root: THREE.Object3D) => {
      expect(root.children[0]!.frustumCulled).toBe(false);
      expect(root.children[1]!.visible).toBe(false);
      return gpu;
    });
    const { engine, root, mesh, water } = fixture(compile);
    const pending = engine.precompileGroup(root, new THREE.Camera(), new THREE.Scene());
    expect(compile).toHaveBeenCalledOnce();
    expect(mesh.frustumCulled).toBe(true);
    expect(water.visible).toBe(true);
    finish();
    await pending;
  });

  it("restores state when the synchronous projection throws", async () => {
    const { engine, root, mesh, water } = fixture(() => { throw new Error("projection failed"); });
    await expect(engine.precompileGroup(root, new THREE.Camera(), new THREE.Scene())).rejects.toThrow("projection failed");
    expect(mesh.frustumCulled).toBe(true);
    expect(water.visible).toBe(true);
  });

  it("cancels queued work for a retired pass without unborrowed builds or warnings", async () => {
    const f = borrowedFixture(), first = f.pass(), start = deferred();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    f.renderer.work = async (object) => { await start.promise; await f.renderer._nodes.getForRenderAsync(object); };
    const old = f.engine.precompileGroup(f.root, new THREE.Camera(), f.scene);
    const current = f.pass();
    f.renderer.work = async (object) => { await f.renderer._nodes.getForRenderAsync(object); };
    f.shader.mockImplementation((object) => {
      expect(object).toBe(current.object);
      expect(f.renderer.getRenderTarget()).toBe(current.renderTarget);
      expect(f.renderer.getMRT()).toBe(current.mrtNode);
      expect(f.renderer._currentRenderContext).toBe(current.context);
    });
    try {
      const live = f.engine.precompileGroup(f.root, new THREE.Camera(), f.scene);
      start.resolve();
      await Promise.all([old, live]);
      expect(f.originalAsync).not.toHaveBeenCalled();
      expect(f.shader).toHaveBeenCalledOnce();
      expect(first.object.dispose).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
      expect(f.engine.shaderBuildsPending).toBe(0);
      expect(f.renderer.getRenderTarget()).toBe(f.canvas);
      expect(f.renderer.getMRT()).toBeNull();
    } finally { warning.mockRestore(); }
  });

  it("heals the async replacement and evicts its malformed retained shader state", async () => {
    const f = borrowedFixture(), pass = f.pass(), replacement = f.makeObject(pass.context);
    const badState = { usedTimes: 1 }, pipeline = {};
    f.cache.set(replacement, badState);
    f.states.set(replacement, { nodeBuilderState: badState });
    retainBuilderStates(f.renderer._nodes);
    Object.assign(f.renderer, { _pipelines: { get: (object: unknown) => object === replacement ? { pipeline } : {} },
      backend: { get: () => ({ error: true }) } });
    f.renderer.work = async () => { await f.renderer._nodes.getForRenderAsync(replacement); };
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await f.engine.precompileGroup(f.root, new THREE.Camera(), f.scene);
      expect(pass.object.dispose).not.toHaveBeenCalled();
      expect(replacement.dispose).toHaveBeenCalledOnce();
      expect(f.cache.has(replacement)).toBe(false);
      expect(f.engine.precompileStats.healed).toBe(1);
    } finally { info.mockRestore(); }
  });

  it("keeps a shared context guarded until every concurrent compile has finished", async () => {
    const f = borrowedFixture(), pass = f.pass(), later = deferred();
    f.renderer.work = async (object) => { await f.renderer._nodes.getForRenderAsync(object); };
    const first = f.engine.precompileGroup(f.root, new THREE.Camera(), f.scene);
    f.renderer.work = async (object) => { await later.promise; await f.renderer._nodes.getForRenderAsync(object); };
    const second = f.engine.precompileGroup(f.root, new THREE.Camera(), f.scene);
    await first;
    f.shader.mockImplementation(() => {
      expect(f.renderer.getRenderTarget()).toBe(pass.renderTarget);
      expect(f.renderer.getMRT()).toBe(pass.mrtNode);
    });
    later.resolve();
    await second;
    expect(f.originalAsync).not.toHaveBeenCalled();
    expect(f.shader).toHaveBeenCalledTimes(2);
    expect(f.renderer.getRenderTarget()).toBe(f.canvas);
    expect(f.renderer.getMRT()).toBeNull();
  });

  it("preserves a newer cache entry when healing an older failed shader", async () => {
    const f = borrowedFixture(), pass = f.pass(), oldState = { usedTimes: 1 }, newerState = { usedTimes: 1 };
    const pipeline = {};
    f.states.set(pass.object, { nodeBuilderState: oldState });
    f.cache.set(pass.object, newerState);
    // The original delete can retire the old state without owning the newer key.
    pass.object.dispose.mockImplementation(() => undefined);
    Object.assign(f.renderer, { _pipelines: { get: () => ({ pipeline }) }, backend: { get: () => ({ error: true }) } });
    f.renderer.work = async (object) => { await f.renderer._nodes.getForRenderAsync(object); };
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await f.engine.precompileGroup(f.root, new THREE.Camera(), f.scene);
      expect(f.cache.get(pass.object)).toBe(newerState);
      expect(pass.object.dispose).toHaveBeenCalledOnce();
    } finally { info.mockRestore(); }
  });

  it("restores target, MRT and current context when a guarded async build throws", async () => {
    const f = borrowedFixture();
    f.pass();
    f.renderer.work = async (object) => { await f.renderer._nodes.getForRenderAsync(object); };
    f.shader.mockImplementation(() => { throw new Error("shader failed"); });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await f.engine.precompileGroup(f.root, new THREE.Camera(), f.scene);
      expect(f.renderer.getRenderTarget()).toBe(f.canvas);
      expect(f.renderer.getMRT()).toBeNull();
      expect(f.renderer._currentRenderContext).toBe(f.idleContext);
      expect(f.engine.shaderBuildsPending).toBe(0);
      expect(warning).toHaveBeenCalledOnce();
    } finally { warning.mockRestore(); }
  });

});

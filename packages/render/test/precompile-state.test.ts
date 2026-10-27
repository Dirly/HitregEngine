import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { EngineRenderer } from "../src/renderer.js";

function fixture(compile: (root: THREE.Object3D) => Promise<void>) {
  // Exercise the real precompile path without requiring a GPU in unit tests.
  const engine = Object.create(EngineRenderer.prototype) as EngineRenderer;
  Object.assign(engine, { renderer: { compileAsync: compile }, postUnavailable: true,
    precompileStats: { borrowed: 0, plain: 0, objects: 0, fallbacks: 0, healed: 0 } });
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  const water = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ transparent: true }));
  root.add(mesh, water);
  return { engine, root, mesh, water };
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
});

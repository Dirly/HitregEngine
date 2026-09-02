import * as THREE from "three/webgpu";
import {
  PostChain,
  needsPipeline,
  pixelateRatio,
  nextPassToBlame,
  passPlan,
  pipelineSignature,
  resolvePostFx,
  toneMappingConstant,
  type PostFxData,
  type PostPassId,
  type PostTextureResolver,
  type ResolvedPostFx,
} from "./post.js";
import { volumetricPlanKey, type VolumetricRequest } from "./atmosphere.js";
import { sceneLighting, type SceneLighting } from "./scene-lighting.js";

/**
 * Three's `_callDepth` while the post chain's scene pass renders when
 * `EngineRenderer.render()` is the outermost render: the quad render is depth
 * 0 and the scene pass runs nested inside it. Part of the RenderContext key —
 * see `compileInSceneContext`, which measures the real value each frame
 * because a host that itself renders from inside a `render()` (the editor's
 * docked viewport) pushes the whole chain one level deeper.
 */
const SCENE_PASS_CALL_DEPTH = 1;

/**
 * The slice of `WebGPURenderer`'s private surface `compileInSceneContext`
 * leans on (three r185). Every member is feature-checked before use; if a
 * future three renames one, the precompile silently degrades to plain
 * `compileAsync` (correct, just compiling for a context nothing draws in —
 * the probe in tools/perf-probe.mjs shows that as codegen during rotation).
 */
interface RenderObjectLike {
  drawRange: unknown;
  group: unknown;
  dispose(): void;
}
interface RendererInternals {
  _renderContexts?: { get: (rt: unknown, mrt: unknown, depth?: number) => unknown };
  _createObjectPipeline?: (...args: unknown[]) => void;
  _objects?: { get: (...args: unknown[]) => RenderObjectLike };
  _nodes?: { getForRender: (renderObject: unknown) => unknown };
  _pipelines?: { get: (renderObject: unknown) => { pipeline?: unknown } | undefined };
  _currentRenderContext?: unknown;
  backend?: { get: (object: unknown) => { error?: boolean } | undefined };
}

/**
 * The two halves of a render, so a profile can tell them apart.
 *
 * The engine's own profiler has twice now billed a whole class of bug to one
 * opaque `render` scope — the light-budget shader-recompile trap (see
 * light-budget.ts) and, before it, per-chunk pipeline rebuilds. "render is
 * 22ms" is not a finding; "the scene's own per-frame lighting work is 0.2ms of
 * it and the draw is the other 22" is. The renderer takes a sink rather than a
 * Profiler so packages/render keeps no dependency on the app's profiler.
 */
export interface RenderScopeSink {
  begin(name: string): void;
  end(): void;
}

export type Backend = "webgpu" | "webgl";

export interface BloomOptions {
  strength: number;
  /** BloomNode requires [0, 1]. */
  radius: number;
  threshold: number;
}

/**
 * WebGPURenderer wrapper. Three's WebGPURenderer falls back to WebGL2 on its
 * own when WebGPU is unavailable; init() reports which backend won.
 *
 * Post-processing: setPostFx() drives a TSL RenderPipeline assembled from the
 * scene's `postfx` component (see post.ts for the pass order and why it is what
 * it is). The pipeline is built lazily on the next render() and rebuilt
 * whenever the scene or camera identity changes (the playground swaps cameras
 * between edit fly-cam and play rigs) or whenever the *set* of enabled passes
 * changes. A parameter tweak retunes uniforms in place — a rebuild recompiles
 * shaders, and doing that per slider frame would blow the interactivity budget.
 *
 * A scene with no postfx (or postfx with nothing but tone mapping) builds no
 * pipeline at all and renders through renderer.render() exactly as before.
 */
export class EngineRenderer {
  readonly renderer: THREE.WebGPURenderer;

  private postFxData: PostFxData | null = null;
  private fx: ResolvedPostFx = resolvePostFx(null);
  private plan: PostPassId[] = [];
  private signature = "";
  private resolveTexture: PostTextureResolver | null = null;
  /**
   * Whether the current `grade.lut` id actually decoded into a 3D texture. Only
   * the chain can answer that, so it is learned from the last build and fed
   * back into the signature — otherwise an unresolvable LUT id makes every
   * setPostFx() call look like a structural change and rebuild forever.
   */
  private lutState: { id: string | undefined; ready: boolean } = { id: undefined, ready: false };

  /**
   * Shafts the scene wants this frame, read off the scene's SceneLighting in
   * render(). It lives here rather than in `postFxData` because it is driven by
   * the `sky` component, and because the *set* of shaft lights is discovered at
   * runtime (a light has no shadow map until its first shadow render).
   */
  private volumetric: VolumetricRequest | null = null;
  private volumetricKey = volumetricPlanKey(null);

  /** What the host last asked for in setSize(); re-applied when pixelate changes. */
  private viewport: { width: number; height: number; pixelRatio: number } | null = null;
  /** The pixelate settings the canvas currently reflects (see applySize). */
  private pixelateKey = "";

  private pipeline: THREE.RenderPipeline | null = null;
  private chain: PostChain | null = null;
  private pipelineScene: THREE.Scene | null = null;
  private pipelineCamera: THREE.Camera | null = null;

  /**
   * Passes retired because the graph threw on this backend. Per-pass rather
   * than one global flag: an unsupported effect should cost you that effect,
   * not the whole stack. Sticky for the renderer's lifetime — a pass that
   * failed once will fail again, and retrying it every rebuild would turn a
   * degraded frame into a stuttering one.
   */
  private readonly failedPasses = new Set<PostPassId>();
  /** Set only when every optional pass has been retired and it still throws. */
  private postUnavailable = false;

  /** Render sub-scope reporting: off unless the app wires a profiler in. */
  private scopes: RenderScopeSink | null = null;
  /** GPU timestamp queries: off unless the profiler asks for them (see setGpuTiming). */
  private gpuTiming = false;
  private gpuResolvePending = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.applyPostFxState();
  }

  async init(): Promise<Backend> {
    await this.renderer.init();
    const backend = this.renderer.backend as { isWebGPUBackend?: boolean };
    return backend.isWebGPUBackend ? "webgpu" : "webgl";
  }

  /**
   * Size the drawing surface. `width`/`height` are CSS pixels; `pixelRatio` is
   * the host's cap (usually min(devicePixelRatio, 1)). A `postfx.pixelate`
   * setting lowers the ratio below that so the frame renders at a fixed line
   * count and the canvas scales it up — see {@link pixelateRatio}.
   */
  setSize(width: number, height: number, pixelRatio = 1): void {
    this.viewport = { width, height, pixelRatio };
    this.applySize();
  }

  private applySize(): void {
    const viewport = this.viewport;
    if (!viewport) return;
    const { pixelate } = this.fx;
    const ratio = pixelateRatio(this.fx, viewport.height, viewport.pixelRatio);
    this.renderer.setPixelRatio(ratio);
    // updateStyle=false: the host app owns canvas CSS (docked editor layout)
    this.renderer.setSize(viewport.width, viewport.height, false);
    // The upscale is the browser's, so its filter is a CSS property on the
    // canvas — the one style the host does NOT own, because it is the look.
    const canvas = this.renderer.domElement as HTMLCanvasElement | undefined;
    if (canvas && canvas.style) {
      canvas.style.imageRendering = pixelate.enabled && pixelate.filter === "nearest" ? "pixelated" : "";
    }
    this.pixelateKey = `${pixelate.enabled}:${pixelate.height}:${pixelate.filter}`;
  }

  /**
   * Hardware anisotropic filtering cap. Feed into `texture.anisotropy` so
   * ground/road textures viewed at a shallow angle into the distance stay
   * sharp — mipmapping alone (on by default) only fixes head-on minification,
   * not the oblique-angle blur a receding road or floor gets. Only valid
   * after init() resolves (backend must exist).
   */
  getMaxAnisotropy(): number {
    return this.renderer.getMaxAnisotropy();
  }

  /**
   * Turn GPU timestamp queries on/off; returns whether they're actually
   * active. Returns false when the backend can't do it (no
   * EXT_disjoint_timer_query_webgl2 on the WebGL fallback, no `timestamp-query`
   * feature on the device).
   *
   * Why this is toggled rather than always on: timestamp queries cost a query
   * pair plus a buffer copy/map per pass, every frame — real but not free, and
   * a pool that is never resolved fills up and starts warning. So it's off
   * until someone opens the profiler, and resolved every frame while it is.
   *
   * Why it's worth having at all: JS-side scope timing cannot tell "the GPU is
   * the bottleneck" from "the main thread is". Those two have opposite fixes —
   * cutting draw calls does nothing to a fill-rate-bound frame, and dropping
   * resolution does nothing to a script-bound one — and without a GPU number
   * you are guessing which one you have.
   */
  setGpuTiming(on: boolean): boolean {
    // Three fixes backend.trackTimestamp at init() (WebGPU ANDs it with device
    // feature support), but the device is always requested WITH every feature
    // the adapter offers, so flipping the flag afterwards is safe and lets the
    // toggle work without a page reload.
    const backend = this.renderer.backend as unknown as {
      trackTimestamp?: boolean;
      disjoint?: unknown;
      isWebGPUBackend?: boolean;
      hasFeature?: (name: string) => boolean;
    };
    if (on) {
      const supported = backend.isWebGPUBackend
        ? (backend.hasFeature?.("timestamp-query") ?? false)
        : Boolean(backend.disjoint);
      if (!supported) {
        this.gpuTiming = false;
        return false;
      }
    }
    backend.trackTimestamp = on;
    this.gpuTiming = on;
    return on;
  }

  get gpuTimingActive(): boolean {
    return this.gpuTiming;
  }

  /**
   * Last resolved GPU frame time in ms, or null while timing is off/unresolved.
   * Kicks off the next resolve without blocking: timestamps land a frame or
   * two late by nature, and awaiting them inside the frame loop would trade
   * the thing being measured for the measurement.
   */
  gpuFrameMs(): number | null {
    if (!this.gpuTiming) return null;
    if (!this.gpuResolvePending) {
      this.gpuResolvePending = true;
      void this.renderer
        .resolveTimestampsAsync(THREE.TimestampQuery.RENDER)
        .catch(() => undefined)
        .finally(() => {
          this.gpuResolvePending = false;
        });
    }
    const timestamp = this.renderer.info.render.timestamp;
    return typeof timestamp === "number" && timestamp > 0 ? timestamp : null;
  }

  /**
   * The whole `postfx` component payload (null = none on this scene). Missing
   * fields take their schema defaults, so `{}` means "ACES at exposure 1 and
   * nothing else" — i.e. exactly what this renderer did before the stack
   * existed.
   *
   * Structural changes (a pass enabled/disabled, a tone-mapping mode, a LUT)
   * queue a rebuild on the next render; everything else is written straight
   * into the live uniforms.
   */
  setPostFx(data: PostFxData | null): void {
    this.postFxData = data;
    this.applyPostFxState();
  }

  /**
   * Resolve `postfx.grade.lut` texture ids. The renderer has no asset table of
   * its own, so without this the numeric grade knobs still apply and the LUT is
   * skipped with a warning.
   */
  setPostFxTextureResolver(resolve: PostTextureResolver | null): void {
    this.resolveTexture = resolve;
    // a resolver arriving late can turn an inert LUT into a real pass
    this.applyPostFxState();
  }

  /** The passes actually in the graph right now, in execution order. */
  postFxPlan(): readonly PostPassId[] {
    return this.plan;
  }

  /** Passes retired by graceful degradation on this backend. */
  postFxDegraded(): readonly PostPassId[] {
    return [...this.failedPasses];
  }

  /**
   * Enable/retune bloom (null disables). Retained shim over setPostFx() so
   * existing callers keep working; it merges into whatever postfx is otherwise
   * set rather than replacing it.
   */
  setBloom(options: BloomOptions | null): void {
    const next: PostFxData = { ...(this.postFxData ?? {}) };
    next.bloom = options ? { enabled: true, ...options } : { ...(next.bloom ?? {}), enabled: false };
    this.setPostFx(next);
  }

  /**
   * Fold in this frame's volumetric request. A changed shaft SET is structural
   * (the node graph references specific lights) and rebuilds; a changed
   * intensity/samples/decay/density is a uniform write. Splitting the two is
   * what keeps a slider drag off the shader compiler.
   */
  private syncVolumetric(request: VolumetricRequest | null): void {
    const key = volumetricPlanKey(request);
    this.volumetric = request;
    if (key !== this.volumetricKey) {
      this.volumetricKey = key;
      this.applyPostFxState();
    } else if (request) {
      this.chain?.retune(this.fx, request.settings);
    }
  }

  private applyPostFxState(): void {
    this.fx = resolvePostFx(this.postFxData);
    // pixelate is not a pass — it is the backing-store size — so it is applied
    // here and never enters the pipeline signature
    const { pixelate } = this.fx;
    if (this.viewport && `${pixelate.enabled}:${pixelate.height}:${pixelate.filter}` !== this.pixelateKey) this.applySize();
    // Tone mapping stays on the renderer as well as in the graph: it is what
    // the no-pipeline path uses, and `toneMappingExposure` is a renderer
    // reference that the graph's own tone-mapping node reads — which is why
    // exposure is a live retune and not a rebuild.
    this.renderer.toneMapping = toneMappingConstant(this.fx);
    this.renderer.toneMappingExposure = this.fx.tonemap.exposure;

    const lutReady =
      this.fx.grade.lut === this.lutState.id ? this.lutState.ready : this.resolveTexture !== null;
    const ctx = { disabled: this.failedPasses, lutReady, volumetric: this.volumetric };
    this.plan = passPlan(this.fx, ctx);
    const signature = pipelineSignature(this.fx, ctx);
    if (signature !== this.signature) {
      this.signature = signature;
      // rebuilt lazily on the next render(), so a burst of edits in one frame
      // costs one rebuild rather than one per edit
      this.disposePipeline();
    } else {
      this.chain?.retune(this.fx, this.volumetric?.settings ?? null);
    }
  }

  /**
   * Build every render pipeline a scene will need, now, instead of paying for
   * each one the first time its object happens to come on screen.
   *
   * WebGPU compiles a pipeline per material/geometry pair on first DRAW, and
   * three generates the shader (a node-builder run, ~60ms of main-thread JS
   * for a lit, shadowed material) on the same frame. In a level you fly
   * around that lands as a stall every time you turn somewhere new. Paying it
   * at load turns a permanent stutter into a slightly longer scene open.
   *
   * Awaiting is optional: the frame loop is free to run while this resolves.
   * See {@link precompileGroup} for the context rules this has to follow.
   */
  async precompile(scene: THREE.Scene, camera: THREE.Camera): Promise<void> {
    await this.compileInSceneContext(scene, camera, scene);
  }

  /**
   * Compile one newly-streamed SUBTREE's pipelines, in the background.
   *
   * `precompile` above solves this for a scene at load. Streamed content gets
   * no such pass, so every chunk that arrives later would still compile its
   * pipelines on first DRAW — "first draw" being whenever the player happens
   * to TURN far enough to see it.
   *
   * NOT awaited by callers, deliberately. Gating a cell's `scene.add()` on
   * its shaders was tried and reverted twice: streamed terrain's collider is
   * cooked from the built objects, so delaying the add delays the ground and
   * the player falls through the world. Adding first and compiling after
   * costs nothing on the critical path — the group is already visible and
   * collidable — and three's `compileAsync` builds the shader with yields
   * between stages and creates the GPU pipeline with
   * `createRenderPipelineAsync`, so neither the codegen nor the driver
   * compile blocks a frame; the cell simply draws once its pipeline is ready.
   *
   * ## The context rule (why this was measured as useless once)
   *
   * Three keys every compiled shader on the RenderContext it was built for,
   * and a RenderContext is keyed by render-target attachment state, MRT node
   * and NESTING DEPTH. The post-processing chain draws the scene INSIDE its
   * quad render — into the scene pass's MRT target, at depth 1 — while a bare
   * `compileAsync` compiles for the canvas at depth 0. Those states never
   * matched, so the first version of this compiled ~10 shaders per scene
   * that were never used and the real ones still compiled on first draw
   * (measured: 57 shader builds in one rotation with precompile "on").
   * Borrowing the scene pass's target and MRT node fixes two of the three
   * keys; the depth is forced through `_renderContexts.get` for the
   * synchronous prologue of `compileAsync` (the only part that resolves a
   * context). With no post chain the scene draws at depth 0 into the
   * framebuffer target, which is exactly what `compileAsync` assumes, so
   * nothing needs borrowing.
   *
   * Shadow-pass shaders are not covered (they build inside the light's
   * shadow render); they are an order of magnitude cheaper.
   */
  async precompileGroup(
    group: THREE.Object3D,
    camera: THREE.Camera,
    targetScene: THREE.Scene,
  ): Promise<void> {
    await this.compileInSceneContext(group, camera, targetScene);
  }

  /**
   * How precompiles have run so far — for probes and bug reports. `borrowed`
   * compiled in the scene pass's context, `plain` had no post chain to
   * borrow from, `objects` is how many render objects were handed to the
   * synchronous shader build, `fallbacks` how many of those threw.
   */
  readonly precompileStats = { borrowed: 0, plain: 0, objects: 0, fallbacks: 0, healed: 0 };
  /** Measured in render(): the nesting depth the scene pass actually draws at. */
  private scenePassCallDepth = SCENE_PASS_CALL_DEPTH;
  /** False until the current post chain has drawn a frame (see below). */
  private chainRendered = false;
  /** Precompiles waiting for the chain's first frame. */
  private renderWaiters: Array<() => void> = [];

  private async compileInSceneContext(
    root: THREE.Object3D,
    camera: THREE.Camera,
    targetScene: THREE.Scene,
  ): Promise<void> {
    const renderer = this.renderer;
    const internals = renderer as unknown as RendererInternals;
    const wantsChain = !this.postUnavailable && needsPipeline(this.plan);
    // A load-time precompile usually runs before the first frame, i.e. before
    // render() has built the post chain whose context we need to borrow.
    // Build it here on the same terms render() would (it rebuilds again only
    // if the render camera differs).
    if (wantsChain && (!this.pipeline || !this.chain || this.pipelineScene !== targetScene)) {
      try {
        this.buildPipeline(targetScene, camera);
      } catch {
        // render() owns the failure path (it retires the pass and reports)
      }
    }
    // The scene pass finishes configuring its render target (MSAA sample
    // count, lazily added MRT textures) on its first frame, and that state is
    // part of the RenderContext key. A whole-scene precompile at load runs
    // before that frame, so it would compile for a context the pass never
    // draws in — wait for the chain to render once. Streamed groups arrive
    // long after and pass straight through.
    if (wantsChain && this.chain && !this.chainRendered) {
      await new Promise<void>((resolve) => this.renderWaiters.push(resolve));
    }
    // compileAsync runs the normal projection pass, which frustum-culls — and
    // a just-streamed cell is usually off-screen, which is the entire case
    // being solved here. Clear culling for the pass, restore it after.
    const restore: THREE.Object3D[] = [];
    root.traverse((object) => {
      if (!(object as THREE.Mesh).isMesh) return;
      if (object.frustumCulled === false) return;
      object.frustumCulled = false;
      restore.push(object);
    });
    const scenePass =
      !this.postUnavailable && needsPipeline(this.plan) && this.chain && this.pipelineScene === targetScene
        ? this.chain.scenePass
        : null;
    const contexts = internals._renderContexts;
    const originalCreate = internals._createObjectPipeline;
    /** Every render object the synchronous shader build touched — see the heal below. */
    const handed: RenderObjectLike[] = [];
    let undo: () => void = () => undefined;
    if (
      scenePass !== null &&
      contexts !== undefined &&
      typeof contexts.get === "function" &&
      typeof originalCreate === "function" &&
      internals._objects !== undefined &&
      internals._nodes !== undefined
    ) {
      this.precompileStats.borrowed += 1;
      const stats = this.precompileStats;
      const previousTarget = renderer.getRenderTarget();
      const previousMrt = renderer.getMRT();
      const originalGet = contexts.get;
      renderer.setRenderTarget(scenePass.renderTarget);
      renderer.setMRT(scenePass.getMRT());
      const depth = this.scenePassCallDepth;
      contexts.get = function (rt: unknown, mrt: unknown) {
        return originalGet.call(this, rt, mrt, depth);
      };
      // Shader CODE is generated by three from live renderer state — it reads
      // getRenderTarget()/getMRT()/isOutputTarget while building — and
      // compileAsync generates it in a later task, after the frame loop has
      // put the canvas back. Built then, the fragment shader has one output
      // where the scene pass's MRT target has several, and every pipeline
      // fails with "Color target has no corresponding fragment stage output".
      // So generate it HERE, inside the borrowed window, for each object the
      // projection pass hands over; compileAsync's own pass then finds the
      // state cached and only has the (async) GPU pipeline left to build. The
      // synchronous cost is one build per genuinely new material variant —
      // rare once batches share shaders (see instancing.ts).
      internals._createObjectPipeline = function (this: RendererInternals, ...args) {
        originalCreate.apply(this, args);
        const [object, material, scene, camera, lightsNode, group, clippingContext, passId] = args;
        try {
          const renderObject = this._objects!.get(
            object, material, scene, camera, lightsNode, this._currentRenderContext, clippingContext, passId,
          );
          renderObject.drawRange = (object as THREE.Mesh).geometry.drawRange;
          renderObject.group = group;
          this._nodes!.getForRender(renderObject);
          handed.push(renderObject);
          stats.objects += 1;
        } catch (error) {
          // compileAsync's own pass is the fallback; it just builds later
          stats.fallbacks += 1;
          if (stats.fallbacks === 1) console.warn("[render] precompile: synchronous shader build failed, deferring:", error);
        }
      };
      undo = () => {
        delete internals._createObjectPipeline;
        contexts.get = originalGet;
        renderer.setRenderTarget(previousTarget);
        renderer.setMRT(previousMrt);
      };
    }
    if (!scenePass) this.precompileStats.plain += 1;
    let pending: Promise<void>;
    try {
      // compileAsync resolves its RenderContext and projects the subtree
      // synchronously, before its first await — the borrowed state only has
      // to hold for that prologue, and must be undone before the frame loop
      // renders again.
      pending = renderer.compileAsync(root, camera, targetScene);
    } finally {
      undo();
    }
    try {
      await pending;
    } catch (error) {
      // an optimisation, never a correctness requirement
      console.warn("[render] pipeline precompile failed:", error);
    } finally {
      for (const object of restore) object.frustumCulled = true;
    }
    // A pipeline that fails validation off-frame stays null in three's cache
    // and the object is then never drawn in this context — a silent hole, not
    // a warning. Materials that read the viewport (the water's depth-based
    // foam, soft particles) can trip this because their bindings depend on a
    // render being in progress. Drop those render objects entirely so the next
    // real frame rebuilds them exactly as it would have without a precompile.
    const pipelines = internals._pipelines;
    const backend = internals.backend;
    if (handed.length > 0 && pipelines && typeof pipelines.get === "function" && backend && typeof backend.get === "function") {
      let healed = 0;
      for (const renderObject of handed) {
        const pipeline = pipelines.get(renderObject)?.pipeline;
        if (!pipeline) continue;
        if (backend.get(pipeline)?.error === true) {
          renderObject.dispose();
          healed += 1;
        }
      }
      if (healed > 0) {
        this.precompileStats.healed += healed;
        // three has already logged one error per pipeline above this line;
        // this is the "and nothing is broken" that those lines lack
        console.info(`[render] precompile: ${healed} pipeline(s) failed validation off-frame and will build on first draw instead`);
      }
    }
  }

  /** Report render sub-scopes to a profiler. Pass null to stop reporting. */
  setScopeSink(sink: RenderScopeSink | null): void {
    this.scopes = sink;
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const scopes = this.scopes;
    scopes?.begin("lighting");
    // Cascade refits, the shared IBL seam and the volumetric light query all
    // key off the render camera and off WHICH scene is actually being drawn,
    // neither of which the builder knows — so the state buildScene() attached
    // to the scene is driven from this one call. A scene with no SceneLighting
    // (a hand-made THREE.Scene) is unaffected and costs nothing.
    const lighting: SceneLighting | null = sceneLighting(scene);
    if (lighting) {
      lighting.frame(camera);
      this.syncVolumetric(lighting.volumetricRequest());
    } else if (this.volumetric) {
      this.syncVolumetric(null);
    }
    scopes?.end();

    if (!this.postUnavailable && needsPipeline(this.plan)) {
      try {
        if (
          !this.pipeline ||
          !this.chain ||
          scene !== this.pipelineScene ||
          camera !== this.pipelineCamera
        ) {
          // a rebuild recompiles every pass's shader: worth its own scope, or
          // it reads as a mysterious once-per-camera-swap render spike
          scopes?.begin("postfx-build");
          try {
            this.buildPipeline(scene, camera);
          } finally {
            scopes?.end();
          }
        }
        scopes?.begin("postfx-update");
        try {
          this.chain!.update();
        } finally {
          scopes?.end();
        }
        scopes?.begin("draw");
        try {
          // The scene pass renders two levels below wherever we are now (the
          // quad render, then the pass nested in it) — recorded for
          // compileInSceneContext, which must key its compiles the same way.
          const internals = this.renderer as unknown as { _callDepth?: number };
          this.scenePassCallDepth = (internals._callDepth ?? -1) + 2;
          this.pipeline!.render();
        } finally {
          scopes?.end();
        }
        this.chainRendered = true;
        if (this.renderWaiters.length > 0) {
          const waiters = this.renderWaiters;
          this.renderWaiters = [];
          for (const resolve of waiters) resolve();
        }
        return;
      } catch (error) {
        this.degrade(error);
      }
    }
    scopes?.begin("draw");
    try {
      this.renderer.render(scene, camera);
    } finally {
      scopes?.end();
    }
  }

  /**
   * A node graph only fails when it is compiled, deep inside render(), and the
   * exception names no pass. So blame the most backend-sensitive pass still in
   * the plan, retire it, and let the next frame rebuild without it — repeat
   * until the graph builds or nothing optional is left.
   */
  private degrade(error: unknown): void {
    const blamed = nextPassToBlame(this.plan, this.failedPasses);
    this.disposePipeline();
    if (blamed) {
      this.failedPasses.add(blamed);
      console.warn(`[render] postfx pass "${blamed}" failed on this backend; disabling it:`, error);
      this.applyPostFxState();
    } else {
      this.postUnavailable = true;
      console.warn("[render] post-processing failed on this backend; rendering without it:", error);
    }
  }

  private buildPipeline(scene: THREE.Scene, camera: THREE.Camera): void {
    this.disposePipeline();
    const chain = new PostChain(this.renderer, this.fx, scene, camera, {
      disabled: this.failedPasses,
      resolveTexture: this.resolveTexture,
      volumetric: this.volumetric,
    });
    const pipeline = new THREE.RenderPipeline(this.renderer);
    // The chain applies the tone curve and the working->output colour-space
    // conversion itself (renderOutput), because grade/vignette/grain/AA have to
    // run after it on display-referred values. Leaving RenderPipeline's own
    // transform on would apply both twice.
    pipeline.outputColorTransform = false;
    pipeline.outputNode = chain.outputNode;
    this.pipeline = pipeline;
    this.chain = chain;
    this.chainRendered = false;
    this.plan = [...chain.plan];
    this.signature = chain.signature;
    this.lutState = { id: this.fx.grade.lut, ready: chain.plan.includes("lut") };
    this.pipelineScene = scene;
    this.pipelineCamera = camera;
  }

  private disposePipeline(): void {
    this.chain?.dispose();
    this.pipeline?.dispose();
    this.pipeline = null;
    this.chain = null;
    this.pipelineScene = null;
    this.pipelineCamera = null;
  }

  dispose(): void {
    this.disposePipeline();
    this.renderer.dispose();
  }
}

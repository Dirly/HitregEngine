import * as THREE from "three/webgpu";
import {
  PostChain,
  needsPipeline,
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

  setSize(width: number, height: number, pixelRatio = 1): void {
    this.renderer.setPixelRatio(pixelRatio);
    // updateStyle=false: the host app owns canvas CSS (docked editor layout)
    this.renderer.setSize(width, height, false);
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
   * Build every render pipeline this scene will need, now, instead of paying
   * for each one the first time its object happens to come on screen.
   *
   * WebGPU compiles a pipeline per material/geometry pair on first DRAW. In a
   * level you fly around, that lands as a stall every time you pan somewhere
   * new — the classic "it hitches whenever I turn" report, and it never settles
   * because there is always another corner you have not looked at yet. Paying
   * it once during load turns a permanent stutter into a slightly longer scene
   * open.
   *
   * `compileAsync()` alone does NOT do this: it runs the normal
   * `_projectObject` pass, which frustum-culls, so it only compiles what the
   * camera can already see — precisely the pipelines that were about to be
   * built anyway. Clearing `frustumCulled` for the duration is what makes it
   * cover the whole level; the flags are restored afterwards, including if the
   * compile throws.
   *
   * Awaiting is optional: the frame loop is free to run while this resolves,
   * and the pipelines simply become ready as they land.
   */
  async precompile(scene: THREE.Scene, camera: THREE.Camera): Promise<void> {
    const restore: THREE.Object3D[] = [];
    scene.traverse((object) => {
      if (!(object as THREE.Mesh).isMesh) return;
      if (object.frustumCulled === false) return;
      object.frustumCulled = false;
      restore.push(object);
    });
    try {
      await this.renderer.compileAsync(scene, camera);
    } catch (error) {
      // A precompile is an optimisation, never a correctness requirement: a
      // failure here must not stop the scene from being rendered normally.
      console.warn("[render] pipeline precompile failed:", error);
    } finally {
      for (const object of restore) object.frustumCulled = true;
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
          this.pipeline!.render();
        } finally {
          scopes?.end();
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

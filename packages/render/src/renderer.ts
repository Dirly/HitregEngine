import * as THREE from "three/webgpu";
import { pass, min, mrt, output, emissive } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";

/**
 * Belt-and-suspenders cap on top of the MRT split below — even the emissive
 * channel shouldn't be able to blow bloom out arbitrarily far past 1.0.
 */
const BLOOM_INPUT_CEILING = 4;

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
 * Post-processing: setBloom() drives a TSL RenderPipeline (scene pass + bloom,
 * works on both backends). The pipeline is built lazily on the next render()
 * and rebuilt whenever the scene or camera identity changes (the playground
 * swaps cameras between edit fly-cam and play rigs). Tone mapping stays on the
 * renderer — RenderPipeline defers it to its output transform, so it applies
 * exactly once with or without bloom.
 */
export class EngineRenderer {
  readonly renderer: THREE.WebGPURenderer;

  private bloomOptions: BloomOptions | null = null;
  private pipeline: THREE.RenderPipeline | null = null;
  private scenePass: ReturnType<typeof pass> | null = null;
  private bloomNode: ReturnType<typeof bloom> | null = null;
  private pipelineScene: THREE.Scene | null = null;
  private pipelineCamera: THREE.Camera | null = null;
  /** Set when the pipeline throws (e.g. backend limitation) — degrade to no bloom. */
  private bloomUnavailable = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

  /** Enable/retune bloom (null disables). Live retunes update uniforms in place. */
  setBloom(options: BloomOptions | null): void {
    this.bloomOptions = options;
    if (!options) {
      this.disposePipeline();
      return;
    }
    if (this.bloomNode) {
      this.bloomNode.strength.value = options.strength;
      this.bloomNode.radius.value = options.radius;
      this.bloomNode.threshold.value = options.threshold;
    }
    // no node yet: render() builds the pipeline lazily
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.bloomOptions && !this.bloomUnavailable) {
      try {
        if (!this.pipeline || scene !== this.pipelineScene || camera !== this.pipelineCamera) {
          this.buildPipeline(scene, camera, this.bloomOptions);
        }
        this.pipeline!.render();
        return;
      } catch (error) {
        this.bloomUnavailable = true;
        this.disposePipeline();
        console.warn("[render] bloom pipeline failed on this backend; rendering without it:", error);
      }
    }
    this.renderer.render(scene, camera);
  }

  private buildPipeline(scene: THREE.Scene, camera: THREE.Camera, options: BloomOptions): void {
    this.disposePipeline();
    const scenePass = pass(scene, camera);
    // selective bloom: split the scene pass into its normal lit "output" and
    // the material's own "emissive" contribution (MRT — one pass, two
    // targets). Bloom samples ONLY the emissive channel — a sunlit terrain
    // slope or a grazing-angle water highlight can never feed it, no matter
    // how bright, because ordinary PBR materials never write to `emissive`
    // unless a material explicitly sets one. This is what fixed a repeatable
    // freeze-and-flare at one hillside: threshold/ceiling tuning on the whole
    // scene color couldn't win against a wide-enough bright area, because
    // bloom's cost scales with area above threshold, not peak brightness —
    // excluding lit surfaces from the bloom input entirely removes that
    // failure mode structurally instead of just raising the bar.
    scenePass.setMRT(mrt({ output, emissive }));
    const scenePassColor = scenePass.getTextureNode("output");
    const emissiveColor = scenePass.getTextureNode("emissive");
    const bloomInput = min(emissiveColor, BLOOM_INPUT_CEILING);
    const bloomPass = bloom(bloomInput, options.strength, options.radius, options.threshold);
    // bloom's 5-level mip blur chain is a FIXED per-frame cost regardless of
    // scene complexity — its default resolutionScale (0.5, i.e. half the
    // render target) is the single biggest lever to cut that without
    // changing the visible effect much; drop it further for headroom.
    bloomPass.setResolutionScale(0.35);
    const pipeline = new THREE.RenderPipeline(this.renderer);
    // additive bloom in working space; the pipeline's output transform then
    // applies renderer.toneMapping + color space once
    pipeline.outputNode = scenePassColor.add(bloomPass);
    this.pipeline = pipeline;
    this.scenePass = scenePass;
    this.bloomNode = bloomPass;
    this.pipelineScene = scene;
    this.pipelineCamera = camera;
  }

  private disposePipeline(): void {
    this.bloomNode?.dispose();
    this.scenePass?.dispose();
    this.pipeline?.dispose();
    this.pipeline = null;
    this.scenePass = null;
    this.bloomNode = null;
    this.pipelineScene = null;
    this.pipelineCamera = null;
  }

  dispose(): void {
    this.disposePipeline();
    this.renderer.dispose();
  }
}

import * as THREE from "three/webgpu";
import { pass } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";

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
    const scenePassColor = scenePass.getTextureNode();
    const bloomPass = bloom(scenePassColor, options.strength, options.radius, options.threshold);
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

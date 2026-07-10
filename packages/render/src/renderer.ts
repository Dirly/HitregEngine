import * as THREE from "three/webgpu";

export type Backend = "webgpu" | "webgl";

/**
 * WebGPURenderer wrapper. Three's WebGPURenderer falls back to WebGL2 on its
 * own when WebGPU is unavailable; init() reports which backend won.
 */
export class EngineRenderer {
  readonly renderer: THREE.WebGPURenderer;

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

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.render(scene, camera);
  }

  dispose(): void {
    this.renderer.dispose();
  }
}

import * as THREE from "three/webgpu";
import {
  texture as tslTexture,
  uv,
  vec2,
  vec4,
  float,
  time,
  add,
  sub,
  mul,
  div,
  length,
  smoothstep,
  saturate,
  sin,
  pow,
} from "three/tsl";

/**
 * PROTOTYPE: proves the render-target ping-pong technique (render a pass into
 * a texture, sample that texture next frame, repeat) actually works in this
 * engine's WebGPU/TSL pipeline and stays portable to the WebGL fallback —
 * before committing to the full stylized water rewrite this is a stepping
 * stone toward. Not wired into the real water material; a throwaway test
 * surface samples its output (see main.ts's water-sim test wiring).
 *
 * Classic "ripple pond" formula (used in most real-time water-ripple demos):
 *   h_next(x,y) = damping * ( avg(4 neighbors of h_cur) * 2 - h_prev(x,y) )
 * Needs two history buffers (current + previous), unlike a plain diffusion/
 * blur — this is what actually gives propagating, oscillating ripples
 * instead of a wave that only ever spreads and flattens. A periodic pulse at
 * the patch center keeps the simulation visibly alive (no interaction wired
 * up yet — this is a proof of the mechanism, not the feature).
 */
export class WaterSimulation {
  /** Most recently computed height field — what a display material should sample. */
  get texture(): THREE.Texture {
    return this.targets[this.curIdx]!.texture;
  }

  private readonly targets: THREE.RenderTarget[];
  private curIdx = 1;
  private prevIdx = 0;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
  // one texture-sampling node per distinct (texture role, UV offset) pair —
  // each `texture(tex, uv)` call bakes its own UV expression into the node
  // graph at construction time, so a shared texture VALUE sampled at several
  // offsets (the 4 neighbors) needs one node per offset, all re-pointed at
  // the new render target's texture each step (see `step()`).
  private readonly prevCenterNode: ReturnType<typeof tslTexture>;
  private readonly curLeftNode: ReturnType<typeof tslTexture>;
  private readonly curRightNode: ReturnType<typeof tslTexture>;
  private readonly curUpNode: ReturnType<typeof tslTexture>;
  private readonly curDownNode: ReturnType<typeof tslTexture>;

  constructor(size: number, damping = 0.985) {
    const options: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.targets = [
      new THREE.RenderTarget(size, size, options),
      new THREE.RenderTarget(size, size, options),
      new THREE.RenderTarget(size, size, options),
    ];

    const texel = 1 / size;
    const uvNode = uv();
    const placeholder = this.targets[0]!.texture;
    this.prevCenterNode = tslTexture(placeholder, uvNode);
    this.curLeftNode = tslTexture(placeholder, add(uvNode, vec2(-texel, 0)));
    this.curRightNode = tslTexture(placeholder, add(uvNode, vec2(texel, 0)));
    this.curUpNode = tslTexture(placeholder, add(uvNode, vec2(0, texel)));
    this.curDownNode = tslTexture(placeholder, add(uvNode, vec2(0, -texel)));

    const left = this.curLeftNode.r;
    const right = this.curRightNode.r;
    const up = this.curUpNode.r;
    const down = this.curDownNode.r;
    const prevHeight = this.prevCenterNode.r;
    const propagated = sub(mul(add(add(left, right), add(up, down)), float(0.5)), prevHeight);
    const damped = mul(propagated, float(damping));

    // periodic drop at the patch center, so the sim is visibly alive without
    // any real interaction wired up yet — a brief sharp pulse (sin raised to
    // a high power concentrates it near the peak), gaussian-ish falloff in space
    const dist = length(sub(uvNode, vec2(0.5, 0.5)));
    const spatialFalloff = sub(float(1), smoothstep(float(0), float(0.04), dist));
    const dropGate = pow(saturate(sin(mul(time, float(0.6)))), float(16));
    const drop = mul(mul(spatialFalloff, dropGate), float(0.6));

    const nextHeight = add(damped, drop);
    const material = new THREE.MeshBasicNodeMaterial({ depthWrite: false, depthTest: false });
    material.colorNode = vec4(nextHeight, nextHeight, nextHeight, float(1));

    this.scene = new THREE.Scene();
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /** Advance the simulation by one step. Call once per frame. */
  step(renderer: THREE.WebGPURenderer): void {
    const nextIdx = 3 - this.curIdx - this.prevIdx; // the index not currently prev or cur
    this.prevCenterNode.value = this.targets[this.prevIdx]!.texture;
    const curTex = this.targets[this.curIdx]!.texture;
    this.curLeftNode.value = curTex;
    this.curRightNode.value = curTex;
    this.curUpNode.value = curTex;
    this.curDownNode.value = curTex;
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.targets[nextIdx]!);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prevTarget);
    this.prevIdx = this.curIdx;
    this.curIdx = nextIdx;
  }

  dispose(): void {
    for (const target of this.targets) target.dispose();
  }
}

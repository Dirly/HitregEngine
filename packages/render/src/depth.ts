import * as THREE from "three/webgpu";
import { Fn, viewportDepthTexture } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

/**
 * Depth-convention helpers for the reversed depth buffer (EngineRenderer
 * turns it on by default — see `EngineRendererOptions.reversedDepth`).
 *
 * With reversed depth the near plane stores 1 and the far plane (the sky)
 * stores 0, so any code that reads the raw depth texture and compares it to a
 * constant must ask which way round it is. Three's own converters
 * (`perspectiveDepthToViewZ`, `orthographicDepthToViewZ`, `getViewPosition`
 * through the camera's own inverse projection, shadow compares) already do;
 * a hand-written "is this pixel sky" test does not. Use this one.
 */
export const isSkyDepth: (depth: N) => N = Fn(([depth]: [N], builder: N) =>
  builder.renderer.reversedDepthBuffer === true ? depth.lessThanEqual(0.0001) : depth.greaterThanEqual(0.9999),
) as N;

/**
 * Three's shared `viewportDepthTexture()` target is a plain `DepthTexture`
 * (24-bit: `depth24plus` on WebGPU), but a reversed-depth framebuffer is
 * `depth32float`, so the per-frame copy into it fails ("copyFramebufferToTexture:
 * Source and destination formats do not match") and every reader (water shore
 * fade, soft particles, light pools, contact shadows) samples nothing. Make
 * the shared texture float before anything allocates it on the GPU.
 */
export function matchViewportDepthTexture(reversed: boolean): void {
  const shared = (viewportDepthTexture() as N).value as THREE.DepthTexture | undefined;
  if (shared && reversed && shared.type !== THREE.FloatType) {
    shared.type = THREE.FloatType;
    shared.needsUpdate = true;
  }
}

interface RenderItemLike {
  groupOrder: number;
  renderOrder: number;
  z: number;
  id: number;
}

/** Wanted opaque order: groupOrder, renderOrder, then FRONT to back (reversed z: larger is nearer). */
function reversedOpaque(a: RenderItemLike, b: RenderItemLike): number {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  if (a.z !== b.z) return b.z - a.z;
  return a.id - b.id;
}

/** Wanted transparent order: groupOrder, renderOrder, then BACK to front (reversed z: smaller is farther). */
function reversedTransparent(a: RenderItemLike, b: RenderItemLike): number {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  if (a.z !== b.z) return a.z - b.z;
  return a.id - b.id;
}

/**
 * Three 0.185's `RenderList.sort` handles a reversed-depth camera by sorting
 * as usual and then `.reverse()`-ing every list WHOLE — which reverses
 * `renderOrder` and `groupOrder` along with depth. The sky dome
 * (renderOrder -1000, depthTest off) then draws LAST among the opaque objects
 * and paints over every wall, floor and creature; overlays meant to draw after
 * their surface draw before it. Hand three comparators that produce the
 * reverse of the wanted order, so its `.reverse()` lands on the right one.
 * Only valid while every camera is reversed — install with the reversed buffer.
 */
export function keepRenderOrderUnderReversedDepth(renderer: {
  setOpaqueSort(sort: ((a: RenderItemLike, b: RenderItemLike) => number) | null): void;
  setTransparentSort(sort: ((a: RenderItemLike, b: RenderItemLike) => number) | null): void;
}): void {
  renderer.setOpaqueSort((a, b) => -reversedOpaque(a, b));
  renderer.setTransparentSort((a, b) => -reversedTransparent(a, b));
}

interface PipelineUtilsLike {
  createRenderPipeline(renderObject: { material: { polygonOffset?: boolean; polygonOffsetFactor: number; polygonOffsetUnits: number } }, promises: unknown): unknown;
}

/**
 * Three 0.185 hands `material.polygonOffsetFactor/Units` to WebGPU's
 * `depthBias/depthBiasSlopeScale` unchanged, whatever the depth direction. The
 * engine's convention (decals, editor overlays, target rings) is the classic
 * one — NEGATIVE pulls toward the camera — which under a reversed buffer
 * pushes the surface AWAY, so every decal would sink behind the wall it sits
 * on. Flip the sign once, here, while each pipeline is described, so authored
 * offsets keep their meaning on either convention. The descriptor is built
 * synchronously, so the material is restored before anything else sees it.
 */
export function flipDepthBiasForReversedDepth(backend: { pipelineUtils?: PipelineUtilsLike }): void {
  const utils = backend.pipelineUtils;
  if (!utils || (utils as { __reversedBias?: boolean }).__reversedBias) return;
  const create = utils.createRenderPipeline.bind(utils);
  utils.createRenderPipeline = (renderObject, promises) => {
    const material = renderObject.material;
    if (material.polygonOffset !== true) return create(renderObject, promises);
    const factor = material.polygonOffsetFactor;
    const units = material.polygonOffsetUnits;
    material.polygonOffsetFactor = -factor;
    material.polygonOffsetUnits = -units;
    try {
      return create(renderObject, promises);
    } finally {
      material.polygonOffsetFactor = factor;
      material.polygonOffsetUnits = units;
    }
  };
  (utils as { __reversedBias?: boolean }).__reversedBias = true;
}

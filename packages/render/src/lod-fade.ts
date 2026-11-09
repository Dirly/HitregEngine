import type * as THREE from "three/webgpu";
import { cameraPosition, clamp, distance, dot, float, floor, fract, screenCoordinate, step, sub, uniform, vec2, vec4, vertexStage } from "three/tsl";
import { instanceMatrixNode } from "./instancing.js";

/**
 * The stipple crossfade between a tree's mesh and its impostor.
 *
 * A hard mesh -> impostor swap changes every pixel of the tree in one frame. Across a band of distance both tiers draw
 * instead (`FoliageLodSystem` keeps the instance in both) and each screen pixel goes to exactly one of them: the mesh
 * keeps the pixels whose dither value is at or above the fade amount, the impostor the rest, so the tree never doubles
 * and never thins. Stippled, not blended, for `foliage-fade.ts`'s reason: opaque, depth-writing, unsorted. It is also
 * how a game of the PSX era would have done it.
 *
 * No per-instance data and no CPU write per frame: the amount comes from the instance's own distance in the vertex
 * stage, so both shaders agree on it for free. The band rides per OBJECT (`onObjectUpdate`), since a material is shared
 * by batches that may have no band at all: an object with none reads (0, 0) and draws solid.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const FADEABLE = "lodFadeable";
const BAND = "lodFadeBand";

/** The band of `object`: `start` to `end`, metres from the camera. (0, 0) = none. */
export function setLodFadeBand(object: THREE.Object3D, start: number, end: number): void {
  object.userData[BAND] = [start, end];
}

function bandUniform(index: 0 | 1): N {
  return (uniform(0, "float") as N).onObjectUpdate(({ object }: { object: THREE.Object3D }) =>
    (object.userData[BAND] as [number, number] | undefined)?.[index] ?? 0);
}

/**
 * 0 at or inside the band's start (all mesh), 1 at its end and past it (all impostor), measured to the instance
 * origin as `FoliageLodSystem` measures. With no band: `unbanded`.
 */
function fadeAmount(unbanded: number): N {
  const start = bandUniform(0);
  const end = bandUniform(1);
  const origin = (instanceMatrixNode() as N).mul(vec4(0, 0, 0, 1)).xyz;
  const t = clamp(sub(distance(origin, cameraPosition), start).div(sub(end, start).max(float(0.001))), 0, 1);
  return vertexStage(end.greaterThan(0).select(t, float(unbanded)));
}

/** Interleaved gradient noise on whole screen pixels: even coverage at every amount, and it holds still. */
function dither(): N {
  const p = floor(screenCoordinate.xy);
  return fract(float(52.9829189).mul(fract(dot(p, vec2(0.06711056, 0.00583715)))));
}

/** The impostor's share of the pixels: 1 where it keeps this one. Solid with no band. */
export function impostorKeep(): N {
  return float(1).sub(step(fadeAmount(1), dither()));
}

/**
 * Wire the mesh side into an instanced material. Only an alpha-tested material can drop a pixel (trees and bushes all
 * are); an opaque rock stays out, keeps its early-Z, and its batch keeps the hard swap.
 */
export function applyLodFade(material: THREE.Material): void {
  const node = material as THREE.NodeMaterial;
  if (!(node.alphaTest > 0) || node.userData[FADEABLE]) return;
  const keep = step(fadeAmount(0), dither());
  // opacityNode multiplies the map's own alpha, so a cutout's holes survive
  node.opacityNode = node.opacityNode ? (node.opacityNode as N).mul(keep) : keep;
  node.userData[FADEABLE] = true;
  node.needsUpdate = true;
}

/** Tag an impostor material built with {@link impostorKeep}. */
export function markLodFadeable(material: THREE.Material): void {
  material.userData[FADEABLE] = true;
}

/** Whether `material` can take part in the crossfade. */
export function isLodFadeable(material: THREE.Material | THREE.Material[]): boolean {
  return Array.isArray(material) ? material.length > 0 && material.every((m) => m.userData[FADEABLE] === true) : material.userData[FADEABLE] === true;
}

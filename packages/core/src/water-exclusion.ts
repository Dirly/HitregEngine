import { z } from "zod";
import type { SceneDoc } from "./scene.js";
import { vecApplyQuat, type Vec3, type WorldTransform } from "./math.js";

const point = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const plane = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
  .refine(p => Math.hypot(p[0], p[1], p[2]) > 1e-8, "Plane normal must be nonzero");

export const waterExclusionSchema = z.object({
  min: point.describe("Local lower corner of a finite dry volume. The bounds also clip the planes; fit them inside a watertight hull, never around the whole ship."),
  max: point.describe("Local upper corner. Stop at the gunwale/deck: the sea above a submerged vessel must remain wet."),
  planes: z.array(plane).max(128).default([]).describe("Optional convex clipping planes [nx,ny,nz,d], in this entity's local metres. Interior means dot(normal, point) <= d for every plane, AND inside min/max. An empty array is a box. Use multiple child entities for a nonconvex interior."),
}).refine(v => v.min.every((n, i) => n < v.max[i]!), "Dry-volume max must exceed min on every axis")
  .describe("Finite watertight interior: hides water surfaces and suppresses swimming/underwater effects inside the same volume. Inherits the entity hierarchy's transform, rotation and scale. Static authored volumes; does not simulate buoyancy or flooding. Omit on open wrecks.");

export type WaterExclusionData = z.infer<typeof waterExclusionSchema>;
export type WaterPlane = readonly [number, number, number, number];
export interface WaterExclusion {
  entity: string;
  min: Vec3;
  max: Vec3;
  /** World-space planes, INCLUDING the six transformed bounds planes. */
  planes: WaterPlane[];
}

/** Pure CPU/GPU contract: both sides consume these exact world-space planes. */
export function waterExclusions(doc: SceneDoc): WaterExclusion[] {
  const out: WaterExclusion[] = [];
  for (const [entity, e] of Object.entries(doc.entities)) {
    const d = e.components["waterExclusion"] as WaterExclusionData | undefined;
    if (!d) continue;
    // Apply each local TRS in order, rather than decomposing a world matrix:
    // a rotated child under a nonuniformly scaled parent has real shear.
    const chain: WorldTransform[] = [];
    let at: string | null = entity;
    while (at) {
      const parent: SceneDoc["entities"][string] = doc.entities[at]!;
      const t = (parent.components["transform"] ?? {}) as Partial<WorldTransform>;
      chain.push({ position: t.position ?? [0, 0, 0], rotation: t.rotation ?? [0, 0, 0, 1], scale: t.scale ?? [1, 1, 1] });
      at = parent.parent;
    }
    if (chain.some(t => t.scale.some(s => Math.abs(s) < 1e-8))) continue;
    const corners: Vec3[] = [];
    for (const x of [d.min[0], d.max[0]]) for (const y of [d.min[1], d.max[1]]) for (const z of [d.min[2], d.max[2]]) {
      let p: Vec3 = [x, y, z];
      for (const t of chain) {
        const v = vecApplyQuat([p[0] * t.scale[0], p[1] * t.scale[1], p[2] * t.scale[2]], t.rotation);
        p = [v[0] + t.position[0], v[1] + t.position[1], v[2] + t.position[2]];
      }
      corners.push(p);
    }
    const local: WaterPlane[] = [...d.planes,
      [1, 0, 0, d.max[0]], [-1, 0, 0, -d.min[0]],
      [0, 1, 0, d.max[1]], [0, -1, 0, -d.min[1]],
      [0, 0, 1, d.max[2]], [0, 0, -1, -d.min[2]],
    ];
    const planes: WaterPlane[] = local.map(localPlane => {
      let p = localPlane;
      for (const t of chain) {
        const n = vecApplyQuat([p[0] / t.scale[0], p[1] / t.scale[1], p[2] / t.scale[2]], t.rotation);
        const length = Math.hypot(...n), nx = n[0] / length, ny = n[1] / length, nz = n[2] / length;
        p = [nx, ny, nz, p[3] / length + nx * t.position[0] + ny * t.position[1] + nz * t.position[2]];
      }
      return p;
    });
    out.push({ entity,
      min: [Math.min(...corners.map(v => v[0])), Math.min(...corners.map(v => v[1])), Math.min(...corners.map(v => v[2]))],
      max: [Math.max(...corners.map(v => v[0])), Math.max(...corners.map(v => v[1])), Math.max(...corners.map(v => v[2]))], planes });
  }
  return out;
}

export function waterExcluded(volumes: readonly WaterExclusion[], x: number, y: number, z: number): boolean {
  return volumes.some(v => x >= v.min[0] && x <= v.max[0] && y >= v.min[1] && y <= v.max[1] && z >= v.min[2] && z <= v.max[2]
    && v.planes.every(p => p[0] * x + p[1] * y + p[2] * z <= p[3]));
}

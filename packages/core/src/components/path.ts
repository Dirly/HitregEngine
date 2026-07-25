import { z } from "zod";
import type { ComponentRegistry } from "./registry.js";

// local copy — importing from core.ts would create a circular module init
const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/**
 * Scatters copies of one small prop (primitive or a glTF node) along a curve
 * at regular spacing — fence posts, streetlights, or vine/leaf segments
 * running along a path. Renders as a single InstancedMesh (one draw call),
 * not real per-instance entities: no per-instance physics/scripts, matching
 * the existing `mesh.renderMode: "instanced"` tradeoff. For a single
 * continuous mesh along the curve instead (a road surface, a rope), use
 * `mesh.source.kind: "path"` on a `mesh` component instead — this component
 * is for repeated discrete props, that one is for one continuous surface.
 */
export const pathScatterSchema = z.object({
  points: z.array(vec3).min(2).describe("Control points in entity-local space; Catmull-Rom through all of them."),
  closed: z.boolean().default(false).describe("Loop from the last point back to the first."),
  prop: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("primitive"),
      shape: z.enum(["box", "sphere", "plane", "cylinder", "capsule", "cone", "torus", "wedge"]),
      size: vec3.default([1, 1, 1]),
    }),
    z.object({
      kind: z.literal("asset"),
      assetId: z.string().min(1),
      /** Named node WITHIN the model — set by "unpack model" to detach parts. */
      node: z.string().optional(),
    }),
  ]).describe("The mesh instanced at each placement along the curve."),
  material: z
    .string()
    .optional()
    .describe("Material asset GUID (assets/materials/); omitted = engine default material."),
  spacing: z.number().positive().default(2).describe("Distance in world units between placements."),
  offset: z
    .number()
    .default(0)
    .describe("Shifts the first placement along the curve (world units) — stagger parallel scatters."),
  alignToTangent: z
    .boolean()
    .default(true)
    .describe("Rotate each instance to face the curve's direction of travel at its point."),
  heightOffset: z.number().default(0),
  sideOffset: z
    .number()
    .default(0)
    .describe("Perpendicular shift from the curve centerline (e.g. fence posts along a road's shoulder)."),
  scaleJitter: z.number().min(0).max(1).default(0).describe("Random per-instance uniform scale variance, 0-1."),
  rotationJitter: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe("Random yaw jitter around the aligned facing, 0-1 of a full turn."),
  seed: z.number().int().default(1).describe("Deterministic jitter seed — same seed, same layout."),
  castShadow: z.boolean().default(true),
  receiveShadow: z.boolean().default(true),
});

export type PathScatterData = z.infer<typeof pathScatterSchema>;

export function registerPathComponents(registry: ComponentRegistry): void {
  registry.register("pathScatter", pathScatterSchema);
}

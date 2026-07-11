import { z } from "zod";
import type { ComponentRegistry } from "./registry.js";

// local copy — importing from core.ts would create a circular module init
const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/**
 * Physics components (consumed by @hitreg/physics / Rapier). An entity with a
 * collider but no rigidbody is treated as static scenery.
 */

export const rigidbodySchema = z.object({
  kind: z
    .enum(["dynamic", "kinematic", "static"])
    .default("dynamic")
    .describe("dynamic = physics-driven; kinematic = script-driven, pushes others; static = immovable. A collider with NO rigidbody is already static scenery."),
  /** Extra mass on top of collider density-derived mass. */
  mass: z.number().min(0).default(0),
  linearDamping: z.number().min(0).default(0),
  angularDamping: z.number().min(0).default(0.05),
  gravityScale: z.number().default(1),
  /** Continuous collision detection for fast movers (bullets). */
  ccd: z.boolean().default(false),
  /** Keep the body upright (character controllers). */
  lockRotations: z.boolean().default(false),
});

export const colliderSchema = z.object({
  // "heightmap" cooks a static trimesh from the SAME entity's heightmap mesh
  // component (single source of truth — no size/offset needed).
  // "trimesh"/"convex" cook from the SAME entity's mesh component (asset
  // meshes need a geometry provider — see PhysicsSim options); `size` is
  // ignored for all three cooked shapes.
  shape: z
    .enum(["box", "sphere", "capsule", "cylinder", "heightmap", "trimesh", "convex"])
    .default("box")
    .describe("heightmap/trimesh/convex COOK from the same entity's mesh component (no size needed); box/sphere/capsule/cylinder are sized primitives."),
  size: vec3
    .default([1, 1, 1])
    .describe("Full extents (box) / diameter+height (sphere, capsule, cylinder use x,y). IGNORED for cooked shapes (heightmap/trimesh/convex)."),
  offset: vec3.default([0, 0, 0]).describe("Local offset from the entity origin."),
  friction: z.number().min(0).default(0.5),
  restitution: z.number().min(0).default(0),
  density: z.number().positive().default(1),
  isTrigger: z
    .boolean()
    .default(false)
    .describe("Detect overlap without physical response — fires trigger.enter/exit events instead of colliding."),
});

export const jointSchema = z.object({
  kind: z.enum(["fixed", "hinge", "slider", "ball"]),
  /** Entity id of the other body (in the expanded scene). */
  target: z.string().min(1),
  /** Anchor on this entity, local space. */
  anchorA: vec3.default([0, 0, 0]),
  /** Anchor on the target entity, local space. */
  anchorB: vec3.default([0, 0, 0]),
  /** Hinge rotation axis / slider travel axis, local space. */
  axis: vec3.default([0, 1, 0]),
  /** Radians for hinge, meters for slider. */
  limits: z.object({ min: z.number(), max: z.number() }).optional(),
  /**
   * Collision response between the two jointed bodies. Off by default —
   * jointed bodies usually touch (door on its post) and fighting contacts
   * pump energy into the joint (violent oscillation).
   */
  contactsEnabled: z.boolean().default(false),
  motor: z
    .object({ targetVelocity: z.number(), maxForce: z.number().positive() })
    .optional(),
});

export function registerPhysicsComponents(registry: ComponentRegistry): void {
  registry.register("rigidbody", rigidbodySchema);
  registry.register("collider", colliderSchema);
  registry.register("joint", jointSchema);
}

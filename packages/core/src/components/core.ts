import { z } from "zod";
import type { ComponentRegistry } from "./registry.js";
import { prefabInstanceSchema } from "../prefab.js";

export const vec3 = z.tuple([z.number(), z.number(), z.number()]);
export const quat = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "expected hex color like #ff8800");

export const transformSchema = z.object({
  position: vec3.default([0, 0, 0]),
  rotation: quat.default([0, 0, 0, 1]),
  scale: vec3.default([1, 1, 1]),
});

export const meshSchema = z.object({
  source: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("primitive"),
      shape: z.enum(["box", "sphere", "plane", "cylinder", "capsule", "cone", "torus", "wedge"]),
      size: vec3.default([1, 1, 1]),
    }),
    z.object({
      kind: z.literal("asset"),
      assetId: z.string().min(1),
    }),
  ]),
  /** Material asset GUID; omitted = engine default material. */
  material: z.string().optional(),
  castShadow: z.boolean().default(true),
  receiveShadow: z.boolean().default(true),
  /** "instanced" collapses all users of the same prefab into one InstancedMesh. */
  renderMode: z.enum(["auto", "instanced"]).default("auto"),
  /** Static geometry is eligible for publish-time merge/batch baking. */
  static: z.boolean().default(false),
});

export const lightSchema = z.object({
  kind: z.enum(["directional", "point", "spot", "ambient"]),
  color: hexColor.default("#ffffff"),
  intensity: z.number().min(0).default(1),
  /** point/spot only */
  range: z.number().min(0).default(10),
  /** spot only, radians */
  angle: z.number().min(0).max(Math.PI / 2).default(Math.PI / 6),
  castShadow: z.boolean().default(false),
});

export const cameraSchema = z.object({
  fov: z.number().min(1).max(179).default(60),
  near: z.number().positive().default(0.1),
  far: z.number().positive().default(1000),
  /** Exactly one camera should be active at runtime; enforced by the render layer. */
  active: z.boolean().default(false),
});

/** PBR material — a data asset referenced by mesh.material GUID. */
export const materialSchema = z.object({
  /** Built-in shader set; custom TSL node-graph shaders are the planned upgrade path. */
  shader: z.enum(["standard", "unlit", "toon", "wireframe"]).default("standard"),
  color: hexColor.default("#9aa0a8"),
  roughness: z.number().min(0).max(1).default(0.85),
  metalness: z.number().min(0).max(1).default(0.05),
  emissive: hexColor.default("#000000"),
  emissiveIntensity: z.number().min(0).default(1),
  opacity: z.number().min(0).max(1).default(1),
  transparent: z.boolean().default(false),
});

export function registerCoreComponents(registry: ComponentRegistry): void {
  registry.register("transform", transformSchema);
  registry.register("mesh", meshSchema);
  registry.register("light", lightSchema);
  registry.register("camera", cameraSchema);
  registry.register("prefab", prefabInstanceSchema);
}

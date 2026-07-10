import { z } from "zod";
import type { ComponentRegistry } from "./registry.js";
import { prefabInstanceSchema } from "../prefab.js";
import { registerPhysicsComponents } from "./physics.js";

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
      /** Named node WITHIN the model — set by "unpack model" to detach parts. */
      node: z.string().optional(),
    }),
    z.object({
      /** Extruded 2D footprint (graybox poly-draw). Rises from the entity origin. */
      kind: z.literal("polygon"),
      /** Footprint points in entity-local XZ (stored as extrude-space [x, -z]). */
      points: z.array(z.tuple([z.number(), z.number()])).min(3),
      height: z.number().positive(),
      bevel: z
        .object({
          size: z.number().min(0),
          segments: z.number().int().min(1).max(8).default(2),
        })
        .optional(),
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
  /** Play-mode camera rig. follow = orbit-follow the first entity with targetTag. */
  rig: z
    .object({
      mode: z.enum(["follow"]),
      targetTag: z.string().default("player"),
      distance: z.number().positive().default(7),
      height: z.number().default(3.5),
      damping: z.number().positive().default(5),
    })
    .optional(),
});

/** PBR material — a data asset referenced by mesh.material GUID. */
export const materialSchema = z.object({
  /** Built-in shader set; custom TSL node-graph shaders are the planned upgrade path. */
  shader: z.enum(["standard", "unlit", "toon", "wireframe"]).default("standard"),
  color: hexColor.default("#9aa0a8"),
  /** Texture asset id (assets/textures/) used as the color map. */
  map: z.string().optional(),
  /** Texture tiling [u, v]. */
  repeat: z.tuple([z.number(), z.number()]).default([1, 1]),
  roughness: z.number().min(0).max(1).default(0.85),
  metalness: z.number().min(0).max(1).default(0.05),
  emissive: hexColor.default("#000000"),
  emissiveIntensity: z.number().min(0).default(1),
  opacity: z.number().min(0).max(1).default(1),
  transparent: z.boolean().default(false),
});

/** Attach behavior: a registered script by name + its tuning params. */
export const scriptSchema = z.object({
  name: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Skeletal animation for asset meshes (clips come from the glTF). `play` is
 * the clip started in play mode; scripts blend via ctx.setAnimation (Unity
 * crossfade semantics: transitions fade over `fade` seconds).
 */
export const animatorSchema = z.object({
  play: z.string().optional(),
  fade: z.number().min(0).default(0.3),
  speed: z.number().default(1),
});

/** Sound emitter. `src` is an audio asset id (assets/audio/). */
export const audioSchema = z.object({
  src: z.string().min(1),
  volume: z.number().min(0).max(1).default(1),
  loop: z.boolean().default(false),
  /** Start when play mode starts (looping ambience, music). */
  autoplay: z.boolean().default(false),
  /** 3D positional vs flat. */
  positional: z.boolean().default(true),
  refDistance: z.number().positive().default(8),
});

/**
 * Environment sky: gradient dome + matching background/fog + hemisphere fill.
 * One per scene (first wins).
 */
export const skySchema = z.object({
  top: hexColor.default("#39598f"),
  bottom: hexColor.default("#101522"),
  /** Equirectangular panorama texture asset id — replaces the gradient dome. */
  texture: z.string().optional(),
  /** Hemisphere fill light tinted by the sky colors. 0 disables. */
  light: z.number().min(0).default(0.5),
  fog: z
    .object({
      color: hexColor.default("#101522"),
      near: z.number().positive().default(40),
      far: z.number().positive().default(180),
    })
    .optional(),
});

export function registerCoreComponents(registry: ComponentRegistry): void {
  registry.register("transform", transformSchema);
  registry.register("mesh", meshSchema);
  registry.register("light", lightSchema);
  registry.register("camera", cameraSchema);
  registry.register("prefab", prefabInstanceSchema);
  registry.register("script", scriptSchema);
  registry.register("animator", animatorSchema);
  registry.register("audio", audioSchema);
  registry.register("sky", skySchema);
  registerPhysicsComponents(registry);
}

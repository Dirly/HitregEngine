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
    z.object({
      /** Procedural noise terrain (see core/terrain.ts). Pair with a
       * collider of shape "heightmap" for matching physics. */
      kind: z.literal("heightmap"),
      /** World extent [width, depth], centered on the entity origin. */
      size: z.tuple([z.number().positive(), z.number().positive()]).default([80, 80]),
      amplitude: z.number().min(0).default(1.5),
      /** Noise feature scale — higher = smaller, busier hills. */
      frequency: z.number().positive().default(0.08),
      seed: z.number().int().default(1),
      /** World-space XZ origin used when tiling terrain across streamed chunks. */
      offset: z.tuple([z.number(), z.number()]).default([0, 0]),
      /** Grid subdivisions per side. */
      resolution: z.number().int().min(8).max(256).default(96),
      /** Radius of a flat disc at the center (a playfield); 0 = none. */
      flatRadius: z.number().min(0).default(0),
      /** Distance over which the flat disc blends up to full height. */
      flatFalloff: z.number().positive().default(8),
      /** Optional world-space river channel, running parallel to the Z axis. */
      river: z
        .object({
          centerX: z.number(),
          width: z.number().positive(),
          depth: z.number().positive(),
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

/**
 * Scene post-processing stack. One per scene (first wins). Each effect is its
 * own object so future passes (DoF, AO, vignette) slot in beside bloom.
 */
export const postfxSchema = z.object({
  bloom: z
    .object({
      enabled: z.boolean().default(false),
      strength: z.number().min(0).max(3).default(0.5),
      /** Bloom spread; BloomNode requires [0, 1]. */
      radius: z.number().min(0).max(1).default(0.4),
      /** Luminance threshold — only pixels brighter than this glow. */
      threshold: z.number().min(0).default(0.85),
    })
    // prefault: `{ "postfx": {} }` parses and the inner field defaults apply
    .prefault({}),
});

/**
 * Data-driven particle emitter. Defaults describe a small additive spark
 * fountain, so `{ "particles": {} }` is a working starter effect. Rendered by
 * a custom instanced system in @hitreg/render (CPU sim, InstancedMesh) —
 * three.quarks is WebGL-only today; this schema is engine-owned, so the
 * backend can swap later without touching scene documents.
 */
export const particlesSchema = z.object({
  emitting: z.boolean().default(true),
  /** Particles spawned per second. */
  rate: z.number().min(0).default(20),
  /** Live-particle cap — pool size, hard-capped for the latency budget. */
  max: z.number().int().min(1).max(2000).default(200),
  /** Per-particle lifespan, random in [min, max] seconds. */
  lifetime: z.tuple([z.number().min(0), z.number().min(0)]).default([0.8, 1.6]),
  /** Emitter volume; cone spreads velocity by coneAngle around direction. */
  shape: z.enum(["point", "sphere", "box", "cone"]).default("point"),
  /** Emitter half-extents (box) / radii (sphere) in local units. */
  shapeSize: vec3.default([0.2, 0.2, 0.2]),
  /** Cone shape only: half-angle of the velocity spread, degrees. */
  coneAngle: z.number().min(0).max(90).default(25),
  /** Initial velocity direction (emitter-local; normalized at runtime). */
  direction: vec3.default([0, 1, 0]),
  /** Initial speed, random in [min, max] units/sec. */
  speed: z.tuple([z.number(), z.number()]).default([1, 2]),
  /** Positive pulls particles down (world -Y), units/sec^2. */
  gravity: z.number().default(0),
  /** Velocity damping per second; 0 = none. */
  drag: z.number().min(0).default(0),
  sizeStart: z.number().min(0).default(0.15),
  sizeEnd: z.number().min(0).default(0.02),
  /** Billboard spin, radians/sec. */
  spin: z.number().default(0),
  colorStart: hexColor.default("#ffffff"),
  colorEnd: hexColor.default("#ffffff"),
  opacityStart: z.number().min(0).max(1).default(1),
  opacityEnd: z.number().min(0).max(1).default(0),
  /** additive = fire/magic glow; normal = smoke/dust. */
  blending: z.enum(["normal", "additive"]).default("additive"),
  /** Texture asset id; omitted = procedural soft round sprite. */
  texture: z.string().optional(),
  /** world = particles trail behind a moving emitter; local = they ride it. */
  space: z.enum(["local", "world"]).default("world"),
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
  registry.register("postfx", postfxSchema);
  registry.register("particles", particlesSchema);
  registerPhysicsComponents(registry);
}

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
      /** Optional file-backed editable heightfield from assets/terrain/. */
      terrainAsset: z.string().min(1).optional(),
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
  material: z
    .string()
    .optional()
    .describe("Material asset GUID (assets/materials/); omitted = engine default material."),
  castShadow: z.boolean().default(true),
  receiveShadow: z.boolean().default(true),
  renderMode: z
    .enum(["auto", "instanced"])
    .default("auto")
    .describe('"instanced" collapses all users of the same prefab into one InstancedMesh.'),
  static: z
    .boolean()
    .default(false)
    .describe(
      "Marks geometry static: eligible for HLOD/batch merge into distant proxies. No effect on gameplay; set it for scenery, not for anything a script moves.",
    ),
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
  active: z
    .boolean()
    .default(false)
    .describe("Marks this the active camera. Exactly one camera should be active; the render layer enforces first-wins."),
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
  shader: z
    .enum(["standard", "unlit", "toon", "wireframe"])
    .default("standard")
    .describe("Built-in shader. unlit = flat/PS1-style, ignores lights; toon = banded; standard = PBR."),
  color: hexColor.default("#9aa0a8"),
  map: z.string().optional().describe("Texture asset id (assets/textures/) used as the color map."),
  repeat: z.tuple([z.number(), z.number()]).default([1, 1]).describe("Texture tiling [u, v]."),
  roughness: z.number().min(0).max(1).default(0.85),
  metalness: z.number().min(0).max(1).default(0.05),
  emissive: hexColor.default("#000000"),
  emissiveIntensity: z
    .number()
    .min(0)
    .default(1)
    .describe("Emissive glow strength. Only visibly blooms when a scene postfx bloom pass is enabled."),
  opacity: z.number().min(0).max(1).default(1),
  transparent: z
    .boolean()
    .default(false)
    .describe("Enable alpha blending. Auto-on when opacity < 1; set true for textures with alpha."),
});

/** Attach behavior: a registered script by name + its tuning params. */
export const scriptSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("Registered behavior name (built-ins + assets/scripts/); GET /__hitreg/spec `scripts` lists them and their params."),
  params: z.record(z.string(), z.unknown()).default({}).describe("Per-instance tuning for the behavior's declared params."),
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
  /** Six-face cubemap texture asset ids — wins over both `texture` and the gradient dome. */
  cubemap: z
    .object({
      px: z.string(),
      nx: z.string(),
      py: z.string(),
      ny: z.string(),
      pz: z.string(),
      nz: z.string(),
    })
    .optional(),
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
  space: z
    .enum(["local", "world"])
    .default("world")
    .describe("world = particles trail behind a moving emitter; local = they ride it."),
});

/**
 * World-space, always-camera-facing UI attached to an entity: HP bars, name
 * labels, icon sprites. All fields are defaulted so `{ "billboard": {} }` is a
 * full green bar floating above the entity. Scripts mutate fill/text/visible
 * at runtime via ctx.setBillboard (never the document).
 */
export const billboardSchema = z.object({
  kind: z.enum(["bar", "text", "sprite"]).default("bar"),
  /** Position above the entity origin, entity-local units. */
  offset: vec3.default([0, 1.4, 0]),
  /** World-space [width, height]. Default is bar-ish; text/sprite authors override. */
  size: z.tuple([z.number().positive(), z.number().positive()]).default([1, 0.14]),
  /** Bar kind only: filled fraction of the track. */
  fill: z.number().min(0).max(1).default(1),
  /** Bar fill / text color. */
  color: hexColor.default("#4ade80"),
  background: hexColor.default("#101522"),
  backgroundOpacity: z.number().min(0).max(1).default(0.65),
  /** Text kind only: the label. */
  text: z.string().default(""),
  /** Sprite kind only: texture asset id (assets/textures/) — the whole image. */
  texture: z.string().optional(),
  /** Sprite kind only: spritesheet data-asset id + frame name (wins over texture). */
  sheet: z.string().optional(),
  frame: z.string().optional(),
  visible: z.boolean().default(true),
});

/**
 * Declares an entity as network-replicated (the engine's NetworkObject).
 * `{ "netObject": {} }` is a sane default: host-simulated, transform +
 * animation synced, relevant to everyone, transmitted every snapshot.
 *
 * Interest management ("need to know"): `relevancy: "proximity"` transmits
 * only to peers whose player is within `radius` (with leave hysteresis);
 * `sendEvery: 4` transmits on every 4th snapshot — distant/slow things
 * (patrolling guards, ambient animals) don't deserve full bandwidth.
 *
 * Entities with a script + rigidbody and NO netObject component get these
 * exact defaults implicitly (zero-config multiplayer); add the component
 * to opt out of a field or tune it.
 */
export const netObjectSchema = z.object({
  /**
   * host = the session authority simulates it (NPCs, world objects).
   * owner = the owning peer simulates it and the host validates/clamps
   * (vehicles, carried props) — reserved; engine wiring lands with
   * ownership assignment.
   */
  authority: z
    .enum(["host", "owner"])
    .default("host")
    .describe('host = the session authority simulates it. "owner" is RESERVED (ownership wiring lands later) — use "host".'),
  sync: z
    .object({
      transform: z.boolean().default(true),
      animation: z.boolean().default(true),
    })
    .prefault({}),
  relevancy: z
    .enum(["always", "proximity"])
    .default("always")
    .describe('"proximity" transmits only to peers within `radius` (interest management, with leave hysteresis).'),
  radius: z.number().positive().default(50).describe("Proximity relevancy range in world units."),
  sendEvery: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(1)
    .describe("Transmit on every Nth snapshot (staggered per entity); raise for ambient/distant things."),
});

export type NetObjectData = z.infer<typeof netObjectSchema>;

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
  registry.register("billboard", billboardSchema);
  registry.register("netObject", netObjectSchema);
  registerPhysicsComponents(registry);
}

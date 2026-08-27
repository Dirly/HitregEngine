import { z } from "zod";
import type { ComponentRegistry } from "./registry.js";
import { prefabInstanceSchema } from "../prefab.js";
import { registerPhysicsComponents } from "./physics.js";
import { registerPathComponents } from "./path.js";
import { polyMeshSourceSchema } from "../poly-mesh/types.js";

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

/**
 * Serialized entity activation for render-side content. This belongs in the
 * document instead of a play-mode script's onStart: edit mode does not run
 * gameplay scripts, so initially inactive rubble/effects/lights must already
 * be inactive when the scene is built.
 */
export const visibilitySchema = z.object({
  visible: z
    .boolean()
    .default(true)
    .describe("False hides this entity's complete render subtree in edit and play mode. Scripts may still reveal it at runtime through the entity Object3D."),
});

export const meshSchema = z.object({
  source: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("primitive"),
      shape: z.enum(["box", "sphere", "plane", "cylinder", "capsule", "cone", "torus", "wedge"]),
      size: vec3.default([1, 1, 1]),
      /** plane only: width/height subdivisions. Every other shape ignores this
       * (their curvature already implies enough segments) — a plane is the
       * one primitive that's otherwise a bare quad, with nothing for a vertex
       * shader (e.g. the water shader's wave displacement) to actually move. */
      segments: z.tuple([z.number().int().min(1), z.number().int().min(1)]).default([1, 1]),
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
    polyMeshSourceSchema.describe(
      "Editable polygon mesh (ProBuilder-class): shared `vertices` + n-gon `faces` (CCW from outside) with per-face " +
        "material slot / smoothing group / UV settings. The graybox shape tools create these; edit them with the " +
        "poly-mesh ops in @hitreg/core (extrude, inset, bevel, subdivide, connect, bridge, ...) or by hand. " +
        "`generator` records the parametric shape (cube/cylinder/stairs/arch/...) while the mesh is untouched.",
    ),
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
    z.object({
      /** Curve-following geometry: roads, rivers, fences (ribbon) or
       * vines/cables/ropes (tube). Catmull-Rom through `points`; rises from
       * no fixed origin — the curve IS the geometry, in entity-local space. */
      kind: z.literal("path"),
      points: z.array(vec3).min(2).describe("Control points in entity-local space."),
      closed: z.boolean().default(false).describe("Loop from the last point back to the first."),
      crossSection: z
        .enum(["ribbon", "tube"])
        .default("ribbon")
        .describe("ribbon = flat strip (roads, rivers, fences); tube = round (vines, cables, rope)."),
      width: z.number().positive().default(2).describe("ribbon only: total width across the curve."),
      radius: z.number().positive().default(0.15).describe("tube only: cross-section radius."),
      radialSegments: z.number().int().min(3).max(16).default(6).describe("tube only: roundness."),
      segmentsPerSpan: z
        .number()
        .int()
        .min(1)
        .max(32)
        .default(8)
        .describe("Curve smoothness between each pair of control points."),
    }),
  ]),
  material: z
    .string()
    .optional()
    .describe("Material asset GUID (assets/materials/); omitted = engine default material."),
  castShadow: z.boolean().default(true),
  receiveShadow: z.boolean().default(true),
  renderMode: z
    .enum(["auto", "instanced", "clustered"])
    .default("auto")
    .describe(
      '"instanced" collapses all users of the same prefab into one InstancedMesh (with distance LOD tiers). ' +
        '"clustered" (asset sources only) gives a single large/hero mesh continuous, crack-free per-cluster LOD ' +
        "and per-cluster frustum culling driven by screen-space error — no LOD authoring; use it for statues, " +
        "buildings, scanned props, terrain patches, not for things placed hundreds of times (use instanced).",
    ),
  lod: z
    .boolean()
    .default(true)
    .describe(
      "instanced only: swap to a cheap distance proxy when far from camera. Turn off for props " +
        "already too small/cheap to benefit (grass, small clutter) — the proxy swap only hurts those visually.",
    ),
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
  importance: z
    .number()
    .positive()
    .default(1)
    .describe("Relative priority when the camera's dynamic point-light budget is full. Raise for short critical flashes; distant decorative lights should stay at 1."),
  /**
   * directional + castShadow only: half-width of the shadow camera's square
   * ortho frustum, world units (so the frustum spans `-shadowSize` to
   * `+shadowSize` on each axis). Default (40) suits a small/medium scene —
   * a large open world needs this raised, or content far from the frustum
   * center renders with NO shadow at all, and — if something (a script)
   * periodically re-centers the light to follow the player — the boundary
   * between one frustum position and the next shows up as a visible seam:
   * a hard-edged grid of shadowed/unshadowed patches. Bigger values trade
   * shadow sharpness for coverage (fixed shadow-map resolution spread over
   * more world space).
   */
  shadowSize: z.number().positive().default(40),
});

export const cameraSchema = z.object({
  fov: z.number().min(1).max(179).default(60),
  near: z.number().positive().default(0.1),
  far: z.number().positive().default(1000),
  active: z
    .boolean()
    .default(false)
    .describe("Marks this the active camera. Exactly one camera should be active; the render layer enforces first-wins."),
  /**
   * Play-mode camera rig, tracking the first entity tagged `targetTag`.
   * follow = free mouse-orbit around the target (default; shooters/characters).
   * chase = rigid third-person: camera stays behind the target's own current
   * yaw at `distance`/`height`, no free orbit — the mouse is freed up for a
   * script to steer the target itself (e.g. vehicle nose direction) via
   * `ctx.input.mouseDelta()` instead of orbiting the camera.
   */
  rig: z
    .object({
      mode: z.enum(["follow", "chase"]),
      targetTag: z.string().default("player"),
      distance: z.number().positive().default(7),
      height: z.number().default(3.5),
      damping: z.number().positive().default(5),
    })
    .optional(),
});

/** One splat layer: a flat color/roughness that fades in over a height band. */
const splatLayerSchema = z.object({
  color: hexColor.default("#9aa0a8"),
  roughness: z.number().min(0).max(1).default(0.9),
  heightStart: z.number().default(0).describe("Local Y where this layer starts blending in."),
  heightEnd: z.number().default(10).describe("Local Y where this layer is fully blended in."),
  grassy: z
    .boolean()
    .default(false)
    .describe(
      "Adds cheap procedural mottling (no textures/geometry — a per-pixel color variation) so this " +
        "layer reads as grass texture instead of a flat tint. Meant for exactly one grass-colored layer.",
    ),
});

/** PBR material — a data asset referenced by mesh.material GUID. */
export const materialSchema = z.object({
  shader: z
    .enum(["standard", "unlit", "toon", "wireframe", "terrain-splat", "water"])
    .default("standard")
    .describe(
      "Built-in shader. unlit = flat/PS1-style, ignores lights; toon = banded; standard = PBR; " +
        "terrain-splat = blends `splat.layers` by height/slope (seamless heightmap terrain, no per-tile hard edges); " +
        "water = animated fresnel/ripple shader driven by `water` (bounded brightness — safe under bloom).",
    ),
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
    .describe(
      "Emissive glow strength (tints `emissive` on top of the base color). Applies to every shader, " +
        "including unlit — unlit's own glow is otherwise invisible to lighting but still feeds bloom. " +
        "Only visibly blooms when a scene postfx bloom pass is enabled.",
    ),
  emissiveMap: z
    .string()
    .optional()
    .describe(
      "Texture asset id (assets/textures/) used as a self-illumination mask, standard/toon shaders only " +
        "(URP-style 'Emission map'): white areas of this texture glow at full `emissive`/`emissiveIntensity` " +
        "regardless of scene lighting — dark areas stay fully lit/shaded. Lets one mesh mix lit PBR surface " +
        "with unlit glowing detail (e.g. a lit robot body with unlit glowing eyes/screens/edge trim) without " +
        "switching the whole material to the `unlit` shader.",
    ),
  opacity: z.number().min(0).max(1).default(1),
  transparent: z
    .boolean()
    .default(false)
    .describe("Enable alpha blending. Auto-on when opacity < 1; set true for textures with alpha."),
  splat: z
    .object({
      layers: z
        .array(splatLayerSchema)
        .min(2)
        .max(4)
        .describe("Ascending-height bands blended in sequence (each overtakes the previous through its band)."),
      slopeRock: z
        .object({
          color: hexColor.default("#8a8378"),
          roughness: z.number().min(0).max(1).default(0.95),
          start: z.number().min(0).max(1).default(0.55).describe("Steepness (0=flat,1=vertical) where rock starts."),
          end: z.number().min(0).max(1).default(0.8),
        })
        .optional()
        .describe("Blends a rock color over steep slopes regardless of height band (cliffs, crater rims)."),
    })
    .optional()
    .describe("Only read when shader is 'terrain-splat'."),
  water: z
    .object({
      shallowColor: hexColor.default("#3fa8c9"),
      /** Toon-ramp middle stop, between shallowColor and deepColor. */
      midColor: hexColor.default("#1f6f96"),
      deepColor: hexColor.default("#0b3150"),
      rimColor: hexColor.default("#eaf6ff"),
      foamColor: hexColor.default("#eaf6ff"),
      waveFrequency: z.number().positive().default(0.35),
      waveSpeed: z.number().default(0.6),
      /** Vertical rise/fall of the surface geometry itself, world units — needs
       * a subdivided mesh (mesh.source.segments) to actually show; 0 keeps the
       * old cosmetic-shimmer-only look. */
      waveAmplitude: z.number().min(0).default(0.15),
      fresnelPower: z.number().positive().default(3),
      /** World units of water depth (camera-ray, not literal vertical depth —
       * the standard real-time approximation) over which color fades from
       * shallowColor to deepColor. Needs opaque geometry (seafloor/terrain)
       * actually beneath the surface to read the depth against. */
      depthFadeDistance: z.number().positive().default(6),
      /** World units of water depth within which the surface blends toward
       * foamColor — the shoreline-foam band. */
      foamWidth: z.number().min(0).default(0.5),
      /** Camera distance (world units) where the surface starts fading toward
       * fully transparent — should end well before the mesh's own physical
       * edge so a large-but-finite water plane never shows a hard cutoff, no
       * matter which direction the camera approaches that edge from. */
      edgeFadeStart: z.number().positive().default(400),
      /** Camera distance where the fade finishes (fully transparent). */
      edgeFadeEnd: z.number().positive().default(600),
    })
    .optional()
    .describe(
      "Only read when shader is 'water'. Fully procedural (no textures needed) — depth-based " +
        "color and shoreline foam read the depth buffer against whatever's actually beneath the " +
        "surface, so they need real opaque geometry (terrain/seafloor) there to work.",
    ),
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
  /** Gradient-dome only (no effect with `texture`/`cubemap`): adds a soft
   * horizon haze band and directional sun glow — a fixed direction, not tied
   * to any actual light in the scene. */
  sun: z
    .object({
      direction: vec3.default([0.4, 0.55, 0.3]),
      color: hexColor.default("#fff6df"),
      size: z.number().min(0.9).max(0.9999).default(0.997).describe("Closer to 1 = a smaller, sharper glow."),
      intensity: z.number().min(0).default(1.5),
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
 * Procedural grass: thousands of camera-following triangle blades scattered
 * within `radius` of the camera and laid onto whichever heightmap terrain is
 * underfoot. Rendered by a custom instanced system in @hitreg/render (merged
 * triangle-per-blade geometry, TSL wind sway) — one field per scene (first
 * wins). `{ "grass": {} }` is a working default patch.
 */
export const grassSchema = z.object({
  bladeColor: hexColor.default("#3f7d34"),
  tipColor: hexColor.default("#8fd15c"),
  bladeWidth: z.number().positive().default(0.06),
  bladeHeight: z.number().positive().default(0.55),
  /** Blades per square unit within the patch. */
  density: z.number().positive().default(5),
  /** Radius around the camera covered by grass, world units — the "sliding
   * window" the patch re-centers within as the camera moves. */
  radius: z.number().positive().default(20),
  windStrength: z.number().min(0).default(0.4),
  windSpeed: z.number().positive().default(1.3),
  /** Camera height above the ground directly below it (world units) below
   * which the field is fully visible; fades out between here and
   * heightFadeEnd so grass is only rendered close to the ground (e.g. a
   * helicopter flying low), not wastefully from altitude. */
  heightFadeStart: z.number().positive().default(12),
  heightFadeEnd: z.number().positive().default(30),
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
  registry.register("visibility", visibilitySchema);
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
  registry.register("grass", grassSchema);
  registry.register("netObject", netObjectSchema);
  registerPhysicsComponents(registry);
  registerPathComponents(registry);
}

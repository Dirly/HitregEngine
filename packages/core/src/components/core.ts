import { z } from "zod";
import type { ComponentRegistry } from "./registry.js";
import { prefabInstanceSchema } from "../prefab.js";
import { registerPhysicsComponents } from "./physics.js";
import { registerPathComponents } from "./path.js";
import { registerVoxelComponents } from "./voxel.js";
import { registerPlacementComponent } from "./placement.js";
import { registerDecalComponent } from "./decal.js";
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

/**
 * Vertex-shader wind for a model, shared by the `mesh` component and the voxel
 * scatter rule that emits one — the same knobs mean the same thing in both.
 */
export const meshWindSchema = z.object({
  mode: z
    .enum(["sway", "ripple"])
    .describe(
      "Two different motions, not one with a knob. `sway` BENDS the whole plant from a base pinned to " +
        "the ground - displacement grows with height, so it leans as one piece. That is a bush or a " +
        "reed. `ripple` shivers each leaf card on the spot with NO net lean, phase varying across the " +
        "model so cards move against each other: the canopy shimmers while the tree stands still, " +
        "which is what real timber does in a light wind. Putting `sway` on a tree is the classic " +
        "mistake - the trunk swings like a blade of grass and the model reads as rubber.",
    ),
  strength: z
    .number()
    .min(0)
    .default(0.12)
    .describe(
      "Peak displacement in METRES of world space, not a fraction of the model. A ripple wants " +
        "0.02-0.06; a bush sway 0.08-0.2.",
    ),
  speed: z.number().positive().default(1.1).describe("Roughly oscillations per second."),
  canopy: z
    .number()
    .min(0)
    .max(0.95)
    .default(0.35)
    .describe(
      "`ripple` only: fraction of the model height where the canopy starts. Everything below is held " +
        "perfectly still, which is how the trunk stays out of it. It is a HEIGHT test rather than a " +
        "'is this the leaf material' test on purpose: Blockbench exports every material as alphaMode " +
        "MASK, so a cutout test catches the trunk too (the same trap `foliageNormals` documents), " +
        "while height does not care where the trunk sits horizontally.",
    ),
});

export const meshSchema = z.object({
  source: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("primitive"),
      shape: z.enum(["box", "sphere", "plane", "cylinder", "capsule", "cone", "torus", "wedge"]),
      size: vec3
        .default([1, 1, 1])
        .describe(
          "Full extents [x, y, z] — the shape's bounding box, on EVERY shape. Round shapes are not " +
            "restricted to a circular cross-section: a sphere with unequal axes is an ellipsoid (a low dome " +
            "is `[1.7, 0.55, 1.5]`), and cylinder/cone/capsule take their depth from z, so an oval pier is " +
            "`[2, 5, 4]`. Equal axes give exactly the circular shape, so nothing about the round-and-simple " +
            "case changes. `plane` uses x and z (it is built flat and laid down by the renderer); `torus` " +
            "reads x as the outer diameter and y as 4x the tube diameter. NOTE the physics side does not " +
            "follow: a `sphere`/`capsule`/`cylinder` COLLIDER is always circular (Rapier has no ellipsoid), " +
            "so a deliberately squashed visual and its collider diverge — give such a mesh a `box` collider, " +
            "or a `convex` one cooked from the mesh itself.",
        ),
      shading: z
        .enum(["auto", "flat", "smooth"])
        .default("auto")
        .describe(
          "Normal generation. `flat` splits every triangle so each face gets one " +
            "normal — the faceted look, where visible flats catch different light " +
            "values instead of a continuous gradient. Without it a low `segments` " +
            "count gives a faceted OUTLINE with smooth shading across it, which is " +
            "the usual reason an authored low-poly form still reads as a smooth " +
            "cylinder. `auto` and `smooth` both keep three's analytic normals " +
            "(existing behaviour); `auto` exists so a future heuristic can change " +
            "without touching content. Cost: flat un-indexes the geometry, so " +
            "vertex count rises to 3x the triangle count — fine for props, avoid " +
            "on anything dense.",
        ),
      uv: z
        .object({
          mode: z
            .enum(["stretch", "world"])
            .default("stretch")
            .describe(
              "`stretch` (the default, and what every primitive did before this field existed) maps one " +
                "texture tile across each face WHATEVER the face measures, so resizing the primitive " +
                "squashes the texture with it — a 2m wall and a 40m wall of the same material do not match. " +
                "`world` instead sizes the UVs in METRES (`scale`), so the texture holds its real-world " +
                "size as the box is resized and adjacent pieces of different length line up. Unlike the " +
                "material-level `triplanar`, this is computed once into the mesh's own UVs: it costs " +
                "nothing per fragment, and because it is OBJECT-space it survives instancing and moving " +
                "the entity (triplanar, being world-space, does neither).",
            ),
          scale: z
            .tuple([z.number().positive(), z.number().positive()])
            .default([1, 1])
            .describe(
              "World METRES per texture tile [u, v] when mode is `world`. [2, 2] means the texture repeats " +
                "every 2m in both surface axes. The material's own `repeat` still multiplies on top, so " +
                "set that to [1, 1] on materials meant for world-UV meshes or the two multiply.",
            ),
        })
        .optional()
        .describe(
          "How texture coordinates are generated. Omit for the historical stretch-to-fit behaviour. " +
            "Exact for box/wedge/plane (per-face planar projection along the face normal); round shapes " +
            "(cylinder/cone/capsule/sphere/torus) rescale their existing UVs by the real circumference " +
            "and height, which removes the resize-stretch without changing their seams.",
        ),
      segments: z
        .tuple([z.number().int().min(1), z.number().int().min(1)])
        .default([1, 1])
        .describe(
          "Tessellation [a, b], read by EVERY primitive. plane/box: width/height " +
            "subdivisions (a plane is otherwise a bare quad with nothing for a vertex " +
            "shader — e.g. the water shader's waves — to move). cylinder/cone: " +
            "[radialSegments, heightSegments]; sphere: [width, height]; torus: " +
            "[tubular, radial]; capsule: [radial, cap]. RADIAL COUNT IS A STYLE " +
            "CONTROL, not just cost: 6-12 gives deliberately faceted low-poly flats, " +
            "24+ reads as smooth. Omit for the historical high-poly defaults " +
            "(cylinder/cone 24, sphere 32x16, torus 48x16, capsule 16x8), which is " +
            "what existing content gets.",
        ),
    }),
    z.object({
      kind: z.literal("asset"),
      assetId: z.string().min(1),
      /** Named node WITHIN the model — set by "unpack model" to detach parts. */
      node: z.string().optional(),
      foliageNormals: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          "Reshape the ALPHA-CUTOUT parts of this model (a tree's leaves, not its trunk) to shade as a sphere " +
            "about their own centre. Exporters give each leaf card its own flat face normal, several pointing " +
            "straight down, so the canopy lights per-card and binary: one card blown out, the next black, no " +
            "gradation. 1 is a pure sphere, which is right for a rounded canopy; lower keeps some of the card's " +
            "own facing. Omit for the authored normals. The edit is baked into the geometry, so it survives " +
            "instancing and costs nothing per frame.",
        ),
      foliageUp: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          "How far those reshaped normals lean toward straight UP. This is what makes leaves match GRASS: the " +
            "grass component shades its cards with a hard (0,1,0), so a grass field is lit exactly like flat " +
            "ground and is the brightest thing outdoors — a canopy shaded as a pure sphere sits visibly darker " +
            "beside it. 1 reproduces the grass treatment exactly; 0.6-0.9 keeps enough sphere for form.",
        ),
      wind: meshWindSchema
        .optional()
        .describe(
          "Vertex-shader wind. Costs nothing per frame beyond the displacement itself - no CPU animation, " +
            "and it survives instancing, so a whole streamed forest moves for one shader.",
        ),
      cameraFade: z
        .boolean()
        .optional()
        .describe(
          "Dissolve this model when it stands between the third-person camera and the character. A leaf card " +
            "30cm from the near plane is an opaque wall and the player loses their own character behind it; " +
            "the usual alternative (shoving the camera out) trades that for the camera lurching past every " +
            "tree. Only fragments BOTH in front of the character AND near the camera-to-character line fade, " +
            "so foliage merely beside the player stays solid. Stippled, not alpha-blended - see the grass " +
            "component on why blending a cutout is a GPU trap. Runtime state (on/off, who the character is) " +
            "belongs to the app, via setFoliageFade; this field only opts the model in.",
        ),
      brightness: z
        .number()
        .min(0)
        .optional()
        .describe(
          "Multiply this model's base colour. A tool like Blockbench previews a model essentially UNLIT, so the " +
            "same asset always arrives darker in a renderer that lights it for real — this is the grading knob " +
            "for that gap. 1.5 is a noticeable lift. It brightens the lit and unlit sides alike, so it is not a " +
            "fix for a dead shadow side; that wants image-based lighting.",
        ),
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
      /**
       * One streamed cell of a procedural voxel world, polygonized by marching
       * cubes. Deliberately four fields: the world RECIPE
       * (assets/worlds/<world>.json) is the authoring truth and the geometry is
       * a derived cache, so a cell is described by which world and which cell
       * and nothing else. Pair with a collider of shape "trimesh" for physics
       * that matches the visible surface exactly. Written by the voxel streamer,
       * not by hand.
       */
      kind: z.literal("voxel"),
      world: z.string().min(1).describe("World recipe asset id (assets/worlds/<id>, sans extension)."),
      cell: z.tuple([z.number().int(), z.number().int()]).describe("Chunk cell [cx, cz]; geometry is emitted local to the cell origin."),
      lodStep: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe("Coarsen the voxel lattice by this factor (2 = half the samples per axis). Omit for full detail."),
      yRange: z
        .tuple([z.number(), z.number()])
        .optional()
        .describe("Explicit vertical band to mesh. Omit and it is derived from this cell's own terrain plus the recipe's verticalRange."),
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
      thickness: z
        .number()
        .min(0)
        .default(0)
        .describe(
          "ribbon only: raise the strip into a closed slab this thick sitting ON the curve (curve = underside, surface = curve + thickness). 0 = flat sheet.",
        ),
      doubleSided: z
        .boolean()
        .default(false)
        .describe("ribbon only, flat sheet: also render the underside. Ignored when thickness > 0 (a slab is closed)."),
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
  intensity: z
    .number()
    .min(0)
    .default(1)
    .describe(
      'BRIGHTNESS IS THE #1 AUTHORING MISTAKE in enclosed spaces: values that look right on paper render nearly black. ' +
      'Rule of thumb, calibrated against measured screen brightness (an interior shot of a lit room should average ' +
      'mean luma 70-100/255): directional sun 1-2 (exteriors only - it does not reach under a ceiling); ambient 1.2-1.8 ' +
      'for interiors that must read on screen; POINT/SPOT lights in rooms need 6-15, i.e. roughly 3-4x your first ' +
      'instinct - a torch at intensity 2 is a glowing dot that lights nothing. When a whole scene reads dark, also ' +
      'consider postfx.tonemap.exposure (the correct global brightness knob) before touching every light.',
    ),
  /** point/spot only */
  range: z
    .number()
    .min(0)
    .default(10)
    .describe(
      'point/spot only: falloff distance in metres. Size it to the ROOM, not the fixture - a wall torch lighting a ' +
      '6m room wants range 8-12; the default 10 with a low intensity still dies within arm reach. Range without ' +
      'intensity does nothing: raise both together (see intensity).',
    ),
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
  shadow: z
    .object({
      enabled: z
        .boolean()
        .default(true)
        .describe(
          "NOT the on/off switch — `castShadow` is, and it still gates everything here (it defaults false, " +
            "so this block alone never turns a shadow on). This is an override that force-DISABLES the " +
            "shadow while leaving its tuning intact, for quality presets and for temporarily proving a " +
            "light is what's costing frame time.",
        ),
      mapSize: z
        .union([z.literal(512), z.literal(1024), z.literal(2048), z.literal(4096)])
        .default(1024)
        .describe(
          "Shadow-map resolution per side. 1024 is deliberate, not lazy: measured frame timing on this " +
            "engine came back fragment-bound, and cost scales with the SQUARE of this — 2048 is 4x the " +
            "shadow-pass fill. Raise it only for a hero light with a small `shadowSize`; on a big " +
            "directional frustum, `cascades` buys far more sharpness per millisecond.",
        ),
      bias: z
        .number()
        .default(-0.0004)
        .describe(
          "Constant depth offset. Almost always the WRONG knob: enough of it to kill shadow acne detaches " +
            "the shadow from its caster (peter-panning). Reach for `normalBias` first and leave this alone.",
        ),
      normalBias: z
        .number()
        .min(0)
        .default(0.02)
        .describe(
          "Offsets the shadow lookup along the surface normal, which is the correct fix for acne: it " +
            "scales with the geometry instead of with depth, so it removes the striping without floating " +
            "the shadow off the caster. Raise this (0.02 -> 0.1) before touching `bias`. Too much makes " +
            "thin geometry leak light at its base.",
        ),
      radius: z
        .number()
        .min(0)
        .default(1)
        .describe("PCF blur radius in shadow-map texels — a fixed texel count, so the world-space softness it buys shrinks as `shadowSize` grows."),
      cascades: z
        .number()
        .int()
        .min(1)
        .max(4)
        .default(1)
        .describe(
          "DIRECTIONAL LIGHTS ONLY (ignored on point/spot). Splits the view distance into N shadow maps so " +
            "near geometry gets fine texels and far geometry still gets covered — the fix for the choice " +
            "between blocky near shadows and no distant ones. Each cascade is a full extra shadow render " +
            "pass, so 3 is the usual sweet spot and 4 is for a showcase shot.",
        ),
      cascadeSplit: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .describe(
          "Blend between uniform splits (0 — even world-space slabs, wastes resolution up close) and " +
            "logarithmic splits (1 — perceptually correct, but the last cascade gets enormous and its " +
            "seam becomes visible). The practical-split default 0.5 is what shipped engines use.",
        ),
      far: z
        .number()
        .min(0)
        .default(0)
        .describe(
          "Far plane of the shadow camera, world units. 0 = auto, which reproduces today's behaviour " +
            "exactly: max(120, shadowSize * 3). Set it explicitly only to tighten depth precision — a far " +
            "plane much larger than the scene wastes the whole depth range and reintroduces acne.",
        ),
    })
    .prefault({})
    .describe(
      "Shadow QUALITY for this light. Present on every light kind, but `cascades`/`cascadeSplit` apply to " +
        "directional only, and the frustum extent still comes from the sibling `shadowSize`.",
    ),
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

/** One splat layer: a color/roughness (and optional texture) blended in by height or by vertex weight. */
const splatLayerSchema = z.object({
  color: hexColor.default("#9aa0a8"),
  roughness: z.number().min(0).max(1).default(0.9),
  heightStart: z.number().default(0).describe("Local Y where this layer starts blending in. Only read when splat.source is 'height'."),
  heightEnd: z.number().default(10).describe("Local Y where this layer is fully blended in. Only read when splat.source is 'height'."),
  grassy: z
    .boolean()
    .default(false)
    .describe(
      "Adds cheap procedural mottling (no textures/geometry — a per-pixel color variation) so this " +
        "layer reads as grass texture instead of a flat tint. Meant for exactly one grass-colored layer. " +
        "Skip it once the layer has a real `map`.",
    ),
  map: z
    .string()
    .optional()
    .describe(
      "Texture asset id (assets/textures/) for this layer's albedo, projected TRIPLANAR from world space. " +
        "Triplanar is not optional here: voxel terrain has cliffs and overhangs with no sane UV unwrap, " +
        "and it is also what keeps one texture continuous across a chunk seam. `color` still tints it.",
    ),
  normalMap: z.string().optional().describe("Tangent-space normal map for this layer, sampled triplanar alongside `map`."),
  uvScale: z
    .number()
    .positive()
    .default(4)
    .describe("World units per texture tile for this layer. Larger = coarser. Give neighbouring layers different scales or their tiling beats in sync."),
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
  uvOffset: z
    .tuple([z.number(), z.number()])
    .default([0, 0])
    .describe(
      "Texture UV offset [u, v], applied to EVERY map on this material (they share one UV transform — " +
        "there is no per-map offset). Use it to break the phase of a repeating surface between two " +
        "otherwise-identical materials so adjacent walls don't line their tiles up.",
    ),
  roughness: z.number().min(0).max(1).default(0.85),
  metalness: z.number().min(0).max(1).default(0.05),
  normalMap: z
    .string()
    .optional()
    .describe(
      "Texture asset id — tangent-space normal map (OpenGL convention: +Y up/green channel points up; " +
        "a DirectX-convention map renders with its lighting inverted along one axis and looks subtly " +
        "'inside out'). This is the single biggest step from 'flat plastic' to a real surface.",
    ),
  normalScale: z
    .number()
    .min(0)
    .max(4)
    .default(1)
    .describe(
      "Multiplier on `normalMap` strength. 0 flattens it entirely; >1 exaggerates (useful for rescuing a " +
        "weak bake, but past ~2 the lighting starts to contradict the silhouette and reads as noise).",
    ),
  roughnessMap: z
    .string()
    .optional()
    .describe(
      "Texture asset id — GREYSCALE roughness, MULTIPLIED against the `roughness` scalar (it does not " +
        "replace it). So leaving `roughness` at its 0.85 default caps the whole surface near-matte no " +
        "matter what the map says: set the scalar to 1 when you want the map to speak for itself.",
    ),
  metalnessMap: z
    .string()
    .optional()
    .describe(
      "Texture asset id — GREYSCALE metalness, MULTIPLIED against the `metalness` scalar (same trap as " +
        "`roughnessMap`: the 0.05 default scalar will mute the map to nothing — raise it to 1).",
    ),
  aoMap: z
    .string()
    .optional()
    .describe(
      "Texture asset id — GREYSCALE baked ambient occlusion. Only darkens INDIRECT/ambient light, never " +
        "direct light, so a scene with no environment/hemisphere contribution shows almost no effect from it.",
    ),
  aoIntensity: z
    .number()
    .min(0)
    .max(1)
    .default(1)
    .describe("How much of `aoMap` (or the ORM red channel) is applied. 0 = ignored, 1 = full."),
  ormMap: z
    .string()
    .optional()
    .describe(
      "Texture asset id — one packed map holding Occlusion in R, Roughness in G, Metalness in B (the glTF " +
        "metallicRoughness convention, with AO folded into R). TAKES PRECEDENCE: when present the renderer " +
        "must ignore `aoMap`/`roughnessMap`/`metalnessMap` entirely rather than compositing both. Saves 2 " +
        "texture fetches and 2 uploads per material, so prefer it for anything used across a whole level.",
    ),
  detailNormalMap: z
    .string()
    .optional()
    .describe(
      "Texture asset id — a second, high-frequency normal map tiled independently (`detailRepeat`) and " +
        "blended over `normalMap`. This is the anti-tiling tool: it breaks up the repeat of a large surface " +
        "at close range, where the base map's tiling would otherwise be obvious. BIBLE §3.6/§9 make a " +
        "visible tiling repeat an automatic quality fail, so on any wall/floor/ground material this is " +
        "load-bearing, not polish.",
    ),
  detailRepeat: z
    .tuple([z.number(), z.number()])
    .default([8, 8])
    .describe(
      "Tiling [u, v] of `detailNormalMap`, INDEPENDENT of `repeat` — it must be a non-integer multiple of " +
        "`repeat` or the two maps beat in sync and you have re-created the repeat you were hiding.",
    ),
  detailStrength: z
    .number()
    .min(0)
    .max(2)
    .default(1)
    .describe("Blend weight of `detailNormalMap` over the base normal. 0 disables the overlay."),
  filter: z
    .enum(["linear", "nearest"])
    .default("linear")
    .describe(
      "Texture magnification. 'nearest' keeps hard texel edges for PIXEL ART, which linear filtering smears " +
        "into mush the moment the camera is close. Minification still mipmaps either way — nearest minification " +
        "of a tiling texture across a hillside shimmers, which is the usual reason 'I set nearest and the " +
        "distance got worse'. Applies to every map on this material, and to every splat layer.",
    ),
  triplanar: z
    .boolean()
    .default(false)
    .describe(
      "Project every texture from world space on the three axes instead of using the mesh UVs — for cliff, " +
        "cave and sculpted-terrain geometry that has no sane unwrap (or none at all). COSTS 3x TEXTURE " +
        "FETCHES per map: use it on organic rock, never on props or anything instanced thousands of times. " +
        "Because it is world-space, the texture stays put when the mesh moves — wrong for anything a script " +
        "animates.",
    ),
  triplanarScale: z
    .number()
    .positive()
    .default(1)
    .describe(
      "World units per texture tile when `triplanar` is on (`repeat`/`uvOffset` are UV-space and do not " +
        "apply). Higher = larger, coarser features.",
    ),
  alphaMap: z
    .string()
    .optional()
    .describe(
      "Texture asset id — GREYSCALE opacity mask (black = cut away). Needs `transparent: true` for soft " +
        "edges, or `alphaTest` > 0 for hard cutout; with neither it has no visible effect.",
    ),
  alphaTest: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe(
      "Discard fragments whose alpha is below this. 0 = off. Non-zero gives foliage/grates a hard cutout " +
        "that writes depth and sorts correctly — prefer it over `transparent` for anything dense, which " +
        "otherwise produces the classic see-through-leaves sorting mess.",
    ),
  envMapIntensity: z
    .number()
    .min(0)
    .default(1)
    .describe(
      "Scales this material's reflection of the scene environment (`sky.environment`). Only does anything " +
        "when an environment map exists; with none, raising it will not rescue a black metal.",
    ),
  side: z
    .enum(["front", "back", "double"])
    .default("front")
    .describe(
      '"double" renders backfaces too (cloth, leaves, single-plane geometry) at 2x fragment cost and with ' +
        "no shadow-caster winding to rely on; \"back\" is for inside-out geometry such as a sky/room shell.",
    ),
  vertexColors: z
    .boolean()
    .default(false)
    .describe(
      "Multiply the base color by the mesh's per-vertex colors. The renderer ALREADY enables this " +
        "automatically for tinted poly meshes, so setting it here is only for glTF assets (or other " +
        "imported geometry) that ship a COLOR_0 attribute the engine can't infer — a cheap way to break " +
        "tiling with large-scale tint variation.",
    ),
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
      source: z
        .enum(["height", "vertex"])
        .default("height")
        .describe(
          "Where the blend weights come from. 'height' = each layer overtakes the previous through its own " +
            "[heightStart, heightEnd] band (heightmap terrain). 'vertex' = the mesh carries a per-vertex vec4 " +
            "weight, which is what marching-cubes voxel terrain generates from its biome rules — that is the " +
            "only way a desert and a snowfield at the SAME altitude can look different. A 'vertex' material on " +
            "geometry with no splat attribute falls back to height bands rather than rendering untextured.",
        ),
      layers: z
        .array(splatLayerSchema)
        .min(2)
        .max(8)
        .describe(
          "Up to four surfaces. With source 'height' they are ascending bands; with source 'vertex' the array " +
            "ORDER is the weight vector's channel order and must match the world recipe's `surfaces`.",
        ),
      slopeRock: z
        .object({
          color: hexColor.default("#8a8378"),
          roughness: z.number().min(0).max(1).default(0.95),
          start: z.number().min(0).max(1).default(0.55).describe("Steepness (0=flat,1=vertical) where rock starts."),
          end: z.number().min(0).max(1).default(0.8),
        })
        .optional()
        .describe(
          "Blends a rock color over steep slopes regardless of height band (cliffs, crater rims). Mostly for " +
            "source 'height'; with 'vertex' the biome rules already carry their own cliff surfaces, so this " +
            "layers a second, global cliff tint on top of them.",
        ),
      tintByVertexColor: z
        .boolean()
        .default(false)
        .describe(
          "Multiply the blended result by the mesh's per-vertex color. Voxel terrain writes its per-biome tint " +
            "there, which is how two biomes sharing the grass channel still read as different places.",
        ),
      macroNoise: z
        .object({
          scale: z
            .number()
            .positive()
            .default(90)
            .describe("World units per cycle of the broad band. Well clear of any layer's `uvScale` — that mismatch is the whole point."),
          strength: z.number().min(0).max(1).default(0.22).describe("How far the broad band swings brightness, plus and minus. 0.22 is a visible but natural mottle."),
          octaves: z.number().int().min(1).max(6).default(3),
          detailScale: z
            .number()
            .positive()
            .optional()
            .describe("Second, finer band, near tile size (10-20 world units). This is the one that breaks the visible grid up close; the broad band only fixes the view to the horizon."),
          detailStrength: z.number().min(0).max(1).default(0.1).describe("Swing of the detail band. Read only when `detailScale` is set."),
          roughnessStrength: z
            .number()
            .min(0)
            .max(1)
            .default(0)
            .describe("Optional matching swing on roughness. Terrain that tiles in specular under a low sun needs this; flat-lit terrain does not."),
          colorStrength: z
            .number()
            .min(0)
            .max(1)
            .default(0)
            .describe(
              "How far the overlay shifts COLOUR, per channel, on top of the brightness swing. Brightness alone " +
                "makes a large area read as one material under uneven light; letting the channels drift apart " +
                "slightly — warmer here, greyer there — is what reads as the ground actually being different from " +
                "place to place. 0.06-0.15 is a natural mottle; past ~0.25 the terrain goes tie-dye.",
            ),
          colorScale: z
            .number()
            .positive()
            .optional()
            .describe("World units per cycle of the colour band. Defaults to `scale`. Set it larger for broad regional colour shifts that survive being seen from a distance."),
          colorOctaves: z.number().int().min(1).max(6).default(3),
          warp: z
            .number()
            .min(0)
            .default(0)
            .describe(
              "How far the texture PROJECTION is pushed around by noise before it is sampled, as a fraction of each " +
                "layer's OWN tile, so one setting means the same thing to a 3.5m grass tile and a 9m cliff tile. This " +
                "is the one that actually kills tiling: brightness noise can only shade OVER a grid, and the grid is " +
                "still underneath it — on a big flat-lit face seen from a distance the eye finds it anyway. Warping " +
                "the projection means neighbouring tiles no longer line up, so there is no grid left to find. " +
                "0.25-0.5 is usually enough; past about 0.6 the texture visibly smears.",
            ),
          warpScale: z
            .number()
            .positive()
            .default(18)
            .describe(
              "World units per cycle of the warp. Measured: keep it near TWICE the tile size, not far above it. A warp " +
                "much coarser than the tile slides whole tiles around and leaves the motif inside each one perfectly " +
                "intact, so a strongly patterned texture still reads as a pattern; a warp at roughly tile scale distorts " +
                "the motif itself, which is what stops a big rock face looking stamped.",
            ),
        })
        .optional()
        .describe(
          "Breaks up texture repetition by multiplying gradient-noise brightness over the WHOLE blended " +
            "result — one overlay across every layer, not a per-layer effect. Tiling reads as tiling because " +
            "the same pattern recurs on a fixed grid; a second variation at a scale that shares no factor with " +
            "the tile hides that grid without touching the art. Costs two noise evaluations per fragment and " +
            "no texture fetches, so it is far cheaper than the stochastic-sampling alternative (3x the fetches).",
        ),
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
      texture: z
        .string()
        .optional()
        .describe(
          "Surface texture ADDED over the procedural water, scrolled in two directions at two scales so it " +
            "never reads as one tile sliding past. It contributes light rather than replacing colour, so the " +
            "depth banding, shoreline foam and fresnel rim underneath all survive — the texture supplies the " +
            "moving detail those cannot.",
        ),
      textureScale: z
        .number()
        .positive()
        .default(24)
        .describe("World units per texture tile. Sampled in WORLD XZ, not UV, so tiling is continuous across a huge plane and independent of how the mesh happens to be unwrapped."),
      textureStrength: z
        .number()
        .min(0)
        .default(0.9)
        .describe("How far the surface reads as the TEXTURE rather than the procedural bands. 1 is texture-led (still shaded by depth, foam and fresnel); low values leave it as a faint tint over the original look."),
      foamPixel: z
        .number()
        .min(0)
        .default(0.7)
        .describe(
          "World units per foam BLOCK. The shoreline band's breakup is sampled on a snapped grid, so the edge " +
            "steps in squares of this size instead of wandering smoothly — which is what makes it sit beside " +
            "nearest-filtered pixel-art terrain instead of looking airbrushed onto it. 0 disables the snap.",
        ),
      foamSteps: z
        .number()
        .int()
        .min(1)
        .max(8)
        .default(3)
        .describe("Quantisation levels in the foam band. Fewer = chunkier, more poster-like; 1 is a hard on/off edge."),
      flow: z
        .tuple([z.number(), z.number()])
        .default([0.012, 0.008])
        .describe(
          "Texture drift in tiles per second [x, z]. The second sample layer moves at a different scale and " +
            "roughly perpendicular, which is what stops the eye locking onto a single repeating direction.",
        ),
    })
    .optional()
    .describe(
      "Only read when shader is 'water'. Procedural by default (no textures needed) — depth-based " +
        "color and shoreline foam read the depth buffer against whatever's actually beneath the " +
        "surface, so they need real opaque geometry (terrain/seafloor) there to work. Add `texture` " +
        "for scrolling surface detail on top.",
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
      mode: z
        .enum(["linear", "exponential", "height"])
        .default("linear")
        .describe(
          "WHICH FIELDS ARE READ depends on this, and the unread ones are silently ignored — the usual " +
            "cause of 'my fog settings do nothing'. linear: `near` + `far` only. exponential: `density` " +
            "only (near/far ignored) — never fully opaque, so distant geometry stays faintly visible " +
            "instead of hitting a hard wall. height: `density` + `heightFalloff` + `baseHeight` " +
            "(near/far ignored) — fog thins with altitude, which is what makes a cave floor or valley " +
            "read as deep while the space above it stays clear.",
        ),
      near: z.number().positive().default(40).describe("linear mode only: distance where fog starts."),
      far: z.number().positive().default(180).describe("linear mode only: distance of full fog."),
      density: z
        .number()
        .min(0)
        .default(0.015)
        .describe(
          "exponential/height modes only: fog per world unit. Scale-sensitive — 0.015 suits a ~200-unit " +
            "view; halve it for every doubling of the space, or the far wall of a large hall vanishes.",
        ),
      heightFalloff: z
        .number()
        .min(0)
        .default(0.15)
        .describe(
          "height mode only: how fast density decays going up, per world unit above `baseHeight`. " +
            "0 degenerates to plain exponential fog; 0.1-0.3 gives a visible fog layer a few metres deep.",
        ),
      baseHeight: z
        .number()
        .default(0)
        .describe("height mode only: WORLD Y (not entity-local) of the densest fog layer — set it to the floor of the space, not to 0 out of habit."),
    })
    .optional(),
  volumetric: z
    .object({
      enabled: z.boolean().default(false),
      intensity: z.number().min(0).max(4).default(1).describe("Brightness of the shafts. This is additive light — heavy values wash out the three-value read (BIBLE §3.2)."),
      samples: z
        .number()
        .int()
        .min(8)
        .max(128)
        .default(32)
        .describe("Ray-march steps. The dominant cost, and the dominant source of banding when too low — pair a low count with `postfx.grain` to hide it."),
      decay: z.number().min(0).max(1).default(0.95).describe("Per-sample attenuation along the ray; lower = shorter, stubbier shafts."),
      density: z.number().min(0).max(1).default(0.5).describe("Amount of participating medium. Needs `fog` to be believable — shafts in clear air read as a bug."),
    })
    .prefault({})
    .describe(
      "God rays / light shafts. Screen-space: a shaft only appears where its source is ON SCREEN or just " +
        "off the edge, so the effect pops in and out as the camera turns — frame the source deliberately. " +
        "Driven by the sun first; spotlight shafts are per-light and far more expensive.",
    ),
  environment: z
    .object({
      mode: z
        .enum(["none", "sky", "hdri"])
        .default("sky")
        .describe(
          "Source of image-based lighting (the reflections and ambient bounce). sky = generate it from " +
            "this sky's own gradient/texture/cubemap (free, always consistent with the background); hdri " +
            "= use `hdri`; none = no environment at all. WITH `none`, ANY `metalness: 1` MATERIAL RENDERS " +
            "NEAR-BLACK — a metal is nothing but its reflection, so with nothing to reflect there is " +
            "nothing to see. That is the single most common 'why does my metal look wrong'.",
        ),
      hdri: z
        .string()
        .optional()
        .describe("hdri mode only: equirectangular texture asset id (.hdr/.exr for real range; an 8-bit jpg/png gives dull, clipped reflections)."),
      intensity: z.number().min(0).default(1).describe("Scales the environment's contribution scene-wide. Per-material trim lives on `material.envMapIntensity`."),
      rotation: z
        .number()
        .default(0)
        .describe("Yaw of the environment around world Y, in RADIANS. Use it to line the HDRI's own sun up with the scene's directional light — mismatched reflections read as wrong before anyone can say why."),
    })
    .prefault({})
    .describe("Image-based lighting. Independent of the visible background: `mode: \"hdri\"` lights the scene from the HDRI while the dome/cubemap still draws behind it."),
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
 * own `{ enabled, ...params }` block, and every block defaults to disabled
 * (except `tonemap`, which defaults ON to match what the renderer already did
 * unconditionally) — so adding a block never changes an existing scene.
 *
 * Order is fixed by the renderer, not by this document: the stack runs
 * AO -> bloom -> DoF -> motion blur -> tonemap -> grade -> chromatic aberration
 * -> vignette -> grain -> sharpen -> antialias. Grading before tonemapping and
 * grain before tonemapping are both classic mistakes — the pass order here is
 * the fix, so authors only pick values, never sequence.
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
  tonemap: z
    .object({
      enabled: z
        .boolean()
        .default(true)
        .describe(
          "Defaults TRUE, unlike every other block here: the renderer has always applied ACES filmic " +
            "tonemapping unconditionally, so `enabled: true` + `mode: \"aces\"` IS the pre-existing " +
            "behaviour, not a new effect. Setting false renders raw linear values and will clip anything " +
            "above 1.0 to flat white.",
        ),
      mode: z
        .enum(["aces", "agx", "neutral", "reinhard", "linear"])
        .default("aces")
        .describe(
          "aces = filmic, punchy, crushes saturated highlights toward white (today's default); agx = " +
            "wider latitude, holds hue in bright emissives — best when bloom is heavy; neutral = " +
            "Khronos PBR neutral, closest to the authored albedo (good for asset review); reinhard = " +
            "flat/soft; linear = none (same as enabled:false).",
        ),
      exposure: z
        .number()
        .min(0.05)
        .max(8)
        .default(1)
        .describe(
          "Linear exposure multiplier applied BEFORE the tone curve — this is the correct global " +
            "brightness knob. Raising light intensities instead pushes everything into the curve's " +
            "shoulder and desaturates the scene.",
        ),
    })
    .prefault({}),
  ao: z
    .object({
      enabled: z.boolean().default(false),
      intensity: z.number().min(0).max(2).default(1).describe("Strength of the occlusion darkening. >1 is stylized, not physical."),
      radius: z
        .number()
        .positive()
        .default(0.5)
        .describe(
          "Sample radius in WORLD UNITS — the scale of the contact darkening. Small (0.2-0.5) gives tight " +
            "crease/contact shadows; large (2+) gives broad cavity shading and starts haloing silhouettes.",
        ),
      distanceFalloff: z
        .number()
        .min(0)
        .max(1)
        .default(1)
        .describe(
          "Fades occlusion out with depth difference, which is what stops a foreground object from " +
            "smearing a dark halo onto distant background. Lower it only if AO is disappearing in big open space.",
        ),
      samples: z
        .number()
        .int()
        .min(4)
        .max(64)
        .default(16)
        .describe("Rays per pixel. Cost is linear in this; 16 with `denoise` on beats 32 without."),
      denoise: z
        .boolean()
        .default(true)
        .describe("Bilateral blur over the AO buffer. Off, low sample counts read as crawling grain in motion."),
    })
    .prefault({})
    .describe(
      "Screen-space ambient occlusion: darkens where surfaces meet, which is what makes objects sit ON the " +
        "ground rather than float above it. BIBLE §3.5 leans on this for cave depth — unlit rock with no AO " +
        "reads as a flat grey wall no matter how good the material is.",
    ),
  grade: z
    .object({
      enabled: z.boolean().default(false),
      contrast: z.number().min(0).max(4).default(1).describe("1 = unchanged. Pivots around mid-grey."),
      saturation: z.number().min(0).max(4).default(1).describe("1 = unchanged, 0 = greyscale, >1 pushes chroma."),
      temperature: z
        .number()
        .min(-1)
        .max(1)
        .default(0)
        .describe("White balance: negative = cooler/blue, positive = warmer/orange. 0 = unchanged."),
      tint: z.number().min(-1).max(1).default(0).describe("The green/magenta axis, perpendicular to `temperature`. 0 = unchanged."),
      lift: hexColor
        .default("#808080")
        .describe(
          "Shadow-range color offset. NEUTRAL IS #808080, NOT #000000 — this is a genuine footgun: each " +
            "channel is read as (value - 0.5), so #808080 means 'no change' and #000000 means 'crush every " +
            "shadow to black'. Same convention for `gamma` and `gain`.",
        ),
      gamma: hexColor.default("#808080").describe("Midtone color offset. #808080 = neutral (see `lift`)."),
      gain: hexColor.default("#808080").describe("Highlight color offset. #808080 = neutral (see `lift`)."),
      lut: z
        .string()
        .optional()
        .describe(
          "Texture asset id of a color lookup table (strip or 2D-tiled cube). Applied AFTER the numeric " +
            "knobs above, so a LUT baked from a graded still will double-apply anything you also dial in here.",
        ),
    })
    .prefault({})
    .describe("Color grading, applied after tonemapping so the values it sees are already display-referred."),
  vignette: z
    .object({
      enabled: z.boolean().default(false),
      amount: z.number().min(0).max(1).default(0.5).describe("Darkening at the very corners. 0 = none."),
      radius: z.number().min(0).max(1).default(0.75).describe("Fraction of the half-diagonal that stays untouched."),
      smoothness: z.number().min(0).max(1).default(0.4).describe("Width of the falloff band. Low values give a visible hard ring."),
    })
    .prefault({}),
  grain: z
    .object({
      enabled: z.boolean().default(false),
      amount: z.number().min(0).max(1).default(0.06).describe("Noise strength. Above ~0.15 it stops reading as film and starts reading as a broken encoder."),
      size: z.number().min(0.1).max(8).default(1).describe("Grain cell size in pixels; 1 = per-pixel."),
    })
    .prefault({})
    .describe(
      "Film grain. MUST be re-seeded every frame by the renderer — a static noise pattern does not read as " +
        "grain, it reads as dirt on the lens (or a dirty monitor), and it is instantly obvious in motion. " +
        "Its real job is hiding banding in the dark gradients that fog and vignette create.",
    ),
  chromaticAberration: z
    .object({
      enabled: z.boolean().default(false),
      amount: z
        .number()
        .min(0)
        .max(1)
        .default(0.005)
        .describe(
          "Maximum red/blue split at the screen edge, as a fraction of screen width. 0.002-0.01 is the " +
            "tasteful range; anything an audience can consciously notice is already too much.",
        ),
    })
    .prefault({}),
  dof: z
    .object({
      enabled: z.boolean().default(false),
      focusDistance: z
        .number()
        .positive()
        .default(10)
        .describe("Distance from the camera to the sharp plane, in WORLD UNITS (the renderer converts to whatever the pass wants)."),
      focalLength: z.number().positive().default(35).describe("Lens focal length in mm. Longer = shallower depth of field at the same aperture."),
      bokehScale: z.number().min(0).max(8).default(2).describe("Size of the out-of-focus circle of confusion."),
      maxBlur: z.number().min(0).max(1).default(0.5).describe("Hard clamp on blur radius — the guard against a distant background smearing across the whole frame."),
    })
    .prefault({})
    .describe(
      "Depth of field. In a first/third-person game this is a cutscene/ADS tool: a permanently blurred " +
        "background fights the player's own eye focus and reads as a rendering fault.",
    ),
  antialias: z
    .object({
      mode: z
        .enum(["none", "fxaa", "smaa", "taa"])
        .default("fxaa")
        .describe(
          "MSAA IS NOT AN OPTION HERE — once the frame goes through the node post pipeline the effects run " +
            "on a resolved single-sample buffer, so anti-aliasing has to be a post pass. fxaa = cheapest, " +
            "softens texture detail; smaa = better edges, more cost; taa = best, but needs motion vectors " +
            "and a jittered projection from the renderer, and ghosts on anything the motion vectors miss " +
            "(vertex-animated water, grass sway, particles).",
        ),
    })
    .prefault({}),
  motionBlur: z
    .object({
      enabled: z.boolean().default(false),
      amount: z.number().min(0).max(1).default(0.3).describe("Shutter length as a fraction of the frame interval."),
      samples: z.number().int().min(2).max(32).default(12).describe("Taps along the velocity vector; too few reads as ghost-stepping, not blur."),
    })
    .prefault({})
    .describe("Per-object motion blur. Shares the motion-vector buffer with `antialias: \"taa\"` — enabling both costs that buffer once, not twice."),
  sharpen: z
    .object({
      enabled: z.boolean().default(false),
      amount: z.number().min(0).max(2).default(0.4).describe("Contrast-adaptive sharpen strength. Its main use is buying back the texture detail FXAA/TAA softened."),
    })
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
  spread: z
    .number()
    .min(0)
    .max(180)
    .default(0)
    .describe(
      "Half-angle, in degrees, that each particle's launch direction is randomised within — on ANY shape, " +
        "unlike coneAngle. 0 fires every particle along `direction` in exact parallel, which is right for a " +
        "jet and wrong for anything suspended: a box of specks all falling parallel reads as SNOW. 180 is a " +
        "full sphere, the usual choice for dust hanging in the air.",
    ),
  turbulence: z
    .number()
    .min(0)
    .default(0)
    .describe(
      "Strength of a smooth per-particle wander field, units/sec^2. This is what makes dust look airborne " +
        "rather than falling — motes curl past each other instead of tracking straight lines. Pair it with " +
        "`drag` so the wander stays a drift instead of accumulating into a drift-off.",
    ),
  turbulenceSpeed: z
    .number()
    .min(0)
    .default(1)
    .describe("How fast the wander field evolves. Low (~0.2) is a lazy indoor drift; high is agitated."),
  fadeIn: z
    .number()
    .min(0)
    .max(0.9)
    .default(0)
    .describe(
      "Fraction of each particle's life spent ramping up from nothing to `opacityStart`. Anything meant to " +
        "already be there — dust, fog, embers — needs this: with 0 every particle POPS into existence at " +
        "full strength, which is the single clearest tell that an ambient effect is being spawned at you.",
    ),
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
 * A ground-cover layer: thousands of camera-following instances scattered
 * within `radius` of the camera and laid onto whatever terrain is underfoot
 * (heightmap tiles or a generated voxel world). Rendered by a custom instanced
 * system in @hitreg/render with TSL wind sway anchored at the base.
 *
 * With no `texture` each instance is a procedural coloured triangle blade;
 * with one it is intersecting textured quads — grass tufts, brambles, ferns.
 * `{ "grass": {} }` is a working default patch.
 *
 * MULTIPLE LAYERS are the intended use: one entity per cover type, each with
 * its own texture, density and `surfaces` gate, so dense grass and sparse
 * bramble are two rows of JSON rather than one compromise.
 */
export const grassSchema = z.object({
  bladeColor: hexColor.default("#3f7d34"),
  tipColor: hexColor.default("#8fd15c"),
  bladeWidth: z.number().positive().default(0.06),
  bladeHeight: z.number().positive().default(0.55),
  texture: z
    .string()
    .optional()
    .describe(
      "Billboard texture asset id. With one set, each instance becomes intersecting textured quads " +
        "(`crossQuads`) with an alpha cutout instead of a procedural triangle blade — which is how you get " +
        "actual grass tufts, brambles or ferns rather than a coloured wedge. `bladeWidth`/`bladeHeight` are " +
        "then the quad's world size.",
    ),
  crossQuads: z
    .number()
    .int()
    .min(1)
    .max(3)
    .default(2)
    .describe(
      "Textured layers only: quads per instance, evenly rotated about Y. 1 is a single card and reads flat " +
        "from the side; 2 is the standard cross and is nearly always right; 3 costs 50% more for a little more " +
        "volume at close range.",
    ),
  alphaTest: z
    .number()
    .min(0)
    .max(1)
    .default(0.35)
    .describe("Texture alpha below which a fragment is discarded. Cutout, not blending — so no sort order to get wrong."),
  surfaces: z
    .array(z.string())
    .default([])
    .describe(
      "Terrain SURFACE names this may grow on (a voxel world's palette: grass, sand, dirt…). Empty = anywhere " +
        "the host allows. Gating on the surface rather than the biome is what makes it agree with what you can " +
        "SEE: a worn dirt patch inside a meadow grows no grass, because the ground there is not grass.",
    ),
  minSurface: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe("Combined weight those surfaces must reach. 0.5 = the ground mostly reads as one of them; lower spreads a sparse layer over its fringes."),
  slopeMax: z
    .number()
    .min(0)
    .max(1)
    .default(0.7)
    .describe("Steepest ground it will grow on, as sin(angle) — the same units as a biome's `cliffStart`. 0.7 is 45 degrees."),
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
  registerPlacementComponent(registry);
  registerDecalComponent(registry);
  registerPhysicsComponents(registry);
  registerPathComponents(registry);
  registerVoxelComponents(registry);
}

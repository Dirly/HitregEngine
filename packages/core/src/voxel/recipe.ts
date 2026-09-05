import { z } from "zod";
import { hexColor, meshWindSchema, MAX_SPLAT_LAYERS } from "../components/core.js";

/**
 * The world recipe: a small, hand-editable JSON document that fully determines
 * an infinite procedural world. **This is the authoring truth** — the meshes,
 * colliders, trees and towns derived from it are caches, exactly like every
 * other derived artifact in the engine (ARCHITECTURE.md §2).
 *
 * It is deliberately shaped for the pipeline this engine is building toward:
 *
 * ```text
 * noise field  ->  carve streams  ->  mark towns  ->  carve roads  ->  place POIs  ->  WFC buildings
 * ```
 *
 * Every later stage writes its result back into `features` as a handful of
 * lines of JSON — a river is a polyline with a width, a town is a disc with a
 * target height — and the field re-derives the terrain around them. That
 * keeps the whole world legible and diffable at every stage instead of baking
 * an unreadable heightmap the moment the first stream is cut.
 */

/**
 * Hard cap on surface channels.
 *
 * You pay for what you USE, not for this number: the mesher's per-vertex splat
 * is exactly `surfaces.length` wide, the geometry emits `ceil(length / 4)`
 * vec4 attributes, and the shader blends `length` layers. A world with six
 * surfaces costs precisely what a six-surface world cost when this constant
 * was six.
 *
 * What the cap protects is the fragment shader, where the real cost is: each
 * ACTIVE layer is three more triplanar fetches (six with a normal map). Eight
 * albedo layers is 24 fetches; sixteen is 48, which is a lot of texturing to
 * ask for on ground. Past sixteen the answer is not a bigger number here —
 * it is a texture ARRAY with per-vertex layer indices, so a vertex samples
 * only the three or four layers it actually blends however big the palette
 * gets.
 */
export const MAX_SURFACES = MAX_SPLAT_LAYERS;

const fbmSchema = z.object({
  frequency: z.number().positive().describe("Cycles per world unit. 0.0008 = continents, 0.01 = hills, 0.08 = rocks."),
  amplitude: z.number().describe("World units this band contributes (ridged bands run 0..amplitude, others +/-amplitude)."),
  octaves: z.number().int().min(1).max(10).default(4),
  lacunarity: z.number().positive().default(2),
  gain: z.number().min(0).max(1).default(0.5),
  ridged: z
    .boolean()
    .default(false)
    .describe("Sharp crests, flat valleys — the difference between rolling hills and a mountain range."),
  seed: z.number().int().default(0).describe("Added to the world seed so two identically-tuned bands still differ."),
  erosion: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Slope-weighted octaves: fine detail is damped where the band is already steep, so valleys come out " +
        "smooth and walkable while ridgelines stay crisp. This is the single biggest lever against terrain " +
        "that reads as jagged noise — plain fBm puts the same 30 m crinkle on every slope in the world. " +
        "0.3-0.6 on the mountain band; costs ~40% more per octave (derivative noise).",
    ),
  crest: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Ridged bands only: round the crests. The ridged fold puts a knife-edge crease at every ridgeline and " +
        "summit of every octave, and the voxel mesh renders each one as a corner it cannot smooth — the " +
        "'cliffs that come to a sharp edge at the top'. 0 (default) keeps the crease; 0.2 rounds each crest " +
        "over about a fifth of the band's swing without moving the summit line. Free.",
    ),
});

export type FbmSpecDoc = z.infer<typeof fbmSchema>;

const polylineSchema = z
  .array(z.tuple([z.number(), z.number()]))
  .min(2)
  .describe("World-space XZ control points; the feature is the polyline through them.");

/** A watercourse carved into the heightfield. Written by `worldgen rivers`. */
export const riverSchema = z.object({
  id: z.string().default("river"),
  points: polylineSchema,
  width: z.number().positive().default(8).describe("Full channel width at the bed."),
  widths: z
    .array(z.number().positive())
    .optional()
    .describe(
      "Per-point channel width, same length as `points`, overriding `width` along the channel: a river that " +
        "widens as tributaries join and swells around its bends. `width` must still be the WIDEST of them (it " +
        "sizes the carve's reach and the bank). `worldgen rivers` writes both.",
    ),
  depth: z.number().positive().default(3).describe("How far below the surrounding land the bed sits."),
  depths: z
    .array(z.number().positive())
    .optional()
    .describe(
      "Per-point channel depth, same length as `points`, overriding `depth` along the channel: a stream a " +
        "metre deep at its head that is six metres deep where it meets the sea. The water surface sits 0.7 of " +
        "the local depth over the bed. `depth` must still be the DEEPEST. `worldgen rivers` writes both.",
    ),
  bank: z
    .number()
    .min(0)
    .default(14)
    .describe(
      "Extra distance over which the banks ease back up to natural terrain, at the channel's WIDEST; where " +
        "`widths` are given the local bank is min(bank, 0.7 × local width + 3).",
    ),
  /** Optional explicit bed height per control point — a real river only flows downhill. */
  bedY: z
    .array(z.number())
    .optional()
    .describe(
      "Per-point bed height, same length as `points`. OMIT IT when writing a river by hand: the field solves a " +
        "descending bed through the points from the ground they cross (a channel depth under it, capped at a lake's " +
        "level from the first point under a lake, running-min from the head so a ridge in the way is cut, the mouth " +
        "a hair under the sea or flush with the river it ends on), and the world carves, banks and waters it live. " +
        "`worldgen rivers --trace` writes one; a hand-written doc never should.",
    ),
  maxGrade: z
    .number()
    .min(0)
    .default(0.05)
    .describe(
      "Steepest bed grade the SOLVED bed may carry (rise over run; 0.05 is 5 %), applied only when `bedY` is " +
        "omitted. Where the ground drops faster — a coastal scarp, a lake's spill — the bed upstream is cut down to " +
        "keep the grade, so the river reaches the sea through a gorge instead of sliding down the cliff as a tilted " +
        "sheet. Not applied inside a lake: an outlet leaves flush with its lake and cascades from there. A water " +
        "sheet reads as a river under about 2 %, as rapids to 5 %; 0 disables the limit.",
    ),
  water: z
    .boolean()
    .default(true)
    .describe(
      "Emit a water surface along the channel (a ribbon at bed + most of `depth`, in the recipe's `riverMaterial`). " +
        "false is a dry gully: carved and painted, no sheet.",
    ),
  surface: z
    .string()
    .default("sand")
    .describe(
      "Palette surface NAME painted on the bed and banks, so ground cover stops at the water: a channel cut " +
        "through grassland is still grass to the splat otherwise, and the grass billboards grow in the river. " +
        "Empty string leaves the biome's cover.",
    ),
  surfaceEdge: z.number().min(0).default(3).describe("World units over which the bed surface fades into the bank."),
  taper: z
    .number()
    .min(0)
    .default(0)
    .describe(
      "Metres over which the channel grows from a trickle to full width and depth at its HEAD. Without it a " +
        "river begins at full size in the middle of a field, which is the single most obvious tell of a traced " +
        "channel; with it the source reads as a stream forming.",
    ),
});

/**
 * A lake: standing water at ITS OWN level, which is the whole point. The ocean
 * plane sits at `seaLevel`; a tarn at 300 m or a swamp pool at 4 m needs a
 * surface of its own, and the basin under it is carved so the water has
 * somewhere to be. Written by `worldgen rivers` wherever a watercourse
 * fills a depression on its way to the sea, and hand-placeable.
 */
export const lakeSchema = z.object({
  id: z.string().default("lake"),
  center: z.tuple([z.number(), z.number()]),
  polygon: z
    .array(z.tuple([z.number(), z.number()]))
    .min(3)
    .optional()
    .describe("World-space XZ outline of the shore. Omit for a disc of `radius` about `center`."),
  radius: z.number().positive().default(60),
  waterY: z.number().describe("Surface height. The basin is carved to sit below it; land outside the outline is untouched past `bank`."),
  depth: z.number().positive().default(6).describe("How far below the surface the deepest water is."),
  bank: z.number().min(0).default(18).describe("Distance over which the shore eases from the waterline back to natural terrain, and the bed from the shore down to `depth`."),
  carve: z
    .boolean()
    .default(true)
    .describe(
      "true (hand-placed lakes): dig the basin — everything inside the outline goes down to `depth`, and a " +
        "`bank` outside it eases to the waterline, whatever the ground was. false (`worldgen rivers` writes " +
        "this): the terrain already holds the basin the hydrology found, so only ground at or under the " +
        "surface is deepened, blended over two banks, and ground standing over a metre above it — an island, " +
        "or an outline that overshot onto a hillside — is left alone. Carving a traced outline dug craters " +
        "with vertical walls where it strayed uphill.",
    ),
  material: z
    .string()
    .optional()
    .describe("Water material for THIS lake, overriding the recipe's `waterMaterial`. A swamp pool is still, murky and opaque; a tarn is clear — one water for both reads wrong in both."),
  surface: z
    .string()
    .default("")
    .describe(
      "Palette surface NAME painted on the bed and a `shore` band around the outline — wet sand, gravel — so " +
        "the ground under and beside the water is not the biome's grass. Empty leaves the biome's cover; an " +
        "unknown name paints nothing.",
    ),
  shore: z.number().min(0).default(8).describe("Metres beyond the outline the `surface` fades out over."),
  tags: z.array(z.string()).default([]),
});

/** A road/trail flattened along a polyline. Written by `worldgen roads`. */
export const roadSchema = z.object({
  id: z.string().default("road"),
  points: polylineSchema,
  width: z.number().positive().default(6),
  shoulder: z.number().min(0).default(8).describe("Distance over which the cut/fill eases back into natural terrain."),
  /** Per-point road surface height — roads are graded, so this is what makes them drivable. */
  surfaceY: z.array(z.number()).optional(),
  smooth: z
    .number()
    .min(0)
    .default(0)
    .describe(
      "Metres BEYOND the shoulder over which the ground is regraded into a smooth embankment: from the road " +
        "edge out to `shoulder + smooth`, the natural terrain is replaced by a clean slope from the road " +
        "surface to `leftY`/`rightY` and only fades back into the rough ground at the outer edge. Without it " +
        "the shoulder merely blends the road height into whatever crinkle is there, and a road across noisy " +
        "ground reads as a notch in jagged terrain. Needs `leftY`/`rightY`; `worldgen roads` writes all three.",
    ),
  /**
   * Smoothed ground height at the OUTER edge of the smoothing band on each
   * side, per point. "Left" is the side where the cross product of the travel
   * direction (a -> b) with the offset from the centreline is positive.
   */
  leftY: z.array(z.number()).optional().describe("Per-point ground height at the outer edge of the `smooth` band on the road's left (positive cross-product side)."),
  rightY: z.array(z.number()).optional().describe("Per-point ground height at the outer edge of the `smooth` band on the road's right."),
  flatten: z.number().min(0).max(1).default(1).describe("How completely the road height wins over natural terrain."),
  surface: z
    .string()
    .default("dirt")
    .describe(
      "Palette surface NAME painted along the roadway, overriding whatever the biome would put there. A road " +
        "that only flattens the ground is invisible from the air — grass graded flat still reads as grass. " +
        "Set to an empty string to leave the biome's own cover in place (a paved street in a town, say).",
    ),
  surfaceEdge: z
    .number()
    .min(0)
    .default(2.5)
    .describe("World units over which the painted surface fades into the surrounding ground. The verge."),
  surfaceByBiome: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Palette surface NAME to paint instead of `surface` where a given biome (by id) holds the ground — " +
        "`{ alpine: \"gravel\" }` makes a footpath gravel across the snow and dirt everywhere else. Blended by " +
        "biome membership, so the swap fades across the biome boundary. `worldgen paths`/`trails` write " +
        "gravel for every snow-dominant biome when the palette has gravel.",
    ),
});

/**
 * A river drawn by hand (the editor's path tool, imported by `worldgen
 * river-path`) or by an agent writing points straight into the recipe. It is
 * AUTHORING input, not a river: `worldgen rivers` solves a downhill bed along
 * it, sizes the channel from `width`, splits it into wet and dry reaches and
 * writes the result into `features.rivers` like any traced channel — and the
 * land is carved and banked to it, so a path drawn across a ridge becomes a
 * gorge. Re-running the stage re-solves it; the path itself is never touched.
 */
export const riverPathSchema = z.object({
  id: z.string().default("path"),
  points: polylineSchema.describe("World-space XZ, head first, mouth last."),
  width: z.number().positive().default(14).describe("Channel width at the mouth; the head is narrower unless `widths` are given."),
  widths: z.array(z.number().positive()).optional().describe("Per-point width, same length as `points`."),
  tags: z.array(z.string()).default([]),
});

/**
 * A hollow filled with sediment: ground inside the outline is RAISED to `y`
 * (never lowered), easing back to natural terrain over `bank` outside it.
 * Written by `worldgen rivers` for every depression the channel network
 * crosses that is too small to keep as a lake — the river then cuts its
 * channel through a flat valley floor instead of running through a chain
 * of ponds. This is the "terrain around the rivers" half of rivers-first:
 * the drainage decides the land, not the other way round.
 */
export const fillSchema = z.object({
  id: z.string().default("fill"),
  polygon: z.array(z.tuple([z.number(), z.number()])).min(3).describe("World-space XZ outline of the hollow."),
  y: z.number().describe("Height the floor is raised to: the hollow's spill level, a little over."),
  bank: z.number().min(0).default(12).describe("Distance beyond the outline over which the raise eases out."),
  tags: z.array(z.string()).default([]),
});

/**
 * A road crossing a river: the road is split at the banks and this spans the
 * gap. Written by `worldgen roads` wherever a route crosses a channel too
 * wide to ford; the terrain under it is untouched (the water runs through),
 * and the streamed cell emits a deck for it. A WFC bridge builder can read
 * these and replace the deck with real architecture.
 */
export const bridgeSchema = z.object({
  id: z.string().default("bridge"),
  points: z
    .tuple([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number()])])
    .describe("World-space XZ of the two abutments: where the road stops on one bank and resumes on the other."),
  width: z.number().positive().default(6).describe("Deck width — the road's."),
  deckY: z.number().describe("Height of the deck surface; the roads on both banks end at this height."),
  thickness: z.number().min(0).default(0.6).describe("Deck slab thickness, hanging below `deckY`."),
  river: z.string().default("").describe("Id of the river crossed."),
  waterY: z.number().optional().describe("Water surface under the span, for the WFC stage to size piers."),
  material: z.string().optional().describe("Material for the deck, overriding the recipe's `bridgeMaterial`."),
  tags: z.array(z.string()).default([]),
});

/** A settlement pad: terrain pulled flat so WFC buildings have somewhere to stand. */
export const townSchema = z.object({
  id: z.string().default("town"),
  center: z.tuple([z.number(), z.number()]),
  radius: z.number().positive().default(45),
  falloff: z.number().min(0).default(35).describe("Distance beyond `radius` over which the pad blends into natural terrain."),
  /** Pad height. Omit and the generator fills it in from the terrain's own local mean. */
  groundY: z.number().optional(),
  flatten: z.number().min(0).max(1).default(0.95),
  /** Free-form, for the WFC/POI stages to read (population tier, faction, ...). */
  tags: z.array(z.string()).default([]),
});

/** A raw volume edit — the escape hatch for arches, quarries, cave mouths, monoliths. */
export const blobSchema = z.object({
  id: z.string().default("blob"),
  center: z.tuple([z.number(), z.number(), z.number()]),
  radius: z.number().positive(),
  /** "add" fills solid rock, "remove" carves air. */
  op: z.enum(["add", "remove"]).default("remove"),
  falloff: z.number().min(0).default(4),
  height: z
    .number()
    .min(0)
    .default(0)
    .describe(
      "0 = a sphere. Above 0 the blob is a VERTICAL CAPSULE this tall, rising from `center` — which is what " +
        "turns the escape hatch into a monolith: a desert pillar is one line of JSON rather than a stack of " +
        "spheres, and it stays one line when you drag it somewhere else.",
    ),
  topRadius: z
    .number()
    .positive()
    .optional()
    .describe(
      "Radius at the TOP of a capsule (needs `height`). Omit for a uniform column. A value below `radius` is " +
        "what turns a pillar into a needle — a spire tapering as it rises reads as weathered stone, a cylinder " +
        "reads as a prop.",
    ),
  /**
   * Squash/stretch in XZ. A monolith that is 1.6x wider east-west than
   * north-south reads as a weathered slab rather than a extruded circle.
   */
  scaleX: z.number().positive().default(1),
  scaleZ: z.number().positive().default(1),
});

/**
 * A canyon: a polyline cut down to a flat floor with TERRACED walls.
 *
 * It is not a big river. A river carves a V because water erodes toward its
 * bed; a canyon has a floor you can walk along and walls that step, because
 * different strata weather at different rates. `steps` is that stratigraphy,
 * and it is what makes the walls read as rock rather than as a smooth chute —
 * the same visual language as the mesas and spires `worldgen monoliths`
 * raises, which is why the two stages belong in the same world.
 */
export const canyonSchema = z.object({
  id: z.string().default("canyon"),
  points: polylineSchema,
  width: z.number().positive().default(70).describe("Width of the flat floor."),
  depth: z.number().positive().default(45).describe("How far below the surrounding land the floor sits."),
  rim: z.number().min(0).default(60).describe("Horizontal distance the walls take to climb back to natural terrain."),
  steps: z
    .number()
    .int()
    .min(1)
    .max(8)
    .default(3)
    .describe("Terraces in each wall. 1 is a smooth ramp; 3-4 reads as bedded rock."),
  stepSharpness: z
    .number()
    .min(0)
    .max(1)
    .default(0.72)
    .describe("0 = the terraces vanish into a straight slope, 1 = vertical risers and flat treads."),
  /** Per-point floor height. Omit and the floor is cut `depth` below local terrain. */
  floorY: z.array(z.number()).optional(),
});

/**
 * A cave passage: a 3D polyline carved out as a tube, exactly the way a road
 * is a 2D polyline flattened into a strip.
 *
 * This is the alternative to carving caves out of 3D noise, and it is better
 * on every axis that matters. Noise caves are everywhere or nowhere — you tune
 * a threshold and get either a Swiss cheese or nothing, with no way to say
 * "one system, here, running that way". They are also the single most
 * expensive thing in the generator, because the noise has to be evaluated for
 * every voxel of rock in the world on the chance that a tunnel passes through
 * it. A tunnel is evaluated only near the tunnel.
 *
 * And because it is authored data, the same pipeline that carves rivers and
 * roads can place, inspect, edit and version it.
 */
export const tunnelSchema = z.object({
  id: z.string().default("tunnel"),
  points: z
    .array(z.tuple([z.number(), z.number(), z.number()]))
    .min(2)
    .describe("World-space path in 3D — unlike rivers and roads, a cave goes up and down as well as along."),
  radius: z
    .number()
    .positive()
    .default(3)
    .describe(
      "Passage radius. Keep it comfortably ABOVE the world's voxel size (cellSize / resolution): marching cubes " +
        "cannot represent a hole much narrower than one voxel, so a thinner tunnel is silently sealed in the mesh " +
        "and in the collider cooked from it, however open the field says it is.",
    ),
  endRadius: z
    .number()
    .positive()
    .optional()
    .describe("Radius at the last point; omit for a uniform tube. Lets a passage open out into a chamber."),
});

/** A named point of interest. Carried through so downstream stages can find it. */
export const poiSchema = z.object({
  id: z.string(),
  kind: z.string().default("poi"),
  position: z.tuple([z.number(), z.number(), z.number()]),
  rotationY: z.number().default(0),
  prefab: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

/**
 * One splat channel. Up to four, blended per-vertex by the biome rules — this
 * is what "multi-layered texture" resolves to: the mesh carries a vec4 weight
 * and the terrain material mixes exactly these four surfaces triplanar-ly, so
 * cliffs and overhangs (which have no sane UVs) still texture correctly.
 */
const surfaceSchema = z.object({
  name: z.string().describe("Human/AI-facing label: grass, sand, rock, snow."),
  color: hexColor.default("#7a8a5a").describe("Tint, and the whole appearance until a texture is supplied."),
  roughness: z.number().min(0).max(1).default(0.9),
  map: z.string().optional().describe("Texture asset id (assets/textures/) — albedo, projected triplanar."),
  normalMap: z.string().optional(),
  uvScale: z.number().positive().default(4).describe("World units per texture tile."),
});

export type SurfaceDoc = z.infer<typeof surfaceSchema>;

const rangeSchema = z.tuple([z.number(), z.number()]);

/**
 * A biome rule. Rules are not exclusive: every rule gets a smooth membership
 * from its windows and the surface weights are blended by it, so biome
 * borders are gradients, never a visible seam.
 */
const biomeSchema = z.object({
  id: z.string(),
  /** Absolute world Y of the ground. The sand/grass/snow axis. */
  height: rangeSchema.optional(),
  temperature: rangeSchema.optional().describe("0 (polar) .. 1 (equatorial), from the climate noise."),
  moisture: rangeSchema.optional().describe("0 (desert) .. 1 (rainforest)."),
  slope: rangeSchema.optional().describe("0 (flat) .. 1 (vertical)."),
  blend: z.number().min(0).default(0.08).describe("Softness of the temperature/moisture/slope window edges, in those windows' own 0..1 units."),
  heightBlend: z
    .number()
    .min(0)
    .default(6)
    .describe("Softness of the `height` window edges, in WORLD UNITS — height is the one window measured in metres, so it needs its own blend or a 0.08 softness makes a razor edge across a hillside."),
  weight: z.number().positive().default(1).describe("Relative pull where several rules match equally."),
  /** Splat weights on ground this biome considers walkable. Indexed like `surfaces`. */
  surface: z.array(z.number().min(0)).min(1).max(MAX_SURFACES),
  /** Splat weights where the ground is too steep for the biome's cover — its cliff face. */
  cliff: z.array(z.number().min(0)).min(1).max(MAX_SURFACES).optional(),
  /** Steepness at which `cliff` fully replaces `surface`. */
  cliffStart: z
    .number()
    .min(0)
    .max(1)
    .default(0.57)
    .describe(
      "Steepness at which `cliff` starts replacing `surface`, in sin(angle). 0.57 is 35 degrees, roughly the " +
        "angle of repose: past it soil and sand stop staying put, which is why cover gives way to rock there. " +
        "These are authored against `slope()` units, so anything that measures steepness differently silently " +
        "means a different ANGLE here.",
    ),
  cliffEnd: z.number().min(0).max(1).default(0.82).describe("Steepness at which `cliff` fully replaces `surface`. 0.82 is 55 degrees."),
  tint: hexColor.optional().describe("Multiplied over the blended surface color — cheap per-biome variation."),
  zones: z
    .array(z.string())
    .optional()
    .describe(
      "Zone anchor ids (`climate.zones.anchors[].id`) this rule belongs to. The rule's membership is multiplied " +
        "by the blended zone weight, so a rule listed here exists ONLY inside those zones — which is how a " +
        "blighted region and a badland can both be hot-and-dry without fighting over the same climate corner. " +
        "Omit for a rule that applies wherever its climate/height/slope windows say.",
    ),
  label: z
    .boolean()
    .default(true)
    .describe(
      "Does this rule NAME the place? Cover-only rules — a crag rule that paints bare rock on steep ground in " +
        "every biome — must set false. `biome().id` is the strongest rule by membership, and everything that " +
        "asks 'which biome is this' reads it: scatter's `biomes` filter above all. A cover rule left labelling " +
        "quietly renames every slope in the world, and the pines filtered to \"meadow\" stop appearing on hills.",
    ),
});

export type BiomeDoc = z.infer<typeof biomeSchema>;

/**
 * A noise-driven blotch of one surface laid over whatever the biome decided.
 *
 * Biome rules answer "what kind of place is this"; they are low-frequency by
 * construction, so on their own a meadow is a uniform sheet of grass to the
 * horizon. Patches are the second scale — bare dirt worn through the grass,
 * rock breaking the surface of a desert, the mottling that makes blighted
 * ground read as diseased rather than merely recoloured. They cost one noise
 * lookup per vertex and only where their `biomes` gate is open, so a patch
 * confined to the blight is free everywhere else in the world.
 */
const patchSchema = z.object({
  id: z.string(),
  surface: z.string().describe("Palette surface NAME to lay down (matched case-insensitively)."),
  biomes: z
    .array(z.string())
    .default([])
    .describe("Biome ids this may appear in; empty = anywhere. The gate is the biome's blended membership, so patches fade out across a border instead of stopping at it."),
  frequency: z.number().positive().default(0.02).describe("Cycles per world unit. 0.02 ~ 50 m blotches."),
  octaves: z.number().int().min(1).max(6).default(3),
  threshold: z
    .number()
    .min(-1)
    .max(1)
    .default(0.15)
    .describe("Noise level (-1..1) at which the patch starts. Higher = rarer, smaller patches."),
  blend: z.number().min(0).default(0.22).describe("Noise range over which it fades in. Small = hard-edged scabs, large = soft mottling."),
  strength: z.number().min(0).max(1).default(0.8).describe("How completely the patch replaces the ground under it at full mask. 1 = bare."),
  slope: rangeSchema.optional().describe("Restrict to a steepness window — dirt worn through on flat ground, scree only on slopes."),
  seed: z.number().int().default(0),
});

export type PatchDoc = z.infer<typeof patchSchema>;

/**
 * Cliff-face placement: a column of props bedded INTO a steep face.
 *
 * The ordinary scatter lattice is a plan projection, so a sheer face — which
 * occupies almost no ground area seen from above — gets almost no props no
 * matter how high the density. That is why cliffs read as flat texture. This
 * mode takes the same lattice point, walks DOWN the face from the clifftop,
 * and puts a prop at each step, pushed back into the rock so only its front
 * stands proud. The face's own outward direction gives each one its facing.
 */
const cliffScatterSchema = z.object({
  stack: z
    .tuple([z.number().int().min(1), z.number().int().min(1)])
    .default([2, 5])
    .describe("How many props down one column, picked per lattice point. The stack stops early where the face does."),
  spacing: z
    .number()
    .positive()
    .default(5)
    .describe("Metres of drop between one prop and the next. Set it under the model's height so they overlap and read as one mass."),
  spacingJitter: z.number().min(0).max(1).default(0.4).describe("How much each step may vary, as a fraction of `spacing`."),
  embed: z
    .number()
    .default(1.6)
    .describe(
      "Depth pushed INTO the face along its inward normal, in MODEL units — it is multiplied by the " +
        "instance scale, like `yOffset`, so resizing a prop does not leave it hanging off the wall. This is " +
        "the field that decides whether the prop " +
        "looks bolted onto the cliff or part of it; roughly a third of the model's depth is a good start.",
    ),
  embedJitter: z.number().min(0).default(0.8).describe("Random variation on `embed`, in the same model units."),
  lateral: z
    .number()
    .min(0)
    .default(2.5)
    .describe("Metres each prop may slide sideways along the face, so a column is not a plumb line of rocks."),
  faceOut: z
    .number()
    .min(0)
    .max(1)
    .default(1)
    .describe("How strongly each prop turns to face out of the cliff. 1 = square to the face, 0 = free yaw (the ordinary scatter behaviour)."),
  yawSpread: z
    .number()
    .min(0)
    .default(0.6)
    .describe("Radians of random yaw either side of the outward direction. This plus `tilt` is what stops a stack looking like one model copy-pasted."),
  tilt: z.number().min(0).default(0.28).describe("Radians of random tilt off vertical, about a random horizontal axis."),
  lean: z
    .number()
    .default(0.35)
    .describe(
      "Radians the prop tips BACK into the face (negative tips it out). A cliff recedes as it rises, so an " +
        "upright prop bedded at its base has its top hanging in open air — which is exactly what makes a face " +
        "read as planted menhirs instead of rock. Roughly `atan(model height / (2 x embed))` cancels it. This " +
        "is NOT `alignToNormal`: that one lays a prop ONTO a slope, which on a cliff leans it further out.",
    ),
  leanJitter: z.number().min(0).default(0.15).describe("Radians of random variation on `lean`."),
  minDrop: z
    .number()
    .min(0)
    .default(6)
    .describe(
      "The face must fall at least this far below the lattice point for the column to start at all. Guards " +
        "against decorating every short steep bank in the world.",
    ),
  search: z
    .number()
    .positive()
    .default(12)
    .describe(
      "Metres to march outward looking for the face at each step's height. Wider catches gentler faces, and " +
        "it is the per-instance cost knob — but it is also how far a prop can end up from the lattice point " +
        "that owns it, so keep it WELL under a quarter of `cellSize` or a cell starts emitting props that " +
        "live in its neighbour and pop when it unloads.",
    ),
});

export type CliffScatterDoc = z.infer<typeof cliffScatterSchema>;

/** One kind of thing scattered across the world: trees, rocks, bushes, grass tufts. */
const scatterSchema = z.object({
  id: z.string(),
  prefab: z.string().optional().describe("Prefab asset id to instance (preferred — keeps chunk docs collapsed)."),
  model: z.string().optional().describe("Model asset id, when there is no prefab worth authoring."),
  foliageNormals: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Passed to the emitted mesh: shade this model's alpha-cutout parts as a sphere. Set it on anything with " +
        "leaf cards, or the canopy lights per-card — one plate blown out, the next black. See the mesh " +
        "component's own field for why.",
    ),
  foliageUp: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Passed to the emitted mesh: how far the reshaped leaf normals lean toward straight up. 1 shades them exactly like the grass cover."),
  brightness: z
    .number()
    .min(0)
    .optional()
    .describe("Passed to the emitted mesh: multiply this model's base colour. See the mesh component's own field."),
  wind: meshWindSchema
    .optional()
    .describe(
      "Passed to the emitted mesh: vertex-shader wind. `sway` for bushes (bends from a base pinned to the " +
        "ground), `ripple` for trees (leaf cards shimmer, trunk holds still). See the mesh component's own field.",
    ),
  cameraFade: z
    .boolean()
    .optional()
    .describe(
      "Passed to the emitted mesh: dissolve this prop when it blocks the third-person camera's view of the " +
        "character. Worth it on anything with leaf cards a player will walk into. See the mesh component's field.",
    ),
  material: z.string().optional(),
  biomes: z.array(z.string()).default([]).describe("Biome ids this may appear in; empty = anywhere."),
  density: z
    .number()
    .min(0)
    .default(0.01)
    .describe("Expected instances per square world unit. 0.01 = one per 10x10m, i.e. a light forest."),
  slopeMax: z.number().min(0).max(1).default(0.5).describe("Steepest ground it will stand on."),
  slopeMin: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe(
      "Shallowest ground it will stand on, in the same sin(angle) units as slopeMax (0.71 = 45 degrees, " +
        "0.87 = 60). Raise it to make a rule STEEP-ONLY — scree, cliff rock, ledge growth — instead of the " +
        "usual 'anywhere flat enough'.",
    ),
  yawOffset: z
    .number()
    .default(0)
    .describe(
      "Radians added to every instance's yaw. The fix for a model whose front does not face +Z: cliff rocks " +
        "turn their +Z out of the face, so a model authored facing -Z needs Math.PI here.",
    ),
  cliff: cliffScatterSchema.optional().describe(
    "Turn this rule into a CLIFF FACE rule: instead of one prop standing on the ground, it emits a vertical " +
      "STACK of props bedded into the face below the clifftop. This is how a sheer voxel face stops reading " +
      "as a painted texture and starts reading as rock. Pair it with a high `slopeMin` — a stack on gentle " +
      "ground is just a tower of floating boulders.",
  ),
  height: rangeSchema.optional().describe("World-Y window the ground must fall in."),
  scale: z.tuple([z.number().positive(), z.number().positive()]).default([0.9, 1.2]),
  alignToNormal: z.number().min(0).max(1).default(0).describe("0 = always upright, 1 = fully laid onto the slope."),
  yOffset: z.number().default(0).describe("Sink (negative) or lift the instance along its own up axis."),
  jitter: z.number().min(0).max(1).default(0.85).describe("How far off its lattice point each instance may wander."),
  /** Keep clear of towns/paths/rivers by this much — nobody wants a tree in the high street. */
  clearance: z
    .number()
    .min(0)
    .default(1.5)
    .describe(
      "Metres kept clear of every feature's EDGE — a path's shoulder, a river's bank foot, a town's radius, a " +
        "monolith's footprint. 0 lets the rule stand props on a footpath, which is never wanted.",
    ),
  footprint: z
    .number()
    .min(0)
    .default(0)
    .describe(
      "Radius of the prop's own ground footprint in MODEL units (scaled per instance). Two props are placed " +
        "no closer than the SUM of their footprints plus `spacing`, and rules are solved largest-footprint " +
        "first so big things claim ground before small ones fill in around them. 0 = derive from colliderSize.",
    ),
  spacing: z.number().min(0).default(0.5).describe("Extra clear ground kept between this prop and any other, in world units."),
  collider: z.enum(["none", "capsule", "box", "cylinder"]).default("none"),
  colliderSize: z.tuple([z.number(), z.number(), z.number()]).default([1, 2, 1]),
  static: z.boolean().default(true),
  castShadow: z.boolean().default(true),
  lod: z
    .boolean()
    .default(true)
    .describe(
      "Passed to the emitted mesh: swap to a cheap distance proxy past ~100m. Turn it OFF for a model that is " +
        "already cheap. Without a baked impostor the far tier is a BOX for a squat prop, so a 170-triangle rock " +
        "spends the whole middle distance as a brown box — the proxy saves 150 triangles and costs you the rock. " +
        "See the mesh component's own field.",
    ),
});

export type ScatterDoc = z.infer<typeof scatterSchema>;

/**
 * One landmass. The coast is not the circle — it is the circle pushed around
 * by noise, which is what stops a continent reading as a dinner plate.
 */
const continentSchema = z.object({
  center: z.tuple([z.number(), z.number()]).describe("World-space XZ centre of the landmass."),
  radius: z.number().positive().describe("Distance from the centre that is solidly inland — the terrain here is whatever the noise bands make it."),
  falloff: z
    .number()
    .positive()
    .default(700)
    .describe(
      "Width of the band over which land descends to the ocean floor. The coastline sits inside it, so a WIDE " +
        "falloff gives beaches and shallow bays and a narrow one gives sea cliffs. Mountains caught in this band " +
        "are compressed rather than clipped, which is what puts lowlands around the rim instead of peaks meeting " +
        "the water.",
    ),
  warp: z
    .number()
    .min(0)
    .default(0.55)
    .describe("Coastline raggedness as a fraction of `falloff`: 0 is a clean arc, ~0.6 gives peninsulas, headlands and bays. Above 1 the coast breaks into islands."),
  warpScale: z
    .number()
    .positive()
    .default(1100)
    .describe("Metres per lobe of coastline wobble. Small values fray the coast into inlets; large ones bend the whole landmass."),
  coastVariation: z
    .number()
    .min(0)
    .max(0.95)
    .default(0)
    .describe(
      "How much `falloff` varies around the coast, as a fraction. 0.6 means some stretches of shore descend " +
        "over 40% of the band (steep: headlands and sea cliffs) and others over 160% (gentle: beaches and " +
        "shallow bays). This is what gives one island a beach on one side and cliffs on the other.",
    ),
  coastVariationScale: z.number().positive().default(1800).describe("Metres per cycle of the falloff variation — how long a stretch of cliff or beach coast is."),
  lobes: z
    .array(z.tuple([z.number(), z.number(), z.number()]))
    .default([])
    .describe(
      "Extra discs [dx, dz, radius], relative to `center`, smoothly UNIONED with the main one. This is what " +
        "stops a continent being a circle: two or three lobes make a crescent, an L, a landmass with a " +
        "peninsula and a gulf. Each lobe still gives an exact distance to its shore, so the shore profile and " +
        "the land floor hold everywhere.",
    ),
  lobeBlend: z.number().min(0).default(500).describe("Metres over which lobes merge into one another instead of meeting at a crease. Wider = softer bays where they join."),
});

/** Continents + the sea around them. See `worldRecipeSchema.bounds`. */
const boundsSchema = z.object({
  continents: z.array(continentSchema).min(1),
  oceanFloor: z
    .number()
    .default(-45)
    .describe(
      "Ground height far out to sea, well below seaLevel so open water is unmistakably water. Keep it above " +
        "`minY` or the sea bed falls through the world's solid floor.",
    ),
  landFloor: z
    .number()
    .min(0)
    .default(0)
    .describe(
      "Metres above seaLevel that the INTERIOR of a landmass is held at or above. Above 0 this switches the " +
        "continent from a height blend to a shore PROFILE: the ground rises from oceanFloor to this floor across " +
        "the coast band and the terrain's own relief fades in on top of it, so the coastline is exactly the " +
        "warped outline of the continent and nowhere else. That is what keeps the ocean from bleeding into every " +
        "inland dip — with the interior held above the sea, standing water inland is only ever a LAKE at its " +
        "own level. 0 = the legacy blend (inland hollows below seaLevel fill with ocean).",
    ),
  shelf: z
    .number()
    .min(0.05)
    .max(0.95)
    .default(0.58)
    .describe("Where in the coast band (0 = open sea, 1 = inland) the shoreline sits when `landFloor` is set. Lower = more of the band is beach and shallows."),
  limit: z
    .number()
    .positive()
    .optional()
    .describe(
      "THE WORLD BOUNDARY: distance from the origin beyond which everything is open ocean at oceanFloor, " +
        "whatever the continents say. Streaming skips cells past it, the ocean plane is sized to it, and " +
        "nothing is placed beyond it. Omit for no hard edge.",
    ),
  limitFalloff: z.number().positive().default(600).describe("Metres over which land is pulled under approaching `limit`."),
});

/**
 * One kind of place a zone can be. A zone is assigned exactly one anchor, so
 * a zone IS a desert, or a forest, or a badland — never a gradient between
 * them. Its climate values are what the biome rules window on, and the
 * landform multipliers are what make it a different SHAPE of ground rather
 * than the same hills in a different colour.
 */
const zoneAnchorSchema = z.object({
  id: z.string(),
  temperature: z.number().min(0).max(1),
  moisture: z.number().min(0).max(1),
  weight: z.number().positive().default(1).describe("How often zones pick this anchor, relative to the others."),
  latitude: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Preferred latitude band, 0 = the cold pole, 1 = the hot pole (see `climate.zones.latitude`). A zone " +
        "picks anchors by weight TIMES how close its own latitude is to this, so tundra collects at one end of " +
        "the world and jungle at the other instead of both being sprinkled everywhere. Omit = anywhere.",
    ),
  relief: z.number().min(0).default(0.15).describe("Multiplies the MOUNTAIN band here. 1 = a mountain zone; 0 = no peaks at all."),
  hills: z.number().min(0).default(1).describe("Multiplies the hills band. 0 = a plain; 1.5 = broken country."),
  dunes: z.number().min(0).default(0).describe("Multiplies the dune band (`terrain.dunes`) here. 1 = a dune sea."),
  mesas: z.number().min(0).default(0).describe("Multiplies the mesa band (`terrain.mesas`) here. 1 = badlands: terraced tables and buttes."),
  flatten: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe("Pulls the continent band down toward the land floor. 1 = a low, level plain hugging the waterline — swamp ground."),
});

/**
 * Zones: the world cut into large regions, each one kind of place.
 *
 * Climate from smooth noise gives patches — a desert the size of a field next
 * to a tundra the size of a field, because that is what the middle of a noise
 * field looks like at every scale. A world you travel through wants regions
 * you can be IN: a desert that takes ten minutes to cross, a forest with a
 * heart and an edge. So the plane is cut into jittered Voronoi cells of
 * roughly `size` metres, each cell picks ONE anchor, and only the border
 * between two cells is blended. Everything else — the biome rules, the
 * patches, the scatter — reads the result through the same climate values it
 * always did, so nothing downstream knows zones exist.
 */
const zonesSchema = z.object({
  size: z.number().positive().default(2400).describe("Mean zone diameter in metres. A region should take minutes to cross, not seconds."),
  jitter: z.number().min(0).max(1).default(0.85).describe("How far each zone's site wanders from its grid point. 0 is a checkerboard."),
  warp: z.number().min(0).default(260).describe("Metres the zone borders are pushed around by noise, so they read as coastlines rather than as cell walls."),
  warpFrequency: z.number().positive().default(0.0009),
  border: z.number().positive().default(220).describe("Width of the blend between two zones, in metres. Biome rules still see a gradient across it."),
  latitude: z
    .object({
      strength: z.number().min(0).max(1).default(0.7).describe("How strongly zones sort by latitude. 0 = anchors are picked by weight alone."),
      scale: z.number().positive().default(6000).describe("Metres from the cold pole to the hot one, centred on the origin along `axis`."),
      axis: z.enum(["x", "z"]).default("z"),
      flip: z.boolean().default(false).describe("Swap which end is hot."),
    })
    .prefault({}),
  anchors: z.array(zoneAnchorSchema).min(1),
  seed: z
    .number()
    .int()
    .default(0)
    .describe(
      "Added to the world seed for the zone layout alone, so the layout can be re-rolled without moving a " +
        "single hill. Which anchor a zone gets is a draw, and a small world can draw no desert at all: a " +
        "generator that needs every kind of place can sweep this until each anchor covers real land.",
    ),
});

export type ZoneAnchorDoc = z.infer<typeof zoneAnchorSchema>;
export type ZonesDoc = z.infer<typeof zonesSchema>;

export const worldRecipeSchema = z.object({
  version: z.literal(1),
  name: z.string().default("world"),
  seed: z.number().int().default(1337),

  cellSize: z.number().positive().default(48).describe("World units per streamed chunk cell (XZ). Must match the scene's voxelWorld cellSize."),
  resolution: z
    .number()
    .int()
    .min(4)
    .max(96)
    .default(24)
    .describe("Voxels per cell edge. voxelSize = cellSize / resolution — 2m voxels read as chunky low-poly, 0.5m as smooth."),
  seaLevel: z.number().default(0),
  bounds: boundsSchema.optional().describe(
    "Turns the endless noise field into CONTINENTS ringed by open ocean. Omit it and the world has no edge at " +
      "all: the terrain tiles outward forever and 'world size' is only however far the CLI happened to place " +
      "features. Applied inside the single shared height function, so the mesh, the cooked collider and the " +
      "placement solver agree about where the coast is — the one rule this generator breaks at its peril.",
  ),
  minY: z.number().default(-60).describe("Hard floor: below this the world is solid rock, so nothing can fall out of it."),
  maxY: z.number().default(900).describe("Hard ceiling: above this is always air (bounds the vertical march). It costs nothing where the ground is low — the meshed band is derived per cell from that cell's own terrain — so it only has to clear the highest peak the noise can produce."),

  terrain: z
    .object({
      base: z.number().default(0).describe("Baseline ground height before any noise band. Relative to seaLevel this is what sets the land/ocean ratio."),
      warp: z
        .object({ strength: z.number().min(0).default(28), frequency: z.number().positive().default(0.0016) })
        .default({ strength: 28, frequency: 0.0016 })
        .describe("Domain warp of the whole heightfield — turns noise-looking hills into eroded-looking landforms."),
      continent: fbmSchema.default({ frequency: 0.00055, amplitude: 70, octaves: 4, lacunarity: 2, gain: 0.5, ridged: false, seed: 11 }),
      hills: fbmSchema.default({ frequency: 0.006, amplitude: 14, octaves: 4, lacunarity: 2.1, gain: 0.5, ridged: false, seed: 23 }),
      // Mountains are DELIBERATELY out of scale with the hills. A range whose
      // peaks land in the same altitude band as ordinary green hills produces
      // the worst possible reading of a world: everything the same height, some
      // of it inexplicably white. The amplitude has to clear the treeline
      // biome's floor by a wide margin for the snow line to be a place rather
      // than a colour.
      mountains: fbmSchema.default({ frequency: 0.0019, amplitude: 900, octaves: 5, lacunarity: 2.05, gain: 0.52, ridged: true, seed: 37 }),
      mountainMask: z
        .object({
          spec: fbmSchema.default({ frequency: 0.0011, amplitude: 1, octaves: 3, lacunarity: 2, gain: 0.5, ridged: false, seed: 53 }),
          start: z.number().default(0.54),
          end: z.number().default(0.8),
        })
        .default({
          spec: { frequency: 0.0011, amplitude: 1, octaves: 3, lacunarity: 2, gain: 0.5, ridged: false, seed: 53 },
          start: 0.54,
          end: 0.8,
        })
        .describe("Where mountains are ALLOWED. Without a mask, ridged noise puts peaks everywhere and the world reads as noise."),
      detail: fbmSchema.default({ frequency: 0.035, amplitude: 1.6, octaves: 3, lacunarity: 2, gain: 0.5, ridged: false, seed: 71 }),
      coast: z
        .object({
          cliff: z
            .number()
            .min(0)
            .default(2.8)
            .describe(
              "How much steeper the land gets at the waterline where the coast noise says 'rugged'. 0 makes " +
                "every shore a beach, which is the failure this fixes: a height-band beach rule applied to a " +
                "uniformly gentle coastline rings the entire world in one unbroken strip of sand.",
            ),
          band: z
            .number()
            .positive()
            .default(18)
            .describe("World units above and below sea level the steepening reaches. Roughly the height of the headlands."),
          frequency: z.number().positive().default(0.0016).describe("How often the coast alternates between cliff and cove."),
          // Deliberately BELOW the middle. Raw fBm clusters hard around 0.5
          // (the same trap `climate.contrast` exists for), so a window written
          // at 0.5..0.75 in honest terms fires on 6% of the coastline and the
          // feature reads as broken rather than as subtle. Measured: 0.48/0.72
          // gave 6% cliff coast, 0.40/0.56 gives 17%.
          start: z.number().default(0.4),
          end: z.number().default(0.56),
          seed: z.number().int().default(1229),
        })
        .prefault({})
        .describe(
          "Sea cliffs. The shoreline profile is steepened in place where a low-frequency noise says the coast " +
            "is rugged, so headlands plunge into deep water and bays stay shallow and sandy. The beach BIOME " +
            "needs no change: its height window is simply crossed in two metres of ground instead of forty, so " +
            "sand survives only where the coast is gentle — and the `crag` rule paints the cliff face rock on " +
            "its own.",
        ),
      dunes: z
        .object({
          amplitude: z
            .number()
            .min(0)
            .default(0)
            .describe("World units of dune crest. 0 disables the band entirely, and with it the extra climate lookup per column."),
          frequency: z.number().positive().default(0.011),
          octaves: z.number().int().min(1).max(5).default(3),
          stretch: z
            .number()
            .positive()
            .default(3.5)
            .describe("Elongation across the prevailing wind. 1 is lumps; 3-4 is the long parallel ridges that read as sand."),
          angle: z.number().default(0.6).describe("Wind direction in radians — the axis the ridges run along."),
          temperature: rangeSchema.default([0.45, 1.1]),
          moisture: rangeSchema.default([-0.1, 0.52]),
          blend: z.number().min(0).default(0.12),
          seed: z.number().int().default(401),
        })
        .prefault({})
        .describe(
          "Sand dunes: a ridged, stretched band added to the heightfield ONLY where the climate is hot and dry — " +
            "the same window the desert biome uses, so the landform and the sand arrive together. This is what " +
            "makes a desert a different PLACE rather than the same hills in a different colour, and the pattern " +
            "generalises: any biome that should have its own landform gets a masked band like this one.",
        ),
      mesas: z
        .object({
          amplitude: z.number().min(0).default(0).describe("World units of table height. 0 disables the band."),
          frequency: z.number().positive().default(0.0032),
          octaves: z.number().int().min(1).max(5).default(3),
          steps: z.number().int().min(1).max(8).default(4).describe("Strata per table: each is a riser and a tread."),
          sharpness: z.number().min(0).max(0.98).default(0.8).describe("How square the risers are. 0 is a smooth dome."),
          seed: z.number().int().default(719),
        })
        .prefault({})
        .describe(
          "BADLANDS landform: a terraced plateau band, added where a zone anchor's `mesas` says so. Tables, " +
            "buttes and stepped strata — the shape that reads as badland, which no amount of red texture on " +
            "rolling hills achieves. The band is masked by the ZONE, so it is off everywhere unless an anchor " +
            "asks for it.",
        ),
      ceiling: z
        .object({
          height: z.number().positive().default(560).describe("The highest the ground can be, asymptotically. Peaks approach it and never reach it."),
          softness: z.number().positive().default(140).describe("Metres below `height` at which the compression begins. Wider = gentler summits."),
        })
        .optional()
        .describe(
          "MAX HEIGHT: a smooth, monotonic compression of everything above `height - softness` toward `height`. " +
            "It is what lets the mountain band have a big amplitude (for tall, steep flanks) without any peak " +
            "punching through `maxY` and being sliced flat — and it gives every summit in the world a common " +
            "sense of scale. Omit for no ceiling.",
        ),
      cliffs: z
        .object({
          enabled: z.boolean().default(false),
          step: z
            .number()
            .positive()
            .default(55)
            .describe("Metres of altitude per terrace — the height of one riser, and roughly the height of one cliff band."),
          sharpness: z
            .number()
            .min(0)
            .max(0.98)
            .default(0.86)
            .describe(
              "How square the riser is. 0 leaves the slope untouched; 0.72 spends ~28% of each band's altitude " +
                "on the riser and flattens the rest into a tread. Past ~0.9 the riser is vertical enough that " +
                "the voxel lattice, not this number, is what limits it.",
            ),
          strength: z
            .number()
            .min(0)
            .max(1)
            .default(1)
            .describe("How much of the terraced profile to blend in where the mask is full. Below 1 the risers soften back toward the raw slope."),
          rounding: z
            .number()
            .min(0)
            .max(0.5)
            .default(0.25)
            .describe(
              "Fraction of each riser's height spent easing into the tread at its top and foot, instead of " +
                "meeting it at a crease. 0 is the raw clamp — a riser that hits the tread at a corner, which the " +
                "mesh renders as a knife edge along every cliff top. 0.25 rounds the crest and the foot over a " +
                "quarter of the riser each while the middle half stays as sheer as `sharpness` asks.",
            ),
          minBands: z
            .number()
            .min(0)
            .default(1.6)
            .describe(
              "How many `step` bands of mountain relief a place must have before it is terraced at all, fading " +
                "in over the next 1.4 bands. This is what keeps cliffs ON MOUNTAINS: without it the edge of the " +
                "mountain band — a hillock with one band's worth of height — gets a single enormous step, which " +
                "reads far harsher than the mountain itself does because there is no mountain around it to " +
                "explain it, and it is visible from a long way off.",
            ),
          mask: z
            .object({
              frequency: z.number().positive().default(0.0012).describe("Cycles per world unit. 0.0012 is a cliff band a few hundred metres across."),
              start: z.number().min(0).max(1).default(0.44).describe("Mask value at which terracing begins to appear."),
              end: z.number().min(0).max(1).default(0.58).describe("Mask value at which it is in full."),
              octaves: z.number().int().min(1).max(6).default(3),
              seed: z.number().int().default(881),
            })
            .default({ frequency: 0.0012, start: 0.44, end: 0.58, octaves: 3, seed: 881 })
            .describe(
              "WHERE the terracing happens. Without this every mountain in the world is terraced from base to " +
                "summit and reads as a ziggurat, which is not what a mountain range looks like — a range is " +
                "mostly smooth flank with cliff bands breaking out of it here and there. Widen the " +
                "start..end gap for cliffs that fade in; raise `start` for rarer, more dramatic ones.",
            ),
          jitter: z
            .number()
            .min(0)
            .default(22)
            .describe(
              "Metres the band boundaries wander from place to place. Without it every terrace in the world is " +
                "a perfectly level contour ring at the same altitude, which reads as a contour map rather than " +
                "as rock.",
            ),
          jitterFrequency: z.number().positive().default(0.02),
          seed: z.number().int().default(613),
        })
        .default({ enabled: false, step: 55, sharpness: 0.86, strength: 1, rounding: 0.25, minBands: 1.6, mask: { frequency: 0.0012, start: 0.44, end: 0.58, octaves: 3, seed: 881 }, jitter: 22, jitterFrequency: 0.02, seed: 613 })
        .describe(
          "CLIFF TERRACING — the difference between marching-cubes noise and rock. fBm has a bounded gradient, " +
            "so unshaped terrain arrives as rounded bubbles with no sheer face anywhere, no matter how the " +
            "amplitudes are tuned. This remaps altitude within each `step` band so most of the band is spent in " +
            "a short riser and the rest is a flat tread: ledges and walls, which is what a cliff is.\n\n" +
            "It shapes the MOUNTAIN band's own relief, not the finished height, and that choice is load-bearing " +
            "twice over. It self-gates — the mountain mask is already zero over meadows, so terracing cannot " +
            "turn a field into a wedding cake, and no slope test is needed (there is no slope to test inside " +
            "`height()`: `slope()` is defined in terms of it). And it leaves the treads riding the continent and " +
            "hill bands rather than dead level, which is what keeps them reading as rock ledges instead of as a " +
            "contour map.\n\n" +
            "The remap is monotonic, exactly like `coast.cliff`, so the terrain stays a function — no " +
            "self-intersections — and rivers/roads/towns still carve on top of the result. OFF by default; it " +
            "costs one extra noise evaluation per column.",
        ),
      overhang: z
        .object({
          strength: z.number().min(0).default(6).describe("World units the surface can bulge horizontally. 0 = a pure heightfield."),
          frequency: z.number().positive().default(0.02),
          slopeStart: z.number().min(0).max(1).default(0.35).describe("Only steep ground gets overhangs — flat fields must stay walkable."),
          slopeEnd: z.number().min(0).max(1).default(0.7),
        })
        .default({ strength: 6, frequency: 0.02, slopeStart: 0.35, slopeEnd: 0.7 })
        .describe("THE reason to use marching cubes over a heightmap: a true 3D perturbation, so cliffs undercut and arches exist."),
      caves: z
        .object({
          enabled: z
            .boolean()
            .default(false)
            .describe(
              "Noise-carved caves. OFF by default: they cost more than everything else in the generator combined " +
                "(the noise must be evaluated for every voxel of rock in the world), and they give you no control " +
                "over where a system is or where it goes.  is the controllable, far cheaper " +
                "mechanism. Turn this on for a deliberately honeycombed world.",
            ),
          frequency: z.number().positive().default(0.012),
          threshold: z.number().min(0).max(1).default(0.14).describe("Higher = wider, more connected tunnel network."),
          minDepth: z.number().min(0).default(6).describe("Tunnels stay at least this far below the surface (no random pits in a meadow)."),
          floorY: z.number().default(-40).describe("Deepest the tunnel network reaches."),
          sampleStep: z
            .number()
            .positive()
            .default(4)
            .describe(
              "World units between cave-noise samples; values between them are smoothly interpolated. Cave noise " +
                "is evaluated across most of a cell's VOLUME, which makes this the single biggest cost lever in " +
                "the generator — doubling it is close to an 8x saving. Tunnels are tens of metres across, so 4 " +
                "costs nothing visible; approach the voxel size only if you want genuinely rough cave walls.",
            ),
          entrances: z
            .object({
              enabled: z.boolean().default(true),
              slopeStart: z
                .number()
                .min(0)
                .max(1)
                .default(0.5)
                .describe("Steepness at which the tunnel network may start reaching the surface."),
              slopeEnd: z.number().min(0).max(1).default(0.72).describe("Steepness at which it fully may."),
              minDepth: z
                .number()
                .default(-2.5)
                .describe(
                  "The `minDepth` that applies on fully steep ground. NEGATIVE means tunnels are allowed to " +
                    "push past the surface, which is what actually cuts an opening; at 0 they only ever kiss it.",
                ),
            })
            .default({ enabled: true, slopeStart: 0.5, slopeEnd: 0.72, minDepth: -2.5 })
            .describe(
              "Cave MOUTHS. Without this, `minDepth` holds everywhere and the network is sealed — a cave system " +
                "nobody can enter. Relaxing the depth requirement on steep ground opens tunnels onto cliff faces " +
                "and mountainsides, which is both where entrances belong and where they read as deliberate.",
            ),
          seed: z.number().int().default(97),
        })
        .default({
          enabled: false,
          frequency: 0.012,
          threshold: 0.14,
          minDepth: 6,
          floorY: -40,
          sampleStep: 4,
          entrances: { enabled: true, slopeStart: 0.5, slopeEnd: 0.72, minDepth: -2.5 },
          seed: 97,
        }),
    })
    .prefault({}),

  climate: z
    .object({
      temperature: fbmSchema.default({ frequency: 0.0006, amplitude: 1, octaves: 3, lacunarity: 2, gain: 0.5, ridged: false, seed: 211 }),
      moisture: fbmSchema.default({ frequency: 0.0008, amplitude: 1, octaves: 3, lacunarity: 2, gain: 0.5, ridged: false, seed: 307 }),
      contrast: z
        .number()
        .positive()
        .default(2.4)
        .describe(
          "Spreads the climate noise across the full 0..1 range. WITHOUT it the documented semantics are a lie: " +
            "raw fBm clusters hard around the middle (measured 0.23..0.65 for temperature), so a biome window " +
            "written in honest 0..1 terms — a desert at moisture below 0.3, say — simply never fires and the " +
            "biome silently does not exist anywhere in the world. 1 disables the spread.",
        ),
      edge: z
        .object({
          warp: z
            .number()
            .min(0)
            .default(90)
            .describe("World units the climate field is domain-warped by before it is read. This is the LARGE-scale raggedness: it makes a desert reach a peninsula into the meadow instead of ending on a smooth curve."),
          warpFrequency: z.number().positive().default(0.0035),
          strength: z
            .number()
            .min(0)
            .default(0.11)
            .describe("Fine noise (in the climate's own 0..1 units) added to temperature and moisture. This is the SMALL-scale raggedness: it breaks the last few metres of every border into speckle, so the transition is a scatter of blighted ground in the grass rather than a line."),
          frequency: z.number().positive().default(0.03),
          octaves: z.number().int().min(1).max(5).default(2),
          heightJitter: z
            .number()
            .min(0)
            .default(4)
            .describe("World units of noise added to the ground height that HEIGHT windows are tested against — the same trick for the snowline and the beach, which are height-driven rather than climate-driven."),
          seed: z.number().int().default(1013),
        })
        .prefault({})
        .describe(
          "Border raggedness. Without it every biome boundary is an iso-contour of a smooth low-frequency noise " +
            "field, which is exactly as artificial as it sounds — a clean arc of blight sweeping across a meadow. " +
            "Set `warp` and `strength` to 0 for the old razor-smooth behaviour.",
        ),
      zones: zonesSchema
        .optional()
        .describe(
          "Cut the world into large single-purpose regions. When set, temperature and moisture come from each " +
            "zone's anchor (blended only across borders) instead of from the `temperature`/`moisture` noise, " +
            "and every anchor carries landform multipliers so a mountain zone HAS mountains and a swamp is " +
            "flat. The noise fields above still add `edge.strength` speckle. Omit for the classic noise climate.",
        ),
      /** Altitude cools the air — this is what puts snow on peaks in every biome. */
      lapseRate: z
        .number()
        .min(0)
        .default(0.0015)
        .describe(
          "Temperature (0..1) lost per world unit of altitude above sea level. Keep it SMALL. At 0.006 a 50 m hill " +
            "is already 0.3 colder than the shore, which drops it straight into the polar band and puts snow on " +
            "modest green hills — the classic symptom is a white hillside next to a meadow at the same latitude. " +
            "Snow on genuine peaks is the `alpine` biome's height window doing its job; this only tilts the odds.",
        ),
    })
    .prefault({}),

  surfaces: z
    .array(surfaceSchema)
    .min(1)
    .max(MAX_SURFACES)
    .describe(
      "The world's surface PALETTE, up to eight, blended per-vertex. Index order is the weight vector's order. " +
        "Every biome names its cover as weights over this one palette, which is how a blighted zone can be all " +
        "blighted-grass and no grass while a coast is sand and dirt: the weights it does not want are simply zero. " +
        "Each extra surface costs three more fragment fetches (sampling is triplanar), so add them deliberately.",
    ),
  biomes: z.array(biomeSchema).min(1),
  patches: z
    .array(patchSchema)
    .default([])
    .describe(
      "Local surface variation layered over the biome result, in order — dirt worn through grass, rock breaking " +
        "a desert, mottled blight. Biomes decide the KIND of place; patches keep it from being a flat sheet of " +
        "one texture.",
    ),
  scatter: z.array(scatterSchema).default([]),

  features: z
    .object({
      rivers: z.array(riverSchema).default([]),
      canyons: z.array(canyonSchema).default([]).describe("Terraced gorges. Written by `worldgen canyons`."),
      roads: z.array(roadSchema).default([]),
      towns: z.array(townSchema).default([]),
      lakes: z.array(lakeSchema).default([]).describe("Standing water at its own level, basin carved beneath. Written by `worldgen rivers`."),
      bridges: z.array(bridgeSchema).default([]).describe("Road decks spanning rivers. Written by `worldgen roads`."),
      fills: z.array(fillSchema).default([]).describe("Sediment-filled hollows on the river network. Written by `worldgen rivers`."),
      riverPaths: z
        .array(riverPathSchema)
        .default([])
        .describe("Hand- or agent-drawn river centrelines. AUTHORING input: `worldgen rivers` solves each into `rivers`."),
      tunnels: z.array(tunnelSchema).default([]).describe("Carved cave passages. Written by `worldgen caves`."),
      blobs: z.array(blobSchema).default([]),
      pois: z.array(poiSchema).default([]),
    })
    .prefault({}),

  verticalRange: z
    .object({
      above: z.number().min(0).default(14).describe("World units of air polygonized above the highest ground in a cell — headroom for overhangs and arches."),
      below: z
        .number()
        .min(0)
        .default(28)
        .describe("World units of rock polygonized below the lowest ground in a cell. This is what makes surface caves enterable, and it is THE vertical cost knob: it multiplies both the sampled volume AND the cave surface the mesher has to triangulate, so it hits twice. Deeper cave networks want vertical chunk sections, not a bigger band here."),
    })
    .prefault({})
    .describe("The vertical band actually meshed per cell. A voxel world is not infinite in Y for free."),

  textureFilter: z
    .enum(["linear", "nearest"])
    .default("linear")
    .describe(
      "Magnification filter for every terrain surface texture. Set 'nearest' for PIXEL ART so it stays chunky " +
        "instead of being smeared smooth up close. Emitted onto the terrain material by `worldgen material`.",
    ),

  macroNoise: z
    .object({
      scale: z.number().positive().default(90).describe("World units per cycle of the broad band."),
      strength: z.number().min(0).max(1).default(0.22).describe("Brightness swing, plus and minus. 0 disables the whole overlay."),
      octaves: z.number().int().min(1).max(6).default(3),
      detailScale: z.number().positive().optional().describe("Second band, near tile size (10-20). This is the one that hides the grid up close."),
      detailStrength: z.number().min(0).max(1).default(0.1),
      roughnessStrength: z.number().min(0).max(1).default(0),
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
      "Noise multiplied over the whole blended terrain to break up texture repetition, emitted onto the " +
        "terrain material by `worldgen material`. It lives HERE and not only in the material because the " +
        "material is derived data — anything written straight into it is lost the next time the palette " +
        "changes and it gets re-emitted.",
    ),

  /** Material asset id used for the terrain mesh. `worldgen material` writes one matching `surfaces`. */
  material: z.string().optional(),
  waterMaterial: z
    .string()
    .optional()
    .describe(
      "Material asset id for river ribbons and lake sheets emitted into streamed cells. Without it rivers " +
        "are carved but dry. `worldgen init` writes one beside the terrain material.",
    ),
  riverMaterial: z
    .string()
    .optional()
    .describe(
      "Material asset id for river ribbons specifically — a water material with `flowMode: \"channel\"`, so " +
        "the water visibly runs downstream. Falls back to `waterMaterial` (standing water). `worldgen rivers` " +
        "writes `<waterMaterial>-river` and sets this.",
    ),
  bridgeMaterial: z
    .string()
    .optional()
    .describe(
      "Material asset id for the placeholder decks emitted for `features.bridges`. `worldgen roads` writes a " +
        "plain timber-coloured one when the recipe has none.",
    ),
});

export type WorldRecipe = z.infer<typeof worldRecipeSchema>;
export type RiverDoc = z.infer<typeof riverSchema>;
export type CanyonDoc = z.infer<typeof canyonSchema>;
export type RoadDoc = z.infer<typeof roadSchema>;
export type TownDoc = z.infer<typeof townSchema>;
export type BlobDoc = z.infer<typeof blobSchema>;
export type TunnelDoc = z.infer<typeof tunnelSchema>;
export type PoiDoc = z.infer<typeof poiSchema>;
export type LakeDoc = z.infer<typeof lakeSchema>;
export type BridgeDoc = z.infer<typeof bridgeSchema>;
export type FillDoc = z.infer<typeof fillSchema>;
export type RiverPathDoc = z.infer<typeof riverPathSchema>;

/**
 * A complete, good-looking starting world: beaches, meadows, forested hills,
 * rock cliffs, snow peaks, caves and overhangs. Written by `worldgen init`,
 * and used as the fallback so a `voxelWorld` component with a missing recipe
 * still renders something rather than nothing.
 */
export function defaultWorldRecipe(overrides: Partial<WorldRecipe> = {}): WorldRecipe {
  const base = worldRecipeSchema.parse({
    version: 1,
    name: "world",
    seed: 1337,
    // Dunes are off in the schema (they cost a climate lookup per column), but
    // this world ships a desert, and a desert without its own landform is just
    // recoloured hills.
    terrain: { dunes: { amplitude: 10 } },
    // The palette is the world's whole vocabulary of ground. Biomes name
    // weights over it, so a zone excludes what does not belong there simply by
    // weighting it zero — a blighted region can be all blighted-grass and dirt
    // with no grass and no sand, while a coast is sand, grass and dirt.
    surfaces: [
      { name: "grass", color: "#5c7a3f", roughness: 0.95, uvScale: 4 },
      { name: "sand", color: "#c8b184", roughness: 0.9, uvScale: 5 },
      { name: "rock", color: "#7c7972", roughness: 0.95, uvScale: 8 },
      { name: "snow", color: "#e8eef4", roughness: 0.7, uvScale: 6 },
      { name: "dirt", color: "#6b543a", roughness: 0.95, uvScale: 4.5 },
      { name: "icyrock", color: "#7d8b98", roughness: 0.8, uvScale: 7 },
      { name: "blightedgrass", color: "#4a4232", roughness: 0.95, uvScale: 4 },
      { name: "blighteddirt", color: "#463c33", roughness: 0.95, uvScale: 4.5 },
    ],
    biomes: [
      // The seabed rule exists because the rule set must COVER the whole
      // height range. Where nothing matches, the field falls back to the
      // heaviest rule — which, without this, made every stretch of ocean floor
      // render as alpine snow with a hard edge at the waterline. A gap in the
      // rules does not fail loudly; it just produces somewhere absurd.
      // weights are [grass, sand, rock, snow, dirt, icyrock, blightedgrass, blighteddirt]
      { id: "seabed", height: [-500, -1], heightBlend: 4, weight: 1.2, surface: [0, 0.65, 0.35, 0, 0, 0, 0, 0], cliff: [0, 0, 1, 0, 0, 0, 0, 0], cliffStart: 0.57, cliffEnd: 0.82 },
      // Beach is deliberately a NARROW band at the waterline. It is the rule
      // most worth getting right: widen it a little and the whole low third of
      // a world reads as one flat expanse of sand, because that is where most
      // of the land is.
      { id: "beach", height: [-2, 2.5], heightBlend: 2.5, blend: 2.5, weight: 1.3, surface: [0.12, 0.78, 0, 0, 0.1, 0, 0, 0], cliff: [0, 0.2, 0.8, 0, 0, 0, 0, 0], cliffStart: 0.57, cliffEnd: 0.82 },
      // Desert is sand, dirt and rock — never grass, and the rock is what
      // stops a dune field reading as a beach that went on too long. Its
      // window is WIDE on purpose: a desert is a region you travel through for
      // a while, and at 4% of land it was a patch you walked past. A quarter
      // of the world is a continent's worth of it, and the height ceiling lets
      // it climb into the hills instead of stopping at the first slope.
      { id: "desert", temperature: [0.42, 1.1], moisture: [-0.1, 0.55], height: [1, 200], heightBlend: 10, blend: 0.11, weight: 1.6, surface: [0, 0.66, 0.1, 0, 0.24, 0, 0, 0], cliff: [0, 0.12, 0.72, 0, 0.16, 0, 0, 0], cliffStart: 0.57, cliffEnd: 0.82 },
      { id: "meadow", temperature: [0.18, 0.92], moisture: [0.24, 1.1], height: [1, 72], heightBlend: 10, blend: 0.1, weight: 1.2, surface: [0.88, 0, 0, 0, 0.12, 0, 0, 0], cliff: [0, 0, 0.75, 0, 0.25, 0, 0, 0], cliffStart: 0.57, cliffEnd: 0.82 },
      // The altitude ladder. Each rung has to be WIDE — a 300 m mountain that
      // passes through green, rock, tundra and snow in the last 40 m of its
      // height reads as a painted cone. Ranges overlap by design; membership
      // is smooth, so the ladder is a gradient, not four stripes.
      { id: "highland", height: [58, 190], heightBlend: 22, surface: [0.5, 0, 0.35, 0, 0.15, 0, 0, 0], cliff: [0, 0, 1, 0, 0, 0, 0, 0], cliffStart: 0.6, cliffEnd: 0.85 },
      // Alpine tundra: the belt between the last trees and the permanent snow.
      // Without it a mountain goes from meadow-green to white in one step, and
      // the snow line reads as a decal rather than as an altitude.
      { id: "montane", height: [170, 330], heightBlend: 30, weight: 1.15, surface: [0.16, 0, 0.34, 0.22, 0.08, 0.2, 0, 0], cliff: [0, 0, 0.55, 0, 0, 0.45, 0, 0], cliffStart: 0.57, cliffEnd: 0.84 },
      { id: "alpine", height: [310, 1400], heightBlend: 34, weight: 1.4, surface: [0, 0, 0, 0.8, 0, 0.2, 0, 0], cliff: [0, 0, 0, 0.15, 0, 0.85, 0, 0], cliffStart: 0.62, cliffEnd: 0.87 },
      { id: "tundra", temperature: [-0.1, 0.2], height: [1, 1400], heightBlend: 6, blend: 0.09, surface: [0.15, 0, 0, 0.6, 0.05, 0.2, 0, 0], cliff: [0, 0, 0, 0.15, 0, 0.85, 0, 0], cliffStart: 0.57, cliffEnd: 0.82 },
      // A blighted zone: dead ground with NO grass and NO sand in it at all.
      // It is a normal biome rule — the "zone" is just a window in climate
      // space (hot and bone dry) plus a height floor that keeps it off the
      // shoreline, and weights that exclude what does not belong. Nothing
      // special-cases it, which is the point: any number of these can be added
      // without touching the mesher, the shader or the streamer.
      {
        id: "blight",
        temperature: [0.7, 1.1],
        moisture: [-0.1, 0.3],
        // kept OFF the shoreline: blighted ground running down into the surf
        // reads as a texturing accident rather than a place
        height: [12, 300],
        heightBlend: 12,
        blend: 0.1,
        // outweighs the desert deliberately: the two share the hot, dry corner
        // of climate space, and widening the desert to a quarter of the world
        // cut the blight from 1.1% to 0.4% before this went up
        weight: 3.2,
        surface: [0, 0, 0, 0, 0.15, 0, 0.55, 0.3],
        cliff: [0, 0, 0.45, 0, 0, 0, 0, 0.55],
        tint: "#b9ad9e",
      },
      // Bare rock on genuinely steep ground, in EVERY biome and at every
      // altitude. Each biome already names its own `cliff` cover, but that is
      // a per-biome judgement about a slope; this is the physical fact that
      // nothing — not grass, not sand, not snow — stays on a near-vertical
      // face. It is what keeps a snowfield from painting itself down a
      // precipice, and it is why the answer to "is steep ground rock?" is yes
      // twice over: the biome's own cliff weights first, this underneath.
      {
        id: "crag",
        // cover only: 'which biome is this' must still answer meadow/desert/
        // alpine on a slope, or every biome-filtered scatter rule stops firing
        // wherever the ground tilts
        label: false,
        slope: [0.78, 1.2],
        blend: 0.12,
        weight: 2.4,
        surface: [0, 0, 1, 0, 0, 0, 0, 0],
        cliff: [0, 0, 1, 0, 0, 0, 0, 0],
      },
    ],
    // The second scale of surface detail. Biomes are hundreds of metres
    // across; these are tens, and they are what stops a meadow being a sheet.
    patches: [
      { id: "worn-dirt", surface: "dirt", biomes: ["meadow", "highland"], frequency: 0.022, octaves: 3, threshold: 0.2, blend: 0.26, strength: 0.75, seed: 5 },
      { id: "scree", surface: "rock", biomes: ["meadow", "highland", "tundra"], frequency: 0.03, octaves: 2, threshold: 0.34, blend: 0.16, strength: 0.7, slope: [0.3, 1.2], seed: 17 },
      // Two patches over the blight, at different scales and both strong:
      // that is what "splotchy" is — large sick-grass blotches with bare
      // dead earth eating holes through them.
      { id: "blight-rot", surface: "blighteddirt", biomes: ["blight"], frequency: 0.017, octaves: 3, threshold: 0.02, blend: 0.3, strength: 0.85, seed: 29 },
      { id: "blight-scab", surface: "blightedgrass", biomes: ["blight"], frequency: 0.055, octaves: 2, threshold: 0.24, blend: 0.12, strength: 0.7, seed: 41 },
      // Desert: rock breaking the surface between the dunes, and wind-scoured
      // dirt in the troughs.
      { id: "desert-rock", surface: "rock", biomes: ["desert"], frequency: 0.026, octaves: 3, threshold: 0.36, blend: 0.14, strength: 0.85, seed: 53 },
      { id: "desert-dirt", surface: "dirt", biomes: ["desert"], frequency: 0.04, octaves: 2, threshold: 0.22, blend: 0.24, strength: 0.55, seed: 67 },
    ],
    scatter: [],
  });
  return { ...base, ...overrides };
}

/**
 * The second-generation starting world: continents in a bounded sea, cut into
 * large zones — tundra, taiga, mountains, highlands, grassland, forest, swamp,
 * jungle, desert, badlands, blight — each with its own landform, plus a
 * height ceiling, eroded mountains and a land floor that keeps the ocean out
 * of the interior. Written by `worldgen init`; `defaultWorldRecipe` remains
 * the classic endless-noise world.
 *
 * Every number here is a starting point, not a law. The design rules that
 * are not negotiable: a zone is ONE kind of place (its anchor), the biome
 * rules that belong to a zone are gated to it, and the altitude ladder
 * (highland / montane / alpine) stays ungated so a peak in any zone reads as
 * a peak.
 */
export function continentalWorldRecipe(overrides: Partial<WorldRecipe> = {}): WorldRecipe {
  const classic = defaultWorldRecipe();
  // palette: [grass, sand, rock, snow, dirt, cliff, ice, blighted, mud, redrock]
  const G = 0;
  const S = 1;
  const R = 2;
  const W = 3;
  const D = 4;
  const C = 5;
  const I = 6;
  const B = 7;
  const M = 8;
  const X = 9;
  void I;
  const w = (entries: Partial<Record<number, number>>): number[] => {
    const out = new Array<number>(10).fill(0);
    for (const [k, v] of Object.entries(entries)) out[Number(k)] = v ?? 0;
    return out;
  };
  const base = worldRecipeSchema.parse({
    ...classic,
    name: "world",
    seaLevel: 0,
    minY: -70,
    maxY: 700,
    terrain: {
      ...classic.terrain,
      base: 55,
      continent: { frequency: 0.00045, amplitude: 45, octaves: 4, lacunarity: 2, gain: 0.5, ridged: false, seed: 11, erosion: 0.2 },
      hills: { frequency: 0.0055, amplitude: 14, octaves: 4, lacunarity: 2.1, gain: 0.48, ridged: false, seed: 23, erosion: 0.35 },
      mountains: { frequency: 0.0017, amplitude: 1050, octaves: 5, lacunarity: 2.05, gain: 0.47, ridged: true, seed: 37, erosion: 0.55, crest: 0.2 },
      mountainMask: { spec: { frequency: 0.0013, amplitude: 1, octaves: 3, lacunarity: 2, gain: 0.5, ridged: false, seed: 53 }, start: 0.38, end: 0.7 },
      detail: { frequency: 0.035, amplitude: 1.2, octaves: 3, lacunarity: 2, gain: 0.5, ridged: false, seed: 71 },
      ceiling: { height: 520, softness: 150 },
      dunes: { ...classic.terrain.dunes, amplitude: 12, frequency: 0.012, stretch: 3.5, angle: 0.6 },
      mesas: { amplitude: 70, frequency: 0.0034, octaves: 3, steps: 4, sharpness: 0.82, seed: 719 },
      // overhangs only on genuinely steep faces: on every 20-degree slope they
      // read as lumps, and lumps are what "jagged" looks like up close
      overhang: { strength: 4, frequency: 0.02, slopeStart: 0.62, slopeEnd: 0.88 },
      coast: { ...classic.terrain.coast, cliff: 2.6, band: 20 },
    },
    bounds: {
      continents: [
        { center: [0, 0], radius: 2200, falloff: 650, warp: 0.6, warpScale: 1100, coastVariation: 0.55, coastVariationScale: 1600 },
        { center: [3300, -1900], radius: 520, falloff: 380, warp: 0.5, warpScale: 700, coastVariation: 0.5, coastVariationScale: 900 },
        { center: [-3100, 2300], radius: 640, falloff: 420, warp: 0.5, warpScale: 700, coastVariation: 0.5, coastVariationScale: 900 },
      ],
      oceanFloor: -45,
      landFloor: 4,
      shelf: 0.58,
      limit: 4600,
      limitFalloff: 600,
    },
    climate: {
      ...classic.climate,
      lapseRate: 0.0015,
      edge: { ...classic.climate.edge, warp: 110, strength: 0.06, heightJitter: 4 },
      zones: {
        size: 1500,
        jitter: 0.85,
        warp: 240,
        warpFrequency: 0.0009,
        border: 200,
        latitude: { strength: 0.7, scale: 7000, axis: "z", flip: false },
        anchors: [
          { id: "tundra", temperature: 0.08, moisture: 0.45, weight: 1, latitude: 0.05, relief: 0.5, hills: 0.9 },
          { id: "taiga", temperature: 0.25, moisture: 0.65, weight: 1.2, latitude: 0.2, relief: 0.35, hills: 1.1 },
          { id: "peaks", temperature: 0.28, moisture: 0.5, weight: 1, latitude: 0.3, relief: 1.35, hills: 1 },
          { id: "mountains", temperature: 0.4, moisture: 0.5, weight: 1.5, relief: 1, hills: 1 },
          { id: "foothills", temperature: 0.48, moisture: 0.55, weight: 1, relief: 0.55, hills: 1.3 },
          { id: "highlands", temperature: 0.5, moisture: 0.5, weight: 1.1, relief: 0.25, hills: 1.7 },
          { id: "moor", temperature: 0.35, moisture: 0.6, weight: 0.9, latitude: 0.3, relief: 0.3, hills: 1.5 },
          { id: "fen", temperature: 0.3, moisture: 0.95, weight: 0.7, latitude: 0.25, relief: 0, hills: 0.2, flatten: 0.9 },
          { id: "savanna", temperature: 0.78, moisture: 0.3, weight: 1.1, latitude: 0.7, relief: 0.1, hills: 0.5 },
          { id: "grassland", temperature: 0.58, moisture: 0.42, weight: 1.5, latitude: 0.5, relief: 0.05, hills: 0.7 },
          { id: "forest", temperature: 0.52, moisture: 0.7, weight: 1.5, latitude: 0.45, relief: 0.15, hills: 1 },
          { id: "swamp", temperature: 0.62, moisture: 0.95, weight: 0.8, latitude: 0.55, relief: 0, hills: 0.25, flatten: 1 },
          { id: "jungle", temperature: 0.88, moisture: 0.9, weight: 1, latitude: 0.9, relief: 0.3, hills: 1.2 },
          { id: "desert", temperature: 0.92, moisture: 0.08, weight: 1.2, latitude: 0.85, relief: 0.08, hills: 0.5, dunes: 1 },
          { id: "badlands", temperature: 0.8, moisture: 0.22, weight: 0.9, latitude: 0.75, relief: 0.15, hills: 0.6, mesas: 1 },
          { id: "blight", temperature: 0.75, moisture: 0.15, weight: 0.55, latitude: 0.65, relief: 0.2, hills: 0.9 },
        ],
      },
    },
    surfaces: [
      { name: "grass", color: "#5c7a3f", roughness: 0.95, uvScale: 4 },
      { name: "sand", color: "#c8b184", roughness: 0.9, uvScale: 5 },
      { name: "rock", color: "#7c7972", roughness: 0.95, uvScale: 11 },
      { name: "snow", color: "#e8eef4", roughness: 0.7, uvScale: 6 },
      { name: "dirt", color: "#6b543a", roughness: 0.95, uvScale: 4.5 },
      { name: "cliff", color: "#6f6659", roughness: 0.95, uvScale: 20 },
      { name: "ice", color: "#a3bdd4", roughness: 0.3, uvScale: 7 },
      { name: "blighted", color: "#463c33", roughness: 0.95, uvScale: 4 },
      { name: "mud", color: "#4a4633", roughness: 0.98, uvScale: 4 },
      { name: "redrock", color: "#9a5a3c", roughness: 0.95, uvScale: 9 },
    ],
    biomes: [
      { id: "seabed", height: [-500, -1], heightBlend: 4, weight: 1.2, surface: w({ [S]: 0.65, [R]: 0.35 }), cliff: w({ [R]: 0.3, [C]: 0.7 }), cliffStart: 0.72, cliffEnd: 0.88 },
      { id: "beach", height: [-2, 2.5], heightBlend: 2.5, blend: 2.5, weight: 1.3, surface: w({ [G]: 0.1, [S]: 0.8, [D]: 0.1 }), cliff: w({ [S]: 0.12, [R]: 0.28, [C]: 0.6 }), cliffStart: 0.72, cliffEnd: 0.88 },
      // zone-gated cover, one rule per kind of place
      { id: "tundra", zones: ["tundra"], height: [2, 1400], heightBlend: 6, weight: 1.4, surface: w({ [G]: 0.3, [R]: 0.15, [W]: 0.45, [D]: 0.1 }), cliff: w({ [R]: 0.25, [W]: 0.15, [C]: 0.6 }), cliffStart: 0.72, cliffEnd: 0.88, tint: "#c9d3cc" },
      { id: "taiga", zones: ["taiga"], height: [2, 1400], heightBlend: 6, weight: 1.4, surface: w({ [G]: 0.68, [R]: 0.08, [D]: 0.24 }), cliff: w({ [R]: 0.3, [C]: 0.7 }), cliffStart: 0.72, cliffEnd: 0.88, tint: "#8fa58a" },
      { id: "grassland", zones: ["grassland", "highlands"], height: [2, 170], heightBlend: 12, weight: 1.4, surface: w({ [G]: 0.9, [D]: 0.1 }), cliff: w({ [R]: 0.3, [D]: 0.1, [C]: 0.6 }), cliffStart: 0.72, cliffEnd: 0.88 },
      { id: "forest", zones: ["forest"], height: [2, 170], heightBlend: 12, weight: 1.4, surface: w({ [G]: 0.72, [D]: 0.28 }), cliff: w({ [R]: 0.3, [D]: 0.1, [C]: 0.6 }), cliffStart: 0.72, cliffEnd: 0.88, tint: "#8ea36e" },
      { id: "foothills", zones: ["mountains", "peaks", "foothills"], height: [2, 130], heightBlend: 14, weight: 1.3, surface: w({ [G]: 0.7, [R]: 0.15, [D]: 0.15 }), cliff: w({ [R]: 0.3, [C]: 0.7 }), cliffStart: 0.72, cliffEnd: 0.88 },
      { id: "moor", zones: ["moor"], height: [2, 260], heightBlend: 14, weight: 1.4, surface: w({ [G]: 0.55, [R]: 0.2, [D]: 0.25 }), cliff: w({ [R]: 0.35, [C]: 0.65 }), cliffStart: 0.72, cliffEnd: 0.88, tint: "#9c8f7a" },
      { id: "fen", zones: ["fen"], height: [2, 50], heightBlend: 8, weight: 1.6, surface: w({ [G]: 0.35, [D]: 0.15, [M]: 0.5 }), cliff: w({ [D]: 0.3, [M]: 0.3, [R]: 0.4 }), cliffStart: 0.72, cliffEnd: 0.88, tint: "#8a9a86" },
      { id: "savanna", zones: ["savanna"], height: [1, 200], heightBlend: 12, weight: 1.4, surface: w({ [G]: 0.7, [S]: 0.1, [D]: 0.2 }), cliff: w({ [R]: 0.3, [D]: 0.1, [C]: 0.6 }), cliffStart: 0.72, cliffEnd: 0.88, tint: "#c9b36a" },
      { id: "swamp", zones: ["swamp"], height: [2, 60], heightBlend: 8, weight: 1.6, surface: w({ [G]: 0.4, [D]: 0.2, [M]: 0.4 }), cliff: w({ [D]: 0.3, [M]: 0.3, [R]: 0.4 }), cliffStart: 0.72, cliffEnd: 0.88, tint: "#7f8b5a" },
      { id: "jungle", zones: ["jungle"], height: [2, 200], heightBlend: 12, weight: 1.4, surface: w({ [G]: 0.75, [D]: 0.25 }), cliff: w({ [R]: 0.35, [C]: 0.65 }), cliffStart: 0.72, cliffEnd: 0.88, tint: "#5f9a4a" },
      { id: "desert", zones: ["desert"], height: [1, 240], heightBlend: 10, weight: 1.4, surface: w({ [S]: 0.7, [R]: 0.08, [D]: 0.22 }), cliff: w({ [S]: 0.1, [R]: 0.24, [D]: 0.1, [C]: 0.56 }), cliffStart: 0.72, cliffEnd: 0.88 },
      { id: "badlands", zones: ["badlands"], height: [1, 260], heightBlend: 10, weight: 1.4, surface: w({ [S]: 0.15, [R]: 0.2, [D]: 0.25, [X]: 0.4 }), cliff: w({ [R]: 0.2, [X]: 0.6, [C]: 0.2 }), cliffStart: 0.66, cliffEnd: 0.84, tint: "#c8927a" },
      { id: "blight", zones: ["blight"], height: [1, 300], heightBlend: 10, weight: 1.4, surface: w({ [D]: 0.25, [B]: 0.75 }), cliff: w({ [R]: 0.28, [C]: 0.42, [B]: 0.3 }), cliffStart: 0.72, cliffEnd: 0.88, tint: "#b9ad9e" },
      // the altitude ladder, ungated: a peak in any zone climbs it
      { id: "highland", height: [120, 240], heightBlend: 26, weight: 1.1, surface: w({ [G]: 0.5, [R]: 0.35, [D]: 0.15 }), cliff: w({ [R]: 0.24, [C]: 0.76 }), cliffStart: 0.74, cliffEnd: 0.9 },
      { id: "montane", height: [220, 360], heightBlend: 32, weight: 1.2, surface: w({ [G]: 0.16, [R]: 0.4, [W]: 0.3, [D]: 0.14 }), cliff: w({ [R]: 0.2, [W]: 0.12, [C]: 0.68 }), cliffStart: 0.72, cliffEnd: 0.88 },
      { id: "alpine", height: [340, 1400], heightBlend: 36, temperature: [-0.1, 0.78], blend: 0.1, weight: 1.5, surface: w({ [R]: 0.1, [W]: 0.9 }), cliff: w({ [R]: 0.17, [W]: 0.28, [C]: 0.55 }), cliffStart: 0.74, cliffEnd: 0.9 },
      { id: "crag", label: false, slope: [0.78, 1.2], blend: 0.12, heightBlend: 6, weight: 2.4, surface: w({ [R]: 0.3, [C]: 0.7 }), cliff: w({ [R]: 0.1, [C]: 0.9 }), cliffStart: 0.7, cliffEnd: 0.86 },
    ],
    patches: [
      { id: "worn-dirt", surface: "dirt", biomes: ["grassland", "foothills", "highland", "taiga", "moor", "savanna"], frequency: 0.022, octaves: 3, threshold: 0.2, blend: 0.26, strength: 0.75, seed: 5 },
      { id: "fen-pools", surface: "mud", biomes: ["fen"], frequency: 0.028, octaves: 3, threshold: 0.05, blend: 0.2, strength: 0.9, seed: 23 },
      { id: "moor-rock", surface: "rock", biomes: ["moor"], frequency: 0.03, octaves: 3, threshold: 0.3, blend: 0.16, strength: 0.7, seed: 37 },
      { id: "forest-floor", surface: "dirt", biomes: ["forest", "jungle"], frequency: 0.03, octaves: 3, threshold: 0.05, blend: 0.3, strength: 0.7, seed: 11 },
      { id: "swamp-pools", surface: "mud", biomes: ["swamp"], frequency: 0.03, octaves: 3, threshold: 0.1, blend: 0.2, strength: 0.9, seed: 19 },
      { id: "blight-rot", surface: "blighted", biomes: ["blight"], frequency: 0.017, octaves: 3, threshold: 0.02, blend: 0.3, strength: 0.85, seed: 29 },
      { id: "blight-scab", surface: "dirt", biomes: ["blight"], frequency: 0.055, octaves: 2, threshold: 0.24, blend: 0.12, strength: 0.7, seed: 41 },
      { id: "desert-rock", surface: "rock", biomes: ["desert"], frequency: 0.026, octaves: 3, threshold: 0.36, blend: 0.14, strength: 0.85, seed: 53 },
      { id: "badland-strata", surface: "sand", biomes: ["badlands"], frequency: 0.04, octaves: 2, threshold: 0.3, blend: 0.15, strength: 0.6, seed: 61 },
      { id: "alpine-ice", surface: "ice", biomes: ["alpine", "tundra", "montane"], frequency: 0.011, octaves: 3, threshold: -0.15, blend: 0.4, strength: 0.9, slope: [0, 0.3], seed: 83 },
      { id: "cliff-skirt", surface: "rock", biomes: [], frequency: 0.035, octaves: 3, threshold: -0.55, blend: 0.5, strength: 0.85, slope: [0.45, 0.8], seed: 17 },
    ],
    scatter: [],
    features: { rivers: [], canyons: [], roads: [], towns: [], lakes: [], tunnels: [], blobs: [], pois: [] },
  });
  return { ...base, ...overrides };
}

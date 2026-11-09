/**
 * Vegetation by REGION and CLEARINGS — the two data controls over the foliage
 * system that are not biome or surface.
 *
 * The scatter rules and cover layers choose plants by climate: biome, slope,
 * surface, height. That cannot say "a few wind-bent pines at Hrimgard", "dead
 * pines on bare spoil at the Gnawspur" or "no palms anywhere in this dark
 * northern zone", and it cannot keep a hall pad or a town plot bare. So:
 *
 * - `regions[].vegetation` (a zone, a town zone or a `place` region) filters,
 *   thins, thickens and SWAPS scatter species and cover layers inside its
 *   polygon. Resolved most-specific region first (place > town > zone), field
 *   by field: a place that names only `scatter.density` keeps its zone's
 *   `replace` and `deny`.
 * - `features.clearings` (polygon or circle + feather) remove (or thin) scatter
 *   and cover inside, for a site's footprint or a town's building plots.
 *
 * Both are pure functions of world position and the lattice hash, read by the
 * ONE scatter path (`scatterCell`, which the client worker, the server's
 * collider worker and every CLI audit call) and the ONE cover gate
 * (`coverVegetationRejects`, called by the shared cover sampler), so render,
 * collision and audits cannot disagree. A world without either pays one
 * boolean test per candidate and places bit-for-bit what it placed before.
 */
import { z } from "zod";
import { coverClumpKeep, coverKeepHash } from "./cover.js";
import { FAR_INSIDE, PolygonIndex, type OutlineSpec } from "./polygon-index.js";
import type { RegionDoc } from "./regions.js";

const slug = z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase slug");

const scatterVegetationSchema = z
  .object({
    allow: z
      .array(z.string())
      .optional()
      .describe(
        "Scatter rule ids that MAY grow here; every other rule is off. Omit to allow all. Filters only: a rule " +
          "still needs its own biomes/slope/height to place, so this can never put a palm in a taiga. Rocks are " +
          "scatter rules too — list them or they vanish.",
      ),
    deny: z
      .array(z.string())
      .optional()
      .describe("Scatter rule ids that never grow here. Unioned down the region chain: a place cannot re-allow what its zone denies."),
    density: z
      .number()
      .min(0)
      .max(8)
      .optional()
      .describe(
        "Multiplier on every allowed rule not named in `rules`. Below 1 thins (0.25 = 'a few'); 0 removes. " +
          "Above 1 only FILLS BACK what the rule's `clump` and `biomeDensity` thinned — never past the rule's own " +
          "`density`, which fixes the lattice. To grow more than that, raise the rule's density and thin it elsewhere.",
      ),
    rules: z
      .record(z.string(), z.number().min(0).max(8))
      .optional()
      .describe("Per-rule multiplier, rule id -> number; REPLACES `density` for that rule. { \"pine\": 0.2, \"rock-small\": 2 }."),
    replace: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Species swap, rule id -> rule id: a candidate of the first rule that survives every gate (its biomes, slope, " +
          "density here) is emitted as the second rule's model, scale, collider and tint. { \"pine\": \"dead-dried-tree\" } " +
          "turns a pine wood dead; { \"palm\": \"pine\" } keeps a beach wooded in a northern zone. The target may be a " +
          "rule with density 0 kept only for this. Not applied to cliff-column rules.",
      ),
    lean: z
      .object({
        degrees: z.number().min(0).max(35).describe("How far the tops lean, from vertical."),
        toward: z
          .tuple([z.number(), z.number()])
          .describe("World direction [x, z] the tops lean toward (downwind). North is -Z: [0, -1] leans north."),
        jitter: z.number().min(0).max(20).default(4).describe("Per-tree random spread on `degrees`, so a stand is not a parade."),
        rules: z
          .array(z.string())
          .default([])
          .describe("Rule ids (as EMITTED, after `replace`) that lean. Empty = every rule with a cylinder collider (the trees)."),
      })
      .optional()
      .describe("Wind-bent stands: trees in this region lean together. Collision follows the same rotation."),
  })
  .describe("Scatter (props: trees, bushes, rocks) inside this region.");

const coverVegetationSchema = z
  .object({
    allow: z.array(z.string()).optional().describe("Cover layer ids (`cover[].id`) that may grow here; all others are off. Omit to allow all."),
    deny: z.array(z.string()).optional().describe("Cover layer ids that never grow here. Unioned down the region chain."),
    density: z
      .number()
      .min(0)
      .max(8)
      .optional()
      .describe("Multiplier on every allowed layer not named in `layers`. Below 1 thins; 0 = bare ground; above 1 fills back the layer's clump thinning only."),
    layers: z.record(z.string(), z.number().min(0).max(8)).optional().describe("Per-layer multiplier, layer id -> number; REPLACES `density` for that layer."),
  })
  .describe("Ground cover (grass, flowers, reeds) inside this region.");

export const regionVegetationSchema = z
  .object({
    scatter: scatterVegetationSchema.optional(),
    cover: coverVegetationSchema.optional(),
    margin: z
      .number()
      .min(0)
      .max(200)
      .default(0)
      .describe(
        "Metres OUTSIDE this region's own polygon that it still governs, where no region contains the point. For a " +
          "zone whose border was drawn along the waterline: its beach lies outside every zone, so without a margin " +
          "the biomes alone decide there (palms on a northern shore). Not inherited.",
      ),
    note: z.string().optional().describe("Why — the mood line this implements ('a few wind-bent pines')."),
  })
  .describe(
    "What grows in this region, over what the biomes choose: allow/deny species, thin or thicken, swap species " +
      "(dead pines, no palms), lean the trees. Resolved most-specific region first (place > town > zone), field by " +
      "field. Read by scatter and the cover gate alike; deterministic. Set with `worldgen vegetation --region`.",
  );

export type RegionVegetation = z.infer<typeof regionVegetationSchema>;

export const clearingSchema = z
  .object({
    id: slug.describe("Stable id; `worldgen vegetation --clearing` replaces by id. Prefix with the owner (`hrimgard-hall-pad`, `brinehold-plot-12`)."),
    polygon: z
      .array(z.tuple([z.number(), z.number()]))
      .min(3)
      .optional()
      .describe("Outline in world metres [x, z]. Give this OR center + radius."),
    center: z.tuple([z.number(), z.number()]).optional().describe("Circle centre [x, z] (with `radius`)."),
    radius: z.number().positive().optional().describe("Circle radius in metres (with `center`)."),
    feather: z
      .number()
      .min(0)
      .max(60)
      .default(3)
      .describe("Metres OUTSIDE the edge over which plants return, from `keep` to full. 0 = a hard edge (reads as a stencil)."),
    keep: z.number().min(0).max(1).default(0).describe("Fraction that survives inside: 0 clears, 0.3 leaves a thinned site."),
    scatter: z
      .boolean()
      .default(true)
      .describe("Clear scatter props. A prop's canopy footprint counts, so a big tree keeps its whole crown off the clearing."),
    cover: z.boolean().default(true).describe("Clear ground cover."),
    owner: z.string().optional().describe("Who wrote it (a POI or town id) — installers remove their own by owner."),
    rules: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Only these scatter rule ids are cleared (omitted = every rule; ground cover is never cleared by a rule-limited " +
          "clearing). A generated species keeps out of the places' footprints this way without clearing the rocks the " +
          "ground already carries (`worldgen flora` writes the woodland's keep-outs so).",
      ),
  })
  .refine((c) => (c.polygon !== undefined) !== (c.center !== undefined && c.radius !== undefined), {
    message: "a clearing needs a polygon OR center + radius (not both, not neither)",
  })
  .describe(
    "A patch where scatter and/or cover do not grow: a site's footprint, a hall pad, a quarry floor, a town's " +
      "building plot, street or door path. Replaces burying additive blobs to suppress foliage. Terrain is untouched.",
  );

export type ClearingDoc = z.infer<typeof clearingSchema>;

/**
 * A declared FIELD: the only ground a crop cover layer (`cover[].fields: true` — wheat, grain) grows on. Owner ruling
 * 2026-10-30 (redstrand): a desert has no wheat-looking grass; a farm has crops. A place (a farm, a croft) declares
 * its strips here; everywhere else the crop layers are off.
 */
export const fieldSchema = z
  .object({
    id: slug.describe("Stable id; prefix with the owner (`strand-farm-strips`)."),
    polygon: z.array(z.tuple([z.number(), z.number()])).min(3).optional().describe("Outline in world metres [x, z]. Give this OR center + radius."),
    center: z.tuple([z.number(), z.number()]).optional().describe("Circle centre [x, z] (with `radius`)."),
    radius: z.number().positive().optional().describe("Circle radius in metres (with `center`)."),
    feather: z
      .number()
      .min(0)
      .max(30)
      .default(2)
      .describe("Metres INSIDE the edge over which the crop thins to nothing at the edge (0 = a hard edge, a ploughed strip)."),
    layers: z
      .array(z.string().min(1))
      .optional()
      .describe("The crop layer ids (`cover[].id` with `fields: true`) sown here; omitted = every crop layer."),
    owner: z.string().optional().describe("Who declared it (a place or town id) — installers remove their own by owner."),
  })
  .refine((c) => (c.polygon !== undefined) !== (c.center !== undefined && c.radius !== undefined), {
    message: "a field needs a polygon OR center + radius (not both, not neither)",
  })
  .describe(
    "Ground where crop cover grows (a farm's strips). Crop layers (`cover[].fields: true`) grow nowhere else; every " +
      "other layer ignores fields. Terrain and scatter are untouched. Written by `worldgen vegetation --fields <file>`.",
  );

export type FieldDoc = z.infer<typeof fieldSchema>;

/** The recipe fields this module reads — kept structural so tests can pass a slice. */
export interface VegetationRecipe {
  regions?: readonly RegionDoc[];
  scatter: readonly { id: string; collider?: string }[];
  cover?: readonly { id: string; fields?: boolean; regions?: readonly string[]; exceptRegions?: readonly string[] }[];
  features: {
    clearings?: readonly ClearingDoc[];
    fields?: readonly FieldDoc[];

    groundPaints?: readonly { polygon?: [number, number][]; center?: [number, number]; radius?: number; feather?: number; clear?: { scatter: boolean; cover: boolean } }[];
    kitWalls?: readonly { cuts: readonly { origin: readonly number[]; dir: readonly number[]; s: readonly number[]; n: readonly number[] }[] }[];
  };
}

/** One region's resolved effect, compiled to rule/layer indices. */
export interface VegetationPlan {
  /** The region it was resolved for. */
  region: string;
  /** Per scatter rule: 0 = off, 1 = untouched, else the multiplier. */
  ruleKeep: Float32Array;
  /** Per scatter rule: the rule index it is emitted as (itself when not swapped). */
  replace: Int32Array;
  /** Per cover layer: 0 = off, 1 = untouched, else the multiplier. */
  layerKeep: Float32Array;
  /** Lean, when set: per EMITTED rule whether it leans. */
  lean: { radians: number; jitter: number; axisAngle: number; rules: Uint8Array } | null;
}

const BUCKET = 128;
/** Largest prop footprint (m) a clearing pushes back; `clearingKeep` clamps its `pad` to it. */
export const CLEARING_PAD = 12;
const bucketKey = (bx: number, bz: number): number => (bx + 32768) * 65536 + (bz + 32768);

/** Polygons bucketed by bounding box; a query walks the few whose box covers its bucket. */
class Buckets {
  private readonly map = new Map<number, number[]>();
  add(item: number, minX: number, minZ: number, maxX: number, maxZ: number): void {
    for (let bz = Math.floor(minZ / BUCKET); bz <= Math.floor(maxZ / BUCKET); bz++) {
      for (let bx = Math.floor(minX / BUCKET); bx <= Math.floor(maxX / BUCKET); bx++) {
        const key = bucketKey(bx, bz);
        const list = this.map.get(key);
        if (list) list.push(item);
        else this.map.set(key, [item]);
      }
    }
  }
  at(x: number, z: number): readonly number[] | undefined {
    return this.map.get(bucketKey(Math.floor(x / BUCKET), Math.floor(z / BUCKET)));
  }
}

function boundsOf(points: readonly (readonly [number, number])[], pad: number): [number, number, number, number] {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return [minX - pad, minZ - pad, maxX + pad, maxZ + pad];
}

/**
 * The compiled vegetation of one recipe: region plans and clearings, both
 * bucketed. Built once per recipe object (`vegetationIndex`), immutable,
 * allocation-free to query.
 */
export class VegetationIndex {
  /** Nothing to do anywhere: every query short-circuits on this. */
  readonly empty: boolean;
  readonly hasPlans: boolean;
  readonly hasClearings: boolean;
  /** Plan per region index (null = no vegetation in its chain). */
  readonly plans: readonly (VegetationPlan | null)[];
  private readonly regionOrder: number[] = [];
  /** Per slot: the region's own `margin` (0 = polygon only). */
  private readonly regionMargin: number[] = [];
  private readonly hasMargins: boolean;
  private readonly regionIndex: PolygonIndex | null;
  /** Bucket -> slots into `regionOrder`, most specific first. */
  private readonly regionBuckets = new Buckets();
  private readonly clearings: readonly ClearingDoc[];
  private readonly clearingIndex: PolygonIndex | null;
  private readonly clearingBuckets = new Buckets();
  /** Some cover layer grows only in (or never in) named regions. */
  readonly hasRegionLayers: boolean;
  /** Per cover layer: null = anywhere, else per region index (last slot = outside every region) 1 = may grow. */
  private readonly layerRegions: readonly (Uint8Array | null)[];
  /** Crop layers (`cover[].fields`) exist: every one of them grows only inside a declared field. */
  readonly hasCrops: boolean;
  private readonly fields: readonly FieldDoc[];
  private readonly fieldIndex: PolygonIndex | null;
  private readonly fieldBuckets = new Buckets();
  private readonly layerOf = new WeakMap<object, number>();
  private readonly layerById = new Map<string, number>();
  private readonly ruleById = new Map<string, number>();
  /** Problems found compiling (unknown ids) — `worldgen vegetation` prints them. */
  readonly warnings: string[] = [];

  constructor(recipe: VegetationRecipe) {
    const regions = recipe.regions ?? [];
    const cover = recipe.cover ?? [];
    recipe.scatter.forEach((rule, i) => this.ruleById.set(rule.id, i));
    cover.forEach((layer, i) => {
      this.layerById.set(layer.id, i);
      this.layerOf.set(layer, i);
    });

    // ---- region plans
    const byId = new Map(regions.map((r, i) => [r.id, i] as const));
    const chainOf = (i: number): number[] => {
      const chain: number[] = [];
      const seen = new Set<number>();
      let at: number | undefined = i;
      while (at !== undefined && !seen.has(at)) {
        seen.add(at);
        chain.push(at);
        const parent: string | undefined = regions[at]!.within;
        at = parent === undefined ? undefined : byId.get(parent);
      }
      return chain;
    };
    const plans: (VegetationPlan | null)[] = regions.map((_, i) => {
      const chain = chainOf(i).filter((k) => regions[k]!.vegetation !== undefined);
      return chain.length > 0 ? this.compile(regions[i]!.id, chain.map((k) => regions[k]!.vegetation!), recipe, cover.length) : null;
    });
    this.plans = plans;
    const depth = (i: number): number => chainOf(i).length - 1;
    const order = regions
      .map((r, i) => ({ i, depth: depth(i), place: r.tags.includes("place") ? 1 : 0 }))
      .sort((a, b) => b.depth - a.depth || b.place - a.place || a.i - b.i);
    this.hasPlans = plans.some((p) => p !== null);
    // a cover layer limited to regions (`cover[].regions` / `exceptRegions`: one layer per zone tint) needs the region at a point
    this.hasRegionLayers = cover.some((l) => (l.regions?.length ?? 0) > 0 || (l.exceptRegions?.length ?? 0) > 0);
    const indexed = this.hasPlans || this.hasRegionLayers;
    // EVERY region is indexed once any has a plan: a point inside a region whose
    // chain has none must answer null, not fall to a neighbour's margin
    this.regionOrder = indexed ? order.map((o) => o.i) : [];
    // band 24 m (> the raster's coarsest 16 m cell) keeps the sign exact at every edge
    this.regionIndex = indexed
      ? new PolygonIndex(this.regionOrder.map((i): OutlineSpec => ({ kind: "polygon", points: regions[i]!.polygon, band: Math.max(24, (regions[i]!.vegetation?.margin ?? 0) + 16) })))
      : null;
    this.regionMargin = this.regionOrder.map((i) => regions[i]!.vegetation?.margin ?? 0);
    this.hasMargins = this.regionMargin.some((m) => m > 0);
    this.regionOrder.forEach((i, slot) => {
      const [x0, z0, x1, z1] = boundsOf(regions[i]!.polygon, 1 + this.regionMargin[slot]!);
      this.regionBuckets.add(slot, x0, z0, x1, z1);
    });

    // per region-limited layer: may it grow in each region (its chain names an allowed region and no excepted one)?
    this.layerRegions = cover.map((l) => {
      if (!l.regions?.length && !l.exceptRegions?.length) return null;
      const ok = new Uint8Array(regions.length + 1);
      for (let i = 0; i < regions.length; i++) {
        const ids = chainOf(i).map((k) => regions[k]!.id);
        const inside = !l.regions?.length || ids.some((id) => l.regions!.includes(id));
        ok[i] = inside && !ids.some((id) => l.exceptRegions?.includes(id)) ? 1 : 0;
      }
      ok[regions.length] = l.regions?.length ? 0 : 1; // outside every region
      for (const id of [...(l.regions ?? []), ...(l.exceptRegions ?? [])]) if (!byId.has(id)) this.warnings.push(`cover ${l.id}: unknown region "${id}"`);
      return ok;
    });

    // ---- clearings

    // an operator's kit wall run keeps its face clear: the strip behind the wall top and the carved ground in front
    const wallClearings = (recipe.features.kitWalls ?? []).flatMap((w, i) => {
      if (!w.cuts.length) return [];
      const back: [number, number][] = [], front: [number, number][] = [];
      const push = (x: number, z: number, d: readonly number[], reach: number) => {
        back.push([x + d[1]! * 1.5, z - d[0]! * 1.5]);
        front.push([x - d[1]! * reach, z + d[0]! * reach]);
      };
      for (const c of w.cuts) push(c.origin[0]!, c.origin[1]!, c.dir, c.n[1]!);
      const last = w.cuts[w.cuts.length - 1]!;
      push(last.origin[0]! + last.dir[0]! * last.s[1]!, last.origin[1]! + last.dir[1]! * last.s[1]!, last.dir, last.n[1]!);
      return [clearingSchema.parse({ id: `kit-wall-${i}`, polygon: [...back, ...front.reverse()], feather: 1 })];
    });
    // an operator's ground paint with `clear` (a scree fan, a quarry floor) keeps its outline clear the same way
    const paintClearings = (recipe.features.groundPaints ?? []).flatMap((p, i) =>
      p.clear && (p.clear.scatter || p.clear.cover)
        ? [clearingSchema.parse({ id: `paint-${i}`, ...(p.polygon ? { polygon: p.polygon } : { center: p.center, radius: p.radius }), feather: Math.min(60, p.feather ?? 3), scatter: p.clear.scatter, cover: p.clear.cover })]
        : [],
    );
    this.clearings = [...(recipe.features.clearings ?? []), ...wallClearings, ...paintClearings];
    this.hasClearings = this.clearings.length > 0;
    this.clearingIndex = this.hasClearings
      ? new PolygonIndex(
          this.clearings.map((c): OutlineSpec =>
            c.polygon ? { kind: "polygon", points: c.polygon, band: c.feather + CLEARING_PAD + 4 } : { kind: "disc", center: c.center!, radius: c.radius! },
          ),
        )
      : null;
    this.clearings.forEach((c, k) => {
      const pts = c.polygon ?? [[c.center![0] - c.radius!, c.center![1] - c.radius!], [c.center![0] + c.radius!, c.center![1] + c.radius!]];
      const [x0, z0, x1, z1] = boundsOf(pts, c.feather + CLEARING_PAD);
      this.clearingBuckets.add(k, x0, z0, x1, z1);
    });
    // ---- fields (crop cover grows only inside them)
    this.hasCrops = cover.some((l) => l.fields === true);
    this.fields = recipe.features.fields ?? [];
    this.fieldIndex =
      this.fields.length > 0
        ? new PolygonIndex(this.fields.map((f): OutlineSpec => (f.polygon ? { kind: "polygon", points: f.polygon, band: f.feather + 4 } : { kind: "disc", center: f.center!, radius: f.radius! })))
        : null;
    this.fields.forEach((f, k) => {
      const pts = f.polygon ?? [[f.center![0] - f.radius!, f.center![1] - f.radius!], [f.center![0] + f.radius!, f.center![1] + f.radius!]];
      const [x0, z0, x1, z1] = boundsOf(pts, 1);
      this.fieldBuckets.add(k, x0, z0, x1, z1);
    });
    this.empty = !this.hasPlans && !this.hasClearings && !this.hasCrops && !this.hasRegionLayers;
  }

  /**
   * Fraction of a crop layer's blades that grow at (x, z): 0 outside every field sowing it, 1 inside past the
   * feather, rising across the feather from the edge inward.
   */
  fieldKeep(x: number, z: number, layerId: string | undefined): number {
    if (!this.fieldIndex) return 0;
    const list = this.fieldBuckets.at(x, z);
    if (!list) return 0;
    let keep = 0;
    for (let k = 0; k < list.length; k++) {
      const f = this.fields[list[k]!]!;
      if (f.layers && (layerId === undefined || !f.layers.includes(layerId))) continue;
      const sd = this.fieldIndex.signedDistance(list[k]!, x, z);
      if (sd >= 0) continue;
      const depth = sd <= FAR_INSIDE ? Infinity : -sd;
      const here = f.feather <= 0 || depth >= f.feather ? 1 : depth / f.feather;
      if (here > keep) keep = here;
      if (keep >= 1) return 1;
    }
    return keep;
  }

  private compile(region: string, chain: readonly RegionVegetation[], recipe: VegetationRecipe, layers: number): VegetationPlan {
    const rules = recipe.scatter.length;
    const first = <T>(pick: (v: RegionVegetation) => T | undefined): T | undefined => {
      for (const v of chain) {
        const value = pick(v);
        if (value !== undefined) return value;
      }
      return undefined;
    };
    /** Maps merged so the most specific region's key wins. */
    const merged = <T>(pick: (v: RegionVegetation) => Record<string, T> | undefined): Map<string, T> => {
      const out = new Map<string, T>();
      for (let k = chain.length - 1; k >= 0; k--) for (const [key, value] of Object.entries(pick(chain[k]!) ?? {})) out.set(key, value);
      return out;
    };
    const union = (pick: (v: RegionVegetation) => readonly string[] | undefined): Set<string> => new Set(chain.flatMap((v) => pick(v) ?? []));
    const known = (ids: Iterable<string>, table: Map<string, number>, what: string): void => {
      for (const id of ids) if (!table.has(id)) this.warnings.push(`${region}: unknown ${what} "${id}"`);
    };

    const sAllow = first((v) => v.scatter?.allow);
    const sDeny = union((v) => v.scatter?.deny);
    const sDensity = first((v) => v.scatter?.density) ?? 1;
    const sRules = merged((v) => v.scatter?.rules);
    const sReplace = merged((v) => v.scatter?.replace);
    const sLean = first((v) => v.scatter?.lean);
    known([...(sAllow ?? []), ...sDeny, ...sRules.keys(), ...sReplace.keys(), ...sReplace.values(), ...(sLean?.rules ?? [])], this.ruleById, "scatter rule");

    const ruleKeep = new Float32Array(rules);
    const replace = new Int32Array(rules);
    for (let i = 0; i < rules; i++) {
      const id = recipe.scatter[i]!.id;
      const allowed = (sAllow === undefined || sAllow.includes(id)) && !sDeny.has(id);
      ruleKeep[i] = allowed ? (sRules.get(id) ?? sDensity) : 0;
      const target = sReplace.get(id);
      replace[i] = target !== undefined && this.ruleById.has(target) ? this.ruleById.get(target)! : i;
    }

    const cAllow = first((v) => v.cover?.allow);
    const cDeny = union((v) => v.cover?.deny);
    const cDensity = first((v) => v.cover?.density) ?? 1;
    const cLayers = merged((v) => v.cover?.layers);
    known([...(cAllow ?? []), ...cDeny, ...cLayers.keys()], this.layerById, "cover layer");
    const layerKeep = new Float32Array(layers);
    for (const [id, i] of this.layerById) {
      const allowed = (cAllow === undefined || cAllow.includes(id)) && !cDeny.has(id);
      layerKeep[i] = allowed ? (cLayers.get(id) ?? cDensity) : 0;
    }

    let lean: VegetationPlan["lean"] = null;
    if (sLean && sLean.degrees > 0) {
      const [dx, dz] = sLean.toward;
      const len = Math.hypot(dx, dz) || 1;
      const leanRules = new Uint8Array(rules);
      for (let i = 0; i < rules; i++) {
        const rule = recipe.scatter[i]!;
        leanRules[i] = (sLean.rules.length > 0 ? sLean.rules.includes(rule.id) : rule.collider === "cylinder") ? 1 : 0;
      }
      // a tilt about the horizontal axis (cos a, 0, sin a) by +angle carries up toward (-sin a, 0, cos a);
      // for tops leaning toward (dx, dz) that axis is up x dir = (dz, 0, -dx)
      lean = {
        radians: (sLean.degrees * Math.PI) / 180,
        jitter: (sLean.jitter * Math.PI) / 180,
        axisAngle: Math.atan2(-dx / len, dz / len),
        rules: leanRules,
      };
    }
    return { region, ruleKeep, replace, layerKeep, lean };
  }

  /** Index into `recipe.regions` of the most specific region whose polygon contains (x, z), or -1. */
  regionAt(x: number, z: number): number {
    if (!this.regionIndex) return -1;
    const slots = this.regionBuckets.at(x, z);
    if (!slots) return -1;
    for (let k = 0; k < slots.length; k++) if (this.regionIndex.signedDistance(slots[k]!, x, z) < 0) return this.regionOrder[slots[k]!]!;
    return -1;
  }

  /** May cover layer `li` grow at (x, z) by its `regions` / `exceptRegions`? */
  layerRegionOk(li: number, x: number, z: number): boolean {
    const ok = li >= 0 ? this.layerRegions[li] : null;
    if (!ok) return true;
    const r = this.regionAt(x, z);
    return ok[r < 0 ? ok.length - 1 : r] === 1;
  }

  /** The plan of the most specific region containing (x, z) that has one, or null. */
  planAt(x: number, z: number): VegetationPlan | null {
    if (!this.hasPlans) return null;
    const slots = this.regionBuckets.at(x, z);
    if (!slots) return null;
    for (let k = 0; k < slots.length; k++) {
      const slot = slots[k]!;
      if (this.regionIndex!.signedDistance(slot, x, z) < 0) return this.plans[this.regionOrder[slot]!] ?? null;
    }
    // outside every polygon: the nearest region whose margin reaches here
    if (!this.hasMargins) return null;
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < slots.length; k++) {
      const slot = slots[k]!;
      const margin = this.regionMargin[slot]!;
      if (margin <= 0 || this.plans[this.regionOrder[slot]!] === null) continue;
      const d = this.regionIndex!.signedDistance(slot, x, z);
      if (d >= 0 && d < margin && d < bestD) {
        bestD = d;
        best = slot;
      }
    }
    return best >= 0 ? (this.plans[this.regionOrder[best]!] ?? null) : null;
  }

  /**
   * Fraction of plants that survive at (x, z) for scatter (`kind` 0) or cover
   * (1): 1 outside every clearing, the clearing's `keep` inside, rising to 1
   * across its feather. `pad` widens every clearing by a prop's footprint.
   */
  clearingKeep(x: number, z: number, kind: 0 | 1, pad = 0, rule?: string): number {
    if (!this.hasClearings) return 1;
    const list = this.clearingBuckets.at(x, z);
    if (!list) return 1;
    let keep = 1;
    if (pad > CLEARING_PAD) pad = CLEARING_PAD;
    for (let k = 0; k < list.length; k++) {
      const c = this.clearings[list[k]!]!;
      if (kind === 0 ? !c.scatter : !c.cover) continue;
      // a clearing naming its rules clears only those (scatter only)
      if (c.rules && (kind === 1 || rule === undefined || !c.rules.includes(rule))) continue;
      const sd = this.clearingIndex!.signedDistance(list[k]!, x, z);
      if (sd >= 1e5) continue; // far outside
      const d = sd <= FAR_INSIDE ? -1 : sd - pad;
      let here: number;
      if (d <= 0) here = c.keep;
      else if (d >= c.feather) continue;
      else here = c.keep + (1 - c.keep) * (d / c.feather);
      if (here < keep) keep = here;
    }
    return keep;
  }

  /** Layer index of a cover layer object (or its `id`), or -1. */
  layerIndex(layer: object & { id?: string }): number {
    const i = this.layerOf.get(layer);
    if (i !== undefined) return i;
    return layer.id !== undefined ? (this.layerById.get(layer.id) ?? -1) : -1;
  }
}

const indices = new WeakMap<object, VegetationIndex>();

/** The (cached) vegetation index of a recipe object. */
export function vegetationIndex(recipe: VegetationRecipe): VegetationIndex {
  let index = indices.get(recipe);
  if (!index) {
    index = new VegetationIndex(recipe);
    indices.set(recipe, index);
  }
  return index;
}

/** The parts of a cover layer the vegetation gate reads. */
export interface CoverVegetationLayer {
  id?: string;
  clump?: Parameters<typeof coverClumpKeep>[0];
  /** A crop layer: grows only inside `features.fields`. */
  fields?: boolean;
}

/**
 * The cover gate for region vegetation, clearings AND the layer's clump mask —
 * one call in place of `coverClumpRejects`, which it reproduces exactly where
 * no region or clearing applies. True = no blade at (x, z).
 *
 * Order is cost order: clearing and region lookups are a bucket hit plus a
 * raster read (no allocation), then the clump fBm.
 */
export function coverVegetationRejects(
  recipe: VegetationRecipe & { seed: number },
  layer: CoverVegetationLayer & object,
  x: number,
  z: number,
): boolean {
  const index = vegetationIndex(recipe);
  let k = 1;
  if (!index.empty) {
    // a crop layer grows only in a declared field (cheapest no first: most of the world is not a field)
    if (layer.fields) {
      const f = index.fieldKeep(x, z, layer.id);
      if (f <= 0 || (f < 1 && coverKeepHash(x, z, 0xf1e1d) >= f)) return true;
    }
    // a layer limited to regions (one tint per zone's ground tile)
    if (index.hasRegionLayers && !index.layerRegionOk(index.layerIndex(layer), x, z)) return true;
    const c = index.clearingKeep(x, z, 1);
    if (c <= 0 || (c < 1 && coverKeepHash(x, z, 0x5c1e) >= c)) return true;
    const plan = index.planAt(x, z);
    if (plan) {
      const li = index.layerIndex(layer);
      if (li >= 0) k = plan.layerKeep[li]!;
      if (k <= 0) return true;
      if (k < 1 && coverKeepHash(x, z, 0x7e6e + li) >= k) return true;
    }
  }
  if (!layer.clump) return false;
  let keep = coverClumpKeep(layer.clump, recipe.seed, x, z);
  if (k > 1) keep = Math.min(1, keep * k);
  return keep < 1 && coverKeepHash(x, z, 0x51ed + layer.clump.seed) >= keep;
}

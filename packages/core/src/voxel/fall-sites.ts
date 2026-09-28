/**
 * Fall sites: the hand-crafted layer over a procedural waterfall.
 *
 * Worldgen places falls by rule (one per river, at its sharpest drop — see
 * docs/world-editing/rivers-and-falls.md). A fall SITE is a small document an
 * agent writes for ONE of them to make it a place: split the drop into a
 * cascade of tiers with level pools between, and dress it with rocks from the
 * world's own scatter rules. It never touches voxel data directly — the field
 * re-solves the river's water levels inside the site's span and raises a
 * bounded rock ledge under each pool; the existing machinery (lip lines,
 * curtains, mist, splash, the terrain-clipped water) then draws every tier the
 * same way it draws any fall. The agent's context is a ~32 × 32 height
 * snapshot of the site (`worldgen fall-site --snapshot`), not the world.
 */

import { z } from "zod";
import type { RiverDoc } from "./recipe.js";

/** The `gorge` knobs of a site (a function so the schema can sit above its first use). */
function fallSiteGorgeSchema() {
  return z.object({
    enabled: z.boolean().default(true).describe("false: no site-scale shape, only the river's own slot carve."),
    bowl: z
      .number()
      .min(1)
      .max(2.5)
      .default(2.3)
      .describe("Widest pool bowl: the channel with its bed widened this many times, plus the channel's own bank reach to the waterline (1 is the channel's water; 1.5-2.5 reads as a plunge pool). The pool's water fills the bowl to where its ground rises out, and necks back to the channel at every lip."),
    depth: z.number().min(0).max(8).default(3).describe("How far (m) the middle of each bowl sits under its pool's water."),
    rim: z.number().min(1.5).default(2).describe("Freeboard (m): how far the bowl's rim stands over its pool before the walls begin."),
    step: z.number().min(2).default(8).describe("Height (m) of one bench of the stepped side walls."),
    slope: z
      .number()
      .min(0.3)
      .max(1.2)
      .default(0.8)
      .describe("Mean rise over run of the stepped walls (benches plus risers). The risers stand about 2.1x this; keep them under 2."),
    wander: z.number().min(0).default(5).describe("How far (m) the foot of each side wall wanders out from the bowl, per side, independently."),
    wavelength: z.number().min(6).max(30).default(14).describe("Along-channel wavelength (m) of that wander (a second octave runs at 0.6x)."),
    curve: z
      .number()
      .min(0)
      .default(0.03)
      .describe("Headwall curvature: at d metres across the channel a tier's cliff face stands curve·d² metres further downstream than at the lip (a concave amphitheatre)."),
    reach: z.number().min(15).default(60).describe("How far (m) from the channel the shape extends; it eases out to the land over its last 15 m."),
    lastPool: z.number().min(6).default(18).describe("Length (m) of the bowl below the last tier, in the river's own pool."),
  });
}

/** The `gorge` knobs with every default filled (an absent `gorge` is these). */
export type FallSiteGorge = z.infer<ReturnType<typeof fallSiteGorgeSchema>>;
export function fallSiteGorge(doc: { gorge?: Partial<FallSiteGorge> } | undefined): FallSiteGorge {
  return fallSiteGorgeSchema().parse(doc?.gorge ?? {});
}

export const fallSiteSchema = z
  .object({
    id: z.string().default("fall-site"),
    at: z
      .tuple([z.number(), z.number()])
      .describe(
        "The FOOT of the solved fall this site dresses (WorldField.falls[i].x/z; `worldgen fall-site <world> --list` " +
          "prints them). Matched to the nearest drop of at least 2 m within 25 m, so a site survives small re-solves; " +
          "a site that matches nothing does nothing.",
      ),
    template: z
      .enum(["single", "cascade"])
      .default("cascade")
      .describe(
        "single: the fall as solved, dressed only (rocks). cascade: the drop split into `tiers` — each its own lip, " +
          "curtain, mist and splash — with a level pool between them held up on a rock ledge the field builds.",
      ),
    tiers: z
      .array(
        z.object({
          share: z.number().positive().describe("Fraction of the fall's total height this step drops (normalised over all tiers)."),
          pool: z.number().min(4).default(16).describe("Length (m) of the level pool below this step, before the next lip. Ignored on the last tier: it lands in the river's own pool."),
        }),
      )
      .default([])
      .describe("cascade only, top to bottom. Empty = three even steps with 16 m pools. Keep every step at least 3 m (under that it is a rapid, not a fall)."),
    course: z
      .array(z.tuple([z.number(), z.number()]))
      .default([])
      .describe(
        "Optional: the river's centreline redrawn through the site, upstream to downstream, as world XZ points. " +
          "The river's own points between the nearest point to the first and the nearest point to the last are " +
          "replaced by these (bed, width and depth interpolated along), then the field splines and solves it as " +
          "usual. Use it to bend a dead-straight traced reach: a gentle S through the pools, a dog-leg at a lip. " +
          "Keep both ends ON the river (within a channel width of it) and every point within 60 m of the site.",
      ),
    rocks: z
      .array(
        z.object({
          rule: z.string().describe("Id of an existing scatter rule whose model to place (its collider, LOD and wind come with it, and it batches with that rule's other instances: no new draw call)."),
          at: z.tuple([z.number(), z.number()]).describe("World XZ; stood on the ground there."),
          lift: z.number().default(0).describe("Metres above (or into, if negative) the ground."),
          yaw: z.number().default(0).describe("Radians about Y."),
          scale: z.number().positive().default(1),
        }),
      )
      .default([])
      .describe(
        "Stacked rocks and boulders that make the site read as placed: along the pool rims, on the lip, in the plunge pool. " +
          "Each is stood on the MESHED surface (blobs and overhangs included) and bedded so its footprint does not hang off a slope.",
      ),
    walls: z
      .object({
        rule: z
          .string()
          .describe(
            "Id of an existing scatter rule whose model is the scree (same instanced batch as its other instances: no new draw call). " +
              "rock-medium's model is 1.6 x 1.14 x 2.47 m (origin at its base).",
          ),
        max: z.number().int().min(0).default(90).describe("Most scree rocks for the site."),
        scale: z.tuple([z.number().positive(), z.number().positive()]).default([0.8, 3]).describe("Instance scale range (model units); larger rocks go down first, lowest on each tier."),
        band: z
          .tuple([z.number().min(0), z.number().min(0)])
          .default([0.5, 40])
          .describe("[below, above] metres around each station's water level searched for ground to rest on."),
        reach: z.number().positive().default(40).describe("How far (m) out from the channel centreline to look for ground."),
        upstream: z.number().min(0).default(0).describe("Metres upstream of the top lip line where the dressing starts. Above the lip is the lake shore: keep 0 unless the channel is walled there."),
      })
      .optional()
      .describe(
        "Automatic scree: rocks of one scatter rule RESTING at each tier's foot around the plunge pools, on bench ledges and at the wall toes " +
          "(clustered there, bottom-up, on the ground or on a rock below: support within 0.2 m under the lowest points, around the centre of mass). " +
          "Never on a face steeper than 45 degrees, in the channel, on a lip line or over the rim. Big masses and wall faces are not this: " +
          "they are rock volumes. Seeded by the site id (stable between runs).",
      ),
    formations: z
      .object({
        seed: z.number().int().optional().describe("Extra seed mixed into the site-id hash (a different, equally valid set)."),
        spacing: z.number().positive().optional().describe("Mean spacing (m) of wall buttresses along each side; default 8."),
        scale: z.number().positive().optional().describe("Scales every mass; default 1."),
        margin: z.number().min(0).optional().describe("Clearance (m) past the measured water edge no rock may enter; default 1.5."),
        voxelSize: z.number().positive().optional().describe("Volume lattice spacing (m); default 1 (dual contouring keeps the facets crisp)."),
        wallSurface: z.string().optional().describe("World surface name for the faces; default 'rock'."),
        accentSurface: z.string().optional().describe("Surface brushed faintly on some fronts; default 'cliff' ('' for none)."),
      })
      .optional()
      .describe(
        "Faceted DC rock masses fused with the gorge walls: shoulders flanking every curtain, buttresses, ledge outcrops and pool-rim blocks " +
          "(core rockFormations). Generated and baked by `tools/rock-formations.mts <project> <world> <site> --scene <scene>`, which reads these options; " +
          "the scree (`walls`) rests on the same masses and keeps out of them. Absent = no formations.",
      ),
    gorge: fallSiteGorgeSchema()
      .optional()
      .describe(
        "cascade only: the SITE-SCALE shape of the gorge, built from the solved tiers — a rounded bowl under every pool " +
          "(wider than the channel, oval, longest downstream), a curved amphitheatre headwall at every tier, and side walls " +
          "stepping back in benches whose width wanders along the span. Only ever cuts, and eases out to the land at `reach`. " +
          "Absent = on with these defaults; `{ \"enabled\": false }` keeps the plain slot the river carve makes.",
      ),
  })
  .describe(
    "An agent-crafted waterfall: one solved fall re-shaped (a cascade of tiers and pools) and dressed with rocks. " +
      "Written by `worldgen fall-site`, or by an agent from its `--snapshot` context. Bounded to the fall's own " +
      "span (a few dozen metres); re-solved live by the field, so it follows the river if the world is regenerated.",
  );

export type FallSiteDoc = z.infer<typeof fallSiteSchema>;

/** A site as the field solved it: the pools it holds up, for the ledge. */
export interface SolvedFallSite {
  id: string;
  /** The river path through the site, with the water level (a step function) and the ledge half-reach at each point. */
  path: { x: number; z: number; level: number; reach: number }[];
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** A tier needs at least this drop (m) to be a fall with its own curtain. */
export const FALL_SITE_MIN_TIER = 3;
/** How far over its pool the ledge beside a tier's channel stands (m). */
const LEDGE_RIM = 1.2;
/** Over how many metres past the channel's reach the ledge eases back to the land. */
const LEDGE_FALLOFF = 10;

/**
 * Re-solve the water levels of every river point a cascade site spans.
 * `runs` are the river chains as (doc, point) references head to mouth,
 * `levels` the solved level per doc point (edited in place), `gap(run, idx)`
 * the distance from the previous point. Returns the points whose level was
 * RAISED (their bed must follow the water up, not stay in the gorge) and the
 * solved sites for the ledge.
 */
export function applyFallSites(
  sites: readonly FallSiteDoc[],
  docs: readonly RiverDoc[],
  runs: readonly (readonly [number, number])[][],
  levels: Float64Array[],
  gap: (run: readonly (readonly [number, number])[], idx: number) => number,
  reachOf: (doc: RiverDoc, k: number) => number,
): { raised: Set<string>; solved: SolvedFallSite[] } {
  const raised = new Set<string>();
  const solved: SolvedFallSite[] = [];
  for (const site of sites) {
    // the drop this site dresses: nearest foot of a >= 2 m step within 25 m
    let best: { run: number; idx: number; d: number } | null = null;
    runs.forEach((run, r) => {
      for (let idx = 1; idx < run.length; idx++) {
        const [pi, pk] = run[idx - 1]!;
        const [i, k] = run[idx]!;
        if (levels[pi]![pk]! - levels[i]![k]! < 2) continue;
        const p = docs[i]!.points[k]!;
        const d = Math.hypot(p[0] - site.at[0], p[1] - site.at[1]);
        if (d <= 25 && (!best || d < best.d)) best = { run: r, idx, d };
      }
    });
    if (!best || site.template !== "cascade") continue;
    const { run: r, idx: foot } = best as { run: number; idx: number };
    const run = runs[r]!;
    const [ti, tk] = run[foot - 1]!;
    const [bi, bk] = run[foot]!;
    const top = levels[ti]![tk]!;
    const bottom = levels[bi]![bk]!;
    const drop = top - bottom;
    const tiers = site.tiers.length > 0 ? site.tiers : [{ share: 1, pool: 16 }, { share: 1, pool: 16 }, { share: 1, pool: 16 }];
    const total = tiers.reduce((s, t) => s + t.share, 0);
    const drops = tiers.map((t) => (drop * t.share) / total);
    if (tiers.length < 2 || drops.some((d) => d < FALL_SITE_MIN_TIER * 0.66)) continue;
    // walk downstream from the foot: tier t's pool holds for its length, then
    // the next step; the last step lands on the river's own level
    const path: SolvedFallSite["path"] = [];
    const push = (i: number, k: number, level: number): void => {
      const p = docs[i]!.points[k]!;
      path.push({ x: p[0], z: p[1], level, reach: reachOf(docs[i]!, k) });
    };
    push(ti, tk, top);
    let tier = 0;
    let level = top - drops[0]!;
    let held = 0;
    for (let idx = foot; idx < run.length; idx++) {
      const [i, k] = run[idx]!;
      if (idx > foot) held += gap(run, idx);
      if (tier < tiers.length - 1 && idx > foot && held >= tiers[tier]!.pool) {
        tier++;
        level -= drops[tier]!;
        held = 0;
      }
      if (tier === tiers.length - 1) {
        // the last step: this point is in the river's own pool
        push(i, k, levels[i]![k]!);
        break;
      }
      if (level > levels[i]![k]! + 1e-6) {
        levels[i]![k] = level;
        raised.add(`${i}:${k}`);
      }
      push(i, k, levels[i]![k]!);
    }
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const p of path) {
      const pad = p.reach + LEDGE_FALLOFF;
      minX = Math.min(minX, p.x - pad);
      minZ = Math.min(minZ, p.z - pad);
      maxX = Math.max(maxX, p.x + pad);
      maxZ = Math.max(maxZ, p.z + pad);
    }
    solved.push({ id: site.id, path, minX, minZ, maxX, maxZ });
  }
  return { raised, solved };
}

/**
 * The rock a cascade's pools stand on: within a site, the ground beside the
 * river path is RAISED to a hand over the pool's level (the river's carve then
 * cuts the channel back down into it), easing to the land over LEDGE_FALLOFF.
 * Steps where the level steps, `lip` metres before the lower point — where the
 * river's own lip goes. Raise only; bounded to the site's box.
 */
export function fallSiteLedge(sites: readonly SolvedFallSite[], x: number, z: number, out: number, lip: number): number {
  for (const site of sites) {
    if (x < site.minX || x > site.maxX || z < site.minZ || z > site.maxZ) continue;
    let bestD = Infinity;
    let level = 0;
    let reach = 0;
    for (let s = 0; s + 1 < site.path.length; s++) {
      const a = site.path[s]!;
      const b = site.path[s + 1]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2));
      const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
      if (d >= bestD) continue;
      bestD = d;
      const len = Math.sqrt(len2);
      level = t * len < len - lip ? a.level : b.level;
      reach = a.reach + (b.reach - a.reach) * t;
    }
    if (bestD === Infinity) continue;
    const w = 1 - smooth(reach, reach + LEDGE_FALLOFF, bestD);
    if (w <= 0) continue;
    const target = level + LEDGE_RIM;
    if (target > out) out = out + (target - out) * w;
  }
  return out;
}

function smooth(a: number, b: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

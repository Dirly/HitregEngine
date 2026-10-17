/**
 * `ledges` — a natural ledge system on a steep slope or cliff band: narrow, noisy shelves on the shelving core with NO
 * walls (the risers stay the zone's own steep cliff ground), every shelf reachable — by a narrow ramp where one fits,
 * else by a short cave that climbs inside the rock from the riser foot and comes out on the shelf above (two mouths).
 * The look the owner described: "a bunch of ledges and caves that led up in and out, it looked handcrafted".
 *
 * Compiles to ONE masked height patch `op:<id>:ground` + per cave link `tunnels` `op:<id>:link-<n>-bore` /
 * `-a-flare` / `-b-flare` and `blobs` `op:<id>:link-<n>-{a,b}-notch-<k>`.
 */
import { z } from "zod";
import { registerOperator, type OperatorFieldReader, type OperatorOutput } from "./operator-registry.js";
import { areaBounds, areaOutline, solveShelves } from "./shelving.js";
import { ledgeLandmarkGround, ledgeLandmarkVolume, type LedgeLandmarkOptions } from "./ledge-landmark.js";

const xz = z.tuple([z.number().finite(), z.number().finite()]);
const xyz = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

export const ledgesOperatorSchema = z
  .object({
    center: xz.optional().describe("Centre [x, z] of a round area (with `radius`). Give this OR `polygon`."),
    radius: z.number().min(15).max(400).optional().describe("Radius of the round area, metres."),
    polygon: z.array(xz).min(3).optional().describe("Area outline [x, z]. Give this OR center + radius."),
    bandHeight: z.number().min(2).max(14).default(4).describe("Smallest height of one ledge band, metres. Grows on steep ground so a typical ledge keeps `minShelf` (riser = slope x ledge)."),
    smooth: z.number().min(4).max(30).default(6).describe("Metres of ground smoothing the ledges follow: ~6 hugs every spur and gully (ledges), ~18 gives long town bands (that is `terrace`)."),
    jitter: z.number().min(0).max(12).default(8).describe("Metres the ledge lips wander off the smoothed contour (three octaves of noise down to 5 m): ragged rock lips."),
    stagger: z.number().min(10).max(80).default(22).describe("Panel width, metres, across the face: each panel shifts its ledges by its own part of a band, so ledges END, step down or overlap at the seams instead of running as one band across the face. Typical ledge length ~ 1-2 panels."),
    staggerAmount: z.number().min(0).max(1).default(0.8).describe("Largest shift of a panel's ledges, as a fraction of a band (0 = continuous contour bands)."),
    pinch: z.number().int().min(0).max(8).refine((v) => v === 0 || v >= 3, "pinch is 0 or at least 3").default(3).describe("Every ledge pinches out (ends at a panel seam against a two-band riser, then picks up again) once in this many panels along the face; the next ledge up pinches two panels on. 0 = ledges run on through every panel."),
    tilt: z.number().min(0).max(0.4).default(0.15).describe("Outward fall of each ledge from its back to its lip, as a fraction of the band height (a weathered shelf sheds water)."),
    minShelf: z.number().min(6).max(30).default(7).describe("Preferred smallest ledge depth, metres (never below 6: the 6 m rule)."),
    riserSlope: z.number().min(0.8).max(3).default(1.6).describe("Rise/run of the risers: steep (>= ~1.2) so they read as the zone's own cliff rock, not as grassy banks."),
    links: z.enum(["ramp", "cave", "auto"]).default("auto").describe("How ledges are joined: ramps only, caves first, or `auto` = a ramp where one fits, else a short cave climbing inside the rock (two mouths)."),
    rampWidth: z.number().min(6).max(16).default(6).describe("Ramp width, metres (at least 6)."),
    rampGrade: z.number().min(0.08).max(0.6).default(0.3).describe("Rise/run of a ramp (0.3 = a steep path, 17 degrees)."),
    caveRadius: z.number().min(3).max(6).default(3).describe("Bore radius of a cave link (>= 3: the 6 m rule)."),
    caveCover: z.number().min(2).max(12).default(3).describe("Rock, metres, a cave link keeps over and beside its bore between its two mouths."),
    caveGrade: z.number().min(0.1).max(0.8).default(0.5).describe("Steepest floor grade of a cave link (0.5 = 27 degrees, walkable)."),
    blend: z.number().min(6).max(60).default(16).describe("Metres past the (wobbled) outline over which the ledges fade back into the slope."),
    edgeNoise: z.number().min(0).max(30).default(8).describe("Metres the outline wobbles in and out."),
    baseY: z.number().finite().optional().describe("Level of the band at the area's median ground. Omit to use that median."),
    seed: z.number().int().default(1).describe("Jitter / edge / mouth seed (combined with the world seed)."),
    mode: z.enum(["landmark", "height"]).default("landmark").describe("`landmark` (default): the solved shelves become a LANDMARK — real rock baked at `voxel` (stacked rock masses per level with ragged battered stepped faces, ramp notches, a few boulders, caves bored through it; `features.landmarks`, baked by tools/ledge-landmark.mts) over a terrain patch that stays inside it. `height`: the older 2.5D height edit on the 2 m lattice (no overhangs; lips smear)."),
    voxel: z.number().min(0.25).max(1).default(0.5).describe("Landmark DC voxel, metres (0.5: a 4 m drop is 8 voxels)."),
    lipNoise: z.number().min(0).max(1.5).default(1).describe("Landmark: metres each level's outline wanders (ragged lips; a different noise per level)."),
    batter: z.number().min(0).max(15).default(7).describe("Landmark: degrees every rock face leans back from vertical (5-10 reads as a battered natural face)."),
    chamfer: z.number().min(0).max(1.5).default(0.4).describe("Landmark: metres of rounding on every rock mass's top edge."),
    boulders: z.number().int().min(0).max(12).default(4).describe("Landmark: low, wide boulder masses fused into shelves at least ~6 m across, whole site (no pillars)."),
    inset: z.number().min(0.5).max(4).default(1).describe("Landmark: metres the terrain stays under the rock surface."),
    reachRepairs: z
      .array(z.object({ from: xyz.describe("Head [x, y, z]: a flat spot on the cut-off shelf's top."), to: xyz.describe("Foot [x, y, z]: walkable ground the baked collider reaches.") }))
      .max(16)
      .default([])
      .describe("Landmark: repair ramps (<= 0.5 grade, >= 2.6 m wide between >= 1.5 m cheeks) that the bake's collider walk added for core shelves it could not reach. Written by tools/ledge-landmark.mts (--fix-reach, on by default); not hand-authored."),
  })
  .refine((p) => (p.polygon !== undefined) !== (p.center !== undefined && p.radius !== undefined), {
    message: "ledges need a polygon OR center + radius (not both, not neither)",
  });
export type LedgesOperatorParams = z.infer<typeof ledgesOperatorSchema>;

function compileLedges(p: LedgesOperatorParams, reader: OperatorFieldReader, ctx: { id: string }): OperatorOutput {
  const out = solveLedges(p, reader, ctx);
  if (p.mode === "height") return { features: out.features, report: out.report };
  const lm = ledgeLandmarkVolume(out.grid, landmarkOptions(p, reader));
  return {
    features: {
      heightPatches: [ledgeLandmarkGround(out.grid, p.inset, p.riserSlope)],
      landmarks: [{ id: "landmark", prefab: landmarkPrefabId(ctx.id, lm.digest), position: lm.origin, radius: lm.radius, digest: lm.digest }],
    },
    report: { ...out.report, landmark: { prefab: landmarkPrefabId(ctx.id, lm.digest), voxel: lm.voxel, tiles: lm.tiles.length, nodes: lm.nodes.length, ...lm.report } },
  };
}

/** The baked prefab a landmark piece names: the operator id plus the digest of its solids. */
export function landmarkPrefabId(opId: string, digest: string): string {
  return `landmarks/${opId}-${digest}`;
}

export function landmarkOptions(p: LedgesOperatorParams, reader: OperatorFieldReader): LedgeLandmarkOptions {
  return { voxel: p.voxel, seed: (reader.seed * 7919 + p.seed * 104729) | 0, lipNoise: p.lipNoise, batter: p.batter, chamfer: p.chamfer, boulders: p.boulders, inset: p.inset, reachRepairs: p.reachRepairs };
}

/** The shelving solve a `ledges` doc compiles from (also what the landmark baker rebuilds the solids from). */
export function solveLedges(p: LedgesOperatorParams, reader: OperatorFieldReader, ctx: { id: string }) {
  return solveShelves(p, reader, {
    bandHeight: p.bandHeight, minShelf: p.minShelf, smooth: p.smooth, jitter: p.jitter, blend: p.blend, edgeNoise: p.edgeNoise,
    riserSlope: p.riserSlope, rampWidth: p.rampWidth, rampGrade: p.rampGrade, baseY: p.baseY, seed: p.seed,
    walls: false, links: p.links, maxRiserBands: 2,
    stagger: { size: p.stagger, amount: p.staggerAmount, drop: p.pinch }, tilt: p.tilt, wornRamps: true,
    cave: { radius: p.caveRadius, cover: p.caveCover, maxGrade: p.caveGrade },
    ...(p.mode === "landmark" ? { maxBand: p.bandHeight * 1.25 } : {}),
  }, `ledges "${ctx.id}"`);
}

registerOperator<LedgesOperatorParams>({
  op: "ledges",
  description: "A natural ledge system on a steep slope or cliff band: narrow noisy shelves, every ledge reachable by a ramp or, where none fits, a short cave climbing inside the rock (two mouths). Default mode `landmark`: real rock baked at a fine DC voxel (stacked rock masses, ramp notches, boulders, bored caves with flared mouths) — one `landmarks` piece `op:<id>:landmark` (bake: tools/ledge-landmark.mts) over one masked height patch `op:<id>:ground` kept inside the rock. Mode `height`: the 2.5D height edit (patch + `tunnels`/`blobs` `op:<id>:link-<n>-*`).",
  schema: ledgesOperatorSchema,
  compile: compileLedges,
  bounds: areaBounds,
  outline: (p) => [areaOutline(p)],
});

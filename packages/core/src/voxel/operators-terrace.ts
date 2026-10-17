/**
 * `terrace` — cut a slope into long contour shelves (a stepped town site, a hillside farm), every shelf reachable.
 *
 * Built on the shelving core (`./shelving.ts`): bands follow the ~`smooth`-metre smoothed contours with no step-count
 * clamp (each cell cuts or fills about half a band), the edge is a noisy soft mask that fades into the natural slope,
 * shelves too shallow to use merge (never past the tallest kit wall), ramps link the shelf graph as a spanning tree,
 * and risers inside the area stand behind world-kit retaining walls.
 *
 * Compiles to ONE masked height patch `op:<id>:ground` and, with walls on, `features.kitWalls` runs `op:<id>:wall-<n>`.
 */
import { z } from "zod";
import { registerOperator, type OperatorFieldReader, type OperatorOutput } from "./operator-registry.js";
import { areaBounds, areaOutline, solveShelves } from "./shelving.js";

const xz = z.tuple([z.number().finite(), z.number().finite()]);

export const terraceOperatorSchema = z
  .object({
    center: xz.optional().describe("Centre [x, z] of a round area (with `radius`). Give this OR `polygon`. The edge is wobbled and faded either way."),
    radius: z.number().min(15).max(600).optional().describe("Radius of the round area, metres."),
    polygon: z.array(xz).min(3).optional().describe("Area outline [x, z] (any simple polygon). Give this OR center + radius."),
    stepHeight: z.number().min(1.5).max(6).default(3).describe("Height of one contour band = one riser, metres (3 = the kit's h300 wall). Shelves that merge make a riser of two bands; never past the tallest kit wall (6.4 m)."),
    smooth: z.number().min(6).max(60).default(18).describe("Metres of ground smoothing the contours follow: ~18 gives long town/farm bands, ~8 hugs every spur."),
    baseY: z.number().finite().optional().describe("Level of the band at the area's median ground. Omit to use that median."),
    jitter: z.number().min(0).max(12).default(2).describe("Metres the riser lines wander off the smoothed contour (deterministic noise): 0 = clean contours."),
    minShelf: z.number().min(6).max(80).default(12).describe("Preferred smallest shelf depth, metres. Shallower shelves merge into a neighbour unless the riser would pass the kit max; then they merge only down to 6 m (the 6 m rule)."),
    riserSlope: z.number().min(0.6).max(1.6).default(1.2).describe("Rise/run of an UNWALLED riser bank (in the fade and where walls are off)."),
    rampWidth: z.number().min(6).max(30).default(8).describe("Width of each ramp between shelves, metres (at least 6)."),
    rampGrade: z.number().min(0.04).max(0.5).default(0.15).describe("Rise/run of a ramp (0.15 = 8.5 degrees). Ramp length = riser height / rampGrade."),
    blend: z.number().min(6).max(80).default(24).describe("Metres past the (wobbled) outline over which the shelves fade back into the hill."),
    edgeNoise: z.number().min(0).max(40).default(10).describe("Metres the outline wobbles in and out (~40 m wavelength), so the terrace never ends on a drawn circle."),
    walls: z.enum(["common", "stone", "none"]).default("common").describe("World-kit retaining walls on risers inside the area (`features.kitWalls`), or none (plain banks)."),
    wallMinDrop: z.number().min(0.8).max(6).default(1.5).describe("Smallest riser drop, metres, that gets a wall."),
    seed: z.number().int().default(1).describe("Jitter / edge-noise seed (combined with the world seed)."),
  })
  .refine((p) => (p.polygon !== undefined) !== (p.center !== undefined && p.radius !== undefined), {
    message: "a terrace needs a polygon OR center + radius (not both, not neither)",
  });
export type TerraceOperatorParams = z.infer<typeof terraceOperatorSchema>;

function compileTerrace(p: TerraceOperatorParams, reader: OperatorFieldReader, ctx: { id: string }): OperatorOutput {
  const out = solveShelves(p, reader, {
    bandHeight: p.stepHeight, minShelf: p.minShelf, smooth: p.smooth, jitter: p.jitter, blend: p.blend, edgeNoise: p.edgeNoise,
    riserSlope: p.riserSlope, rampWidth: p.rampWidth, rampGrade: p.rampGrade, baseY: p.baseY, seed: p.seed,
    walls: p.walls === "none" ? false : { style: p.walls, minDrop: p.wallMinDrop },
  }, `terrace "${ctx.id}"`);
  return { features: out.features, report: out.report };
}

registerOperator<TerraceOperatorParams>({
  op: "terrace",
  description: "Cut a slope into long contour shelves (a stepped town site, a hillside farm) joined by ramps, risers walled with world-kit retaining walls; compiles to one masked height patch `op:<id>:ground` + `kitWalls` runs `op:<id>:wall-<n>`.",
  schema: terraceOperatorSchema,
  compile: compileTerrace,
  bounds: areaBounds,
  outline: (p) => [areaOutline(p)],
});

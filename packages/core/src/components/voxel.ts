import { z } from "zod";
import type { ComponentRegistry } from "./registry.js";

/**
 * Opts a scene into a streamed procedural voxel world.
 *
 * It is the `chunkStreamer` of generated worlds: same residency rings, same
 * HLOD supercells, same runtime-only rule (generated content never enters the
 * scene document) — the only difference is that cells come from a world recipe
 * instead of from `.chunk.json` files on disk. One per scene, first wins.
 *
 * The recipe owns `cellSize`, `resolution` and everything about the terrain
 * itself; this component owns only how much of it is resident and how it is
 * presented, so tuning draw distance never risks changing the world's shape.
 */
export const voxelWorldSchema = z.object({
  world: z
    .string()
    .min(1)
    .describe("World recipe asset id (assets/worlds/<id>.json, sans extension). The recipe is the authoring truth; meshes and props are derived."),
  rings: z
    .object({
      simulation: z.number().min(0).default(2).describe("Cells within this radius render AND collide + run scripts."),
      fullRender: z.number().min(0).default(3).describe("Out to here: full meshes, no physics/scripts."),
      hlod: z.number().min(0).default(7).describe("Out to here: merged low-detail proxy."),
      farTerrain: z
        .number()
        .min(0)
        .default(24)
        .describe(
          "Out to here: coarse far proxy (twice as coarse as hlod, so it costs about the same per supercell). " +
            "Beyond: unloaded. Match the scene's height fog to it — the ring should end where the fog is ~85% " +
            "opaque, or ridgelines cut off in clear air.",
        ),
    })
    .prefault({})
    .describe("Residency rings in CELLS from the focus, exactly as chunkStreamer.rings. Generated cells are cheap to drop and expensive to build, so keep `simulation` tight and let `hlod` carry the distance."),
  keepPadding: z.number().min(0).max(8).default(1).describe("Hysteresis: cells beyond a ring boundary held before downgrading."),
  hlodSupercellFactor: z
    .number()
    .int()
    .min(1)
    .max(16)
    .default(4)
    .describe("Cells per HLOD supercell edge — a 4x4 block bakes into ONE merged proxy so distant tree batches don't re-fragment per cell."),
  scatter: z.boolean().default(true).describe("Place the recipe's scatter rules (trees, rocks) in streamed cells. Off = bare terrain, useful while tuning the landform."),
  material: z.string().optional().describe("Terrain material asset id; overrides the recipe's own `material`."),
  terrainCastShadow: z
    .boolean()
    .default(false)
    .describe("Terrain casting shadows means every cascade re-rasterises a large mesh every frame. Off by default; turn it on for worlds whose silhouette (canyons, spires) depends on it."),
  collision: z.boolean().default(true).describe("Cook a trimesh collider for simulation-ring cells. Off only for a fly-through preview."),
  mesher: z
    .enum(["mc", "dc", "nets", "auto"])
    .default("mc")
    .describe(
      "How the sampled field becomes triangles. 'auto': PER CELL, dual contouring where the recipe's terrain.planarCliffs " +
        "mask reaches the cell (plus planarCliffs.dcMargin), marching cubes everywhere else — what a planar-cliffs world " +
        "wants (DC keeps the cliff planes sharp; MC is ~2-3x cheaper on smooth ground; borders fall on smooth ground). " +
        "On a world without planarCliffs 'auto' is MC everywhere. 'mc' marching cubes (the shipping mesher), " +
        "'dc' dual contouring (a QEF vertex per cell — sharp rims and scarps survive), 'nets' surface nets " +
        "(the same dual topology, smoothed). Dual cells are clipped to their column and skirted into the rock, so an LOD " +
        "step closes about as well as MC's. Pair 'dc' with a world whose recipe sets terrain.planarCliffs: on the plain " +
        "field DC keeps no sharper an edge than MC (there is none to keep) and costs ~1.6x per chunk.",
    ),
  colliderLodStep: z
    .number()
    .int()
    .min(1)
    .max(4)
    .default(1)
    .describe("Coarsen the COLLISION mesh relative to the visual one. Leave at 1: anything else breaks 'what you see is what you collide with', which is the invariant this whole terrain path exists to keep."),
  bounds: z
    .object({
      min: z.tuple([z.number(), z.number()]).describe("World [x, z] of the box's low corner, metres."),
      max: z.tuple([z.number(), z.number()]).describe("World [x, z] of the box's high corner, metres."),
    })
    .refine((b) => b.max[0] > b.min[0] && b.max[1] > b.min[1], { message: "bounds.max must exceed bounds.min on both axes" })
    .optional()
    .describe(
      "Streaming box in world metres. Cells that do not overlap it are never generated, rendered, cooked or simulated " +
        "(client rings, HLOD and far terrain, the server's residency and terrain bake alike); past it the view shows sky. " +
        "Omitted = unbounded (only the recipe's own world limit). Meant for crop-and-work scratch scenes such as a " +
        "place-build lab: a box round the job instead of the whole world.",
    ),
});

export type VoxelWorldData = z.infer<typeof voxelWorldSchema>;
export type VoxelWorldBounds = NonNullable<VoxelWorldData["bounds"]>;

/**
 * Does cell (cx, cz) of a `cellSize` lattice overlap the component's streaming
 * box? Every streamer (client provider, server residency, terrain bake) asks
 * this one question, so "outside the box" means the same thing everywhere.
 * No bounds = every cell (unbounded, the default).
 */
export function voxelCellInBounds(bounds: VoxelWorldBounds | undefined, cellSize: number, cx: number, cz: number): boolean {
  if (!bounds) return true;
  const x0 = cx * cellSize;
  const z0 = cz * cellSize;
  return x0 + cellSize > bounds.min[0] && x0 < bounds.max[0] && z0 + cellSize > bounds.min[1] && z0 < bounds.max[1];
}

export function registerVoxelComponents(registry: ComponentRegistry): void {
  registry.register("voxelWorld", voxelWorldSchema);
}

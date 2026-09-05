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
  colliderLodStep: z
    .number()
    .int()
    .min(1)
    .max(4)
    .default(1)
    .describe("Coarsen the COLLISION mesh relative to the visual one. Leave at 1: anything else breaks 'what you see is what you collide with', which is the invariant this whole terrain path exists to keep."),
});

export type VoxelWorldData = z.infer<typeof voxelWorldSchema>;

export function registerVoxelComponents(registry: ComponentRegistry): void {
  registry.register("voxelWorld", voxelWorldSchema);
}

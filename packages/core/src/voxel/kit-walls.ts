/**
 * `features.kitWalls` — retaining-wall runs COMPILED by a landform operator (ids `op:<id>:wall-<n>`; today `terrace`).
 *
 * One entry is one run of world-kit retaining-wall pieces standing on a shelf riser: 2 m straights plus caps, placed
 * exactly like a path ribbon's walls (piece origin = the face start at the wall foot, the low side to the right of the
 * run). Each module carries one `face` cut that carves the low side, so the terrain riser stands inside the wall body
 * and `height()` reads the foot in front of it. Derived like `terraceWalls` / `ribbons`: never hand-edited.
 */
import { z } from "zod";
import type { ChunkDoc } from "../chunks.js";
import { terraceWallCutSchema, terraceWallPieceSchema } from "./terrace-walls.js";

/** World-kit retaining-wall heights (m) a kit wall may use; the tallest is the cap on any walled riser. */
export const KIT_WALL_HEIGHTS = [0.8, 1.5, 2, 2.4, 3, 3.6, 4.4, 4.5, 5.2, 6, 6.4] as const;
export const KIT_WALL_MAX = 6.4;

export const kitWallSchema = z.object({
  id: z.string().describe("`op:<operator id>:wall-<n>` — one run per riser stretch."),
  style: z.enum(["common", "stone"]).describe("Retaining-wall kit style (`retaining-wall/<style>-h<cm>-straight-2`)."),
  pieces: z.array(terraceWallPieceSchema).describe("Kit pieces in run order: a 2 m straight and its cap per module."),
  cuts: z.array(terraceWallCutSchema).describe("One `face` cut per module: the low side the field carves down to the wall foot."),
});
export type KitWallDoc = z.infer<typeof kitWallSchema>;

/** The pieces of every kit wall run whose origin stands in chunk cell (cx, cz), as collapsed prefab instances. */
export function kitWallEntities(
  walls: readonly KitWallDoc[] | undefined,
  cellSize: number,
  cx: number,
  cz: number,
  entities: ChunkDoc["entities"],
  assetExists?: (assetId: string, kind: "prefab" | "model") => boolean,
): void {
  if (!walls?.length) return;
  const x0 = cx * cellSize, z0 = cz * cellSize;
  for (const w of walls) {
    w.pieces.forEach((p, i) => {
      const [x, y, z] = p.position;
      if (Math.floor(x / cellSize) !== cx || Math.floor(z / cellSize) !== cz) return;
      if (assetExists && !assetExists(p.prefab, "prefab")) return;
      const half = (p.yaw * Math.PI) / 360;
      entities[`kw_${w.id}_${i}`] = {
        name: `${w.id} ${p.role}`,
        parent: null,
        tags: ["kit-wall", w.id],
        components: {
          transform: { position: [x - x0, y, z - z0], rotation: [0, Math.sin(half), 0, Math.cos(half)] },
          prefab: { prefabId: p.prefab, props: {}, overrides: p.overrides ?? [] },
        },
      };
    });
  }
}

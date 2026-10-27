/**
 * ROCK SETS — named boulders an operator put on the ground (`features.rockSets`, ids `op:<id>:*`), placed as instances
 * of the world's own scatter rules, so they batch with that rule's other rocks: no new material, no new draw call, the
 * rule's collider, LOD and rock skin come with them.
 *
 * They stand exactly the way a fall site's hand rocks do (fall-site-rocks.ts `standSiteRocks`): on the MESHED surface
 * (the density the mesher sampled), tilted onto the slope, sunk until bedded and held up — a rock nothing holds up is
 * dropped, never left floating. Placement: fall-site-rocks.ts `rockSetInstances` (this file is schema only: recipe.ts imports it).
 */
import { z } from "zod";

export const rockSetSchema = z
  .object({
    id: z.string().default("rock-set"),
    rocks: z
      .array(
        z.object({
          rule: z.string().describe("Id of an existing scatter rule whose model to place (batches with that rule)."),
          at: z.tuple([z.number().finite(), z.number().finite()]).describe("World XZ; stood on the meshed ground there."),
          yaw: z.number().default(0).describe("Radians about Y."),
          scale: z.number().positive().default(1),
        }),
      )
      .max(2000),
  })
  .describe("Boulders COMPILED by a landform operator (`scree`; ids `op:<id>:rocks`), never hand-edited: instances of existing scatter rules, seated on the meshed ground like fall-site rocks (unsupported ones dropped).");
export type RockSetDoc = z.infer<typeof rockSetSchema>;

/** XZ bounds of a set (its rocks, padded by a boulder's reach). */
export function rockSetBounds(set: { rocks?: readonly { at: readonly number[] }[] }): { x0: number; z0: number; x1: number; z1: number } | null {
  const rocks = set.rocks ?? [];
  if (!rocks.length) return null;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const r of rocks) { x0 = Math.min(x0, r.at[0]!); z0 = Math.min(z0, r.at[1]!); x1 = Math.max(x1, r.at[0]!); z1 = Math.max(z1, r.at[1]!); }
  return { x0: x0 - 6, z0: z0 - 6, x1: x1 + 6, z1: z1 + 6 };
}

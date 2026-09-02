import { z } from "zod";
import type { ComponentRegistry } from "./registry.js";

/**
 * Authoring-time placement metadata — how this entity settles onto the world
 * when a placement solve runs (the editor's placement-assist toggle, the
 * playground `place` CLI, or `snapPlacementOps` from @hitreg/core). Pure
 * metadata: nothing reads it at runtime, and the solve bakes its result into
 * the ordinary `transform`, so documents stay the truth.
 *
 * Zod-only module (like physics.ts) so registerCoreComponents can import it
 * without pulling the solver's prefab/terrain/poly-mesh dependencies into a
 * circular init.
 */
export const placementSchema = z.object({
  snap: z
    .enum(["ground", "ceiling", "wall", "none"])
    .default("ground")
    .describe(
      "Which surface this entity settles onto when a placement solve runs (editor placement-assist, CLI `place snap`, or snapPlacementOps): " +
        "`ground` casts straight down from just above the entity's own top and rests its lowest point on the first upward-facing surface " +
        "(so a buried prop is NOT recovered — the cast starts above the prop, not above the world, to avoid landing on dungeon roofs); " +
        "`ceiling` mirrors that upward for chandeliers/stalactites; `wall` casts horizontally around the entity, backs it against the " +
        "nearest vertical surface and yaws it so local +Z faces INTO the room (author wall props with their back at local -Z, and note " +
        "wall snap REPLACES rotation and keeps the authored Y); `none` opts out while keeping the other metadata readable.",
    ),
  sink: z
    .number()
    .min(0)
    .default(0.02)
    .describe(
      "Metres to embed past the contact surface (into the floor for ground, into the ceiling/wall for those). The default 2cm hides " +
        "the hairline float that uneven or sloped surfaces otherwise leave under a flat-bottomed prop. Keep it under any lint gap tolerance.",
    ),
  alignToNormal: z
    .boolean()
    .default(false)
    .describe(
      "ground/ceiling only: tilt the entity so its +Y matches the hit surface normal (rocks on a hillside). Off keeps the authored " +
        "upright orientation — right for furniture, which should sit level and let `sink` absorb the slope.",
    ),
  rotJitter: z
    .enum(["none", "y", "full"])
    .default("none")
    .describe(
      "Random rotation applied on solve, seeded per entity id (deterministic — re-running the same solve with the same seed reproduces it): " +
        "`y` = random yaw (props whose facing shouldn't repeat: crates, barrels, rubble); `full` = uniform random orientation (debris, rocks — " +
        "usually paired with alignToNormal off). Ignored for `wall` snap, which owns the rotation.",
    ),
  scaleJitter: z
    .tuple([z.number().positive(), z.number().positive()])
    .default([1, 1])
    .describe("Uniform random scale multiplier range [min, max] applied on solve (seeded, deterministic). [1,1] = off. [0.9, 1.15] breaks up prop repetition."),
  embed: z
    .tuple([z.number().min(0).max(0.95), z.number().min(0).max(0.95)])
    .default([0, 0])
    .describe(
      "ground/ceiling only: bury a random fraction of the entity's own height (measured after rotation/scale) past the contact " +
        "surface, drawn from [min, max] per entity (seeded — deterministic, like the jitters). [0.15, 0.45] makes scattered rocks " +
        "sit naturally half-sunk in the floor instead of perched on it; pair with rotJitter \"full\". Additive with `sink`; " +
        "ignored for wall snap. Schema caps at 0.95 so something always shows above the surface.",
    ),
  maxSnapDistance: z
    .number()
    .positive()
    .default(60)
    .describe("Give up (leave the entity untouched, report no-support) if no surface lies within this many metres along the cast."),
});

export type PlacementData = z.infer<typeof placementSchema>;

/** Register the `placement` component (called from registerCoreComponents). */
export function registerPlacementComponent(registry: ComponentRegistry): void {
  registry.register("placement", placementSchema);
}

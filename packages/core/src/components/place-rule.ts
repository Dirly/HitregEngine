import { z } from "zod";
import type { ComponentRegistry } from "./registry.js";

/**
 * How the PLACEMENT SOLVER (packages/core/src/place-solver) seats a piece, declared once on the prefab root.
 *
 * Agents state intent (what, roughly where, facing); the solver owns the exact transform. Every placer (place-build
 * layouts and dressing, `dress apply`, settle, the town builder, statue placement) hands the solver a position + yaw
 * and gets back the corrected transform, or the piece DROPPED with a reason. This component is what the solver reads
 * about the piece itself; its footprint comes from the catalogue `dressing.size` and its sink cap from
 * `dressing.footing`.
 *
 * Authoring-time metadata, like `placement` and `dressing`: nothing reads it at runtime. Zod-only module so
 * registerCoreComponents can import it without the solver.
 */

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

export const PLACE_SEATS = ["foot", "plinth", "float-ok", "embed", "set-in"] as const;
export type PlaceSeat = (typeof PLACE_SEATS)[number];

export const placeOpeningSchema = z
  .object({
    kind: z
      .enum(["door", "gate", "stair"])
      .describe("door / gate: a way in that must stay clear in front of it (the solver keeps a clear zone there). stair: a flight whose run stays clear."),
    position: vec3.describe("Prop-local metres (front = +Z, up = +Y): the opening's centre at its sill / the stair's foot."),
    yaw: z.number().default(0).describe("Degrees, prop-local: the direction the opening faces OUT (0 = +Z). A stair: its direction of travel."),
    width: z.number().positive().describe("Opening (or flight) width, metres."),
    depth: z
      .number()
      .positive()
      .optional()
      .describe("Clear depth in front of a door/gate (default the solver's DOOR_CLEAR_DEPTH_M 1.5); a stair's run length."),
  })
  .describe("A way in or a flight declared by a prop that is not a WFC kit building (kit buildings export them as markers).");
export type PlaceOpening = z.infer<typeof placeOpeningSchema>;

export const placeRuleSchema = z.object({
  seat: z
    .enum(PLACE_SEATS)
    .default("foot")
    .describe(
      "How the piece meets the ground. `foot` (default): the footprint is sampled (corners, edge midpoints, centre) and the piece sinks so " +
        "its HIGHEST sample is flush and nothing floats, the sink capped by the catalogue `dressing.footing`; a gap the cap cannot close is " +
        "covered by `foundation` when declared, else the solver searches small moves and turns for level ground, else drops it. `plinth`: " +
        "the piece stands flush on its highest ground on its own foundation skirt (needs `foundation`). `float-ok`: no ground seat (a rug on " +
        "a deck, a hanging sign): kept at its stated height. `embed`: a rock, sunk into its LOWEST ground (the voxel seat's ROCK_EMBED rule). `set-in`: a front CUT INTO a slope or cliff " +
        "(a temple front, a tomb door): its base stands on its LOWEST ground (no daylight anywhere), the uphill side runs into the rock, no sink " +
        "beyond the seat's 3 cm and no slope limit (o-gates 2026-10-30: `foot` lifted a 38 m gate onto the cliff behind it, `embed` sank it 15 %).",
    ),
  grade: z
    .number()
    .min(0)
    .default(0)
    .describe(
      "Metres BELOW the origin where the ground meets the piece (a kit building's floor slab at y = 0 on a 0.3 m raised foundation: 0.3). The " +
        "solver seats that plane, so the floor stands clear of the highest ground and never shares its plane; a layout never adds `lift` for it.",
    ),
  tolerance: z
    .object({
      gap: z.number().min(0).default(0.05).describe("Most daylight (m) allowed under the footprint after the seat (the seated gate's SEAT_GAP_M)."),
      slope: z.number().min(0).default(0.6).describe("Steepest ground (rise over run across the footprint) the piece accepts (place-build USABLE_SLOPE)."),
      move: z.number().min(0).default(1.5).describe("Furthest (m) the solver may move the piece in plan to find level ground, clear a wall or leave a keep-out."),
      yaw: z.number().min(0).max(90).default(15).describe("Most degrees the solver may turn the piece either way while searching."),
    })
    .prefault({})
    .describe("What the solver may accept or change before it drops the piece."),
  foundation: z
    .object({
      material: z.string().min(1).describe("Material asset id the skirt wears (the piece's own masonry / plinth stone; one draw per material, batched)."),
      depth: z.number().min(0).default(0.3).describe("Metres the skirt runs BELOW the lowest ground sample."),
      inset: z.number().min(0).default(0.03).describe("Metres the skirt stands inside the footprint box on every side (its faces never share the piece's planes)."),
      size: z
        .tuple([z.number().positive(), z.number().positive()])
        .optional()
        .describe("Skirt box [x, z] in prop-local metres when the catalogue size (rubble spread, overhangs) is larger than the base. Default: dressing.size."),
      offset: z.tuple([z.number(), z.number()]).default([0, 0]).describe("Skirt box centre [x, z], prop-local metres."),
      tile: z.number().positive().default(3.2).describe("Metres one texture tile covers on the skirt's faces (the town texel standard: 128 px = 3.2 m)."),
      cap: z
        .boolean()
        .default(true)
        .describe(
          "Close the skirt's top. false: the piece's own base covers it (a pyre's ember bed lying at its foot: a cap over the ground under it buried the bed, or lay in its plane; r-found 2026-10-31). A piece with a floor (grade > 0) never has a cap.",
        ),
    })
    .optional()
    .describe(
      "A foundation skirt for a piece that stands on uneven ground (ruin walls, towers, corners, kit buildings, wall runs, plinths, gatehouses): " +
        "the footprint box extruded from just under the piece's base down to the lowest ground sample + `depth`, with a collider, so the piece " +
        "reads grounded without levelled terrain. Emitted by the solver only where the ground falls more than the footing covers.",
    ),
  bedded: z
    .boolean()
    .default(false)
    .describe("May intersect placed structures (rubble in a wall's foot, roots through a step): the solver's no-intersect rule skips it."),
  openings: z.array(placeOpeningSchema).default([]).describe("Doors, gates and stairs of this prop: the solver keeps dressing out of their clear zones."),
});
export type PlaceRule = z.infer<typeof placeRuleSchema>;
export type PlaceRuleInput = z.input<typeof placeRuleSchema>;

/** Register the `placeRule` component (called from registerCoreComponents). */
export function registerPlaceRuleComponent(registry: ComponentRegistry): void {
  registry.register("placeRule", placeRuleSchema);
}

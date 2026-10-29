/**
 * The TOWN DESIGN document (2026-10-29, Derek: "the layouts for our towns dont feel good — you should be able to make
 * terraces to put buildings there — there should be more of a design phase with the towns").
 *
 * The order used to be backwards: `worldgen terrace` cut shelves from a radius or an area total, then `town-layout`
 * squeezed lots onto whatever came out (Saltharrow: four masters, still rows of houses on parallel shelves). Now a
 * town DESIGNER agent writes this document first, on the real site, before any ground is cut:
 *
 *   site -> design (`town-design propose`, the designer iterates through `check`) -> approve (the plan picture)
 *        -> cut (`worldgen terrace --from-plan`) -> lots (`town-layout --from-plan`) -> build
 *
 * File: projects/<p>/authoring/towns/<name>-design.json. Its `buildings[].request` is the kit request (MMO/WFC
 * request format), so `kit_fit.py` reads the file as it is. Facts live here (`.describe()`, printed as JSON Schema by
 * `town-design schema`); the judgement lives in tools/zonegen/briefs/town-design.md.
 */
import { z } from "zod";

const id = z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "lower-case letters, digits and dashes");
const xz = z.tuple([z.number().finite(), z.number().finite()]);
const polygon = z.array(xz).min(3).describe("World XZ outline, either winding, not closed (the last vertex joins the first).");
const polyline = z.array(xz).min(2);

/** The design rules' numbers. One table: `check` enforces them, the schema text quotes them. */
export const DESIGN_RULE = {
  /** the building kit's cell (town-layout CELL) */
  cell: 3.2,
  /** steepest ramp (rise / run): TERRACE_DEFAULTS.rampGrade */
  rampGrade: 0.12,
  /** steepest stair: the terrace stage's --stair-grade */
  stairGrade: 0.5,
  /** most a terrace may cut into or fill above the natural ground (the 6 m rule) */
  maxCutFill: 6,
  /** a bank runs this many metres per metre of drop (RISER_RULE.bankRun, 1 : 2 planted) */
  bankRun: 2,
  /** a lot's ground envelope keeps this far inside a terrace edge that is a WALL (the retaining-wall fit's inset) ... */
  wallInset: 1.5,
  /** ... and this far inside a bank's top edge */
  bankInset: 1,
  /** air between two lots' ground envelopes (town-layout's 1 m) */
  lotAir: 1,
  /** a lot's ground envelope keeps this far off every street edge (town-layout's 0.5 m) */
  streetClear: 0.5,
  /** a door is ON its street when its ground envelope's front is at most this far from the street edge */
  doorReach: 4,
  /** eye height at the gate for the landmark sightline */
  eye: 1.7,
  /** a square stands within this many metres of the gate or the harbour */
  squareReach: 30,
  /** rows: more than this share of the buildings facing within `rowsDeg` of one bearing is a town of rows */
  rowsShare: 0.6,
  rowsDeg: 8,
  /** a ramp on ground steeper than this climbs ACROSS the slope: its run within 45 deg of the contour */
  acrossSlope: 0.1,
  /** a tread between the tiers of a stepped wall: RISER_RULE plans 2 m planted treads, but the wall fitter levels a
   *  foot strip of at least 4 m (CUT_FRONT 3.5 + 0.5) in front of every face, so a BUILT tread is 4.5 m (2 m and 3 m
   *  treads read as 1.5-2 m foot gaps on the tier above, hill lab 10-29) */
  tread: 4.5,
  /** the tallest single tier of a stepped wall (RISER_RULE.tierMax) */
  tierMax: 2.5,
  /** heights the retaining-wall kit has slices for (world-kit authoring/retaining-wall/lookup.json); another one is a Blender build */
  kitHeights: [0.8, 1.5, 2, 2.4, 3, 3.6, 4.4, 4.5, 5.2, 6, 6.4] as readonly number[],
} as const;

export const kitRequestSchema = z
  .object({
    system: z.enum(["common", "stone"]).default("common").describe("Kit system: `common` (timber/stucco/plank) or `stone`."),
    size: z.tuple([z.number().int().min(2), z.number().int().min(2)]).describe("Footprint in 3.2 m kit cells: [width ALONG its street, depth AWAY from it]. Must be a size the kit has PROVEN for these storeys/roof/features (`check` runs MMO/WFC/wfc/kit_fit.py)."),
    storeys: z.number().int().min(1).max(4).default(2),
    roof: z.string().default("gable").describe("gable | steep | flat | hip ... (the kit's roof names)."),
    features: z.array(z.string()).default([]).describe("Kit features (fireplace, tower, vault, grand_door, nave, church, apse, shopfront, forge_bay ...); the rules R31-R35 apply."),
  })
  .passthrough()
  .describe("The building-constructor request (MMO/WFC request format; style/seed pass through).");

export const designBuildingSchema = z.object({
  id,
  name: z.string().describe("What the town calls it (shown on the plan picture)."),
  district: z.string().optional().describe("A `districts[].id`."),
  at: xz.describe("World XZ of the footprint centre (the requested size, not the envelope)."),
  facing: xz.describe("World XZ direction the FRONT (door) faces: toward its street. Normalised on use."),
  street: z.string().describe("The `streets[].id` its door opens on."),
  request: kitRequestSchema.optional().describe("Its kit request. Omitted only with `model` (it reuses that building's model and request)."),
  model: z.string().optional().describe("Reuse another building's model (its id): the town fills out with houses already built."),
  optional: z.boolean().optional().describe("May be dropped when it does not fit (reported, never silently)."),
  note: z.string().optional(),
});

export const edgeTreatmentSchema = z.object({
  edge: z.number().int().min(0).describe("Polygon edge index: from polygon[edge] to polygon[edge + 1] (the last joins the first)."),
  treatment: z
    .enum(["auto", "bank", "wall", "stepped"])
    .describe(
      "What holds this edge (tools/worldgen-riser-rule.mts, per riser): `bank` = a 1 : 2 planted earth bank (2 m run per metre of drop), " +
        "`wall` = one kit retaining wall (its drop must be a kit height), `stepped` = 2-3 low walls (each <= 2.5 m) with 4.5 m planted treads (the wall fitter's foot strip), " +
        "`auto` = the riser rule decides (wall when the drop is over 2.5 m, a street or building stands within 3 m of the top edge, or the " +
        "bank's run does not fit before the next terrace, a street, a lot or the sea; else bank).",
    ),
  style: z.enum(["masonry-common", "masonry-stone"]).optional().describe("Wall style; default from the town tier (capital/city = stone)."),
});

export const designTerraceSchema = z.object({
  id,
  name: z.string().optional().describe("e.g. 'Harbour shelf', 'Chapel close'."),
  level: z.number().describe("The platform's height (world Y). Everything on it stands at this level."),
  polygon: polygon.describe("The designed platform outline. Irregular block shapes follow the ground and the streets; a straight band along the contour is the old draft, not a design."),
  buildings: z.array(z.string()).default([]).describe("The buildings standing on it (ids). Each building is on exactly one terrace, inside it by the kit margins (1.5 m off a wall edge, 1 m off a bank)."),
  edges: z.array(edgeTreatmentSchema).default([]).describe("Per-edge treatment; edges not listed are `auto`."),
  quay: z.boolean().optional().describe("A harbour platform at the water: its seaward edges may stand over the sea (a quay wall)."),
  note: z.string().optional(),
});

export const designStreetSchema = z.object({
  id,
  name: z.string(),
  kind: z.enum(["main", "lane", "quay", "close"]).default("lane").describe("main = the street the gate opens on and the town climbs by; lane = a side lane; quay = along the water; close = a cul-de-sac or a chapel close."),
  points: polyline.describe("Centre-line, world XZ. Every point stands on a terrace or a square; where it changes level it runs through a `connections` stair or ramp."),
  width: z.number().positive().default(5).describe("Clear width (m): main 5-6, lanes 3.5-4.5."),
  surface: z.enum(["gravel", "paving", "dirt"]).default("gravel"),
  note: z.string().optional(),
});

export const designSquareSchema = z.object({
  id,
  name: z.string(),
  kind: z.enum(["market", "gate", "harbour", "chapel", "well"]).default("market"),
  polygon,
  terrace: z.string().describe("The terrace it is laid on (its level)."),
});

export const designConnectionSchema = z.object({
  id,
  kind: z.enum(["ramp", "stair"]).describe(`ramp: a graded street at most ${DESIGN_RULE.rampGrade * 100} % (carts); stair: steps at most ${DESIGN_RULE.stairGrade * 100} %. Through a WALL edge it is built as the wall's own insert (stair / ramp along the face); through a bank it is cut into the bank.`),
  from: z.string().describe("Lower terrace id, or `gate` (the natural ground at the gate)."),
  to: z.string().describe("Upper terrace id."),
  points: polyline.describe("Its line from the lower end (on `from`) to the upper end (on `to`), world XZ; the run is its length."),
  width: z.number().positive().default(4),
  street: z.string().optional().describe("The street it carries (a street crossing levels runs through it)."),
});

export const townDesignSchema = z
  .object({
    version: z.literal(1).default(1),
    town: z.string().describe("The recipe town id (`features.towns[].id`)."),
    world: z.string().describe("The world recipe name."),
    name: z.string().describe("The town's file name stem (authoring/towns/<name>-design.json) and its layout name."),
    title: z.string().optional().describe("The town's name, for the picture."),
    status: z
      .enum(["draft", "approved"])
      .default("draft")
      .describe("`approved` only after the coordinator or Derek has seen the plan picture (+ the concept on the site). `worldgen terrace --from-plan` refuses a draft."),
    approval: z.object({ by: z.string(), at: z.string(), note: z.string().optional() }).optional().describe("Who approved the picture, when (ISO date), and on what."),
    idea: z.string().optional().describe("One sentence: what the town is and how it sits on its ground."),
    gate: z
      .object({ at: xz, facing: xz.describe("Outward, away from the town.") })
      .describe("The way in (from the recipe town's first gate). The main street starts here; a square stands within 30 m of it or of the harbour."),
    harbour: xz.optional().describe("Coastal towns: the landing point on the water (quay head)."),
    districts: z
      .array(z.object({ id, name: z.string(), role: z.string().describe("harbour, market, chapel close, high town, craft row ..."), note: z.string().optional() }))
      .default([]),
    terraces: z.array(designTerraceSchema).min(1).describe("Designed platforms, each at one level. They may touch along a riser, never overlap."),
    streets: z.array(designStreetSchema).min(1),
    squares: z.array(designSquareSchema).default([]),
    connections: z.array(designConnectionSchema).default([]).describe("Every stair and ramp between levels: placed where the streets cross levels."),
    landmark: z
      .object({
        building: z.string().describe("The landmark building's id (chapel, bell tower, guild hall)."),
        height: z.number().positive().optional().describe("Its top over its terrace (m). Default storeys x 3.2 + 4 (+ 8 with a `tower` feature)."),
      })
      .describe("The landmark CLOSES A VIEW: seen from the gate (eye 1.7 m, line to its top clear of the designed ground and the other buildings), within 40 deg of the way in."),
    buildings: z.array(designBuildingSchema).min(1),
    note: z.string().optional(),
  })
  .superRefine((d, ctx) => {
    const seen = (kind: string, ids: string[]) => {
      const s = new Set<string>();
      ids.forEach((v, i) => {
        if (s.has(v)) ctx.addIssue({ code: "custom", path: [kind, i], message: `duplicate ${kind} id "${v}"` });
        s.add(v);
      });
    };
    seen("terraces", d.terraces.map((t) => t.id));
    seen("streets", d.streets.map((t) => t.id));
    seen("buildings", d.buildings.map((t) => t.id));
    seen("connections", d.connections.map((t) => t.id));
    for (const [i, b] of d.buildings.entries()) if (!b.request && !b.model) ctx.addIssue({ code: "custom", path: ["buildings", i], message: `${b.id}: needs a request or a model` });
  });

export type TownDesign = z.infer<typeof townDesignSchema>;
export type DesignTerrace = TownDesign["terraces"][number];
export type DesignBuilding = TownDesign["buildings"][number];
export type DesignStreet = TownDesign["streets"][number];
export type DesignConnection = TownDesign["connections"][number];
export type EdgeTreatment = z.infer<typeof edgeTreatmentSchema>["treatment"];

import { z } from "zod";
import type { ChunkDoc } from "../chunks.js";

/**
 * TERRACE WALLS: a levelled pad held up by real retaining-wall geometry.
 *
 * Derek's ruling: retaining walls and their stairs are built geometry; the terrain is only levelled for them
 * ("terrain is not architecture"). A terrace wall is the authoring half of that: the pad outline, the drop and the
 * inserts an agent (or `worldgen terrace`) dictates. `worldgen terrace-place` solves it against the ground — the pad
 * level, the wall pieces from the retaining-wall kit (nine-slice: corners, stepped ends, coping, straights to any
 * length; stairs, ramps, doors, drains and buttresses as inserts), a feathered height patch for the pad and the low
 * strip at the wall foot, and box cuts that keep the terrain riser behind the wall face — and writes the result
 * into `solved` (pieces, oriented cuts) plus the derived `heightPatches` / `clearings` (id `tw-<id>`). A terrain rebuild
 * re-fits from this doc (`terrace-place --refit`); nothing is a hand-placed entity. The streamer emits
 * `solved.pieces` as prefab instances in the cell each stands in.
 *
 * Walls take any heading (edges on a 2 m run grid along themselves, turns on 5 deg steps). The terrain lattice is
 * 2 m, so a heightfield riser would be a 2 m ramp: the fit holds the lattice row in front of each face at pad
 * height and the field carves it with an oriented cut (`solved.cuts`) whose back plane stands inside the wall
 * body; `height()` reports the foot there, so ground queries agree with the drawn terrain.
 */

const slug = z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase slug");
const xz = z.tuple([z.number().finite(), z.number().finite()]);

export const TERRACE_WALL_STYLES = ["masonry-common", "masonry-stone", "natural"] as const;
export const TERRACE_WALL_INSERTS = ["stair", "stair-turn", "ramp", "drain", "buttress", "door-arch", "door-lintel"] as const;

export const terraceWallInsertSchema = z.object({
  role: z
    .enum(TERRACE_WALL_INSERTS)
    .describe(
      "What replaces plain wall at this offset. stair: straight flights against the face (2 m of low ground). stair-turn: " +
        "dog-leg stair for tight terraces (3.8 m of low ground). ramp: ~10.6 deg ramp along the face. drain / buttress: a " +
        "straight with weep holes / a buttress. door-lintel (wall >= 3.2 m) / door-arch (>= 3.6 m): a doorway with a 2 m " +
        "passage into the pad (its keep-clear box is carved; the pad must stand a lattice node above the passage roof).",
    ),
  edge: z.number().int().min(0).default(0).describe("Footprint edge index: the edge from footprint[edge] to footprint[edge + 1]. It must carry wall."),
  at: z.number().min(0).describe("Metres from that edge's start vertex, snapped down to the 2 m grid."),
  run: z.union([z.literal(2), z.literal(4)]).default(4).describe("drain / buttress only: a 2 m or a 4 m module."),
});

export const terraceWallPieceSchema = z.object({
  prefab: z.string().describe("Retaining-wall kit prefab id."),
  role: z.string(),
  position: z.tuple([z.number(), z.number(), z.number()]).describe("World position of the piece origin (its start vertex on the face line, at the wall foot)."),
  yaw: z.number().describe("Degrees about +Y."),
  run: z.number().positive().optional().describe("Length (m) the piece runs along its face from its origin (body pieces)."),
  overrides: z
    .array(z.object({ path: z.string(), value: z.unknown() }))
    .optional()
    .describe("Prefab overrides for this placement: the run-space UV phase variant of its meshes (the texture runs on unbroken from the piece before)."),
});

export const terraceWallCutSchema = z.object({
  kind: z.enum(["face", "door"]).describe("face: the low side of a wall face (the terrain riser stands inside the wall body, and `height()` reads the foot there); door: a doorway's keep-clear box."),
  origin: xz.describe("World XZ the cut's frame starts at."),
  dir: xz.describe("Unit XZ direction of the frame's s axis (the face's walking direction); n is to its right (the low side)."),
  s: z.tuple([z.number(), z.number()]).describe("Extent along dir (m)."),
  n: z.tuple([z.number(), z.number()]).describe("Extent along the low-side normal (m): negative is behind the face, inside the wall."),
  y: z.tuple([z.number(), z.number()]).describe("Floor and top of the carved box (world Y). The floor is exact: the foot of the wall."),
});

export const terraceWallSolvedSchema = z.object({
  style: z.enum(TERRACE_WALL_STYLES).describe("The kit style the pieces came from (natural falls back to `fallback` until the natural shelf kit exists)."),
  topY: z.number().describe("Pad level the walls retain."),
  baseY: z.number().describe("Wall foot: the levelled low ground in front of every face."),
  height: z.number().describe("Wall drop on the kit's 0.4 m courses (topY - baseY)."),
  runs: z.array(z.object({ edges: z.array(z.number().int()), closed: z.boolean() })).describe("Footprint edges grouped into continuous wall runs."),
  faces: z
    .array(z.object({ a: xz, b: xz, normal: xz }))
    .describe("Wall face lines and their low-side normals. The lattice step under them is the wall's: `worldgen lips` exempts it."),
  pieces: z.array(terraceWallPieceSchema).describe("Every body and coping piece, world placed. The streamer emits these; do not hand-edit."),
  cuts: z
    .array(terraceWallCutSchema)
    .default([])
    .describe("Oriented boxes the field carves (any heading): the low side of every face and each doorway's passage. The field reads these directly."),
  sockets: z
    .array(z.object({ name: z.string(), tag: z.string(), position: z.tuple([z.number(), z.number(), z.number()]), yaw: z.number() }))
    .default([])
    .describe("Doorway sockets (interior / portal / arrival), world placed."),
  derived: z
    .object({ patch: z.string(), passages: z.array(z.string()), clearing: z.string() })
    .describe("Ids of the features this fit wrote into `features.heightPatches` / `passages` / `clearings`; a refit replaces exactly these."),
  ground: z.number().describe("Fingerprint (mean natural height over the raster) of the ground the fit was solved on; `terrace-place --check` reports a terrace STALE when the ground under it has changed."),
  warnings: z.array(z.string()).default([]),
});

export const terraceWallSchema = z
  .object({
    id: slug.describe("Stable id; its derived height patch and clearing are `tw-<id>`."),
    owner: z.string().optional().describe("Who wrote it (a town or POI id). `worldgen terrace` owns the `<town>-riser-*` terraces of the towns it steps and rewrites them."),
    style: z
      .enum(TERRACE_WALL_STYLES)
      .default("masonry-common")
      .describe("masonry-common: coursed rubble (houses, lanes, fields). masonry-stone: dressed ashlar (civic works, capitals). natural: rock shelves from the rock kit."),
    fallback: z
      .enum(["masonry-common", "masonry-stone"])
      .optional()
      .describe("natural only: the masonry style to build with while the natural shelf kit (world-kit rock-kit shelf-lookup.json) does not exist. Omitted = a natural terrace fails until it does."),
    footprint: z
      .array(xz)
      .min(3)
      .describe("Outline of the upper pad, world XZ, any headings (wall runs are laid on a 2 m / 5 deg run grid from their first vertex; an all-axis outline snaps to the 2 m world grid). Either winding."),
    walls: z
      .union([z.literal("auto"), z.array(z.number().int().min(0))])
      .default("auto")
      .describe("Footprint edge indices that carry wall (the rest meet the hill as feathered banks). auto: every edge whose outside ground lies at least `minDrop` and 60 % of the steepest edge's drop below the pad."),
    minDrop: z.number().positive().default(1.2).describe("auto walls: smallest drop (m) worth a wall. With a dictated `height` an edge must also drop a quarter of it (the strip is cut down to the foot)."),
    facing: xz
      .optional()
      .describe("auto walls: the way the ground falls ([x, z], any length). Only edges whose outward normal is within 60 deg of it get wall — a wall running UP a slope would need its foot dug into the hill."),
    topY: z.number().optional().describe("Pad level. Omitted = solved from the ground (median over the footprint; nudged so a doorway keeps a roof)."),
    height: z
      .number()
      .min(0.8)
      .max(6.4)
      .optional()
      .describe("Wall drop (m), snapped to the kit's 0.4 m courses (1.5 / 3 / 4.5 exact). Omitted = from the ground at the wall foot. A height the kit has no slices for is built by `build.mts make` on the first fit."),
    inserts: z.array(terraceWallInsertSchema).default([]),
    strip: z.number().min(1).max(8).default(2.5).describe("Metres of low ground levelled at the wall foot (stairs and ramps take their own footprint + 1 m)."),
    feather: z.number().min(2).optional().describe("Minimum width (m) over which levelled ground blends back into the hill. Default: 1.6 x the height difference, at least 4."),
    wear: z.number().int().min(0).max(3).default(0).describe("0 kept, 1 weathered (drains), 2 run-down (buttresses, worn coping), 3 ruined (gaps in the coping)."),
    seed: z.string().optional(),
    tags: z.array(z.string()).default([]),
    solved: terraceWallSolvedSchema.optional().describe("Written by `worldgen terrace-place`; never hand-edit. Absent = not fitted yet (nothing is built)."),
  })
  .describe("A terrace held up by retaining walls: pad outline + drop + inserts; solved by `worldgen terrace-place`.");

export type TerraceWallDoc = z.infer<typeof terraceWallSchema>;
export type TerraceWallSolved = z.infer<typeof terraceWallSolvedSchema>;
export type TerraceWallInsert = z.infer<typeof terraceWallInsertSchema>;
export type TerraceWallCut = z.infer<typeof terraceWallCutSchema>;

/** Derived-feature id prefix of a terrace wall. */
export const terraceWallFeatureId = (id: string): string => `tw-${id}`;

/**
 * The fitted wall pieces of every terrace wall that stand in chunk cell (cx, cz), as collapsed prefab instances
 * (the static batcher merges them per material). Unfitted terraces emit nothing.
 */
export function terraceWallEntities(
  terraces: readonly TerraceWallDoc[] | undefined,
  cellSize: number,
  cx: number,
  cz: number,
  entities: ChunkDoc["entities"],
  assetExists?: (assetId: string, kind: "prefab" | "model") => boolean,
): void {
  if (!terraces?.length) return;
  const x0 = cx * cellSize, z0 = cz * cellSize;
  for (const t of terraces) {
    const pieces = t.solved?.pieces;
    if (!pieces) continue;
    pieces.forEach((p, i) => {
      const [x, y, z] = p.position;
      if (Math.floor(x / cellSize) !== cx || Math.floor(z / cellSize) !== cz) return;
      if (assetExists && !assetExists(p.prefab, "prefab")) return;
      const half = (p.yaw * Math.PI) / 360;
      entities[`tw_${t.id}_${i}`] = {
        name: `${t.id} ${p.role}`,
        parent: null,
        tags: ["terrace-wall", t.id],
        components: {
          transform: { position: [x - x0, y, z - z0], rotation: [0, Math.sin(half), 0, Math.cos(half)] },
          prefab: { prefabId: p.prefab, props: {}, overrides: p.overrides ?? [] },
        },
      };
    });
  }
}

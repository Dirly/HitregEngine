import { z } from "zod";

/**
 * Dressing documents: where props MAY go in a space (`socket-map`), reusable
 * groups of props (`dressing-set`), and what a designer chose (`dressing-plan`).
 *
 * The other half is on the prop: the `dressing` component
 * (../components/dressing.ts) declares how each prop mounts and what sockets
 * it offers. A plan joins the two by NAMING things (a prop, a wall, a socket)
 * and never by writing a transform; `resolveDressing` (./resolve.ts) turns it
 * into transforms and findings. That is what makes "paper floating above a
 * shelf" or "a drawer on the floor" impossible to write rather than something
 * a reviewer has to catch.
 *
 * All coordinates are metres in the MAP'S LOCAL FRAME: +Y up, XZ on the floor.
 * For a building that is the building model's own frame, so one map serves
 * every town the model is reused in; the installer applies the instance
 * transform. Zod-only module.
 */

const xz = z.tuple([z.number().finite(), z.number().finite()]);
const xyz = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

/** One character per cell in `socketLevelSchema.cells`. */
export const SOCKET_CELLS = {
  outside: " ",
  free: ".",
  wall: "#",
  /** Floor with no ceiling (a yard, a roofless ruin): outdoor props only. */
  open: "o",
  /** A stair flight. Never furnished; items keep the stair buffer from it. */
  stair: "S",
  /** A stair well / hole in an upper floor. */
  well: "W",
  /** A doorway between two rooms. */
  doorway: "D",
  /** The lane kept clear inside an outside door. */
  entry: "E",
  /**
   * Floor kept clear in front of a hearth (a building's `hearth-clearance` marker): walkable, and a rug may lie on it,
   * but no solid prop stands on it; solid props close to it are warned, like the stair buffer.
   */
  hearth: "H",
  /**
   * The way on and off a stair (a building's `stair-foot`, `stair-head` and `stair-approach` markers): walkable floor
   * a player needs to reach the first step and to step off the last, side gap included. No solid prop stands on it,
   * and a player-wide lane must reach it from the entry (approach/foot) and lead from it onto its floor (head).
   */
  stairClear: "A",
  /**
   * A walking path reserved when the map is generated (`dress sockets`' circulation mask): free floor a player needs
   * to get from the door to every doorway, stair, hearth and through every large room, as wide as the resolver's lane.
   * Walkable; no SOLID prop's footprint may touch it, but a rug or other walk-over (non-solid) prop may lie on it.
   * The manifest shows it as 'x' (crossed out): furniture goes only on what is left.
   */
  path: "x",
} as const;

/** Clear height per cell is one base-36 digit of quarter metres ("c" = 3.0 m), capped at "z" = 8.75 m or more. */
export const HEAD_STEP = 0.25;
/** One step of a level's outdoor `ground` raster, metres; the digit 'i' (18) is the level's floorY. */
export const GROUND_STEP = 0.05;
export const GROUND_ZERO = 18;

export const socketRoomSchema = z.object({
  id: z.string().min(1).describe("Unique in the map, e.g. \"G-1\" (ground) or \"U1-2\" (first upper floor)."),
  index: z.number().int().min(0).max(35).describe("This room's digit in the level's `room` raster (base 36)."),
  area: z.number().positive().describe("Free floor, square metres."),
  centre: xz,
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).describe("[minX, maxX, minZ, maxZ] of its free cells."),
  minHead: z.number().describe("Lowest clear height over the room's free floor, metres."),
  maxHead: z.number().describe("Highest clear height: >= 5 m is where a chandelier can hang."),
});
export type SocketRoom = z.infer<typeof socketRoomSchema>;

export const socketWallSchema = z.object({
  id: z.string().min(1).describe("Unique in the map, e.g. \"G-1.N\" or \"L0-W3\". Plans place wall items and wall-backed furniture by this id."),
  room: z.string().min(1).describe("The room this face looks into."),
  a: xz.describe("LEFT end of the wall face on the floor, as seen from inside the room facing the wall. `t` in a plan is metres from here toward `b` (left to right)."),
  b: xz,
  normal: xz.describe("Unit vector pointing from the wall INTO the room. A prop placed on this wall faces this way."),
  spans: z
    .array(z.tuple([z.number().min(0), z.number().min(0)]))
    .describe("Stretches [t0, t1] (metres from `a`) that are solid, uninterrupted wall: no door, window, stair or opening. A prop's whole width must fit in one."),
  height: z.number().positive().describe("Usable wall height above the floor before the ceiling or a slope starts, metres."),
});
export type SocketWall = z.infer<typeof socketWallSchema>;

export const socketPathSchema = z.object({
  id: z.string().min(1).describe("Unique on its level, e.g. \"L0-p2\"."),
  name: z.string().min(1).describe("What it is for, as a designer reads it: \"the way from the door to the stair\", \"the walk through G-1\"."),
  width: z.number().positive().describe("Lane width, metres: the resolver's lane (player capsule plus comfort). Its cells are every cell this lane's body overlaps."),
  points: z.array(xz).min(1).describe("Centre line, local XZ metres: where it leaves the path network, every turn, and its end."),
});
export type SocketPath = z.infer<typeof socketPathSchema>;

export const socketLevelSchema = z
  .object({
    level: z.number().int().min(0).describe("0 = ground floor."),
    floorY: z.number().describe("Local Y of the walking surface."),
    origin: xz.describe("Local XZ of the corner of cell (column 0, row 0). Columns run +X, rows +Z."),
    step: z.number().positive().describe("Cell size in metres (0.25 by default)."),
    columns: z.number().int().positive(),
    rows: z.number().int().positive(),
    cells: z.array(z.string()).describe("One string per row, one character per cell, from SOCKET_CELLS: ' ' outside, '.' free floor, '#' wall, 'o' unroofed floor, 'S' stair, 'W' well, 'D' doorway, 'E' entry lane, 'H' hearth clearance (walkable; no solid prop), 'A' stair approach/foot/head (walkable; no solid prop; must be reachable), 'x' reserved walking path (walkable; no solid prop; a rug may lie on it)."),
    head: z.array(z.string()).describe("Clear height above the floor per cell: one base-36 digit of quarter metres (HEAD_STEP); '.' where there is no floor."),
    room: z.array(z.string()).describe("Room membership per cell: the room's `index` as a base-36 digit; '.' = no room (walls, thresholds)."),
    ground: z
      .array(z.string())
      .optional()
      .describe(
        "Outdoor sites only (`site-sockets`): ground height per cell relative to `floorY`, one base-36 digit of GROUND_STEP (0.05 m) with 'i' = floorY " +
          "('0' = -0.90 m, 'z' = +0.85 m); '.' = floorY. Floor props stand on the ground under their centre.",
      ),
    rooms: z.array(socketRoomSchema),
    walls: z.array(socketWallSchema),
    paths: z
      .array(socketPathSchema)
      .default([])
      .describe(
        "The circulation mask's walking paths on this level (`circulate`, run by `dress sockets`): their cells are the 'x' cells (keep-clear cells they cross keep their own code). " +
          "The resolver names the path a solid prop stands on.",
      ),
  })
  .superRefine((l, ctx) => {
    for (const key of ["cells", "head", "room", "ground"] as const) {
      const raster = l[key];
      if (!raster) continue;
      if (raster.length !== l.rows) ctx.addIssue({ code: "custom", path: [key], message: `expected ${l.rows} rows` });
      else if (raster.some((row) => row.length !== l.columns)) ctx.addIssue({ code: "custom", path: [key], message: `every row must be ${l.columns} characters` });
    }
  });
export type SocketLevel = z.infer<typeof socketLevelSchema>;

export const socketAnchorSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1).describe("What the point is for: \"door-side\", \"sign-bracket\", \"hearth\", \"counter\", \"altar\", \"bed-nook\", \"stall\". A plan places by id; the kind lets a designer find it."),
  level: z.number().int().min(0).default(0),
  position: xyz.describe("Local metres. The placed prop's origin lands here."),
  yaw: z.number().default(0).describe("Degrees about +Y the placed prop faces (0 = local +Z)."),
  mount: z.enum(["floor", "wall", "ceiling"]).describe("Which prop mount this point takes."),
  outdoor: z.boolean().default(false).describe("True for points outside the shell (door torches, a sign bracket, a stall pitch)."),
  size: xyz
    .optional()
    .describe("[w, h, d] metres of the fixture this point stands for, when the model says so (a hearth's fire opening, from its `.markers.json`). `dress fixtures` sizes the fire from it."),
});
export type SocketAnchor = z.infer<typeof socketAnchorSchema>;

export const socketMapSchema = z
  .object({
    id: z.string().min(1).describe("Usually the building model's id; a street or plaza map uses its own."),
    source: z
      .object({
        model: z.string().describe("Asset path of the geometry this was measured from."),
        sha256: z.string().describe("Its hash when measured. A differing hash means the map is STALE and must be regenerated."),
      })
      .optional(),
    entry: z
      .object({ position: xz, facing: xz.describe("Unit vector pointing INTO the building from the door.") })
      .optional()
      .describe("The outside door. Route checks start here."),
    levels: z.array(socketLevelSchema).min(1),
    anchors: z.array(socketAnchorSchema).default([]).describe("Named single-prop points the geometry itself implies."),
  })
  .describe(
    "Where props may go in one space, measured from its geometry (authoring/dressing/sockets/<id>.json; written by `dress sockets`, never by hand; authoring-time only, never loaded by the runtime). " +
      "Free floor, walls with their uninterrupted spans, headroom, and the stairs/doorways that must stay clear.",
  );
export type SocketMap = z.infer<typeof socketMapSchema>;

/**
 * Where one item goes. The `kind` must agree with the prop's declared mount:
 *   floor prop    -> "floor" (open floor) or "wall" (standing with its back to that wall)
 *   wall prop     -> "wall" (hung, `height` used)
 *   ceiling prop  -> "ceiling"
 *   surface/slot  -> "on"
 *   any of floor/wall/ceiling -> "anchor" when the anchor's mount matches
 */
export const dressingPlaceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("floor"),
    level: z.number().int().min(0).default(0),
    at: xz.describe("Local XZ of the prop's centre."),
    yaw: z.number().default(0).describe("Degrees about +Y the prop's front faces (0 = local +Z, 90 = local +X)."),
  }),
  z.object({
    kind: z.literal("wall"),
    wall: z.string().min(1).describe("A wall id from the socket map."),
    t: z.number().min(0).describe("Metres along the wall from its `a` end to the prop's centre."),
    height: z.number().min(0).optional().describe("Wall-mounted props only: bottom edge above the floor. Omitted = the middle of the prop's `wallHeight`."),
  }),
  z.object({
    kind: z.literal("ceiling"),
    level: z.number().int().min(0).default(0),
    at: xz,
    yaw: z.number().default(0),
    drop: z.number().min(0).default(0).describe("Metres from the ceiling down to the prop's top. Only props with a `chain` may drop."),
  }),
  z.object({
    kind: z.literal("on"),
    item: z.string().min(1).describe("Id of the item (in this plan, or a sibling inside the same set) whose socket it goes on."),
    socket: z.string().default("").describe("Socket id on that item's prop. Empty = the first socket that accepts and still has room."),
    offset: xz.optional().describe("surface only: metres from the socket centre, in the HOST's local X and Z. Omitted = auto-arranged left to right."),
    yaw: z.number().default(0).describe("Degrees added to the socket's facing."),
  }),
  z.object({ kind: z.literal("anchor"), anchor: z.string().min(1).describe("An anchor id from the socket map.") }),
  z
    .object({
      kind: z.literal("auto"),
      room: z.string().min(1).describe("The room (map room id, e.g. \"G-1\") it goes in. The resolver picks the spot."),
      prefer: z
        .enum(["wall", "corner", "open", "near"])
        .optional()
        .describe(
          "`wall`: back to a wall, centred on the longest free stretch. `corner`: back to a wall, tucked into a corner. `open`: in the open floor, " +
            "aligned to the room, as far from everything as the room allows. `near`: as close to `near` as fits, facing it when in the open. " +
            "Omitted: `wall` for wall-backed and either-way props, `open` for free-standing ones (`near` when `near` is given).",
        ),
      near: z
        .string()
        .optional()
        .describe("An earlier item id in this plan, or an anchor kind of the map (hearth, door, stair, sconce...): the spot is chosen as close to it as fits."),
      wall: z.string().optional().describe("Only this wall id (with `wall`/`corner`)."),
    })
    .describe(
      "Placement by intent: name the room and a preference; the resolver picks a free spot deterministically (never on a path, keep-clear zone or " +
        "another item; inside the lane, buffer and density rules; honouring the prop's `against` and clearance). Items resolve in plan order, so " +
        "earlier ones win; one that cannot fit is a violation that says how much room was left. `dress check` prints the spot chosen.",
    ),
]);
export type DressingPlace = z.infer<typeof dressingPlaceSchema>;

export const dressingItemSchema = z
  .object({
    id: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/i, "letters, digits, . _ - only").describe("Unique in the plan (or set). Becomes part of the scene entity id, so keep it stable."),
    prop: z.string().default("").describe("Prefab id of a prop carrying a `dressing` component. Exactly one of `prop` / `set`."),
    set: z.string().default("").describe("A dressing-set id: the whole group is placed by its anchor piece and its members expand to items `<id>/<member>`."),
    place: dressingPlaceSchema,
    mirror: z
      .boolean()
      .optional()
      .describe(
        "Sets only: true swaps the set's left and right (a nightstand on the left goes on the right; see the set's `shape`). Omitted with an " +
          "`auto` place = the resolver may mirror the set to make it fit; omitted otherwise = as authored.",
      ),
    note: z.string().default("").describe("Why it is here (whose desk, what trade). For the reviewer; never read by the resolver."),
    setPiece: z
      .boolean()
      .optional()
      .describe("This item is the room's declared SET PIECE (the throne, the great table): it may stand in the room's keep-clear centre. One per room, two in a great hall."),
    props: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Values for the placed prefab's declared props (a hearth fire's `size`), written onto the instance by `dress apply`. Single props only; " +
          "omit to take the prefab's defaults, which is what keeps a shared look editable in one place.",
      ),
  })
  .superRefine((item, ctx) => {
    if ((item.prop === "") === (item.set === "")) ctx.addIssue({ code: "custom", path: ["prop"], message: "give exactly one of `prop` or `set`" });
    if (item.mirror !== undefined && item.set === "") ctx.addIssue({ code: "custom", path: ["mirror"], message: "`mirror` is for set items only" });
  });
export type DressingItem = z.infer<typeof dressingItemSchema>;

const uniqueItemIds = (items: { id: string }[], ctx: z.RefinementCtx): void => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) ctx.addIssue({ code: "custom", path: ["items", index, "id"], message: `duplicate item id "${item.id}"` });
    seen.add(item.id);
  });
};

export const dressingSetSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().default(""),
    rooms: z.array(z.string().min(1)).default([]).describe("Room roles this group furnishes (same vocabulary as the `dressing` component's `rooms`)."),
    wealth: z.array(z.enum(["destitute", "poor", "comfortable", "wealthy", "noble"])).default([]),
    themes: z.array(z.string().min(1)).default([]),
    footprint: xz.describe("Floor the whole group needs, [width X, depth Z] metres, in the anchor piece's frame (front = +Z). For the menu; the resolver still checks every member."),
    shape: z
      .string()
      .default("")
      .describe(
        "Where each member falls relative to the anchor, in words the menu prints: left/right as seen standing in front of the anchor, facing it " +
          "(\"chest at the foot; nightstand on the left\"). A plan item may mirror the set (`mirror: true`) to swap the sides.",
      ),
    items: z
      .array(dressingItemSchema)
      .min(1)
      .describe(
        "items[0] is the ANCHOR: a single prop whose own `place` is ignored, because the plan places it. Every other member is placed relative " +
          "to the anchor: `floor` places use the anchor's local frame (`at` = offset from the anchor's centre, +Z = its front; `yaw` relative to it), " +
          "`on` places name a sibling member. Members may not be sets, and `wall`/`ceiling`/`anchor` places are not allowed inside a set.",
      ),
  })
  .superRefine((set, ctx) => {
    uniqueItemIds(set.items, ctx);
    set.items.forEach((item, index) => {
      if (item.set !== "") ctx.addIssue({ code: "custom", path: ["items", index, "set"], message: "a set may not contain sets" });
      if (item.mirror !== undefined) ctx.addIssue({ code: "custom", path: ["items", index, "mirror"], message: "`mirror` is for plan items placing a set" });
      if (index > 0 && item.place.kind !== "floor" && item.place.kind !== "on")
        ctx.addIssue({ code: "custom", path: ["items", index, "place"], message: "set members are placed with `floor` (relative to the anchor) or `on` (a sibling)" });
    });
  })
  .describe(
    "A reusable furnished group (authoring/dressing/sets/<id>.json): a desk with its chair, papers and candle; a bed with its chest. Authored once, " +
      "placed as ONE plan item, so most of a room is chosen from a short menu rather than assembled prop by prop.",
  );
export type DressingSet = z.infer<typeof dressingSetSchema>;

export const dressingSpaceSchema = z
  .object({
    kind: z
      .enum(["building", "dungeon", "site"])
      .default("building")
      .describe(
        "`dungeon`: every room keeps its MIDDLE clear (a central keep-clear zone sized from the room; only a centrepiece/set piece stands there), " +
          "solid props keep `pathMargin` (default 0.4 m) off every walking path, doorway and stair, and the stair/doorway buffers are wider (1.0 / 1.6 m). " +
          "`building`/`site`: the centre rule is off unless a room sets `keepCentre`; the review still scores centre clutter.",
      ),
    scale: z
      .string()
      .min(1)
      .optional()
      .describe("The scale class of the people who live here (dressing vocabulary: tiny, small, human, large, giant). Props of another class (not `any`) are refused."),
    cultures: z
      .array(z.string().min(1))
      .default([])
      .describe("Whose place this is (dressing vocabulary: civic, rural, bandit, crypt, giant, ratkin, anansi...). Props sharing none of them (and not `any`) are refused."),
  })
  .describe("What kind of place this plan dresses, at what scale, for whom. The menu (`props menu --plan`) offers only matching props; the resolver refuses the rest.");
export type DressingSpace = z.infer<typeof dressingSpaceSchema>;

export const dressingObstacleSchema = z.object({
  id: z.string().min(1),
  level: z.number().int().min(0).default(0),
  at: xz.describe("Local XZ of the footprint centre."),
  size: z.tuple([z.number().positive(), z.number().positive()]).describe("[width X, depth Z] metres before yaw."),
  yaw: z.number().default(0).describe("Degrees about +Y."),
  height: z.number().positive().default(10).describe("Metres above the floor it occupies."),
  note: z.string().default(""),
});
export type DressingObstacle = z.infer<typeof dressingObstacleSchema>;

export const dressingPlanSchema = z
  .object({
    id: z.string().min(1).describe("Usually `<town>/<building instance>` or `<poi>/<space>`."),
    map: z.string().min(1).describe("The socket-map this plan dresses."),
    rooms: z
      .record(
        z.string(),
        z.object({
          role: z.string().min(1).describe("What the room is: bedroom, kitchen, shop, storage… (the `dressing` vocabulary)."),
          also: z
            .array(z.string().min(1))
            .default([])
            .describe("Other things the same room is used for. A one-room cottage is kitchen, hall and storage at once: props tagged for any of these roles belong."),
          owner: z.string().default("").describe("Resident id(s) who use it, for the reviewer."),
          wealth: z.enum(["destitute", "poor", "comfortable", "wealthy", "noble"]).optional(),
          scale: z.string().min(1).optional().describe("This room's scale class when it differs from `space.scale` (a giant hall's ratkin-infested store)."),
          cultures: z.array(z.string().min(1)).optional().describe("This room's cultures when they differ from `space.cultures`."),
          keepCentre: z.boolean().optional().describe("Override `space`'s centre rule for this room: true keeps its middle clear, false lets furniture stand there (a tavern's tables)."),
        }),
      )
      .default({})
      .describe("The room programme, keyed by room id from the map. Every room must appear and be furnished; an empty room is a finding."),
    space: dressingSpaceSchema.optional(),
    obstacles: z
      .array(dressingObstacleSchema)
      .default([])
      .describe("Placed geometry on this space's floor that the socket map does not show (statues, pillars, set-piece models): no prop may overlap one."),
    items: z.array(dressingItemSchema).default([]),
  })
  .superRefine((plan, ctx) => uniqueItemIds(plan.items, ctx))
  .describe(
    "A designer's choices for one space (authoring/dressing/plans/<id>.json, checked by `dress check`, installed by `dress apply`): which props and sets, on which " +
      "wall, floor point, ceiling point or socket. No transforms: the resolver computes them from the socket map and each prop's `dressing` declaration.",
  );
export type DressingPlan = z.infer<typeof dressingPlanSchema>;
export type DressingPlanInput = z.input<typeof dressingPlanSchema>;

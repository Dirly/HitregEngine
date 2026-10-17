import { z } from "zod";
import type { ChunkDoc } from "../chunks.js";

/**
 * BRIDGE SPANS: real bridges across real gaps — a stone arch bridge / aqueduct (a repeating arcade, piers founded on
 * the ground or seabed, abutments seated into both cliff tops, an optional lower arcade for tall crossings) or a
 * rope suspension bridge (a catenary deck of lashed planks between anchor posts and deadmen).
 *
 * The doc is the authoring half: two anchors, the kind, the style and a few options. `worldgen bridge-place` solves
 * it against the ground — measures the gap and the ground / seabed profile under it, picks the bay width and count,
 * stacks every pier down to real footing, seats both ends (feathered height-patch pads, or rock seating), builds a
 * rope bridge's catenary piece for its span — and writes `solved` (prefab pieces, walk profile) plus the derived
 * `bs-<id>-*` height patches and clearing. A terrain rebuild re-fits from this doc (`bridge-place --refit`); nothing
 * is a hand-placed entity. The streamer emits `solved.pieces` as prefab instances in the cell each stands in.
 *
 * Kits: world-kit authoring/bridges (build.mts, plan.mjs, lookup.json). Contract the kits keep: every walked surface
 * is a smooth box collider (paving bevels and plank edges carry none), and a rope bridge's sway (when added) is
 * cosmetic only, never its colliders, so the server and every client walk the same deck.
 */

const slug = z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase slug");
const xz = z.tuple([z.number().finite(), z.number().finite()]);

export const BRIDGE_SPAN_KINDS = ["arch", "rope", "plinth"] as const;
export const BRIDGE_SPAN_STYLES = ["gnawspur", "coastal"] as const;

export const bridgeAnchorSchema = z
  .object({
    at: xz.describe("World [x, z] of this end: where the deck meets the land (a cliff-top edge, a stack top)."),
    y: z
      .union([z.number().finite(), z.literal("ground")])
      .default("ground")
      .describe("Deck height at this end (world Y), or \"ground\": the natural ground there. Arch decks are level (both ends within 2 m; the pads are levelled to the deck); a rope deck runs from one end's height to the other's."),
    seat: z
      .enum(["pad", "rock", "stage", "plinth"])
      .optional()
      .describe("This end's seating, overriding the span's `seat` (a span from a headland onto a DC stack top: pad on the land, rock on the stack; stage: a timber landing stage, docks / sea-level landings only; plinth: refused for rope ends)."),
  })
  .describe("One end of a span.");

export const bridgeSpanPieceSchema = z.object({
  prefab: z.string().describe("Bridge kit prefab id (world-kit assets/prefabs/bridges/)."),
  role: z.string().describe("Kit role: bay-deck, bay-channel, bay-tier, abut, pier-cap, pier-course-4, cutwater-cap, rope-bridge ..."),
  position: z.tuple([z.number(), z.number(), z.number()]).describe("World position of the piece origin (see the kit's frames in world-kit authoring/bridges/lookup.json)."),
  yaw: z.number().describe("Degrees about +Y."),
});

export const bridgeSpanPierSchema = z.object({
  position: z.tuple([z.number(), z.number(), z.number()]).describe("World [x, y, z]: the pier centre at its springing (top)."),
  ground: z.number().describe("Lowest solid ground under its footing (density surface), world Y."),
  water: z.number().nullable().describe("Water surface over it, or null when dry."),
  bottom: z.number().describe("Bottom of its stepped footing (world Y): below `ground` by the burial."),
  kind: z.enum(["full", "two-tier", "abutment", "post"]).describe("full: one stack to the top springing; two-tier: a lower stack under the lower arcade and an upper one standing on it; abutment: the course stack under an abutment; post: a rope bridge anchor post."),
});

export const bridgeSpanSolvedSchema = z.object({
  kind: z.enum(BRIDGE_SPAN_KINDS),
  style: z.enum(BRIDGE_SPAN_STYLES),
  heading: z.number().describe("Degrees about +Y that turn the kit's +X (along the span) onto A -> B."),
  origin: z.tuple([z.number(), z.number(), z.number()]).describe("World point s = 0 of the span frame (the measured face A for an arch, deck end A for a rope bridge)."),
  span: z.number().describe("Arch: abutment face to face (bays x bay width). Rope: deck end to deck end."),
  deckY: z.number().describe("Arch: the walked deck height. Rope: deck end A's height."),
  dy: z.number().default(0).describe("Rope: deck end B minus end A."),
  bay: z.number().optional().describe("Arch: bay width (m)."),
  bays: z.number().int().optional().describe("Arch: number of top-arcade bays."),
  tiers: z.number().int().optional().describe("Arch: 1, or 2 with a lower arcade (Pont du Gard)."),
  drops: z.tuple([z.number(), z.number()]).default([0, 0]).describe("Rope: metres each end's landing falls over its length, following a rock top that falls inland (0 = level)."),
  lowDrop: z.number().optional().describe("Rope: the deck's lowest point below end A (m)."),
  pieces: z.array(bridgeSpanPieceSchema).describe("Every kit piece, world placed. The streamer emits these; do not hand-edit."),
  piers: z.array(bridgeSpanPierSchema).default([]),
  profile: z
    .array(z.tuple([z.number(), z.number()]))
    .describe("The walked deck surface as [s, y] samples along the span frame (s from `origin`, y world): what the walk probe reads."),
  derived: z
    .object({ patches: z.array(z.string()), clearing: z.string().optional() })
    .describe("Ids of the features this fit wrote into `features.heightPatches` / `clearings`; a refit replaces exactly these."),
  ground: z.number().describe("Fingerprint of the ground the fit was solved on (mean natural height over the ends and the span); `bridge-place --check` reports STALE when it has changed."),
  plinth: z
    .object({
      prefab: z.string(),
      position: z.tuple([z.number(), z.number(), z.number()]).describe("World centre of the roof (the walked roof top)."),
      yaw: z.number(),
      half: z.number().describe("Half the outer side (m)."),
      base: z.number().describe("World Y of the floor inside (the highest rock under the footprint)."),
      height: z.number().describe("Roof over base (m)."),
      door: z.tuple([z.number(), z.number(), z.number()]).describe("World point just outside the doorway, on the ground."),
      stair: z.array(z.tuple([z.number(), z.number(), z.number()])).describe("World stair stations, door corner to the roof: what the walk probe follows."),
    })
    .optional()
    .describe("kind plinth: the solved tower."),
  stages: z
    .array(
      z.object({
        end: z.enum(["a", "b"]),
        prefab: z.string().describe("The landing stage's whole-piece id (bridges/stage-<hash>); `pieces` carry its segments."),
        origin: z.tuple([z.number(), z.number(), z.number()]).describe("World point of the stage frame: the rope deck end on the platform."),
        yaw: z.number().describe("Degrees about +Y of the stage frame (+X out over the gap)."),
        path: z.array(z.tuple([z.number(), z.number(), z.number()])).describe("World deck-top centreline of the walkway, platform back edge to the walkable ground: what the walk probe follows."),
        ground: z.tuple([z.number(), z.number(), z.number()]).describe("The walkable ground the walkway reaches."),
        feet: z.array(z.tuple([z.number(), z.number(), z.number()])).default([]).describe("World foot of every post / strut (the footing gate checks each is in rock or ground)."),
      }),
    )
    .default([])
    .describe("Timber landing stages at `seat: stage` ends."),
  warnings: z.array(z.string()).default([]),
});

export const bridgeSpanSchema = z
  .object({
    id: slug.describe("Stable id; its derived height patches and clearing are `bs-<id>*`."),
    owner: z.string().optional().describe("Who wrote it (a town, POI or zone id)."),
    kind: z
      .enum(BRIDGE_SPAN_KINDS)
      .default("arch")
      .describe("arch: stone arch bridge / aqueduct (bays 6-16 m, piers founded on the ground or seabed, up to ~70 m piers). rope: rope suspension bridge (12-130 m, no piers): sea stacks, chasms, anything too deep or wet for piers; STRAIGHT in plan between NATURAL TOPS, the height taken as SLOPE (end to end <= 30 deg, the deck <= 35 deg): Derek's standing rule, never stairs, stages, towers or plinths to meet a deck; steeper means a different anchor pair. plinth: reserved (the kit's stone landing plinth is a future POI part; bridge-place refuses it)."),
    style: z
      .enum(BRIDGE_SPAN_STYLES)
      .default("gnawspur")
      .describe("gnawspur: coursed rubble with dressed voussoir rings, string course, coping and paving (the Gnawspur aqueduct). coastal: dark lichened rubble, ragged voussoirs, weather-picked bosses. Rope bridges are always the Gnawbridge's lashed hull planks on tarred stringers (style ignored)."),
    a: bridgeAnchorSchema,
    b: bridgeAnchorSchema,
    toward: z
      .array(xz)
      .default([])
      .describe("plinth only: the far ends of the rope bridges landing on it (world [x, z]); the parapet opens toward each and the stair's roof hatch keeps clear of their landings."),
    channel: z.boolean().default(false).describe("arch only: a true aqueduct, a water channel along the deck beside a 2.2 m towpath."),
    tiers: z
      .union([z.literal("auto"), z.literal(1), z.literal(2)])
      .default("auto")
      .describe("arch only: 2 = a lower arcade under the top one (Pont du Gard). auto: 2 when a pier would be over 24 m tall."),
    bay: z
      .union([z.literal(6), z.literal(8), z.literal(10), z.literal(12), z.literal(14), z.literal(16)])
      .optional()
      .describe("arch only: force the bay width (m). Omitted = chosen from the gap and the pier heights (taller crossings get wider bays)."),
    maxPier: z.number().positive().default(70).describe("arch only: tallest pier (m, springing to footing) the fit may build."),
    maxWater: z.number().min(0).default(14).describe("arch only: deepest water (m) a pier may be founded in; a layout that needs a deeper pier fails over to another bay width or fails (use a rope bridge)."),
    sag: z.number().min(0.01).max(0.12).default(0.035).describe("rope only: the deck's sag at mid-span as a fraction of the span (3.5 % = 3.2 m on 90 m)."),
    width: z.number().min(1.2).max(3).default(1.8).describe("rope only: deck width (m)."),
    rails: z.boolean().default(true).describe("rope only: hidden rail colliders along the hand ropes (nobody steps off by accident)."),
    seat: z
      .enum(["pad", "rock", "stage", "plinth"])
      .default("pad")
      .describe("pad: level each end with a feathered height patch (the cliff top behind the face only). rock: no patch (an end on a DC cliff top or rock formation): a rope end slides to the rim and its deck eases level over it, the gate checks the rock seats it. stage (rope only): a timber landing stage off a steep lip, with a walkway / stair to walkable ground (world-kit bridges stage.mts)."),
    seed: z.string().optional(),
    tags: z.array(z.string()).default([]),
    solved: bridgeSpanSolvedSchema.optional().describe("Written by `worldgen bridge-place`; never hand-edit. Absent = not fitted yet (nothing is built)."),
  })
  .describe("A bridge across a gap: two anchors + kind + style; solved by `worldgen bridge-place` from the world-kit bridge kits.");

export type BridgeSpanDoc = z.infer<typeof bridgeSpanSchema>;
export type BridgeSpanSolved = z.infer<typeof bridgeSpanSolvedSchema>;

/** Derived-feature id prefix of a bridge span. */
export const bridgeSpanFeatureId = (id: string): string => `bs-${id}`;

/**
 * The fitted pieces of every bridge span whose origin stands in chunk cell (cx, cz), as collapsed prefab instances
 * (the static batcher merges them per material). Unfitted spans emit nothing.
 */
export function bridgeSpanEntities(
  spans: readonly BridgeSpanDoc[] | undefined,
  cellSize: number,
  cx: number,
  cz: number,
  entities: ChunkDoc["entities"],
  assetExists?: (assetId: string, kind: "prefab" | "model") => boolean,
): void {
  if (!spans?.length) return;
  const x0 = cx * cellSize, z0 = cz * cellSize;
  for (const b of spans) {
    const pieces = b.solved?.pieces;
    if (!pieces) continue;
    pieces.forEach((p, i) => {
      const [x, y, z] = p.position;
      if (Math.floor(x / cellSize) !== cx || Math.floor(z / cellSize) !== cz) return;
      if (assetExists && !assetExists(p.prefab, "prefab")) return;
      const half = (p.yaw * Math.PI) / 360;
      entities[`bs_${b.id}_${i}`] = {
        name: `${b.id} ${p.role}`,
        parent: null,
        tags: ["bridge-span", b.id],
        components: {
          transform: { position: [x - x0, y, z - z0], rotation: [0, Math.sin(half), 0, Math.cos(half)] },
          prefab: { prefabId: p.prefab, props: {}, overrides: [] },
        },
      };
    });
  }
}

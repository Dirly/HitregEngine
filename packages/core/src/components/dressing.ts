import { z } from "zod";
import type { ComponentRegistry } from "./registry.js";

/**
 * How a prop may be placed, declared ONCE on the prop itself.
 *
 * A prop's prefab root carries this component from the moment it is
 * catalogued. Everything that dresses a room, a street or a POI reads it, so
 * no brief, agent or world has to restate that paper lies on a surface, that a
 * drawer belongs in its dresser, or that a shelf offers three boards to put
 * things on. A dressing plan never writes a raw transform: it names a prop and
 * where it goes (a floor point, a wall, a ceiling point, a socket on another
 * item) and `resolveDressing` (../dressing/resolve.ts) computes the transform
 * and refuses a placement the prop's own declaration does not allow.
 *
 * Authoring-time metadata, like `placement`: nothing reads it at runtime.
 *
 * Zod-only module (like placement.ts/physics.ts) so registerCoreComponents can
 * import it without pulling in the resolver.
 */

export const DRESSING_MOUNTS = ["floor", "wall", "ceiling", "surface", "slot", "part"] as const;
export type DressingMount = (typeof DRESSING_MOUNTS)[number];
/** What a prop is FOR, as a designer choosing furniture thinks of it (the menu prints it). */
export const DRESSING_USES = ["seat", "table", "bed", "storage", "shelf", "light", "work", "decor"] as const;
export type DressingUse = (typeof DRESSING_USES)[number];

/**
 * The scale classes and cultures a prop or a place may declare. DATA, not a schema enum: a project extends it with
 * `authoring/dressing/vocabulary.json` ({ scales: [...], cultures: [...] }, merged over this by id) as new peoples get
 * their own props, and the tools pass the merged table to the resolver (`DressingResolveInput.vocabulary`).
 *
 * A place of scale S accepts props whose scale is S, `any`, or one S lists in `accepts`. A place of cultures C accepts
 * props whose cultures include `any` or share one with C (or with what a culture of C lists in `accepts`).
 */
export interface DressingScaleClass {
  id: string;
  /** Typical standing height of the people it is made for, metres (what the backfill inferred the class from). */
  height: number;
  /** Other scale classes a place of this scale also takes (beyond its own and `any`). */
  accepts?: string[];
  note: string;
}
export interface DressingCulture {
  id: string;
  /** Other cultures whose things a place of this culture also takes (a bandit camp uses rural goods it stole). */
  accepts?: string[];
  note: string;
}
export interface DressingVocabulary {
  scales: DressingScaleClass[];
  cultures: DressingCulture[];
}
export const DRESSING_VOCABULARY: DressingVocabulary = {
  scales: [
    { id: "any", height: 0, note: "Reads right at every scale: rocks, bones, skulls, plain fire pits, rubble, hides on the ground, ice." },
    { id: "tiny", height: 0.6, note: "Made for very small folk (sprites, the smallest kin): a cupboard you could hold." },
    { id: "small", height: 1.2, note: "Made for small folk (ratkin, goblins, frogkin): low stools, short shelves, cramped beds." },
    { id: "human", height: 1.8, note: "Made for people about 1.8 m tall: a 0.45 m seat, a 0.75 m table, a 2 m wardrobe, hand lanterns, grinding stones." },
    { id: "large", height: 2.8, note: "Made for large folk (ogres, trolls, crocodile-kin, dragonkin): a 0.7 m seat, a 1.2 m table." },
    { id: "giant", height: 4.5, note: "Made for giants 4-5 m tall: log benches, hide beds, whole-trunk racks, hall bonfires." },
  ],
  cultures: [
    { id: "any", note: "Shared by every people: rocks, bones, plain fires, logs, rubble, carcasses." },
    { id: "civic", note: "Town folk: made and bought goods (chairs, lanterns, shop counters, signs, bookshelves).", accepts: ["rural"] },
    { id: "rural", note: "Farms, hamlets and human camps: sacks, barrels, carts, haystacks, tools." },
    { id: "noble", note: "Wealthy houses and keeps: fine furniture, banners, tapestries.", accepts: ["civic"] },
    { id: "sacred", note: "Temples and shrines of the human faiths: altars, pews, candle stands." },
    { id: "bandit", note: "Outlaws and raiders: stolen goods, crude camp gear, palisades, cages.", accepts: ["rural"] },
    { id: "crypt", note: "The dead and their keepers: coffins, urns, bone niches, sarcophagi, grave goods." },
    { id: "wild", note: "Nothing made: nests, carcasses, fungus, unworked rock and wood. Beasts' lairs." },
    { id: "giant", note: "Hill and frost giants: whole trunks, hides, bone, fire; nothing small or fine." },
    { id: "ratkin", note: "Rat-folk: scavenged junk, gnawed timber, sacks, rope, crude cages." },
    { id: "frogkin", note: "Frog-folk of the marshes: reed, woven baskets, gourds, mud and shell." },
    { id: "anansi", note: "Spider-folk: silk, egg clutches, wrapped prey, webbed bone." },
    { id: "crocodile-kin", note: "Crocodile-folk: river stone, bone, hide, heavy wet timber." },
    { id: "dragonkin", note: "Dragon-folk: forged metal, scaled hide, hoard goods, fire stone." },
    { id: "goblin", note: "Goblins: scrap metal, spikes, crude tents and traps." },
    { id: "dwarf", note: "Dwarves: dressed stone, forges, iron-bound timber, carts and rails." },
  ],
};
/** The vocabulary merged with a project's additions (by id; an added entry replaces the built-in one). */
export function mergeVocabulary(extra?: Partial<DressingVocabulary>): DressingVocabulary {
  const by = <T extends { id: string }>(a: T[], b: T[] = []): T[] => [...new Map([...a, ...b].map((x) => [x.id, x] as const)).values()];
  return { scales: by(DRESSING_VOCABULARY.scales, extra?.scales), cultures: by(DRESSING_VOCABULARY.cultures, extra?.cultures) };
}
/** Does a place of `place` scale take a prop of `prop` scale? */
export function scaleFits(vocab: DressingVocabulary, place: string, prop: string): boolean {
  if (prop === "any" || prop === place) return true;
  return !!vocab.scales.find((s) => s.id === place)?.accepts?.includes(prop);
}
/** Does a place of these cultures take a prop of those? Empty place cultures = no rule. */
export function cultureFits(vocab: DressingVocabulary, place: string[], prop: string[]): boolean {
  if (!place.length || prop.includes("any")) return true;
  const ok = new Set(place.flatMap((c) => [c, ...(vocab.cultures.find((x) => x.id === c)?.accepts ?? [])]));
  return prop.some((c) => ok.has(c));
}

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

/** A place ON this prop where another prop may go. */
export const dressingSocketSchema = z.object({
  id: z.string().min(1).describe("Unique on this prop. A dressing plan names it: `{ kind: \"on\", item, socket }`."),
  kind: z
    .enum(["surface", "slot", "hang"])
    .describe(
      "`surface`: a flat rectangle things rest on (a table top, one board of a shelf); several small items may share it. " +
        "`slot`: a fitted cavity that takes exactly the props whose `slotKind` it `accepts` (a drawer bay, a bottle rack, a scabbard hook), " +
        "the item's origin lands on `position`. `hang`: a point something hangs FROM (a hook, a peg), the item's top lands on `position`.",
    ),
  position: vec3.describe(
    "Prop-local metres (prop front = +Z, up = +Y). surface: the CENTRE of the rectangle, at the surface's height. slot/hang: the exact point.",
  ),
  size: z
    .tuple([z.number().min(0), z.number().min(0)])
    .default([0, 0])
    .describe("surface only: usable rectangle, local X by local Z, in metres. Items are kept wholly inside it."),
  clearHeight: z
    .number()
    .positive()
    .default(10)
    .describe("Tallest item that fits, in metres: the gap to the board above on a shelf. The default means open above."),
  yaw: z.number().default(0).describe("Degrees added to the host's facing for items placed here. 0 = items face the way the prop faces."),
  accepts: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "slot: the `slotKind`s that fit (required, a slot that accepts nothing is useless). surface/hang: if non-empty, only items whose `fits` " +
        "shares a tag are allowed (a book shelf accepting [\"book\", \"scroll\"]); empty = any surface item that physically fits.",
    ),
  capacity: z.number().int().positive().default(1).describe("Most items this socket holds. A slot or hang is normally 1; a table top may take 6."),
});
export type DressingSocket = z.infer<typeof dressingSocketSchema>;

export const dressingSchema = z
  .object({
    mount: z
      .enum(DRESSING_MOUNTS)
      .describe(
        "The ONE way this prop is placed. `floor`: stands on a floor (see `against`). `wall`: hung on a wall face, its back (local -Z) flush to the " +
          "wall, at a height inside `wallHeight`. `ceiling`: hangs from the ceiling, optionally on a chain. `surface`: rests on a `surface` or " +
          "`hang` socket of another item and NOWHERE else (papers, books, mugs, candles): the floor is never a fallback. `slot`: goes only into a " +
          "`slot` socket that accepts its `slotKind` (a loose drawer, a bottle for a rack). `part`: a piece of another prefab that is never placed " +
          "on its own; a plan naming it is refused. A prop that can go two ways (a paper lying flat, the same paper pinned to a wall) is TWO " +
          "prefabs, each declaring one mount, because the mesh pose differs.",
      ),
    size: vec3.describe(
      "Bounds in metres [width X, height Y, depth Z] with the front facing +Z, as the prop stands when placed. Measured from the model at intake, never guessed.",
    ),
    origin: z
      .enum(["foot", "back", "top"])
      .optional()
      .describe(
        "Where the prefab's origin sits on those bounds. `foot`: centre of the bottom face (floor, surface, slot, part props). `back`: centre of the " +
          "back face (wall props). `top`: centre of the top face (ceiling props and anything hung from a `hang` socket). Omitted = the mount's own " +
          "default (wall -> back, ceiling -> top, everything else -> foot). Intake fixes the pivot so this is true.",
      ),
    against: z
      .enum(["free", "wall", "either"])
      .default("either")
      .describe(
        "floor only. `wall`: its back must stand against a wall (wardrobe, shelf, bed head); placing it in open floor is refused. `free`: stands in " +
          "the open (a table, a brazier). `either`: both are fine (a barrel, a crate).",
      ),
    wallHeight: z
      .tuple([z.number().min(0), z.number().min(0)])
      .default([1.2, 1.8])
      .describe("wall only: allowed height of the prop's BOTTOM edge above the floor, [min, max] metres. A plan's height outside it is refused."),
    chain: z
      .string()
      .default("")
      .describe(
        "ceiling only: prefab id of a ONE-METRE chain/rope link. Set = the prop hangs at the plan's drop and links are repeated (the last one scaled) " +
          "from its top up to the ceiling. Empty = it mounts flush under the ceiling.",
      ),
    slotKind: z.string().default("").describe("slot only (required there): the cavity it fits, matched against a socket's `accepts`, e.g. \"drawer\"."),
    fits: z
      .array(z.string().min(1))
      .default([])
      .describe("surface/slot props: tags matched against a socket's `accepts` (\"paper\", \"book\", \"tableware\", \"candle\"). Empty = generic small item."),
    clearance: z
      .number()
      .min(0)
      .default(0)
      .describe(
        "floor/wall: metres of walkable floor that must stay free in FRONT of the prop across its width (a wardrobe's doors, a counter's customer side, " +
          "a bed's side). Other solid items may not stand there.",
      ),
    solid: z
      .boolean()
      .default(true)
      .describe("floor only: false for walk-over floor coverings (rugs). A non-solid prop blocks nothing and furniture may stand on it."),
    fire: z.boolean().default(false).describe("A real flame (VFX + light). Counted against the per-floor flame budget when a plan is resolved."),
    setting: z
      .enum(["indoor", "outdoor", "both"])
      .default("both")
      .describe("Where it may be used. An `outdoor` prop inside a building (a gravestone, a market stall) is refused, and the reverse."),
    category: z.string().default("").describe("Coarse family for the catalogue menu: furniture, storage, bedding, light, tableware, document, tool, decor, trade, sacred, street."),
    use: z
      .array(z.enum(DRESSING_USES))
      .default([])
      .describe(
        "What it is for, as the room-aware menu prints it: seat (sat on), table (a top to eat, work or put things on), bed, storage (holds goods), " +
          "shelf (boards to display things on), light, work (a trade's working piece: anvil, furnace), decor. Several may apply (a cabinet is storage " +
          "and a bedside table). Judged from what the thing IS, not its name: a low round 'stool' with a top is a table.",
      ),
    rooms: z
      .array(z.string().min(1))
      .default([])
      .describe(
        "Room roles it belongs in, from the dressing vocabulary (bedroom, kitchen, hall, tavern, shop, workshop, storage, office, chapel, cellar, " +
          "street, plaza, quay, yard, camp, ruin, dungeon). Empty = anywhere. Used by the menu query and warned on mismatch, never a hard refusal.",
      ),
    themes: z.array(z.string().min(1)).default([]).describe("Cultures/sets it belongs to (\"coastal\", \"norse\", \"ratkin\"). Empty = neutral, usable in every theme."),
    wealth: z
      .array(z.enum(["destitute", "poor", "comfortable", "wealthy", "noble"]))
      .default([])
      .describe("Wealth tiers of the household or business that would own it. Empty = any."),
    provides: z.array(dressingSocketSchema).default([]).describe("Sockets other props may be placed on. A table provides its top; a shelf, one surface per board."),
    anchorKinds: z
      .array(z.string().min(1))
      .default([])
      .describe(
        "Socket-map anchor kinds this prop FILLS (\"hearth\", \"forge\", \"sconce\", \"lantern\"). Non-empty = a flame-and-light fixture with no " +
          "mesh of its own, made to sit in a building's own hearth, sconce or lantern: it is placed ONLY with an `anchor` place on an anchor " +
          "of one of these kinds, never on a bare wall, floor or surface, and it is left out of the furniture menu (`dress fixtures` places it). " +
          "Empty = an ordinary prop (lit furniture such as candles, a lamp or a chandelier carries its own mesh and stays ordinary).",
      ),
    scale: z
      .string()
      .min(1)
      .optional()
      .describe(
        "SCALE CLASS: who it is sized for, judged from the model beside a figure (`props proof`), never from its name. One id of the dressing " +
          "vocabulary (DRESSING_VOCABULARY + the project's authoring/dressing/vocabulary.json): `any` (rocks, bones, skulls, plain fire pits: right at " +
          "every scale), `tiny`, `small` (ratkin, goblins, frogkin), `human` (~1.8 m folk: a 0.45 m seat, hand lanterns, grinding stones), `large` " +
          "(ogres, trolls, crocodile-kin, dragonkin), `giant` (4-5 m giants: log benches, hide beds). A place declaring its scale (plan `space.scale`, " +
          "or a room's `scale`) refuses a prop of another class (`wrong-scale`), and `props menu --scale` offers only matching and `any` props. " +
          "Omitted = undeclared: warned wherever a place declares its scale.",
      ),
    cultures: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "CULTURE/use tags: the peoples who would make, own or use it, from the dressing vocabulary: `any` (shared by everyone), civic (town folk), " +
          "rural, noble, sacred, bandit, crypt, wild (nothing made: nests, carcasses), giant, ratkin, frogkin, anansi, crocodile-kin, dragonkin, " +
          "goblin, dwarf (projects add more). A place declaring cultures (plan `space.cultures`, or a room's) refuses a prop sharing none of them and " +
          "not tagged `any` (`wrong-culture`): giants do not hang lanterns. Distinct from `themes` (a visual style set). Omitted = undeclared: warned " +
          "where a place declares cultures.",
      ),
    centrepiece: z
      .boolean()
      .optional()
      .describe(
        "A SET PIECE that belongs in the middle of a room (a hall bonfire, an altar, a throne, a well, a great table): exempt from the keep-clear " +
          "centre of a room that keeps its middle clear (every dungeon room). Everything else fills walls and corners first. A plan may also mark " +
          "one item `setPiece`. Omitted = false.",
      ),
    loose: z
      .boolean()
      .optional()
      .describe(
        "floor only: a loose container standing on the floor (a sack, crate, basket, barrel, box). Loose things count against a room's small " +
          "floor-clutter budget; past it they go on shelves, in a storage room, or are left out. Omitted = derived: a solid floor prop of " +
          "category storage or trade that does not stand against a wall (shelves, wardrobes and cabinets are furniture, not clutter).",
      ),
  })
  .superRefine((d, ctx) => {
    const ids = new Set<string>();
    d.provides.forEach((socket, index) => {
      if (ids.has(socket.id)) ctx.addIssue({ code: "custom", path: ["provides", index, "id"], message: `duplicate socket id "${socket.id}"` });
      ids.add(socket.id);
      if (socket.kind === "slot" && socket.accepts.length === 0)
        ctx.addIssue({ code: "custom", path: ["provides", index, "accepts"], message: "a slot socket must list the slotKinds it accepts" });
      if (socket.kind === "surface" && (socket.size[0] <= 0 || socket.size[1] <= 0))
        ctx.addIssue({ code: "custom", path: ["provides", index, "size"], message: "a surface socket needs a size" });
    });
    if (d.mount === "slot" && d.slotKind === "") ctx.addIssue({ code: "custom", path: ["slotKind"], message: "a slot-mounted prop must name its slotKind" });
    if (d.mount !== "slot" && d.slotKind !== "") ctx.addIssue({ code: "custom", path: ["slotKind"], message: "slotKind is only for mount \"slot\"" });
    if (d.wallHeight[0] > d.wallHeight[1]) ctx.addIssue({ code: "custom", path: ["wallHeight"], message: "wallHeight is [min, max]" });
    if (d.anchorKinds.length && (d.mount === "surface" || d.mount === "slot" || d.mount === "part"))
      ctx.addIssue({ code: "custom", path: ["anchorKinds"], message: "an anchor-only fixture mounts floor, wall or ceiling (the anchor's mount)" });
    if (d.size.some((v) => v <= 0)) ctx.addIssue({ code: "custom", path: ["size"], message: "size must be positive in every axis" });
  })
  .describe(
    "Prop placement declaration, on a prop prefab's ROOT entity. Declared once at intake (docs/prop-cataloging.md); dressing plans are resolved against it.",
  );

export type DressingData = z.infer<typeof dressingSchema>;
export type DressingInput = z.input<typeof dressingSchema>;

/** The origin a prop has when `origin` is omitted. */
export function dressingOrigin(d: Pick<DressingData, "mount" | "origin">): "foot" | "back" | "top" {
  return d.origin ?? (d.mount === "wall" ? "back" : d.mount === "ceiling" ? "top" : "foot");
}

/** A loose floor container (sack, crate, barrel, box): counted against a room's floor-clutter budget. */
export function isLooseClutter(d: Pick<DressingData, "mount" | "solid" | "category" | "against" | "loose">): boolean {
  if (d.mount !== "floor" || !d.solid) return false;
  return d.loose ?? ((d.category === "storage" || d.category === "trade") && d.against !== "wall");
}

/** Register the `dressing` component (called from registerCoreComponents). */
export function registerDressingComponent(registry: ComponentRegistry): void {
  registry.register("dressing", dressingSchema);
}

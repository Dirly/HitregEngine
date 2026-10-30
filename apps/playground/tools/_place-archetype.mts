/**
 * PLACE ARCHETYPES — the data and the pure planner behind tools/place-build.mts (docs/place-builder.md).
 *
 * An archetype is a SMALL recipe for an outdoor place (owner ruling 2026-10-19: KISS, WoW Classic / EverQuest geometry):
 * a core pocket with the landmark, a few more pockets round it, each a levelled pad with 0-3 catalogued structures,
 * a dressing area (props BY NAME, never transforms), a creature clearing; footpaths join them to the core and the core
 * to the approach. Files: projects/world-kit/authoring/place-archetypes/<id>.json, validated by `placeArchetypeSchema`.
 *
 * Lessons are DEFAULTS here (each marked `L:`), never prose an agent must remember; the gates are in place-build.mts.
 */
import { z } from "zod";
import { facesDir } from "./_compass.mts";
import { fitRibbon, pathParamsSchema, regionVegetationSchema } from "@hitreg/core";
import { densityNeed, heightForPx, leanQuat, orientBase, POCKET_FLOOR_M, READ_PX_MIN, readPixels, SEAT_GAP_M, scaleBase, seatStructure, SINK_MAX_M, SKIRT_BURY_M, toWorldYaw, wearsCliffTile, type BaseOutline } from "./_place-quality.mts";
/** Skirt wall thickness (m): its outer face stands ~0.15 m past the structure's base edge (a plinth). */
export const SKIRT_THICK_M = 0.8;

const xz = z.tuple([z.number().finite(), z.number().finite()]);
const FEATURE_KINDS = ["landmark", "water", "cave", "interior", "camp", "ruin", "structure", "grove", "shore", "lookout", "lair", "other"] as const;
/** L: fire is only ever the standing `vfx` fire through these catalogued prefabs (owner ruling 2026-10-11). */
export const FIRE_PREFABS = [
  "poi-props/brazier", "poi-props/standing-torch", "poi-props/campfire", "camp-props/bonfire", "fixtures/sconce-fire", "fixtures/looks/torch-flame",
  "giant-camp/giant-fire", "giant-camp/giant-bonfire-pit", "giant-camp/landmark-pyre", "giant-camp/beacon-fire", "composite-props/bonfire-logs", "town-lights/lamp-post-lit",
];
/** L (place, coffin-road 2026-10-20): a place burns at dusk when it holds any catalogued fire (FIRE_PREFABS: the
 *  landmark pyre did not match the old name test) or a prop named for a flame (torch, brazier, lamp, lantern, fire). */
/** L (bar-watch 2026-10-21): a COLD piece (composite-props/cold-brazier, "-unlit") is named for a flame but burns nothing. */
export const burnsAtDusk = (prefabs: string[]) => prefabs.some((id) => FIRE_PREFABS.includes(id) || (/fire|torch|brazier|lamp|lantern|pyre/.test(id) && !/\bcold-|-unlit\b|\bunlit-/.test(id)));
/** L (zfight, sheer-crofts 2026-10-20): the place is charged only for z-fighting the live world (same --near, place not
 *  installed) does not already have: the ocean coplanar with sea-level terrain 260 m off the crofts failed the gate. The
 *  failing clusters (area >= failClusterArea) of the lab report whose mesh pair, materials and centre (within 1 m) are
 *  not in the live report; mesh names are compared with the lab world's name read as the live one. */
export function newZfightClusters(labRep: any, liveRep: any, labWorld: string, world: string): any[] {
  const norm = (m: string) => String(m).split(labWorld).join(world), min = labRep?.thresholds?.failClusterArea ?? 0.05;
  const pair = (c: any) => [`${norm(c.a.mesh)}|${c.a.material}`, `${norm(c.b.mesh)}|${c.b.material}`].sort().join(" vs ");
  const had = (liveRep?.clusters ?? []) as any[];
  return ((labRep?.clusters ?? []) as any[]).filter((c) => c.area >= min && !had.some((h) => pair(h) === pair(c) && Math.hypot(h.centre[0] - c.centre[0], h.centre[1] - c.centre[1], h.centre[2] - c.centre[2]) <= 1));
}
/** Landmarks whose read top is a smoke column, not the prop. The smoke standard (core vfx/smoke.ts, Derek 2026-10-22:
 *  "smoke is far too big") caps a pyre's column at ~3x the fire: foundation vfx env/smoke-column now tops out ~8.5 m
 *  (it was ~60 m and read as a smear larger than the castle). A place reads by its structure, never by its smoke. */
export const SMOKE_READ_M: Record<string, number> = {
  "giant-camp/landmark-pyre": 8,
  // L (TOOLS-PB 2026-10-23): every fire prop with a fire vfx (foundation vfx env/fire-*), at an honest column: these carry
  // no smoke column, so the read top is the flame over the ground (bonfire: a ~3.5 m log pile and its licks; a campfire or
  // a brazier: a knee-high flame). Their flames cull at 60-120 m: they never carry a 300 m read on their own.
  "camp-props/bonfire": 4, "poi-props/campfire": 1.2, "poi-props/brazier": 1.4,
};
/** Metres from a pocket's centre to its two default close views (`<pocket>-close`, `<pocket>-close-side`), eye 1.7 m. */
export const CLOSE_VIEW_M = 8;
/** Composites and hero parts that are not offered by `props menu` but may be placed whole as a STRUCTURE. */
const HULL_RE = /\bhull|wreck-(hull|side|wall)/i;

/** LEAN (KNUCKLECROWN 2026-10-29: the review RETURNED nine finger-pillars standing upright: a layout piece had yaw only, no
 *  tilt, so a concept leaning each WHOLE pillar 15-25 deg from the foot could not be said). */
export const LEAN_MAX_DEG = 30;
export const leanSchema = z.object({
  deg: z.number().min(0).max(LEAN_MAX_DEG).describe("Degrees the WHOLE piece tips from the vertical at its foot (a menhir 10-15 deg toward a pool)."),
  toward: xz.optional().describe("Place-frame x,z the top leans toward (the pool centre [0,0] of a ring). One of `toward` / `dir`."),
  dir: z.number().optional().describe("Direction of the lean in degrees about +Y in the place frame (0: toward the approach, +z), when there is no point (the Thumb bent toward the falls). One of `toward` / `dir`."),
}).strict().refine((l) => (l.toward === undefined) !== (l.dir === undefined), { message: "lean names exactly one of toward / dir" })
  .describe("Tilt of the whole piece (a rotation about a horizontal axis after its yaw). A leaned piece is SUNK to the lowest ground under its turned base outline: its raised uphill edge meets the ground, the downhill edge is buried; the seated gate measures the turned outline.");
const landmarkSchema = z.object({
  fogReach: z.number().min(100).max(1500).default(450).describe("Metres the landmark reads through the zone fog (`landmark` component / wall operator `fog`)."),
  silhouette: z.number().min(0).max(1).default(0.6).describe("How dark it stands against the fog."),
  height: z.number().min(1).max(60).describe("Top of the landmark above its foot, metres — the approach-read check's target."),
}).strict();

export const placeStructureSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/).describe("Slot id, unique in the pocket (`--set <pocket>.<slot>=<prefab>` swaps the prefab)."),
  role: z.enum(["landmark", "dwelling", "work", "fire", "set-piece", "boat"]).describe("What it is for. `fire` must be a catalogued vfx fire (FIRE_PREFABS); `boat` lies on the ground as a boat (never a wall); `dwelling` gets its ground cover cleared."),
  prefab: z.string().describe("Catalogued prefab id (world-kit / foundation / the world's project). Never a primitive: the tool refuses an id it cannot find."),
  overrides: z.array(z.object({ path: z.string().min(1), value: z.unknown() }).strict()).max(8).default([]).describe("Prefab-instance overrides on the placed piece (the engine prefab `overrides`: `<local entity>/components/<component>/<field>`; a nested instance is reached through its `<entity>/components/prefab/overrides` array). For a per-place tweak of a catalogued piece that is not a new prop: a camp fire whose light burns at night only. L (o-small2 dropped-hour 2026-10-30)."),
  choices: z.array(z.string()).default([]).describe("Other catalogued prefabs this slot accepts (`--set` may pick one of them, or any catalogued id)."),
  at: xz.default([0, 0]).describe("Metres from the pocket centre in the place frame (+z = toward the approach, +x = its right)."),
  yaw: z.number().default(0).describe("Degrees about +Y in the place frame (0: the prefab's +Z front faces the approach)."),
  footprint: z.number().min(0.5).max(20).default(2.5).describe("Radius of what it stands on, metres: its pad, its cover clearing and the dressers' keep-out."),
  lift: z.number().min(0).max(2).default(0).describe("Metres above its seat (layout pieces: `lift`)."),
  scale: z.number().min(0.5).max(3).default(1).describe("Uniform scale of the placed piece (a silhouette element taller than its catalogue size). L (PLACES-FIX 2026-10-22): never past its texel floor: the plan refuses a scale that takes the piece under MIN_SCALED_TEXELS tx/m (its catalogue texel density / scale)."),
  landmark: landmarkSchema.nullable().default(null).describe("Present on the ONE landmark (a structure or a wall; L: every place reads from its approaches)."),
  on: z.string().regex(/^[a-z0-9-]+$/).optional().describe("Id of an earlier structure of the pocket (a crag, a rock): the piece stands on that piece's own mesh top at its spot (a cairn on a crag top), never on the ground."),
  stone: z.string().optional().describe("A stone piece of a BUILT structure (a weighting stone in a basin): the material it draws with instead of the zone's rock skin (a material id, or `@wall:<id>` = that wall's face stone); written as the entity tag `stone:<material>`, read by rock-skins. Set by the planner on a basin's rock-kit contents."),
  lean: leanSchema.optional(),
  onWall: z.string().regex(/^[a-z0-9-]+$/).optional().describe("Id of a level-topped built wall (kind tower / keep / gatehouse) in the same pocket: the piece stands on its wall walk (the coping top), not on the ground, and is not seated. `at` must lie on the wall line (a tower's ring: [0, size] = its front). L (LANDMARKS 2026-10-21): a wizard's tower is read at dusk by the fire ON its top."),
}).strict();

/** BUILT structure kinds made by the wall operator (LANDMARKS 2026-10-21, Derek: "castles, wizard towers ... something big
 *  and apparent that breaks up the landscape"): KISS classic-MMO masonry, every face incl. coping, parapet and merlon tops
 *  on the wall mesher's planar 40 tx/m UVs. `wall` is the plain dyke / yard wall (<= 12 m). */
export const WALL_KINDS = ["wall", "curtain", "tower", "keep", "gatehouse"] as const;
/** Crenellated parapet of the built kinds: merlons both sides, a top SEEN not walked (no stair reaches it: the bake declares no walk-mid reach target). */
/** The night light hung in a tower window (camp light bucket): a warm point, its halo seen from afar. */
export const WINDOW_LIGHT = "giant-camp/window-glow";
/** The openings a body walks through: gates and doors, never a raised window (sill > 0). */
export const walkGaps = <T extends { sill?: number }>(o: T[] | undefined): T[] => (o ?? []).filter((x) => !(x.sill! > 0));
/** A tower's windows as wall-operator openings (sill > 0): on face centres counted round from the door's station. */
export function towerWindows(wl: { kind: string; sides: number; size: number; gate: number; windows?: { face: number; sill: number; height: number; width: number; light: string }[] }, pts: V2[], gf: number | null): { name: string; at: number; width: number; height: number; sill: number; arch: boolean; light: string }[] {
  if (wl.kind !== "tower" || !wl.windows?.length) return [];
  let P = 0; for (let i = 1; i < pts.length; i++) P += dist(pts[i - 1]!, pts[i]!);
  const faceLen = P / towerSides(wl), g0 = gf ?? faceLen / 2;
  return wl.windows.map((w, i) => ({ name: `window-${i + 1}`, at: r2((((g0 + w.face * faceLen) % P) + P) % P), width: w.width, height: Math.max(w.height, w.sill + 0.6), sill: w.sill, arch: true, light: w.light }));
}
export const CRENEL_PARAPET = { height: 1.1, thickness: 0.45, side: "both", crenels: { merlon: 1.4, gap: 0.8, height: 0.7 }, walked: false } as const;
/** Height a built wall's top shows over its `height` (coping 0.3 + a crenellated parapet and merlons). */
export const wallTopExtra = (w: { kind: string; top?: string }) => 0.3 + (w.kind !== "wall" && (w.top ?? "crenel") === "crenel" ? CRENEL_PARAPET.height + CRENEL_PARAPET.crenels.height : 0);
/** Pieces SET on a basin's bed or a worked floor (structures of the pocket at fixed spots, `on` = stacked on an earlier one). */
const contentsSchema = z.array(z.object({
  prefab: z.string().describe("Catalogued prefab (a weighted sheaf, a weighting stone, a beating board, a heap)."),
  at: xz.default([0, 0]).describe("Metres from the basin's / floor's centre in the pocket frame."),
  yaw: z.number().default(0).describe("Degrees about +Y in the place frame."),
  on: z.number().int().min(0).optional().describe("Index of an EARLIER content this one rests on (a stone on a sheaf, a sheaf on a sheaf): it stands on that piece's mesh top."),
  kerb: z.boolean().optional().describe("Basins only: the piece lies ON the kerb top (straw tangles, a heap dropped on the coping); `at` must lie on the kerb line. L (RETTING 2026-10-23): full pits have straw on their kerbs."),
}).strict()).max(24).default([]);
export const placeWallSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  kind: z.enum(WALL_KINDS).default("wall").describe("wall: a dyke / yard wall (<= 12 m, follows the ground). curtain: a castle curtain (follows the ground, crenellated walk, buttresses; a gatehouse standing on its line cuts it: the gate is the gatehouse). tower: a round tower (shape ring, a mitred polygon of `sides`, level top, crenellated walk, an arched door when `gate` > 0). keep: a square or oblong keep (shape square, level top, crenellated, an arched door = `gate`). gatehouse: a square gate tower with an arched passage through its front AND back (on a curtain's line). Built kinds have no footing step (the body runs into the ground: a footing crossing another wall's met it coplanar) and stand level on the pocket's ground."),
  sides: z.number().int().min(8).max(24).refine((v) => v % 4 === 0, "a multiple of 4 (the door sits on the front vertex row)").default(12).describe("tower: the ring's polygon sides."),
  top: z.enum(["crenel", "plain"]).optional().describe("Built kinds: `crenel` (default) = a crenellated walk; `plain` = coping only (a ruined stump, an engine house)."),
  portal: z.object({
    scene: z.string().default("").describe("Destination scene id; empty = a SEALED door (the portal refuses with `refusal`: the dungeon behind it is a later round)."),
    anchor: z.string().default(""),
    name: z.string().describe("What the prompt names (the Raven Keep)."),
    refusal: z.string().default("The way is shut."),
  }).strict().optional()
    .describe("Built kinds with a door (tower, keep, gatehouse): a walk-through `portal` (trigger mode) filling the door, veiled by tools/portal-veil.mts. L (LANDMARKS 2026-10-21): a landmark's dungeon door is its keep's gate, sealed until the interior is built, never a hole."),
  windows: z.array(z.object({
    face: z.number().int().min(1).max(23).describe("Faces round the ring from the door's face (1 = the next face in the ring's point order, the door's face + half the faces = the back; counted on the built ring, whose sides towerSides may lower so the door fits a face)."),
    sill: z.number().min(1).max(36).describe("Sill height above the ground, metres."),
    height: z.number().min(1.6).max(38).describe("Head height above the ground (the arch crown), metres; at least sill + 0.6."),
    width: z.number().min(0.8).max(3).default(0.8).describe("Clear width (0.8 = an arrow slit)."),
    light: z.string().default(WINDOW_LIGHT).describe("Catalogued light prefab hung in the opening (warm by night: the window reads from afar); empty = dark."),
  }).strict()).max(8).default([])
    .describe("tower only: raised windows / arrow slits through the ring (the wall body runs on under each sill), each with a night light in it. L (LANDMARKS 2026-10-22, coordinator: a tower at dusk was a black block from 300 m): a landmark tower reads at night by its lit windows and its beacon top."),
  gateHeight: z.number().min(2.2).max(30).optional().describe("Built kinds: the arched gate / door's clear height at the crown (default max(3.5, 1.5 x gate), at most height - 1.5)."),
  shape: z.enum(["ring", "square", "line"]).describe("ring/square: closed round the pocket centre (`size` = radius / half-side); line: `points` in the pocket frame."),
  at: xz.default([0, 0]).describe("Centre of a ring/square (and origin of a line's points), metres in the pocket frame."),
  size: z.number().min(1.5).max(60).default(12).describe("ring: radius; square: half-width (x)."),
  depth: z.number().min(1).max(60).optional().describe("square only: half-depth (z) for an oblong shell; omitted = `size` (a true square)."),
  gateSide: z.enum(["front", "back"]).default("front").describe("ring/square: the side the gate opens on (front = +z, toward the approach; back = -z: a byre or fold across the yard from a row facing it)."),
  row: z.object({
    nouns: z.array(z.string()).min(1).describe("Words naming ONE shell in the brief (hut, croft, house): the count is the number (word or digit) just before one of them in the place's read/landmark/features (`five turf-roofed stone huts` -> 5)."),
    count: z.number().int().min(1).max(8).default(3).describe("Shells when the brief names no number."),
    max: z.number().int().min(1).max(8).default(5).describe("Most shells built, whatever the brief says."),
    gap: z.number().min(1).max(12).default(2.5).describe("Metres between neighbouring shells."),
    size: z.object({ pinpoint: xz.default([4, 3]), small: xz.default([5, 3.5]), medium: xz.default([6, 4]), large: xz.default([7, 5]) }).strict().prefault({})
      .describe("Each shell's outline [width, depth] in metres, per size tier."),
  }).strict().optional().describe("square only: a ROW of N shells (a croft row, a line of huts) along x through `at`, doors on `gateSide`; the pocket radius grows to hold the row. L (shielings 2026-10-20): ONE 4 m shell read as a lone gate where the brief promised five huts."),
  points: z.array(xz).min(2).max(12).optional().describe("`line` only: plan points, metres in the pocket frame."),
  retain: z.object({
    face: z.enum(["right", "left"]).describe("The exposed (downhill) side, right/left of travel from the first point; the other side is the tread."),
    backfill: z.number().min(6).max(30).default(8).describe("Metres of tread raised behind the wall to just under its coping (>= 6: the 6 m rule)."),
    feather: z.number().min(4).max(40).default(6).describe("Metres the tread eases back to the natural ground."),
  }).strict().optional().describe("`line` only: a RETAINING wall (wall operator `retaining` + `backfill`): one face shown, the ground behind raised into a level tread, so a run of lines down a slope reads as stepped terraces, not field walls on a lawn. Height = the drop to the next tread. L (KNUCKLECROWN 2026-10-29: five free 3.5 m walls on the levelled crown read as one field wall)."),
  height: z.number().min(0.5).max(40).default(1.4).describe("Height above the ground (dry-stone dyke 1.2-1.6, yard wall 2, a beacon tower 9; kind wall <= 12, built kinds <= 40: curtain 7-10, tower 12-30, keep 18-26). L: over 3 m the tool adds buttresses (not to a small ring: a round tower braces itself; not to towers, keeps, gatehouses)."),
  thickness: z.number().min(0.4).max(4).default(0.8).describe("Wall thickness at the top (kind wall <= 3; a crenellated walk wants >= 1.8: two 0.45 m parapets and a 0.9 m walk)."),
  gate: z.number().min(0).max(12).default(3.5).describe("ring/square: a gap this wide on the approach side (0 = none)."),
  materials: z.record(z.string(), z.union([z.string(), z.array(z.string()).min(1).max(8)])).default({}).describe("Wall operator role materials; {} = the zone's own stone (one draw, texel-matched to the ground)."),
  landmark: landmarkSchema.nullable().default(null),
  shell: z.enum(["stub", "burnt"]).optional().describe("A house shell's state (square / row walls): omitted or `stub` = as given; `burnt` = standing charred walls BURNT_SHELL_M (4-5 m), no buttresses, no roof (`--set core.croft.shell=burnt`). L (TOOLS-PB 2026-10-23: croft shells were knee-high stubs; over 3 m they grew buttresses that shared the face picture). Gable ends and a charred face are not built yet (the wall operator has a flat top; no charred zone material)."),
  basin: z.object({
    material: z.string().min(1).describe("Water material id (shader `water`) of the sheet: a retting pit's brown, a tanning pit's black, a fish stew's green."),
    level: z.number().min(0.05).max(1.5).default(0.15).describe("Water surface above the HIGHEST ground inside the kerb, metres: no bed shows through the sheet."),
    kerb: z.number().min(0.15).max(1.5).default(0.4).describe("Kerb top above the water, metres (the wall is written level: heightMode level, topY = water + kerb)."),
    swim: z.boolean().default(false).describe("false: visual-only water (a shallow pit a body wades through)."),
    bed: z.number().min(-3).max(3).optional().describe("The levelled bed's height relative to the pocket's ground (m); omitted = the median of the ground inside the kerb. A FLIGHT of pits steps down by giving each a lower bed (ground that does not fall the way the flight should is cut and filled under the beds)."),
    open: z.enum(["front", "back"]).optional().describe("Leave the kerb's front (+z) or back (-z) side unbuilt: a sluice chute whose end is held by a gate content (a plank or hurdle across the inner width at that end), not by a wall. L (RETTING 2026-10-23): a sluice read as a kerb wall meeting the lake."),
    bedSurface: z.string().optional().describe("Palette surface painted over the basin's bed and its cut faces (to the kerb's outer face): the cut otherwise draws the cliff tile, at the cliff's texel scale (RETTING 2026-10-23, art gate: a sluice bed in the hagsheer cliff tile at 0.4x the built work beside it)."),
    contents: contentsSchema.describe("What lies in the water, placed as the pocket's structures are (seated on the bed, sunk when small; `on` = on another piece)."),
  }).strict().optional()
    .describe("square walls only, no gate: the wall is the stone KERB of a basin of standing water (a retting pit, a tanning pit, a tank): written level at water + kerb, the water sheet (a scene `water` body, its edge buried in the kerb's centre line) at the highest inner ground + level, its contents seated on the bed. L (RETTING 2026-10-23): a retting place passed every gate with no pits and no water; archetypes could not say 'a flight of stone-banked pits'."),
}).strict().superRefine((w, ctx) => {
  if (w.shape === "line" && !w.points) ctx.addIssue({ code: "custom", path: ["points"], message: "a line wall needs points" });
  if (w.basin && (w.kind !== "wall" || w.shape !== "square" || w.gate > 0 || w.row)) ctx.addIssue({ code: "custom", path: ["basin"], message: "a basin is a closed square kerb: kind wall, shape square, gate 0, no row" });
  w.basin?.contents.forEach((c, i) => { if (c.on !== undefined && c.on >= i) ctx.addIssue({ code: "custom", path: ["basin", "contents", i, "on"], message: "`on` names an EARLIER content" }); });
  if (w.kind === "wall" && (w.height > 12 || w.thickness > 3)) ctx.addIssue({ code: "custom", path: ["height"], message: "a plain wall is <= 12 m high and <= 3 m thick: a taller one is a built kind (curtain, tower, keep, gatehouse)" });
  if (w.kind === "tower" && w.shape !== "ring") ctx.addIssue({ code: "custom", path: ["shape"], message: "a tower is a ring" });
  if ((w.kind === "keep" || w.kind === "gatehouse") && w.shape !== "square") ctx.addIssue({ code: "custom", path: ["shape"], message: `a ${w.kind} is a square` });
  if (w.kind !== "wall" && w.kind !== "curtain" && w.row) ctx.addIssue({ code: "custom", path: ["row"], message: "a row is of plain shells" });
  if (w.kind !== "wall" && (w.top ?? "crenel") === "crenel" && w.thickness < 1.8) ctx.addIssue({ code: "custom", path: ["thickness"], message: "a crenellated walk needs a wall >= 1.8 m thick" });
  if (w.kind === "gatehouse" && w.size * 2 - 1 > 6) ctx.addIssue({ code: "custom", path: ["size"], message: "a gatehouse is at most 3.5 m half-width (the curtain's cut is a gate the router walks: <= 6 m)" });
});

export const placePocketSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/).describe("Pocket id; the core pocket is `core`."),
  kind: z.enum(FEATURE_KINDS).describe("Size-gate feature kind (tools/poi-review/size-tiers.mjs)."),
  at: xz.default([0, 0]).describe("Position in units of the tier's `spread` (place frame: [0,1] = toward the approach, [0,-1] = behind)."),
  search: z.number().min(0).max(60).default(14).describe("Metres the ground fit may move the pocket to find level dry ground."),
  sight: z.boolean().default(false).describe("A SIGHT, not a stop: seen from the place across water or a drop (a fishing cluster on the far bank), never walked to: no route from the core, no walk target, no encounter. L (RETTING 2026-10-23, owner: 'why are there no huts on the other side of the shore?')."),
  near: z.enum(["water", "edge", "any"]).default("any").describe("Fit preference: `water` = as close to water as stays dry (a shore), `edge` = beside a drop (a rim), `any`."),
  radius: z.number().min(3).max(40).default(9).describe("Pocket radius, metres: the ground its layout covers (L: >= 3 so the pad is >= 6 m: the 6 m rule). The plan raises it to the built tier's floor (POCKET_FLOOR_M) and spreads the layout with it."),
  fit: z.number().min(3).max(40).optional().describe("Radius the ground fit, the site search and the pad judge and level, metres; omitted = `radius`. Set by the plan when it spreads a pocket to its tier's floor (the archetype's own radius: only the structures' ground is levelled)."),
  pad: z.boolean().default(true).describe("Level a pad (a masked height patch, calm; raiseOnly beside a drop: L no lips/chamfered cliffs)."),
  maxRelief: z.number().min(0.5).max(12).default(4).describe("Most ground relief the fit accepts across the pad, metres."),
  structures: z.array(placeStructureSchema).max(10).default([]).describe("Up to 10 (LANDMARKS 2026-10-22: a landmark core carries its beacon, door lights and steps besides its pieces; PLACES-FIX: a story silhouette of up to 4 pieces joins the core)."),
  walls: z.array(placeWallSchema).max(8).default([]).describe("Walls and BUILT structures (kind curtain / tower / keep / gatehouse: a castle is a curtain, a keep, towers and a gatehouse in one pocket)."),
  dressing: z.object({
    role: z.enum(["camp", "yard", "path", "shore", "ruin", "cave-mouth"]),
    radius: z.number().min(3).max(40).optional().describe("Defaults to the pocket radius."),
    note: z.string().default(""),
    density: z.number().min(0).max(5).optional().describe("Loose props per 100 m2 the first plan asks of the area; omitted = the role's floor (DENSITY_FLOOR: camp 1.2, yard/ruin 1, cave-mouth 0.8, shore 0.6, path 0.4). L (Hagsheer 2026-10-21): a handful of props on open grass."),
    props: z.array(z.object({ prop: z.string(), count: z.number().int().min(1).max(12).default(1), prefer: z.enum(["wall", "open", "centre", "row"]).default("open").describe("`row` on a grave (tagged grave/headstone/cross/tomb): the pocket's graves are laid in rows filling the yard (dress check `graveyard-rows`), topped up to one per 10 m2 of the yard (`graveyard-sparse`) by place-build's dress loop.") }).strict()).default([])
      .describe("A FIRST dressing plan, by name only (dress check resolves every place; a Sonnet dresser may refine it). Counts are EXACT: the density top-up never repeats a listed prop (L TOOLS-PB 2026-10-23: 1 figurehead became 3)."),
    filler: z.array(z.string()).optional().describe("Catalogued small props the density top-up draws from for this pocket (stones, hay, rope coils, firewood); omitted = the archetype's `filler`, then the role's fill (ROOM_FILL). Never a `props` entry."),
  }).strict().nullable().default(null),
  encounter: z.object({ radius: z.number().min(6).max(16).default(8), for: z.string(), at: z.tuple([z.number(), z.number()]).optional().describe("Pocket-local centre (the place frame for the core under a layout): the fight's ground, e.g. the foot of a stair the boss guards. Omitted: the first spot of a ring round the pocket clear of its pieces. L (Red Dial 2026-10-29: the ring spot fell behind a plinth, unreachable).") }).strict().nullable().default(null)
    .describe("A creature clearing (populate packs) in this pocket."),
  floor: z.object({
    surface: z.string().min(1).describe("Palette surface name (recipe.surfaces[].name): the zone's paving for a flagged floor."),
    at: xz.default([0, 0]).describe("Centre, metres from the pocket centre in the pocket frame."),
    radius: z.number().min(3).max(20).default(6).describe("Radius, metres (>= 3: the 6 m rule)."),
    strength: z.number().min(0).max(1).default(0.9),
    breakup: z.number().min(0).max(0.9).default(0.15),
    contents: contentsSchema.describe("The floor's work set on it (beating boards, heaps of sheaves, a barrel), placed as the pocket's structures are (`floor-<n>`): fixed spots, not a dressing plan."),
  }).strict().nullable().default(null)
    .describe("A worked FLOOR painted on the ground (a groundPaints disc, data, no geometry): a scutching floor, a threshing floor, a flagged yard. L (RETTING 2026-10-23): the brief's flagged floor was open moor."),
}).strict();

export const placeArchetypeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  description: z.string().describe("What places it builds, in one line."),
  fits: z.array(z.string()).default([]).describe("Words in a brief place (id/name/read/landmark) that pick this archetype when --archetype is omitted."),
  culture: z.array(z.string()).min(1).default(["rural"]).describe("Dressing cultures (props menu vocabulary)."),
  lights: z.string().default("camp").describe("The one light bucket (tools/light-buckets.json)."),
  spread: z.object({ pinpoint: z.number().default(20), small: z.number().default(95), medium: z.number().default(150), large: z.number().default(300) }).strict().prefault({})
    .describe("Metres from the core to a pocket at |at| = 1, per size tier (sized so the footprint meets the tier: small 100-150 m, medium 150-300 m)."),
  spreadMax: z.number().min(5).max(300).optional().describe("Cap on `spread`, metres: the most ground between the core's pad and a satellite pocket's pad (pad = the archetype's own radius, `fit`); a pocket centre stands at most core fit + pocket fit + spreadMax from the core's (spreadReach). A tight place (a camp's forge by its fire) may then measure a lower tier: the size gate stays honest (tierDowngrade). L (TOOLS-PB 2026-10-23: a camp's forge 120 m and its horse lines 150 m from the fire)."),
  filler: z.array(z.string()).default([]).describe("Catalogued small props the density top-up draws from (every pocket without its own `dressing.filler`): stones, hay, rope coils, firewood. Empty = the role's fill (ROOM_FILL). The top-up never repeats a `dressing.props` entry."),
  views: z.array(z.object({ name: z.string().regex(/^[a-z0-9-]+$/), camera: z.tuple([z.number(), z.number(), z.number()]), target: z.tuple([z.number(), z.number(), z.number()]) }).strict()).max(12).default([])
    .describe("Extra fixed evidence cameras, written by the design before the site is final (`--set views=[...]`): PLACE FRAME, x right / z toward the approach from the plan centre, y over the pad (padY). Merged into views.json like <job>/contract.json views (a contract view of the same name wins)."),
  route: z.object({ width: z.number().min(1.6).max(5).default(2.4), style: z.enum(["dirt", "cobble", "slab"]).default("dirt"),
    maxGrade: z.number().min(0.1).max(0.45).default(0.35).describe("Steepest rise/run a footpath climbs as a ramp before the ribbon cuts steps. 0.35 (19 deg) walks; stepped flights on open moor read as sawtooth ground (gate lips alias).") }).strict().prefault({})
    .describe("Footpaths (path operator ribbons) from the approach to the core and from the core to each pocket."),
  read: z.object({
    ratio: z.number().min(1).max(4).optional().describe("Override of SILHOUETTE_RATIO: how many times the tallest OTHER piece the silhouette must stand (default 2, a tower over sheds). A farm, a steading or a yard whose read is one roof among walls sets ~1.1 (owner ruling 2026-10-23: a burnt croft is never a 9 m tower)."),
    band: xz.optional().describe("Override of the read window [near, far] in metres. Default by tier (READ_BY_TIER): small 110-150 m (a small silhouette is enough), medium 225-300 m, large 340-450 m."),
    duskLight: z.boolean().default(true).describe("L: a light or fire must burn in the place at dusk (hour 20). false only with `reason`."),
    reason: z.string().optional(),
    views: z.array(z.object({ name: z.string().regex(/^[a-z0-9-]+$/), at: xz.describe("World x,z of the viewer (a far head across a gorge, a rival landmark).") }).strict()).max(4).default([])
      .describe("Extra EVIDENCE views at noon/dusk looking at the landmark from fixed world spots (`far-<name>-<d>m`), on top of the approach read views. Judged by eye, not by the read check. L (bar-watch 2026-10-21): a pinpoint's 60 m read window has no view from across the gorge it is seen from."),
    beacon: z.object({ structure: placeStructureSchema.optional(), structures: z.array(placeStructureSchema).max(6).optional().describe("A silhouette of several pieces (two ribs of an arch, a row of net poles, two end frames): the first carries `landmark`."), wall: placeWallSchema.optional() }).strict().nullable().default(null)
      .describe("The core's tall element for the 300 m read (one catalogued structure OR one wall: a drystone beacon tower is a small `ring`), carrying `landmark`. Added by the plan when every read target of the archetype (landmark, smoke columns) is shorter than the tier's read needs (READ_PX_MIN px at the far end of the read window: medium 7.7 m, small 3.9 m); it then is the landmark. L (Hagsheer 2026-10-21): 1.8-5 m landmarks showed 0-10 px at 300 m."),
  }).strict().prefault({}),
  pockets: z.array(placePocketSchema).min(1).max(5).describe("The core (`core`, holding the landmark) first, then up to 4 more."),
  deny: z.array(z.string()).default([]).describe("Prefabs this archetype never places (on top of DENIED_PROPS, the catalogue pieces the art/zfight gates reject): a denied slot prefab is swapped for its first allowed choice, a denied dressing or fill prop is skipped."),
  ring: z.object({
    when: z.array(z.string()).default([]).describe("Brief words that switch the ring on (any one in the place's read/landmark/features); empty = always."),
    anchor: z.enum(["water", "core"]).default("water").describe("water: round the nearest lake (recipe features.lakes) within 150 m of the brief site, on its shore band (falls back to core when none); core: a circle round the core."),
    radius: z.number().min(4).max(120).default(14).describe("core anchor: the ring's radius, metres (a water ring takes the lake's own radius)."),
    width: z.number().min(1).max(20).default(6).describe("Band width, metres."),
    paint: z.object({ surface: z.string().min(1).describe("Palette surface name (recipe.surfaces[].name)."), strength: z.number().min(0).max(1).default(0.85), breakup: z.number().min(0).max(0.9).default(0.25) }).strict().nullable().default(null)
      .describe("A groundPaints band (data, no geometry): water anchor = a disc over the lake limited to its shore heights (waterY - 1 .. waterY + 1.5); core anchor = discs round the circle."),
    scatter: z.array(z.object({ rules: z.array(z.string()).min(1).describe("Scatter rule ids, the first the world has is used; `{zone}` = the zone id (dry-brush-{zone}: the zone's own skin)."), count: z.number().int().min(1).max(64).default(16), scale: z.number().min(0.2).max(3).default(1) }).strict()).default([])
      .describe("The VISIBLE ring: instances of the world's own scatter rules on the rim (a `rockSets` feature: batched with the rule, seated on the meshed ground). L (weep-well 2026-10-20): paint alone did not read from 300 m."),
    props: z.array(z.object({ prop: z.string(), count: z.number().int().min(1).max(24).default(6) }).strict()).default([])
      .describe("Catalogued ground props spread evenly round the ring on the first dry, level-enough ground (stones, wrack)."),
    note: z.string().default(""),
    request: z.string().optional().describe("What the catalogue lacks for the true ring (a reed or salt cover species): logged as a prop request, the paint and props stand in meanwhile."),
  }).strict().nullable().default(null)
    .describe("A ground ring round an anchor: the set piece of a shrine at a tarn (a white salt-killed reed ring), a stone circle's trodden band. L (weep-well 2026-10-20): nothing expressed the brief's ring, the landmark read as a small cairn."),
  quest: z.record(z.string(), z.string()).default({})
    .describe("The quest objects the zone's quest plan declares at the place (quests.json entities[] of kind object/readable whose location is the place): entity id -> the catalogued prop that IS it, usually given per place by `--set quest.<entity>=<prop>`. Each becomes an item of the core's first dressing plan with quest.entity (dress check / dress apply make it the quest entity, the id `zonegen bind` looks for). L (weepmouth, kelpmane-cove 2026-10-21): quest objects had been hand-added to dressing plans after the plan, and every `plan` wiped them."),
  propRequests: z.array(z.object({ name: z.string(), pocket: z.string(), at: xz, radius: z.number().default(3), why: z.string() }).strict()).default([])
    .describe("Things the catalogue lacks: logged as prop requests and their spots kept open (never a home-made stand-in)."),
}).strict().superRefine((a, ctx) => {
  if (a.pockets[0]?.id !== "core") ctx.addIssue({ code: "custom", path: ["pockets", 0, "id"], message: "the first pocket is `core`" });
  const all = a.pockets.flatMap((p) => p.structures);
  if (all.filter((s) => s.landmark).length + a.pockets.flatMap((p) => p.walls).filter((w) => w.landmark).length !== 1) ctx.addIssue({ code: "custom", path: ["pockets"], message: "exactly one structure carries `landmark`" });
  const lit = all.some((s) => s.role === "fire" || FIRE_PREFABS.includes(s.prefab)) || a.pockets.some((p) => p.dressing?.props.some((q) => FIRE_PREFABS.includes(q.prop)));
  if (a.read.duskLight && !lit) ctx.addIssue({ code: "custom", path: ["read", "duskLight"], message: "no fire or light: the place must read at dusk (a FIRE_PREFABS structure or dressing prop), or set read.duskLight false with a reason" });
  if (!a.read.duskLight && !a.read.reason) ctx.addIssue({ code: "custom", path: ["read", "reason"], message: "duskLight false needs a reason" });
  for (const s of all) {
    if (s.role === "fire" && !FIRE_PREFABS.includes(s.prefab)) ctx.addIssue({ code: "custom", path: ["pockets"], message: `${s.id}: fire must be a catalogued vfx fire (${FIRE_PREFABS.join(", ")})` });
    if (HULL_RE.test(s.prefab) && s.role !== "boat") ctx.addIssue({ code: "custom", path: ["pockets"], message: `${s.id}: a hull is never a wall or a building (boats lie on the shingle as role boat)` });
  }
  const bc = a.read.beacon;
  const kinds = [bc?.structure, bc?.wall, bc?.structures?.length ? bc.structures : undefined].filter(Boolean).length;
  if (bc && (kinds !== 1 || !(bc.structure?.landmark ?? bc.wall?.landmark ?? bc.structures?.[0]?.landmark))) ctx.addIssue({ code: "custom", path: ["read", "beacon"], message: "a beacon is ONE structure, ONE wall or ONE list of structures (the story silhouette), and its first piece carries `landmark`" });
  const ids = new Set(a.pockets.map((p) => p.id));
  if (ids.size !== a.pockets.length) ctx.addIssue({ code: "custom", path: ["pockets"], message: "pocket ids repeat" });
});
export type PlaceArchetype = z.infer<typeof placeArchetypeSchema>;

/** L (TOOLS-LAYOUT 2026-10-24, Tinkers' Camp RETURNED with 16/16 gates: "the builder decides where things go"): the
 *  owner's COMPOSITION, `<job>/layout.json`. When it exists `plan` places every piece at exactly its spot (settled to the
 *  ground there) or refuses the plan naming the piece; it never re-fits or moves one. The archetype then contributes only
 *  terrain (pocket fits, pads), clearings, walls, filler and the quest slots: its own structures, its `read.beacon` and its
 *  pockets' listed `dressing.props` are NOT added (the layout is the whole composition). */
export const LAYOUT_KINDS = ["structure", "prop", "fire", "decal"] as const;
export const GROUND_KINDS = ["wear", "mud", "ash", "paving", "rubble"] as const;
/** L (Exiles' Bell 2026-10-24: 2-3 m discs with a 2 m feather did not read from a walking camera): every ground disc is at
 *  least this wide (radius, metres) with a 1 m feather. */
export const GROUND_MIN_RADIUS_M = 4, GROUND_FEATHER_M = 1;
/** `rubble`: small rock-kit stones scattered in the disc (catalogued; rock-skins gives them the zone's small-rock skin). */
/** Metres (x the stone's scale) a rubble stone sits in the ground: it is seated on the field BEFORE the walls/operators regrade it (KNUCKLECROWN 2026-10-29: 3.5 m terraces moved the tread 0.12 m and 8 stones showed their undersides, float FAIL). */
export const RUBBLE_EMBED_M = 0.3;
export const RUBBLE_STONES = ["rock-kit/boulder-s-1", "rock-kit/boulder-s-2", "rock-kit/boulder-s-3"];
const layoutPieceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/).describe("Piece id, unique in the layout (entity `<poi>-core-<id>`; refusals name it)."),
  element: z.string().describe("The design.json `elements[].id` this piece shows (coverage: every element made of a catalogue prop needs a piece; a piece naming no element is refused)."),
  kind: z.enum(LAYOUT_KINDS).describe("`structure` (seated on its base outline, a skirt or raised ground on a slope), `prop` (a fixed dressing piece, seated the same way, never moved by the dresser), `fire` (the fire slot: a catalogued vfx fire, FIRE_PREFABS), `decal` (a flat ground piece such as composite-props/ash-drift: at ground height, no footprint, never a solid)."),
  prefab: z.string().describe("Catalogued prefab id in the world's closure; one that is not is a plan refusal."),
  at: xz.describe("PLACE FRAME, metres from the plan centre (reports/plan.json `centre`): x = right, z = toward the approach (the frame `views` use)."),
  yaw: z.number().default(0).describe("Degrees about +Y in the place frame (0: the prefab's +Z front faces the approach)."),
  scale: z.number().min(0.25).max(3).default(1).describe("Uniform scale; the footprint (catalogue `dressing.size`) scales with it. Above 1 it obeys the texel floor (MIN_SCALED_TEXELS) like a structure slot."),
  pocket: z.string().regex(/^[a-z0-9-]+$/).optional().describe("The archetype pocket this piece belongs to (default `core`). A non-core pocket named by pieces is centred on their centroid (its dressing area and filler surround them); its own ground fit is skipped."),
  role: z.enum(["landmark", "dwelling", "work", "fire", "set-piece", "boat"]).optional().describe("Slot role (placeStructureSchema.role). Default: fire -> `fire`, a tent/hut/shack/house/lean-to structure -> `dwelling`, else `set-piece`."),
  landmark: landmarkSchema.optional().describe("The ONE piece the approach read and the silhouette rule judge (at most one per layout)."),
  over: z.array(z.string()).default([]).describe("Piece ids this piece is MEANT to overlap (a hoist gantry straddling the bell, a tarp standing over a crate): those footprint pairs are exempt from the overlap refusal, both directions. L (Exiles' Bell 2026-10-24)."),
  quest: z.string().regex(/^[a-z0-9-]+$/).optional().describe("A quest slot (the quest plan's object id, `--set quest.<slot>=<prop>`): the slot's prop (the set's prop; this piece's `prefab` when the set names none) is placed HERE as the quest entity (a fixed floor item of the core plan at this `at`/`yaw`), never at the dressing plan's auto spot; the piece is not also built as a structure."),
  sink: z.number().min(0).max(4).default(0).describe("Decal pieces only: metres the piece stands BELOW the ground at its centre. A piece set INTO a rock face (an opened niche whose back is in the face) has its centre over the face, where the ground is the face itself; `sink` lowers it to the foot so its front stands flush on the flat. L (o-small 2026-10-29)."),
  lift: z.number().min(0).max(2).default(0).describe("Metres the piece stands above its seat (raised foundations: a kit building whose floor slab is at y=0 stands 0.6 m up, like town buildings, so the slab never shares the pad surface — Ashen Vow 2026-10-24: a 410 m2 z-fight)."),
  on: z.string().regex(/^[a-z0-9-]+$/).optional().describe("Id of an EARLIER piece of the layout: this piece stands on that piece's own mesh top at its `at` (a ring on its plinth, a fire bowl on a pillar cap or a tower top), never on the ground; list it with `over` when the footprints overlap. L (Red Dial 2026-10-29: the ring stands on a 2.4 m plinth, lift caps at 2 m)."),
  lean: leanSchema.optional().describe("Tilt the WHOLE piece from its foot (leanSchema): yaw turns it, lean tips it (also on top of an `on` piece). L (KNUCKLECROWN 2026-10-29)."),
  overrides: z.array(z.object({ path: z.string().min(1), value: z.unknown() }).strict()).max(8).default([]).describe("Prefab-instance overrides on the placed piece (the engine prefab `overrides`: `<local entity>/components/<component>/<field>`; a nested instance is reached through its `<entity>/components/prefab/overrides` array). For a per-place tweak of a catalogued piece that is not a new prop: a camp fire whose light burns at night only. L (o-small2 dropped-hour 2026-10-30)."),
  wet: z.boolean().default(false).describe("The piece may stand at or in water (drowned steps, a pier, a reed clump): wet ground under its footprint is not a refusal. Default: wet ground refuses the piece (Drowning Pools 2026-10-24: the ordeal sanctuary whose steps run into the loch)."),
}).strict();
/** The scale class a site's dressing plans are made for, from its cultures: an ogre or giant camp is dressed at giant
 *  scale (props menu --scale giant), everyone else at human. L (o-small2 dropped-hour 2026-10-30): every site plan was
 *  written 'human', so a desert-ogre camp's dressers could not take the ogre-giant-craft props without editing the plan. */
export const siteScale = (culture: string[]): "giant" | "human" => (culture.some((c) => c === "ogre" || c === "giant") ? "giant" : "human");
export const placeLayoutSchema = z.object({
  version: z.literal(1),
  frame: z.literal("place").describe("Every x,z is in the place frame: origin the plan centre, +z toward the approach, +x its right, y over padY."),
  origin: xz.optional().describe("World x,z of the frame's origin (the plan centre the layout was drawn on, reports/plan.json `centre`). Given: the core is PINNED there (the site search never moves the composition between plans). Omitted: the site search's core, re-fitted every plan."),
  pieces: z.array(layoutPieceSchema).min(1).max(60).describe("The composition: every structure, hero prop, fire and decal of the place, each at its exact spot."),
  views: z.array(z.object({ name: z.string().regex(/^[a-z0-9-]+$/), camera: z.tuple([z.number(), z.number(), z.number()]), target: z.tuple([z.number(), z.number(), z.number()]) }).strict()).max(12).default([])
    .describe("Fixed evidence cameras in the place frame (y over padY). They REPLACE the archetype's / `--set views` set; contract.json views still win on a name."),
  ground: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    element: z.string().optional().describe("The design element the patch belongs to (checked like a piece's)."),
    kind: z.enum(GROUND_KINDS).describe("`wear` trodden earth (the DARKEST of the zone's road / ground / dirt surfaces, never the paving-like road tile), `mud`, `ash`, `paving`: a groundPaints disc (1 m feather, edge noise) in the surface WEAR_SURFACES finds for the kind (zone surface first), or `texture`. No surface = a plan refusal naming the kind. `rubble`: 6-10 small catalogued rock-kit stones (RUBBLE_STONES) scattered inside the disc, seated on the ground, worn in the zone's small-rock skin (rock-skins)."),
    at: xz.describe("Place frame centre."),
    radius: z.number().min(0.5).max(30).default(GROUND_MIN_RADIUS_M).describe("Metres; raised to GROUND_MIN_RADIUS_M (4) when smaller (a smaller disc does not read)."),
    texture: z.string().optional().describe("A recipe surface name (recipe.surfaces[].name) instead of the kind's default."),
    faces: z.boolean().default(false).describe("Also paint the steep faces in the disc (groundPaints `faces`): a pad's cut bank otherwise draws the zone cliff tile at its 20 m scale beside 40 tx/m work (art gate texel). L (KNUCKLECROWN 2026-10-28)."),
    strength: z.number().min(0).max(1).default(0.85),
    breakup: z.number().min(0).max(0.9).default(0.3),
  }).strict()).default([]).describe("Ground WEAR as data (the pocket `floor` path: groundPaints, no geometry): trodden earth round the fire, mud at the horse lines, ash."),
  pools: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    element: z.string().optional().describe("The design element the pool belongs to (checked like a piece's)."),
    at: xz.describe("Place frame centre."),
    radius: z.number().min(6).max(40).describe("Water radius, metres (>= 6: the 6 m rule)."),
    sink: z.number().min(0.3).max(5).default(1.5).describe("Metres the still water stands BELOW the pad (padY - sink): a sunken pool in its own hollow, never a sheet on the pad."),
    depth: z.number().min(0.5).max(8).default(2.5).describe("Deepest water below the surface, metres."),
    bank: z.number().min(6).max(30).default(8).describe("Metres the shore eases from the waterline back to the pad (>= 6: the 6 m rule; no lip)."),
    material: z.string().optional().describe("Water material for this pool (recipe lake `material`): a still black pool, a murky tarn."),
  }).strict()).max(4).default([]).describe("STILL WATER as data: a hand-placed recipe lake (carve: true) of ONE level sunk below the pad in its own hollow. L (KNUCKLECROWN 2026-10-28): a landmark ringing a pool had no way to say the pool; a basin kerb is a square tank."),
  waters: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    element: z.string().optional().describe("The design element the water belongs to (checked like a piece's)."),
    on: z.string().regex(/^[a-z0-9-]+$/).describe("The layout piece (a built basin, a tank, a well) whose marker holds the level."),
    marker: z.string().default("basin-water").describe("Marker id in that piece's <model>.markers.json: its position is the water level and centre, its size [x, 0, z] the sheet."),
    material: z.string().describe("Water material (a still pool's, e.g. terrain/<world>-water-lake)."),
    depth: z.number().min(0.2).max(8).default(1.4).describe("Water depth for bodies in it, metres."),
    swim: z.boolean().default(false).describe("false: visual-only water a body wades through (a basin), true: swimmable."),
  }).strict()).max(4).default([]).describe("STILL WATER IN A BUILT PIECE: one level sheet at a structure's marker (a kit basin's `basin-water`), nothing moving. Pools carve terrain; this fills a mesh basin. L (Red Dial 2026-10-29)."),
  clearings: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    element: z.string().optional().describe("The design element the clearing serves (checked like a piece's)."),
    at: xz.describe("Place frame centre."),
    radius: z.number().min(8).max(160).describe("Metres."),
    keep: z.number().min(0).max(1).default(0.15).describe("Share of trees and scatter kept inside (0.15: a heath with a few stripped trees)."),
    feather: z.number().min(0).max(60).default(20).describe("Metres outside the edge over which the woods return."),
  }).strict()).max(6).default([]).describe("HEATH / SIGHTLINE clearings as data (recipe vegetation clearings, scatter only, ground cover kept): a landmark in woodland is hidden from its own roads by the trees, not the terrain. L (KNUCKLECROWN 2026-10-28: 25 m pillars on a forested crown were invisible from all three roads at 300 m)."),
  areas: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/).describe("Area id (the room of its socket map; its plan is dressing/<poi>-<id>.json, written by its dresser and KEPT by plan)."),
    role: z.enum(["camp", "yard", "path", "shore", "ruin", "cave-mouth"]).describe("Site-dressing role (density floor, vignette kinds)."),
    at: xz.describe("Place frame centre."),
    radius: z.number().min(3).max(20).describe("Metres."),
    note: z.string().default("").describe("What the area is for, printed in the dresser brief."),
    reach: xz.optional().describe("Place frame point poi-walk walks to for this area: open ground at its edge, on the walk side (default the centre, where the dresser's props and the area's own pieces stand; a reach there walked into a basin and through a sack)."),
  }).strict()).max(4).default([]).describe("Extra DRESSING AREAS beyond the pockets' (handoff siteDressing.areas): a midden, an opened tomb at the rib foot, each dressed by its own fresh dresser. Plan never wipes their plan files. L (o-small2 dropped-hour 2026-10-30)."),
  vegetation: regionVegetationSchema.optional().describe("The place's OWN region vegetation (recipe regions[id = the poi].vegetation, a place region): species swaps, thinning and cover filters over the whole place, applied by build/install (removed by --uninstall). Clearings only thin; this says WHAT grows (broadleaf -> dead pines on a heath crown). L (KNUCKLECROWN 2026-10-29: a heath crown stood in lush broadleaf with no data path to say otherwise)."),
}).strict().superRefine((l, ctx) => {
  const ids = l.pieces.map((p) => p.id);
  for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) ctx.addIssue({ code: "custom", path: ["pieces"], message: `piece id ${id} repeats` });
  if (l.pieces.filter((p) => p.landmark).length > 1) ctx.addIssue({ code: "custom", path: ["pieces"], message: "at most one piece carries `landmark`" });
});
export type PlaceLayout = z.infer<typeof placeLayoutSchema>;
export type LayoutPiece = PlaceLayout["pieces"][number];
/** Surface candidates per ground kind, first the recipe has wins: `{w}-{z}` = <world>-<zone> (the zone's own skin), then generic. */
export const WEAR_SURFACES: Record<Exclude<(typeof GROUND_KINDS)[number], "rubble">, string[]> = {
  wear: ["{w}-{z}-road", "{w}-{z}-ground", "{w}-{z}-dirt", "dirt"],
  mud: ["{w}-{z}-mud", "mud"],
  ash: ["{w}-{z}-ash", "ash"],
  paving: ["{w}-{z}-paving", "paving", "cut-stone"],
};
const luma = (hex: string | undefined): number => { const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? ""); if (!m) return Infinity; const n = parseInt(m[1]!, 16); return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255); };
/** The surface for a ground kind: the first candidate the recipe has; `wear` given surface colours takes the DARKEST
 *  candidate the recipe has (L Exiles' Bell 2026-10-24: Hagsheer's road is a pale gravel that read as paving). */
export function wearSurface(kind: Exclude<(typeof GROUND_KINDS)[number], "rubble">, surfaces: string[], world: string, zone: string, colors?: Record<string, string>): string | null {
  const have = WEAR_SURFACES[kind].map((s) => s.replace("{w}", world).replace("{z}", zone)).filter((s) => surfaces.includes(s));
  if (kind === "wear" && colors && have.some((s) => colors[s])) return [...have].sort((x, y) => luma(colors[x]) - luma(colors[y]))[0] ?? null;
  return have[0] ?? null;
}
const DWELLING_RE = /tent|hut|shack|house|lean-to|hovel|bothy/;
/** Steepest rise/run a layout piece may stand on (the usable-area slope: 31 deg). */
export const USABLE_SLOPE = 0.6;
export const pieceRole = (p: LayoutPiece) => p.role ?? (p.kind === "fire" ? "fire" : p.kind === "structure" && DWELLING_RE.test(p.prefab) ? "dwelling" : "set-piece");
/** A piece's footprint half extents (x, z) from its catalogue size x scale; null when the catalogue declares no size. */
export const pieceHalf = (p: { scale: number }, size: number[] | undefined | null): [number, number] | null => (size && size.length >= 3 ? [Math.round(size[0]! * p.scale * 50) / 100, Math.round(size[2]! * p.scale * 50) / 100] : null);
/** The size band a layout piece's catalogued size (x its scale) should sit in, by kind: a WARN, never a refusal
 *  (TOOLS-LAYOUT 5: a human camp's "bonfire" catalogued 4.81 x 5.10 m). null = in band or no size. */
export function layoutSizeWarn(q: { kind: string; prefab: string; scale: number }, size: number[] | undefined | null): string | null {
  if (!size || size.length < 3) return null;
  const span = Math.round(Math.max(size[0]!, size[2]!) * q.scale * 100) / 100;
  if (q.kind === "fire" && span > 3) return `fire ${q.prefab} is ${span} m across (> 3 m for a human camp; scale it or use a smaller fire)`;
  if (q.kind === "prop" && span > 6) return `prop ${q.prefab} is ${span} m across (> 6 m: a structure, or a catalogue size fault)`;
  if (q.kind === "structure" && span < 1) return `structure ${q.prefab} is ${span} m across (< 1 m: a prop)`;
  // L (Exiles' Bell 2026-10-24): a Codex hero prop scaled up stretches its texels; it is re-made at the size it stands at
  if (q.prefab.startsWith("codex-craft/") && q.scale > CODEX_SCALE_MAX) return `${q.prefab} made too small: re-request at ${Math.round(size[1]! * q.scale * 10) / 10} m (props request add --size; it stands at x${q.scale}, over x${CODEX_SCALE_MAX})`;
  return null;
}
/** The most a layout may scale a codex-craft prop up before it is a re-request at its size. */
export const CODEX_SCALE_MAX = 1.2;
/** Two yawed rectangles (place-frame centre, half extents, degrees) overlap (separating axis); `tol` metres of touch allowed. */
export function boxesOverlap(a: { at: [number, number]; half: [number, number]; yaw: number }, b: { at: [number, number]; half: [number, number]; yaw: number }, tol = 0.05): boolean {
  // the piece's own axes in the place frame, as planPlace turns it (+Z front onto (-sin, cos): yaw +90 faces -x). L (Red Dial
  // 2026-10-29: these were mirrored — harmless at 0/90/180, wrong overlaps at 35 deg)
  const axes = (y: number): [number, number][] => { const r = (y * Math.PI) / 180; return [[Math.cos(r), Math.sin(r)], [-Math.sin(r), Math.cos(r)]]; };
  const corners = (q: typeof a) => { const [u, v] = axes(q.yaw); return [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([i, j]) => [q.at[0] + u![0] * q.half[0] * i! + v![0] * q.half[1] * j!, q.at[1] + u![1] * q.half[0] * i! + v![1] * q.half[1] * j!] as [number, number]); };
  const ca = corners(a), cb = corners(b);
  for (const ax of [...axes(a.yaw), ...axes(b.yaw)]) {
    const pa = ca.map((c) => c[0] * ax[0] + c[1] * ax[1]), pb = cb.map((c) => c[0] * ax[0] + c[1] * ax[1]);
    if (Math.max(...pa) - tol <= Math.min(...pb) || Math.max(...pb) - tol <= Math.min(...pa)) return false;
  }
  return true;
}
/** The archetype as a layout leaves it: its structures, `read.beacon` (and the silhouette tower withBeacon added) and its
 *  pockets' listed dressing props out; terrain, walls, filler, encounters, floors and the quest slots kept; the layout's
 *  `views` replace the set. The pieces (not decals) join the core as structures (the core pocket's frame IS the place
 *  frame), so the silhouette rule and every structure path (seat, skirt, pad, cover clearing, keep-clear) judge them as
 *  placed; planPlace pins the core on the plan centre and places them exactly. Apply AFTER forTier (spreadToFloor never
 *  moves a piece). Pure. */
export function withLayout(a: PlaceArchetype, l: PlaceLayout, info?: (prefab: string) => { size?: number[] } | null): PlaceArchetype {
  const pieces = l.pieces.filter((p) => p.kind !== "decal" && !p.quest).map((p) => {
    const half = pieceHalf(p, info?.(p.prefab)?.size);
    return { id: p.id, role: pieceRole(p), prefab: p.prefab, choices: [], at: p.at, yaw: p.yaw, footprint: Math.min(20, Math.max(0.5, half ? Math.round(Math.hypot(half[0], half[1]) * 100) / 100 : 1)), scale: p.scale, lift: p.lift ?? 0, landmark: p.landmark ?? null, ...(p.on ? { on: p.on } : {}), ...(p.lean && p.lean.deg > 0 ? { lean: p.lean } : {}), overrides: p.overrides ?? [] } as PlaceArchetype["pockets"][number]["structures"][number];
  });
  // L (Exiles' Bell 2026-10-24): spreadToFloor had multiplied the core walls' `at` by floor / fit (x1.8), so a chapel the
  // owner drew at [28,-4] stood 51 m out while the pieces beside it stood exactly: under a layout the walls stand where
  // they are written in the same place frame (the spread is undone; a grown enclosure keeps its grown size).
  const exact = (p: PlaceArchetype["pockets"][number], w: PlaceArchetype["pockets"][number]["walls"][number]) => {
    const s = p.fit && p.fit > 0 ? p.radius / p.fit : 1;
    if (Math.abs(s - 1) < 1e-9) return w;
    const un = (q: V2): V2 => [r2(q[0] / s), r2(q[1] / s)];
    return { ...w, at: un(w.at), ...(w.points ? { points: w.points.map((q) => un(q as V2)) } : {}) };
  };
  return { ...a, views: l.views, read: { ...a.read, beacon: null }, pockets: a.pockets.map((p, k) => ({ ...p,
    // a layout piece that carries `landmark` IS the landmark: an archetype wall's landmark (kept only so the archetype schema's
    // "exactly one" holds before the layout applies — Ashen Vow 2026-10-24: a 1.1 m dyke declared 16 m) is dropped
    structures: k === 0 ? pieces : [], walls: p.walls.filter((w) => w.id !== "beacon").map((w) => (k === 0 ? exact(p, w) : w)).map((w) => (l.pieces.some((q) => q.landmark) && w.landmark ? { ...w, landmark: null } : w)),
    dressing: p.dressing ? { ...p.dressing, props: [] } : null })) };
}
/** Coverage both ways (gate 16 meets the layout): every design element made of a catalogue prop has a piece (or a ground
 *  patch); every piece / patch names an element that exists. structure:/creature:/terrain:/decal:/water:/text:/light:
 *  entries are exempt, and so is an element whose catalogued props are all the place's quest props (the quest slot is
 *  placed by the dressing plan as quest.entity). */
export function layoutCoverage(design: { elements?: { id: string; madeOf?: string[] }[] } | null, l: PlaceLayout, o: { catalogued?: (id: string) => boolean; questProps?: string[] } = {}): string[] {
  const out: string[] = [], els = design?.elements ?? [], ids = new Set(els.map((e) => e.id));
  for (const p of l.pieces) if (!ids.has(p.element)) out.push(`piece ${p.id} names unknown element ${p.element}`);
  for (const q of l.ground) if (q.element && !ids.has(q.element)) out.push(`ground ${q.id} names unknown element ${q.element}`);
  const exempt = /^(structure|terrain|creature|decal|water|text|light):/;
  for (const e of els) {
    const props = (e.madeOf ?? []).filter((m) => !exempt.test(m) && m.includes("/") && (o.catalogued?.(m) ?? true));
    if (!props.length || props.every((m) => (o.questProps ?? []).includes(m))) continue;
    if (!l.pieces.some((p) => p.element === e.id) && !l.ground.some((q) => q.element === e.id) && !(l.pools ?? []).some((q) => q.element === e.id) && !(l.waters ?? []).some((q) => q.element === e.id) && !(l.clearings ?? []).some((q) => q.element === e.id)) out.push(`element ${e.id} has no layout piece`);
  }
  return out;
}
export type PlaceTier = "pinpoint" | "small" | "medium" | "large";

/** L (weepmouth, coordinator ruling 2026-10-21): a PINPOINT is one spot (a cairn, a marker, a lookout): the archetype's
 *  core pocket only, its satellites and their prop requests dropped. Ground that holds no small layout (a 14 m beach strip
 *  under gorge walls) still holds one strong marker; size-tiers.mjs pinpoint: 15-60 m across, 100 m2 usable. */
export function forTier(a: PlaceArchetype, size: PlaceTier, heightOf?: (prefab: string) => number | null): PlaceArchetype {
  const one = size !== "pinpoint" ? a : { ...a, pockets: a.pockets.slice(0, 1), propRequests: a.propRequests.filter((q) => q.pocket === a.pockets[0]!.id) };
  return spreadToFloor(withBeacon(one, size, heightOf), size);
}

/** The heights (above the core's ground) the archetype shows from afar: landmark and smoke columns. */
const readHeights = (a: PlaceArchetype) => a.pockets.flatMap((p) => [...p.structures.flatMap((s) => [s.landmark?.height ?? 0, SMOKE_READ_M[s.prefab] ?? 0]), ...p.walls.map((w) => w.landmark?.height ?? 0)]);
/** L (read, Hagsheer 2026-10-21: 1.8-5 m landmarks showed 0-10 px from 300 m) and the owner ruling 2026-10-21 23:25
 *  ("larger and more silhouetted POIs"): every place has ONE silhouette element, built, that reads from its approach:
 *  at least `heightForPx` of the tier's far read distance AND at least SILHOUETTE_RATIO x the tallest other piece of the
 *  place (walls by their height, structures by `heightOf`, the catalogue's declared size). A landmark that already is
 *  that tall is the silhouette. Otherwise the archetype's `read.beacon` joins the core and becomes the landmark: a wall
 *  beacon (the drystone beacon tower) is raised to the height needed (a `tower` past 12 m); a structure beacon (a pyre,
 *  a crag) keeps standing as the fire / smoke and the default silhouette tower (SILHOUETTE_TOWER) is built beside it,
 *  unless the structure itself is tall enough. Smoke columns count for the dusk read, never as the silhouette. The old
 *  landmark keeps standing, without the role. */
/** The lowest texel density a scaled structure may reach. The owner's hard floor is 20 tx/m, but the art gate holds built
 *  surfaces to 40 +- 8 (art standard builtTarget/builtTolerance): a piece scaled under 32 tx/m fails art (wreck-road whale
 *  ribs x1.45 = 27.9, PLACES-FIX 2026-10-22), so the plan refuses it up front. Taller than that = a Codex landmark request. */
export const MIN_SCALED_TEXELS = 32;
export const SILHOUETTE_RATIO = 2;
/** The silhouette stands this many times the bare 16 px height: the reviewer (REV-PF3 2026-10-22) could not find a 9 m
 *  tower that met READ_PX_MIN against the far ground at 292 m (dark stone on dark moor); taller crosses the skyline. */
export const SILHOUETTE_READ_K = 1.6;
export const SILHOUETTE_TOWER = { id: "beacon", kind: "wall" as const, shape: "ring" as const, at: [-7, -7] as V2, size: 2.6, height: 9, thickness: 1.2, gate: 0 };
export function silhouetteHeight(a: PlaceArchetype, size: PlaceTier, heightOf?: (prefab: string) => number | null): { need: number; floor: number; landmark: number; other: number } {
  const px16 = heightForPx(readBand(size, a.read.band)[1]), need0 = SILHOUETTE_READ_K * px16;
  let landmark = 0, other = 0;
  // the silhouette's own kind (its prefabs) elsewhere in the place is part of it (the rows of net poles), never "other"
  const own = new Set(a.pockets.flatMap((p) => p.structures.filter((s) => s.landmark || /^beacon/.test(s.id)).map((s) => s.prefab)));
  // a SIGHT pocket (huts on the far bank) is seen across the water, not beside the landmark: it is no rival to it
  for (const p of a.pockets.filter((q) => !q.sight)) {
    for (const s of p.structures) { if (own.has(s.prefab) && !s.landmark) continue; const h = s.landmark?.height ?? (heightOf?.(s.prefab) ?? 0) * (s.scale ?? 1); if (s.landmark) landmark = Math.max(landmark, h); else if (!s.onWall && !/^beacon/.test(s.id)) other = Math.max(other, h); } // the silhouette's own pieces are not "other"
    for (const w of p.walls) { if (w.landmark) landmark = Math.max(landmark, w.landmark.height ?? w.height); else other = Math.max(other, w.height); }
  }
  // `need` sizes the generic fallback tower; `floor` is what ANY silhouette (a story element: ribs, net poles, a gibbet) must reach
  const ratio = a.read.ratio ?? SILHOUETTE_RATIO;
  return { need: Math.max(need0, ratio * other), floor: Math.max(px16, ratio * other), landmark, other };
}
export function withBeacon(a: PlaceArchetype, size: PlaceTier, heightOf?: (prefab: string) => number | null): PlaceArchetype {
  const { need, floor, landmark } = silhouetteHeight(a, size, heightOf);
  if ((landmark >= need || (landmark >= floor && !a.read.beacon?.structures?.length)) || a.pockets[0]!.walls.some((w) => w.id === "beacon") || a.pockets[0]!.structures.some((s) => s.id === "beacon")) return a; // idempotent
  const H = Math.ceil(need), bc = a.read.beacon;
  const tower = (base: any) => {
    const h = Math.max(base.height ?? 9, H), tall = h > 12;
    return { ...base, id: "beacon", height: h, ...(tall ? { kind: "tower", sides: 8, top: "plain", thickness: Math.min(4, Math.max(1.8, h / 8)) } : { thickness: Math.min(3, Math.max(base.thickness ?? 1.2, h / 8)) }),
      landmark: { fogReach: Math.max(600, base.landmark?.fogReach ?? 600), silhouette: base.landmark?.silhouette ?? 0.7, height: h } };
  };
  // a STORY silhouette of several pieces (the place's own element: read.beacon.structures) is used as given; its height is judged by the plan (SILHOUETTE FIT)
  if (bc?.structures?.length) return { ...a, pockets: a.pockets.map((p, k) => { const un = { ...p, structures: p.structures.map((s) => (s.landmark ? { ...s, landmark: null } : s)), walls: p.walls.map((w) => (w.landmark ? { ...w, landmark: null } : w)) };
    return k ? un : { ...un, structures: [...un.structures, ...bc.structures!.map((s, i) => ({ ...s, id: i ? `beacon-${i + 1}` : "beacon", landmark: i ? null : s.landmark }))] }; }) };
  const tallStructure = bc?.structure && (bc.structure.landmark?.height ?? 0) >= need;
  const pockets = a.pockets.map((p, k) => {
    const un = { ...p, structures: p.structures.map((s) => (s.landmark ? { ...s, landmark: null } : s)), walls: p.walls.map((w) => (w.landmark ? { ...w, landmark: null } : w)) };
    if (k !== 0) return un;
    if (tallStructure) return { ...un, structures: [...un.structures, { ...bc!.structure!, id: "beacon" }] };
    const structures = bc?.structure ? [...un.structures, { ...bc.structure, id: "beacon-fire", landmark: null }] : un.structures;
    return { ...un, structures, walls: [...un.walls, placeWallSchema.parse(tower(bc?.wall ?? SILHOUETTE_TOWER))] };
  });
  return { ...a, pockets };
}

/** L (size, Hagsheer 2026-10-21: a medium place was a 16-30 m clutter patch): every pocket covers at least its tier's
 *  floor (POCKET_FLOOR_M: medium core 24 m radius, other pockets 12 m). A smaller pocket keeps its own radius as `fit`
 *  (the ground fit, the site search and the pad judge only that) and its layout is spread by floor / radius: structure
 *  and wall positions, line walls, a set dressing radius and its prop requests; a wall that encloses the pocket (ring or
 *  square, size >= half the radius, not a row shell) grows with it; small rings and squares (a tower, a pen, a shell)
 *  keep their size. Idempotent. */
export function spreadToFloor(a: PlaceArchetype, size: PlaceTier): PlaceArchetype {
  const fl = POCKET_FLOOR_M[size], scales = new Map<string, number>();
  const pockets = a.pockets.map((p, k) => {
    const want = k === 0 ? fl.core : fl.other;
    if (p.radius >= want) return p;
    const s = want / p.radius, sc = (q: V2): V2 => [r2(q[0] * s), r2(q[1] * s)];
    scales.set(p.id, s);
    return { ...p, radius: want, fit: p.fit ?? p.radius,
      // a piece on a wall's walk (onWall) rides its wall: the wall's centre moves, the piece keeps its place on the wall line
      structures: p.structures.map((st) => { const host = st.onWall ? p.walls.find((w) => w.id === st.onWall) : undefined; return { ...st, at: host ? [r2(host.at[0] * s + st.at[0] - host.at[0]), r2(host.at[1] * s + st.at[1] - host.at[1])] as V2 : sc(st.at) }; }),
      // built towers, keeps and gatehouses keep their size (a curtain or a yard wall round the pocket grows with it)
      walls: p.walls.map((w) => { const grow = !w.row && w.shape !== "line" && (w.kind === "wall" || w.kind === "curtain") && w.size >= p.radius * 0.5;
        return { ...w, at: sc(w.at), ...(grow ? { size: r2(Math.min(60, w.size * s)), ...(w.depth ? { depth: r2(Math.min(60, w.depth * s)) } : {}) } : {}), ...(w.points ? { points: w.points.map((q) => sc(q as V2)) } : {}) }; }),
      dressing: p.dressing ? { ...p.dressing, ...(p.dressing.radius ? { radius: r2(Math.min(40, p.dressing.radius * s)) } : {}) } : null };
  });
  return { ...a, pockets, propRequests: a.propRequests.map((q) => (scales.has(q.pocket) ? { ...q, at: [r2(q.at[0] * scales.get(q.pocket)!), r2(q.at[1] * scales.get(q.pocket)!)] as V2 } : q)) };
}

/** A burnt house shell (wall `shell: "burnt"`) stands this tall (clamped into the range; a lower wall is raised to the default). */
export const BURNT_SHELL_M = { min: 4, max: 5, default: 4.5 } as const;
/** The wall as built: a burnt shell raised to BURNT_SHELL_M (its landmark height with it); every other wall unchanged. */
export function burntShell<W extends { shell?: string; height: number; landmark?: { height: number } | null }>(w: W): W {
  if (w.shell !== "burnt") return w;
  const h = w.height < BURNT_SHELL_M.min ? BURNT_SHELL_M.default : Math.min(BURNT_SHELL_M.max, w.height);
  return { ...w, height: h, ...(w.landmark ? { landmark: { ...w.landmark, height: Math.max(w.landmark.height, h) } } : {}) };
}
/** `--set k=v` overrides on the raw archetype JSON (before parsing). `<pocket>.<slot>=<prefab>` swaps a structure; any
 *  other dotted path sets a field (`spread.medium=100`, `core.radius=12`, `route.width=3`). Values parse as JSON when they can. */
export function applySets(raw: any, sets: string[]): any {
  const a = structuredClone(raw);
  for (const s of sets) {
    const i = s.indexOf("="); if (i < 1) throw new Error(`--set ${s}: expected key=value`);
    const key = s.slice(0, i).split("."), text = s.slice(i + 1);
    let val: unknown; try { val = JSON.parse(text); } catch { val = text; }
    const pocket = (a.pockets ?? []).find((p: any) => p.id === key[0]);
    if (pocket && key.length === 2 && (pocket.structures ?? []).some((x: any) => x.id === key[1])) { pocket.structures.find((x: any) => x.id === key[1]).prefab = val; continue; }
    // `<pocket>.<wall or structure>.<field>=v` sets a field of that wall / structure (`core.croft.shell=burnt`)
    const piece = pocket && key.length >= 3 ? [...(pocket.walls ?? []), ...(pocket.structures ?? [])].find((x: any) => x.id === key[1]) : undefined;
    if (piece) { let t: any = piece; for (const k of key.slice(2, -1)) t = t[k] ??= {}; t[key[key.length - 1]!] = val; continue; }
    let o: any = pocket ?? a; const path = pocket ? key.slice(1) : key;
    for (const k of path.slice(0, -1)) o = o[k] ??= {};
    o[path[path.length - 1]!] = val;
  }
  return a;
}

/** The archetype a brief place fits best (most `fits` words in its id/name/read/landmark), or null. */
export function pickArchetype(place: { id: string; name?: string; read?: string; landmark?: string }, archetypes: PlaceArchetype[]): PlaceArchetype | null {
  const text = `${place.id} ${place.name ?? ""} ${place.read ?? ""} ${place.landmark ?? ""}`.toLowerCase();
  let best: PlaceArchetype | null = null, score = 0;
  for (const a of archetypes) { const s = a.fits.filter((w) => text.includes(w.toLowerCase())).length; if (s > score) { score = s; best = a; } }
  return best;
}

const NUMBER_WORDS: Record<string, number> = { one: 1, a: 1, single: 1, two: 2, pair: 2, twin: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, dozen: 12 };
/** The number the brief puts before one of `nouns` ("five turf-roofed stone huts" -> 5, "3 crofts" -> 3), up to three
 *  words between; the largest such count; null when none is named. */
export function briefCount(text: string | undefined, nouns: string[]): number | null {
  if (!text) return null;
  const re = new RegExp(`\\b(\\d+|${Object.keys(NUMBER_WORDS).filter((w) => w !== "a").join("|")})\\b((?:[\\s,]+[a-z'-]+){0,3}?)[\\s,]+(?:${nouns.map((n) => n.replace(/[^a-z-]/gi, "")).join("|")})(?:s|es)?\\b`, "gi");
  let best: number | null = null;
  for (const m of text.matchAll(re)) { const n = /^\d+$/.test(m[1]!) ? +m[1]! : NUMBER_WORDS[m[1]!.toLowerCase()]!; if (n > 0 && (best === null || n > best)) best = n; }
  return best;
}
/** L (owner ruling 2026-10-24, Exiles' Bell's 5 m "chapel" box): buildings come from the WFC kit, ruined and burnt ones
 *  too; a wall-operator shell standing in for one is never a building. Why `w` is such a shell (a kind `wall` square or
 *  line >= 1.5 m tall that is a `row`, has a `shell` state, or whose id names a building), or null for a dyke / yard wall. */
export const BUILDING_WORDS = /(^|-)(house|croft|hut|byre|hall|chapel|kirk|church|shed|barn)s?(-|$)/;
export function shellStandIn(w: { id: string; kind: string; shape: string; height: number; row?: unknown; shell?: string }): string | null {
  if (w.kind !== "wall" || (w.shape !== "square" && w.shape !== "line") || w.height < 1.5) return null;
  return w.row ? "a row of shells" : w.shell ? `shell: ${w.shell}` : BUILDING_WORDS.test(w.id) ? `its id names a building` : null;
}
/** The archetype with every wall `row` expanded into its N shells (square walls `<id>-1..N` along x, the landmark on
 *  the middle one) and each pocket's radius grown to hold its row (half its length + 2 m). N = the brief's count
 *  (`briefCount` over `place.text`), else `row.count`, capped at `row.max`. Idempotent (expanded walls carry no row). */
export function expandRows(a: PlaceArchetype, place: { size: PlaceTier; text?: string }, notes?: string[]): PlaceArchetype {
  if (!a.pockets.some((p) => p.walls.some((w) => w.row))) return a;
  const pockets = a.pockets.map((p) => {
    let radius = p.radius;
    const walls = p.walls.flatMap((w) => {
      if (!w.row || w.shape !== "square") return [w];
      const said = briefCount(place.text, w.row.nouns), n = Math.max(1, Math.min(w.row.max, said ?? w.row.count)), [W, D] = w.row.size[place.size], step = W + w.row.gap;
      notes?.push(`${p.id}.${w.id}: a row of ${n} shells ${W} x ${D} m (${said === null ? `no number before ${w.row.nouns.join("/")} in the brief: default ${w.row.count}` : `the brief names ${said}${said > n ? `, capped at ${w.row.max}` : ""}`})`);
      radius = Math.max(radius, Math.min(40, (n * W + (n - 1) * w.row.gap) / 2 + 2));
      const mid = Math.floor((n - 1) / 2);
      return Array.from({ length: n }, (_, i) => ({ ...w, id: `${w.id}-${i + 1}`, size: W / 2, depth: D / 2, at: [r2(w.at[0] + (i - (n - 1) / 2) * step), w.at[1]] as V2, row: undefined, landmark: i === mid ? w.landmark : null }));
    });
    return { ...p, radius, walls };
  });
  return { ...a, pockets };
}

// ---------------------------------------------------------------------------------------------------------------------
// The planner (pure: the ground is a function, so it is deterministic and testable)

export interface PlaceGround { height(x: number, z: number): number; wet(x: number, z: number): boolean; /** water surface y where wet (optional) */ waterY?(x: number, z: number): number | null }
export interface PlaceInput {
  world: string; zone: string; project: string;
  /** `text`: the brief place's read + landmark + features (row counts, ring switches); `culture`: the brief's people
   *  when it names them (overrides the archetype's dressing culture). */
  place: { id: string; name: string; size: PlaceTier; at: [number, number]; faces?: string; text?: string; culture?: string[] };
  /** Lakes near the place (recipe features.lakes: centre, radius, waterY) for a water-anchored ring. */
  waters?: { id: string; center: [number, number]; radius: number; waterY: number }[];
  /** The world's scatter rule ids (a ring's scatter entries take the first that exists); omitted = not checked. */
  scatterRules?: string[];
  reservation: { center: [number, number]; radius: number; approaches: [number, number][][] };
  /** The catalogue's dressing declaration of a prop (cultures), when the caller can read it; omitted = not checked. */
  propInfo?: (prefab: string) => { cultures?: string[]; size?: number[] } | null;
  /** A catalogued piece's texel density (tx/m), for the scale floor. */
  texelsOf?: (prefab: string) => number | null;
  /** Highest mesh surface (m, prefab frame, unscaled) of a catalogued piece over a local point; null off its mesh. */
  topOf?: (prefab: string, x: number, z: number) => number | null;
  /** A catalogued piece's marker (prefab frame, unscaled: position [x, y, z], size [x, y, z]) from its <model>.markers.json; null when none. */
  markerOf?: (prefab: string, id: string) => { position: [number, number, number]; size: [number, number, number] } | null;
  /** Quest objects the zone's quest plan declares at this place (kind object/readable); each needs `a.quest[id]`. */
  questObjects?: { id: string; kind: string; what?: string }[];
  /** Pocket centres chosen by `siteSearch` (level, dry, connected ground): each pocket's fit only refines within 4 m. */
  pocketAt?: Record<string, [number, number]>;
  /** The zone's BUILT stone (role -> material id: face, cap, footing, ...; place-build zone defaults `builtStone`): every wall
   *  whose archetype gives no materials takes it. L (art, Hagsheer 2026-10-21): {} meant the terrain cliff tile. */
  builtStone?: Record<string, string>;
  /** Role materials per BUILT wall kind (place-build zone defaults `builtKinds`: { curtain: { face, cap, buttress, pier, footing }, keep, tower, gatehouse }). Use coherent architectural assignments; variant lists are explicit authored patterns, never an automatic response to texture repetition or variety counts. */
  builtKinds?: Record<string, Record<string, string | string[]>>;
  /** A structure prefab's base outline (place-build: from its triangles, baseOutline); omitted/null = seated at its centre. */
  structureBase?: (prefab: string) => BaseOutline | null;
  /** Whether a material asset id exists in the closure (a skirt takes the structure's own base material when it does). */
  materialExists?: (id: string) => boolean;
  /** The world's existing roads, paths and trails (recipe features.roads, other places' approach tracks left out): the
   *  approach track starts on the nearest within TRACK_JOIN_M. Omitted / none near = it starts where the approach line is joined. */
  roads?: { id: string; points: [number, number][] }[];
  /** The owner's composition (<job>/layout.json); the archetype passed in is already `withLayout`. Its pieces are placed
   *  exactly or refused (faults "LAYOUT: ..."), its ground patches painted. */
  layout?: PlaceLayout;
  /** Whether a prefab id is in the world's closure (layout pieces); omitted = all are. */
  catalogued?: (prefab: string) => boolean;
  /** The recipe's surface names (recipe.surfaces[].name), for layout ground patches. */
  /** The closure catalogues WFC kit buildings (any `wfc-ruins/` prefab): a wall-operator building shell is then a refusal. */
  kitBuildings?: boolean;
  surfaces?: string[];
  /** recipe.surfaces[].color by name: `wear` ground takes the darkest candidate. */
  surfaceColors?: Record<string, string>;
}
type V2 = [number, number];
const r2 = (n: number) => Math.round(n * 100) / 100;
const dist = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const segDist = (q: V2, a: V2, b: V2) => { const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dz) / L)); return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dz); };
/** Metres an evidence view's body and camera keep past every structure footprint and wall line. */
export const CAMERA_CLEAR_M = 1.5;

/** The place frame: +z (front) toward the approach. Brief `faces` ("E down trail-x") wins (tools/_compass.mts: N = -Z, E = +X, the one compass), else the nearest approach point >= 40 m. */
export function placeFacing(at: V2, faces: string | undefined, approaches: V2[][]): V2 {
  const named = facesDir(faces);
  if (named) return named;
  let best: V2 | null = null, bd = Infinity;
  for (const line of approaches) for (const p of line) { const d = dist(p, at); if (d >= 40 && d < bd) { bd = d; best = p; } }
  if (!best) return [0, 1];
  const l = Math.hypot(best[0] - at[0], best[1] - at[1]); return [(best[0] - at[0]) / l, (best[1] - at[1]) / l];
}
/** Place frame -> world: local (x right, z front). */
/** A placed piece's marker in the world: rotY(ang) of its scaled local point (+Z onto (sin, cos)) over its foot. Pure. */
export function waterAtMarker(host: { w: V2; ang: number; y: number; k: number }, mk: { position: [number, number, number] }): { w: V2; y: number; ang: number } {
  const [x, y, z] = mk.position.map((v) => v * host.k) as [number, number, number], c = Math.cos(host.ang), s = Math.sin(host.ang);
  return { w: [r2(host.w[0] + x * c + z * s), r2(host.w[1] - x * s + z * c)], y: r2(host.y + y), ang: host.ang };
}
export function toWorld(origin: V2, front: V2, local: V2): V2 {
  const right: V2 = [-front[1], front[0]];
  return [origin[0] + local[0] * right[0] + local[1] * front[0], origin[1] + local[0] * right[1] + local[1] * front[1]];
}
const yawOf = (front: V2) => Math.atan2(front[0], front[1]); // rotY(a) maps +Z onto front

/** Relief, wetness and the steepest step over a disc (rings of samples, 2 m apart). */
export function discStats(g: PlaceGround, c: V2, r: number) {
  const hs: number[] = []; let wet = 0, steep = 0;
  // rings every 2 m plus the rim itself when it falls between rings: a piece under 2 m radius was sampled at its centre
  // alone, so the steep check never fired for it (L o-small 2026-10-29: a trough drawn on a rock face toe passed)
  const rings: number[] = []; for (let rr = 0; rr <= r + 1e-6; rr += 2) rings.push(rr);
  if (r - rings[rings.length - 1]! > 0.25) rings.push(r);
  rings.forEach((rr, k) => {
    const n = rr === 0 ? 1 : Math.max(6, Math.round((2 * Math.PI * rr) / 2.5)), prev = k ? rings[k - 1]! : 0;
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2, x = c[0] + rr * Math.cos(a), z = c[1] + rr * Math.sin(a); const h = g.height(x, z); hs.push(h); if (g.wet(x, z)) wet++;
      if (rr > 0) steep = Math.max(steep, Math.abs(h - g.height(c[0] + prev * Math.cos(a), c[1] + prev * Math.sin(a))) / (rr - prev)); }
  });
  hs.sort((a, b) => a - b);
  return { median: hs[hs.length >> 1]!, relief: hs[hs.length - 1]! - hs[0]!, wet, steep };
}
/** Steepest 2 m step in a ring just outside the pad (a drop beside it = a rim / cliff edge). */
function edgeDrop(g: PlaceGround, c: V2, r: number) {
  let d = 0;
  for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; const h0 = g.height(c[0] + (r + 2) * Math.cos(a), c[1] + (r + 2) * Math.sin(a)); const h1 = g.height(c[0] + (r + 8) * Math.cos(a), c[1] + (r + 8) * Math.sin(a)); d = Math.max(d, h0 - h1); }
  return d;
}
export const SHORE_M = 60, SHORE_RISE_M = 12;
/** Height of `c` above the nearest water within `max` (its surface; without g.waterY the last dry ground before it) (16 rays, 2 m steps);
 *  Infinity without water. With `level` (and g.waterY) only water at that level +-2 m counts: the brief's sea, not a tarn. */
export function shoreRise(g: PlaceGround, c: V2, level: number | null = null, max = SHORE_M): number {
  let best = Infinity;
  for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; let last = g.height(c[0], c[1]);
    for (let rr = 2; rr <= max; rr += 2) { const x = c[0] + rr * Math.cos(a), z = c[1] + rr * Math.sin(a);
      if (g.wet(x, z)) { const wy = g.waterY?.(x, z); if (level === null || wy == null || Math.abs(wy - level) <= 2) best = Math.min(best, g.height(c[0], c[1]) - (wy ?? last)); break; }
      last = g.height(x, z); } }
  return best;
}
/** The water level nearest `at` (rings out to `max`), or null. */
export function waterLevelNear(g: PlaceGround, at: V2, max = 250): number | null {
  if (!g.waterY) return null;
  for (let rr = 0; rr <= max; rr += 5) for (let i = 0; i < (rr ? 24 : 1); i++) { const a = (i / 24) * Math.PI * 2, y = g.waterY(at[0] + rr * Math.cos(a), at[1] + rr * Math.sin(a)); if (y != null) return y; }
  return null;
}
function nearestWet(g: PlaceGround, c: V2, max = 40) {
  for (let rr = 4; rr <= max; rr += 4) for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; if (g.wet(c[0] + rr * Math.cos(a), c[1] + rr * Math.sin(a))) return rr; }
  return max + 10;
}

/** GROUND FIT: the best pocket centre within `search` of `want` (deterministic grid, 2 m): dry, least relief, near what it prefers. */
export function fitPocket(g: PlaceGround, want: V2, p: { radius: number; search: number; near: string; maxRelief: number }, keepIn: { center: V2; radius: number }) {
  let best: { at: V2; score: number; stats: ReturnType<typeof discStats> } | null = null;
  const step = 2, n = Math.floor(p.search / step);
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const at: V2 = [want[0] + i * step, want[1] + j * step];
    if (Math.hypot(i * step, j * step) > p.search + 1e-6 || dist(at, keepIn.center) > keepIn.radius - p.radius) continue;
    const s = discStats(g, at, p.radius);
    if (s.wet > 0) continue;
    let score = s.relief + 0.04 * dist(at, want);
    if (p.near === "water") score += 0.08 * nearestWet(g, at);
    if (p.near === "edge") score -= Math.min(6, edgeDrop(g, at, p.radius)) * 0.5;
    if (!best || score < best.score - 1e-9) best = { at, score, stats: s };
  }
  if (!best) return { at: want, ok: false, why: `no dry ground for a ${p.radius} m pad within ${p.search} m of ${want.map(Math.round)}`, stats: discStats(g, want, p.radius) };
  const ok = best.stats.relief <= p.maxRelief;
  return { at: best.at, ok, why: ok ? "" : `relief ${best.stats.relief.toFixed(1)} m over the pad > ${p.maxRelief} m`, stats: best.stats };
}

/** A masked height patch levelling a pad at `y` (weights 1 inside r, smoothstep to 0 at r + feather). L: calm; raiseOnly beside a drop. */
export function padPatch(id: string, c: V2, r: number, y: number, feather: number, raiseOnly: boolean, g?: PlaceGround) {
  const R = r + feather, step = 2, cols = Math.round((2 * R) / step) + 1;
  const heights: number[] = [], weights: number[] = [];
  for (let j = 0; j < cols; j++) for (let i = 0; i < cols; i++) {
    const d = Math.hypot(-R + i * step, -R + j * step), t = Math.min(1, Math.max(0, (d - r) / feather));
    // L (lips, no filled gorges): past the pad edge the weight fades with the height gap, so a pad on a rim never ramps out over the drop
    const x = c[0] - R + i * step, z = c[1] - R + j * step, gap = g && d > r ? Math.abs(g.height(x, z) - y) : 0, keep = Math.min(1, Math.max(0, 1 - (gap - 1.5) / 2.5));
    heights.push(r2(y)); weights.push(r2((1 - t * t * (3 - 2 * t)) * keep));
  }
  // L (lips gate): a wide smoothstep feather, the tent prefilter and a soft automatic edge keep the 2 m lattice from drawing teeth
  return { edit: "add-feature", kind: "heightPatches", feature: { id, origin: [r2(c[0] - R), r2(c[1] - R)], size: [2 * R, 2 * R], columns: cols, rows: cols, heights, weights, blend: 2, edgeSlope: 0.6, filter: 2, calm: true, ...(raiseOnly ? { raiseOnly: true } : {}) } };
}

/** L (Red Dial 2026-10-30): a LEVEL pad (cut + fill) over a turned rectangle (`half` in the piece's frame, turned `yaw` like a
 *  structure, three.js about +Y), feathered `feather` m past its edge with padPatch's smoothstep and rim fade. */
export function rectPadPatch(id: string, c: V2, half: [number, number], yaw: number, y: number, feather: number, g?: PlaceGround) {
  const R = Math.hypot(half[0], half[1]) + feather, step = 2, cols = Math.round((2 * R) / step) + 1, cs = Math.cos(yaw), sn = Math.sin(yaw);
  const heights: number[] = [], weights: number[] = [];
  for (let j = 0; j < cols; j++) for (let i = 0; i < cols; i++) {
    const dx = -R + i * step, dz = -R + j * step, lx = dx * cs - dz * sn, lz = dx * sn + dz * cs; // world offset -> the piece's frame (inverse of toWorldYaw)
    const ox = Math.max(0, Math.abs(lx) - half[0]), oz = Math.max(0, Math.abs(lz) - half[1]), d = Math.hypot(ox, oz), t = Math.min(1, d / feather);
    const x = c[0] + dx, z = c[1] + dz, gap = g && d > 0 ? Math.abs(g.height(x, z) - y) : 0, keep = Math.min(1, Math.max(0, 1 - (gap - 1.5) / 2.5));
    heights.push(r2(y)); weights.push(r2((1 - t * t * (3 - 2 * t)) * keep));
  }
  return { edit: "add-feature", kind: "heightPatches", feature: { id, origin: [r2(c[0] - R), r2(c[1] - R)], size: [2 * R, 2 * R], columns: cols, rows: cols, heights, weights, blend: 2, edgeSlope: 0.6, filter: 2, calm: true } };
}

/** L (walk, fowlers-drop 2026-10-21): a tower's door spans ONE face: a 2.4 m door on a 12-sided 4.5 m tower (2.33 m faces)
 *  crossed two corners and a corner's mitre stood in the passage (10 STUCK). Fewer sides (multiples of 4, at least 8)
 *  until the face holds the door + 0.4 m each side. */
export function towerSides(w: Pick<z.infer<typeof placeWallSchema>, "sides" | "size" | "gate">): number {
  let n = w.sides;
  while (w.gate > 0 && n > 8 && 2 * w.size * Math.sin(Math.PI / n) < w.gate + 0.8) n -= 4;
  return n;
}
function wallPoints(w: z.infer<typeof placeWallSchema>): { pts: V2[]; front: number | null; back: number | null; smooth: boolean } {
  if (w.shape === "line") return { pts: w.points as V2[], front: null, back: null, smooth: true };
  if (w.shape === "square") { const h = w.size, d = w.depth ?? w.size;
    // a basin open at one end (a sluice chute: its gate, not a wall, holds the water there) is a U, not a ring
    if (w.basin?.open === "back") return { pts: [[h, -d], [h, d], [-h, d], [-h, -d]], front: h + 2 * d, back: null, smooth: false };
    if (w.basin?.open === "front") return { pts: [[-h, d], [-h, -d], [h, -d], [h, d]], front: null, back: h + 2 * d, smooth: false };
    return { pts: [[-h, -d], [h, -d], [h, d], [-h, d], [-h, -d]], front: 3 * h + 2 * d, back: h, smooth: false }; }
  // ring from the left (local -x): the back (-z) at a quarter, the front (+z) at three quarters. A tower is a mitred
  // polygon of `sides` (L op-apply: a closed smooth ring's collider solids self-intersect); its stations are the chords'
  const tower = w.kind === "tower", n = tower ? towerSides(w) : 16, pts: V2[] = [];
  // (a tower's vertices half a step round, so its door and the front of its walk are a flat face, not a corner)
  for (let i = 0; i <= n; i++) { const a = ((i + (tower ? 0.5 : 0)) / n) * Math.PI * 2; pts.push([r2(-Math.cos(a) * w.size), r2(-Math.sin(a) * w.size)]); }
  if (tower) { const chord = 2 * w.size * Math.sin(Math.PI / n); return { pts, front: r2(chord * ((3 * n) / 4 - 0.5)), back: r2(chord * (n / 4 - 0.5)), smooth: false }; }
  return { pts, front: (3 * Math.PI * w.size) / 2, back: (Math.PI * w.size) / 2, smooth: true };
}
/** A closed wall round the pocket centre (a yard, a kirkyard): its routes go through its gates. */
const encloses = (w: z.infer<typeof placeWallSchema>, r: number) => w.shape !== "line" && Math.hypot(w.at[0], w.at[1]) < 1 && w.size >= r * 0.5;

/** L (walk): where a body stands in a pocket — its centre, or the nearest of a few points toward the approach that keeps
 *  2 m from every structure footprint and wall line, so routes, dressing areas and clearings never end inside a wall or a kiln. */
export function standPoint(p: z.infer<typeof placePocketSchema>, at: V2, front: V2): V2 {
  const clearOf = pocketClearance(p);
  for (const c of [[0, 0], [0, 3], [3, 3], [-3, 3], [0, 6], [4, 6], [-4, 6], [0, 9]] as V2[]) if (clearOf(c) >= 2) return toWorld(at, front, c).map(r2) as V2;
  // L (Red Dial 2026-10-29: a 24 x 18 m plinth over the core centre put every stand inside it; all routes "no walkable
  // way"): further out toward the approach, nearest first, inside the pocket
  const far: V2[] = [];
  for (let d = 12; d <= p.radius - 1; d += 3) for (const x of [0, 4, -4, 8, -8, 12, -12]) far.push([x, d]);
  for (const c of far) if (clearOf(c) >= 2) return toWorld(at, front, c).map(r2) as V2;
  return toWorld(at, front, [0, Math.min(p.radius - 1, 9)]).map(r2) as V2;
}
/** Clearance of a pocket-local point from the pocket's structure footprints and wall lines (their half-width + 0.6 m). */
export function pocketClearance(p: z.infer<typeof placePocketSchema>): (q: V2) => number {
  const segs: [V2, V2, number][] = [];
  for (const w of p.walls) { const { pts } = wallPoints(w); for (let i = 0; i + 1 < pts.length; i++) segs.push([[pts[i]![0] + w.at[0], pts[i]![1] + w.at[1]], [pts[i + 1]![0] + w.at[0], pts[i + 1]![1] + w.at[1]], w.thickness / 2 + 0.6]); }
  const segDist = (q: V2, a: V2, b: V2) => { const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dz) / L)); return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dz); };
  return (q: V2) => Math.min(...p.structures.map((st) => dist(q, st.at) - st.footprint), ...segs.map(([a, b, r]) => segDist(q, a, b) - r), 99);
}

/** Route obstacles: discs (structures, kiln/fold rings) and wall runs (segments with a half-width), both already
 *  inflated by nothing: `routeGrid` adds the body's clearance. */
export interface RouteObstacles { discs: { at: V2; r: number }[]; segs: [V2, V2, number][]; gates?: RouteGate[] }
/** A gap in a wall (between two run ends `a` and `b`; `hw` the wall's half-width + pier projection): a body passes
 *  it on its centre line. L (walk, shielings 2026-10-20): a 1.4 m croft door is 1.0 m between pier faces, narrower than
 *  the router's 0.5 m wall clearance either side, so every route to the croft's stand had "no walkable way" and the
 *  walker was sent straight into the wall; the router now walks gates on their centre line (body 0.4 m + 0.05 m). */
/** L (walk, shielings 2026-10-20): the narrowest gate a body walks through. A wall is VOXEL ground: a pier-ended
 *  1.4-1.6 m croft/byre door is 1.0-1.2 m between piers (each reaches 0.2 m into the gap) and the mesher rounds that
 *  further, so the 0.84 m capsule stuck in both doors although the route went through their centre lines. */
export const MIN_GATE_M = 2.2;
export interface RouteGate { a: V2; b: V2; hw: number }
/** The gaps between wall run ends (a run's own two ends: an open ring's gate; or the ends of two runs: a ring cut
 *  into runs at its gates, written as one operator per run), 0.6-6 m apart; each end pairs with its nearest such end. */
export function wallGates(runs: V2[][], hw: number | number[]): RouteGate[] {
  const ends: { q: V2; run: number; hw: number }[] = [];
  // L (walk, ravenstacks 2026-10-21): an end BURIED in another run's body (a curtain cut at a gatehouse ends inside its
  // wall) is no door jamb: paired with the gatehouse's own jamb it made a phantom gate through the gatehouse corner (8 STUCK)
  const hwOf = (i: number) => (Array.isArray(hw) ? hw[i]! : hw);
  const buried = (q: V2, i: number) => runs.some((r, j) => j !== i && r.some((_, k) => k + 1 < r.length && boxDist(q, r[k]!, r[k + 1]!, hwOf(j) - 0.4) < 0.05));
  runs.forEach((r, i) => { const w = hwOf(i); if (r.length < 2 || dist(r[0]!, r[r.length - 1]!) < 0.01) return; for (const q of [r[0]!, r[r.length - 1]!]) if (!buried(q, i)) ends.push({ q, run: i, hw: w }); });
  const out: RouteGate[] = [], used = new Set<number>();
  ends.forEach((e, i) => { if (used.has(i)) return; let best = -1;
    ends.forEach((f, j) => { if (j === i || used.has(j) || (f.run === e.run && runs[e.run]!.length === 2)) return; const d = dist(e.q, f.q); if (d > 0.6 && d <= 6 && (best < 0 || d < dist(e.q, ends[best]!.q))) best = j; });
    if (best >= 0) { used.add(i); used.add(best); out.push({ a: e.q, b: ends[best]!.q, hw: Math.max(e.hw, ends[best]!.hw) }); } });
  return out;
}
/** q stands in a gate's walkable strip: on its centre line within (half-width - pier 0.2 - body 0.45) along the wall,
 *  and within the wall's half-width + 2 m across it. */
export const inGate = (gt: RouteGate, q: V2) => { const L = dist(gt.a, gt.b) || 1, ux = (gt.b[0] - gt.a[0]) / L, uz = (gt.b[1] - gt.a[1]) / L, cx = (gt.a[0] + gt.b[0]) / 2, cz = (gt.a[1] + gt.b[1]) / 2;
  const al = Math.abs((q[0] - cx) * ux + (q[1] - cz) * uz), ac = Math.abs((q[0] - cx) * -uz + (q[1] - cz) * ux); return al <= Math.max(0.05, Math.min(L / 2 - 0.65, GATE_LINE_M)) && ac <= gt.hw + 2; };
/** L (walk, shielings 2026-10-21: STUCK in a 2.95 m pen gate): a taut leg may cross a gate at most this far off its centre
 *  line (the strip had allowed half the gap - 0.65 m, and a diagonal through a 0.7 m thick ring met the pier). */
export const GATE_LINE_M = 0.3;
/** Distance from q to a wall run's footprint: the segment as a box `hw` either side, ending 0.2 m past each end (the
 *  wall operator's end pier spans -0.2 .. pierWidth - 0.2 along the line), so a gate gap keeps its square edges. */
const boxDist = (q: V2, a: V2, b: V2, hw: number) => { const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1, ux = dx / L, uz = dz / L, t = (q[0] - a[0]) * ux + (q[1] - a[1]) * uz, side = Math.abs((q[0] - a[0]) * -uz + (q[1] - a[1]) * ux);
  return Math.hypot(Math.max(0, t < 0 ? -t - 0.2 : t - L - 0.2), Math.max(0, side - hw)); };
/** L (walk): a route leg is PLANNED over the ground, never drawn straight: A* on a 1 m grid round the leg, blocked by
 *  water, structures (footprint + 0.8 m), wall runs (their pier-wide footprint + 0.5 m: a body passes gates, never walls) and ground
 *  steeper than `maxSlope` (the character slides at 40 deg); steps steeper than `prefer` (the footpath's maxGrade) cost
 *  extra, so the path follows the contours instead of cutting a 4 m grade into a gully side. The cell path is pulled
 *  taut (a straight run kept only where every 0.5 m sample is free and no 2 m step is steeper than `prefer` or the cells it replaces).
 *  Returns the waypoints from `from` to `to` (both included), or null when the ground holds no way. */
/** A body can stand at q: dry, clear of every disc (r + cl) and wall run (its footprint + 0.5 m). */
export const pointFree = (g: PlaceGround, obs: RouteObstacles, q: V2, cl = 0.8) => !g.wet(q[0], q[1]) && obs.discs.every((d) => dist(q, d.at) >= d.r + cl) && ((obs.gates ?? []).some((gt) => inGate(gt, q)) || obs.segs.every(([a, b, hw]) => boxDist(q, a, b, hw) >= 0.5));
/** The straight walk a -> b (0.5 m samples) touches no obstacle and no water. */
export const lineFree = (g: PlaceGround, obs: RouteObstacles, a: V2, b: V2) => { const n = Math.max(1, Math.ceil(dist(a, b) / 0.5)); for (let t = 0; t <= n; t++) if (!pointFree(g, obs, [a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n])) return false; return true; };
export function routeGrid(g: PlaceGround, from: V2, to: V2, obs: RouteObstacles, o: { maxSlope?: number; prefer?: number; margin?: number; clearance?: number } = {}): V2[] | null {
  const maxSlope = o.maxSlope ?? 0.7, prefer = o.prefer ?? 0.35, cl = o.clearance ?? 0.8;
  // room to wind: a climb of dh at `prefer` needs dh / prefer of run, so the search box grows with the climb
  const margin = o.margin ?? Math.max(30, Math.min(150, (0.6 * Math.abs(g.height(from[0], from[1]) - g.height(to[0], to[1]))) / prefer));
  const free = (q: V2) => pointFree(g, obs, q, cl);
  const x0 = Math.min(from[0], to[0]) - margin, z0 = Math.min(from[1], to[1]) - margin;
  const span = Math.max(Math.abs(from[0] - to[0]), Math.abs(from[1] - to[1])) + 2 * margin, s = Math.max(1, span / 400);
  const nx = Math.ceil((Math.max(from[0], to[0]) + margin - x0) / s) + 1, nz = Math.ceil((Math.max(from[1], to[1]) + margin - z0) / s) + 1, N = nx * nz;
  const H = new Float64Array(N), ok = new Uint8Array(N), P = (k: number): V2 => [x0 + (k % nx) * s, z0 + Math.floor(k / nx) * s];
  for (let k = 0; k < N; k++) { const q = P(k); H[k] = g.height(q[0], q[1]); ok[k] = free(q) ? 1 : 0; }
  const cell = (q: V2) => Math.min(nz - 1, Math.max(0, Math.round((q[1] - z0) / s))) * nx + Math.min(nx - 1, Math.max(0, Math.round((q[0] - x0) / s)));
  // the ground's own slope (central differences): a grid path must not zigzag up a 40 deg bank 1 m at a time
  const grad = new Float64Array(N);
  for (let k = 0; k < N; k++) { const i = k % nx, j = Math.floor(k / nx), l = i > 0 ? k - 1 : k, r = i < nx - 1 ? k + 1 : k, u = j > 0 ? k - nx : k, d = j < nz - 1 ? k + nx : k;
    grad[k] = Math.hypot((H[r]! - H[l]!) / (s * ((r - l) || 1)), (H[d]! - H[u]!) / (s * (((d - u) / nx) || 1))); if (grad[k]! > maxSlope) ok[k] = 0; }
  // gates: the cells their centre line crosses are open (where the ground allows), each snapped onto that line
  const snap = new Map<number, V2>();
  for (const gt of obs.gates ?? []) { const L = dist(gt.a, gt.b) || 1, ux = (gt.b[0] - gt.a[0]) / L, uz = (gt.b[1] - gt.a[1]) / L, cx = (gt.a[0] + gt.b[0]) / 2, cz = (gt.a[1] + gt.b[1]) / 2, ext = gt.hw + 2;
    for (let t = -ext; t <= ext + 1e-9; t += s / 4) { const q: V2 = [cx - uz * t, cz + ux * t], k = cell(q);
      if (q[0] < x0 || q[1] < z0 || q[0] > x0 + (nx - 1) * s || q[1] > z0 + (nz - 1) * s || g.wet(q[0], q[1]) || grad[k]! > maxSlope || !obs.discs.every((d) => dist(q, d.at) >= d.r + cl)) continue; ok[k] = 1; if (!snap.has(k)) snap.set(k, q); } }
  const a = cell(from), b = cell(to); ok[a] = 1; ok[b] = 1; // the ends are chosen stand points
  const G = new Float64Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), heap: [number, number][] = [];
  const push = (f: number, k: number) => { heap.push([f, k]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p]![0] <= heap[i]![0]) break; [heap[p], heap[i]] = [heap[i]!, heap[p]!]; i = p; } };
  const pop = () => { const top = heap[0]!, last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l; if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i]!, heap[m]!]; i = m; } } return top; };
  const hx = (k: number) => dist(P(k), P(b));
  G[a] = 0; push(hx(a), a);
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
  while (heap.length) {
    const [f, k] = pop(); if (k === b) break; if (f > G[k]! + hx(k) + 1e-9) continue;
    const i = k % nx, j = Math.floor(k / nx);
    for (const [di, dj] of NB) {
      const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
      const n = jj * nx + ii; if (!ok[n] || (di && dj && (!ok[j * nx + ii] || !ok[jj * nx + i]))) continue;
      const d = s * Math.hypot(di, dj), gr = Math.abs(H[n]! - H[k]!) / d; if (gr > maxSlope) continue;
      const c = G[k]! + d * (1 + gr + (gr > prefer ? 40 * (gr - prefer) : 0));
      if (c < G[n]!) { G[n] = c; came[n] = k; push(c + hx(n), n); }
    }
  }
  if (!Number.isFinite(G[b]!)) return null;
  const cells: number[] = []; for (let k = b; k !== -1; k = came[k]!) cells.unshift(k);
  const pts: V2[] = [from, ...cells.slice(1, -1).map((k) => snap.get(k) ?? P(k)).filter((q) => dist(q, from) >= 1.5 && dist(q, to) >= 1.5), to];
  // pull taut: keep a straight run only where it is free and no steeper than the cells it replaces (or `prefer`)
  // the raw path's own grade at a 3-step scale (a 1 m zigzag is not a switchback): a taut run may be no steeper
  const hp = pts.map((q) => g.height(q[0], q[1])), step = pts.map((q, k) => { const e = Math.min(pts.length - 1, k + 3); return e > k ? Math.abs(hp[e]! - hp[k]!) / (dist(q, pts[e]!) || 1) : 0; });
  let lim = prefer;
  const clear = (p: V2, q: V2) => { const L = dist(p, q), n = Math.max(1, Math.ceil(L / 0.5)); let prev = g.height(p[0], p[1]), since = 0;
    for (let t = 1; t <= n; t++) { const x: V2 = [p[0] + ((q[0] - p[0]) * t) / n, p[1] + ((q[1] - p[1]) * t) / n]; if (!free(x)) return false;
      if (++since * (L / n) >= 2 || t === n) { const h = g.height(x[0], x[1]); if (Math.abs(h - prev) / (since * (L / n)) > lim + 0.05) return false; prev = h; since = 0; } }
    return true; };
  const out: V2[] = [from]; let i = 0;
  while (i < pts.length - 1) { let j = i + 1; lim = Math.max(prefer, step[i]!); while (j + 1 < pts.length && ((lim = Math.max(lim, step[j]!)), clear(pts[i]!, pts[j + 1]!))) j++; out.push(pts[j]!); i = j; }
  return out.map((q) => q.map(r2) as V2);
}

/** Station (metres along the polyline) of the point of `pts` nearest `q`, and its distance. */
export function stationOn(pts: V2[], q: V2): { at: number; d: number } {
  let best = { at: 0, d: Infinity }, cum = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!, L = dist(a, b) || 1e-9, t = Math.max(0, Math.min(1, ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / (L * L)));
    const d = Math.hypot(q[0] - a[0] - t * (b[0] - a[0]), q[1] - a[1] - t * (b[1] - a[1]));
    if (d < best.d) best = { at: cum + t * L, d };
    cum += L;
  }
  return best;
}
/** The point at station `s` along a polyline. */
function pointAt(pts: V2[], s: number): V2 {
  let cum = 0;
  for (let i = 0; i + 1 < pts.length; i++) { const L = dist(pts[i]!, pts[i + 1]!); if (cum + L >= s || i + 2 === pts.length) { const t = Math.max(0, Math.min(1, (s - cum) / (L || 1))); return [pts[i]![0] + (pts[i + 1]![0] - pts[i]![0]) * t, pts[i]![1] + (pts[i + 1]![1] - pts[i]![1]) * t]; } cum += L; }
  return pts[0]!;
}
/** An OPEN line cut at gaps (cutRing wraps round a closed one). */
export function cutLine(pts: V2[], gaps: { at: number; width: number }[]): V2[][] {
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + dist(pts[i - 1]!, pts[i]!));
  const L = cum[cum.length - 1]!, at = (s: number): V2 => pointAt(pts, s).map(r2) as V2;
  const cuts = [...gaps].sort((m, n) => m.at - n.at).map((x) => [x.at - x.width / 2, x.at + x.width / 2] as const), runs: V2[][] = [];
  let s0 = 0;
  for (const [g0, g1] of [...cuts, [L, L] as const]) {
    const s1 = Math.min(L, g0);
    if (s1 - s0 >= 1) runs.push([at(s0), ...pts.filter((_, k) => cum[k]! > s0 + 0.05 && cum[k]! < s1 - 0.05).map((q) => q.map(r2) as V2), at(s1)]);
    s0 = Math.max(s0, g1);
  }
  return runs;
}

/** The wall operator docs of a BUILT wall kind (curtain, tower, keep, gatehouse; LANDMARKS 2026-10-21): KISS masonry from
 *  the one wall mesher (planar 40 tx/m UVs on every face incl. coping, parapet and merlon tops), no footing step (built
 *  pieces cross each other: a footing met another's coplanar), towers / keeps / gatehouses level-topped on the pocket's
 *  ground (`topY` = y + height; the body runs down past the lowest ground), curtains following the ground with
 *  buttresses. Gates and doors are round-arched openings; a curtain with a gatehouse standing on its line is CUT there
 *  (the runs end inside the gatehouse's side walls, the passage is the gatehouse's). */
export function builtWall(wl: z.infer<typeof placeWallSchema>, walls: z.infer<typeof placeWallSchema>[], doc: any, y: number, gf: number | null, gb: number | null, notes: string[]): any[] {
  const out = { ...doc, smooth: false, footing: null };
  // towers, keeps and gatehouses run deeper than a curtain they stand on (bury 1.1 vs 0.6 m): their buried undersides
  // never share a plane (zfight, ravenstacks 2026-10-21: a corner tower and its curtain, 16.7 m2)
  // ... and stand near plumb (batter 0.02/m): a 14 m gatehouse at the default 0.06 closed its 3 m passage to 1.3 m at the
  // foot (walk STUCK, ravenstacks 2026-10-21)
  if (wl.kind !== "curtain") { out.heightMode = "level"; out.topY = r2(y + wl.height); out.bury = 1.1; out.batter = 0.02; }
  if ((wl.top ?? "crenel") === "crenel") out.parapet = structuredClone(CRENEL_PARAPET);
  if (wl.kind === "curtain") out.buttresses = { every: 9, side: "both" };
  const gh = r2(Math.min(wl.height - 1.5, wl.gateHeight ?? Math.max(3.5, 1.5 * wl.gate))), gw = Math.max(MIN_GATE_M, wl.gate);
  const openings: any[] = [];
  if (wl.gate && gf !== null) openings.push({ name: wl.kind === "curtain" ? "gate" : "door", at: r2(gf), width: gw, height: gh, arch: true });
  if (wl.kind === "gatehouse" && wl.gate && gb !== null) openings.push({ name: "back-door", at: r2(gb), width: gw, height: gh, arch: true });
  for (const w of towerWindows(wl, out.points, gf)) { const { light: _l, ...o } = w; openings.push(o); }
  if (wl.kind !== "curtain") { if (openings.length) out.openings = openings.sort((m, n) => m.at - n.at); return [out]; }
  // a curtain: cut where a gatehouse stands on its line (pocket-local frame; the world frame is a rigid turn of it)
  const local = wallPoints(wl).pts.map((q) => [q[0] + wl.at[0], q[1] + wl.at[1]] as V2);
  const cuts = walls.filter((x) => x.kind === "gatehouse").map((x) => ({ x, st: stationOn(local, x.at) })).filter(({ x, st }) => st.d <= wl.thickness / 2 + x.size * 0.5)
    .map(({ x, st }) => ({ at: st.at, width: 2 * x.size - 1, by: x.id }));
  if (!cuts.length) { if (openings.length) out.openings = openings; return [out]; }
  const gates = openings.filter((o) => !cuts.some((c) => Math.abs(c.at - o.at) < c.width)); // the gatehouse IS the gate there
  const runs = (wl.shape !== "line" ? cutRing : cutLine)(out.points, cuts);
  notes.push(`curtain ${wl.id}: cut at gatehouse ${cuts.map((c) => c.by).join(", ")} (${runs.length} runs)`);
  const { fog, openings: _o, ...rest } = out;
  return runs.map((run, ri) => {
    // a gate left on a run moves to the run's own stations
    const mine = gates.map((o) => { const q = pointAt(out.points, o.at), st = stationOn(run, q); return st.d < 0.5 ? { ...o, at: r2(st.at) } : null; }).filter(Boolean);
    return { ...rest, ...(ri === 0 && fog ? { fog } : {}), id: `${out.id}-${ri + 1}`, points: run, ends: { start: "none", end: "none" }, ...(mine.length ? { openings: mine } : {}) };
  });
}

/** A closed wall line cut at its gates: the runs between the gaps (each gap `width` wide round its station `at`). */
export function cutRing(pts: V2[], gaps: { at: number; width: number }[]): V2[][] {
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + dist(pts[i - 1]!, pts[i]!));
  const L = cum[cum.length - 1]!, at = (s: number): V2 => { s = ((s % L) + L) % L; let i = 1; while (i < cum.length - 1 && cum[i]! < s) i++; const t = (s - cum[i - 1]!) / (cum[i]! - cum[i - 1]! || 1), a = pts[i - 1]!, b = pts[i]!; return [r2(a[0] + (b[0] - a[0]) * t), r2(a[1] + (b[1] - a[1]) * t)]; };
  const g = [...gaps].sort((m, n) => m.at - n.at), runs: V2[][] = [];
  g.forEach((gi, i) => {
    const s0 = gi.at + gi.width / 2, nx = g[(i + 1) % g.length]!, s1 = nx.at - nx.width / 2 + (i + 1 === g.length ? L : 0);
    if (s1 - s0 < 1) return;
    const run: V2[] = [at(s0)];
    for (let k = 0; k < 2 * (cum.length - 1); k++) { const c = cum[k % (cum.length - 1)]! + (k >= cum.length - 1 ? L : 0); if (c > s0 + 0.05 && c < s1 - 0.05) run.push(pts[k % (cum.length - 1)]!.map(r2) as V2); }
    run.push(at(s1)); runs.push(run);
  });
  return runs;
}

/** Nearest point on any approach polyline (sampled every 2 m), and its distance. */
/** L (lips, tinkers-camp 2026-10-20): a footpath LANDS on the ground at both ends. The paved stretch stops at the
 *  pocket's edge (radius - 1), but a leg that comes down a flight to that edge ended its fitted ribbon 1.5 m above the
 *  ground (no room left to come down): the walled end's hard edge beside the fanned foot was a lattice alias. When the
 *  ribbon fitted on the measured ground ends more than LAND_TOL_M off it, the stretch runs on into the pocket along the
 *  planned line (pocket radius x 0.6, then x 0.3) and the stretch whose ends land best is kept. */
export const LAND_TOL_M = 0.5;
export function ribbonEndsOff(g: Pick<PlaceGround, "height">, pts: V2[], route: { width: number; style: string; maxGrade: number }): number {
  if (pts.length < 2) return Infinity;
  const ps = pts.length === 2 ? [pts[0]!, [(pts[0]![0] + pts[1]![0]) / 2, (pts[0]![1] + pts[1]![1]) / 2] as V2, pts[1]!] : pts;
  try {
    const s = fitRibbon(pathParamsSchema.parse({ points: ps.map((q) => [r2(q[0]), r2(q[1])]), width: route.width, style: route.style, maxGrade: route.maxGrade, calm: true }), { height: (x, z) => g.height(x, z) }).ribbon.samples;
    const off = (p: number[]) => Math.abs(p[1]! - g.height(p[0]!, p[2]!));
    return Math.max(off(s[0]!), off(s[s.length - 1]!));
  } catch { return Infinity; }
}
export function landedStretch(g: Pick<PlaceGround, "height">, line: V2[], discs: { at: V2; radius: number }[], outside: (poly: V2[], discs: { at: V2; radius: number }[]) => V2[], route: { width: number; style: string; maxGrade: number }): V2[] {
  let best = outside(line, discs), bestOff = ribbonEndsOff(g, best, route);
  for (const k of [0.6, 0.3]) {
    if (bestOff <= LAND_TOL_M) break;
    const pts = outside(line, discs.map((d) => ({ at: d.at, radius: Math.max(2, d.radius * k) }))), off = ribbonEndsOff(g, pts, route);
    if (off < bestOff - 0.1) { best = pts; bestOff = off; }
  }
  return best;
}
export function nearestOnApproach(at: V2, lines: V2[][], ok: (p: V2) => boolean = () => true): { p: V2; d: number; line: number } | null {
  let best: { p: V2; d: number; line: number } | null = null;
  lines.forEach((l, li) => { for (let i = 0; i + 1 < l.length; i++) { const a = l[i]!, b = l[i + 1]!, len = dist(a, b), n = Math.max(1, Math.ceil(len / 2));
    for (let k = 0; k <= n; k++) { const p: V2 = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]; const d = dist(p, at); if ((!best || d < best.d) && ok(p)) best = { p, d, line: li }; } } });
  return best;
}

export interface PlacePlan {
  centre: V2; padY: number; front: V2; yaw: number; faults: string[]; notes: string[];
  pockets: { id: string; kind: string; at: V2; y: number; radius: number; fit: ReturnType<typeof fitPocket> }[];
  worldOps: unknown[]; operators: any[]; clearings: any[]; encounters: any[]; ops: any[]; plans: any[]; handoff: any; propRequests: any[];
  /** Per dressing plan id: the props asked of it (exact counts) and, for one the plan could not take, why (dress gate). */
  requested: Record<string, { prop: string; count: number; why?: string }[]>;
  /** The archetype's / design's `views` (place frame) in world coordinates, contract-view shaped ({ name, x, z, y, camera, target }). */
  setViews: any[];
  /** Where the aerial view's body stands (the core centre unless something is built there). */
  aerial: V2;
  /** The approach TRACK: a carved + painted recipe road (place-build grades it with `worldgen road` into world-ops.json
   *  as `road-pb-<id>-approach`), from `from` (an existing road id, or "the approach line") to the core's edge. null:
   *  a pinpoint, or no walkable way. */
  track: ApproachTrack | null;
}
export interface ApproachTrack { id: string; points: V2[]; width: number; maxGrade: number; from: string; lengthM: number }

/** Plan a place: fit every pocket, level pads, place structures (catalogued prefabs), walls (wall operator), footpaths
 *  (path operator), clearings (L: cover cleared under every structure), creature clearings, a first dressing plan per
 *  pocket and the handoff (routes for poi-walk, siteDressing, measured size, viewpoints). Pure. */
/** Feather (m) of a basin bed's levelling pad past its disc: neighbouring basins keep >= 2 m of kerb-to-kerb ground. */
export const BED_FEATHER_M = 1.5;
/**
 * A basin's BED: a rectangular height patch in the kerb's own frame, full weight to the kerb's inner face, fading to
 * nothing at its OUTER face (the fade lies under the wall), so the ground outside the kerb keeps its height. L (RETTING
 * 2026-10-23): a round bed pad drawn round the pit's corners plus a 1.5 m feather cut a ditch round every pit (kerbs
 * 0.9-1.1 m over their low side, the crane beside a pit standing in it).
 */
export function bedPatch(id: string, c: V2, front: V2, hx: number, hz: number, wall: number, y: number) {
  const right: V2 = [-front[1], front[0]], ox = hx + wall, oz = hz + wall, R = Math.hypot(ox, oz) + 2, step = 2, cols = Math.round((2 * R) / step) + 1;
  const heights: number[] = [], weights: number[] = [];
  const fade = (d: number, inner: number) => { const t = Math.min(1, Math.max(0, (d - inner) / wall)); return 1 - t * t * (3 - 2 * t); };
  for (let j = 0; j < cols; j++) for (let i = 0; i < cols; i++) {
    const dx = -R + i * step, dz = -R + j * step, lx = Math.abs(dx * right[0] + dz * right[1]), lz = Math.abs(dx * front[0] + dz * front[1]);
    heights.push(r2(y)); weights.push(r2(Math.min(fade(lx, hx), fade(lz, hz))));
  }
  return { edit: "add-feature", kind: "heightPatches", feature: { id, origin: [r2(c[0] - R), r2(c[1] - R)], size: [2 * R, 2 * R], columns: cols, rows: cols, heights, weights, blend: 2, calm: true } };
}
/** A basin's contents as structures of its pocket (`<wall>-<n>`, role set-piece, at = basin centre + content offset, `on` =
 *  the earlier content's slot): they are seated on the bed (sunk when small) and stand on each other exactly as structures
 *  do. Idempotent. Pure. */
export function withBasinContents(a: PlaceArchetype): PlaceArchetype {
  return { ...a, pockets: a.pockets.map((p) => {
    const set = (id: string, at: V2, list: z.infer<typeof contentsSchema>, wall?: string) => list.map((c, i) => placeStructureSchema.parse({
      id: `${id}-${i + 1}`, role: "set-piece", prefab: c.prefab, at: [r2(at[0] + c.at[0]), r2(at[1] + c.at[1])], yaw: c.yaw, footprint: 0.6,
      ...(c.on !== undefined ? { on: `${id}-${c.on + 1}` } : {}), ...(wall && c.kerb ? { onWall: wall } : {}), ...(wall && c.prefab.startsWith("rock-kit/") ? { stone: `@wall:${wall}` } : {}) }));
    const have = new Set(p.structures.map((s) => s.id)), add = [...p.walls.flatMap((w) => set(w.id, w.at, w.basin?.contents ?? [], w.id)), ...set("floor", p.floor?.at ?? [0, 0], p.floor?.contents ?? [])].filter((s) => !have.has(s.id));
    return add.length ? { ...p, structures: [...p.structures, ...add] } : p;
  }) };
}
/** A basin's water: the sheet over the kerb's inner ground (its edge on the kerb's centre line, buried in the wall), the
 *  kerb's level top, and the scene entity. `ground` is the planned ground (pad or field). Pure. */
/** Least height a basin's kerb stands over the highest ground on its line, metres. */
export const KERB_OVER_GROUND_M = 0.25;
export function basinWater(wl: z.infer<typeof placeWallSchema>, centre: V2, front: V2, ground: (x: number, z: number) => number): { waterY: number; topY: number; lowLine: number; inner: { min: number; max: number }; corners: V2[] } {
  const b = wl.basin!, W = wl.size, D = wl.depth ?? wl.size, hx = W - wl.thickness / 2, hz = D - wl.thickness / 2;
  let max = -Infinity, min = Infinity, lowLine = Infinity, highLine = -Infinity;
  for (let x = -hx; x <= hx + 1e-6; x += Math.max(0.25, hx / 8)) for (let z = -hz; z <= hz + 1e-6; z += Math.max(0.25, hz / 8)) {
    const q = toWorld(centre, front, [x, z]), h = ground(q[0], q[1]); max = Math.max(max, h); min = Math.min(min, h); }
  const ring: V2[] = [[-W, -D], [W, -D], [W, D], [-W, D]];
  for (let i = 0; i < 4; i++) { const p0 = ring[i]!, p1 = ring[(i + 1) % 4]!; for (let t = 0; t <= 1 + 1e-6; t += 0.1) { const q = toWorld(centre, front, [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t]); const h = ground(q[0], q[1]); lowLine = Math.min(lowLine, h); highLine = Math.max(highLine, h); } }
  const waterY = r2(max + b.level);
  // the kerb clears the highest ground on its own line (a pit DUG into a rise: a level kerb at water + kerb was buried
  // on the high side and the ground cut the sheet into a blob, RETTING 2026-10-23); the water then lies lower in it
  return { waterY, topY: r2(Math.max(waterY + b.kerb, highLine + KERB_OVER_GROUND_M)), lowLine: r2(lowLine), inner: { min: r2(min), max: r2(max) }, corners: ring };
}

export function planPlace(a: PlaceArchetype, inp: PlaceInput, g: PlaceGround): PlacePlan {
  const { place, reservation } = inp, poi = place.id, faults: string[] = [], notes: string[] = [];
  const asked = new Map(a.pockets.map((p) => [p.id, p.dressing?.props ?? []] as const)), requested: PlacePlan["requested"] = {};
  for (const w of a.pockets.flatMap((p) => p.walls)) { const why = shellStandIn(w); if (!why) continue;
    // Owner ruling 2026-10-24 (second): the wall operator is a fine way to build; kit and custom builds mix. So this is a
    // NOTE pointing at the kit alternative when one exists, never a refusal.
    notes.push(`${w.id} is a wall-operator shell (${why})${inp.kitBuildings ? " — the kit has ruins too (wfc-ruins/*), a layout structure piece can take one" : ""}`); }
  a = withoutDenied(withBasinContents(expandRows(place.culture?.length ? { ...a, culture: place.culture } : a, place, notes)), inp.propInfo, faults, notes);
  const spread = a.spread[place.size], tags = ["poi", `zone:${inp.zone}`, `poi:${poi}`];
  const front = placeFacing(place.at, place.faces, reservation.approaches), yaw = yawOf(front);
  // the tier wins over a tight reservation (the size gate measures the footprint): pockets may reach spread + 30 m from it
  const keepIn = { center: reservation.center, radius: Math.max(reservation.radius, dist(place.at, reservation.center) + 1.25 * spread + 30) };
  const pockets: PlacePlan["pockets"] = [];
  for (const p of a.pockets) {
    const origin = pockets[0]?.at ?? place.at;
    const chosen = inp.pocketAt?.[p.id];
    const reach = p.id === "core" ? Infinity : spreadReach(a, a.pockets[0]!, p), nominal: V2 = [p.at[0] * spread, p.at[1] * spread], nl = Math.hypot(nominal[0], nominal[1]);
    const local: V2 = nl > reach ? [nominal[0] * (reach / nl), nominal[1] * (reach / nl)] : nominal; // spreadMax caps the offset
    const mine = inp.layout && p.id !== "core" ? inp.layout.pieces.filter((q) => q.pocket === p.id && q.kind !== "decal") : [];
    const cen: V2 | null = mine.length ? [mine.reduce((m, q) => m + q.at[0], 0) / mine.length, mine.reduce((m, q) => m + q.at[1], 0) / mine.length] : null;
    const want = cen ? toWorld(origin, front, cen) : p.id === "core" && inp.layout?.origin ? inp.layout.origin : chosen ?? (p.id === "core" ? place.at : toWorld(origin, front, local));
    // a SIGHT with no pad (stilt huts in the shallows across the bay) stands where it is drawn: no dry-pad fit, its pieces seat on the bed
    const fitR = p.fit ?? p.radius, fit = (p.sight && !p.pad) || cen || (inp.layout?.origin && p.id === "core") ? { at: want, ok: true, why: "", stats: discStats(g, want, fitR) } : fitPocket(g, want, chosen ? { ...p, radius: fitR, search: Math.min(p.search, 4) } : { ...p, radius: fitR, search: Math.min(p.search, Math.max(2, reach - dist(want, origin))) }, keepIn);
    if (!fit.ok) faults.push(`pocket ${p.id}: ${fit.why}`);
    pockets.push({ id: p.id, kind: p.kind, at: fit.at, y: fit.stats.median, radius: p.radius, fit });
  }
  const core = pockets[0]!, padY = r2(core.y);
  // THE LAYOUT (TOOLS-LAYOUT 2026-10-24): every piece where the owner put it, or a refusal naming it; nothing moved
  const L = inp.layout, layoutWorld = new Map<string, { w: V2; half: V2 | null }>(), refused = new Set<string>();
  if (L) {
    const why = (id: string, w: string) => faults.push(`LAYOUT: piece ${id}: ${w}`);
    for (const q of L.pieces) {
      const w = toWorld(core.at, front, q.at), size = inp.propInfo?.(q.prefab)?.size, half = pieceHalf(q, size);
      layoutWorld.set(q.id, { w, half });
      if (inp.catalogued && !inp.catalogued(q.prefab)) { why(q.id, `${q.prefab} is not catalogued in the world's closure`); refused.add(q.id); continue; }
      if (q.pocket && !a.pockets.some((k) => k.id === q.pocket)) why(q.id, `pocket ${q.pocket} is no pocket of the archetype (${a.pockets.map((k) => k.id).join(", ")})`);
      if (q.kind === "fire" && !FIRE_PREFABS.includes(q.prefab)) why(q.id, `a fire must be a catalogued vfx fire (${q.prefab} is not in FIRE_PREFABS)`);
      if (!half) notes.push(`LAYOUT: piece ${q.id}: ${q.prefab} declares no catalogue size: footprint 1 m, overlap not judged`);
      const r = half ? Math.max(half[0], half[1]) : 1, st = discStats(g, w, Math.max(0.5, r));
      if (dist(w, keepIn.center) > keepIn.radius) why(q.id, `at ${q.at.join(",")} lies outside the usable area (${Math.round(dist(w, keepIn.center))} m from the reservation centre, ${Math.round(keepIn.radius)} m allowed)`);
      else if (!q.wet && (st.wet > 0 || g.wet(w[0], w[1]))) why(q.id, `at ${q.at.join(",")} stands in water (wet ground under its ${r2(r)} m footprint; wet: true on the piece if it is meant to)`);
      else if (q.kind !== "decal" && !q.on && st.steep > USABLE_SLOPE) why(q.id, `at ${q.at.join(",")} stands on ground steeper than the usable slope (${r2(st.steep)} > ${USABLE_SLOPE} rise/run under its footprint)`);
      // the hero-prop size band: WARN, never a refusal (TOOLS-LAYOUT 5: a 4.8 m "bonfire" in a human camp)
      const sw = layoutSizeWarn(q, size); if (sw) notes.push(`WARN: piece ${q.id}: ${sw}`);
    }
    const solid = L.pieces.filter((q) => q.kind !== "decal" && layoutWorld.get(q.id)!.half && !refused.has(q.id));
    for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) { const x = solid[i]!, y = solid[j]!;
      if (x.over.includes(y.id) || y.over.includes(x.id)) continue; // meant to overlap (a gantry over the bell)
      if (boxesOverlap({ at: x.at, half: layoutWorld.get(x.id)!.half!, yaw: x.yaw }, { at: y.at, half: layoutWorld.get(y.id)!.half!, yaw: y.yaw })) faults.push(`LAYOUT: pieces ${x.id} and ${y.id} overlap (footprints ${layoutWorld.get(x.id)!.half!.map((h) => r2(2 * h)).join(" x ")} m and ${layoutWorld.get(y.id)!.half!.map((h) => r2(2 * h)).join(" x ")} m)`); }
    if (refused.size) a = { ...a, pockets: a.pockets.map((k, i) => (i ? k : { ...k, structures: k.structures.filter((s) => !refused.has(s.id)) })) };
    notes.push(`LAYOUT: ${L.pieces.length} pieces placed as drawn (frame origin ${core.at.map(r2).join(",")}${L.origin ? ", pinned" : ", the site search's core"}), ${L.ground.length} ground patches; archetype structures, read.beacon and listed dressing props not added`);
  }
  const worldOps: unknown[] = [], operators: any[] = [], clearings: any[] = [], encounters: any[] = [], plans: any[] = [], areas: any[] = [];
  const ops: any[] = [{ op: "add-entity", id: `poi-${poi}`, entity: { name: place.name, parent: null, tags, components: { transform: { position: [core.at[0], padY, core.at[1]] } } } }];
  const features: any[] = [], keepClear: any[] = [];
  let landmark: { at: V2; foot: number; top: number; fogReach: number } | null = null;
  const smokes: { at: V2; top: number; fogReach: number }[] = [], solids: { at: V2; r: number; band?: number; soft?: boolean }[] = [];
  const stands: V2[] = [];
  const placedAll = new Map<string, { w: V2; ang: number; y: number; prefab: string; k: number }>(); // every pocket's pieces (layout `waters` find their host here)
  // `walk: false`: a structure's own cover clearing is ground cleared under a solid, not a spot a body walks to (poi-walk skips it;
  // L walk, peat-banks 2026-10-21: a marker spread past a bank line became an unreachable walk target, 3 STUCK)
  const clear = (id: string, c: V2, r: number, walk = true) => clearings.push({ id: `${poi}-${id}`, center: [r2(c[0]), r2(c[1])], radius: r2(r), feather: 2, keep: 0, scatter: true, cover: true, owner: poi, ...(walk ? {} : { walk: false }) });
  a.pockets.forEach((p, k) => {
    const pk = pockets[k]!, y = r2(pk.y), fitR = p.fit ?? p.radius; // the pad and its fit: the archetype's own radius (spreadToFloor)
    // a layout's pieces all stand in the core's list (place frame): a satellite pocket's walk-in stand keeps clear of them too
    const toLocal = (w: V2): V2 => { const dx = w[0] - pk.at[0], dz = w[1] - pk.at[1]; return [dx * -front[1] + dz * front[0], dx * front[0] + dz * front[1]]; };
    stands.push(standPoint(L && k > 0 ? { ...p, structures: a.pockets[0]!.structures.map((s) => ({ ...s, at: toLocal(toWorld(core.at, front, s.at)) })) } : p, pk.at, front));
    const raise = p.pad && (edgeDrop(g, pk.at, fitR) > 3 || pk.fit.stats.steep > 1.2); // L: raiseOnly where the pad meets a cliff
    // L: the pad sits on the ground's own level — ground already level (relief <= 2 m) gets no patch at all (no edit, no lips)
    // L (lips): a pad only levels ground for STRUCTURES; walls and dressing follow the ground (a masked pad on a slope
    // under a dyke or a dressing area is all risk: sawtooth edges for nothing)
    const padded = p.pad && p.structures.length > 0 && pk.fit.stats.relief > 2;
    if (padded) worldOps.push(padPatch(`pb-${poi}-${p.id}-pad`, pk.at, fitR, y, Math.max(12, fitR), raise, g));
    const padGround = (x: number, z: number) => { const gh = g.height(x, z); return padded && dist([x, z], pk.at) <= fitR - 0.5 ? (raise ? Math.max(y, gh) : y) : gh; };
    // a basin's BED: the ground under its water levelled at the inner ground's median (a masked pad round the kerb): on a
    // slope the sheet otherwise stood a metre deep on the low side and drowned what lies in it (RETTING 2026-10-23)
    const beds = p.walls.filter((wl) => wl.basin).map((wl) => { const c = toWorld(pk.at, front, wl.at), hx = wl.size - wl.thickness / 2, hz = (wl.depth ?? wl.size) - wl.thickness / 2, hs: number[] = [];
      for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) { const q = toWorld(c, front, [(hx * i) / 4, (hz * j) / 4]); hs.push(padGround(q[0], q[1])); }
      hs.sort((m, n) => m - n); const r = r2(Math.hypot(hx, hz) + 0.2), bedY = r2(wl.basin!.bed !== undefined ? y + wl.basin!.bed : hs[hs.length >> 1]!);
      worldOps.push(bedPatch(`pb-${poi}-${p.id}-${wl.id}-bed`, c, front, hx, hz, wl.thickness, bedY));
      if (wl.basin!.bedSurface) { const ox = hx + wl.thickness, oz = hz + wl.thickness;
        worldOps.push({ edit: "add-feature", kind: "groundPaints", feature: { id: `pb-${poi}-${p.id}-${wl.id}-bed-paint`, surface: wl.basin!.bedSurface, polygon: ([[-ox, -oz], [ox, -oz], [ox, oz], [-ox, oz]] as V2[]).map((q) => { const w = toWorld(c, front, q); return [r2(w[0]), r2(w[1])]; }), feather: 0.5, edgeNoise: 0, faces: true } }); }
      return { c, r, hx, hz, y: bedY }; });
    // inside a bed = inside its kerb's inner rectangle (a circle round the corners seated the crane beside a pit on its bed)
    const inBed = (d: { c: V2; hx: number; hz: number }, x: number, z: number) => { const dx = x - d.c[0], dz = z - d.c[1]; return Math.abs(dx * -front[1] + dz * front[0]) <= d.hx + 0.01 && Math.abs(dx * front[0] + dz * front[1]) <= d.hz + 0.01; };
    const pocketGround = (x: number, z: number) => { const b = beds.find((d) => inBed(d, x, z)); return b ? b.y : padGround(x, z); };
    if (p.floor) { const c = toWorld(pk.at, front, p.floor.at);
      worldOps.push({ edit: "add-feature", kind: "groundPaints", feature: { id: `pb-${poi}-${p.id}-floor`, surface: p.floor.surface, center: [r2(c[0]), r2(c[1])], radius: p.floor.radius, feather: 1, edgeNoise: 0.6, strength: p.floor.strength, breakup: p.floor.breakup } });
      clear(`${p.id}-floor`, c, p.floor.radius + 1); }
    clear(`${p.id}-pad`, stands[k]!, fitR + 2 + dist(stands[k]!, pk.at), !p.sight);
    const placed = new Map<string, { w: V2; ang: number; y: number; prefab: string; k: number }>();
    // a built structure's stone: `@wall:<id>` = that wall's face (its own materials, else the zone's built stone)
    const stoneOf = (st: string) => { const m = /^@wall:(.+)$/.exec(st), wl = m ? p.walls.find((x) => x.id === m[1]) : null; if (!m) return st; const f = (wl && Object.keys(wl.materials).length ? wl.materials : inp.builtStone ?? {}).face; return String(Array.isArray(f) ? f[0] : f ?? st); };
    for (const s of p.structures) {
      // L (seated, signal-tower 2026-10-21: a ruin at the pocket's median ground floated on its low side): the ground as
      // planned (the pad where one is written, else the field); a structure sits on the highest ground under its BASE
      // OUTLINE and a skirt in its own stone runs round the outline into the ground where it then stands clear
      // (seatStructure); a rock or a post is sunk instead. Fires and boats keep the ground at their centre.
      const planned = pocketGround;
      // a piece ON a built wall's walk (onWall: a brazier on a tower top) stands on the coping, never seated on the ground
      const host = s.onWall ? p.walls.find((x) => x.id === s.onWall && ((x.kind !== "wall" && x.kind !== "curtain") || x.basin)) : undefined;
      if (s.onWall && !host) faults.push(`structure ${p.id}.${s.id}: onWall ${s.onWall} is no tower / keep / gatehouse / basin kerb of the pocket`);
      // a basin's kerb is written level at its basin's top (basinWater): a piece on it lies on the coping
      const kerbTop = host?.basin ? basinWater(host, toWorld(pk.at, front, host.at), front, pocketGround).topY : null;
      const w = toWorld(pk.at, front, s.at), ang = yaw + (s.yaw * Math.PI) / 180;
      // a piece ON another piece (`on`: a cairn on a crag top) stands on that mesh's top at its spot
      const under = s.on ? placed.get(s.on) : undefined; let onY: number | null = null;
      if (s.on && !under) faults.push(`structure ${p.id}.${s.id}: on ${s.on} is no earlier structure of the pocket`);
      if (under) { const dx = w[0] - under.w[0], dz = w[1] - under.w[1], c = Math.cos(under.ang), sn = Math.sin(under.ang), lx = (dx * c - dz * sn) / under.k, lz = (dx * sn + dz * c) / under.k, t = inp.topOf?.(under.prefab, lx, lz);
        if (t == null) faults.push(`structure ${p.id}.${s.id}: no top of ${s.on} under it`); else onY = under.y + t * under.k - 0.1; }
      // LEAN: the whole piece tipped toward a place-frame point or direction; its base outline turned with it, sunk (rooted)
      const lean = s.lean && s.lean.deg > 0 && !host ? s.lean : null; // on a piece (`on`): tipped from its foot on that top
      const leanDir = lean ? (lean.toward ? (() => { const t = toWorld(pk.at, front, lean.toward!); return Math.atan2(t[0] - w[0], t[1] - w[1]); })() : yaw + ((lean.dir ?? 0) * Math.PI) / 180) : 0;
      const q = leanQuat(ang, lean?.deg ?? 0, leanDir);
      const b0 = host || under || s.role === "fire" || s.role === "boat" ? null : inp.structureBase?.(s.prefab) ?? null, bs = b0 && s.scale !== 1 ? scaleBase(b0, s.scale) : b0, base = bs && lean ? orientBase(bs, q) : bs;
      if (lean && s.role === "dwelling") faults.push(`structure ${p.id}.${s.id}: a dwelling never leans (lean is for menhirs, pillars, posts)`);
      const seat = base ? seatStructure(base, w, lean ? 0 : ang, planned, { rock: /^rock-kit\//.test(s.prefab) || !!lean, sinkMax: s.role === "dwelling" ? 0 : SINK_MAX_M }) : null, sy0 = r2(kerbTop != null ? kerbTop : host ? y + host.height + 0.3 : onY != null ? onY : seat ? seat.y : planned(w[0], w[1]));
      const sy = r2(sy0 + (s.lift ?? 0)); // raised foundations for a piece that asks for it (`lift`)
      placed.set(s.id, { w, ang, y: sy, prefab: s.prefab, k: s.scale }); placedAll.set(s.id, placed.get(s.id)!);
      // raised foundations: the ground under the base is lifted to it (level, raise-only, feathered with the fall)
      if (seat?.level && seat.rect) worldOps.push(rectPadPatch(`pb-${poi}-seat-${p.id}-${s.id}`, toWorldYaw(w, ang, seat.rect.centre[0], seat.rect.centre[1]), seat.rect.half, ang, seat.raise!.y, Math.max(3, Math.min(8, 2 * seat.relief)), g));
      else if (seat?.raise) worldOps.push(padPatch(`pb-${poi}-seat-${p.id}-${s.id}`, w, seat.raise.radius, seat.raise.y, Math.max(4, 3 * seat.relief), true, g));
      if (seat?.skirt) {
        const own = base!.material && inp.materialExists?.(base!.material) ? base!.material : null, mats: Record<string, string> = own ? { face: own, cap: own, footing: own } : { ...(inp.builtStone ?? {}) };
        if (wearsCliffTile(mats)) faults.push(`skirt ${p.id}.${s.id}: no stone for it (its own base material is not a material asset and the zone has no builtStone)`);
        operators.push({ id: `pb-${poi}-skirt-${p.id}-${s.id}`, op: "wall", variant: "free", scale: "human", points: seat.skirt, smooth: false, height: 0.5, heightMode: "level", topY: r2(sy + Math.min(...base!.perimeter.map((q) => q[2])) - 0.15), thickness: SKIRT_THICK_M, batter: 0, cap: null,
          footing: { depth: SKIRT_BURY_M, projection: 0.1, plinth: 0.05 }, irregularity: { thickness: 0, height: 0, lean: 0 }, materials: mats, seed: 1 });
        notes.push(`structure ${p.id}.${s.id}: ${seat.relief} m of ground fall under its base: seated on the highest ground, a skirt (${own ?? "zone built stone"}) runs round it ${SKIRT_BURY_M} m into the ground`);
      } else if (seat?.level) notes.push(`structure ${p.id}.${s.id}: ${seat.relief} m of ground fall under its open base: seated at the middle of the fall, the ground levelled under it (r ${seat.raise!.radius} m, cut + fill)`);
      else if (seat?.raise) notes.push(`structure ${p.id}.${s.id}: ${seat.relief} m of ground fall under its base: seated on the highest ground, the ground raised to its base (r ${seat.raise.radius} m)`);
      else if (seat?.sunk && seat.relief > SEAT_GAP_M) notes.push(`structure ${p.id}.${s.id}: sunk to its lowest ground (${seat.relief} m of fall under it: its uphill side rooted, no terrain edit)`);
      const comps: any = { transform: { position: [r2(w[0] - core.at[0]), r2(sy - padY), r2(w[1] - core.at[1])], rotation: q.map((c) => r2(c * 1e4) / 1e4), ...(s.scale !== 1 ? { scale: [s.scale, s.scale, s.scale] } : {}) }, prefab: { prefabId: s.prefab, props: {}, ...(s.overrides?.length ? { overrides: s.overrides } : {}) } };
      if (lean) notes.push(`structure ${p.id}.${s.id}: leans ${lean.deg} deg toward ${Math.round(((leanDir * 180) / Math.PI + 360) % 360)} deg (world, 0 = +z), sunk ${seat ? r2(Math.max(0, ...base!.cells.map((c) => planned(w[0] + c[0], w[1] + c[1]) - (seat.y + c[2])))) : 0} m at its downhill foot`);
      if (s.scale !== 1) { const tx = inp.texelsOf?.(s.prefab); if (tx != null && tx / s.scale < MIN_SCALED_TEXELS) faults.push(`structure ${p.id}.${s.id}: ${s.prefab} at scale ${s.scale} is ${r2(tx / s.scale)} tx/m, under the ${MIN_SCALED_TEXELS} tx/m floor: a taller piece is a prop request (Codex), never a stretched one`); }
      if (s.landmark) { comps.landmark = { fogReach: s.landmark.fogReach, silhouette: s.landmark.silhouette }; landmark = { at: w, foot: sy, top: sy + s.landmark.height, fogReach: s.landmark.fogReach }; }
      // L (Red Dial 2026-10-30: a footpath's grade band cut under a kit wall's end, 0.7 m of daylight): a kit structure with a
      // declared footing keeps the routes a grade band further off, so no path cut reaches under it
      // ...and so does every other ground piece (Red Dial 2026-10-30: the paths re-baked over the seat pads cut 0.7-0.9 m under
      // the avenue's pillars); a piece `on` another rides its host's band
      // (soft: dropped for a leg that finds no way with it)
      if (!host && !under) solids.push({ at: w, r: s.footprint, band: PATH_GRADE_BAND_M, ...((inp.propInfo?.(s.prefab) as { footing?: number } | null)?.footing ? {} : { soft: true }) });
      if (SMOKE_READ_M[s.prefab]) smokes.push({ at: [r2(w[0]), r2(w[1])], top: r2(sy + SMOKE_READ_M[s.prefab]!), fogReach: s.landmark?.fogReach ?? 600 });
      ops.push({ op: "add-entity", id: `${poi}-${p.id}-${s.id}`, entity: { name: `${s.id} (${s.prefab})`, parent: `poi-${poi}`, tags: [...tags.slice(1), `slot:${s.role}`, ...(s.on ? [`on:${s.on}`] : s.onWall ? [`on:${s.onWall}`] : []), ...(s.stone ? [`stone:${stoneOf(s.stone)}`] : []), ...(s.lift ? [`lift:${s.lift}`] : []), ...(lean ? [`lean:${lean.deg}`] : [])], components: comps } });
      if (host || under) continue; // up on the wall: no ground cleared, nothing kept clear on the ground
      if (dist(w, pk.at) + s.footprint > fitR + 2) clear(`${p.id}-${s.id}`, w, s.footprint + 1.5, false); // L: cover cleared under every structure
      keepClear.push({ id: `${p.id}-${s.id}`, why: `structure ${s.prefab}`, at: [r2(w[0]), r2(w[1])], radius: s.footprint });
    }
    p.walls.map(burntShell).forEach((wl, wi) => {
      const { pts, front: gf, back: gb, smooth } = wallPoints(wl), yard = encloses(wl, p.radius);
      const doc: any = { id: `pb-${poi}-${p.id}-${wl.id}`, op: "wall", variant: "free", scale: "human", points: pts.map((q) => toWorld(pk.at, front, [q[0] + wl.at[0], q[1] + wl.at[1]]).map(r2)), smooth, height: wl.height, thickness: wl.thickness, materials: Object.keys(wl.materials).length ? wl.materials : { ...(inp.builtStone ?? {}) }, seed: wi + 1 };
      // L (zfight, hags-garth 2026-10-21): a low dyke's footing step follows the terrain smoothed and its top met the meshed ground
      // coplanar (0.08 m2); a dry-stone dyke has no footing step: the body still runs its depth into the ground
      if (wl.height < 3.2) doc.footing = null;
      if (wl.retain) { if (wl.shape !== "line") faults.push(`wall ${p.id}.${wl.id}: retain is for line walls`); doc.variant = "retaining"; doc.face = wl.retain.face; doc.backfill = { width: wl.retain.backfill, feather: wl.retain.feather }; }
      const built = wl.kind !== "wall";
      if (wearsCliffTile(doc.materials)) faults.push(`wall ${p.id}.${wl.id}: no face material and no zone built stone (place-build zone defaults builtStone): it would wear the terrain cliff tile`);
      if (wl.landmark) { doc.fog = { fogReach: wl.landmark.fogReach, silhouette: wl.landmark.silhouette }; landmark = { at: toWorld(pk.at, front, wl.at), foot: y, top: y + wl.landmark.height, fogReach: wl.landmark.fogReach }; }
      if (built) {
        if (!Object.keys(wl.materials).length && inp.builtKinds?.[wl.kind]) doc.materials = { ...inp.builtKinds[wl.kind] };
        operators.push(...builtWall(wl, p.walls, doc, y, gf, gb, notes));
        // a tower's windows: each holds its night light at mid-opening on the wall's centre line
        towerWindows(wl, doc.points, gf).forEach((o) => {
          if (!o.light) return;
          const q = pointAt(doc.points, o.at), c = toWorld(pk.at, front, wl.at), out = Math.atan2(q[0] - c[0], q[1] - c[1]);
          ops.push({ op: "add-entity", id: `${poi}-${p.id}-${wl.id}-${o.name}`, entity: { name: `${o.name} light (${o.light})`, parent: `poi-${poi}`, tags: [...tags.slice(1), "slot:window"],
            components: { transform: { position: [r2(q[0] - core.at[0]), r2(y + (o.sill + o.height) / 2 - padY), r2(q[1] - core.at[1])], rotation: [0, r2(Math.sin(out / 2) * 1e4) / 1e4, 0, r2(Math.cos(out / 2) * 1e4) / 1e4] }, prefab: { prefabId: o.light, props: {} } } } });
        });
        if (wl.windows.length && wl.kind !== "tower") faults.push(`wall ${p.id}.${wl.id}: windows are for towers (a ring)`);
        // a door's portal (sealed when it names no scene): a trigger box filling the arched door on the wall's centre line
        if (wl.portal && wl.gate && wl.kind !== "curtain") {
          const out = wl.kind === "tower" ? wl.size * Math.cos(Math.PI / wl.sides) : (wl.depth ?? wl.size), d = toWorld(pk.at, front, [wl.at[0], wl.at[1] + out]);
          const gh = Math.min(wl.height - 1.5, wl.gateHeight ?? Math.max(3.5, 1.5 * wl.gate)), gw = Math.max(MIN_GATE_M, wl.gate);
          ops.push({ op: "add-entity", id: `${poi}-${p.id}-${wl.id}-portal`, entity: { name: `${wl.portal.name}: ${wl.portal.scene ? "portal" : "sealed door"}`, parent: `poi-${poi}`, tags: [...tags.slice(1), "portal", `slot:${wl.id}-door`],
            components: { transform: { position: [r2(d[0] - core.at[0]), r2(y - padY), r2(d[1] - core.at[1])], rotation: [0, r2(Math.sin(yaw / 2) * 1e4) / 1e4, 0, r2(Math.cos(yaw / 2) * 1e4) / 1e4] },
              script: { name: "portal", params: { mode: "trigger", scene: wl.portal.scene, anchor: wl.portal.anchor, name: wl.portal.name, prompt: "Enter", party: true, condition: {}, refusal: wl.portal.refusal, halfExtents: [r2(gw / 2 + 0.3), r2(gh / 2), r2(wl.thickness / 2)], offset: [0, r2(gh / 2), 0], fade: 2.5, arrivalGrace: 2 } } } } });
          notes.push(`${wl.kind} ${wl.id}: ${wl.portal.scene ? `portal to ${wl.portal.scene}` : "SEALED door"} in its ${gw} x ${r2(gh)} m arched door (veil: tools/portal-veil.mts)`);
        }
        return;
      }
      if (wl.basin) {
        // a BASIN: the kerb written level over the water; the sheet's edge on the kerb's centre line (buried in it)
        const c = toWorld(pk.at, front, wl.at), bw = basinWater(wl, c, front, pocketGround), b = wl.basin;
        doc.heightMode = "level"; doc.topY = bw.topY; doc.height = r2(Math.max(0.3, bw.topY - bw.lowLine)); doc.footing = null;
        if (bw.topY - bw.lowLine > 2.5) faults.push(`basin ${p.id}.${wl.id}: its kerb stands ${r2(bw.topY - bw.lowLine)} m over its low side (the ground falls ${r2(bw.inner.max - bw.lowLine)} m under it): move it onto level ground or step it`);
        const W = wl.size, D = wl.depth ?? wl.size;
        if (inp.materialExists && !inp.materialExists(b.material)) faults.push(`basin ${p.id}.${wl.id}: water material ${b.material} is no material asset of the closure`);
        else {
          ops.push({ op: "add-entity", id: `${poi}-${p.id}-${wl.id}-water`, entity: { name: `${wl.id} water (${b.material})`, parent: `poi-${poi}`, tags: ["water", ...tags.slice(1), "slot:basin"],
            components: { transform: { position: [r2(c[0] - core.at[0]), r2(bw.waterY - padY), r2(c[1] - core.at[1])], rotation: [0, r2(Math.sin(yaw / 2) * 1e4) / 1e4, 0, r2(Math.cos(yaw / 2) * 1e4) / 1e4] },
              mesh: { source: { kind: "surface", positions: [-W, 0, -D, W, 0, -D, W, 0, D, -W, 0, D], indices: [0, 2, 1, 0, 3, 2], uvs: [-W, -D, W, -D, W, D, -W, D] }, material: b.material, static: false, castShadow: false, receiveShadow: false },
              water: { depth: r2(bw.waterY - bw.inner.min + 0.5), swim: b.swim } } } });
        }
        // no grass through the water or the kerb: the clearing reaches the kerb's outer corners, as its keepClear does
        const basinR = r2(Math.hypot(wl.size, wl.depth ?? wl.size) + wl.thickness / 2);
        clear(`${p.id}-${wl.id}-basin`, c, basinR, false);
        keepClear.push({ id: `${p.id}-${wl.id}-basin`, why: "structure basin water", at: [r2(c[0]), r2(c[1])], radius: basinR });
        notes.push(`basin ${p.id}.${wl.id}: water at ${bw.waterY} (inner ground ${bw.inner.min}-${bw.inner.max}), kerb top ${bw.topY} (${r2(bw.topY - bw.lowLine)} m over its low side), ${b.contents.length} piece(s) in it`);
      }
      const h = Math.max(2.6, wl.height + 1);
      if (gf !== null && wl.gate) doc.openings = [{ name: "gate", at: r2(wl.gateSide === "back" && gb !== null ? gb : gf), width: Math.max(MIN_GATE_M, wl.gate), height: h }];
      // L (walk): a yard with pockets behind it gets a back gate, and its routes go through the gates
      if (gb !== null && wl.gate && wl.gateSide === "front" && yard && k === 0 && a.pockets.length > 1) doc.openings.push({ name: "back-gate", at: r2(gb), width: Math.max(MIN_GATE_M, Math.min(wl.gate, 3)), height: h });
      if (wl.height > 3 && wl.shell !== "burnt" && !(wl.shape === "ring" && wl.size <= 4)) doc.buttresses = { every: 6, side: "both" }; // L: walls over 3 m get buttresses (a small round tower braces itself)
      if (doc.openings) doc.openings.sort((m: any, n: any) => m.at - n.at);
      // L (op-apply, shielings beacon 2026-10-21): a CLOSED smooth ring (no gate) fails the wall bake (its collider solids
      // self-intersect, any radius); a closed ring is built as a mitred polygon
      if (wl.shape === "ring" && !doc.openings?.length) doc.smooth = false;
      // L (walk): the wall operator spans every opening with a lintel no higher than the wall top - 0.4 m, so a gate in a
      // low yard wall (< 3.2 m) is a 1.4 m slot nobody walks through. Low walls get real gaps: one run between gates.
      if (doc.openings?.length && wl.height < 3.2) {
        const runs = cutRing(doc.points, doc.openings);
        runs.forEach((run, ri) => { const { openings: _o, fog, ...rest } = doc; operators.push({ ...rest, ...(ri === 0 && fog ? { fog } : {}), id: `${doc.id}-${ri + 1}`, points: run, smooth: false, ends: { start: "pier", end: "pier" } }); });
      } else operators.push(doc);
    });
    if (p.dressing) {
      const id = `${poi}-${p.id}`;
      // L (owner walk 2026-10-21, vignettes): the area is the whole pocket round its structures (its centre, + DRESS_RIM_M), not a
      // disc round the walk-in stand point: a camp's vignette stands round the fire, a yard's before its hut
      // L (walk, ravenstacks 2026-10-21: the castle court's centre is the keep's corner, poi-walk's area target 2.1 m off):
      // the area's walk-in point is the pocket's stand (clear of every footprint and wall line), not its centre
      const st = stands[pockets.indexOf(pk)] ?? pk.at;
      areas.push({ id: p.id, role: p.dressing.role, centre: [r2(pk.at[0]), r2(pk.at[1])], radius: (p.dressing.radius ?? p.radius) + DRESS_RIM_M, note: p.dressing.note, reach: [st[0], r2(g.height(st[0], st[1])), st[1]] });
      // L (dress, peat-banks 2026-10-21): an area whose own props were all denied (handcart banned, crate out of the L* band)
      // still gets its plan: the density floor fills it (it had been dropped, and the live area went undressed)
      const why = fillWhy({ ...a, id: a.id }, inp.propInfo), dropped: PlanDrop[] = [];
      for (const q of asked.get(p.id) ?? []) if (!p.dressing.props.some((x) => x.prop === q.prop)) dropped.push({ prop: q.prop, count: q.count, why: why(q.prop) ?? "taken out by the plan" });
      // L (TOOLS-LAYOUT 2026-10-24): every layout piece's footprint inside the area is occupied ground: the filler yields
      const dr = p.dressing.radius ?? p.radius, occupied = r2([...layoutWorld.entries()].filter(([id]) => !refused.has(id) && L!.pieces.find((q) => q.id === id)!.kind !== "decal" && dist(layoutWorld.get(id)!.w, pk.at) <= dr).reduce((m, [, v]) => m + (v.half ? 4 * v.half[0] * v.half[1] : 1), 0));
      if (occupied > 0) notes.push(`${p.id} dressing: ${occupied} m2 of the area is layout pieces (filler counted on the rest)`);
      const laid = arrangeFirstPlan(firstPlanItems(p.dressing.props, p.id, dr, p.dressing.role, fillOk({ ...a, id: a.id }, inp.propInfo), p.dressing.density, { filler: p.dressing.filler ?? a.filler, dropped, why, occupiedM2: occupied }), p.dressing.role, p.id, p.structures, p.id);
      // L (TOOLS-PB 2026-10-23, silent drop): what was asked of the plan, exact counts, and why any did not make it (dress gate)
      // L (KNUCKLECROWN 2026-10-29: 29 top-up boulders strewn over a set-piece ring floor): under a layout, more filler than
      // listed props means the dressing area spans ground the composition leaves open on purpose: say so (shrink it)
      { const nf = laid.items.filter((it) => /^fill-/.test(it.id)).length, nl = laid.items.length - nf; if (L && nf > Math.max(4, nl)) notes.push(`WARN: ${p.id} dressing: ${nf} top-up filler vs ${nl} listed props: the area (r ${dr + DRESS_RIM_M} m) spans open composition ground; set ${p.id}.dressing.radius to the ground the props belong to`); }
      requested[id] = (asked.get(p.id) ?? []).map((q) => { const d = dropped.find((x) => x.prop === q.prop); return { prop: q.prop, count: q.count, ...(d ? { why: d.why } : {}) }; });
      for (const d of dropped) notes.push(`${p.id} dressing: ${d.prop} x${d.count ?? 1} not placed (${d.why})`);
      if (laid.items.length) plans.push({ id, map: id, lights: a.lights, rooms: { [p.id]: { role: p.dressing.role, also: ROOM_ALSO[p.dressing.role] ?? [p.dressing.role] } }, space: { kind: "site", scale: siteScale(a.culture), cultures: a.culture }, items: laid.items, ...(laid.arrangements.length ? { arrangements: laid.arrangements } : {}) });
    }
    if (p.encounter) {
      // L (walk): the creature clearing's centre keeps 1.5 m past every structure footprint (wolfhollow: a boulder on the
      // default spot made the clearing unreachable, STUCK + BODY); the first free of six spots round the pocket
      // L (walk, shielings 2026-10-20): and 1.5 m past every wall line (a croft's corner left the clearing unreachable);
      // when the half-radius ring has no free spot, a ring at 0.85 x the radius
      const h = p.radius * 0.5, f = p.radius * 0.85, clearOf = pocketClearance(p), spots: V2[] = [[h, -h], [-h, -h], [h, h], [-h, h], [0, -h], [0, h], [f, 0], [-f, 0], [0, -f], [0, f], [f * 0.7, -f * 0.7], [-f * 0.7, -f * 0.7], [f * 0.7, f * 0.7], [-f * 0.7, f * 0.7]];
      const c = toWorld(pk.at, front, (p.encounter.at as V2 | undefined) ?? spots.find((q) => clearOf(q) >= 1.5) ?? spots[0]!);
      clear(`enc-${p.id}`, c, p.encounter.radius);
      encounters.push({ id: `${poi}-enc-${p.id}`, job: poi, center: [r2(c[0]), r2(c[1])], radius: p.encounter.radius, for: p.encounter.for });
      keepClear.push({ id: `enc-${p.id}`, why: "creature clearing", at: [r2(c[0]), r2(c[1])], radius: p.encounter.radius });
    }
    features.push({ id: p.id, kind: p.kind, linkedTo: k === 0 ? [] : ["core"] });
  });
  // the layout's DECALS (flat ground pieces at their spot, on the planned ground) and GROUND wear (groundPaints discs, the
  // pocket `floor` path: data, no geometry); a kind the world has no surface for is a refusal naming it
  if (L) {
    const corePadded = worldOps.some((w: any) => w.feature?.id === `pb-${poi}-core-pad`), fitC = a.pockets[0]!.fit ?? a.pockets[0]!.radius;
    for (const q of L.pieces.filter((x) => x.kind === "decal" && !refused.has(x.id))) {
      const { w } = layoutWorld.get(q.id)!, y = (corePadded && dist(w, core.at) <= fitC - 0.5 ? padY : g.height(w[0], w[1])) - (q.sink ?? 0), ang = yaw + (q.yaw * Math.PI) / 180;
      ops.push({ op: "add-entity", id: `${poi}-core-${q.id}`, entity: { name: `${q.id} (${q.prefab})`, parent: `poi-${poi}`, tags: [...tags.slice(1), "slot:decal", "layout", ...((q.sink ?? 0) > 0 ? ["set-in"] : [])], components: { transform: { position: [r2(w[0] - core.at[0]), r2(y - padY), r2(w[1] - core.at[1])], rotation: [0, r2(Math.sin(ang / 2) * 1e4) / 1e4, 0, r2(Math.cos(ang / 2) * 1e4) / 1e4], ...(q.scale !== 1 ? { scale: [q.scale, q.scale, q.scale] } : {}) }, prefab: { prefabId: q.prefab, props: {} } } } });
    }
    for (const q of L.ground) {
      const c = toWorld(core.at, front, q.at), radius = Math.max(GROUND_MIN_RADIUS_M, q.radius);
      if (radius > q.radius) notes.push(`LAYOUT: ground ${q.id}: radius ${q.radius} m raised to ${radius} m (GROUND_MIN_RADIUS_M: a smaller disc does not read)`);
      if (q.kind === "rubble") { // 6-10 small catalogued stones inside the disc, seated on the ground (never in water)
        const stones = RUBBLE_STONES.filter((id) => !inp.catalogued || inp.catalogued(id));
        if (!stones.length) { faults.push(`LAYOUT: ground ${q.id}: no rubble stone is catalogued (${RUBBLE_STONES.join(", ")})`); continue; }
        let h = 0; for (const ch of q.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        const n = 6 + (h % 5);
        for (let i = 0; i < n; i++) {
          const t = i * 2.39996 + (h % 360) * (Math.PI / 180), s = radius * 0.85 * Math.sqrt((i + 0.5) / n), w: V2 = [c[0] + Math.cos(t) * s, c[1] + Math.sin(t) * s];
          if (g.wet(w[0], w[1])) continue;
          const ang = (i * 137 + h) % 360, sc = r2(0.6 + ((h >> (i % 8)) % 5) * 0.1);
          ops.push({ op: "add-entity", id: `${poi}-core-${q.id}-${i + 1}`, entity: { name: `${q.id} stone ${i + 1}`, parent: `poi-${poi}`, tags: [...tags.slice(1), "slot:rubble", "layout"], components: { transform: { position: [r2(w[0] - core.at[0]), r2(g.height(w[0], w[1]) - RUBBLE_EMBED_M * sc - padY), r2(w[1] - core.at[1])], rotation: [0, r2(Math.sin((ang * Math.PI) / 360) * 1e4) / 1e4, 0, r2(Math.cos((ang * Math.PI) / 360) * 1e4) / 1e4], scale: [sc, sc, sc] }, prefab: { prefabId: stones[i % stones.length]!, props: {} } } } });
        }
        continue;
      }
      const surface = q.texture ? (inp.surfaces && !inp.surfaces.includes(q.texture) ? null : q.texture) : inp.surfaces ? wearSurface(q.kind, inp.surfaces, inp.world, inp.zone, inp.surfaceColors) : WEAR_SURFACES[q.kind].at(-1)!;
      if (!surface) { faults.push(`LAYOUT: ground ${q.id}: no ${q.kind} surface in the world palette (${q.texture ? `texture ${q.texture} is not a recipe surface` : `tried ${WEAR_SURFACES[q.kind].map((x) => x.replace("{w}", inp.world).replace("{z}", inp.zone)).join(", ")}`})`); continue; }
      worldOps.push({ edit: "add-feature", kind: "groundPaints", feature: { id: `pb-${poi}-ground-${q.id}`, surface, center: [r2(c[0]), r2(c[1])], radius, feather: GROUND_FEATHER_M, edgeNoise: 0.6, strength: q.strength, breakup: q.breakup, ...(q.faces ? { faces: true } : {}) } });
    }
  }
  // the layout's POOLS: hand-placed recipe lakes, one still level sunk below the pad (L KNUCKLECROWN 2026-10-28)
  if (L) for (const q of L.pools ?? []) {
    const c = toWorld(core.at, front, q.at);
    worldOps.push({ edit: "add-feature", kind: "lakes", feature: { id: `pb-${poi}-pool-${q.id}`, center: [r2(c[0]), r2(c[1])], radius: q.radius, waterY: r2(padY - q.sink), depth: q.depth, bank: q.bank, carve: true, ...(q.material ? { material: q.material } : {}) } });
    // the hollow is cut INTO the core pad patch too: a height patch wins over the lake's own carve, so the pool on a
    // levelled crown drew as dry pad (L KNUCKLECROWN 2026-10-28: water-edges "0 bodies", the pool flat at padY)
    const pad = worldOps.find((w: any) => w.feature?.id === `pb-${poi}-core-pad`) as any, wy = padY - q.sink;
    if (pad?.feature?.heights) {
      const P = pad.feature, st = P.size[0] / (P.columns - 1);
      for (let rr = 0; rr < P.rows; rr++) for (let cc = 0; cc < P.columns; cc++) {
        const k = rr * P.columns + cc, d = Math.hypot(P.origin[0] + cc * st - c[0], P.origin[1] + rr * st - c[1]);
        if (d > q.radius + q.bank) continue;
        const t = d <= q.radius ? 0 : (d - q.radius) / q.bank, e = t * t * (3 - 2 * t);
        const h = d <= q.radius ? wy - q.depth * (1 - (d / q.radius) ** 2) : wy + (P.heights[k] - wy) * e;
        P.heights[k] = r2(Math.min(P.heights[k], h)); if (P.weights) P.weights[k] = 1;
      }
    } else notes.push(`LAYOUT: pool ${q.id}: no core pad patch to cut the hollow into (the lake carves the natural ground)`);
    features.push({ id: `pool-${q.id}`, kind: "water", linkedTo: ["core"] });
    notes.push(`LAYOUT: pool ${q.id}: still water r ${q.radius} m at y ${r2(padY - q.sink)} (pad ${r2(padY)} - ${q.sink}), bank ${q.bank} m`);
  }
  // the layout's WATERS: one still sheet at a placed structure's marker (a kit basin's `basin-water`), level and unmoving.
  // L (Red Dial 2026-10-29: sun-ruins/basin-block carries the water level as a marker; a pool carves terrain, so the basin was dry)
  if (L) for (const q of L.waters ?? []) {
    const host = placedAll.get(q.on), mk = host ? inp.markerOf?.(host.prefab, q.marker) ?? null : null;
    if (!host) { faults.push(`LAYOUT: water ${q.id}: on ${q.on} is no placed structure of the layout`); continue; }
    if (!mk) { faults.push(`LAYOUT: water ${q.id}: ${host.prefab} has no marker ${q.marker} (its <model>.markers.json)`); continue; }
    if (inp.materialExists && !inp.materialExists(q.material)) { faults.push(`LAYOUT: water ${q.id}: water material ${q.material} is no material asset of the closure`); continue; }
    const at = waterAtMarker(host, mk), W = r2((mk.size[0] * host.k) / 2), D = r2((mk.size[2] * host.k) / 2);
    if (!(W > 0 && D > 0)) { faults.push(`LAYOUT: water ${q.id}: marker ${q.marker} of ${host.prefab} has no size (x, z)`); continue; }
    ops.push({ op: "add-entity", id: `${poi}-core-${q.id}-water`, entity: { name: `${q.id} water (${q.material})`, parent: `poi-${poi}`, tags: ["water", ...tags.slice(1), "slot:basin", "layout"],
      components: { transform: { position: [r2(at.w[0] - core.at[0]), r2(at.y - padY), r2(at.w[1] - core.at[1])], rotation: [0, r2(Math.sin(at.ang / 2) * 1e4) / 1e4, 0, r2(Math.cos(at.ang / 2) * 1e4) / 1e4] },
        mesh: { source: { kind: "surface", positions: [-W, 0, -D, W, 0, -D, W, 0, D, -W, 0, D], indices: [0, 2, 1, 0, 3, 2], uvs: [-W, -D, W, -D, W, D, -W, D] }, material: q.material, static: false, castShadow: false, receiveShadow: false },
        water: { depth: q.depth, swim: q.swim } } } });
    // the size gate's water feature (a large place needs water/cave/interior): the basin's still water counts. L (Red Dial 2026-10-29)
    features.push({ id: `water-${q.id}`, kind: "water", linkedTo: ["core"] });
    notes.push(`LAYOUT: water ${q.id}: still sheet ${r2(2 * W)} x ${r2(2 * D)} m at y ${at.y} (${q.on}'s marker ${q.marker})`);
  }
  if (L) for (const q of L.clearings ?? []) { const c = toWorld(core.at, front, q.at); clearings.push({ id: `${poi}-heath-${q.id}`, center: [r2(c[0]), r2(c[1])], radius: q.radius, feather: q.feather, keep: q.keep, scatter: true, cover: false, owner: poi, walk: false }); }
  // THE RING (archetype `ring`): a ground band round an anchor, as data: a groundPaints feature and catalogued ground
  // props spread round it. L (weep-well 2026-10-20): the brief's set piece (a white salt-killed reed ring round the
  // tarn) had nothing expressing it; the landmark read as a small cairn.
  const ringReq: { name: string; at: V2; why: string }[] = [];
  const briefText = (place.text ?? "").toLowerCase();
  if (a.ring && (!a.ring.when.length || a.ring.when.some((w) => new RegExp(`\\b${w.toLowerCase().replace(/[^a-z0-9 -]/g, "")}`).test(briefText)))) {
    const R = a.ring, lake = R.anchor === "water" ? (inp.waters ?? []).map((l) => ({ l, d: dist(l.center, place.at) - l.radius })).filter((x) => x.d <= 150).sort((x, y) => x.d - y.d)[0]?.l ?? null : null;
    if (R.anchor === "water" && !lake) notes.push(`ring: no lake within 150 m of the brief site: the ring goes round the core (r ${R.radius} m)`);
    // a lake's ring stands on its measured dry rim (the median first dry ground along 24 rays): the field's shore and bank are
    // wet past the recipe radius (weep-tarn r 45: dry from ~58 m)
    const rim = lake ? (() => { const ds = Array.from({ length: 24 }, (_, i) => { const t = (i / 24) * Math.PI * 2; for (let s = lake.radius * 0.5; s <= lake.radius + 40; s += 1) if (!g.wet(lake.center[0] + Math.cos(t) * s, lake.center[1] + Math.sin(t) * s)) return s; return lake.radius + 40; }).sort((x, y) => x - y); return ds[12]!; })() : 0;
    const c: V2 = lake ? lake.center : core.at, r = lake ? rim : R.radius;
    if (R.paint) {
      if (lake) worldOps.push({ edit: "add-feature", kind: "groundPaints", feature: { id: `pb-${poi}-ring`, surface: R.paint.surface, center: [r2(c[0]), r2(c[1])], radius: r2(r + R.width), feather: 3, edgeNoise: 2, strength: R.paint.strength, breakup: R.paint.breakup, height: [r2(lake.waterY - 1), r2(lake.waterY + 2.5)] } });
      else { const n = Math.max(8, Math.ceil((2 * Math.PI * r) / R.width)); for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2;
        worldOps.push({ edit: "add-feature", kind: "groundPaints", feature: { id: `pb-${poi}-ring-${i + 1}`, surface: R.paint.surface, center: [r2(c[0] + r * Math.cos(t)), r2(c[1] + r * Math.sin(t))], radius: r2(R.width * 0.6), feather: 2, edgeNoise: 1, strength: R.paint.strength, breakup: R.paint.breakup } }); } }
    }
    const list = R.props.flatMap((q) => Array.from({ length: q.count }, () => q.prop)), n = list.length;
    let placed = 0;
    // the first dry spot outward along a ray (a lake: just past its waterline) whose next 1.2 m is dry and <= `grade`;
    // L (weep-well 2026-10-20): a ray with none (a steep bank) tries the angles either side, then a 0.7 grade: no gaps
    const rimSpot = (t: number, step: number): V2 | null => {
      for (const grade of [0.5, 0.7]) for (const off of [0, 0.25, -0.25, 0.45, -0.45]) { const a2 = t + off * step, u: V2 = [Math.cos(a2), Math.sin(a2)];
        for (let s = lake ? r - 3 : r; s <= r + R.width + 10; s += 0.5) { const p: V2 = [c[0] + u[0] * s, c[1] + u[1] * s], p2: V2 = [p[0] + u[0] * 1.2, p[1] + u[1] * 1.2];
          if (!g.wet(p[0], p[1]) && !g.wet(p2[0], p2[1]) && Math.abs(g.height(p2[0], p2[1]) - g.height(p[0], p[1])) / 1.2 <= grade) return p2; } }
      return null; };
    // the visible ring: instances of the world's own scatter rules (rockSets: batched with the rule, seated on the meshed
    // ground) — dead brush, bleached snags; the first of each entry's rule ids the recipe has (`{zone}` = the zone id)
    const plants: { rule: string; at: V2; yaw: number; scale: number }[] = [], sl = R.scatter.flatMap((e) => { const rule = e.rules.map((x) => x.replace("{zone}", inp.zone)).find((x) => !inp.scatterRules || inp.scatterRules.includes(x));
      if (!rule) { faults.push(`ring scatter: none of ${e.rules.join(", ")} is a scatter rule of the world`); return []; } return Array.from({ length: e.count }, () => ({ rule, scale: e.scale })); });
    sl.forEach((e, i) => { const q = rimSpot(((i + 0.5) / sl.length) * Math.PI * 2 + 0.11, (Math.PI * 2) / sl.length); if (q) plants.push({ rule: e.rule, at: [r2(q[0]), r2(q[1])], yaw: r2(i * 2.4), scale: e.scale }); });
    if (plants.length) worldOps.push({ edit: "add-feature", kind: "rockSets", feature: { id: `pb-${poi}-ring-plants`, rocks: plants } });
    list.forEach((prop, i) => {
      const q = rimSpot(((i + 0.5) / n) * Math.PI * 2, (Math.PI * 2) / n);
      if (!q) return;
      const y = g.height(q[0], q[1]), ang = (i * 137.5 * Math.PI) / 180; placed++;
      ops.push({ op: "add-entity", id: `${poi}-ring-${i + 1}`, entity: { name: `ring ${i + 1} (${prop})`, parent: `poi-${poi}`, tags: [...tags.slice(1), "slot:ring"], components: { transform: { position: [r2(q[0] - core.at[0]), r2(y - 0.1 - padY), r2(q[1] - core.at[1])], rotation: [0, r2(Math.sin(ang / 2) * 1e4) / 1e4, 0, r2(Math.cos(ang / 2) * 1e4) / 1e4] }, prefab: { prefabId: prop, props: {} } } } });
      solids.push({ at: [r2(q[0]), r2(q[1])], r: 0.8 });
      keepClear.push({ id: `ring-${i + 1}`, why: `ring ${prop}`, at: [r2(q[0]), r2(q[1])], radius: 0.8 });
    });
    if (R.request) ringReq.push({ name: R.request, at: [r2(c[0] + r), r2(c[1])], why: `the ring ${lake ? `round ${lake.id}` : "round the core"} (${R.note || "the brief's set piece"}): the paint and props stand in until it exists` });
    notes.push(`ring: ${lake ? `round ${lake.id} (dry rim ${r} m, recipe r ${lake.radius} m; paint band waterY - 1 .. + 2.5 at waterY ${lake.waterY})` : `round the core (r ${r} m)`}${R.paint ? `, paint ${R.paint.surface}` : ""}, ${placed}/${n} props placed, ${plants.length}/${sl.length} scatter plants`);
  }
  // footpaths: approach -> core, core -> every pocket. L (walk): every leg is PLANNED over the measured ground round the
  // walls (gates are gaps), structures, water and steep banks (routeGrid); the path ribbon follows the planned line
  // outside the pockets (path operator; L: risers <= 0.4 m are the ribbon's own)
  const routes: any[] = [], lines: V2[][] = [];
  const obs: RouteObstacles = { discs: solids, segs: [] };
  // L (walk): a wall end left at the operator's default (`terrain`) runs on `tie` m (2 x thickness + 2) past its last
  // point at full height on level ground: the route keeps off that too
  const runOn = (run: V2[], o: any): V2[] => {
    const closed = run.length > 2 && dist(run[0]!, run[run.length - 1]!) < 0.01, tie = o.ends?.tie ?? 2 * o.thickness + 2;
    if (closed) return run;
    const ext = (p: V2, q: V2): V2 => { const d = dist(p, q) || 1; return [p[0] + ((p[0] - q[0]) * tie) / d, p[1] + ((p[1] - q[1]) * tie) / d]; };
    const out = [...run];
    if ((o.ends?.start ?? "terrain") === "terrain") out[0] = ext(run[0]!, run[1]!);
    if ((o.ends?.end ?? "terrain") === "terrain") out[out.length - 1] = ext(run[run.length - 1]!, run[run.length - 2]!);
    return out;
  };
  const allRuns: V2[][] = [], allHw: number[] = [];
  for (const o of operators.filter((x) => x.op === "wall")) { const gaps = walkGaps(o.openings), runs: V2[][] = gaps.length ? cutRing(o.points, gaps) : [o.points as V2[]];
    for (const r0 of runs) { allRuns.push(r0); allHw.push(o.thickness / 2 + 0.4); }
    for (const r0 of runs) for (let i = 0, run = gaps.length ? r0 : runOn(r0, o); i + 1 < run.length; i++) obs.segs.push([run[i]!, run[i + 1]!, o.thickness / 2 + 0.4]); } // + the pier's projection
  obs.gates = wallGates(allRuns, allHw); // L (walk): a gap between run ends (a door, a ring's gate) is walked on its centre line
  // L (lips): a leg the ground holds no way for is a FIT fault and gets NO footpath: a straight line graded down a
  // 35+ deg bank is the 6-9 m sidehill lip (pb runs 2026-10-20); the site search keeps pockets on connected ground
  const failed = new Set<V2[]>();
  // L (walk, shielings 2026-10-20): a leg first looks for a way whose ground is nowhere steeper than the footpath grade
  // (route.maxGrade), then + 0.1, and only when the ground holds neither may it cross up to 35 deg. Ground steeper than
  // the ribbon's grade gets a riser: a 29 deg slope on the in-field leg (fell 3 m) and a 0.45 stretch on the approach
  // (a 2 m riser, fell 2.2 m) were the short ways the router took (2 FALL, 8 STUCK, 8-10 MISS at one spot).
  // a kit structure with a declared footing keeps a leg a grade band further off (its path cut never reaches under it),
  // except the structure the leg starts or ends at (a stand beside the plinth)
  const legObs = (from: V2, to: V2, soft = true): RouteObstacles => ({ ...obs, discs: obs.discs.map((d: any) => (d.band && (soft || !d.soft) && dist(from, d.at) > d.r + d.band + 1 && dist(to, d.at) > d.r + d.band + 1 ? { at: d.at, r: d.r + d.band } : d)) });
  const tryLeg = (from: V2, to: V2, obs: RouteObstacles): V2[] | null => routeGrid(g, from, to, obs, { prefer: a.route.maxGrade, maxSlope: a.route.maxGrade }) ?? routeGrid(g, from, to, obs, { prefer: a.route.maxGrade, maxSlope: a.route.maxGrade + 0.1 }) ?? routeGrid(g, from, to, obs, { prefer: a.route.maxGrade });
  // every piece's grade band first; a leg with no way through them keeps only the footing structures' bands (the old rule)
  const leg = (from: V2, to: V2, what: string): V2[] => tryLeg(from, to, legObs(from, to)) ?? tryLeg(from, to, legObs(from, to, false)) ?? (() => { faults.push(`route ${what}: no walkable way over the ground (water, walls or slopes > 35 deg)`); const l: V2[] = [from, to]; failed.add(l); return l; })();
  /** The longest run of a planned line outside the given pockets (their radius - 1): the stretch the ribbon paves. */
  const outside = (poly: V2[], discs: { at: V2; radius: number }[]): V2[] => {
    const out = (q: V2) => discs.every((d) => dist(q, d.at) > d.radius - 1), sm: { q: V2; v: boolean }[] = [];
    for (let i = 0; i + 1 < poly.length; i++) { const n = Math.max(1, Math.ceil(dist(poly[i]!, poly[i + 1]!))); for (let t = 0; t < n; t++) sm.push({ q: [poly[i]![0] + ((poly[i + 1]![0] - poly[i]![0]) * t) / n, poly[i]![1] + ((poly[i + 1]![1] - poly[i]![1]) * t) / n], v: t === 0 }); }
    sm.push({ q: poly[poly.length - 1]!, v: true });
    let best: typeof sm = [], cur: typeof sm = [];
    for (const s of sm) { if (out(s.q)) { cur.push(s); if (cur.length > best.length) best = cur; } else cur = []; }
    return best.filter((s, i) => i === 0 || i === best.length - 1 || s.v).map((s) => s.q);
  };
  const path = (id: string, line: V2[], discs: { at: V2; radius: number }[], planned = true) => {
    if (!planned) return;
    // L (owner ruling, bar-watch 2026-10-21): a pinpoint gets NO footpath ribbon, it is reached on foot over the ground
    // as it is; the planned leg is still a walk route (poi-walk) and keeps its lane clearings
    if (place.size === "pinpoint") { notes.push(`footpath ${id}: none (a pinpoint is reached on foot; the leg stays a walk route)`); return; }
    const edge = outside(line, discs), pts = landedStretch(g, line, discs, outside, { width: a.route.width, style: a.route.style, maxGrade: a.route.maxGrade });
    if (pts.length !== edge.length || pts.some((q, i) => dist(q, edge[i]!) > 0.01)) notes.push(`footpath ${id}: runs on into the pocket so both ends land on the ground (ribbon at the pocket edge ended ${r2(ribbonEndsOff(g, edge, a.route))} m off it)`);
    if (pts.length < 2 || pts.slice(1).reduce((m, q, i) => m + dist(pts[i]!, q), 0) < 8) return;
    const ps = pts.length === 2 ? [pts[0]!, [(pts[0]![0] + pts[1]![0]) / 2, (pts[0]![1] + pts[1]![1]) / 2] as V2, pts[1]!] : pts;
    operators.push({ id: `pb-${poi}-${id}`, op: "path", points: ps.map((q) => q.map(r2)), width: a.route.width, style: a.route.style, maxGrade: a.route.maxGrade, calm: true });
    lines.push(ps);
  };
  // L (walk): the footpath joins the approach where the approach itself is dry and near the pad's level (judged per
  // 2 m sample, not per vertex: a segment between two good vertices can cross a cliff foot); in a gully (no sample
  // within 12 m of the pad) the nearest dry sample a footpath can climb to at ~0.3 grade
  const joinOk = (grade: number) => (q: V2) => !g.wet(q[0], q[1]) && dist(q, core.at) > core.radius + 6 && Math.abs(g.height(q[0], q[1]) - padY) <= Math.max(12, grade * dist(q, core.at));
  let near = [0.2, 0.3, 0.45].map((gr) => nearestOnApproach(core.at, reservation.approaches, joinOk(gr))).find(Boolean) ?? null;
  // L (approach): the join is where the ground holds a walkable way to the core: when the nearest good join has none,
  // the next joins along the approach (nearest first, 12 m apart, at most 8) are tried before it is a fault
  if (near && near.d > core.radius + 6 && !routeGrid(g, near.p, stands[0]!, obs, { prefer: a.route.maxGrade })) {
    const tried: V2[] = [near.p], ok = joinOk(0.45);
    for (let n = 0; n < 8; n++) { const nx = nearestOnApproach(core.at, reservation.approaches, (q) => ok(q) && tried.every((t) => dist(t, q) > 12)); if (!nx) break; tried.push(nx.p);
      if (routeGrid(g, nx.p, stands[0]!, obs, { prefer: a.route.maxGrade })) { notes.push(`approach join moved ${Math.round(dist(nx.p, near.p))} m along the approach (no walkable way from the nearest join)`); near = nx; break; } }
  }
  // L (owner ruling 2026-10-20, "no ribbon roads: buried by terrain, never approved"): the approach is a CARVED + PAINTED
  // TRACK (a recipe road; place-build grades it with `worldgen road`), TRACK_WIDTH_M wide by tier, from the nearest
  // existing road / path / trail within TRACK_JOIN_M that holds a walkable way to the core (nearest first, 12 m apart, at
  // most 8 tried), else from the approach join. Never a path-operator ribbon (gate `roads`). A pinpoint gets no track.
  const trackW = TRACK_WIDTH_M[place.size] ?? 0, roads = (inp.roads ?? []).filter((r) => r.points.length >= 2);
  let roadJoin: { p: V2; d: number; line: number } | null = null;
  if (trackW > 0 && roads.length) {
    const rl = roads.map((r) => r.points as V2[]), okR = (q: V2) => !g.wet(q[0], q[1]) && dist(q, core.at) > core.radius + 6 && dist(q, core.at) <= TRACK_JOIN_M;
    const onIt = nearestOnApproach(core.at, rl, (q) => !g.wet(q[0], q[1]));
    if (onIt && onIt.d <= core.radius + 6) notes.push(`approach track: ${roads[onIt.line]!.id} runs by the core (${Math.round(onIt.d)} m): the place stands on it`);
    else { const tried: V2[] = [];
      for (let n = 0; n < 8; n++) { const c = nearestOnApproach(core.at, rl, (q) => okR(q) && tried.every((t) => dist(t, q) > 12)); if (!c) break; tried.push(c.p);
        if (routeGrid(g, c.p, stands[0]!, obs, { prefer: a.route.maxGrade })) { roadJoin = c; break; } }
      if (!roadJoin) notes.push(`approach track: no road, path or trail within ${TRACK_JOIN_M} m with a walkable way to the core: it starts on the approach line`); }
  }
  const start: V2 = roadJoin ? roadJoin.p : near && near.d > core.radius + 6 ? near.p : toWorld(core.at, front, [0, core.radius + 25]);
  const corePad = worldOps.some((w: any) => w.feature?.id === `pb-${poi}-core-pad`);
  const P3 = (q: V2, y?: number) => [r2(q[0]), r2(y ?? g.height(q[0], q[1])), r2(q[1])];
  const Y = (q: V2) => P3(q, corePad && dist(q, core.at) < core.radius ? padY : undefined);
  const appr = leg(start, stands[0]!, "approach");
  let track: ApproachTrack | null = null;
  if (!failed.has(appr)) {
    if (trackW <= 0) notes.push(`approach: no track (a ${place.size} is reached on foot; the leg stays a walk route)`);
    else { // the track runs from its join to the core's edge (radius - 1): the pad is the place's own ground
      // L (seated, kirk-knowe 2026-10-21: the track's regraded band lifted the ground 0.55 m off a bell post's base): the
      // track stops where its band (half width + shoulder + smooth) would reach a structure or a wall (trimTrack)
      const ps = trimTrack(outside(appr, [core]), trackW, solids, obs.segs), len = ps.slice(1).reduce((m, q, i) => m + dist(ps[i]!, q), 0);
      if (ps.length >= 2 && len >= 8) { track = { id: trackId(poi), points: ps.map((q) => q.map(r2) as V2), width: trackW, maxGrade: a.route.maxGrade, from: roadJoin ? roads[roadJoin.line]!.id : "the approach line", lengthM: Math.round(len) }; lines.push(track.points);
        notes.push(`approach track: ${trackW} m carved + painted, ${track.lengthM} m from ${track.from} to the core`); }
      else notes.push(`approach: no track (the planned leg is ${Math.round(len)} m outside the core)`);
    }
  }
  routes.push({ id: "approach", note: "the approach to the core", points: appr.map(Y) });
  for (const pk of pockets.slice(1)) {
    if (a.pockets.find((q) => q.id === pk.id)?.sight) { notes.push(`pocket ${pk.id}: a sight across the water, no route`); continue; }
    const i = pockets.indexOf(pk), l = leg(stands[0]!, stands[i]!, `core -> ${pk.id}`);
    path(`to-${pk.id}`, l, [core, pk], !failed.has(l));
    routes.push({ id: `to-${pk.id}`, note: `core -> ${pk.id}`, points: l.map((q, j) => (j === l.length - 1 ? P3(q, pk.y) : Y(q))) });
  }
  // L (walk): poi-walk reaches an area or clearing from the NEAREST point of the route graph (2 m samples, within 12 m)
  // in a straight line; when that line meets a wall or a structure (a creature clearing inside a walled yard, nearest to
  // the footpath outside it), the target gets its own planned spur from its pocket's stand point
  const graph = () => [...routes.map((r: any) => r.points.map((q: number[]) => [q[0], q[2]] as V2)), ...lines].flatMap((l: V2[]) => l.slice(1).flatMap((q, i) => { const p = l[i]!, n = Math.max(1, Math.ceil(dist(p, q) / 2)); return Array.from({ length: n + 1 }, (_, t) => [p[0] + ((q[0] - p[0]) * t) / n, p[1] + ((q[1] - p[1]) * t) / n] as V2); }));
  const targets = [...areas.map((x: any) => ({ id: `area-${x.id}`, at: x.centre as V2 })), ...clearings.filter((c: any) => c.walk !== false).map((c: any) => ({ id: c.id as string, at: c.center as V2 }))]; // walk: false = ground cleared under a solid or a basin's water, never a spot a body walks to (poi-walk skips it too)
  for (const t of targets) {
    if (!pointFree(g, obs, t.at)) continue; // a structure's own cover clearing: nobody stands in its middle
    const near = graph().reduce((m: V2 | null, q) => (!m || dist(q, t.at) < dist(m, t.at) ? q : m), null);
    if (near && dist(near, t.at) <= 12 && lineFree(g, obs, near, t.at)) continue;
    const k = pockets.reduce((m, pk) => (dist(pk.at, t.at) < dist(m.at, t.at) ? pk : m), core), from = stands[pockets.indexOf(k)]!, l = routeGrid(g, from, t.at, obs, { prefer: a.route.maxGrade });
    if (!l) { faults.push(`target ${t.id}: no walkable way from the ${k.id} stand`); continue; }
    routes.push({ id: `to-${t.id}`, note: `${k.id} stand -> ${t.id} (its straight reach from the footpath is blocked)`, points: l.map((q) => (k === core ? Y(q) : P3(q))) });
  }
  // L (walk): scatter (boulders in a gully, deadfall) is cleared off every route lane: one polygon clearing per route,
  // the planned line buffered half the footpath width + 4 m each side (the ribbon's cut and fill shoulders reach past its edge: a scatter rock 4.8 m off the shielings path floated 0.09 m) (scatter only; grass stays; not a walk target: poi-walk targets circles)
  // L (scatter-float, kelpmane-cove 2026-10-21): the cut shoulder also leaves the GRASS cover standing 0.5 m over the
  // cut ground 2.9 m past a footpath's edge: a narrower cover band (half the width + COVER_LANE_M) is cleared too; grass
  // stays beyond it
  const laneW = (id: string) => (id === "approach" && track ? track.width : a.route.width); // the track is wider than a footpath
  const laneBand = (l: V2[], w: number): V2[] => { const L: V2[] = [], R: V2[] = [];
    l.forEach((q, i) => { const a0 = l[Math.max(0, i - 1)]!, b0 = l[Math.min(l.length - 1, i + 1)]!, d = dist(a0, b0) || 1, nx = -(b0[1] - a0[1]) / d, nz = (b0[0] - a0[0]) / d;
      L.push([r2(q[0] + nx * w), r2(q[1] + nz * w)]); R.push([r2(q[0] - nx * w), r2(q[1] - nz * w)]); });
    return [...L, ...R.reverse()]; };
  for (const r of routes) {
    const l: V2[] = r.points.map((q: number[]) => [q[0], q[2]] as V2);
    if (l.length < 2) continue;
    clearings.push({ id: `${poi}-lane-${r.id}`, polygon: laneBand(l, laneW(r.id) / 2 + 4), feather: 1, keep: 0, scatter: true, cover: false, owner: poi });
    clearings.push({ id: `${poi}-lane-cover-${r.id}`, polygon: laneBand(l, laneW(r.id) / 2 + COVER_LANE_M), feather: 1, keep: 0, scatter: false, cover: true, owner: poi });
  }
  for (const l of lines) keepClear.push(l === track?.points ? { id: "track-approach", why: "approach track", points: l, width: track.width + 1.2 } : { id: `path-${keepClear.length}`, why: "footpath", points: l.map((q) => q.map(r2)), width: a.route.width + 1.2 });
  // L (walk): every declared route lane (through gates, across yards) is kept clear of dressing too
  for (const r of routes) keepClear.push({ id: `route-${r.id}`, why: "walk route", points: r.points.map((q: number[]) => [q[0], q[2]]), width: 2.4 });
  // QUEST OBJECTS (archetype `quest`): each object the quest plan declares here is one item of the core's first plan
  for (const q of inp.questObjects ?? []) {
    // a layout piece naming the slot (`pieces[].quest`) puts the quest entity at its own spot (Exiles' Bell 2026-10-24: the
    // mending board landed at the plan's auto spot, not where the owner drew it)
    const piece = L?.pieces.find((x) => x.quest === q.id && !refused.has(x.id));
    const prop = a.quest[q.id] ?? piece?.prefab, plan = plans.find((d) => d.id === `${poi}-core`) ?? plans[0];
    if (!prop) { faults.push(`quest object ${q.id} (${q.kind}${q.what ? `: ${q.what}` : ""}) has no prop: --set quest.${q.id}=<catalogued prop>`); continue; }
    if (!plan) { faults.push(`quest object ${q.id}: the place has no dressing plan to hold it`); continue; }
    // FIRST in the plan: the quest entity claims its room before the loose dressing (RETTING 2026-10-23: appended last, the
    // quest stook was the item dropped `no room on the socket map` and the binding had no entity)
    const w = piece ? layoutWorld.get(piece.id)!.w : null, deg = piece ? ((((yaw * 180) / Math.PI + piece.yaw) % 360) + 360) % 360 : 0;
    plan.items.unshift({ id: q.id, prop, place: w ? { kind: "floor", level: 0, at: [r2(w[0]), r2(w[1])], yaw: r2(deg) } : { kind: "auto", room: Object.keys(plan.rooms)[0], prefer: "open" }, quest: { entity: q.id } });
    notes.push(`quest object ${q.id} = ${prop} (plan ${plan.id}${piece ? `, at layout piece ${piece.id}` : ""})`);
  }
  for (const x of L?.pieces ?? []) if (x.quest && !(inp.questObjects ?? []).some((q) => q.id === x.quest)) notes.push(`LAYOUT: piece ${x.id}: quest ${x.quest}: the quest plan declares no object ${x.quest} here (placed nowhere)`);
  for (const id of Object.keys(a.quest)) if (!(inp.questObjects ?? []).some((q) => q.id === id)) notes.push(`quest.${id}: the quest plan declares no object ${id} here (ignored)`);
  const propRequests = a.propRequests.map((q) => { const pk = pockets.find((x) => x.id === q.pocket) ?? core, w = toWorld(pk.at, front, q.at);
    keepClear.push({ id: `request-${q.name.replace(/\W+/g, "-")}`, why: `prop request: ${q.name}`, at: [r2(w[0]), r2(w[1])], radius: q.radius });
    return { name: q.name, culture: a.culture[0], scale: "human", for: poi, at: [r2(w[0]), r2(w[1])], why: q.why }; });
  for (const q of ringReq) propRequests.push({ name: q.name, culture: a.culture[0]!, scale: "human", for: poi, at: q.at, why: q.why });
  const lm = landmark as { at: V2; foot: number; top: number; fogReach: number } | null;
  // viewpoints: player height round the core, and the approach-read spots (150-300 m along each approach)
  const views: any[] = [];
  // L (evidence, weep-well 2026-10-20): the rig's pivot stands `distance` m toward the target and the camera at `from`:
  // neither may be under water. A shore spot can be dry by the field yet lower than the lake beside it (the camera sat
  // under the tarn's surface): wet, or within a lake's radius + 40 m and under its waterY + 0.3, slides the spot back
  // from the target in 4 m steps (up to 40 m); still under -> the view is dropped with a note.
  // L (evidence, Hagsheer 2026-10-21: the aerial sat inside the pyre flames, core views inside a wall): the body and the
  // camera keep CAMERA_CLEAR_M past every structure footprint and wall line
  const clearOfBuilt = (q: V2) => solids.every((d) => dist(q, d.at) >= d.r + CAMERA_CLEAR_M) && obs.segs.every(([a0, b0, hw]) => segDist(q, a0, b0) >= hw + CAMERA_CLEAR_M);
  const underWater = (q: V2) => g.wet(q[0], q[1]) || (inp.waters ?? []).some((l) => dist(q, l.center) <= l.radius + 40 && g.height(q[0], q[1]) < l.waterY + 0.3);
  const look = (name: string, from: V2, to: V2, distance = 4) => { const d = dist(from, to) || 1, dx = (to[0] - from[0]) / d, dz = (to[1] - from[1]) / d;
    for (let back = 0; back <= 40; back += 4) { const cam: V2 = [from[0] - dx * back, from[1] - dz * back], pivot: V2 = [cam[0] + dx * distance, cam[1] + dz * distance];
      if (underWater(cam) || underWater(pivot) || !clearOfBuilt(cam) || !clearOfBuilt(pivot)) continue;
      if (back) notes.push(`view ${name}: moved ${back} m back from the target (the camera or the body stood under water or in a structure)`);
      views.push({ name, x: r2(pivot[0]), z: r2(pivot[1]), facing: Math.round(((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360), distance }); return; }
    notes.push(`view ${name}: dropped (under water within 40 m behind its spot)`); };
  // L (evidence): a view stands on dry ground near the place's level; a core on a cliff edge is looked at from the land
  // side (the first of the turns round it that is dry and within 4 m of the pad), never from over the sea
  const ground = (at: V2, y: number, deg: number, r: number): V2 => { for (const t of [0, 45, -45, 90, -90, 135, -135, 180]) { const a = ((deg + t) * Math.PI) / 180, q = toWorld(at, front, [Math.sin(a) * r, Math.cos(a) * r]);
    if (!g.wet(q[0], q[1]) && Math.abs(g.height(q[0], q[1]) - y) <= 4) return q; } return toWorld(at, front, [0, r]); };
  // L (TOOLS-PB 2026-10-23: the reviewer judged a place from core-front 40 m out, which showed nothing): two player-height
  // views per walked pocket, CLOSE_VIEW_M from its centre: `<pocket>-close` toward the approach, `<pocket>-close-side` at 90 deg
  for (const k of pockets) { if (a.pockets.find((x) => x.id === k.id)?.sight) continue;
    look(`${k.id}-close`, ground(k.at, k.y, 0, CLOSE_VIEW_M), k.at, 1); look(`${k.id}-close-side`, ground(k.at, k.y, 90, CLOSE_VIEW_M), k.at, 1); }
  const setViews = a.views.map((v) => { const c = toWorld(core.at, front, [v.camera[0], v.camera[2]]), t = toWorld(core.at, front, [v.target[0], v.target[2]]);
    const camera = [r2(c[0]), r2(padY + v.camera[1]), r2(c[1])], target = [r2(t[0]), r2(padY + v.target[1]), r2(t[1])];
    return { name: v.name, x: camera[0], z: camera[2], y: Math.round((camera[1]! - 1.7) * 10) / 10, camera, target }; });

  // the aerial's body: the core centre, or the first spot toward the front (4 m steps) clear of the built pieces
  let aerial: V2 = core.at; for (let s0 = 0; s0 <= 40; s0 += 4) { const q = toWorld(core.at, front, [0, s0]); if (clearOfBuilt(q) && !g.wet(q[0], q[1])) { aerial = [r2(q[0]), r2(q[1])]; if (s0) notes.push(`view aerial-150: body moved ${s0} m toward the approach (the core centre is built on)`); break; } }
  const band = readBand(place.size, a.read.band), spots = approachSpots(core.at, reservation.approaches, band, (p) => !g.wet(p[0], p[1]));
  // one viewpoint per approach: its farthest spot in the read window
  // L (evidence, PLACES-FIX 2026-10-21: rope-walk's read shot was a cliff face 4 m from the camera, wreck-road's a dot):
  // the read view stands on the spot the read check JUDGES (approachRead's row: the farthest spot of the line that reads,
  // else its best), and the camera stays 1 m behind the eye (4 m back down a slope had put the cliff between them)
  const judged = lm ? approachRead(g, lm, spots).rows.map((r) => ({ p: r.at as V2, d: r.distance })) : null;
  const reads = judged ?? [...new Set(spots.map((s) => s.line))].map((l) => spots.filter((s) => s.line === l).reduce((m, s) => (s.d > m.d ? s : m)));
  reads.forEach((s, i) => look(`read-${i + 1}-${Math.round(s.d)}m`, s.p, lm?.at ?? core.at, 1));
  for (const v of a.read.views) look(`far-${v.name}-${Math.round(dist(v.at, lm?.at ?? core.at))}m`, v.at, lm?.at ?? core.at);
  // the layout's extra dressing AREAS (one fresh dresser each, plan <poi>-<id> in the job's dressing/, which plan keeps):
  // L (o-small2 dropped-hour 2026-10-30): a pinpoint has one pocket, so a camp's midden and an opened tomb had no area of their own
  if (L) for (const q of L.areas ?? []) {
    if (areas.some((x) => x.id === q.id)) { faults.push(`LAYOUT: area ${q.id} repeats a pocket's dressing area`); continue; }
    const c = toWorld(core.at, front, q.at), rc = q.reach ? toWorld(core.at, front, q.reach) : c;
    areas.push({ id: q.id, role: q.role, centre: [r2(c[0]), r2(c[1])], radius: q.radius, note: q.note, reach: [r2(rc[0]), r2(g.height(rc[0], rc[1])), r2(rc[1])] });
  }
  const handoff = {
    version: 1, poiId: poi, ownerAgentId: "place-build", builder: { tool: "place-build", archetype: a.id },
    // L (KNUCKLECROWN 2026-10-29): the dress-site brief prints handoff `idea`; a place-build handoff had none ("undefined")
    idea: (inp.place.text ?? inp.place.name).split(/(?<=\.)\s/)[0]!.slice(0, 300),
    stage: "blockout", integration: { sceneOps: "ops.json", worldOps: "world-ops.json + operators.json", clearings: "clearings.json" },
    measurements: { adventureSize: place.size, features, approaches: reservation.approaches.filter((l) => l.length).map((_, i) => `approach-${i + 1}`) },
    navigation: { routes, network: lines.map((l) => l.map((q) => q.map(r2))) },
    approachTrack: track ? { id: track.id, width: track.width, from: track.from, lengthM: track.lengthM } : null,
    siteDressing: { lights: a.lights, areas, keepClear },
    landmark: lm ? { at: [r2(lm.at[0]), r2(lm.at[1])], foot: r2(lm.foot), top: r2(lm.top), fogReach: lm.fogReach } : null, smoke: smokes,
    read: { ...a.read, band, approachLine: near && near.d > core.radius + 6 ? near.line : null }, viewpoints: views, populateClearings: encounters.map((e) => e.id),
  };
  notes.push(`TIER: built ${place.size}${a.spreadMax !== undefined ? `; pockets within ${a.spreadMax} m of the core's pad (spreadMax)` : ""}`);
  return { centre: core.at, padY, front, yaw, faults, notes, pockets, worldOps, operators, clearings, encounters, ops, plans, handoff, propRequests, aerial, track, requested, setViews };
}

/** L (approach, peat-banks/gibbet-rise 2026-10-20): a reservation's approach may name only what it is reached `from`
 *  (points: []): the line is resolved from the world, never dropped (an empty line left the place with no footpath join
 *  and the read check with "no approach line to judge from"). A road/path/trail id -> its points within 600 m of the
 *  centre (the stretch round its nearest point), else [nearest point, centre]; a river -> [nearest point, centre]; a town,
 *  recipe POI, region (hub or polygon centroid) or another reservation -> [its centre, this centre]. Unresolved -> none. */
/** Metres between one road leg's end and the next leg's start that still make them one road (approachLines). */
export const ROAD_LEG_JOIN_M = 40;
export function approachLines(recipe: any, reservations: any[], res: { center: V2; approach?: any; approaches?: any[] }): { lines: V2[][]; resolved: string[]; unresolved: string[]; names: string[] } {
  const c = res.center, lines: V2[][] = [], names: string[] = [], resolved: string[] = [], unresolved: string[] = [], f = recipe.features ?? {};
  const xz = (q: number[]): V2 => (q.length >= 3 ? [q[0]!, q[2]!] : [q[0]!, q[1]!]);
  for (const ap of [res.approach, ...(res.approaches ?? [])].filter(Boolean)) {
    if ((ap.points ?? []).length >= 2) { lines.push(ap.points as V2[]); names.push(ap.from ?? `points-${lines.length}`); continue; }
    const id = ap.from as string, road = (f.roads ?? []).find((r: any) => r.id === id), river = (f.rivers ?? []).find((r: any) => r.id === id);
    if (road || river) {
      const pts: V2[] = ((road ?? river).points as number[][]).map(xz);
      // L (KNUCKLECROWN 2026-10-29): a road approach named by one LEG (`path-...-crown.s2`) was judged on that leg alone.
      // L (KNUCKLECROWN close 2026-10-29: "line 0 reads 0 px" while the first-sight frame showed 28-46 px): the legs were
      // still separate lines (the road from Saltharrow was line 5 + line 0, each judged on its own stretch). A ROAD is one
      // line: every leg of its chain (`<base>`, `<base>.s2`, ... joined end to start within ROAD_LEG_JOIN_M), named by its
      // base id, so naming any leg (or a renumbered one's neighbour) judges the whole road once.
      let chainName = id;
      if (road) { const m = /^(.*?)(?:\.s(\d+))?$/.exec(id)!, base = m[1]!, legOf = (k: number) => (f.roads ?? []).find((r: any) => r.id === (k === 1 ? base : `${base}.s${k}`));
        const legPts = (r: any) => (r.points as number[][]).map(xz);
        let k0 = Number(m[2] ?? 1); while (k0 > 1) { const pv = legOf(k0 - 1), cur = legOf(k0); if (!pv || !cur) break; const pp = legPts(pv); if (dist(pp[pp.length - 1]!, legPts(cur)[0]!) > ROAD_LEG_JOIN_M) break; k0--; }
        pts.length = 0; pts.push(...legPts(legOf(k0) ?? road));
        for (let k = k0 + 1; ; k++) { const nx = legOf(k); if (!nx) break; const np = legPts(nx); if (dist(np[0]!, pts[pts.length - 1]!) > ROAD_LEG_JOIN_M) break; pts.push(...np); }
        chainName = base; }
      const ni = pts.reduce((m, q, i) => (dist(q, c) < dist(pts[m]!, c) ? i : m), 0);
      let i0 = ni, i1 = ni; while (i0 > 0 && dist(pts[i0 - 1]!, c) <= 600) i0--; while (i1 < pts.length - 1 && dist(pts[i1 + 1]!, c) <= 600) i1++;
      const l = road && i1 > i0 ? pts.slice(i0, i1 + 1) : [pts[ni]!, c];
      lines.push(l.map((q) => [r2(q[0]), r2(q[1])] as V2)); names.push(chainName); resolved.push(`${id} (${road ? "road" : "river"})`); continue;
    }
    const town = (f.towns ?? []).find((t: any) => t.id === id), poi = (f.pois ?? []).find((t: any) => t.id === id), reg = (recipe.regions ?? []).find((t: any) => t.id === id), other = reservations.find((r: any) => r.location === id);
    const at: V2 | null = town ? xz(town.center) : poi ? xz(poi.position) : other ? (other.center as V2) : reg ? (reg.hub ? xz(reg.hub.position ?? reg.hub) : (() => { const P = reg.polygon as V2[]; return [P.reduce((t, q) => t + q[0], 0) / P.length, P.reduce((t, q) => t + q[1], 0) / P.length] as V2; })()) : null;
    if (at && Number.isFinite(at[0]) && Number.isFinite(at[1]) && dist(at, c) > 1) { lines.push([[r2(at[0]), r2(at[1])], [r2(c[0]), r2(c[1])]]); names.push(id); resolved.push(`${id} (${town ? "town" : poi ? "poi" : other ? "reservation" : "region"})`); }
    else unresolved.push(id);
  }
  // a reservation naming one road twice (approach + approaches: wreck-road, coffin-road) judged it twice: one line each
  const seen = new Set<string>(), keep = lines.map((l) => { const k = JSON.stringify(l); if (seen.has(k)) return false; seen.add(k); return true; });
  return { lines: lines.filter((_, i) => keep[i]), names: names.filter((_, i) => keep[i]), resolved, unresolved };
}

/** L (art, zfight): catalogue pieces the gates reject (camp-props/tent and spoilgate/chain-post were lifted 2026-10-21 by
 *  PLACES-FIX: the art gate now judges an atlas by the texels a piece samples, cloth tile and giant-camp timber re-valued), never placed by the place builder (slot -> its first allowed
 *  choice; dressing / fill -> skipped). Fix the prop (prop-intake) and take it off this list. */
export const DENIED_PROPS: Record<string, string> = {
  "carters-rest/lean-to": "z-fights itself (frame vs roof, 0.69 m2)",
  "camp-props/lean-to": "wraps carters-rest/lean-to (z-fights itself)",
  "spoilgate/chain-post": "z-fights itself (p00-timber vs its ironwork, goat-tables 2026-10-21; its L* was fixed)",
  "town-craft/covered-public-water-trough": "its base slab lies coplanar with the ground and z-fights the voxel terrain (0.55 m2, wreck-road 2026-10-22)",
  "town-craft/dockside-tally-stand": "its flat base z-fights level ground (0.1 m2 at retting-ponds)",
  "town-craft/bundled-river-oars": "its flat base z-fights level ground (0.13 m2 at strangers-acre)",
  "house-interior/handcart": "a bare wheel-and-axle cart: banned by the owner (2026-10-21), superseded",
  "house-interior/barrel-a": "out of the L* band (24.2 vs 37.4 at signal-tower 2026-10-21)",
};
const cultureOk = (a: { culture: string[] }, info?: PlaceInput["propInfo"]) => (prop: string) => { const c = info?.(prop)?.cultures; return !c || !c.length || c.includes("any") || c.some((x) => a.culture.includes(x)); };
/** Camp gear: banners, porters' frames, tents, lean-tos, bedrolls. L (weep-well, hags-nose 2026-10-20): the automatic
 *  fill put camp banners and porter frames at a salt tarn shrine and a hag's nose ("camp props at a hag shrine",
 *  "banner and frame thin"): camp gear fills only the `camp` archetype. */
export const CAMP_ONLY_RE = /^camp-props\/|banner|porters?-back-frame|\btent\b|-tent$|lean-to|bedroll/;
/** What a fill prop must pass: not denied (globally or by the archetype), of the place's people (dress check
 *  wrong-culture), and no camp gear outside the camp archetype (`id` given and not `camp`). */
export const fillOk = (a: { culture: string[]; deny: string[]; id?: string }, info?: PlaceInput["propInfo"]) => (prop: string) =>
  !DENIED_PROPS[prop] && !a.deny.includes(prop) && cultureOk(a, info)(prop) && (a.id === undefined || a.id === "camp" || !CAMP_ONLY_RE.test(prop));
/** The role's small fill props that pass `ok`. */
export const roomFill = (role: string, ok: (prop: string) => boolean) => (ROOM_FILL[role] ?? ROOM_FILL.yard!).filter(ok);
/** Why fillOk refuses a prop (null = it passes): the plan's and the dress gate's record of a requested prop not placed. */
export const fillWhy = (a: { culture: string[]; deny: string[]; id?: string }, info?: PlaceInput["propInfo"]) => (prop: string): string | null =>
  DENIED_PROPS[prop] ? `denied: ${DENIED_PROPS[prop]}` : a.deny.includes(prop) ? "denied: on the archetype's deny list"
    : !cultureOk(a, info)(prop) ? `wrong culture: ${info?.(prop)?.cultures?.join("/")}, the place is ${a.culture.join("/")}`
    : a.id !== undefined && a.id !== "camp" && CAMP_ONLY_RE.test(prop) ? "camp gear outside the camp archetype" : null;
/** The density top-up's props for a pocket (L TOOLS-PB 2026-10-23, hero top-up): its own `dressing.filler`, else the
 *  archetype's `filler`, else the role's fill; never a prop the pocket's `dressing.props` asks for (those counts are exact). */
export function fillerFor(filler: string[] | undefined, role: string, ok: (prop: string) => boolean, requested: string[] = []): string[] {
  const own = (filler ?? []).filter((q) => ok(q) && !requested.includes(q));
  return own.length ? own : roomFill(role, ok).filter((q) => !requested.includes(q));
}
/** spreadMax (TOOLS-PB 2026-10-23): the farthest a satellite pocket's centre may stand from the core's (core fit + pocket
 *  fit + spreadMax); Infinity when the archetype sets none. */
export const spreadReach = (a: { spreadMax?: number }, core: { radius: number; fit?: number }, p: { radius: number; fit?: number }) =>
  a.spreadMax === undefined ? Infinity : (core.fit ?? core.radius) + (p.fit ?? p.radius) + a.spreadMax;
/** A requested prop of a dressing plan that did not land: why (a plan-time refusal or a dress-loop drop). */
export type PlanDrop = { prop: string; count?: number; why: string };
/** DRESS GATE (L TOOLS-PB 2026-10-23, silent drop: a requested wreck-salvage-pile produced no entity and the gate said
 *  "every first plan resolves"): each prop the archetype / design asked of a plan (`requested`, exact counts) against the
 *  plan's items; one fault per prop short, naming it and why (its plan-time `why`, else the dress loop's record, else
 *  "dropped without a record"). Empty = every requested prop is in the plan. */
export function requestedShortfall(requested: { prop: string; count: number; why?: string }[], items: { prop: string }[], dropped: PlanDrop[] = []): string[] {
  const want = new Map<string, { n: number; why?: string }>();
  for (const q of requested) { const w = want.get(q.prop) ?? { n: 0 }; w.n += q.count; w.why ??= q.why; want.set(q.prop, w); }
  const out: string[] = [];
  for (const [prop, w] of want) { const have = items.filter((it) => it.prop === prop).length; if (have >= w.n) continue;
    out.push(`${prop}: ${have}/${w.n} placed (${w.why ?? dropped.find((d) => d.prop === prop)?.why ?? "dropped without a record"})`); }
  return out;
}
/** The archetype without denied pieces: a denied slot prefab becomes its first allowed choice (else a fault), a denied
 *  or wrong-culture dressing prop is a fault (the archetype is wrong: its author fixes the JSON, a runner cannot). */
export function withoutDenied(a: PlaceArchetype, info: PlaceInput["propInfo"], faults: string[], notes: string[]): PlaceArchetype {
  const no = (id: string) => DENIED_PROPS[id] ?? (a.deny.includes(id) ? "on the archetype's deny list" : null), people = cultureOk(a, info);
  const pockets = a.pockets.map((p) => ({ ...p,
    structures: p.structures.map((s) => { const why = no(s.prefab); if (!why) return s;
      const alt = s.choices.find((c) => !no(c));
      if (!alt) { faults.push(`${p.id}.${s.id}: ${s.prefab} is denied (${why}) and the slot has no allowed choice: --set ${p.id}.${s.id}=<prefab>`); return s; }
      notes.push(`${p.id}.${s.id}: ${s.prefab} denied (${why}) -> ${alt}`); return { ...s, prefab: alt }; }),
    dressing: p.dressing && { ...p.dressing, props: p.dressing.props.filter((q) => { const why = no(q.prop);
      if (why) { notes.push(`${p.id} dressing: ${q.prop} skipped (${why})`); return false; }
      if (!people(q.prop)) faults.push(`${p.id} dressing: ${q.prop} is ${info?.(q.prop)?.cultures?.join("/")}, not of the archetype's culture ${a.culture.join("/")} (dress check wrong-culture): fix the archetype's culture or props`);
      return true; }) } }));
  return { ...a, pockets };
}
/** Outdoor room roles and the neighbouring roles a prop may declare and still belong (dress check room-role). */
const ROOM_ALSO: Record<string, string[]> = { camp: ["camp", "yard", "street"], yard: ["yard", "street", "quay", "camp", "plaza"], shore: ["shore", "quay", "yard", "camp"], ruin: ["ruin", "yard", "camp"], path: ["path", "street", "yard"], "cave-mouth": ["cave-mouth", "camp", "ruin"] };
/** Small outdoor props (< 0.5 m2 of floor) that top a room up to the minimum without eating the cover ceiling, per role. */
export const ROOM_FILL: Record<string, string[]> = {
  // L (fill): only a camp is filled with camp gear; every other role is filled with small boulders (any culture; never rock-kit/scree: its flat underside z-fights a cairn or boulder base on level ground, weep-well)
  camp: ["town-craft/porters-back-frame", "camp-props/banner", "rock-kit/boulder-s-1"],
  yard: ["rock-kit/boulder-s-1", "rock-kit/boulder-s-2", "rock-kit/boulder-s-3"],
  shore: ["rock-kit/boulder-s-1", "rock-kit/boulder-s-2", "rock-kit/boulder-s-3"],
  ruin: ["rock-kit/boulder-s-1", "rock-kit/boulder-s-3", "rock-kit/boulder-s-2"],
  path: ["rock-kit/boulder-s-1", "rock-kit/boulder-s-2", "rock-kit/boulder-s-3"],
  "cave-mouth": ["rock-kit/boulder-s-2", "rock-kit/boulder-s-1", "poi-props/small-bone-pile"],
};
const CONTAINER_RE = /crate|barrel|sack|box|chest|basket/i;
/** The first plan's items: the archetype's list, topped up to the room minimum `dress check` asks for an area of the
 *  area's size (core dressing defaultMinItems: max(2, area/15), at most 6), repeating non-container props first
 *  (containers have their own budget). L: furnishing scales with floor area. */
/** L (owner walk 2026-10-21: "they don't look designed... is it looking for a small square place to put things?"): an
 *  area's first plan is laid out in VIGNETTES (plan `arrangements`, resolved by @hitreg/core's dressing resolver), by its
 *  role: a camp round the pocket's fire structure, a yard before the pocket's first structure, a work line for what a
 *  yard or camp holds past its own vignette (shore: the work line on its own); graves keep their rows. Boulders and other
 *  natural fill stay loose (`prefer: open` spreads them), quest objects keep their own place. Item ids are KEPT (quest
 *  stand-in swaps survive a re-plan): only the places change. Pure. */
export const VIGNETTE_MEMBERS = { camp: 6, yard: 6, "work-line": 5, shrine: 5, lookout: 3 } as const;
/** Metres a pocket's dressing area reaches past its radius (round the pocket centre): room for vignettes past the structures. */
export const DRESS_RIM_M = 3;
export function arrangeFirstPlan<T extends { id: string; prop: string; place: any; quest?: unknown }>(items: T[], role: string, room: string, structures: { id: string; role: string }[], pocket: string): { items: T[]; arrangements: any[] } {
  const arrangements: any[] = [], loose = (it: T) => /^rock-kit\//.test(it.prop) || !!it.quest;
  const join = (it: T, arrangement: string): T => ({ ...it, place: { kind: "auto", room, arrangement } });
  const fire = structures.find((s) => s.role === "fire"), built = structures.find((s) => s.role !== "fire" && s.role !== "boat");
  let first: { id: string; kind: string; cap: number } | null = null;
  // L (PLACES-FIX 2026-10-21: 26 installed places failed site-spread / site-clutter): a ruin, cave mouth or path pocket had
  // NO vignette, every prop stood loose and heaped. A lookout pocket is a lookout, an offering pocket a shrine; a ruin or a
  // cave mouth gets a yard (before its first built piece), a path a work line along it.
  if (/lookout/.test(pocket) && role !== "camp") first = { id: "lookout", kind: "lookout", cap: VIGNETTE_MEMBERS.lookout };
  else if (/offering|shrine/.test(pocket) && role !== "camp") first = { id: "shrine", kind: "shrine", cap: VIGNETTE_MEMBERS.shrine };
  else if (role === "camp") first = { id: "camp", kind: "camp", cap: VIGNETTE_MEMBERS.camp };
  else if (role === "yard" || role === "ruin" || role === "cave-mouth") first = { id: "yard", kind: "yard", cap: VIGNETTE_MEMBERS.yard };
  else if (role === "shore" || role === "path") first = { id: "work", kind: "work-line", cap: VIGNETTE_MEMBERS["work-line"] };
  const out: T[] = [];
  let inFirst = 0, inWork = 0;
  for (const it of items) {
    if (it.place?.prefer === "row") { out.push(it); continue; } // graves: rows over the yard already (the graveyard rule)
    if (!first || loose(it)) { out.push(it); continue; }
    if (inFirst < first.cap) { inFirst++; out.push(join(it, first.id)); continue; }
    if (first.kind !== "work-line" && inWork < VIGNETTE_MEMBERS["work-line"]) { inWork++; out.push(join(it, "work")); continue; }
    out.push(it);
  }
  if (first && inFirst) {
    const anchor = first.kind === "camp" && fire ? `structure:${pocket}-${fire.id}` : first.kind === "yard" && built ? `structure:${pocket}-${built.id} front` : undefined;
    arrangements.push({ id: first.id, kind: first.kind, room, ...(anchor ? { anchor } : {}) });
  }
  if (inWork) arrangements.push({ id: "work", kind: "work-line", room });
  return { items: out, arrangements };
}

export function firstPlanItems(props: { prop: string; count: number; prefer: string }[], room: string, radius: number, role = "yard", ok: (prop: string) => boolean = (q) => !DENIED_PROPS[q], density?: number,
  o: { filler?: string[]; dropped?: PlanDrop[]; why?: (prop: string) => string | null; occupiedM2?: number } = {}) {
  for (const q of props) if (!ok(q.prop)) o.dropped?.push({ prop: q.prop, count: q.count, why: o.why?.(q.prop) ?? "not allowed here (denied, wrong culture or camp gear)" });
  const list = props.filter((q) => ok(q.prop)).flatMap((q) => Array.from({ length: q.count }, () => ({ ...q, fill: false })));
  // L (dressing, Hagsheer 2026-10-21): the floor is the role's density over the area (densityNeed), never under dress
  // check's room minimum. L (TOOLS-PB 2026-10-23, hero top-up: 1-2 wagons / figureheads / banners became 3-5): the listed
  // props keep their EXACT counts; the top-up draws only from the filler (fillerFor), its items `fill-*` (shed first)
  // L (TOOLS-LAYOUT 2026-10-24): ground the owner's layout pieces cover is no floor to fill
  const area = Math.max(0, Math.PI * radius * radius - (o.occupiedM2 ?? 0)), free = Math.sqrt(area / Math.PI), need = area < 4 ? 1 : Math.max(Math.min(6, Math.max(2, Math.floor(area / 15))), densityNeed(role, free, density));
  const fill = fillerFor(o.filler, role, ok, props.map((q) => q.prop)).map((prop) => ({ prop, count: 1, prefer: "open", fill: true })); // L (zfight, peat-banks 2026-10-21): fill boulders pushed "to the wall" sank into the bank walls
  for (let i = 0; list.length < need && fill.length; i++) list.push(fill[i % fill.length]!);
  const seen = new Map<string, number>();
  return list.map((q) => { const base = `${q.fill ? "fill-" : ""}${q.prop.split("/").pop()!}`, n = (seen.get(base) ?? 0) + 1; seen.set(base, n); return { id: `${base}-${n}`, prop: q.prop, place: { kind: "auto", room, prefer: q.prefer } }; });
}

/** Metres past a footpath's edge the grass cover is cleared (the ribbon's cut shoulder: kelpmane-cove cover 2.9 m off the edge floated 0.5 m). */
export const COVER_LANE_M = 3.5;
/** L (owner ruling 2026-10-20: "no ribbon roads: buried by terrain, never approved"): a place's approach is a CARVED +
 *  PAINTED recipe road (`worldgen road`: the roadFrom grading + painted tread the world's paths and town ramps use), wider
 *  than the 3.4 m footpaths: small 4 m, medium 5 m, large 6 m; a pinpoint gets none (reached on foot over the ground). */
export const TRACK_WIDTH_M = { pinpoint: 0, small: 4, medium: 5, large: 6 } as const;
/** Farthest (from the core) an existing road/path/trail may be for the approach track to start on it; with none that
 *  near the track starts where the place's approach line is joined (plan NOTE). */
export const TRACK_JOIN_M = 350;
/** `worldgen road` cut and fill for an approach track, on the profile and on the tread (RoadDoc maxCut/maxFill): a track
 *  rides the slope at the grade its leg was planned at (archetype route.maxGrade), never a trench or a causeway (gate lips). */
export const TRACK_CUT_M = 1.5, TRACK_FILL_M = 0.8;
/** The recipe road id of a place's approach track (`worldgen road` ids start with road-; place-build owns road-pb-<id>-*). */
export const trackId = (poi: string) => `road-pb-${poi}-approach`;
/** GATE `roads` (place-build) and zonegen status `poi <id>`: a job may not carry its approach as a ribbon: a `path` (or
 *  `ribbon`) operator, or a features.ribbons edit, whose id names the approach. One line per offender; empty = clean. */
/** How far from its centreline an approach track reshapes the ground: half its width + the shoulder (3.5 m) + the
 *  smoothing band (7 m) roadFrom writes for a 5 m track, + 1 m. */
export const trackBand = (width: number) => width / 2 + 3.5 + 7 + 1;
/** The approach track cut back from its core end (sampled every 1 m) to the last point whose regraded band (trackBand)
 *  stays clear of every structure disc (r) and wall run (hw), so the road never reshapes the ground a built piece is
 *  seated on. Fewer than 2 points left = []. */
export function trimTrack(pts: V2[], width: number, discs: { at: V2; r: number }[], segs: [V2, V2, number][]): V2[] {
  const band = trackBand(width), clear = (q: V2) => discs.every((d) => dist(q, d.at) >= d.r + band) && segs.every(([a, b, hw]) => segDist(q, a, b) >= hw + band);
  if (!pts.length || !clear(pts[0]!)) return [];
  const out: V2[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!, n = Math.max(1, Math.ceil(dist(a, b)));
    let last: V2 = a;
    for (let t = 1; t <= n; t++) { const q: V2 = [r2(a[0] + ((b[0] - a[0]) * t) / n), r2(a[1] + ((b[1] - a[1]) * t) / n)];
      if (!clear(q)) { if (dist(last, out[out.length - 1]!) > 0.01) out.push(last); return out.length >= 2 ? out : []; } last = q; }
    out.push(b);
  }
  return out;
}
/** A place as BUILT (its job: plan.json core, the approach route's stand, the structures' keep-clear discs, its wall
 *  operators), for re-planning the approach only. */
export interface BuiltPlace {
  poi: string; size: PlaceTier; core: { at: V2; radius: number }; stand: V2; maxGrade: number;
  solids: { at: V2; r: number }[]; walls: { points: V2[]; thickness?: number; openings?: { at: number; width: number }[] }[];
  approaches: V2[][]; roads?: { id: string; points: V2[] }[];
}
/** APPROACH ONLY (place-build `approach`): the approach leg planned round the place AS BUILT (never a re-plan: archetype
 *  and planner changes since the build moved re-planned structures 7-16 m and the new leg walked into the real ones), joined
 *  to the nearest road within TRACK_JOIN_M (else the approach line), the carved + painted track trimmed clear of the
 *  built pieces, its walk route, lane clearings and keep-clear lines. The same rules as planPlace's approach. */
export function approachForBuilt(g: PlaceGround, b: BuiltPlace): { track: ApproachTrack | null; route: { id: string; note: string; points: number[][] } | null; clearings: any[]; keepClear: any[]; notes: string[]; faults: string[] } {
  const notes: string[] = [], faults: string[] = [], { core, stand } = b, prefer = b.maxGrade;
  const obs: RouteObstacles = { discs: b.solids, segs: [] }, runs: V2[][] = [], hws: number[] = [];
  for (const w of b.walls) { const hw = (w.thickness ?? 0.8) / 2 + 0.4, gaps = walkGaps(w.openings); for (const r of gaps.length ? cutRing(w.points, gaps) : [w.points]) { runs.push(r); hws.push(hw); for (let i = 0; i + 1 < r.length; i++) obs.segs.push([r[i]!, r[i + 1]!, hw]); } }
  obs.gates = wallGates(runs, hws);
  const way = (from: V2, to: V2) => routeGrid(g, from, to, obs, { prefer, maxSlope: prefer }) ?? routeGrid(g, from, to, obs, { prefer, maxSlope: prefer + 0.1 }) ?? routeGrid(g, from, to, obs, { prefer });
  const trackW = TRACK_WIDTH_M[b.size] ?? 0, roads = (b.roads ?? []).filter((r) => r.points.length >= 2), padY = g.height(stand[0], stand[1]);
  let start: V2 | null = null, from = "the approach line";
  if (trackW > 0 && roads.length) {
    const rl = roads.map((r) => r.points), onIt = nearestOnApproach(core.at, rl, (q) => !g.wet(q[0], q[1]));
    if (onIt && onIt.d <= core.radius + 6) notes.push(`approach track: ${roads[onIt.line]!.id} runs by the core (${Math.round(onIt.d)} m): the place stands on it`);
    else { const tried: V2[] = [];
      for (let n = 0; n < 8 && !start; n++) { const c = nearestOnApproach(core.at, rl, (q) => !g.wet(q[0], q[1]) && dist(q, core.at) > core.radius + 6 && dist(q, core.at) <= TRACK_JOIN_M && tried.every((t) => dist(t, q) > 12)); if (!c) break; tried.push(c.p);
        if (way(c.p, stand)) { start = c.p; from = roads[c.line]!.id; } }
      if (!start) notes.push(`approach track: no road, path or trail within ${TRACK_JOIN_M} m with a walkable way to the core: it starts on the approach line`); }
  }
  if (!start) { const joinOk = (gr: number) => (q: V2) => !g.wet(q[0], q[1]) && dist(q, core.at) > core.radius + 6 && Math.abs(g.height(q[0], q[1]) - padY) <= Math.max(12, gr * dist(q, core.at));
    const tried: V2[] = [];
    for (let n = 0; n < 9 && !start; n++) { const c = [0.2, 0.3, 0.45].map((gr) => nearestOnApproach(core.at, b.approaches, (q) => joinOk(gr)(q) && tried.every((t) => dist(t, q) > 12))).find(Boolean); if (!c) break; tried.push(c.p); if (way(c.p, stand)) start = c.p; } }
  if (!start) { faults.push("route approach: no walkable way from a road or the approach line to the core as built"); return { track: null, route: null, clearings: [], keepClear: [], notes, faults }; }
  const leg = way(start, stand)!;
  // the stretch outside the core (radius - 1), trimmed clear of the built pieces (trimTrack)
  const outsideCore: V2[] = []; for (let i = 0; i < leg.length; i++) { if (dist(leg[i]!, core.at) <= core.radius - 1) { if (i > 0) { const a = leg[i - 1]!, q = leg[i]!; let lo = 0, hi = 1; for (let k = 0; k < 20; k++) { const m = (lo + hi) / 2; if (dist([a[0] + (q[0] - a[0]) * m, a[1] + (q[1] - a[1]) * m], core.at) > core.radius - 1) lo = m; else hi = m; } outsideCore.push([r2(a[0] + (q[0] - a[0]) * lo), r2(a[1] + (q[1] - a[1]) * lo)]); } break; } outsideCore.push(leg[i]!); }
  let track: ApproachTrack | null = null;
  if (trackW <= 0) notes.push(`approach: no track (a ${b.size} is reached on foot; the leg stays a walk route)`);
  else { const ps = trimTrack(outsideCore, trackW, b.solids, obs.segs), len = ps.slice(1).reduce((m, q, i) => m + dist(ps[i]!, q), 0);
    if (ps.length >= 2 && len >= 8) { track = { id: trackId(b.poi), points: ps.map((q) => q.map(r2) as V2), width: trackW, maxGrade: prefer, from, lengthM: Math.round(len) }; notes.push(`approach track: ${trackW} m carved + painted, ${track.lengthM} m from ${from} toward the core`); }
    else notes.push(`approach: no track (the leg outside the core is ${Math.round(len)} m once clear of the built pieces)`); }
  const route = { id: "approach", note: "the approach to the core", points: leg.map((q) => [r2(q[0]), r2(g.height(q[0], q[1])), r2(q[1])]) };
  const band = (l: V2[], w: number): V2[] => { const L: V2[] = [], R: V2[] = []; l.forEach((q, i) => { const a0 = l[Math.max(0, i - 1)]!, b0 = l[Math.min(l.length - 1, i + 1)]!, d = dist(a0, b0) || 1, nx = -(b0[1] - a0[1]) / d, nz = (b0[0] - a0[0]) / d; L.push([r2(q[0] + nx * w), r2(q[1] + nz * w)]); R.push([r2(q[0] - nx * w), r2(q[1] - nz * w)]); }); return [...L, ...R.reverse()]; };
  const lw = track ? track.width : 2.4;
  const clearings = [{ id: `${b.poi}-lane-approach`, polygon: band(leg, lw / 2 + 4), feather: 1, keep: 0, scatter: true, cover: false, owner: b.poi }, { id: `${b.poi}-lane-cover-approach`, polygon: band(leg, lw / 2 + COVER_LANE_M), feather: 1, keep: 0, scatter: false, cover: true, owner: b.poi }];
  const keepClear = [{ id: "route-approach", why: "walk route", points: leg.map((q) => [r2(q[0]), r2(q[1])]), width: 2.4 }, ...(track ? [{ id: "track-approach", why: "approach track", points: track.points, width: track.width + 1.2 }] : [])];
  return { track, route, clearings, keepClear, notes, faults };
}
export function ribbonApproachOps(operators: unknown[] = [], worldOps: unknown[] = []): string[] {
  const isApproach = (id: unknown) => typeof id === "string" && /(^|-)approach($|[-:.])/.test(id);
  return [
    ...(operators as any[]).filter((o) => (o?.op === "path" || o?.op === "ribbon") && isApproach(o.id)).map((o) => `operator ${o.id} (${o.op} ribbon)`),
    ...(worldOps as any[]).filter((o) => o?.kind === "ribbons" && isApproach(o.feature?.id)).map((o) => `features.ribbons ${o.feature.id}`),
  ];
}
/** Read distance per size tier (owner ruling 2026-10-19): a small place only has to show as a silhouette from about
 *  150 m; medium and larger keep the 300 m read, scaled by tier; a pinpoint (one marker at the end of its path, weepmouth
 *  2026-10-21) shows from 60 m. The window is [0.75 R, R]. */
export const READ_BY_TIER = { pinpoint: 60, small: 150, medium: 300, large: 450 } as const;
export function readBand(tier: string | undefined, override?: V2 | null): V2 {
  if (override) return override;
  const R = READ_BY_TIER[(tier ?? "medium") as keyof typeof READ_BY_TIER] ?? 300;
  return [Math.round(R * 0.75), R];
}

/** Spots along each approach inside the read window (every 15 m of path). A line that never gets that far from the
 *  place is judged from its far end. */
/** Metres between judged spots along an approach. L (KNUCKLECROWN close 2026-10-29): at 15 m the Saltharrow road's only
 *  in-band spots were [-418,260] (behind the saddle lip, 0 px) and the next at 254 m (out of the band): its first-sight
 *  point [-420,256] (266 m, 39.5 px) fell between two samples. */
export const APPROACH_SPOT_M = 4;
export function approachSpots(c: V2, lines: V2[][], band: V2, ok: (p: V2) => boolean = () => true, step = APPROACH_SPOT_M): { p: V2; d: number; line: number; reason?: string }[] {
  const out: { p: V2; d: number; line: number; reason?: string }[] = [];
  lines.forEach((l, li) => {
    const samples: V2[] = [];
    for (let i = 0; i + 1 < l.length; i++) { const a = l[i]!, b = l[i + 1]!, n = Math.max(1, Math.ceil(dist(a, b) / step)); for (let k = 0; k < n; k++) samples.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]); }
    if (l.length) samples.push(l[l.length - 1]!);
    const reaches = samples.some((p) => dist(p, c) >= band[0]);
    // L: judged where a player can stand (an approach drawn along the shore dips into the sea)
    for (let i = samples.length - 1; i >= 0; i--) if (!ok(samples[i]!)) samples.splice(i, 1);
    const inside = samples.filter((p) => { const d = dist(p, c); return d >= band[0] && d <= band[1]; });
    if (inside.length) for (const p of inside) out.push({ p, d: dist(p, c), line: li });
    else if (reaches) {
      // L (TOOLS-PB 2026-10-23: "best 0 px @ 560 m" was the line's far end, reported as if measured): the line runs through
      // the read window but nothing in it is standable: a named reason (a fault), judged from the nearest standable spot
      const gap = (p: V2) => { const d = dist(p, c); return d < band[0] ? band[0] - d : d > band[1] ? d - band[1] : 0; };
      const near = samples.length ? samples.reduce((m, p) => (gap(p) < gap(m) ? p : m)) : (l[l.length - 1] ?? c);
      out.push({ p: near, d: dist(near, c), line: li, reason: `no standable spot in band ${band[0]}-${band[1]} m (wet/steep); ${samples.length ? `nearest standable at ${Math.round(dist(near, c))} m` : "none on the line"}` });
    } else if (samples.length) {
      // nothing standable in the window: the first standable point closer in (the brow of a climb), else the far end
      const closer = samples.filter((p) => dist(p, c) < band[0]), pool = closer.length ? closer : samples;
      const far = pool.reduce((m, p) => (dist(p, c) > dist(m, c) ? p : m)); if (dist(far, c) > 30) out.push({ p: far, d: dist(far, c), line: li });
    }
  });
  return out;
}

/** APPROACH READ (lesson: the place reads from its approaches): along each approach, at least one spot in the tier's
 *  read window sees the landmark's top over the ground (eye 1.7 m, ground every 4 m, 0.5 m clearance) inside its
 *  fogReach. Rows: per line, the farthest spot that reads, else the farthest spot with where it was blocked. */
export function approachRead(g: PlaceGround, landmark: { at: V2; top: number; fogReach: number; foot?: number }, spots: { p: V2; d: number; line: number; reason?: string }[]) {
  const all = spots.map((s) => {
    const eye = g.height(s.p[0], s.p[1]) + 1.7, d = dist(s.p, landmark.at), n = Math.max(2, Math.floor(d / 4));
    let blocked: number | null = null;
    for (let k = 1; k < n; k++) { const t = k / n, x = s.p[0] + (landmark.at[0] - s.p[0]) * t, z = s.p[1] + (landmark.at[1] - s.p[1]) * t, ray = eye + (landmark.top - eye) * t;
      if (g.height(x, z) > ray + 0.5 && d * (1 - t) > 6) { blocked = r2(d * t); break; } }
    // L (read, Hagsheer 2026-10-21): with its foot known the target must also SHOW: READ_PX_MIN px of it over the ground
    // in the evidence frame (a 1.8 m wall top over the horizon at 300 m is 3.7 px: "seen" but never read)
    const px = landmark.foot === undefined ? null : readPixels(g, [s.p[0], eye, s.p[1]], { at: landmark.at, foot: landmark.foot, top: landmark.top }).px;
    return { at: s.p.map(r2), line: s.line, distance: Math.round(d), inFog: d <= landmark.fogReach, blockedAt: blocked, px, reads: !s.reason && blocked === null && d <= landmark.fogReach && (px === null || px >= READ_PX_MIN), ...(s.reason ? { reason: s.reason } : {}) };
  });
  const lines = [...new Set(all.map((r) => r.line))];
  // L (KNUCKLECROWN close 2026-10-29): each line is judged at its FIRST-SIGHT point, the farthest judged spot along the
  // road from which any of the target shows (px > 0, nothing blocking, inside fog): the row is the first spot from there
  // in that reads, and carries where the target first shows (`firstSight`) so the evidence frame is shot on that spot
  const rows = lines.map((l) => { const mine = all.filter((r) => r.line === l).sort((a, b) => b.distance - a.distance);
    const fs0 = mine.find((r) => !r.reason && r.blockedAt === null && r.inFog && (r.px === null || r.px > 0));
    const row = mine.find((r) => r.reads) ?? [...mine].sort((a, b) => (b.px ?? 0) - (a.px ?? 0))[0]!;
    return fs0 ? { ...row, firstSight: { at: fs0.at, distance: fs0.distance, px: fs0.px } } : row; });
  const unread = rows.filter((r) => !r.reads).map((r) => r.line);
  return { ok: rows.length > 0 && unread.length === 0, rows, unread, note: rows.length ? "" : "no approach line to judge from" };
}

/** The height above `foot` a target at `at` must reach to be seen (approachRead's rule: eye 1.7 m, 0.5 m clearance)
 *  from the best standable spot of approach `line` in the read window (every `step`-th spot). Infinity: no spot. */
export function readHeightNeeded(g: PlaceGround, at: V2, foot: number, lines: V2[][], band: V2, line: number, step = 1): number {
  const spots = approachSpots(at, [lines[line] ?? []], band, (p) => !g.wet(p[0], p[1])).filter((_, i) => i % step === 0);
  let best = Infinity;
  for (const s of spots) {
    const eye = g.height(s.p[0], s.p[1]) + 1.7, d = dist(s.p, at), n = Math.max(2, Math.floor(d / 4)); let need = eye;
    for (let k = 1; k < n && need - foot < best; k++) { const t = k / n; if (d * (1 - t) <= 6) continue; need = Math.max(need, eye + (g.height(s.p[0] + (at[0] - s.p[0]) * t, s.p[1] + (at[1] - s.p[1]) * t) + 0.5 - eye) / t); }
    best = Math.min(best, need - foot);
  }
  return best;
}

/** The read over every target the place shows from afar: its landmark and any smoke column (SMOKE_READ_M). Per
 *  approach line the first target that reads wins. */
export function approachReadAny(g: PlaceGround, targets: { at: V2; top: number; fogReach: number; foot?: number }[], lines: V2[][], band: V2, required?: number[]) {
  const each = targets.map((t) => approachRead(g, t, approachSpots(t.at, lines, band, (p) => !g.wet(p[0], p[1]))));
  const ids = [...new Set(each.flatMap((e) => e.rows.map((r) => r.line)))];
  const rows = ids.map((l) => { const mine = each.map((e, ti) => ({ ...e.rows.find((r) => r.line === l)!, target: ti === 0 ? "landmark" : "smoke" })).filter((r) => r.at); return mine.find((r) => r.reads) ?? mine[0]!; });
  const unread = rows.filter((r) => !r.reads && (!required || required.includes(r.line))).map((r) => r.line);
  return { ok: rows.length > 0 && unread.length === 0, rows, unread, note: rows.length ? "" : "no approach line to judge from" };
}

/** STALE CHECK (lesson: --reinstall removes what the source no longer delivers): entities tagged poi:<id> in a scene that
 *  are neither in the job's ops nor dressing (`dress-<poi>-`). Empty = clean. */
export function staleEntities(scene: { entities: Record<string, { tags?: string[] }> }, poi: string, opIds: Set<string>): string[] {
  return Object.entries(scene.entities).filter(([id, e]) => (e.tags ?? []).includes(`poi:${poi}`) && !opIds.has(id) && !id.startsWith(`dress-${poi}-`)).map(([id]) => id);
}

/** CLEARINGS CHECK (lesson: grass cleared under every dwelling/structure): each structure's footprint disc lies inside a
 *  cover-clearing of this job. */
export function unclearedStructures(keepClear: { id: string; at?: V2; radius?: number; why: string }[], clearings: { center: V2; radius: number; cover?: boolean }[]) {
  return keepClear.filter((k) => k.why.startsWith("structure") && k.at).filter((k) => !clearings.some((c) => c.cover !== false && c.center && dist(c.center, k.at!) + (k.radius ?? 0) <= c.radius + 0.01)).map((k) => k.id);
}

/** PRIMITIVE CHECK (lesson: no stacked primitive boxes stand in for an object): mesh components with a primitive source in the ops. */
export function primitiveMeshes(ops: any[]): string[] {
  return ops.filter((o) => o?.op === "add-entity" && o.entity?.components?.mesh?.source?.kind === "primitive").map((o) => o.id);
}

/** MEASURED usable area: 2 m cells within `radius` of the core, dry, slope <= 0.6, flood-filled from the core. */
/** Convex hull of points (monotone chain). */
export function hull(points: V2[]): V2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]), cr = (o: V2, a: V2, b: V2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: V2[] = [], up: V2[] = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2]!, up[up.length - 1]!, q) <= 0) up.pop(); up.push(q); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}
const inPoly = (q: V2, poly: V2[]) => { let a = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!; if (zi > q[1] !== zj > q[1] && q[0] < ((xj - xi) * (q[1] - zi)) / (zj - zi) + xi) a = !a; } return a; };
/** L (size): flood-filled from the core AND from every other pocket (each is joined to the core by a walked footpath,
 *  so ground round it is reachable even when a steep bank parts it from the core's own floor). */
export function usableArea(g: PlaceGround, c: V2, radius: number, within?: V2[], seeds: V2[] = []): number {
  const s = 2, n = Math.ceil(radius / s), seen = new Set<string>(), q: [number, number][] = [];
  const ok = (i: number, j: number) => { const x = c[0] + i * s, z = c[1] + j * s; if (Math.hypot(i * s, j * s) > radius || g.wet(x, z) || (within && !inPoly([x, z], within))) return false;
    return Math.abs(g.height(x + s, z) - g.height(x, z)) / s <= 0.6 && Math.abs(g.height(x, z + s) - g.height(x, z)) / s <= 0.6; };
  for (const [i, j] of [[0, 0], ...seeds.map((p) => [Math.round((p[0] - c[0]) / s), Math.round((p[1] - c[1]) / s)])] as [number, number][]) if (!seen.has(`${i},${j}`) && Math.abs(i) <= n && Math.abs(j) <= n && ok(i, j)) { seen.add(`${i},${j}`); q.push([i, j]); }
  while (q.length) { const [i, j] = q.pop()!; for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) { const k = `${i + di},${j + dj}`; if (seen.has(k) || Math.abs(i + di) > n || Math.abs(j + dj) > n || !ok(i + di, j + dj)) continue; seen.add(k); q.push([i + di, j + dj]); } }
  return seen.size * s * s;
}

// ---------------------------------------------------------------------------------------------------------------------
// SITE SEARCH (owner ruling 2026-10-20: pockets go on level ground). The reservation's ground is measured once as a
// slope map; the core is moved to the flattest pocket in the reserved disc (and a ring round it up to `roam` x its
// radius) whose satellites also find level, dry, connected ground at the tier's spread, so the place holds the tier's
// usable area. Water, the road corridor and existing entities are excluded. Pure: tested on synthetic ground.

/** The measured ground round a site on a `step` m raster: heights, wet, `ok` (dry and both 1-step slopes <= 0.6,
 *  the size gate's usable-cell rule), `blocked` (road corridor, other entities), 4-connected components of ok cells. */
export interface SlopeMap { x0: number; z0: number; step: number; nx: number; nz: number; h: Float32Array; wet: Uint8Array; ok: Uint8Array; blocked: Uint8Array; comp: Int32Array }
export interface SiteBlockers { segs: [V2, V2, number][]; discs: { at: V2; r: number }[] }
export function slopeMap(g: PlaceGround, centre: V2, R: number, blockers: SiteBlockers = { segs: [], discs: [] }, step = 2): SlopeMap {
  const x0 = centre[0] - R, z0 = centre[1] - R, nx = Math.ceil((2 * R) / step) + 1, nz = nx, N = nx * nz;
  const h = new Float32Array(N), wet = new Uint8Array(N), ok = new Uint8Array(N), blocked = new Uint8Array(N), comp = new Int32Array(N).fill(-1);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const x = x0 + i * step, z = z0 + j * step, k = j * nx + i; h[k] = g.height(x, z); wet[k] = g.wet(x, z) ? 1 : 0; }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const k = j * nx + i;
    if (wet[k] || i + 1 >= nx || j + 1 >= nz) continue;
    if (Math.abs(h[k + 1]! - h[k]!) / step <= 0.6 && Math.abs(h[k + nx]! - h[k]!) / step <= 0.6) ok[k] = 1; }
  const stamp = (c: V2, r: number) => { const i0 = Math.max(0, Math.floor((c[0] - r - x0) / step)), i1 = Math.min(nx - 1, Math.ceil((c[0] + r - x0) / step)), j0 = Math.max(0, Math.floor((c[1] - r - z0) / step)), j1 = Math.min(nz - 1, Math.ceil((c[1] + r - z0) / step));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (Math.hypot(x0 + i * step - c[0], z0 + j * step - c[1]) <= r) blocked[j * nx + i] = 1; };
  for (const d of blockers.discs) stamp(d.at, d.r);
  for (const [a, b, r] of blockers.segs) { const n = Math.max(1, Math.ceil(dist(a, b) / step)); for (let t = 0; t <= n; t++) stamp([a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n], r); }
  let label = 0; const q: number[] = [];
  for (let s = 0; s < N; s++) { if (!ok[s] || comp[s]! >= 0) continue; comp[s] = label; q.push(s);
    while (q.length) { const k = q.pop()!, i = k % nx; for (const n of [i > 0 ? k - 1 : -1, i + 1 < nx ? k + 1 : -1, k - nx, k + nx]) if (n >= 0 && n < N && ok[n] && comp[n]! < 0) { comp[n] = label; q.push(n); } }
    label++; }
  return { x0, z0, step, nx, nz, h, wet, ok, blocked, comp };
}
const cellOf = (m: SlopeMap, q: V2) => { const i = Math.round((q[0] - m.x0) / m.step), j = Math.round((q[1] - m.z0) / m.step); return i < 0 || j < 0 || i >= m.nx || j >= m.nz ? -1 : j * m.nx + i; };
/** A pad disc on the map: null when any cell is wet, blocked or off the map; else its relief, median height and the
 *  share of usable (ok) cells. */
export function discOnMap(m: SlopeMap, c: V2, r: number): { relief: number; median: number; okShare: number } | null {
  const hs: number[] = []; let okN = 0;
  for (let dz = -r; dz <= r + 1e-6; dz += m.step) for (let dx = -r; dx <= r + 1e-6; dx += m.step) {
    if (dx * dx + dz * dz > r * r) continue;
    const k = cellOf(m, [c[0] + dx, c[1] + dz]); if (k < 0 || m.wet[k] || m.blocked[k]) return null;
    hs.push(m.h[k]!); okN += m.ok[k]!; }
  if (!hs.length) return null;
  hs.sort((a, b) => a - b);
  return { relief: hs[hs.length - 1]! - hs[0]!, median: hs[hs.length >> 1]!, okShare: okN / hs.length };
}
/** Usable area (m2) of a pocket layout as the size gate measures it: ok cells inside the hull of the pocket rims, in the
 *  components the pockets stand on. */
export function layoutArea(m: SlopeMap, pockets: { at: V2; radius: number }[]): number {
  const rim = pockets.flatMap((k) => Array.from({ length: 12 }, (_, i) => [k.at[0] + k.radius * Math.cos((i * Math.PI) / 6), k.at[1] + k.radius * Math.sin((i * Math.PI) / 6)] as V2));
  const poly = hull(rim), comps = new Set(pockets.map((k) => m.comp[cellOf(m, k.at)] ?? -1).filter((c) => c >= 0));
  const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
  let n = 0;
  for (let j = Math.max(0, Math.floor((Math.min(...zs) - m.z0) / m.step)); j <= Math.min(m.nz - 1, Math.ceil((Math.max(...zs) - m.z0) / m.step)); j++)
    for (let i = Math.max(0, Math.floor((Math.min(...xs) - m.x0) / m.step)); i <= Math.min(m.nx - 1, Math.ceil((Math.max(...xs) - m.x0) / m.step)); i++) {
      const k = j * m.nx + i; if (m.ok[k] && comps.has(m.comp[k]!) && inPoly([m.x0 + i * m.step, m.z0 + j * m.step], poly)) n++; }
  return n * m.step * m.step;
}
export interface SiteChoice { at: V2; pockets: Record<string, V2>; areaM2: number; relief: number; moved: number; searched: number; why: string; read?: { line: number; short: number } }
/** What a layout shows from afar, as heights above the core's ground: the landmark (structure or wall) at its pocket and
 *  every smoke column (SMOKE_READ_M) at its pocket, tallest first. */
export function readTargets(a: PlaceArchetype, chosen: { id: string; at: V2 }[]): { at: V2; height: number }[] {
  const out: { at: V2; height: number }[] = [];
  for (const p of a.pockets) { const q = chosen.find((k) => k.id === p.id)?.at; if (!q) continue;
    for (const st of p.structures) { if (st.landmark) out.push({ at: q, height: st.landmark.height }); if (SMOKE_READ_M[st.prefab]) out.push({ at: q, height: SMOKE_READ_M[st.prefab]! }); }
    for (const w of p.walls) if (w.landmark) out.push({ at: q, height: w.landmark.height }); }
  return out.sort((x, y) => y.height - x.height);
}
/** SITE SEARCH: the core and every satellite pocket of `a` on level, dry, connected ground. Core candidates on a 6 m
 *  grid within `roam` x the reservation radius of its centre (or within 14 m of a pinned `--at`); per core, each
 *  satellite tries 0.6-1.25 x spread at its nominal bearing +-60 deg, on the core's own connected ground, no more than
 *  `grade` x distance above or below the core (a footpath climbs it under the grade cap). Score: usable area toward
 *  the tier's need first, then the pads' relief, then distance from the brief's site. Null when no core fits. */
export function siteSearch(a: PlaceArchetype, inp: PlaceInput, g: PlaceGround, o: { needM2: number; roam?: number; pinned?: V2 | null; blockers?: SiteBlockers; grade?: number; map?: SlopeMap; compact?: boolean; read?: { band: V2 } }): SiteChoice | null {
  a = expandRows(a, inp.place);
  const { place, reservation } = inp, spread = a.spread[place.size], roam = o.roam ?? 1.5, grade = o.grade ?? Math.min(0.3, a.route.maxGrade);
  const pin = o.pinned ?? null, centre: V2 = pin ?? reservation.center, Rs = pin ? 14 : roam * reservation.radius;
  const m = o.map ?? slopeMap(g, centre, Rs + 1.25 * spread + 30, o.blockers);
  const core = a.pockets[0]!, sats = a.pockets.slice(1);
  const shoreLevel = core.near === "water" ? waterLevelNear(g, place.at) : null; // the brief site's own water
  const cands: { c: V2; s: NonNullable<ReturnType<typeof discOnMap>>; pre: number }[] = [];
  for (let dz = -Rs; dz <= Rs + 1e-6; dz += 6) for (let dx = -Rs; dx <= Rs + 1e-6; dx += 6) {
    if (dx * dx + dz * dz > Rs * Rs) continue;
    const c: V2 = [r2(centre[0] + dx), r2(centre[1] + dz)], s = discOnMap(m, c, core.radius);
    if (!s || s.relief > core.maxRelief || s.okShare < 0.8) continue;
    // L (site, weepmouth 2026-10-20): a shore core (`near: water`) stays on the shore: water within SHORE_M and the core no
    // more than SHORE_RISE_M above the last dry ground before it (the search had lifted a beach landing 130 m onto the cliff top)
    if (core.near === "water" && shoreRise(g, c, shoreLevel) > SHORE_RISE_M) continue;
    cands.push({ c, s, pre: s.relief + dist(c, place.at) / 40 });
  }
  cands.sort((x, y) => x.pre - y.pre);
  let best: (SiteChoice & { score: number }) | null = null;
  for (const { c, s } of cands.slice(0, 80)) {
    const front = placeFacing(c, place.faces, reservation.approaches), comp = m.comp[cellOf(m, c)] ?? -1;
    if (comp < 0) continue;
    const chosen: { id: string; at: V2; radius: number; relief: number }[] = [{ id: core.id, at: c, radius: core.radius, relief: s.relief }];
    let okAll = true;
    for (const p of sats) {
      // spreadMax (TOOLS-PB 2026-10-23): a capped archetype's satellites stay within spreadReach of the core, kept apart by their pads (fit)
      const reach = spreadReach(a, core, p), capped = reach < Infinity, fitOf = (id: string) => { const k = a.pockets.find((x) => x.id === id); return k ? k.fit ?? k.radius : 0; };
      const nom = toWorld(c, front, [p.at[0] * spread, p.at[1] * spread]), nd = Math.min(reach, dist(nom, c) || spread), b0 = Math.atan2(nom[1] - c[1], nom[0] - c[0]);
      let pb: { at: V2; relief: number; score: number } | null = null;
      for (const f of o.compact ? [0.5, 0.4, 0.3] : [1, 0.8, 1.15, 0.6, 1.25]) for (const off of o.compact ? [0, 30, -30, 60, -60, 90, -90] : [0, 20, -20, 40, -40, 60, -60]) {
        const d = Math.min(reach, Math.max(nd * f, capped ? fitOf(core.id) + fitOf(p.id) + 6 : core.radius + p.radius + 10)), b = b0 + (off * Math.PI) / 180, q: V2 = [c[0] + d * Math.cos(b), c[1] + d * Math.sin(b)];
        if (chosen.some((k) => dist(k.at, q) < (capped ? fitOf(k.id) + fitOf(p.id) : k.radius + p.radius) + 6)) continue;
        const ps = discOnMap(m, q, p.radius); if (!ps || ps.relief > p.maxRelief || ps.okShare < 0.7) continue;
        if (m.comp[cellOf(m, q)] !== comp || Math.abs(ps.median - s.median) > grade * d) continue;
        let sc = ps.relief + Math.abs(off) / 30 + 2 * Math.abs(f - 1);
        if (p.near === "water") sc += 0.08 * nearestWet(g, q);
        if (p.near === "edge") sc -= Math.min(6, edgeDrop(g, q, p.radius)) * 0.5;
        if (!pb || sc < pb.score) pb = { at: [r2(q[0]), r2(q[1])], relief: ps.relief, score: sc };
      }
      if (!pb) { okAll = false; break; }
      chosen.push({ id: p.id, at: pb.at, radius: p.radius, relief: pb.relief });
    }
    if (!okAll) continue;
    const areaM2 = layoutArea(m, chosen), relief = chosen.reduce((t, k) => t + k.relief, 0);
    let score = (Math.min(areaM2, o.needM2) / o.needM2) * 100 - 1.5 * relief - dist(c, place.at) / 25;
    // L (read, Hagsheer batch 2026-10-20: 7 medium places hid a 3.5-5 m landmark behind a crest): the landmark or a
    // smoke column must read from the approach the footpath joins (the `place` check's line); a layout whose targets
    // stay hidden in the tier's read window pays 30 + its shortfall in metres (capped 30)
    let read: SiteChoice["read"];
    if (o.read && reservation.approaches.length) {
      const line = nearestOnApproach(c, reservation.approaches)?.line ?? 0;
      read = { line, short: Infinity };
      const show = heightForPx(o.read.band[1]); // L (read px): READ_PX_MIN px must show over the ground, not only the top
      for (const t of readTargets(a, chosen)) { read.short = Math.min(read.short, r2(readHeightNeeded(g, t.at, s.median, reservation.approaches, o.read.band, line, 2) + show - t.height)); if (read.short <= 0) break; }
      if (read.short > 0) score -= 30 + Math.min(30, read.short);
    }
    if (!best || score > best.score) best = { at: c, pockets: Object.fromEntries(chosen.map((k) => [k.id, k.at])), areaM2, relief: r2(relief), moved: Math.round(dist(c, place.at)), searched: cands.length, why: "", score, ...(read ? { read } : {}) };
  }
  // L (walk, hags-nose 2026-10-20): no layout at 0.6-1.25 x spread (a headland, a knoll) used to fall back to the
  // archetype's own offsets: satellites 40-50 m down a cliff, routes with "no walkable way" and a walk of FALLs. The
  // search first tries a COMPACT layout (satellites 0.3-0.5 x spread, +-90 deg) on the core's connected ground
  if (!best) return o.compact ? null : siteSearch(a, inp, g, { ...o, map: m, compact: true });
  const { score: _s, ...out } = best;
  out.why = `${o.compact ? "COMPACT (satellites 0.3-0.5 x spread: none fit at 0.6-1.25) " : ""}flattest connected layout in ${pin ? `14 m of --at ${pin.map(Math.round)}` : `${roam} x the reserved disc (r ${Math.round(Rs)} m)`}: ${cands.length} level core spots, pads relief ${out.relief} m, ~${out.areaM2} m2 usable (need ${o.needM2}), core ${out.moved} m from the brief site${out.read ? `; read from approach ${out.read.line}: ${out.read.short <= 0 ? "the landmark reads" : `${out.read.short} m short (no layout reads)`}` : ""}`;
  return out;
}

/** L (dress check): item ids unique in a plan (a later id that repeats gets -b, -c ...). */
export function uniqueItemIds<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.map((it) => { let id = it.id, n = 1; while (seen.has(id)) id = `${it.id}-${String.fromCharCode(97 + n++)}`; seen.add(id); return id === it.id ? it : { ...it, id }; });
}

/** L (install, Hagsheer 2026-10-20): the world's ground moved 0.24-0.94 m under five reviewed places (a core road-band
 *  change + re-applied ops) and the install guard demanded a full 8-min `all` rerun for 0.24 m. Under `RESEAT_MAX_M` the
 *  place installs and its pieces are re-seated on the live solid (float's seat rule) with the float gate run on the live
 *  scene; above it the place is re-planned. 0.05 m and under is the same ground. */
export const RESEAT_MAX_M = 0.5;
/** Half-width a footpath operator grades either side of its centre line (its ribbon samples carry 3.5 m). */
export const PATH_GRADE_BAND_M = 3.5;
export function installGuard(maxDiffM: number): "same" | "reseat" | "refuse" {
  return maxDiffM <= 0.05 ? "same" : maxDiffM <= RESEAT_MAX_M ? "reseat" : "refuse";
}

/** L (walk, hags-garth 2026-10-20): the planned route is a taut polyline, the built footpath a spline RIBBON smoothed
 *  through it; at a bend the polyline ran 2.2 m off a 2.4 m ribbon into its retaining wall's face cut (2 STUCK). A walk
 *  route follows the ribbon AS BUILT: every run of 2+ route points within `hw` + 4 m of the ribbon is replaced by the
 *  ribbon's own samples between them (about every `step` m); points off it (pocket ends) are kept. Points [x, y, z];
 *  samples [x, y, z, ...]. */
export function routeOnRibbon(points: number[][], samples: number[][], hw: number, step = 3): number[][] {
  if (samples.length < 2) return points;
  const near = (q: number[]) => { let bi = 0, bd = Infinity; samples.forEach((s, i) => { const d = Math.hypot(s[0]! - q[0]!, s[2]! - q[2]!); if (d < bd) { bd = d; bi = i; } }); return { i: bi, d: bd }; };
  // L (walk, burnt-steading 2026-10-21): a point past the ribbon's END is not on it (it was within hw + 4 of the end sample, so
  // the planned way round a pen wall to its gate collapsed onto the end and the route cut straight through the wall)
  const hit = points.map(near), on = hit.map((h) => h.d <= ((h.i === 0 || h.i === samples.length - 1) ? hw + 0.5 : hw + 4)), out: number[][] = [];
  for (let k = 0; k < points.length; ) {
    if (!on[k]) { out.push(points[k]!); k++; continue; }
    let e = k; while (e + 1 < points.length && on[e + 1]) e++;
    if (e === k) { out.push(points[k]!); k++; continue; }
    // L (walk, net-green 2026-10-21: FALL 2.48 m off a fill shoulder): the ribbon runs on PAST the last point on it toward
    // the next one (a pocket stand beyond the paved end, the core before its start); the taut chord to that point left the
    // ribbon's bow 2.4 m to one side and the walk stepped off the fill. Follow the samples while they near that point.
    const toward = (i: number, q: number[] | undefined, d: number) => { if (!q) return i; const dq = (j: number) => Math.hypot(samples[j]![0]! - q[0]!, samples[j]![2]! - q[2]!);
      while (i + d >= 0 && i + d < samples.length && dq(i + d) < dq(i)) i += d; return i; };
    let a = hit[k]!.i, b = hit[e]!.i; const dir = b >= a ? 1 : -1; let last: number[] | null = null;
    a = toward(a, points[k - 1], -dir); b = toward(b, points[e + 1], dir);
    for (let i = a; dir > 0 ? i <= b : i >= b; i += dir) { const s = samples[i]!; if (!last || Math.hypot(s[0]! - last[0]!, s[2]! - last[2]!) >= step || i === b) { last = [s[0]!, s[1]!, s[2]!]; out.push(last); } }
    k = e + 1;
  }
  return out;
}

/** L (Red Dial 2026-10-30: footpath grades cut under avenue pillars AFTER the plan seated them; the built re-seat fixed the
 *  centre and the seated gate still read 0.2-3.6 m of daylight at their edges): the y a piece's foot should take on the
 *  ground AS BUILT — the lowest ground sampled over its whole turned footprint (dressing size x scale), but never more than
 *  its declared `footing` below the highest ground there (deeper is buried: the float gate). Only ever lowers: null when
 *  the piece already stands no higher than that. Pure. */
export function sinkToBase(at: { x: number; y: number; z: number; yaw: number }, half: [number, number], footing: number, height: (x: number, z: number) => number, step = 1): number | null {
  const c = Math.cos(at.yaw), s = Math.sin(at.yaw), nx = Math.max(1, Math.ceil((2 * half[0]) / step)), nz = Math.max(1, Math.ceil((2 * half[1]) / step));
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) {
    const lx = -half[0] + (2 * half[0] * i) / nx, lz = -half[1] + (2 * half[1] * j) / nz, h = height(at.x + lx * c + lz * s, at.z - lx * s + lz * c);
    lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  const want = Math.max(lo - 0.03, hi - Math.max(0, footing));
  // L (Red Dial 2026-10-30: a fire post the footpath grade FILLED over stood 0.7 m in the ground, float: buried): a piece
  // buried past the cap below its highest ground comes up to the cap; one within it is only ever lowered
  const raiseTo = hi - Math.max(0, footing);
  if (raiseTo > at.y + 0.01) return Math.round(raiseTo * 1000) / 1000;
  return want < at.y - 0.01 ? Math.round(want * 1000) / 1000 : null;
}

/** A piece's seat pad before merging (place-build's SEAT PADS pass). */
export interface SeatPadRaw { id: string; at: V2; radius: number; y: number; gap: number }
/** L (dropped-hour 2026-10-30: a spit over its pyre each got a pad at its own height: the pyre floated 0.13 m, the spit
 *  0.15 m): seat pads of pieces SHARING a spot (centres within half the smaller pad's radius: one over the other) merge into ONE pad covering them all at the LOWEST base of the group (ids joined
 *  with "--", the largest gap kept). Neighbours whose pads only touch keep their own (a merged pad at the lower pillar's
 *  seat cut 0.8 m from under the next pillar up the avenue, Red Dial). Pure. */
export function mergeSeatPads(pads: SeatPadRaw[]): SeatPadRaw[] {
  const groups: SeatPadRaw[][] = [];
  for (const p of pads) {
    const hit = groups.filter((g) => g.some((q) => Math.hypot(q.at[0] - p.at[0], q.at[1] - p.at[1]) < 0.5 * Math.min(q.radius, p.radius)));
    const merged = [p, ...hit.flat()]; for (const h of hit) groups.splice(groups.indexOf(h), 1); groups.push(merged);
  }
  return groups.map((g) => {
    if (g.length === 1) return g[0]!;
    const c: V2 = [g.reduce((s, q) => s + q.at[0], 0) / g.length, g.reduce((s, q) => s + q.at[1], 0) / g.length];
    return { id: g.map((q) => q.id).sort().join("--"), at: [r2(c[0]), r2(c[1])], radius: r2(Math.max(...g.map((q) => Math.hypot(q.at[0] - c[0], q.at[1] - c[1]) + q.radius))), y: Math.min(...g.map((q) => q.y)), gap: Math.max(...g.map((q) => q.gap)) };
  });
}
/** The most ground a seat pad may lift under a piece (more is a re-plan, not a pad). */
export const SEAT_PAD_MAX_M = 1.5;
/** L (Red Dial 2026-10-30: pillars on 0.8-1.5 m of fall kept daylight under their low edge after the sink cap): the
 *  seat pad a piece's base needs on the ground AS BUILT (after the footpath grades): a level disc at its foot over its
 *  turned footprint, or null when nothing shows (gap <= 0.05 m) or the fall is past SEAT_PAD_MAX_M. Pure. */
export function seatPad(at: { x: number; y: number; z: number; yaw: number }, half: [number, number], height: (x: number, z: number) => number, step = 0.5): { radius: number; y: number; gap: number } | null {
  const c = Math.cos(at.yaw), s = Math.sin(at.yaw), nx = Math.max(1, Math.ceil((2 * half[0]) / step)), nz = Math.max(1, Math.ceil((2 * half[1]) / step));
  let lo = Infinity;
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) {
    const lx = -half[0] + (2 * half[0] * i) / nx, lz = -half[1] + (2 * half[1] * j) / nz;
    lo = Math.min(lo, height(at.x + lx * c + lz * s, at.z - lx * s + lz * c));
  }
  const gap = Math.round((at.y - lo) * 1000) / 1000;
  if (gap <= 0.05 || gap > SEAT_PAD_MAX_M) return null;
  return { radius: Math.round((Math.hypot(half[0], half[1]) + 1.2) * 100) / 100, y: at.y, gap }; // 1.2 m of plateau past the base: the filtered 2 m lattice sagged a 0.3 m margin 0.28 m (red-pillar)
}

/**
 * POI SIZE TIERS — the one definition (owner ruling 2026-10-03: "all of these look so small in size for POI none of
 * these should be considered large... think how big WOW's oasis in the barrens is"). "Small" is roughly what was built
 * as medium/large before; a LARGE place is a 300-600 m district of the map, minutes to cross, with three or more linked
 * features (water, a cave or interior, a camp, a landmark), its own terrain shaping and several creature groups.
 *
 * Used by: creator/brief.mjs (targets written into brief + owner prompt), zonegen poi-brief (via the brief),
 * zonegen reserve (refuses a reservation smaller than its tier), job.mjs installBlock (refuses an install whose
 * MEASURED size is below its tier: `job.mjs measure <jobDir>`). Change a number here and every gate follows.
 *
 * PARENTED JOBS (dungeon doors): a job that is only one part of a larger place — the entrance of a dungeon whose place
 * is another job (the First King's Door of the First King's Barrow) — names that place in brief.json / handoff.json
 * `parent: "<parent job id>"`. It is sized as a `pinpoint` CHILD (PARENTED_TIER): its own tier must be pinpoint, and
 * the size gate judges the PARENT'S tier over the parent's aggregate (the parent job plus every job naming it as
 * parent: footprint points united, usable area and creature groups summed, features joined, approaches the most of
 * any). The parent's own size gate counts its children the same way, so a door never has to be a large place alone
 * and a large place is not short by the door it delegated. A parent that is not a job in the same world is a fault.
 *
 * CROSSING (HERO-BRIDGE 2026-10-22): a bridge, ferry or causeway is not an adventure place; it is judged by the
 * `crossing` tier (CROSSING_TIER), outside the four ordered sizes: its span over water or a chasm, both approach roads,
 * its seated structures, a read picture from >= 300 m on EACH approach (`read-*` views), and a landmark (tower, parapet
 * head) standing >= 6 m over the deck at one end. No usable-area / linked-feature / creature-group minimums: the gorge's
 * packs and the crossing's quest hang on the zone. A job whose kind is `bridge` (bridge.json) is a crossing
 * automatically; any other plan may name `crossing` as its size.
 */
import { createRequire } from "node:module";
const { z } = createRequire(new URL("../../packages/core/package.json", import.meta.url))("zod");

export const SIZE_NAMES = ["pinpoint", "small", "medium", "large"];
/** Every tier name a job may carry: the four ordered sizes + the crossing tier. */
export const TIER_NAMES = [...SIZE_NAMES, "crossing"];
export const FEATURE_KINDS = ["landmark", "water", "cave", "interior", "camp", "ruin", "structure", "grove", "shore", "lookout", "lair", "other"];

const range = z.object({
  min: z.number().positive().describe("Metres: the smallest footprint diameter this tier may have."),
  max: z.number().positive().describe("Metres: above this the place is the next tier up (a warning, not a refusal)."),
}).strict();

export const sizeTierSchema = z.object({
  id: z.enum(SIZE_NAMES),
  read: z.string().min(1).describe("What a place of this tier is, in the owner's words."),
  footprintDiameterM: range.describe("Measured across the place's whole edit footprint (every delivered terrain edit, clearing, path, landmark and root entity), not the landmark alone. A reservation's diameter is 2 x radius."),
  minUsableAreaM2: z.number().nonnegative().describe("Connected, reachable, walkable ground (18 deg default slope limit) after walls, steep banks, the incoming spur and solid dressing are excluded; summed over outdoor and interior levels. MEASURED, never an estimate."),
  minLinkedFeatures: z.number().int().nonnegative().describe("Distinct sub-sites joined by walked routes (a lake, a cave system, a camp, a ruin, the landmark)."),
  requiredFeatureKinds: z.array(z.enum(FEATURE_KINDS)).describe("Kinds every place of this tier must include."),
  oneOfFeatureKinds: z.array(z.enum(FEATURE_KINDS)).describe("At least one feature of one of these kinds (water or a cave/interior for a large place). Empty = no constraint."),
  minCreatureGroups: z.number().int().nonnegative().describe("Distinct creature groups (packs / camps handed to populate as clearings), not individual bodies."),
  minApproaches: z.number().int().positive().describe("Distinct ways in (roads, paths, trails, shore landings) that reach the place."),
  terrainShaping: z.boolean().describe("The place must carry its own terrain shaping (operators, height patches, carves, clearings) in its delivered world ops."),
}).strict();

export const sizeTiersSchema = z.object({
  version: z.literal(1),
  ruling: z.string().min(1),
  tiers: z.array(sizeTierSchema).length(SIZE_NAMES.length),
}).strict().describe("POI size tiers (docs/world-standards/sites.md). One table, read by brief, reserve and install.");

export const POI_SIZE_TIERS = sizeTiersSchema.parse({
  version: 1,
  ruling: "2026-10-03 owner review of zone-5 (memory poi-scale-and-town-walls): small = what was built as medium/large before; large = 300-600 m with 3+ linked features, its own terrain shaping and several creature groups (WoW's Barrens oasis).",
  tiers: [
    { id: "pinpoint", read: "One spot: a shrine, a cairn, a lookout, a wreck, a dungeon door in a rock face.", footprintDiameterM: { min: 15, max: 60 }, minUsableAreaM2: 100, minLinkedFeatures: 1, requiredFeatureKinds: [], oneOfFeatureKinds: [], minCreatureGroups: 0, minApproaches: 1, terrainShaping: false },
    { id: "small", read: "A local adventure: a camp with its yard and a lookout, a ruin with a cellar; what was built as medium/large before.", footprintDiameterM: { min: 100, max: 150 }, minUsableAreaM2: 3500, minLinkedFeatures: 2, requiredFeatureKinds: [], oneOfFeatureKinds: [], minCreatureGroups: 1, minApproaches: 1, terrainShaping: false },
    { id: "medium", read: "Several pockets round a landmark, a short walk across; more exploration and encounters between distinct sub-sites.", footprintDiameterM: { min: 150, max: 300 }, minUsableAreaM2: 9000, minLinkedFeatures: 3, requiredFeatureKinds: ["landmark"], oneOfFeatureKinds: [], minCreatureGroups: 2, minApproaches: 2, terrainShaping: true },
    { id: "large", read: "A district of the map, minutes to cross (the Barrens oasis): a landmark with water or a cave system, camps, its own terrain shaping and several creature groups.", footprintDiameterM: { min: 300, max: 600 }, minUsableAreaM2: 30000, minLinkedFeatures: 3, requiredFeatureKinds: ["landmark"], oneOfFeatureKinds: ["water", "cave", "interior"], minCreatureGroups: 3, minApproaches: 3, terrainShaping: true },
  ],
});

export const crossingTierSchema = z.object({
  id: z.literal("crossing"),
  read: z.string().min(1),
  minSpanM: z.number().positive().describe("Metres of deck (bridge) / crossing line between the two banks; the footprint is this span plus its two approach roads."),
  minClearanceM: z.number().positive().describe("The deck over the lowest ground under the span: it must cross water or a chasm, not lie on the ground."),
  minReadM: z.number().positive().describe("Each approach needs a read-* view at least this far from the deck, with its evidence picture."),
  minEndHeightM: z.number().positive().describe("A landmark (gate tower, parapet head) standing this far over the deck at one end at least."),
  minApproaches: z.number().int().positive().describe("Approach roads (one per bank)."),
  minUsableAreaM2: z.literal(0), minLinkedFeatures: z.literal(0), minCreatureGroups: z.literal(0),
  footprintDiameterM: range, requiredFeatureKinds: z.array(z.enum(FEATURE_KINDS)).length(0), oneOfFeatureKinds: z.array(z.enum(FEATURE_KINDS)).length(0), terrainShaping: z.literal(false),
}).strict().describe("The crossing tier (bridges, later ferries / causeways): judged by span, approaches, seating and its reads, not by area.");
export const CROSSING_TIER = crossingTierSchema.parse({
  id: "crossing",
  read: "A landmark crossing: one built span over water or a chasm joining two roads, read from both approaches (The Lych Span).",
  minSpanM: 60, minClearanceM: 4, minReadM: 300, minEndHeightM: 6, minApproaches: 2,
  minUsableAreaM2: 0, minLinkedFeatures: 0, minCreatureGroups: 0,
  footprintDiameterM: { min: 60, max: 900 }, requiredFeatureKinds: [], oneOfFeatureKinds: [], terrainShaping: false,
});

export function tierFor(size) {
  if (size === "crossing") return CROSSING_TIER;
  const t = POI_SIZE_TIERS.tiers.find((x) => x.id === size);
  if (!t) throw new Error(`unknown POI size "${size}" (${TIER_NAMES.join(", ")})`);
  return t;
}

/** All tiers in one line (for schema descriptions): "pinpoint 15-60 m, ... large 300-600 m". */
export function tierSummary() {
  return POI_SIZE_TIERS.tiers.map((t) => `${t.id} ${t.footprintDiameterM.min}-${t.footprintDiameterM.max} m across, ${t.minUsableAreaM2} m2 usable, ${t.minLinkedFeatures}+ features, ${t.minCreatureGroups}+ groups, ${t.minApproaches}+ approaches`).join("; ");
}

/** The tier's targets as one line for a brief / owner prompt. */
export function tierTargetsText(size) {
  const t = tierFor(size);
  if (t.id === "crossing") return `crossing (${t.read}) — span >= ${t.minSpanM} m with >= ${t.minClearanceM} m under the deck; ${t.minApproaches} approach roads; every structure seated; a read-* view >= ${t.minReadM} m out on EACH approach with its picture; a landmark >= ${t.minEndHeightM} m over the deck at one end; no area / feature / creature minimums (install REFUSES below them)`;
  const kinds = [t.requiredFeatureKinds.length ? `including ${t.requiredFeatureKinds.join(" + ")}` : "", t.oneOfFeatureKinds.length ? `and one of ${t.oneOfFeatureKinds.join("/")}` : ""].filter(Boolean).join(" ");
  return `${t.id} POI (${t.read}) — footprint ${t.footprintDiameterM.min}-${t.footprintDiameterM.max} m across; at least ${t.minUsableAreaM2.toLocaleString("en")} m2 of MEASURED connected usable ground; ${t.minLinkedFeatures}+ linked features${kinds ? ` ${kinds}` : ""}; ${t.minCreatureGroups}+ creature groups; ${t.minApproaches}+ distinct approaches${t.terrainShaping ? "; its own terrain shaping" : ""}.`;
}

/** Why a planned reservation is too small for its tier (null = fits). `approaches` counts approach + approaches[]. */
export function reservationTierFault(size, { radius, approaches = 1 }) {
  const t = tierFor(size);
  const out = [];
  if (2 * radius < t.footprintDiameterM.min) out.push(`a ${size} place needs ${t.footprintDiameterM.min}-${t.footprintDiameterM.max} m across; the reservation is ${2 * radius} m (radius ${radius}, needs >= ${t.footprintDiameterM.min / 2})`);
  if (approaches < t.minApproaches) out.push(`a ${size} place needs ${t.minApproaches}+ distinct approaches; the reservation names ${approaches}`);
  return out.length ? out.join("; ") : null;
}

/** Measured-size record a job carries (reports/size.json, written by job.mjs measure). */
export const sizeMeasurementSchema = z.object({
  tier: z.enum(TIER_NAMES),
  footprintDiameterM: z.number().nonnegative().describe("Tool-measured: the widest span over every delivered world-space point (clearings, patches, paths, landmarks, root entities) and declared dressing areas (handoff.siteDressing.areas)."),
  footprintHullAreaM2: z.number().nonnegative().describe("Tool-measured: convex hull area of the same points; usable area can never exceed it."),
  usableAreaM2: z.number().nonnegative().nullable().describe("handoff.measurements.measuredCombinedUsableAreaM2 — the owner's MEASURED connected usable area; null when only an estimate exists."),
  features: z.array(z.object({ id: z.string().min(1), kind: z.enum(FEATURE_KINDS), linkedTo: z.array(z.string()).default([]) }).strict()).describe("handoff.measurements.features[] { id, kind, linkedTo[] }: sub-sites and the features each is joined to by a walked route."),
  creatureGroups: z.number().int().nonnegative().describe("Distinct creature groups: spawn areas `zonegen populate` stood here (tag location:<id>), handoff.populateClearings[] and delivered clearings whose id names an encounter (-enc-, pack, lair, camp, den)."),
  approaches: z.number().int().nonnegative().describe("max(handoff.measurements.approaches[] length, the zone reservation's approach count)."),
  terrainEdits: z.number().int().nonnegative().describe("Delivered world terrain edits (patches, landmarks, operators, paths, carves, clearings)."),
  crossing: z.object({
    spanM: z.number().nonnegative().describe("reports/bridge.json report.span."),
    clearanceM: z.number().describe("Deck Y over the lowest ground under the span (pier groundMin)."),
    seated: z.boolean().nullable().describe("reports/seated.json ok (null: not run)."),
    reads: z.array(z.object({ name: z.string(), end: z.enum(["start", "end"]), distanceM: z.number().nonnegative(), picture: z.boolean() }).strict()).describe("read-* views: the deck end nearer the camera, the camera's distance to the deck, and whether evidence/**/<name>-12.png exists."),
    endHeightM: z.number().describe("Landmark top over the deck (report.towerTop - deckY; 0 without one)."),
    roads: z.number().int().nonnegative().describe("Approach roads delivered with the crossing."),
  }).strict().optional().describe("Crossing tier only: measured from the bridge job's own reports."),
}).strict();

/** Every way a measured place falls short of its tier. Empty = meets it. */
export function measurementFaults(m) {
  const t = tierFor(m.tier);
  if (t.id === "crossing") return crossingFaults(m, t);
  const out = [];
  if (m.footprintDiameterM < t.footprintDiameterM.min) out.push(`footprint ${Math.round(m.footprintDiameterM)} m across, a ${t.id} place needs >= ${t.footprintDiameterM.min} m`);
  if (m.usableAreaM2 === null) out.push(`no MEASURED usable area (handoff.measurements.measuredCombinedUsableAreaM2): an estimate does not count; a ${t.id} place needs >= ${t.minUsableAreaM2} m2`);
  else {
    if (m.usableAreaM2 < t.minUsableAreaM2) out.push(`usable area ${Math.round(m.usableAreaM2)} m2, a ${t.id} place needs >= ${t.minUsableAreaM2} m2`);
    if (m.usableAreaM2 > m.footprintHullAreaM2 * 1.5 + 1) out.push(`claims ${Math.round(m.usableAreaM2)} m2 usable inside a ${Math.round(m.footprintHullAreaM2)} m2 footprint hull (stacked floors aside, re-measure)`);
  }
  const ids = new Set(m.features.map((f) => f.id));
  const linked = m.features.filter((f) => f.linkedTo.some((x) => ids.has(x) && x !== f.id) || m.features.some((g) => g.id !== f.id && g.linkedTo.includes(f.id)));
  if (m.features.length === 0) out.push(`no features declared (handoff.measurements.features[] { id, kind, linkedTo[] }); a ${t.id} place needs ${t.minLinkedFeatures}+ linked`);
  else if ((t.minLinkedFeatures > 1 ? linked.length : m.features.length) < t.minLinkedFeatures) out.push(`${t.minLinkedFeatures > 1 ? linked.length : m.features.length} linked feature(s), a ${t.id} place needs ${t.minLinkedFeatures}+`);
  const kinds = new Set(m.features.map((f) => f.kind));
  for (const k of t.requiredFeatureKinds) if (!kinds.has(k)) out.push(`no ${k} feature (required for ${t.id})`);
  if (t.oneOfFeatureKinds.length && !t.oneOfFeatureKinds.some((k) => kinds.has(k))) out.push(`none of ${t.oneOfFeatureKinds.join("/")} among the features (required for ${t.id})`);
  if (m.creatureGroups < t.minCreatureGroups) out.push(`${m.creatureGroups} creature group(s), a ${t.id} place needs ${t.minCreatureGroups}+`);
  if (m.approaches < t.minApproaches) out.push(`${m.approaches} approach(es), a ${t.id} place needs ${t.minApproaches}+`);
  if (t.terrainShaping && m.terrainEdits === 0) out.push(`no terrain shaping delivered (required for ${t.id})`);
  return out;
}

/** Every way a measured crossing falls short of the crossing tier. */
function crossingFaults(m, t) {
  const c = m.crossing, out = [];
  if (!c) return ["no crossing measurement (a crossing is measured from its bridge job: reports/bridge.json, reports/seated.json, views.json read-* views)"];
  if (c.spanM < t.minSpanM) out.push(`span ${Math.round(c.spanM)} m, a crossing needs >= ${t.minSpanM} m`);
  if (c.clearanceM < t.minClearanceM) out.push(`the deck stands ${Math.round(c.clearanceM * 10) / 10} m over the ground under it: a crossing spans water or a chasm (>= ${t.minClearanceM} m)`);
  if (c.seated !== true) out.push(c.seated === null ? "seated gate not run (reports/seated.json)" : "a structure is not seated (reports/seated.json)");
  for (const end of ["start", "end"]) {
    const ok = c.reads.filter((r) => r.end === end && r.distanceM >= t.minReadM && r.picture);
    const have = c.reads.filter((r) => r.end === end).map((r) => `${r.name} ${Math.round(r.distanceM)} m${r.picture ? "" : " no picture"}`).join(", ") || "none";
    if (!ok.length) out.push(`no read from the ${end} approach: a read-* view >= ${t.minReadM} m from the deck with its evidence picture (have: ${have})`);
  }
  if (c.endHeightM < t.minEndHeightM) out.push(`no landmark >= ${t.minEndHeightM} m over the deck at either end (${Math.round(c.endHeightM * 10) / 10} m)`);
  const roads = Math.max(c.roads, m.approaches);
  if (roads < t.minApproaches) out.push(`${roads} approach road(s), a crossing needs ${t.minApproaches}`);
  return out;
}

/** The tier a parented job (a dungeon door of a larger place: brief/handoff `parent`) is sized as. */
export const PARENTED_TIER = "pinpoint";
/** Why a parented job's own tier is wrong (null = it is a pinpoint child). */
export function parentedTierFault(tier, parent) {
  return tier === PARENTED_TIER ? null : `a job with parent "${parent}" is an entrance of that place and is sized as a ${PARENTED_TIER} child (its tier is ${tier ?? "unset"}): set adventureSize ${PARENTED_TIER}, the parent's tier is judged over the parent and its children`;
}
/**
 * One measurement over a parent job and its children (each a sizeMeasurementSchema-shaped part, `tier` ignored), judged
 * at `tier`. `pointsDiameter` / `pointsHullArea` are the united footprint (measured by the caller over every part's points).
 * Usable area sums the parts that measured one (null only when none did); features are joined (ids stay unique per part
 * by prefixing a child's ids with its job id when they collide); creature groups and terrain edits sum; approaches = max.
 */
export function aggregateMeasurement(tier, parts, { diameter, hullArea }) {
  const seen = new Set(), features = [];
  for (const p of parts) for (const f of p.features ?? []) {
    const id = seen.has(f.id) ? `${p.job ?? "child"}/${f.id}` : f.id;
    seen.add(id);
    features.push({ ...f, id });
  }
  const usable = parts.map((p) => p.usableAreaM2).filter((v) => typeof v === "number");
  return {
    tier,
    footprintDiameterM: diameter,
    footprintHullAreaM2: hullArea,
    usableAreaM2: usable.length ? usable.reduce((a, v) => a + v, 0) : null,
    features,
    creatureGroups: parts.reduce((a, p) => a + (p.creatureGroups ?? 0), 0),
    approaches: Math.max(0, ...parts.map((p) => p.approaches ?? 0)),
    terrainEdits: parts.reduce((a, p) => a + (p.terrainEdits ?? 0), 0),
  };
}

/**
 * The street-lighting standard as DATA and as a CHECK (docs/world-standards/towns.md, "Lights"): every town street
 * and every road near a town carries lanterns. Pure module (no CLI): the schema and loader, the deterministic planner
 * (`planTownLights`) and the gate (`checkTownLights`). `tools/town-lights.mts` drives them; `zonegen status` reads the
 * report the check writes (row `town <name>: lights`).
 *
 * Everything a lantern position comes from is recipe/town data: the town's street polylines (`<town>-street-*` roads,
 * lanes `-lane-`, plazas `-square-`), its gates, its door paths (`<town>-door-*`), stairs/ramps, the layout's building
 * footprints, dock structures in the town plan (`structures[].built`), the world roads leaving a gate (or crossing the
 * radius of a gateless town), their junctions and bridge abutments. Same inputs, same lanterns. The ground under a
 * lantern is the world field's `height()` (the same sampler the town tools use); on a built deck it is the deck height
 * the dock builder recorded.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

type XZ = [number, number];

const prefabId = z.string().min(1).regex(/^[a-z0-9-]+\/[a-z0-9-]+$/, "a catalogued prefab id, folder included");
export const streetLightingSchema = z
  .object({
    about: z.string().default(""),
    streets: z
      .object({
        prefab: prefabId.default("town-lights/lamp-post-lit").describe("Lantern on streets (a catalogued lit prop; never a new model)."),
        lanePrefab: prefabId.default("town-lights/hanging-lantern-lit").describe("Slimmer lantern for lanes (narrow streets, `-lane-` in the road id)."),
        spacing: z.number().positive().default(18).describe("Metres between lanterns along one street; sides alternate, so one side sees one every 2x this."),
        cover: z.number().positive().default(13).describe("GATE: every metre of every street and lane has a lantern within this distance."),
        edgeOffset: z.number().default(0.5).describe("Preferred distance of a lantern beyond the street's paved edge (negative = on the edge band)."),
      })
      .prefault({}),
    plazas: z
      .object({
        prefab: prefabId.default("town-lights/lamp-post-lit"),
        cover: z.number().positive().default(3).describe("GATE: a lantern within the plaza (half its width + this) of its centre."),
      })
      .prefault({}),
    gates: z
      .object({
        prefab: prefabId.default("town-lights/lamp-post-lit"),
        pair: z.boolean().default(true).describe("Flank each gate mouth with two lanterns (false: one)."),
        cover: z.number().positive().default(7).describe("GATE: a lantern within this distance of every gate mouth."),
      })
      .prefault({}),
    quays: z
      .object({
        prefab: prefabId.default("town-lights/lamp-post-lit").describe("Lantern on the quay deck and at its head (arms along the quay)."),
        jettyPrefab: prefabId.default("town-lights/hanging-lantern-lit").describe("Slim lantern at a jetty end (a narrow timber deck)."),
        cover: z.number().positive().default(6).describe("GATE: a lantern within this distance of each quay head and jetty end."),
      })
      .prefault({}),
    roads: z
      .object({
        prefab: prefabId.default("town-lights/lamp-post-lit"),
        reach: z.number().positive().default(160).describe("Metres of every road lit from the town's gate (or radius) outwards."),
        start: z.number().min(0).default(16).describe("First road lantern this far from the mouth (the gate pair lights the mouth itself)."),
        spacing: z.number().positive().default(30).describe("Metres between road lanterns, sides alternating."),
        cover: z.number().positive().default(24).describe("GATE: every dry metre of road within `reach` has a lantern within this distance."),
        shoulderOffset: z.number().positive().default(1.1).describe("Lanterns stand on the shoulder this far beyond the carriageway edge, never on it."),
        junctionReach: z.number().positive().default(200).describe("Road junctions and bridge ends within this distance of a mouth get a lantern."),
        exclude: z.array(z.string()).default(["^trail-"]).describe("Road ids (regex) that are not roads for lighting: mountain trails."),
      })
      .prefault({}),
    clearance: z
      .object({
        building: z.number().min(0).default(0.6).describe("Minimum distance from a building footprint (layout `full`)."),
        door: z.number().min(0).default(1.0).describe("Minimum distance beyond a door path's half width, and from the door point."),
        stair: z.number().min(0).default(1.5).describe("Minimum distance beyond a stair/ramp road's half width (stair buffers)."),
        npc: z.number().min(0).default(1.5).describe("Minimum distance from a placed resident."),
        landmark: z.number().min(0).default(4).describe("Minimum distance from a landmark/structure/quest-object root."),
        minApart: z.number().min(0).default(8).describe("Two lanterns never closer than this."),
        maxTilt: z.number().positive().default(0.35).describe("Largest ground drop (m) across a lantern's base; steeper spots are refused."),
        groundTolerance: z.number().positive().default(0.3).describe("GATE: an installed lantern on land stands within this of the ground (no floating, no burial)."),
      })
      .prefault({}),
  })
  .describe("Street-lighting standard (tools/street-lights.json; project override authoring/street-lights.json).");
export type StreetLighting = z.infer<typeof streetLightingSchema>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The project's override if it has one, else the engine default beside this file. */
export function streetLightingFile(projectDir: string): string {
  const own = path.join(projectDir, "authoring", "street-lights.json");
  return fs.existsSync(own) ? own : path.join(HERE, "street-lights.json");
}
export function loadStreetLighting(projectDir: string): StreetLighting {
  return streetLightingSchema.parse(JSON.parse(fs.readFileSync(streetLightingFile(projectDir), "utf8")));
}

// ------------------------------------------------------------------ inputs

export interface LightRoad { id: string; points: XZ[]; width: number }
export interface LightGate { id: string; at: XZ; facing: XZ; width: number }
export interface LightDock {
  id: string;
  corners: XZ[];
  centre: XZ;
  along: XZ;
  head?: { at: XZ; y: number };
  deck?: { y: number; along: [number, number]; across: [number, number] };
  jetty?: { root: XZ; end: XZ; y: number; width: number };
}
export interface LightObstacle { at: XZ; r: number; what: string }
export interface LightGround { height(x: number, z: number): number; waterY(x: number, z: number): number | null }
export interface TownLightInput {
  town: { id: string; name: string; center: XZ; radius: number; gates: LightGate[] };
  roads: LightRoad[]; // the whole recipe's roads
  bridges: { id: string; points: [XZ, XZ]; width: number; deckY: number }[];
  buildings: { id: string; poly: XZ[]; door?: XZ }[];
  docks: LightDock[];
  obstacles: LightObstacle[];
  ground: LightGround;
}
export type LightKind = "street" | "lane" | "plaza" | "gate" | "quay" | "road" | "junction" | "bridge";
export interface Lantern { id: string; prefab: string; kind: LightKind; ref: string; at: [number, number, number]; yaw: number; deck?: boolean }

// ------------------------------------------------------------------ geometry

const sub = (a: XZ, b: XZ): XZ => [a[0] - b[0], a[1] - b[1]];
const add = (a: XZ, b: XZ, k = 1): XZ => [a[0] + b[0] * k, a[1] + b[1] * k];
const len = (a: XZ): number => Math.hypot(a[0], a[1]);
const norm = (a: XZ): XZ => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l];
};
const dist = (a: XZ, b: XZ): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
function segDist(p: XZ, a: XZ, b: XZ): number {
  const ab = sub(b, a), ap = sub(p, a);
  const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1]) / (ab[0] * ab[0] + ab[1] * ab[1] || 1)));
  return dist(p, add(a, ab, t));
}
export function polyDist(p: XZ, pts: XZ[]): number {
  if (pts.length === 1) return dist(p, pts[0]!);
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(p, pts[i - 1]!, pts[i]!));
  return d;
}
function inPoly(p: XZ, poly: XZ[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!;
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
const ringDist = (p: XZ, poly: XZ[]): number => polyDist(p, [...poly, poly[0]!]);
/** Point and unit tangent at arc length s along a polyline. */
function along(pts: XZ[], s: number): { p: XZ; t: XZ } {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!, l = dist(a, b);
    if (acc + l >= s || i === pts.length - 1) {
      const k = l ? Math.max(0, Math.min(1, (s - acc) / l)) : 0;
      return { p: add(a, sub(b, a), k), t: norm(sub(b, a)) };
    }
    acc += l;
  }
  return { p: pts[0]!, t: [1, 0] };
}
const lengthOf = (pts: XZ[]): number => pts.slice(1).reduce((s, p, i) => s + dist(pts[i]!, p), 0);
/** Yaw (radians about +Y) that turns local +X onto direction d (three.js: +X -> (cos, 0, -sin)). */
const yawOf = (d: XZ): number => Math.atan2(-d[1], d[0]);
/** The polyline cut to the stretch [0, maxLen] from its start. */
function cut(pts: XZ[], maxLen: number): XZ[] {
  const out: XZ[] = [pts[0]!];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = dist(pts[i - 1]!, pts[i]!);
    if (acc + l >= maxLen) {
      out.push(add(pts[i - 1]!, sub(pts[i]!, pts[i - 1]!), (maxLen - acc) / (l || 1)));
      return out;
    }
    acc += l;
    out.push(pts[i]!);
  }
  return out;
}

// ------------------------------------------------------------------ classification

export interface TownNet {
  streets: (LightRoad & { kind: "street" | "lane" | "plaza" })[];
  doors: LightRoad[];
  stairs: LightRoad[];
  /** World roads leaving this town, each oriented from its mouth outwards and cut to `junctionReach`. */
  out: (LightRoad & { mouth: XZ; gate: string; full: LightRoad })[];
  world: LightRoad[];
}
export function townNet(inp: TownLightInput, rule: StreetLighting): TownNet {
  const t = inp.town;
  const own = (r: LightRoad): boolean => r.id.startsWith(`${t.id}-`);
  const anyTown = /^town-\d+-/;
  const excluded = rule.roads.exclude.map((x) => new RegExp(x));
  const streets = inp.roads
    .filter((r) => own(r) && r.id.startsWith(`${t.id}-street-`))
    .map((r) => ({ ...r, kind: (/-(square|plaza)-/.test(r.id) ? "plaza" : /-lane-/.test(r.id) ? "lane" : "street") as "street" | "lane" | "plaza" }));
  const doors = inp.roads.filter((r) => r.id.startsWith(`${t.id}-door-`));
  const stairs = inp.roads.filter((r) => own(r) && /-(stair|ramp)-/.test(r.id));
  const world = inp.roads.filter((r) => !anyTown.test(r.id) && !excluded.some((x) => x.test(r.id)));
  const out: TownNet["out"] = [];
  for (const r of world) {
    for (const rev of [false, true]) {
      const pts = rev ? [...r.points].reverse() : r.points;
      const end = pts[0]!;
      const gate = t.gates.find((g) => dist(g.at, end) < 4);
      let mouth: XZ | null = gate ? gate.at : null;
      let from = 0;
      if (!gate) {
        if (dist(end, t.center) > t.radius) continue; // this end is not in the town
        // gateless town: the road starts lighting where it leaves the radius
        const L = lengthOf(pts);
        for (let s = 0; s <= L; s += 1) if (dist(along(pts, s).p, t.center) > t.radius) { from = s; break; }
        mouth = along(pts, from).p;
      }
      const rest: XZ[] = [mouth!];
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        acc += dist(pts[i - 1]!, pts[i]!);
        if (acc > from) rest.push(pts[i]!);
      }
      out.push({ id: r.id, width: r.width, points: cut(rest, rule.roads.junctionReach), mouth: mouth!, gate: gate?.id ?? "", full: r });
    }
  }
  return { streets, doors, stairs, out, world };
}

// ------------------------------------------------------------------ the planner

interface Ctx { inp: TownLightInput; rule: StreetLighting; net: TownNet; placed: Lantern[] }

/** Why a lantern may not stand at p (null = it may). `self` is the road it lights (its carriageway rule differs). */
function refuse(c: Ctx, p: XZ, foot: XZ[], o: { self?: string; selfMin?: number; deck?: boolean; kind: LightKind }): string | null {
  const { inp, rule, net } = c;
  const cl = rule.clearance;
  for (const b of inp.buildings) for (const q of foot) if (inPoly(q, b.poly) || ringDist(q, b.poly) < cl.building) return `building ${b.id}`;
  for (const b of inp.buildings) if (b.door && dist(p, b.door) < 1 + cl.door) return `door of ${b.id}`;
  for (const d of net.doors) if (polyDist(p, d.points) < d.width / 2 + cl.door) return `door path ${d.id}`;
  for (const s of net.stairs) if (polyDist(p, s.points) < s.width / 2 + cl.stair) return `stair ${s.id}`;
  for (const r of [...net.streets, ...net.world]) {
    const d = polyDist(p, r.points);
    if (r.id === o.self) {
      if (d < (o.selfMin ?? r.width / 2)) return `on ${r.id}`;
    } else if (!(o.kind === "plaza" && "kind" in r && r.kind === "plaza") && d < r.width / 2 + (net.world.includes(r) ? 0.4 : 0.25)) return `on ${r.id}`;
  }
  for (const b of inp.bridges) if (segDist(p, b.points[0], b.points[1]) < b.width / 2 + 0.5) return `bridge ${b.id}`;
  for (const ob of inp.obstacles) if (dist(p, ob.at) < ob.r) return ob.what;
  if (!o.deck) for (const d of inp.docks) if (inPoly(p, d.corners)) return `dock ${d.id}`;
  for (const l of c.placed) if (dist(p, [l.at[0], l.at[2]]) < cl.minApart) return `near ${l.id}`;
  if (!o.deck) {
    const g = inp.ground.height(p[0], p[1]);
    const w = inp.ground.waterY(p[0], p[1]);
    if (w !== null && w > g - 0.05) return "water";
    const hs = [[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]].map(([dx, dz]) => inp.ground.height(p[0] + dx!, p[1] + dz!));
    if (Math.max(...hs, g) - Math.min(...hs, g) > cl.maxTilt) return "steep";
  }
  return null;
}
function baseY(c: Ctx, p: XZ): number {
  const g = c.inp.ground;
  const hs = [[0, 0], [0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]].map(([dx, dz]) => g.height(p[0] + dx!, p[1] + dz!));
  return +(Math.min(...hs) - 0.04).toFixed(3);
}
/**
 * Footprint test points. Every lantern faces the middle of what it lights (owner ruling 2026-10-05): `u` points from the
 * lantern toward the road centre. A hanging lantern hangs toward `u` (its lantern is at head height, so it is tested);
 * a lamp post's arms are above any head, so only its base and the arm on the far side are tested.
 */
function footOf(prefab: string, p: XZ, u: XZ): XZ[] {
  const n: XZ = [-u[1], u[0]];
  return prefab.includes("hanging") ? [p, add(p, u, 0.45), add(p, u, -0.3)] : [p, add(p, u, -1.05), add(p, n, 0.3), add(p, n, -0.3)];
}
function put(c: Ctx, l: Omit<Lantern, "id">, n: number): Lantern {
  const lantern = { id: `${l.kind}-${l.ref.replace(/[^a-z0-9-]/gi, "-")}-${n}`, ...l };
  c.placed.push(lantern);
  return lantern;
}
const covered = (c: Ctx, p: XZ, r: number): boolean => c.placed.some((l) => dist(p, [l.at[0], l.at[2]]) <= r);

export interface TownLightPlan { lanterns: Lantern[]; unplaced: { kind: LightKind; ref: string; at: XZ; why: string }[] }

export function planTownLights(inp: TownLightInput, rule: StreetLighting): TownLightPlan {
  const net = townNet(inp, rule);
  const c: Ctx = { inp, rule, net, placed: [] };
  const unplaced: TownLightPlan["unplaced"] = [];
  const tryAll = (kind: LightKind, ref: string, prefab: string, at: XZ, cands: { p: XZ; u: XZ; self?: string; selfMin?: number; y?: number }[], n: number): void => {
    let why = "no candidate";
    for (const k of cands) {
      const r = refuse(c, k.p, footOf(prefab, k.p, k.u), { self: k.self, selfMin: k.selfMin, deck: k.y !== undefined, kind });
      if (r) { why = r; continue; }
      put(c, { prefab, kind, ref, at: [+k.p[0].toFixed(3), k.y !== undefined ? +Math.max(k.y, inp.ground.height(k.p[0], k.p[1]) - 0.04).toFixed(3) : baseY(c, k.p), +k.p[1].toFixed(3)], yaw: +yawOf(k.u).toFixed(4), ...(k.y !== undefined ? { deck: true } : {}) }, n);
      return;
    }
    unplaced.push({ kind, ref, at, why });
  };
  const shifts = [0, 2, -2, 4, -4, 6, -6];

  // 1. quays: the head where the street meets the deck, a lantern on the deck towards each end, the jetty end
  for (const d of inp.docks) {
    const across: XZ = [d.along[1], -d.along[0]];
    const sea = d.jetty && (d.jetty.end[0] - d.centre[0]) * across[0] + (d.jetty.end[1] - d.centre[1]) * across[1] < 0 ? -1 : 1;
    const pre = rule.quays.prefab;
    if (d.head) tryAll("quay", `${d.id}-head`, pre, d.head.at, [0, 1.5, -1.5, 4.5, -4.5, 6, -6, 3, -3].map((s) => ({ p: add(d.head!.at, d.along, s), u: d.along, y: d.head!.y })), 0);
    if (d.deck) {
      const half = (d.deck.along[1] - d.deck.along[0]) / 2, mid = (d.deck.along[1] + d.deck.along[0]) / 2;
      const off = sea > 0 ? d.deck.across[1] - 2 : d.deck.across[0] + 2;
      for (const [n, s] of [[1, mid + half * 0.6], [2, mid - half * 0.6]] as const)
        tryAll("quay", `${d.id}-deck`, pre, add(d.centre, d.along, s), [0, 2, -2, 4, -4].map((ds) => ({ p: add(add(d.centre, d.along, s + ds), across, sea * off), u: pre.includes("hanging") ? ([-across[0] * sea, -across[1] * sea] as XZ) : d.along, y: d.deck!.y })), n);
    }
    if (d.jetty) {
      const j = d.jetty, dir = norm(sub(j.end, j.root)), side: XZ = [-dir[1], dir[0]];
      tryAll("quay", `${d.id}-jetty`, rule.quays.jettyPrefab, j.end, [1, -1].map((sg) => ({ p: add(add(j.end, dir, -0.8), side, sg * (j.width / 2 - 0.2)), u: dir, y: j.y })), 3);
    }
  }
  // 2. gates: a pair flanking each mouth, just outside it
  for (const g of inp.town.gates) {
    const f = norm(g.facing), n: XZ = [-f[1], f[0]];
    for (const sg of rule.gates.pair ? [1, -1] : [1])
      tryAll("gate", g.id, rule.gates.prefab, g.at, [1.5, 3, 0.5, 4.5, 6].flatMap((s) => [1.2, 2].map((o) => ({ p: add(add(g.at, f, s), n, sg * (g.width / 2 + o)), u: [-n[0] * sg, -n[1] * sg] as XZ })), ), sg > 0 ? 0 : 1);
  }
  // 3. plazas: one in the square (centre if clear, else round its edge)
  for (const pz of net.streets.filter((s) => s.kind === "plaza")) {
    const L = lengthOf(pz.points), mid = along(pz.points, L / 2);
    const ring = [0, 1, 2, 3, 4, 5, 6, 7].flatMap((k) => [0.35, 0.7].map((f) => {
      const a = (k / 8) * Math.PI * 2;
      return { p: add(mid.p, [Math.cos(a), Math.sin(a)], (pz.width / 2) * f), u: [-Math.cos(a), -Math.sin(a)] as XZ, self: pz.id, selfMin: 0 };
    }));
    if (!covered(c, mid.p, pz.width / 2)) tryAll("plaza", pz.id, rule.plazas.prefab, mid.p, [{ p: mid.p, u: mid.t, self: pz.id, selfMin: 0 }, ...ring], 0);
  }
  // 4. streets then lanes, widest first: stations at most `spacing` apart, sides alternating, at the paved edge
  const order = net.streets.filter((s) => s.kind !== "plaza").sort((a, b) => (a.kind === b.kind ? b.width - a.width || a.id.localeCompare(b.id) : a.kind === "street" ? -1 : 1));
  for (const s of order) {
    const L = lengthOf(s.points);
    const n = Math.max(1, Math.ceil(L / rule.streets.spacing));
    const prefab = s.kind === "lane" ? rule.streets.lanePrefab : rule.streets.prefab;
    for (let i = 0; i < n; i++) {
      const st = (i + 0.5) * (L / n);
      const at = along(s.points, st).p;
      if (covered(c, at, rule.streets.cover * 0.6)) continue;
      const first = i % 2 ? -1 : 1;
      // a hanging lantern carries its lantern at head height and faces the lane, so it stands far enough out that the
      // lantern itself stays clear of the lane (town-walk found a body bumping one that hung over a 4 m lane)
      const slim = prefab.includes("hanging");
      const offs = slim ? [s.width / 2 + 0.9, s.width / 2 + 1.4, s.width / 2 + 1.1] : [s.width / 2 + rule.streets.edgeOffset, s.width / 2 - 0.3, s.width / 2 + 1.2];
      const cands = shifts.flatMap((ds) => [first, -first].flatMap((sg) => offs.map((o) => {
        const a = along(s.points, Math.max(0, Math.min(L, st + ds))), nrm: XZ = [-a.t[1], a.t[0]];
        const p = add(a.p, nrm, sg * o);
        return { p, u: [-nrm[0] * sg, -nrm[1] * sg] as XZ, self: s.id, selfMin: slim ? s.width / 2 + 0.4 : s.width / 2 - 0.35 };
      })));
      tryAll(s.kind, s.id, prefab, at, cands, i);
    }
  }
  // 5. roads out of every mouth: on the shoulder, from `start` to `reach`, sides alternating
  for (const r of net.out) {
    const L = Math.min(rule.roads.reach, lengthOf(r.points));
    // even stations from `start` to the end of the lit stretch, at most `spacing` apart, the last one AT the end
    const n = Math.max(1, Math.ceil((L - rule.roads.start) / rule.roads.spacing)), step = (L - rule.roads.start) / n;
    for (let i = 0; i <= n; i++) {
      const st = rule.roads.start + i * step;
      const at = along(r.points, st).p;
      if (covered(c, at, rule.roads.cover * 0.6)) continue;
      const w = inp.ground.waterY(at[0], at[1]);
      if (w !== null && w > inp.ground.height(at[0], at[1]) - 0.05) continue; // a ford: nothing stands in the river
      const first = i % 2 ? -1 : 1;
      const offs = [r.width / 2 + rule.roads.shoulderOffset, r.width / 2 + 0.6, r.width / 2 + 1.8];
      const cands = [0, 3, -3, 6, -6].flatMap((ds) => [first, -first].flatMap((sg) => offs.map((o) => {
        const a = along(r.points, Math.max(0, st + ds)), nrm: XZ = [-a.t[1], a.t[0]];
        return { p: add(a.p, nrm, sg * o), u: [-nrm[0] * sg, -nrm[1] * sg] as XZ, self: r.id, selfMin: r.width / 2 + 0.4 };
      })));
      tryAll("road", r.id, rule.roads.prefab, at, cands, i);
    }
  }
  // 6. junctions of world roads near the town (not at a mouth, which the gate already lights)
  const near = (p: XZ): boolean => net.out.some((o) => dist(p, o.mouth) <= rule.roads.junctionReach);
  const atMouth = (p: XZ): boolean => net.out.some((o) => dist(p, o.mouth) < 12) || dist(p, inp.town.center) < inp.town.radius;
  const junctions: { at: XZ; a: LightRoad; b: LightRoad }[] = [];
  for (const a of net.world) for (const b of net.world) {
    if (a.id >= b.id) continue;
    for (const e of [a.points[0]!, a.points[a.points.length - 1]!, b.points[0]!, b.points[b.points.length - 1]!]) {
      const other = a.points.includes(e) ? b : a;
      if (polyDist(e, other.points) < 3 && near(e) && !atMouth(e) && !junctions.some((j) => dist(j.at, e) < 12)) junctions.push({ at: e, a, b });
    }
  }
  junctions.sort((x, y) => x.at[0] - y.at[0] || x.at[1] - y.at[1]);
  junctions.forEach((j, n) => {
    if (covered(c, j.at, 8)) return;
    const r0 = Math.max(j.a.width, j.b.width) / 2;
    const cands = [0, 1, 2, 3, 4, 5, 6, 7].flatMap((k) => [r0 + 1.5, r0 + 2.5].map((o) => {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
      return { p: add(j.at, [Math.cos(a), Math.sin(a)], o), u: [-Math.cos(a), -Math.sin(a)] as XZ };
    }));
    tryAll("junction", `${j.a.id}+${j.b.id}`, rule.roads.prefab, j.at, cands, n);
  });
  // 7. both ends of every bridge near the town, on the bank beside the abutment
  for (const b of inp.bridges) {
    if (!b.points.some((p) => near(p))) continue;
    b.points.forEach((p, n) => {
      const away = norm(sub(p, b.points[1 - n]!)), side: XZ = [-away[1], away[0]];
      const cands = [2, 3.5, 5].flatMap((s) => [1, -1].flatMap((sg) => [1, 1.8].map((o) => ({ p: add(add(p, away, s), side, sg * (b.width / 2 + o)), u: [-side[0] * sg, -side[1] * sg] as XZ }))));
      tryAll("bridge", b.id, rule.roads.prefab, p, cands, n);
    });
  }
  return { lanterns: c.placed, unplaced };
}

// ------------------------------------------------------------------ the gate

export interface LightCheck { ok: boolean; failures: string[]; counts: Record<string, number> }

/** Judge INSTALLED lanterns (read from the scene) against the standard: coverage of every street, plaza, gate, quay
 *  and road stretch, and lawful spots (not in a building, on a carriageway, door path, stair buffer or in water; on the
 *  ground). Re-run after anything moves: a lantern a new building swallowed fails here. */
export function checkTownLights(inp: TownLightInput, rule: StreetLighting, installed: Lantern[]): LightCheck {
  const net = townNet(inp, rule);
  const failures: string[] = [];
  const pts = installed.map((l) => [l.at[0], l.at[2]] as XZ);
  const nearest = (p: XZ): number => pts.reduce((m, q) => Math.min(m, dist(p, q)), Infinity);
  const gapsAlong = (name: string, line: XZ[], cover: number, skip?: (p: XZ) => boolean): void => {
    const L = lengthOf(line);
    let worst = 0, at: XZ | null = null, s0 = 0;
    for (let s = 0; s <= L; s += 1) {
      const p = along(line, s).p;
      if (skip?.(p)) continue;
      const d = nearest(p);
      if (d > worst) { worst = d; at = p; s0 = s; }
    }
    if (worst > cover) failures.push(`${name}: dark stretch, ${worst.toFixed(1)} m from a lantern at ${s0.toFixed(0)} m along (${at![0].toFixed(0)}, ${at![1].toFixed(0)}); the standard is ${cover} m`);
  };
  for (const s of net.streets) {
    if (s.kind === "plaza") {
      const mid = along(s.points, lengthOf(s.points) / 2).p;
      if (nearest(mid) > s.width / 2 + rule.plazas.cover) failures.push(`plaza ${s.id}: no lantern in the square`);
    } else gapsAlong(`${s.kind} ${s.id}`, s.points, rule.streets.cover, (p) => inp.docks.some((d) => inPoly(p, d.corners)));
  }
  for (const g of inp.town.gates) if (nearest(g.at) > rule.gates.cover) failures.push(`gate ${g.id}: no lantern at the mouth`);
  for (const d of inp.docks) {
    if (d.head && nearest(d.head.at) > rule.quays.cover) failures.push(`quay ${d.id}: no lantern at the quay head`);
    if (d.jetty && nearest(d.jetty.end) > rule.quays.cover) failures.push(`quay ${d.id}: no lantern at the jetty end`);
  }
  const wet = (p: XZ): boolean => {
    const w = inp.ground.waterY(p[0], p[1]);
    return (w !== null && w > inp.ground.height(p[0], p[1]) - 0.05) || inp.bridges.some((b) => segDist(p, b.points[0], b.points[1]) < b.width);
  };
  for (const r of net.out) gapsAlong(`road ${r.id} out of ${r.gate || "the town"}`, cut(r.points, rule.roads.reach), rule.roads.cover, wet);
  for (const b of inp.bridges) if (b.points.some((p) => net.out.some((o) => dist(p, o.mouth) <= rule.roads.junctionReach)))
    for (const p of b.points) if (nearest(p) > 8) failures.push(`bridge ${b.id}: no lantern at the end (${p[0].toFixed(0)}, ${p[1].toFixed(0)})`);
  // lawful spots
  const c: Ctx = { inp, rule, net, placed: [] };
  for (const l of installed) {
    const p: XZ = [l.at[0], l.at[2]];
    const u: XZ = [Math.cos(l.yaw), -Math.sin(l.yaw)];
    const selfRoad = [...net.streets, ...net.out].filter((r) => r.id === l.ref)[0];
    const why = refuse(c, p, footOf(l.prefab, p, u), {
      kind: l.kind, deck: !!l.deck, self: selfRoad?.id,
      selfMin: selfRoad ? (l.kind === "road" ? selfRoad.width / 2 + 0.4 : l.kind === "plaza" ? 0 : l.prefab.includes("hanging") ? selfRoad.width / 2 + 0.4 : selfRoad.width / 2 - 0.35) : undefined,
    });
    if (why && !why.startsWith("near ")) failures.push(`lantern ${l.id}: unlawful spot (${why})`);
    if (!l.deck) {
      // the same footing baseY() uses: the lowest of the five base samples (a post on a slope is set on its low side)
      const g = Math.min(...[[0, 0], [0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]].map(([dx, dz]) => inp.ground.height(p[0] + dx!, p[1] + dz!)));
      if (Math.abs(l.at[1] - g) > rule.clearance.groundTolerance) failures.push(`lantern ${l.id}: ${l.at[1] > g ? "floats" : "buried"} ${Math.abs(l.at[1] - g).toFixed(2)} m off the ground`);
    }
    c.placed.push(l);
  }
  const counts: Record<string, number> = {};
  for (const l of installed) counts[l.kind] = (counts[l.kind] ?? 0) + 1;
  return { ok: failures.length === 0, failures, counts };
}

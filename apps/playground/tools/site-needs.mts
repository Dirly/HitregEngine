/**
 * SITE NEEDS — the ground a place or a town needs, as measured data (2026-10-29, Derek on firstshore).
 *
 * The Wristgate (a 52 m carved front) went on a 40 m gorge beside a 31 m falls: "the river cliff doesn't support
 * this... you need a cliff for something of this calibre". Saltharrow, a WALLED town, went in a cove under a hill
 * where no wall line is defensible: "the cliffs beside them would have been better suited". Places were sited BY TYPE
 * (an entrance -> a falls, a harbour -> a cove) and nothing asked whether the ground could carry the idea.
 *
 * Here every role declares what it needs, in metres, and `measureNeeds` says met / unmet per need with the numbers.
 * Defaults live in SITE_NEEDS (this file is the one place); a brief place overrides them with `siteNeeds`.
 * Read by: `zonegen sites --role` / `--propose`, `zonegen reserve` (a reservation whose site fails a need FAILS unless a
 * dated coordinator ruling excepts it), `worldgen towns --propose` / `--pick` and the `towns` status row (a town's
 * `siteRole`), and `worldgen needs` (the generator making ground no candidate has: GENERATORS below).
 *
 * Pure: no I/O. The ground is a sampler (NeedGround), so tests run on synthetic fields.
 */
import { z } from "zod";
import { TOWN_SITE_ROLES, type GroundNeedDoc, type HeightPatchDoc } from "@hitreg/core";
import { OVERLOOK_RULE } from "./_town-wall-rules.mts";
import { terraceReach } from "./worldgen-coastal-towns.mts";

export type V2 = [number, number];

/** The ground the needs are measured on. `height` is the DRAWN ground (DC terrain: `field.ground`). */
export interface NeedGround {
  height(x: number, z: number): number;
  /** Standing water (sea, lake, river) at (x, z). */
  wet(x: number, z: number): boolean;
  sea: number;
  /** harbour-town: the coastal rule's faults at a pad (tools/worldgen-coastal-towns.mts coastalFaults); empty = a shore site. */
  coastal?(x: number, z: number, radius: number): string[];
  /** Travel roads, when the world has them (a crossroads counts the roads that meet). */
  roads?: readonly { id: string; points: readonly (readonly number[])[] }[];
}

// ------------------------------------------------------------------ the schema (facts in .describe())

const reach = terraceReach();
const rockFace = z.object({
  kind: z.literal("rock-face"),
  frontHeight: z.number().positive().default(40).describe("Height of the carved / built front the face must carry, m."),
  ratio: z.number().min(1).default(1.1).describe("The face must stand this many times the front's height (rock above the lintel)."),
  minHeight: z.number().positive().optional().describe("Explicit face height, m (overrides frontHeight x ratio)."),
  faceSlope: z.number().positive().default(1).describe("Rise/run counted as rock face (1 = 45 deg)."),
  footReach: z.number().positive().default(40).describe("The face's foot must start within this many metres of the site point."),
  apronM2: z.number().min(0).default(1600).describe("Flat apron at the foot (plaza, stair landing), m2: dry, within 3 m of the foot's height, slope <= apronSlope."),
  apronSlope: z.number().positive().default(0.15).describe("Steepest rise/run counted as apron."),
  readDistance: z.number().min(0).default(300).describe("The face must be seen (line of sight to its mid-height, eye 1.7 m) from at least this far in front of it; 0 = not measured."),
});
const defensible = z.object({
  kind: z.literal("defensible"),
  margin: z.number().min(0).default(12).describe("The wall ring stands this far outside the pad radius, m."),
  maxWall: z.number().positive().default(260).describe("Most metres of wall the open (unprotected) ring may need: cliff flanks or a neck <= this to wall."),
  flankDrop: z.number().positive().default(8).describe("A bearing is PROTECTED when the ground within flankBand outside the ring falls this far under the pad, or is water."),
  flankBand: z.number().positive().default(30).describe("Metres outside the ring a protecting drop must happen within."),
  overlookBand: z.number().positive().default(OVERLOOK_RULE.band).describe("No ground within this many metres outside the ring may see over the wall top (the town-wall-line overlook rule, pre-layout)."),
  wallHeight: z.number().positive().default(6).describe("Wall height over the pad, m (town-wall-line draw --height default)."),
  parapet: z.number().min(0).default(1.2).describe("Parapet over the wall top, m."),
});
const shore = z.object({ kind: z.literal("shore") }).describe("The coastal rule (tools/worldgen-coastal-towns.mts COASTAL_TOWN: <= 12 m over the sea, <= 90 m from a sheltered cove / sand-beach, steppable, dry).");
const flatPad = z.object({
  kind: z.literal("flat-pad"),
  maxRelief: z.number().positive().default(reach.maxRelief).describe("Most relief (p05..p95) across the pad a terrace steps, m (worldgen terrace defaults)."),
  maxSlope: z.number().positive().default(Math.round(reach.maxSlope * 100) / 100).describe("Most mean rise/run across the pad a terrace steps."),
});
const highGround = z.object({
  kind: z.literal("high-ground"),
  minRise: z.number().positive().default(15).describe("The pad stands at least this far over the median ground on a ring `ring` m outside it."),
  ring: z.number().positive().default(150).describe("Metres outside the pad edge the surroundings are read at."),
});
const crossroads = z.object({
  kind: z.literal("crossroads"),
  minWays: z.number().int().min(1).default(4).describe("Open ways in (of 8 compass sectors: walkable ground out to `reach` m) or roads meeting within 150 m of the pad edge."),
  reach: z.number().positive().default(500).describe("Metres a way must run open."),
  maxGrade: z.number().positive().default(0.2).describe("Steepest rise/run over a 12 m step a way may climb (two steps over it are allowed)."),
});

export const siteNeedSchema = z
  .discriminatedUnion("kind", [rockFace, defensible, shore, flatPad, highGround, crossroads])
  .describe("One measured requirement on the ground under a place or town.");
export type SiteNeed = z.infer<typeof siteNeedSchema>;
export type NeedKind = SiteNeed["kind"];
export const NEED_KINDS = ["rock-face", "defensible", "shore", "flat-pad", "high-ground", "crossroads"] as const satisfies readonly NeedKind[];

export const siteNeedOverridesSchema = z
  .object({
    "rock-face": rockFace.omit({ kind: true }).partial(),
    defensible: defensible.omit({ kind: true }).partial(),
    "flat-pad": flatPad.omit({ kind: true }).partial(),
    "high-ground": highGround.omit({ kind: true }).partial(),
    crossroads: crossroads.omit({ kind: true }).partial(),
  })
  .partial()
  .describe("Per-place overrides of its role's needs (tools/site-needs.mts SITE_NEEDS): { \"rock-face\": { frontHeight: 52 } }.");
export type SiteNeedOverrides = z.infer<typeof siteNeedOverridesSchema>;

/** Roles of places (POIs, dungeon doors) beside the town roles of the recipe (`townSchema.siteRole`). */
export const PLACE_SITE_ROLES = ["grand-entrance", "dungeon-door", "lookout", "harbour"] as const;
export const SITE_ROLES = [...TOWN_SITE_ROLES, ...PLACE_SITE_ROLES] as const;
export type SiteRole = (typeof SITE_ROLES)[number];
export const siteRoleSchema = z.enum(SITE_ROLES).describe(
  "What the site is FOR, so its ground needs can be measured (tools/site-needs.mts SITE_NEEDS): grand-entrance = a rock face >= 1.1 x the front, " +
    "a 1600 m2 apron, seen from 300 m; dungeon-door = rock >= 1.5 x an 8 m door behind it; lookout = high ground; harbour = the shore rule; " +
    "walled-town = flanks or a neck <= 260 m to wall and no ground within 60 m over the wall top; harbour-town = the coastal rule; " +
    "capital / crossroads-town = 4 open ways in; hill-town = 15 m over its surroundings; every town = a steppable pad.",
);

/** THE DEFAULTS: what each role needs (one place; a brief place overrides with `siteNeeds`). */
export const SITE_NEEDS: Record<SiteRole, readonly Record<string, unknown>[]> = {
  "grand-entrance": [{ kind: "rock-face" }],
  "dungeon-door": [{ kind: "rock-face", frontHeight: 8, ratio: 1.5, apronM2: 150, readDistance: 0, footReach: 25 }],
  lookout: [{ kind: "high-ground", minRise: 25, ring: 120 }],
  harbour: [{ kind: "shore" }],
  town: [{ kind: "flat-pad" }],
  capital: [{ kind: "flat-pad" }, { kind: "crossroads" }],
  "walled-town": [{ kind: "flat-pad" }, { kind: "defensible" }],
  "harbour-town": [{ kind: "shore" }],
  "hill-town": [{ kind: "flat-pad" }, { kind: "high-ground" }],
  "crossroads-town": [{ kind: "flat-pad" }, { kind: "crossroads", minWays: 5 }],
};

/** The needs of a role with a place's overrides merged, schema-parsed (defaults filled in). */
export function needsFor(role: SiteRole, overrides: SiteNeedOverrides = {}): SiteNeed[] {
  return SITE_NEEDS[role].map((n) => {
    const kind = n.kind as NeedKind;
    const o = kind === "shore" ? {} : ((overrides as Record<string, object | undefined>)[kind] ?? {});
    return siteNeedSchema.parse({ ...n, ...o });
  });
}

// ------------------------------------------------------------------ measuring

export interface NeedResult {
  need: NeedKind;
  met: boolean;
  /** The measured numbers (metres, m2, bearings). */
  numbers: Record<string, number | string | null>;
  /** What is short, in words with numbers; empty when met. */
  faults: string[];
  /** One line. */
  message: string;
}
export interface NeedsReport {
  role: string;
  met: boolean;
  results: NeedResult[];
}

const R1 = (v: number) => Math.round(v * 10) / 10;
const dirOf = (bearing: number): V2 => [Math.sin((bearing * Math.PI) / 180), -Math.cos((bearing * Math.PI) / 180)];
export const bearingOf = (dx: number, dz: number): number => ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export const compassWord = (b: number): string => COMPASS[Math.round((((b % 360) + 360) % 360) / 45) % 8]!;
const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]!;
};

/** Heights and slopes over a pad disc (6 m grid). */
function padStats(g: NeedGround, x: number, z: number, radius: number): { median: number; max: number; relief: number; meanSlope: number; wet: number } {
  const step = 6;
  const hs: number[] = [];
  let slope = 0, n = 0, wet = 0;
  for (let dz = -radius; dz <= radius; dz += step)
    for (let dx = -radius; dx <= radius; dx += step) {
      if (dx * dx + dz * dz > radius * radius) continue;
      const px = x + dx, pz = z + dz;
      const h = g.height(px, pz);
      hs.push(h);
      const gx = (g.height(px + 3, pz) - g.height(px - 3, pz)) / 6, gz = (g.height(px, pz + 3) - g.height(px, pz - 3)) / 6;
      slope += Math.hypot(gx, gz);
      n++;
      if (g.wet(px, pz)) wet++;
    }
  return { median: quantile(hs, 0.5), max: Math.max(...hs), relief: quantile(hs, 0.95) - quantile(hs, 0.05), meanSlope: slope / Math.max(1, n), wet };
}

/** The best rock face rising from within `footReach` of (x, z): its height, the bearing INTO the rock, foot and top. */
export function bestFace(g: NeedGround, x: number, z: number, o: { faceSlope: number; footReach: number; maxRun?: number; bearings?: number }): {
  height: number; into: number; foot: V2; footY: number; top: V2; run: number;
} {
  const step = 2;
  const nb = o.bearings ?? 36;
  const maxRun = o.maxRun ?? 160;
  let best = { height: 0, into: 0, foot: [x, z] as V2, footY: g.height(x, z), top: [x, z] as V2, run: 0 };
  for (let k = 0; k < nb; k++) {
    const b = (k * 360) / nb;
    const [dx, dz] = dirOf(b);
    const H = (s: number) => g.height(x + dx * s, z + dz * s);
    let start = -1;
    for (let s = 0; s <= o.footReach; s += step) if ((H(s + 4) - H(s)) / 4 >= o.faceSlope) { start = s; break; }
    if (start < 0) continue;
    if (g.wet(x + dx * start, z + dz * start)) continue; // a foot under water is no door foot
    let top = start, gentle = 0;
    for (let s = start; s < start + maxRun; s += step) {
      if ((H(s + step) - H(s)) / step >= o.faceSlope * 0.5) { top = s + step; gentle = 0; }
      else if ((gentle += step) > 6) break;
    }
    const height = H(top) - H(start);
    if (height > best.height) best = { height, into: b, foot: [x + dx * start, z + dz * start], footY: H(start), top: [x + dx * top, z + dz * top], run: top - start };
  }
  return best;
}

/** Line of sight from (vx, vy, vz) to (tx, ty, tz) over the ground (sampled every 4 m, the last 6 m skipped). */
function sees(g: NeedGround, v: [number, number, number], t: [number, number, number]): boolean {
  const len = Math.hypot(t[0] - v[0], t[2] - v[2]);
  for (let s = 4; s < len - 6; s += 4) {
    const f = s / len;
    const y = v[1] + (t[1] - v[1]) * f;
    if (g.height(v[0] + (t[0] - v[0]) * f, v[2] + (t[2] - v[2]) * f) > y) return false;
  }
  return true;
}

function measureRockFace(g: NeedGround, n: Extract<SiteNeed, { kind: "rock-face" }>, x: number, z: number): NeedResult {
  const want = n.minHeight ?? n.frontHeight * n.ratio;
  const f = bestFace(g, x, z, { faceSlope: n.faceSlope, footReach: n.footReach, maxRun: Math.max(80, want * 2.5) });
  const front = (f.into + 180) % 360;
  const [ix, iz] = dirOf(f.into);
  // the apron: dry level ground in front of the foot
  const ra = Math.sqrt(Math.max(n.apronM2, 100) / Math.PI);
  const cx = f.foot[0] - ix * ra * 0.9, cz = f.foot[1] - iz * ra * 0.9;
  let apron = 0;
  const cell = 4;
  for (let dz = -ra * 1.6; dz <= ra * 1.6; dz += cell)
    for (let dx = -ra * 1.6; dx <= ra * 1.6; dx += cell) {
      if (dx * dx + dz * dz > ra * ra * 2.56) continue;
      const px = cx + dx, pz = cz + dz;
      if ((px - f.foot[0]) * ix + (pz - f.foot[1]) * iz > 0) continue; // the rock side
      if (g.wet(px, pz)) continue;
      const h = g.height(px, pz);
      if (Math.abs(h - f.footY) > 3) continue;
      const gx = (g.height(px + 2, pz) - g.height(px - 2, pz)) / 4, gz = (g.height(px, pz + 2) - g.height(px, pz - 2)) / 4;
      if (Math.hypot(gx, gz) <= n.apronSlope) apron += cell * cell;
    }
  // the read: the face's mid-height seen from out in front
  let seenFrom = 0;
  if (n.readDistance > 0 && f.height > 0) {
    const midY = f.footY + f.height / 2;
    let s = 0;
    while (s < f.run && g.height(f.foot[0] + ix * s, f.foot[1] + iz * s) < midY) s += 2;
    const t: [number, number, number] = [f.foot[0] + ix * (s - 2), midY + 1, f.foot[1] + iz * (s - 2)];
    for (const d of [n.readDistance * 1.5, n.readDistance * 1.25, n.readDistance]) {
      for (const off of [0, -15, 15, -30, 30, -45, 45]) {
        const [vx, vz] = dirOf(front + off);
        const px = t[0] + vx * d, pz = t[2] + vz * d;
        if (g.wet(px, pz)) continue;
        if (sees(g, [px, g.height(px, pz) + 1.7, pz], t)) { seenFrom = Math.max(seenFrom, d); break; }
      }
      if (seenFrom) break;
    }
  }
  const faults: string[] = [];
  if (f.height < want) faults.push(`face ${R1(f.height)} m, needs ${R1(want)} m (${n.minHeight ? "asked" : `${n.ratio} x the ${n.frontHeight} m front`})`);
  if (apron < n.apronM2) faults.push(`apron ${Math.round(apron)} m2 at the foot, needs ${n.apronM2} m2`);
  if (n.readDistance > 0 && seenFrom < n.readDistance) faults.push(`face not seen from ${n.readDistance} m in front`);
  return {
    need: "rock-face",
    met: faults.length === 0,
    numbers: { face: R1(f.height), want: R1(want), apronM2: Math.round(apron), wantApronM2: n.apronM2, seenFrom: Math.round(seenFrom), readDistance: n.readDistance, faces: Math.round(front), foot: `${Math.round(f.foot[0])},${Math.round(f.foot[1])}`, footY: R1(f.footY) },
    faults,
    message: faults.length ? faults.join("; ") : `face ${R1(f.height)} m (>= ${R1(want)}), apron ${Math.round(apron)} m2, seen from ${Math.round(seenFrom)} m, front faces ${compassWord(front)}`,
  };
}

/** The ring round a pad: which bearings a cliff or water protects, and the wall the rest needs. */
export function measureDefensible(g: NeedGround, n: Extract<SiteNeed, { kind: "defensible" }>, x: number, z: number, radius: number): NeedResult {
  const pad = padStats(g, x, z, radius);
  const padY = pad.median;
  const R = radius + n.margin;
  const N = 72;
  const prot: boolean[] = [];
  for (let k = 0; k < N; k++) {
    const [dx, dz] = dirOf((k * 360) / N);
    let p = false;
    for (let s = 0; s <= n.flankBand && !p; s += 3) {
      const px = x + dx * (R + s), pz = z + dz * (R + s);
      if (g.wet(px, pz) || g.height(px, pz) < padY - n.flankDrop) p = true;
    }
    prot.push(p);
  }
  // open runs, as contiguous bearings, round the circle
  const runs: number[] = [];
  if (prot.every((p) => !p)) runs.push(N);
  else {
    const first = prot.indexOf(true);
    let len = 0;
    for (let i = 1; i <= N; i++) {
      const k = (first + i) % N;
      if (!prot[k]) len++;
      else if (len) { runs.push(len); len = 0; }
    }
    if (len) runs.push(len);
  }
  const theta = (cells: number) => (cells * 2 * Math.PI) / N;
  const wallOf = (cells: number) => (theta(cells) <= (100 * Math.PI) / 180 ? 2 * R * Math.sin(theta(cells) / 2) : R * theta(cells));
  const wallM = runs.reduce((a, c) => a + wallOf(c), 0);
  const neck = runs.length ? 2 * R * Math.sin(Math.min(Math.PI, theta(Math.max(...runs))) / 2) : 0;
  // overlook (pre-layout): an eye on ground outside the ring, within the band, above the wall top + parapet
  const wallTop = padY + n.wallHeight + n.parapet;
  let worst = -Infinity, worstAt: V2 = [x, z];
  for (let k = 0; k < N; k++) {
    const [dx, dz] = dirOf((k * 360) / N);
    for (let s = 0; s <= n.overlookBand; s += 4) {
      const px = x + dx * (R + s), pz = z + dz * (R + s);
      const over = g.height(px, pz) + OVERLOOK_RULE.eye - wallTop;
      if (over > worst) { worst = over; worstAt = [px, pz]; }
    }
  }
  const faults: string[] = [];
  if (wallM > n.maxWall) faults.push(`${Math.round(wallM)} m of open ring to wall (max ${n.maxWall}; ${runs.length} open run(s), widest ${Math.round(neck)} m): no cliff flanks or neck`);
  if (runs.length === 0) faults.push("cliff or water all round the ring: no way in on foot (it needs a neck to wall and gate)");
  if (worst > 0) faults.push(`ground at [${Math.round(worstAt[0])}, ${Math.round(worstAt[1])}] sees ${R1(worst)} m over a ${n.wallHeight} m wall (within ${n.overlookBand} m)`);
  const protShare = prot.filter(Boolean).length / N;
  return {
    need: "defensible",
    met: faults.length === 0,
    numbers: { wallM: Math.round(wallM), maxWall: n.maxWall, openRuns: runs.length, neckM: Math.round(neck), protectedShare: Math.round(protShare * 100) / 100, overlookM: R1(Math.max(0, worst)), padY: R1(padY) },
    faults,
    message: faults.length ? faults.join("; ") : `${Math.round(protShare * 100)} % of the ring protected by drop or water, ${Math.round(wallM)} m to wall (neck ${Math.round(neck)} m), nothing overlooks`,
  };
}

function measureFlat(g: NeedGround, n: Extract<SiteNeed, { kind: "flat-pad" }>, x: number, z: number, radius: number): NeedResult {
  const p = padStats(g, x, z, radius);
  const faults: string[] = [];
  if (p.relief > n.maxRelief) faults.push(`relief ${R1(p.relief)} m across the pad (terrace steps ${n.maxRelief})`);
  if (p.meanSlope > n.maxSlope) faults.push(`mean slope ${p.meanSlope.toFixed(2)} (terrace steps ${n.maxSlope})`);
  if (p.wet > 0) faults.push(`${p.wet} wet sample(s) on the pad`);
  return { need: "flat-pad", met: !faults.length, numbers: { relief: R1(p.relief), meanSlope: Math.round(p.meanSlope * 100) / 100, wet: p.wet }, faults, message: faults.join("; ") || `relief ${R1(p.relief)} m, slope ${p.meanSlope.toFixed(2)}` };
}

function measureHigh(g: NeedGround, n: Extract<SiteNeed, { kind: "high-ground" }>, x: number, z: number, radius: number): NeedResult {
  const padY = padStats(g, x, z, radius).median;
  const ring: number[] = [];
  for (let k = 0; k < 36; k++) { const [dx, dz] = dirOf(k * 10); ring.push(g.height(x + dx * (radius + n.ring), z + dz * (radius + n.ring))); }
  const rise = padY - quantile(ring, 0.5);
  const faults = rise < n.minRise ? [`stands ${R1(rise)} m over its surroundings ${n.ring} m out (needs ${n.minRise})`] : [];
  return { need: "high-ground", met: !faults.length, numbers: { rise: R1(rise), minRise: n.minRise }, faults, message: faults.join("; ") || `${R1(rise)} m over its surroundings` };
}

function measureCrossroads(g: NeedGround, n: Extract<SiteNeed, { kind: "crossroads" }>, x: number, z: number, radius: number): NeedResult {
  let open = 0;
  const openBearings: number[] = [];
  for (let k = 0; k < 8; k++) {
    let ok = false;
    for (const off of [0, -18, 18]) {
      const [dx, dz] = dirOf(k * 45 + off);
      let over = 0, s = radius, prev = g.height(x + dx * s, z + dz * s), good = true;
      for (s = radius + 12; s <= radius + n.reach; s += 12) {
        const px = x + dx * s, pz = z + dz * s;
        if (g.wet(px, pz)) { good = false; break; }
        const h = g.height(px, pz);
        if (Math.abs(h - prev) / 12 > n.maxGrade && ++over > 2) { good = false; break; }
        prev = h;
      }
      if (good) { ok = true; break; }
    }
    if (ok) { open++; openBearings.push(k * 45); }
  }
  let roads = 0;
  for (const r of g.roads ?? []) {
    let d = Infinity;
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1]!, b = r.points[i]!;
      const ax = a[0]!, az = a[a.length >= 3 ? 2 : 1]!, bx = b[0]!, bz = b[b.length >= 3 ? 2 : 1]!;
      const ddx = bx - ax, ddz = bz - az, L = ddx * ddx + ddz * ddz;
      const t = L < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - ax) * ddx + (z - az) * ddz) / L));
      d = Math.min(d, Math.hypot(x - ax - ddx * t, z - az - ddz * t));
    }
    if (d <= radius + 150) roads++;
  }
  const ways = Math.max(open, roads);
  const faults = ways < n.minWays ? [`${open} open way(s) of 8 sectors out to ${n.reach} m${roads ? `, ${roads} road(s) meet` : ""} (needs ${n.minWays})`] : [];
  return { need: "crossroads", met: !faults.length, numbers: { ways, openSectors: open, roads, minWays: n.minWays, openBearings: openBearings.map(compassWord).join(" ") }, faults, message: faults.join("; ") || `${ways} ways in (${openBearings.map(compassWord).join(" ")})` };
}

function measureShore(g: NeedGround, x: number, z: number, radius: number): NeedResult {
  if (!g.coastal) return { need: "shore", met: false, numbers: {}, faults: ["no coast plan to measure (run worldgen coast)"], message: "no coast plan to measure (run worldgen coast)" };
  const faults = g.coastal(x, z, radius);
  return { need: "shore", met: !faults.length, numbers: { faults: faults.length }, faults, message: faults.join("; ") || "a sheltered landing at shore level" };
}

export function measureNeed(g: NeedGround, n: SiteNeed, x: number, z: number, radius: number): NeedResult {
  switch (n.kind) {
    case "rock-face": return measureRockFace(g, n, x, z);
    case "defensible": return measureDefensible(g, n, x, z, radius);
    case "flat-pad": return measureFlat(g, n, x, z, radius);
    case "high-ground": return measureHigh(g, n, x, z, radius);
    case "crossroads": return measureCrossroads(g, n, x, z, radius);
    case "shore": return measureShore(g, x, z, radius);
  }
}

/** Every need of `role` at (x, z) for a pad / site of `radius` m. */
export function measureNeeds(g: NeedGround, role: SiteRole, x: number, z: number, radius: number, overrides: SiteNeedOverrides = {}): NeedsReport {
  const results = needsFor(role, overrides).map((n) => measureNeed(g, n, x, z, radius));
  return { role, met: results.every((r) => r.met), results };
}

/** A need excepted by a dated coordinator ruling ({ need, ruling: "2026-10-29 ..." }). */
export const needRulingSchema = z.object({
  need: z.enum(NEED_KINDS).describe("The need kind the ruling excepts."),
  ruling: z.string().regex(/\d{4}-\d{2}-\d{2}/, "a ruling quotes its date (YYYY-MM-DD)").describe("The coordinator's ruling with its date: why this site stands although the ground misses the need."),
});
export type NeedRuling = z.infer<typeof needRulingSchema>;

/** The unmet needs no ruling excepts. */
export function unexcepted(report: NeedsReport, rulings: readonly NeedRuling[] = []): NeedResult[] {
  return report.results.filter((r) => !r.met && !rulings.some((x) => x.need === r.need));
}

export function needsLine(report: NeedsReport): string {
  return report.results.map((r) => `${r.met ? "met" : "UNMET"} ${r.need}: ${r.message}`).join(" | ");
}

// ------------------------------------------------------------------ the world field as a NeedGround

export function needGroundOf(field: { height(x: number, z: number): number; ground?(x: number, z: number): number | null; waterY(x: number, z: number): number | null }, sea: number, extra: Partial<Pick<NeedGround, "coastal" | "roads">> = {}): NeedGround {
  return {
    height: (x, z) => field.ground?.(x, z) ?? field.height(x, z),
    wet: (x, z) => field.waterY(x, z) !== null || field.height(x, z) < sea + 0.3,
    sea,
    ...extra,
  };
}

// ------------------------------------------------------------------ candidate search (feet of rock faces)

/**
 * Feet of tall rock faces in an area: a coarse relief prefilter (`step` m grid, 60 m probes), then `bestFace` on what
 * passes. For a grand entrance the finder's canyon ends and cliffs rarely stand where the TALLEST faces are.
 */
export function findFaceFeet(g: NeedGround, inside: (x: number, z: number) => boolean, box: [number, number, number, number], want: number, o: { step?: number; top?: number } = {}): { at: V2; face: number; into: number }[] {
  const step = o.step ?? 32;
  const out: { at: V2; face: number; into: number; apron: boolean }[] = [];
  for (let z = box[1]; z <= box[3]; z += step)
    for (let x = box[0]; x <= box[2]; x += step) {
      if (!inside(x, z) || g.wet(x, z)) continue;
      const h = g.height(x, z);
      let up = 0;
      for (let k = 0; k < 8; k++) { const [dx, dz] = dirOf(k * 45); up = Math.max(up, g.height(x + dx * 60, z + dz * 60) - h); }
      if (up < want * 0.6) continue;
      const f = bestFace(g, x, z, { faceSlope: 1, footReach: 30, bearings: 16, maxRun: want * 2.5 });
      if (f.height < want * 0.6) continue;
      // a foot with standable ground in front of it (a sea cliff's foot is the surf): probe 20 m out from the face
      const [ix, iz] = dirOf(f.into);
      const ax = f.foot[0] - ix * 20, az = f.foot[1] - iz * 20;
      const apron = !g.wet(ax, az) && Math.abs(g.height(ax, az) - f.footY) <= 4;
      out.push({ at: [Math.round(x), Math.round(z)], face: R1(f.height), into: f.into, apron });
    }
  out.sort((a, b) => Number(b.apron) - Number(a.apron) || Math.min(b.face, want) - Math.min(a.face, want) || b.face - a.face);
  const kept: typeof out = [];
  for (const c of out) if (kept.every((k) => Math.hypot(k.at[0] - c.at[0], k.at[1] - c.at[1]) > 60)) kept.push(c);
  return kept.slice(0, o.top ?? 24);
}

// ------------------------------------------------------------------ GENERATORS: ground no candidate has

export interface NeedArea {
  inside(x: number, z: number): boolean;
  box: [number, number, number, number];
  /** Prefer spots near this point. */
  near: V2;
}

/** Resolve `near` ([x, z] or "<zone> <side>") into a search area. */
export function needArea(near: GroundNeedDoc["near"], within: number, regions: readonly { id: string; polygon: readonly (readonly number[])[]; within?: string }[]): NeedArea {
  if (Array.isArray(near)) {
    const [nx, nz] = near as [number, number];
    return { near: [nx, nz], box: [nx - within, nz - within, nx + within, nz + within], inside: (x, z) => Math.hypot(x - nx, z - nz) <= within };
  }
  const [zoneId, sideWord = "centre"] = String(near).trim().split(/\s+/);
  const region = regions.find((r) => r.id === zoneId && r.within === undefined) ?? regions.find((r) => r.id === zoneId);
  if (!region) throw new Error(`need near "${near}": no region ${zoneId}`);
  const poly = region.polygon.map((p) => [p[0]!, p[1]!] as V2);
  const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length, cz = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  const inPoly = (x: number, z: number): boolean => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!;
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  const sides: Record<string, number> = { north: 0, n: 0, ne: 45, east: 90, e: 90, se: 135, south: 180, s: 180, sw: 225, west: 270, w: 270, nw: 315 };
  const side = sides[sideWord.toLowerCase()];
  const box: [number, number, number, number] = [Math.min(...poly.map((p) => p[0])), Math.min(...poly.map((p) => p[1])), Math.max(...poly.map((p) => p[0])), Math.max(...poly.map((p) => p[1]))];
  if (side === undefined) return { near: [cx, cz], box, inside: (x, z) => inPoly(x, z) && Math.hypot(x - cx, z - cz) <= within };
  const [sx, sz] = dirOf(side);
  // the side's half of the zone, preferring its far edge: spots whose bearing from the centroid is within 50 deg
  let far = 0;
  for (const p of poly) far = Math.max(far, (p[0] - cx) * sx + (p[1] - cz) * sz);
  const nearPt: V2 = [cx + sx * far * 0.6, cz + sz * far * 0.6];
  return {
    near: nearPt,
    box,
    inside: (x, z) => {
      if (!inPoly(x, z)) return false;
      const dx = x - cx, dz = z - cz, d = Math.hypot(dx, dz);
      return d > 1 && (dx * sx + dz * sz) / d >= Math.cos((50 * Math.PI) / 180) && Math.hypot(x - nearPt[0], z - nearPt[1]) <= within;
    },
  };
}

const smooth = (t: number) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };

/** A masked, raise-only height patch over a box, from a function giving the wanted height (null = leave the ground). */
function patchOver(id: string, box: [number, number, number, number], cell: number, natural: (x: number, z: number) => number, wantY: (x: number, z: number) => number | null): { patch: HeightPatchDoc; raised: number } {
  const columns = Math.min(1025, Math.max(2, Math.round((box[2] - box[0]) / cell) + 1));
  const rows = Math.min(1025, Math.max(2, Math.round((box[3] - box[1]) / cell) + 1));
  const sx = (box[2] - box[0]) / (columns - 1), sz = (box[3] - box[1]) / (rows - 1);
  const heights: number[] = [], weights: number[] = [];
  let raised = 0;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < columns; i++) {
      const x = box[0] + i * sx, z = box[1] + j * sz;
      const nat = natural(x, z);
      const w = wantY(x, z);
      if (w === null || w <= nat + 0.05) { heights.push(Math.round(nat * 100) / 100); weights.push(0); continue; }
      heights.push(Math.round(w * 100) / 100);
      weights.push(1);
      raised = Math.max(raised, w - nat);
    }
  const blend = Math.max(4, Math.min(12, Math.min(box[2] - box[0], box[3] - box[1]) / 2 - 1));
  return {
    patch: { id, origin: [box[0], box[1]], size: [box[2] - box[0], box[3] - box[1]], columns, rows, heights, weights, blend, raiseOnly: true, edgeSlope: 1.5 } as HeightPatchDoc,
    raised,
  };
}

export interface NeedSolve {
  ok: boolean;
  /** Already met on the natural ground: nothing written. */
  existing: boolean;
  at: V2;
  faces: number;
  height: number;
  raised: number;
  patch: HeightPatchDoc | null;
  message: string;
}

/**
 * cliff-face: pick the spot in the area whose natural face is tallest (cheapest uplift; nearer `near` breaks ties),
 * and raise the ground BEHIND its foot into a scarp `minHeight` tall (face at rise/run 1.5, a crest 30 m deep, a back
 * slope of 0.35 to natural ground, the ends tapered over one face height), and fill the `apron` m in front of the foot
 * level with it (raise-only, a 45 deg fill edge), so the plaza the rock-face need measures is there.
 */
export function solveCliffFace(g: NeedGround, need: GroundNeedDoc, area: NeedArea): NeedSolve {
  const H = need.minHeight;
  const step = 24;
  let best: { at: V2; face: number; into: number; score: number } | null = null;
  for (let z = area.box[1]; z <= area.box[3]; z += step)
    for (let x = area.box[0]; x <= area.box[2]; x += step) {
      if (!area.inside(x, z) || g.wet(x, z)) continue;
      // the apron spot itself must be level, dry ground
      const gx = (g.height(x + 6, z) - g.height(x - 6, z)) / 12, gz = (g.height(x, z + 6) - g.height(x, z - 6)) / 12;
      if (Math.hypot(gx, gz) > 0.2) continue;
      const f = bestFace(g, x, z, { faceSlope: 1, footReach: need.apron, bearings: 12, maxRun: H * 2.5 });
      let into = f.into;
      if (f.height < 4) into = bearingOf(gx, gz); // no face: the rock rises uphill
      if (need.faces !== undefined) into = (need.faces + 180) % 360;
      // dry behind (the scarp) and dry in front (the apron and its fill); the apron's natural fall counts against it
      const [dx, dz] = dirOf(into);
      let wet = 0, fall = 0;
      for (let s = -need.apron * 1.5; s <= need.apron + 2 * H; s += 8) if (g.wet(x + dx * s, z + dz * s)) wet++;
      for (const side of [-need.width / 2, 0, need.width / 2]) {
        const qx = x - dz * side, qz = z + dx * side;
        if (g.wet(qx, qz)) wet++;
        fall = Math.max(fall, Math.abs(g.height(qx, qz) - g.height(x, z)), Math.abs(g.height(qx - dx * need.apron, qz - dz * need.apron) - g.height(x, z)));
      }
      if (wet) continue;
      const score = Math.min(f.height, H) - fall - Math.hypot(x - area.near[0], z - area.near[1]) / 50;
      if (!best || score > best.score) best = { at: [x, z], face: f.height, into, score };
    }
  if (!best) return { ok: false, existing: false, at: area.near, faces: 0, height: 0, raised: 0, patch: null, message: "no dry level spot in the area with dry ground behind it" };
  const front = (best.into + 180) % 360;
  if (best.face >= H) {
    // the ground already carries it only when the whole grand-entrance need passes there (apron and read included)
    const check = measureRockFace(g, siteNeedSchema.parse({ kind: "rock-face", minHeight: H, apronM2: need.apron * need.apron, footReach: need.apron }) as Extract<SiteNeed, { kind: "rock-face" }>, best.at[0], best.at[1]);
    if (check.met) return { ok: true, existing: true, at: best.at, faces: front, height: R1(best.face), raised: 0, patch: null, message: `the ground already carries it: ${check.message} at [${best.at.map(Math.round).join(", ")}] — site the place there` };
  }
  const [ix, iz] = dirOf(best.into);
  const px = -iz, pz = ix;
  const footD = need.apron / 2;
  const fx = best.at[0] + ix * footD, fz = best.at[1] + iz * footD;
  // the apron level is the HIGHEST natural ground across it: the patch only fills, so a lower level would leave the
  // apron's high side standing proud of the plaza
  let footY = g.height(fx, fz);
  for (let u = -need.apron; u <= 0; u += 4)
    for (let v = -need.width / 2; v <= need.width / 2; v += 6) footY = Math.max(footY, g.height(fx + ix * u - iz * v, fz + iz * u + ix * v));
  const top = footY + H * 1.05 + 1; // a margin over the asked height: the measure reads the face from where its slope starts
  const run = H / 1.5, crest = 30, back = Math.min(160, H / 0.35), taper = H;
  const half = need.width / 2;
  const wantY = (x: number, z: number): number | null => {
    const u = (x - fx) * ix + (z - fz) * iz, v = Math.abs((x - fx) * px + (z - fz) * pz);
    // the APRON: level at the foot across the face, `apron` m deep, then a 45 deg fill down to natural ground (raise-only:
    // only hollows fill), so the plaza and stair have the flat the rock-face need measures
    if (u < 0) return u < -(need.apron + 45) || v > half + 45 ? null : footY - Math.hypot(Math.max(0, -u - need.apron), Math.max(0, v - half));
    if (u > run + crest + back || v > half + taper) return null;
    let y = u <= run ? footY + (u / run) * (top - footY) : u <= run + crest ? top : top - (u - run - crest) * 0.35;
    if (v > half) y = footY + (y - footY) * (1 - smooth((v - half) / taper));
    return y;
  };
  const span = run + crest + back + 8, wide = half + taper + 8;
  const behind = -(need.apron + 45);
  const corners = [[behind, -wide], [behind, wide], [span, -wide], [span, wide]].map(([u, v]) => [fx + ix * u! + px * v!, fz + iz * u! + pz * v!]);
  const box: [number, number, number, number] = [
    Math.floor(Math.min(...corners.map((c) => c[0]!))), Math.floor(Math.min(...corners.map((c) => c[1]!))),
    Math.ceil(Math.max(...corners.map((c) => c[0]!))), Math.ceil(Math.max(...corners.map((c) => c[1]!))),
  ];
  const { patch, raised } = patchOver(`need-${need.id}`, box, 3, (x, z) => g.height(x, z), wantY);
  return { ok: true, existing: false, at: [Math.round(fx), Math.round(fz)], faces: Math.round(front), height: H, raised: R1(raised), patch, message: `a ${H} m scarp behind [${Math.round(fx)}, ${Math.round(fz)}], front facing ${compassWord(front)}, ${need.width} m wide (lifted at most ${R1(raised)} m)` };
}

/**
 * walled-neck: pick the spot in the area that needs the least lift to stand as a promontory, and raise it: a level
 * pad of `radius` m at the top, flanks falling at rise/run 1.5 to natural ground on every side but one, and the NECK
 * (`neck` m wide) ramping down at 0.15 toward the open/lowest side (or `faces`). The top clears every bearing's
 * natural ground within 30 m of the ring by `flankDrop` (so the flanks protect) and the 60 m band by the wall
 * (so nothing overlooks). A spot needing more than 50 m of lift is refused.
 */
export function solveWalledNeck(g: NeedGround, need: GroundNeedDoc, area: NeedArea): NeedSolve {
  const r = need.radius, R = r + 12;
  const step = 32;
  type Spot = { at: V2; top: number; lift: number; neck: number; score: number };
  let best: Spot | null = null;
  const dflt = siteNeedSchema.parse({ kind: "defensible" }) as Extract<SiteNeed, { kind: "defensible" }>;
  for (let z = area.box[1]; z <= area.box[3]; z += step)
    for (let x = area.box[0]; x <= area.box[2]; x += step) {
      if (!area.inside(x, z) || g.wet(x, z)) continue;
      const pad = padStats(g, x, z, r);
      if (pad.wet > 0) continue;
      let band30 = -Infinity, band60 = -Infinity, lowB = 0, low = Infinity;
      for (let k = 0; k < 24; k++) {
        const b = k * 15;
        const [dx, dz] = dirOf(b);
        for (let s = 0; s <= 60; s += 6) {
          const h = g.height(x + dx * (R + s), z + dz * (R + s));
          if (s <= 30) band30 = Math.max(band30, h);
          band60 = Math.max(band60, h);
        }
        const out = g.height(x + dx * (R + 60), z + dz * (R + 60));
        if (out < low) { low = out; lowB = b; }
      }
      const neckB = need.faces ?? lowB;
      // the top must clear the flanks by flankDrop and the overlook band by the wall (eye vs wall top + parapet)
      const top = Math.max(pad.max + 1, band30 + need.flankDrop, band60 + OVERLOOK_RULE.eye - dflt.wallHeight - dflt.parapet);
      const lift = top - pad.median;
      const score = -lift - Math.hypot(x - area.near[0], z - area.near[1]) / 40;
      if (lift <= 50 && (!best || score > best.score)) best = { at: [x, z], top, lift, neck: neckB, score };
    }
  if (!best) return { ok: false, existing: false, at: area.near, faces: 0, height: 0, raised: 0, patch: null, message: "no dry spot in the area stands within 50 m of lift of a defensible promontory" };
  const already = measureDefensible(g, dflt, best.at[0], best.at[1], r);
  if (already.met) return { ok: true, existing: true, at: best.at, faces: best.neck, height: g.height(best.at[0], best.at[1]), raised: 0, patch: null, message: `the ground already carries it at [${best.at.join(", ")}] (${already.message}) — site the town there` };
  const [cx, cz] = best.at;
  const [nx, nz] = dirOf(best.neck);
  const top = best.top;
  const fallRun = (best.lift + need.flankDrop + 20) / 1.5;
  const rampRun = (best.lift + need.flankDrop + 20) / 0.15;
  const wantY = (x: number, z: number): number | null => {
    const dx = x - cx, dz = z - cz, d = Math.hypot(dx, dz);
    const fall = d <= R ? top : top - (d - R) * 1.5;
    const u = dx * nx + dz * nz, v = Math.abs(-dx * nz + dz * nx);
    const ramp = u > 0 && v <= need.neck / 2 ? (u <= R ? top : top - (u - R) * 0.15) : -Infinity;
    // the neck's own side walls fall like the flanks
    const rampSide = u > R && v > need.neck / 2 ? top - (u - R) * 0.15 - (v - need.neck / 2) * 1.5 : -Infinity;
    const y = Math.max(fall, ramp, rampSide);
    return Number.isFinite(y) ? y : null;
  };
  const ext = R + Math.max(fallRun, Math.min(rampRun, 400)) + 8;
  const box: [number, number, number, number] = [Math.floor(cx - ext), Math.floor(cz - ext), Math.ceil(cx + ext), Math.ceil(cz + ext)];
  const { patch, raised } = patchOver(`need-${need.id}`, box, 4, (x, z) => g.height(x, z), wantY);
  return { ok: true, existing: false, at: [Math.round(cx), Math.round(cz)], faces: Math.round(best.neck), height: R1(top), raised: R1(raised), patch, message: `a promontory pad r${r} at [${Math.round(cx)}, ${Math.round(cz)}] top ${R1(top)} m, neck ${need.neck} m wide facing ${compassWord(best.neck)} (lifted at most ${R1(raised)} m)` };
}

/** How a solved need is re-measured on the ground as it now stands (the `needs` status row). */
export function needStillMet(g: NeedGround, need: GroundNeedDoc): NeedResult | null {
  if (!need.solved) return null;
  const [x, z] = need.solved.at;
  if (need.kind === "cliff-face") {
    // measured from the apron centre in front of the foot
    const [fx, fz] = dirOf(need.solved.faces);
    return measureRockFace(g, siteNeedSchema.parse({ kind: "rock-face", minHeight: need.minHeight * 0.95, apronM2: (need.apron * need.apron) / 2, readDistance: 0, footReach: need.apron }) as Extract<SiteNeed, { kind: "rock-face" }>, x + fx * (need.apron / 2), z + fz * (need.apron / 2));
  }
  return measureDefensible(g, siteNeedSchema.parse({ kind: "defensible", flankDrop: Math.min(need.flankDrop, 8), maxWall: Math.max(260, need.neck * 1.6) }) as Extract<SiteNeed, { kind: "defensible" }>, x, z, need.radius);
}

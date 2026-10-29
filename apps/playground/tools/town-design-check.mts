/**
 * The town design's geometry and its CHECK (pure: the ground comes in as functions, so tests run on a fixture hill).
 *
 * `checkDesign` is what `town-design check` prints and what `worldgen terrace --from-plan` refuses to cut without:
 *   fit       every building inside its terrace by the kit margins (1.5 m off a wall edge, 1 m off a bank), 1 m air
 *             between lots, off the streets and squares
 *   door      every door on its street (ground-envelope front <= 4 m from the street edge, facing it, same level)
 *   reach     every terrace reachable from the gate by stairs/ramps at most 12 % (ramp) / 50 % (stair)
 *   street    every street on designed ground; a level change only through a stair/ramp
 *   cutfill   every terrace within 6 m of the natural ground (cut and fill)
 *   riser     every edge's treatment by the per-riser rule (tools/worldgen-riser-rule.mts); a bank must fit its run
 *   landmark  the landmark's top seen from the gate eye (1.7 m) over the designed ground and the other buildings
 *   square    a square within 30 m of the gate or the harbour
 *   rows      not a town of rows (<= 60 % of the buildings on one bearing)
 *   across    a ramp on a slope over 10 % climbs across it (within 45 deg of the contour)
 * plus kit-fit (MMO/WFC/wfc/kit_fit.py), run by the CLI.
 */
import { riserRule, type RiserVerdict } from "./worldgen-riser-rule.mts";
import { DESIGN_RULE, type DesignBuilding, type DesignTerrace, type EdgeTreatment, type TownDesign } from "./town-design-schema.mts";

export type V2 = [number, number];
type Ext = { left: number; right: number; front: number; back: number };
export type Envelopes = Record<string, { full?: Ext; ground?: Ext; door?: string }>;

export interface DesignSite {
  /** natural ground (the town's own earthworks lifted off) */
  height: (x: number, z: number) => number;
  sea: number;
  /** least-squares downhill direction over the site (unit) */
  downhill?: V2;
  slope?: number;
}

// ---------------------------------------------------------------- geometry

export const r2 = (v: number): number => Math.round(v * 100) / 100;
export function inPoly(poly: readonly (readonly [number, number])[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
export function segDist(x: number, z: number, a: readonly number[], b: readonly number[]): { d: number; t: number; q: V2 } {
  const dx = b[0]! - a[0]!, dz = b[1]! - a[1]!, l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - a[0]!) * dx + (z - a[1]!) * dz) / l2));
  const q: V2 = [a[0]! + dx * t, a[1]! + dz * t];
  return { d: Math.hypot(x - q[0], z - q[1]), t, q };
}
export function lineDist(line: readonly (readonly [number, number])[], x: number, z: number): { d: number; q: V2; s: number } {
  let best = { d: Infinity, q: [line[0]![0], line[0]![1]] as V2, s: 0 };
  let acc = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const r = segDist(x, z, line[i]!, line[i + 1]!);
    const len = Math.hypot(line[i + 1]![0] - line[i]![0], line[i + 1]![1] - line[i]![1]);
    if (r.d < best.d) best = { d: r.d, q: r.q, s: acc + r.t * len };
    acc += len;
  }
  return best;
}
export function lineLength(line: readonly (readonly [number, number])[]): number {
  let s = 0;
  for (let i = 0; i + 1 < line.length; i++) s += Math.hypot(line[i + 1]![0] - line[i]![0], line[i + 1]![1] - line[i]![1]);
  return s;
}
export function densify(line: readonly (readonly [number, number])[], step: number, closed = false): V2[] {
  const pts = closed ? [...line, line[0]!] : line;
  const out: V2[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!, n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let s = 0; s < n; s++) out.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
  }
  if (!closed) out.push([pts[pts.length - 1]![0], pts[pts.length - 1]![1]]);
  return out;
}
export function polyArea(poly: readonly (readonly [number, number])[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j]![0] - poly[i]![0]) * (poly[j]![1] + poly[i]![1]);
  return a / 2;
}
export interface PolyEdge {
  i: number;
  a: V2;
  b: V2;
  len: number;
  dir: V2;
  /** outward unit normal */
  normal: V2;
}
/** Edges in the polygon's own order; normals point OUT whatever the winding. */
export function polyEdges(poly: readonly (readonly [number, number])[]): PolyEdge[] {
  const sign = polyArea(poly) > 0 ? 1 : -1;
  return poly.map((p, i) => {
    const q = poly[(i + 1) % poly.length]!;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const dir: V2 = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
    // polyArea > 0 for a counter-clockwise outline in (x, z): its outside is to the right of each edge
    const normal: V2 = sign > 0 ? [dir[1], -dir[0]] : [-dir[1], dir[0]];
    return { i, a: [p[0], p[1]], b: [q[0], q[1]], len, dir, normal };
  });
}
/** Distance from a point to a polygon's boundary. */
export function polyEdgeDist(poly: readonly (readonly [number, number])[], x: number, z: number): { d: number; edge: number } {
  let best = { d: Infinity, edge: 0 };
  for (let i = 0; i < poly.length; i++) {
    const r = segDist(x, z, poly[i]!, poly[(i + 1) % poly.length]!);
    if (r.d < best.d) best = { d: r.d, edge: i };
  }
  return best;
}
function segsCross(a: V2, b: V2, c: V2, d: V2): boolean {
  const o = (p: V2, q: V2, r: V2) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
export function selfIntersects(poly: readonly V2[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segsCross(poly[i]!, poly[(i + 1) % n]!, poly[j]!, poly[(j + 1) % n]!)) return true;
    }
  return false;
}
/** Separating axis on two convex quads, grown by gap/2 each. */
export function quadsOverlap(p: readonly V2[], q: readonly V2[], gap = 0): boolean {
  const axes = [p, q].flatMap((poly) => [0, 1].map((k) => { const a = poly[k]!, b = poly[k + 1]!; const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l] as V2; }));
  for (const ax of axes) {
    const proj = (poly: readonly V2[]): V2 => { const s = poly.map((c) => c[0] * ax[0] + c[1] * ax[1]); return [Math.min(...s) - gap / 2, Math.max(...s) + gap / 2]; };
    const [a0, a1] = proj(p), [b0, b1] = proj(q);
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}

// ---------------------------------------------------------------- footprints (town-layout's math, exactly)

const DEFAULT_EXT = { full: { left: 0.45, right: 0.45, front: 0.75, back: 0.55 }, ground: { left: 0.4, right: 0.4, front: 0.55, back: 0.55 } };
const PRE_ROT: Record<string, number> = { "-y": 0, "+x": -Math.PI / 2, "+y": Math.PI, "-x": Math.PI / 2 };
function rotExt(e: Ext, door: string): Ext {
  if (door === "+x") return { front: e.right, left: e.front, back: e.left, right: e.back };
  if (door === "-x") return { front: e.left, right: e.front, back: e.right, left: e.back };
  if (door === "+y") return { front: e.back, back: e.front, left: e.right, right: e.left };
  return e;
}
export interface Footprint {
  id: string;
  model: string;
  /** cells after the door-side turn: [along the street, away from it] */
  size: [number, number];
  centre: V2;
  facing: V2;
  yaw: number;
  preRot: number;
  corners: V2[];
  ground: V2[];
  full: V2[];
  /** the middle of the ground envelope's front edge */
  front: V2;
  /** where a visitor stands (town-layout: 2.5 m out from the front steps) */
  door: V2;
  storeys: number;
  features: string[];
}
export function requestOf(design: Pick<TownDesign, "buildings">, b: DesignBuilding): NonNullable<DesignBuilding["request"]> | undefined {
  if (b.request) return b.request;
  return design.buildings.find((q) => q.id === b.model)?.request;
}
export function footprintOf(design: Pick<TownDesign, "buildings">, b: DesignBuilding, envelopes: Envelopes = {}): Footprint {
  const CELL = DESIGN_RULE.cell;
  const model = b.model ?? b.id;
  const req = requestOf(design, b);
  if (!req) throw new Error(`${b.id}: no request (and no model with one)`);
  const raw = envelopes[`bh_${model.replace(/-/g, "_")}`] ?? envelopes[model] ?? DEFAULT_EXT;
  const doorSide = raw.door ?? "-y";
  const ext = { full: rotExt(raw.full ?? DEFAULT_EXT.full, doorSide), ground: rotExt(raw.ground ?? DEFAULT_EXT.ground, doorSide) };
  const [w0, d0] = req.size;
  const [w, d] = doorSide === "+x" || doorSide === "-x" ? [d0, w0] : [w0, d0];
  const W = w * CELL, D = d * CELL;
  const fl = Math.hypot(b.facing[0], b.facing[1]) || 1;
  const facing: V2 = [b.facing[0] / fl, b.facing[1] / fl];
  const right: V2 = [facing[1], -facing[0]];
  const c = b.at;
  const local = (ra: number, fw: number): V2 => [c[0] + right[0] * ra + facing[0] * fw, c[1] + right[1] * ra + facing[1] * fw];
  const rect = (e: Ext | null): V2[] => {
    const x = e ?? { left: 0, right: 0, front: 0, back: 0 };
    return [local(-W / 2 - x.left * CELL, D / 2 + x.front * CELL), local(W / 2 + x.right * CELL, D / 2 + x.front * CELL), local(W / 2 + x.right * CELL, -D / 2 - x.back * CELL), local(-W / 2 - x.left * CELL, -D / 2 - x.back * CELL)];
  };
  return {
    id: b.id,
    model,
    size: [w, d],
    centre: [c[0], c[1]],
    facing,
    yaw: Math.atan2(facing[0], facing[1]),
    preRot: PRE_ROT[doorSide] ?? 0,
    corners: rect(null),
    ground: rect(ext.ground),
    full: rect(ext.full),
    front: local((ext.ground.right - ext.ground.left) * CELL / 2, D / 2 + ext.ground.front * CELL),
    door: local(0, D / 2 + ext.ground.front * CELL + 2.5),
    storeys: req.storeys ?? 2,
    features: req.features ?? [],
  };
}

// ---------------------------------------------------------------- the designed ground

export function terraceAt(design: Pick<TownDesign, "terraces">, x: number, z: number, grow = 0): DesignTerrace | null {
  let best: DesignTerrace | null = null;
  for (const t of design.terraces) {
    if (inPoly(t.polygon, x, z)) {
      if (!best || t.level > best.level) best = t;
    } else if (grow > 0 && polyEdgeDist(t.polygon, x, z).d <= grow && !best) best = t;
  }
  return best;
}
/** The ground the design asks for before the cut: a terrace's level inside it, the natural ground elsewhere. */
export function designedGround(design: Pick<TownDesign, "terraces">, site: Pick<DesignSite, "height">): (x: number, z: number) => number {
  return (x, z) => terraceAt(design, x, z)?.level ?? site.height(x, z);
}

/** Least-squares fall line over a disc (the same fit as worldgen-town-program `fallLine`). */
export function siteFall(height: (x: number, z: number) => number, c: V2, radius: number, step = 4): { downhill: V2; slope: number } {
  let n = 0, sxx = 0, szz = 0, sxz = 0, sxh = 0, szh = 0, sh = 0;
  const pts: [number, number, number][] = [];
  for (let dz = -radius; dz <= radius; dz += step) for (let dx = -radius; dx <= radius; dx += step) if (dx * dx + dz * dz <= radius * radius) pts.push([dx, dz, height(c[0] + dx, c[1] + dz)]);
  for (const [, , h] of pts) sh += h;
  const mh = sh / pts.length;
  for (const [dx, dz, h] of pts) { n++; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; sxh += dx * (h - mh); szh += dz * (h - mh); }
  const det = sxx * szz - sxz * sxz || 1;
  const gx = (sxh * szz - szh * sxz) / det, gz = (szh * sxx - sxh * sxz) / det;
  const slope = Math.hypot(gx, gz);
  return { downhill: slope > 1e-9 ? [-gx / slope, -gz / slope] : [0, 1], slope };
}

// ---------------------------------------------------------------- edges: the riser rule per designed edge

export interface ResolvedEdge {
  terrace: string;
  edge: number;
  a: V2;
  b: V2;
  normal: V2;
  /** level minus the median ground 3 m outside (another terrace's level there, else natural); + = a drop */
  drop: number;
  /** what lies outside: a terrace id, `natural` or `sea` */
  outside: string;
  /** cut = natural ground above the level (a cut face into the hill), drop = a riser down, flush = within 0.5 m */
  kind: "cut" | "drop" | "flush";
  asked: EdgeTreatment;
  /** bank / wall / stepped (cut and flush edges: bank) */
  treatment: "bank" | "wall" | "stepped";
  tiers: number;
  verdict: RiserVerdict | null;
  /** metres of run clear outside before the first blocker (null = clear for the bank's run) */
  clear: number | null;
  blocker: string | null;
  /** the outside is a terrace: the median gap (m) from this edge to it (the wall's foot strip is levelled across it) */
  gap: number | null;
  style?: "masonry-common" | "masonry-stone";
}

export function resolveEdges(design: TownDesign, site: DesignSite, prints: Map<string, Footprint>): ResolvedEdge[] {
  const out: ResolvedEdge[] = [];
  const ground = designedGround(design, site);
  for (const t of design.terraces) {
    for (const e of polyEdges(t.polygon)) {
      const asked = t.edges.find((x) => x.edge === e.i);
      const samples: V2[] = [];
      for (let s = Math.min(1, e.len / 2); s < e.len; s += 2) samples.push([e.a[0] + e.dir[0] * s, e.a[1] + e.dir[1] * s]);
      const outsideH: number[] = [];
      const outsideOf: string[] = [];
      const gaps: number[] = [];
      for (const p of samples) {
        // a LOWER terrace across a gap narrower than the bank the drop to it would need is what this riser holds up
        // (measuring the natural ground in the gap read a 3.6 m riser between two shelves as "flush")
        let other: DesignTerrace | undefined;
        let gap = 0;
        for (let d = 0.25; d <= 3 + DESIGN_RULE.bankRun * DESIGN_RULE.maxCutFill && !other; d += 0.5) {
          const q: V2 = [p[0] + e.normal[0] * d, p[1] + e.normal[1] * d];
          const o = design.terraces.find((x) => x.id !== t.id && inPoly(x.polygon, q[0], q[1]));
          if (o && (d <= 3 || o.level < t.level - 0.3) && d <= Math.max(3, DESIGN_RULE.bankRun * (t.level - o.level) + 1)) { other = o; gap = Math.max(0, d - 0.25); }
          else if (o) break;
        }
        const q: V2 = [p[0] + e.normal[0] * 3, p[1] + e.normal[1] * 3];
        const nat = site.height(q[0], q[1]);
        outsideH.push(other ? other.level : nat);
        outsideOf.push(other ? other.id : nat < site.sea + 0.3 ? "sea" : "natural");
        if (other) gaps.push(gap);
      }
      const sorted = [...outsideH].sort((p, q) => p - q);
      const med = sorted[Math.floor(sorted.length / 2)] ?? site.height(e.a[0], e.a[1]);
      const drop = r2(t.level - med);
      const tally = new Map<string, number>();
      for (const o of outsideOf) tally.set(o, (tally.get(o) ?? 0) + 1);
      const outside = [...tally.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] ?? "natural";
      const kind: ResolvedEdge["kind"] = drop > 0.5 ? "drop" : drop < -0.5 ? "cut" : "flush";
      let verdict: RiserVerdict | null = null;
      let clear: number | null = null;
      let blocker: string | null = null;
      if (kind === "drop") {
        const need = DESIGN_RULE.bankRun * drop;
        // the bank's run, marched out from the edge: the first thing a bank may not run over
        for (const p of samples) {
          for (let d = 0.5; d <= need + 1e-9; d += 0.5) {
            const q: V2 = [p[0] + e.normal[0] * d, p[1] + e.normal[1] * d];
            let hit: string | null = null;
            const other = design.terraces.find((o) => o.id !== t.id && o.level < t.level - 0.3 && inPoly(o.polygon, q[0], q[1]));
            if (other) hit = `terrace ${other.id}`;
            if (!hit) for (const [bid, f] of prints) if (!t.buildings.includes(bid) && inPoly(f.ground, q[0], q[1])) { hit = `lot ${bid}`; break; }
            // a street where it runs through a stair / ramp is that connection, not something the bank buries
            const onConnection = design.connections.some((c) => lineDist(c.points, q[0], q[1]).d <= c.width / 2 + 0.5);
            if (!hit && !onConnection) for (const st of design.streets) { const r = lineDist(st.points, q[0], q[1]); if (r.d < st.width / 2 && Math.abs(ground(r.q[0], r.q[1]) - t.level) > 0.3) { hit = `street ${st.id}`; break; } }
            if (!hit && !other && site.height(q[0], q[1]) < site.sea + 0.3) hit = "the sea";
            if (hit) {
              if (clear === null || d - 0.5 < clear) { clear = d - 0.5; blocker = hit; }
              break;
            }
          }
        }
        // a street or a building within 3 m of the top edge
        let top: string | null = null;
        for (const bid of t.buildings) {
          const f = prints.get(bid);
          if (!f) continue;
          if (Math.min(...densify(f.ground, 1, true).map((p) => segDist(p[0], p[1], e.a, e.b).d)) < 3) { top = `lot ${bid}`; break; }
        }
        if (!top)
          for (const st of design.streets) {
            const near = densify(st.points, 1).filter((p) => inPoly(t.polygon, p[0], p[1]));
            if (near.some((p) => segDist(p[0], p[1], e.a, e.b).d - st.width / 2 < 3)) { top = `street ${st.id}`; break; }
          }
        verdict = riserRule({ id: `${t.id}#${e.i}`, k: e.i, height: drop, need, clear, blocker, top });
      }
      const ruled: ResolvedEdge["treatment"] = verdict ? (verdict.kind === "wall" ? (verdict.tiers > 1 ? "stepped" : "wall") : "bank") : "bank";
      const a = asked?.treatment ?? "auto";
      const treatment = a === "auto" ? ruled : a;
      const tiers = treatment === "stepped" ? Math.max(2, Math.ceil(drop / DESIGN_RULE.tierMax - 1e-9)) : treatment === "wall" ? 1 : 0;
      const gapMed = gaps.length ? [...gaps].sort((p, q) => p - q)[Math.floor(gaps.length / 2)]! : null;
      out.push({ terrace: t.id, edge: e.i, a: e.a, b: e.b, normal: e.normal, drop, outside, kind, asked: a, treatment, tiers, verdict, clear, blocker, gap: outside === "natural" || outside === "sea" ? null : gapMed, style: asked?.style });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the check

export interface DesignReport {
  ok: boolean;
  faults: string[];
  warnings: string[];
  facts: string[];
  edges: ResolvedEdge[];
  prints: Map<string, Footprint>;
  landmark: { visible: boolean; blockedBy: string | null; eye: [number, number, number]; top: [number, number, number]; angle: number } | null;
  reach: Map<string, number>;
}

export function landmarkHeight(f: Footprint, given?: number): number {
  if (given) return given;
  return f.storeys * 3.2 + 4 + (f.features.includes("tower") ? 8 : 0);
}

export function checkDesign(design: TownDesign, site: DesignSite, envelopes: Envelopes = {}): DesignReport {
  const R = DESIGN_RULE;
  const faults: string[] = [];
  const warnings: string[] = [];
  const facts: string[] = [];
  const fault = (rule: string, msg: string) => faults.push(`${rule}: ${msg}`);
  const warn = (rule: string, msg: string) => warnings.push(`${rule}: ${msg}`);
  const at = (p: readonly number[]) => `[${r2(p[0]!)}, ${r2(p[1]!)}]`;
  const terr = new Map(design.terraces.map((t) => [t.id, t]));
  const streets = new Map(design.streets.map((s) => [s.id, s]));
  const prints = new Map<string, Footprint>();
  for (const b of design.buildings) {
    try {
      prints.set(b.id, footprintOf(design, b, envelopes));
    } catch (e) {
      fault("fit", String((e as Error).message));
    }
  }
  const ground = designedGround(design, site);

  // ---- terraces: simple, apart, dry, within the 6 m rule
  for (const t of design.terraces) {
    if (selfIntersects(t.polygon)) fault("terrace", `${t.id}: its polygon crosses itself`);
    if (t.level < site.sea + 1) fault("terrace", `${t.id}: level ${t.level} is under the sea + 1 m (${site.sea + 1})`);
    let cut = 0, fill = 0, cutAt: V2 = t.polygon[0]!, fillAt: V2 = t.polygon[0]!;
    const xs = t.polygon.map((p) => p[0]), zs = t.polygon.map((p) => p[1]);
    let area = 0;
    for (let z = Math.min(...zs) + 1; z < Math.max(...zs); z += 2)
      for (let x = Math.min(...xs) + 1; x < Math.max(...xs); x += 2) {
        if (!inPoly(t.polygon, x, z)) continue;
        area += 4;
        const h = site.height(x, z);
        if (h - t.level > cut) { cut = h - t.level; cutAt = [x, z]; }
        if (t.level - h > fill && !(t.quay && h < site.sea)) { fill = t.level - h; fillAt = [x, z]; }
      }
    if (cut > R.maxCutFill) fault("cutfill", `${t.id}: cuts ${cut.toFixed(1)} m into the hill at ${at(cutAt)} (most ${R.maxCutFill} m: raise it, or split it into two levels)`);
    if (fill > R.maxCutFill) fault("cutfill", `${t.id}: fills ${fill.toFixed(1)} m over the ground at ${at(fillAt)} (most ${R.maxCutFill} m: lower it, pull the edge in, or split it)`);
    for (const id of t.buildings) if (!design.buildings.some((b) => b.id === id)) fault("terrace", `${t.id}: lists building "${id}", which the design does not have`);
    facts.push(`terrace ${t.id}: level ${t.level}, ${Math.round(area)} m2, cut ${cut.toFixed(1)} / fill ${fill.toFixed(1)} m, ${t.buildings.length} building(s)`);
  }
  for (let i = 0; i < design.terraces.length; i++)
    for (let j = i + 1; j < design.terraces.length; j++) {
      const A = design.terraces[i]!, B = design.terraces[j]!;
      const hit = densify(A.polygon, 1, true).find((p) => inPoly(B.polygon, p[0], p[1]) && polyEdgeDist(B.polygon, p[0], p[1]).d > 0.3);
      const hit2 = hit ?? densify(B.polygon, 1, true).find((p) => inPoly(A.polygon, p[0], p[1]) && polyEdgeDist(A.polygon, p[0], p[1]).d > 0.3);
      if (hit2) fault("terrace", `${A.id} and ${B.id} overlap at ${at(hit2)} (terraces may touch along a riser, never overlap)`);
    }
  for (const b of design.buildings) {
    const on = design.terraces.filter((t) => t.buildings.includes(b.id));
    if (on.length !== 1) fault("fit", `${b.id}: listed by ${on.length} terraces (exactly one holds it)`);
  }

  const edges = resolveEdges(design, site, prints);
  const edgeOf = (t: string, i: number) => edges.find((e) => e.terrace === t && e.edge === i)!;

  // ---- risers
  for (const e of edges) {
    const name = `${e.terrace} edge ${e.edge}`;
    if ((e.treatment === "wall" || e.treatment === "stepped") && e.kind !== "drop") fault("riser", `${name}: a ${e.treatment} on an edge that does not drop (${e.drop} m; a retaining wall holds a terrace UP, its foot outside): make it a bank`);
    if (e.kind !== "drop") continue;
    const why = e.verdict?.why ?? "";
    if (e.treatment === "bank" && e.verdict?.kind === "wall") fault("riser", `${name}: asked for a bank, the riser rule says wall — ${why}`);
    if (e.asked !== "auto" && e.treatment !== "bank" && e.verdict?.kind === "bank") warn("riser", `${name}: a ${e.treatment} where the rule says bank (${why}); walls only where a bank cannot do the job`);
    if (e.treatment === "wall") {
      if (e.drop > R.kitHeights[R.kitHeights.length - 1]!) fault("riser", `${name}: a ${e.drop} m wall is over the kit's ${R.kitHeights[R.kitHeights.length - 1]} m: stepped, or a tread terrace`);
      else if (e.drop > R.tierMax + 1e-9) warn("riser", `${name}: one ${e.drop} m wall; the rule plans a drop over ${R.tierMax} m as stepped low walls with ${R.tread} m treads`);
      if (e.outside !== "natural" && e.outside !== "sea" && !R.kitHeights.some((h) => Math.abs(h - e.drop) <= 0.05))
        warn("riser", `${name}: a ${e.drop} m wall between two terraces is not a kit height (${R.kitHeights.join(" / ")}): its foot strip sits up to 0.4 m off ${e.outside}`);
    }
    if (e.treatment === "stepped") {
      const room = (e.tiers - 1) * R.tread + 1;
      if (e.clear !== null && e.clear < room) fault("riser", `${name}: ${e.tiers} tiers need ${room} m of tread outside the edge, ${e.clear.toFixed(1)} m clear before ${e.blocker}`);
    }
    if (e.treatment === "bank" && e.clear !== null && e.clear < R.bankRun * e.drop - 1e-9) fault("riser", `${name}: its ${e.drop} m bank needs ${(R.bankRun * e.drop).toFixed(1)} m of run, ${e.clear.toFixed(1)} m clear before ${e.blocker}`);
  }

  // ---- buildings: fit, air, off streets and squares, door on its street
  const insetOf = (t: DesignTerrace, edge: number) => {
    const e = edgeOf(t.id, edge);
    return e.treatment === "bank" ? R.bankInset : R.wallInset;
  };
  for (const b of design.buildings) {
    const f = prints.get(b.id);
    const t = design.terraces.find((x) => x.buildings.includes(b.id));
    if (!f || !t) continue;
    for (const p of densify(f.ground, 1, true)) {
      if (!inPoly(t.polygon, p[0], p[1])) { fault("fit", `${b.id}: its ground envelope leaves ${t.id} at ${at(p)}`); break; }
      const d = polyEdgeDist(t.polygon, p[0], p[1]);
      const need = insetOf(t, d.edge);
      if (d.d < need - 1e-6) { fault("fit", `${b.id}: ${d.d.toFixed(2)} m from ${t.id} edge ${d.edge} (a ${edgeOf(t.id, d.edge).treatment} keeps lots ${need} m in) at ${at(p)}`); break; }
    }
    for (const s of design.squares) if (densify(f.ground, 1, true).some((p) => inPoly(s.polygon, p[0], p[1]))) fault("fit", `${b.id}: stands in square ${s.id}`);
    for (const st of design.streets) {
      const d = Math.min(...densify(f.ground, 0.5, true).map((p) => lineDist(st.points, p[0], p[1]).d)) - st.width / 2;
      const centreIn = densify(st.points, 0.5).some((p) => inPoly(f.ground, p[0], p[1]));
      if (d < R.streetClear || centreIn) fault("fit", `${b.id}: ${d.toFixed(2)} m off street ${st.id}'s edge (keep ${R.streetClear} m)`);
    }
    const st = streets.get(b.street);
    if (!st) { fault("door", `${b.id}: its street "${b.street}" is not in the design`); continue; }
    const r = lineDist(st.points, f.front[0], f.front[1]);
    const gap = r.d - st.width / 2;
    const to: V2 = [r.q[0] - f.front[0], r.q[1] - f.front[1]];
    const tl = Math.hypot(to[0], to[1]) || 1;
    const faces = (to[0] * f.facing[0] + to[1] * f.facing[1]) / tl;
    if (gap > R.doorReach) fault("door", `${b.id}: its door is ${gap.toFixed(1)} m from street ${st.id} (at most ${R.doorReach} m)`);
    else if (faces < 0.5 && r.d > 1) fault("door", `${b.id}: its front faces away from street ${st.id} (the street is ${(Math.acos(Math.max(-1, Math.min(1, faces))) * 180 / Math.PI).toFixed(0)} deg off its facing)`);
    const lvl = ground(r.q[0], r.q[1]);
    if (Math.abs(lvl - t.level) > 0.3) fault("door", `${b.id}: its street ${st.id} runs at ${r2(lvl)} m in front of the door, the lot stands at ${t.level} m`);
  }
  const list = [...prints.values()];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const p = list[i]!, q = list[j]!;
      if (quadsOverlap(p.ground, q.ground, R.lotAir)) fault("fit", `${p.id} and ${q.id}: ground envelopes under ${R.lotAir} m apart`);
      else if (quadsOverlap(p.full, q.full, 0)) fault("fit", `${p.id} and ${q.id}: roofs / eaves intersect`);
    }

  // ---- connections: ends on their terraces, grades, across the slope
  const levelOf = (idv: string): number | null => (idv === "gate" ? site.height(design.gate.at[0], design.gate.at[1]) : terr.get(idv)?.level ?? null);
  for (const c of design.connections) {
    const lo = levelOf(c.from), hi = levelOf(c.to);
    if (lo === null || hi === null) { fault("reach", `${c.id}: ${lo === null ? c.from : c.to} is not a terrace`); continue; }
    const a = c.points[0]!, b = c.points[c.points.length - 1]!;
    const onT = (idv: string, p: V2) => idv === "gate" ? Math.hypot(p[0] - design.gate.at[0], p[1] - design.gate.at[1]) <= 3 : inPoly(terr.get(idv)!.polygon, p[0], p[1]) || polyEdgeDist(terr.get(idv)!.polygon, p[0], p[1]).d <= 1.5;
    if (!onT(c.from, a)) fault("reach", `${c.id}: its lower end ${at(a)} is not on ${c.from}`);
    if (!onT(c.to, b)) fault("reach", `${c.id}: its upper end ${at(b)} is not on ${c.to}`);
    const rise = hi - lo, run = lineLength(c.points);
    if (rise < -0.05 && c.from !== "gate") fault("reach", `${c.id}: runs DOWN ${(-rise).toFixed(1)} m from ${c.from} to ${c.to} (from = the lower)`);
    const cap = c.kind === "ramp" ? R.rampGrade : R.stairGrade;
    const grade = run > 0 ? Math.abs(rise) / run : Infinity;
    // through a wall edge of `to`: the wall's own insert (fixed kit pieces) carries it
    const through = c.to === "gate" ? null : edges.find((e) => e.terrace === c.to && (e.treatment === "wall" || e.treatment === "stepped") && densify(c.points, 0.5).some((p) => segDist(p[0], p[1], e.a, e.b).d < 1));
    if (through?.treatment === "stepped") fault("reach", `${c.id}: a ${c.kind} through the STEPPED edge ${through.edge} of ${c.to} (its treads have no flight): make that edge a \"wall\" (one kit wall carries the insert) or move the ${c.kind} to a bank`);
    if (through) facts.push(`connection ${c.id}: a ${c.kind} insert in the ${through.treatment} of ${c.to} edge ${through.edge} (${Math.abs(rise).toFixed(1)} m)`);
    else if (grade > cap + 1e-6) fault("reach", `${c.id}: a ${c.kind} at ${(grade * 100).toFixed(0)} % (${Math.abs(rise).toFixed(1)} m in ${run.toFixed(1)} m; most ${cap * 100} %): ${(Math.abs(rise) / cap).toFixed(0)} m of run, or a stair`);
    else facts.push(`connection ${c.id}: ${c.kind} ${c.from} -> ${c.to}, ${rise.toFixed(1)} m in ${run.toFixed(0)} m (${(grade * 100).toFixed(0)} %)`);
    if (!through && c.kind === "ramp" && (site.slope ?? 0) > R.acrossSlope && site.downhill) {
      const d: V2 = [(b[0] - a[0]) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1), (b[1] - a[1]) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1)];
      if (Math.abs(d[0] * site.downhill[0] + d[1] * site.downhill[1]) > Math.SQRT1_2 + 1e-6) warn("across", `${c.id}: the ramp climbs UP the ${(site.slope! * 100).toFixed(0)} % slope; a street climbs across it (within 45 deg of the contour)`);
    }
  }
  // reachability from the gate
  const reach = new Map<string, number>();
  const gateT = terraceAt(design, design.gate.at[0], design.gate.at[1], 2);
  const start = new Set<string>();
  if (gateT) start.add(gateT.id);
  for (const c of design.connections) if (c.from === "gate") start.add(c.to);
  for (const s of design.squares) if (inPoly(s.polygon, design.gate.at[0], design.gate.at[1]) || polyEdgeDist(s.polygon, design.gate.at[0], design.gate.at[1]).d <= 3) start.add(s.terrace);
  if (start.size === 0) fault("reach", `the gate ${at(design.gate.at)} is on no terrace and no connection starts at it ("from": "gate")`);
  const queue = [...start];
  for (const s of start) reach.set(s, 0);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const c of design.connections) {
      const next = c.from === cur ? c.to : c.to === cur ? c.from : null;
      if (!next || next === "gate" || reach.has(next)) continue;
      reach.set(next, reach.get(cur)! + 1);
      queue.push(next);
    }
  }
  for (const t of design.terraces) if (!reach.has(t.id)) fault("reach", `${t.id} is not reachable from the gate by any stair or ramp`);

  // ---- streets: on designed ground; levels change only through connections
  for (const st of design.streets) {
    let prev: { id: string; level: number } | null = null;
    let leftAt: V2 | null = null;
    let len = 0;
    for (const p of densify(st.points, 1)) {
      const t = terraceAt(design, p[0], p[1], 0.5);
      const sq = !t ? design.squares.find((s) => inPoly(s.polygon, p[0], p[1])) : undefined;
      const onConn = design.connections.some((c) => lineDist(c.points, p[0], p[1]).d <= c.width / 2 + 0.5);
      const gateNear = Math.hypot(p[0] - design.gate.at[0], p[1] - design.gate.at[1]) <= 4;
      if (!t && !sq && !onConn && !gateNear) { leftAt ??= p; continue; }
      if (t) {
        len += 1;
        if (prev && prev.id !== t.id && Math.abs(prev.level - t.level) > 0.3 && !onConn) fault("street", `${st.id}: steps ${Math.abs(prev.level - t.level).toFixed(1)} m from ${prev.id} to ${t.id} at ${at(p)} with no stair or ramp`);
        prev = { id: t.id, level: t.level };
      } else if (onConn) prev = null;
    }
    if (leftAt) fault("street", `${st.id}: leaves the designed ground at ${at(leftAt)} (every point on a terrace, a square or a stair/ramp)`);
    facts.push(`street ${st.id} (${st.kind}, ${st.width} m): ${lineLength(st.points).toFixed(0)} m, ${len} m on terraces`);
  }

  // ---- squares
  for (const s of design.squares) {
    const t = terr.get(s.terrace);
    if (!t) { fault("square", `${s.id}: terrace "${s.terrace}" is not in the design`); continue; }
    const out = s.polygon.find((p) => !inPoly(t.polygon, p[0], p[1]) && polyEdgeDist(t.polygon, p[0], p[1]).d > 0.5);
    if (out) fault("square", `${s.id}: corner ${at(out)} is off ${t.id}`);
  }
  const nearSq = (p: V2) => Math.min(Infinity, ...design.squares.map((s) => (inPoly(s.polygon, p[0], p[1]) ? 0 : polyEdgeDist(s.polygon, p[0], p[1]).d)));
  const gateD = nearSq(design.gate.at), harbourD = design.harbour ? nearSq(design.harbour) : Infinity;
  if (Math.min(gateD, harbourD) > R.squareReach) fault("square", `no square within ${R.squareReach} m of the gate${design.harbour ? " or the harbour" : ""} (nearest ${Number.isFinite(gateD) ? gateD.toFixed(0) : "none"} m): a town opens on a square at its gate or its harbour`);

  // ---- rows
  if (list.length >= 5) {
    const bearings = list.map((f) => ((Math.atan2(f.facing[0], f.facing[1]) * 180) / Math.PI + 360) % 360);
    let most = 0, mostAt = 0;
    for (const b0 of bearings) {
      const n = bearings.filter((b) => Math.min(Math.abs(b - b0), 360 - Math.abs(b - b0)) <= R.rowsDeg).length;
      if (n > most) { most = n; mostAt = b0; }
    }
    const share = most / list.length;
    facts.push(`bearings: ${most} of ${list.length} buildings face within ${R.rowsDeg} deg of ${mostAt.toFixed(0)} deg`);
    if (share > R.rowsShare) fault("rows", `${most} of ${list.length} buildings face one way (${mostAt.toFixed(0)} deg +-${R.rowsDeg}): a town of rows on parallel shelves; bend the streets, turn the blocks, open a square`);
  }
  // ---- backs to the slope
  if (site.downhill && (site.slope ?? 0) > 0.05)
    for (const f of list) {
      const up = -(f.facing[0] * site.downhill[0] + f.facing[1] * site.downhill[1]);
      if (up > 0.8) warn("slope", `${f.id}: faces straight up the hill (its back to the drop); buildings face the street with their backs to the slope`);
    }

  // ---- landmark
  let landmark: DesignReport["landmark"] = null;
  const lm = prints.get(design.landmark.building);
  const lmT = design.terraces.find((t) => t.buildings.includes(design.landmark.building));
  if (!lm || !lmT) fault("landmark", `the landmark "${design.landmark.building}" is not a building on a terrace`);
  else {
    const gy = ground(design.gate.at[0], design.gate.at[1]);
    const eye: [number, number, number] = [design.gate.at[0], gy + R.eye, design.gate.at[1]];
    const topY = lmT.level + landmarkHeight(lm, design.landmark.height);
    const top: [number, number, number] = [lm.centre[0], topY, lm.centre[1]];
    const dist = Math.hypot(top[0] - eye[0], top[2] - eye[2]);
    let blockedBy: string | null = null;
    for (let s = 2; s < dist - 1 && !blockedBy; s += 1) {
      const t = s / dist;
      const x = eye[0] + (top[0] - eye[0]) * t, z = eye[2] + (top[2] - eye[2]) * t, y = eye[1] + (top[1] - eye[1]) * t;
      if (inPoly(lm.full, x, z)) break;
      if (ground(x, z) > y - 0.3) blockedBy = `the ground at ${at([x, z])}`;
      for (const f of list) {
        if (f.id === lm.id || !inPoly(f.full, x, z)) continue;
        const ft = design.terraces.find((tt) => tt.buildings.includes(f.id));
        if ((ft?.level ?? ground(x, z)) + f.storeys * 3.2 + 3 > y) { blockedBy = `${f.id}`; break; }
      }
    }
    const inward: V2 = [-design.gate.facing[0], -design.gate.facing[1]];
    const il = Math.hypot(inward[0], inward[1]) || 1;
    const to: V2 = [(top[0] - eye[0]) / (dist || 1), (top[2] - eye[2]) / (dist || 1)];
    const angle = (Math.acos(Math.max(-1, Math.min(1, (inward[0] * to[0] + inward[1] * to[1]) / il))) * 180) / Math.PI;
    landmark = { visible: !blockedBy, blockedBy, eye, top, angle: r2(angle) };
    if (blockedBy) fault("landmark", `${lm.id} (top ${r2(topY)} m) is hidden from the gate by ${blockedBy}`);
    else facts.push(`landmark ${lm.id}: seen from the gate over ${dist.toFixed(0)} m, ${angle.toFixed(0)} deg off the way in`);
    if (angle > 40) warn("landmark", `${lm.id} stands ${angle.toFixed(0)} deg off the way in from the gate: the landmark should close the view (within 40 deg)`);
  }
  const counts = { bank: 0, wall: 0, stepped: 0 };
  for (const e of edges) if (e.kind === "drop") counts[e.treatment]++;
  facts.push(`risers: ${counts.bank} bank(s), ${counts.wall} wall(s), ${counts.stepped} stepped`);
  return { ok: faults.length === 0, faults, warnings, facts, edges, prints, landmark, reach };
}

/** The kit-fit rows (kit_fit.py --json) as check faults. */
export function kitFitFaults(rows: { name: string; status: string; reason?: string; proven?: string[] }[], design: Pick<TownDesign, "buildings">): string[] {
  const out: string[] = [];
  for (const k of rows) {
    if (k.status === "ok") continue;
    const optional = design.buildings.find((b) => b.id === k.name)?.optional;
    out.push(`kit-fit: ${k.name}: ${k.status}${k.reason ? ` (${k.reason})` : ""}${k.proven?.length ? `; proven sizes for this feature set: ${k.proven.join(", ")}` : ""}${optional ? " [optional]" : ""}`);
  }
  return out;
}

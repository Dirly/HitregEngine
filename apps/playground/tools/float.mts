/**
 * FLOAT — does anything hang in the air? One gate for every placed object, measured against the REAL solid.
 *
 *   worldgen float <world> [--project p] [--near x,z,r | --rect x0,z0,x1,z1] [--no-scene] [--no-scatter]
 *                          [--legacy-scatter] [--tol 0.05] [--json] [--out f.json] [--list]
 *   node tools/float.mts scene <project> [--scene <id|file>] [--world <recipe id>] [--near x,z,r] [--json] [--out f]
 *   node tools/float.mts scene <project> ... --fix [--drop-unsupported | --drop-unsupported-rocks] [--inverse f.json]   (writes the scene)
 *   node tools/float.mts undo <project> --inverse f.json [--scene ...]                       (applies an inverse)
 *   The inverse is keyed to the scene build it was written for ({ scene, digest, ops }): after a rebuild the old one is
 *   stale — --fix drops it and re-seats the new build, undo refuses it.
 *
 * Objects: every prefab instance in the scene (props, fires, torches, lanterns, baskets, rocks, structures) with
 * its contact kind from the catalogue (`dressing.contact`, else `defaultSeatContact`), its footprint from its own
 * geometry; and, for a world, every scatter rock (`ScatterDoc.contact` embed) the runtime places in the area.
 * Solid: the voxel field's density (edits, cuts, carves, planar treads, buttes — not the drawn heightfield, which
 * misses cuts: `seated`'s old blind spot) plus every other object's triangles (DC dungeon meshes, decks, stairs,
 * box colliders). One rule decides (`seatObject`, packages/core/src/voxel/seat.ts). A fault is a contact off by
 * more than `--tol` (5 cm): floating, a rock not embedded (under ROCK_EMBED_MIN, 10% of its height, below its lowest ground), a hang not touching, a wall piece off its wall — or
 * no support at all. Exit 1 on any fault. `--fix` re-seats what can be re-seated through applyOps (inverse kept);
 * unsupported objects are listed (and removed only with --drop-unsupported).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  rockSetInstances,
  applyOps,
  ComponentRegistry,
  registerCoreComponents,
  createWorldField,
  defaultSeatContact,
  fieldSolidProbe,
  scatterCell,
  scatterContact,
  scatterEmbed,
  ROCK_EMBED,
  scatterSeatSize,
  seatObject,
  triangleSolidProbe,
  unionSolidProbe,
  worldRecipeSchema,
  type SceneDoc,
  type SeatContact,
  type SeatOptions,
  type SeatResult,
  type SolidProbe,
  type WorldField,
  type WorldRecipe,
} from "@hitreg/core";
import { prefabFile, readJson, sceneGeometry, type SceneEntityGeometry } from "./_prop-geometry.mts";
import { findAsset, PROJECTS } from "./_closure.mjs";
import { applyOpsToSceneFile, removalsOf, updateJsonFile } from "./_scene-write.mts";
import { walkGround } from "./_ground.mts";
import { baseOutline } from "./_place-quality.mts";

export interface FloatRow {
  kind: "scene" | "scatter";
  id: string;
  what: string;
  contact: SeatContact;
  x: number;
  y: number;
  z: number;
  status: SeatResult["status"];
  gap: number;
  support: number;
  reason?: string;
  fix?: { y: number | null; x?: number; z?: number };
}
export interface FloatReport {
  ok: boolean;
  /** = ok; what the dungeon pipeline's stage table reads. */
  passed: boolean;
  target: string;
  area: string;
  tol: number;
  checked: { scene: number; scatter: number; unsized: number; /** founded pieces (`<id>--foundation`) handed to place-build's seated gate */ deferred?: number };
  counts: { off: number; unsupported: number; byKind: Record<string, number>; byContact: Record<string, number> };
  ms: { scene: number; scatter: number; perObjectMs: number };
  rows: FloatRow[];
}

type Area = { near?: [number, number, number]; rect?: [number, number, number, number] };
const inArea = (a: Area, x: number, z: number): boolean =>
  a.near ? Math.hypot(x - a.near[0], z - a.near[1]) <= a.near[2] : a.rect ? x >= a.rect[0] && z >= a.rect[1] && x <= a.rect[2] && z <= a.rect[3] : true;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r2 = (v: number): number => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);

/** Ids a scene check skips: the player, NPCs, creatures, portals — things that move or are not set down — and light
 * shafts (a beam of light hangs in the air by design). */
const SKIP_PREFAB = /^(characters|npcs?|creatures|mobs)\/|^fixtures\/light-shaft$/;

/** Support only: the world's baked landmark prefabs (`landmarks/<opId>-<digest>`, drawn by the voxel world at their
 *  operator's pose and never in the scene doc) — a built deck or plaza holds up what stands on it. The newest bake per op,
 *  placed at the op's `at` / `y` (the bake is already turned and scaled; only the origin is applied); an op without an
 *  explicit `y` is skipped (its foot is solved at bake). */
export const LANDMARK_SUPPORT = "__landmark:";
export function withLandmarkSupport(assets: string, doc: SceneDoc, operators: readonly any[] = [], landmarks: readonly any[] = []): SceneDoc {
  const dir = path.join(assets, "prefabs", "landmarks");
  if (!fs.existsSync(dir)) return doc;
  const newest = new Map<string, { f: string; t: number }>();
  for (const f of fs.readdirSync(dir)) {
    const m = /^(.+)-[0-9a-f]{8}\.json$/.exec(f);
    if (!m) continue;
    const t = fs.statSync(path.join(dir, f)).mtimeMs, cur = newest.get(m[1]!);
    if (!cur || t > cur.t) newest.set(m[1]!, { f, t });
  }
  if (!newest.size) return doc;
  const entities = { ...(doc as any).entities };
  for (const [op, { f }] of newest) {
    const o = operators.find((d) => d?.id === op && d?.op === "landmark");
    if (!o || typeof o.y !== "number" || !Array.isArray(o.at)) continue;
    
    entities[`${LANDMARK_SUPPORT}${op}`] = { name: `landmark ${op}`, parent: null, tags: [], components: { transform: { position: [o.at[0], o.y, o.at[1]] }, prefab: { prefabId: `landmarks/${f.slice(0, -5)}` } } };
  }
  // every OTHER operator that bakes to a recipe landmark (`wall`: a ramp stair's decks and parapets, a quay) stands where
  // the voxel world draws it: the recipe entry's prefab at its position (lanterns on a wall-ramp stair read "nothing above
  // or beside to hang from": the wall-baked stair was never support)
  for (const l of landmarks) {
    const op = /^op:(.+):landmark$/.exec(String(l?.id ?? ""))?.[1] ?? String(l?.id ?? "");
    if (!op || entities[`${LANDMARK_SUPPORT}${op}`] || typeof l?.prefab !== "string" || !Array.isArray(l?.position)) continue;
    if (!fs.existsSync(path.join(assets, "prefabs", `${l.prefab}.json`))) continue;
    entities[`${LANDMARK_SUPPORT}${op}`] = { name: `landmark ${op}`, parent: null, tags: [], components: { transform: { position: [l.position[0], l.position[1], l.position[2]] }, prefab: { prefabId: l.prefab } } };
  }
  return { ...(doc as any), entities } as SceneDoc;
}

/** The catalogue's dressing entry of a prefab (compiled onto its root by `props sync`), or undefined. */
function dressingOf(assets: string, prefabId: string): { contact?: SeatContact; mount?: string; category?: string } | undefined {
  try {
    const doc = readJson(prefabFile(assets, prefabId));
    const ents = doc.entities ?? {};
    const root = doc.root ?? Object.keys(ents).find((k) => ents[k].parent == null);
    return root ? ents[root]?.components?.dressing : undefined;
  } catch {
    return undefined;
  }
}

/** A generated chain link of a hanging prop (`<placement>--chain-<n>` / `.../chain-<n>: ...`, dress.mts). */
const CHAIN_LINK = /(--|\/)chain-\d+(:|$)/;

/** How far back from each end of a taut span its hold is looked for: a chain end threads its ring / sinks into its block. */
export const TAUT_END_M = 2.5;
/**
 * The two ends of a TAUT span (a long chain run between two anchored pieces) and whether each is held. The axis is the
 * span's farthest vertex pair (any slope, not only a plan axis); each end is the CENTRE of the vertices within 0.3 m of
 * the extreme along it (never one edge vertex, which hangs off the link's side). An end is held when a point of its last
 * TAUT_END_M along the axis touches solid (inside it, a top within 0.6 m, or a wall within 0.6 m across the axis: the
 * ring it threads, the block it sinks into) or lies inside another span's bounds (the next span of the run, 0.3 m slack).
 */
export function tautSpanEnds(w: ArrayLike<number>, probe: SolidProbe, others: ArrayLike<number>[]): { at: [number, number, number]; held: boolean }[] {
  const n = w.length / 3, P = (k: number): [number, number, number] => [w[3 * k]!, w[3 * k + 1]!, w[3 * k + 2]!];
  if (n < 2) return [];
  const c = [0, 0, 0]; for (let k = 0; k < n; k++) for (let a = 0; a < 3; a++) c[a]! += w[3 * k + a]! / n;
  const far = (from: number[]) => { let best = 0, bd = -1; for (let k = 0; k < n; k++) { const p = P(k), d = (p[0] - from[0]!) ** 2 + (p[1] - from[1]!) ** 2 + (p[2] - from[2]!) ** 2; if (d > bd) { bd = d; best = k; } } return P(best); };
  const A = far(c), B = far(A), len = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]) || 1, u = [(B[0] - A[0]) / len, (B[1] - A[1]) / len, (B[2] - A[2]) / len];
  let lo = Infinity, hi = -Infinity; const t = new Float64Array(n);
  for (let k = 0; k < n; k++) { const p = P(k); t[k] = (p[0] - c[0]!) * u[0]! + (p[1] - c[1]!) * u[1]! + (p[2] - c[2]!) * u[2]!; lo = Math.min(lo, t[k]!); hi = Math.max(hi, t[k]!); }
  const centre = (edge: number): [number, number, number] => { const s = [0, 0, 0]; let m = 0; for (let k = 0; k < n; k++) if (Math.abs(t[k]! - edge) <= 0.3) { const p = P(k); s[0]! += p[0]; s[1]! += p[1]; s[2]! += p[2]; m++; } return [s[0]! / m, s[1]! / m, s[2]! / m]; };
  const bounds = others.map((v) => { const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; for (let q = 0; q < v.length; q += 3) for (let a = 0; a < 3; a++) { b[a] = Math.min(b[a]!, v[q + a]!); b[a + 3] = Math.max(b[a + 3]!, v[q + a]!); } return b; });
  const inSpan = (p: number[]) => bounds.some((b) => p.every((v, a) => v >= b[a]! - 0.3 && v <= b[a + 3]! + 0.3));
  const h = Math.hypot(u[0]!, u[2]!), across = h > 1e-6 ? [[-u[2]! / h, u[0]! / h], [u[2]! / h, -u[0]! / h]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const touches = (p: number[]) => probe.floor(p[0]!, p[2]!, p[1]! + 0.6, p[1]! - 0.6) !== null || across.some(([dx, dz]) => { const d = probe.wall?.(p[0]!, p[1]!, p[2]!, dx!, dz!, 0.6); return d !== null && d !== undefined; });
  return [[lo, 1], [hi, -1]].map(([edge, inward]) => {
    const at = centre(edge!);
    let held = inSpan(at);
    for (let s = 0; !held && s <= TAUT_END_M + 1e-9; s += 0.25) { const p = [at[0] + u[0]! * inward! * s, at[1] + u[1]! * inward! * s, at[2] + u[2]! * inward! * s]; held = touches(p); }
    return { at, held };
  });
}

/**
 * The contact a scene object is measured by. A HANGING piece is checked for its hook, never for ground contact: a
 * prop whose dressing mount is `ceiling` (or `hang`), and every link of a hanging prop's chain (the prefab a ceiling
 * prop names as its `chain`, mount `part`; or an entity the dresser named `.../chain-<n>`) — chandelier chain links
 * read "floating 0.06 m" when floor-tested.
 */
export function contactOf(dressing: { contact?: SeatContact; mount?: string; category?: string } | undefined, prefabId: string, entityId = "", entityName = "", chains: ReadonlySet<string> = new Set()): SeatContact {
  if (dressing?.contact) return dressing.contact;
  if (dressing?.mount === "ceiling" || dressing?.mount === "hang") return "hang";
  if (chains.has(prefabId) || CHAIN_LINK.test(entityId) || CHAIN_LINK.test(entityName)) return "hang";
  return defaultSeatContact(dressing, prefabId);
}

/**
 * Footprint of an object from its root-frame bounds and world matrix (a yawed object). A TILTED one (its up axis off
 * vertical: a book laid on its side, a toppled barrel) is measured by its world bounds instead: its base is its lowest
 * point, not the root frame's bottom (a ledger laid flat was seated by its spine's mid-line, half its thickness and the
 * sink down into the desk).
 */
function footprintOf(g: SceneEntityGeometry): { x: number; y: number; z: number; halfX: number; halfZ: number; yaw: number; height: number } {
  const m = g.m;
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!), sy = Math.hypot(m[4]!, m[5]!, m[6]!), sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  if (sy > 0 && m[5]! / sy < 0.98 && g.world.length >= 9) {
    // a LEANED piece: its footprint is its mesh's box in its own HEADING (the horizontal of its x axis, else of its z
    // axis), never the world-axis box (Rustgut 2026-11-10: 6 m log curbs laid along a ramp at a diagonal heading read a
    // 4.7 x 4.7 m world box whose corners hung over the trench beside the ramp: "a foot over nothing")
    const hx = Math.hypot(m[0]!, m[2]!), yaw = hx > 0.2 * sx ? Math.atan2(-m[2]!, m[0]!) : Math.atan2(m[8]!, m[10]!);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k + 2 < g.world.length; k += 3) {
      const x = g.world[k]!, y = g.world[k + 1]!, z = g.world[k + 2]!, a = x * c - z * s, b = x * s + z * c;
      if (a < a0) a0 = a; if (a > a1) a1 = a; if (b < b0) b0 = b; if (b > b1) b1 = b; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const am = (a0 + a1) / 2, bm = (b0 + b1) / 2;
    return { x: am * c + bm * s, y: y0, z: -am * s + bm * c, halfX: (a1 - a0) / 2, halfZ: (b1 - b0) / 2, yaw, height: y1 - y0 };
  }
  const cx = (g.min[0] + g.max[0]) / 2, cz = (g.min[2] + g.max[2]) / 2, by = g.min[1];
  return {
    x: m[0]! * cx + m[4]! * by + m[8]! * cz + m[12]!,
    y: m[1]! * cx + m[5]! * by + m[9]! * cz + m[13]!,
    z: m[2]! * cx + m[6]! * by + m[10]! * cz + m[14]!,
    halfX: ((g.max[0] - g.min[0]) / 2) * sx,
    halfZ: ((g.max[2] - g.min[2]) / 2) * sz,
    yaw: Math.atan2(-m[2]!, m[0]!),
    height: (g.max[1] - g.min[1]) * sy,
  };
}

/**
 * Heights above `baseY` of the object's own up-facing level faces in its lowest `reach` metres (a box's inner floor, a
 * barrel's bottom), not its top: what a `base` seat keeps off the floor's plane (seat.ts `flats`; the zfight gate).
 * A face counts from 0.002 m² (a 1 mm height band summed), so a sliver never moves a prop.
 */
export function flatsOf(world: ArrayLike<number>, baseY: number, height: number, reach = 0.1): number[] {
  const bands = new Map<number, number>();
  for (let k = 0; k + 8 < world.length; k += 9) {
    const ux = world[k + 3]! - world[k]!, uy = world[k + 4]! - world[k + 1]!, uz = world[k + 5]! - world[k + 2]!;
    const vx = world[k + 6]! - world[k]!, vy = world[k + 7]! - world[k + 1]!, vz = world[k + 8]! - world[k + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
    if (!(l > 0) || ny / l < 0.99) continue;
    const h = (world[k + 1]! + world[k + 4]! + world[k + 7]!) / 3 - baseY;
    if (h <= 0.002 || h > reach || h >= height - 0.005) continue;
    const b = Math.round(h * 1000);
    bands.set(b, (bands.get(b) ?? 0) + l / 2);
  }
  return [...bands].filter(([, a]) => a >= 0.002).map(([b]) => b / 1000);
}

/** The object's own lowest point in the world column at (x, z) from its world triangles; null where none of it is there. */
export function undersideOf(world: ArrayLike<number>): (x: number, z: number) => number | null {
  return (qx, qz) => {
    let low: number | null = null;
    for (let k = 0; k + 8 < world.length; k += 9) {
      const ax = world[k]!, az = world[k + 2]!, bx = world[k + 3]!, bz = world[k + 5]!, cx = world[k + 6]!, cz = world[k + 8]!;
      const d = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
      if (Math.abs(d) < 1e-12) continue;
      const u = ((bx - qx) * (cz - qz) - (cx - qx) * (bz - qz)) / d, v = ((cx - qx) * (az - qz) - (ax - qx) * (cz - qz)) / d, w = 1 - u - v;
      if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
      const y = u * world[k + 1]! + v * world[k + 4]! + w * world[k + 7]!;
      if (low === null || y < low) low = y;
    }
    return low;
  };
}

/**
 * BURIED (Wristgate 2026-10-29: a haul sledge and a chain coil stood INSIDE the raised terrace and both `dress` and
 * `float` passed them — the seat found the cut ground under the built block). A set-down prop (contact base / legs) is
 * buried when, at most of its inner footprint samples (centre + the 45% ring), it is INSIDE closed built mass (an odd
 * number of built-surface crossings above its lower body line) or a solid surface (built or the voxel field) crosses its body
 * between `base + max(0.3 m, 15 % of its height)` and 90 % of its height. `built` = the landmark bakes only (closed
 * meshes). Returns the reason, or null when it stands clear.
 */
export function buriedReason(built: { crossings(x: number, z: number, above: number): number[] } | null, field: SolidProbe | null, fp: { x: number; z: number; y: number; halfX: number; halfZ: number; yaw?: number; height: number }, under?: (x: number, z: number) => number | null): string | null {
  const c = Math.cos(fp.yaw ?? 0), s = Math.sin(fp.yaw ?? 0);
  const w = (lx: number, lz: number): [number, number] => [fp.x + lx * c + lz * s, fp.z - lx * s + lz * c];
  const hx = fp.halfX * 0.45, hz = fp.halfZ * 0.45;
  const pts: [number, number][] = [[fp.x, fp.z], w(-hx, -hz), w(hx, -hz), w(hx, hz), w(-hx, hz)];
  // L (o-wild3 2026-11-02: a 0.33 m bone pile and a 0.59 m bone heap sat 69-70 % under flat ground and passed): under 0.6 m
  // tall the body line was 0.3 m up, at or over 90 % of the piece, so nothing short was ever read. It is at most HALF the
  // piece's height: a short prop with the ground over its middle is buried too
  const lo0 = fp.y + Math.min(Math.max(0.3, fp.height * 0.15), fp.height * 0.5), hi = fp.y + fp.height * 0.9;
  let inside = 0, through = 0;
  for (const [x, z] of pts) {
    // L (o-coast2 ant-picked-wreck 2026-10-31: a hull LEANED to lie along a 20 deg beach read "buried" because its tilted box
    // holds the slope): a leaned piece passes its own underside (`under`), and each sample's body line starts from the mesh above it
    const u = under?.(x, z), lo = u == null ? lo0 : Math.max(lo0, u + Math.max(0.3, fp.height * 0.15));
    if (lo >= hi) continue;
    // sunk less than the lower body line is seating, not burial: parity is read from that line up
    const above = built ? built.crossings(x, z, lo) : [];
    if (above.length % 2 === 1) inside++;
    else if (above.some((h) => h <= hi) || (hi > lo && field && field.floor(x, z, hi, lo) !== null)) through++;
  }
  const need = Math.ceil(pts.length / 2);
  if (inside >= need) return `buried: inside built mass at ${inside}/${pts.length} footprint samples (base ${r2(fp.y)})`;
  if (inside + through >= need) return `buried: a solid surface crosses its body (${r2(lo0)}..${r2(hi)}) at ${inside + through}/${pts.length} samples`;
  return null;
}

/** The body the buried test reads: from the seat, or from the foot of a declared catalogue FOOTING (metres, scaled) up. Pure. */
export function bodyAboveFooting<T extends { y: number; height: number }>(fp: T, seatY: number, footing: number): T {
  return footing > 0 && fp.height - footing > 0.3 ? { ...fp, y: seatY + footing, height: fp.height - footing } : { ...fp, y: seatY };
}
/** Vertical crossings of a triangle soup above a height, bucketed on a 1 m plan grid. */
export function crossingColumns(tris: ArrayLike<number>): { crossings(x: number, z: number, above: number): number[] } {
  const buckets = new Map<string, number[]>();
  for (let t = 0; t + 8 < tris.length; t += 9) {
    const x0 = Math.min(tris[t]!, tris[t + 3]!, tris[t + 6]!), x1 = Math.max(tris[t]!, tris[t + 3]!, tris[t + 6]!);
    const z0 = Math.min(tris[t + 2]!, tris[t + 5]!, tris[t + 8]!), z1 = Math.max(tris[t + 2]!, tris[t + 5]!, tris[t + 8]!);
    for (let i = Math.floor(x0); i <= Math.floor(x1); i++)
      for (let k = Math.floor(z0); k <= Math.floor(z1); k++) { const key = `${i},${k}`; const b = buckets.get(key); if (b) b.push(t); else buckets.set(key, [t]); }
  }
  return {
    crossings(x, z, above) {
      const out: number[] = [];
      for (const t of buckets.get(`${Math.floor(x)},${Math.floor(z)}`) ?? []) {
        const ax = tris[t]!, az = tris[t + 2]!, bx = tris[t + 3]!, bz = tris[t + 5]!, cx = tris[t + 6]!, cz = tris[t + 8]!;
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(d) < 1e-12) continue;
        const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, ww = 1 - u - v;
        if (u < -1e-9 || v < -1e-9 || ww < -1e-9) continue;
        const y = u * tris[t + 1]! + v * tris[t + 4]! + ww * tris[t + 7]!;
        if (y > above) out.push(y);
      }
      // a column through a shared edge or vertex meets the same crossing twice: merge crossings under 1 mm apart
      out.sort((a, b) => a - b);
      return out.filter((y, i) => i === 0 || y - out[i - 1]! > 1e-3);
    },
  };
}

/** The lowest ground under a footprint (its centre and 8 rim points at 0.9 of the half extents), or null off the world. */
/** A boat afloat (tags `slot:boat` + `wet`) whose hull crosses sea level: base below the sea, top above it. */
export function afloat(tags: readonly string[], fp: { y: number; height: number }, seaLevel: number): boolean {
  return tags.includes("slot:boat") && tags.includes("wet") && fp.y < seaLevel && fp.y + fp.height > seaLevel;
}

export function beddedGround(field: Pick<WorldField, "height">, fp: { x: number; z: number; halfX: number; halfZ: number; yaw: number }): number | null {
  const c = Math.cos(fp.yaw), s = Math.sin(fp.yaw); let lo = Infinity;
  for (const [a, b] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    const lx = a * fp.halfX * 0.9, lz = b * fp.halfZ * 0.9, h = field.height(fp.x + lx * c + lz * s, fp.z - lx * s + lz * c);
    if (Number.isFinite(h)) lo = Math.min(lo, h);
  }
  return Number.isFinite(lo) ? lo : null;
}

/** Seat every prefab instance of a scene. `field` adds the voxel world's solid under it. */
export function floatScene(assets: string, doc: SceneDoc, field: WorldField | null, area: Area, tol: number, only?: ReadonlySet<string>, seatOpts: SeatOptions = {}): { rows: FloatRow[]; checked: number; unsized: number; ms: number; deferred: string[]; unsizedIds: string[] } {
  const t0 = performance.now();
  // only what can hold up an object in the area: geometry whose world points come within 30 m of it
  const box = area.near ? [area.near[0] - area.near[2] - 30, area.near[1] - area.near[2] - 30, area.near[0] + area.near[2] + 30, area.near[1] + area.near[2] + 30] : area.rect ? [area.rect[0] - 30, area.rect[1] - 30, area.rect[2] + 30, area.rect[3] + 30] : null;
  const geo = sceneGeometry(assets, (field ? withLandmarkSupport(assets, doc, (field as any).recipe?.features?.operators ?? [], (field as any).recipe?.features?.landmarks ?? []) : doc) as never).filter((g) => {
    if (!box) return true;
    for (let k = 0; k < g.world.length; k += 3) if (g.world[k]! >= box[0]! && g.world[k]! <= box[2]! && g.world[k + 2]! >= box[1]! && g.world[k + 2]! <= box[3]!) return true;
    return false;
  });
  const owners: number[] = [];
  const soup: number[] = [];
  geo.forEach((g, i) => {
    for (let k = 0; k < g.world.length; k += 9) owners.push(i);
    for (const v of g.world) soup.push(v);
  });
  const tris = triangleSolidProbe(soup, 1, owners);
  // the built mass alone (landmark bakes: closed meshes) for the buried test
  const builtSoup: number[] = [];
  for (const g of geo) if (g.id.startsWith(LANDMARK_SUPPORT)) for (const v of g.world) builtSoup.push(v);
  const built = builtSoup.length ? crossingColumns(builtSoup) : null;
  const fieldProbe = field ? fieldSolidProbe(field) : null;
  const rows: FloatRow[] = [];
  let checked = 0, unsized = 0;
  // L (t-ground 2026-10-31, NO SILENT SKIPS): what the scene check hands to another gate, or cannot measure, is listed by id
  const deferred: string[] = [], unsizedIds: string[] = [];
  const contactCache = new Map<string, SeatContact>();
  const dressCache = new Map<string, ReturnType<typeof dressingOf>>();
  const dressing = (id: string): ReturnType<typeof dressingOf> => { if (!dressCache.has(id)) dressCache.set(id, dressingOf(assets, id)); return dressCache.get(id); };
  // the chain prefabs the scene's hanging props hang by: their links are hangs too
  const chains = new Set<string>();
  for (const g of geo) if (g.prefabId) { const c = (dressing(g.prefabId) as { chain?: string } | undefined)?.chain; if (c) chains.add(c); }
  geo.forEach((g, i) => {
    if (!g.prefabId || SKIP_PREFAB.test(g.prefabId) || g.id.startsWith(LANDMARK_SUPPORT) || (only && !only.has(g.id))) return;
    // a piece the PLACEMENT SOLVER founded (`<id>--foundation`, t-place 2026-10-30) stands on its skirt: the seated gate
    // measures it along its whole base outline with that skirt; its own mesh bottom is not its contact
    const fp = footprintOf(g);
    if (!inArea(area, fp.x, fp.z)) return;
    if ((doc as { entities?: Record<string, unknown> }).entities?.[`${g.id}--foundation`]) { deferred.push(g.id); return; }
    // L (o-sunwine3 2026-10-31): a WET piece HELD at its layout `y` (tags held + wet: a pier deck run, a T-head, a jetty on its own
    // driven posts) has its post feet in the bed by design; the seated gate judges its base outline against the bed (a foot above it fails)
    { const tg = ((doc as { entities?: Record<string, any> }).entities?.[g.id]?.tags ?? []) as string[]; if (tg.includes("held") && tg.includes("wet") && !tg.includes("slot:boat")) { deferred.push(g.id); return; } }
    // a FLAT piece (a decal, a mat: no height) is judged as a 2 cm slab; a piece with no footprint at all cannot be judged: a fault
    if (fp.halfX > 0 && fp.halfZ > 0 && !(fp.height > 0.01) && Number.isFinite(fp.y)) fp.height = 0.02;
    if (!(fp.height > 0.01) || !(fp.halfX > 0) || !(fp.halfZ > 0)) { unsized++; unsizedIds.push(`${g.id} (${g.prefabId})`); rows.push({ kind: "scene", id: g.id, what: g.prefabId, contact: "base", x: r3(fp.x), y: r3(fp.y), z: r3(fp.z), status: "off", gap: Infinity, support: null as never, reason: "no geometry to measure (no triangles or no footprint): not measured, so not passed", fix: { y: null } }); return; }
    let contact: SeatContact | undefined = CHAIN_LINK.test(g.id) || CHAIN_LINK.test(g.name ?? "") ? "hang" : contactCache.get(g.prefabId);
    if (!contact) contactCache.set(g.prefabId, (contact = contactOf(dressing(g.prefabId), g.prefabId, "", "", chains)));
    const own = tris.excluding(i);
    const probe: SolidProbe = fieldProbe ? unionSolidProbe(fieldProbe, own) : own;
    // L (Wristgate 2026-10-29): a TAUT chain span (a "--chain-<n>" link longer than 6 m: the fist's chains run 14 m spans
    // from a wrist lug to an anchor eye) hangs from neither end alone; it is held when BOTH ends of its long axis are held
    // (tautSpanEnds: the end CENTRE on the 3D axis, its last 2.5 m threading a ring / sunk into a block, or the next span)
    if (contact === "hang" && Math.max(fp.halfX, fp.halfZ, fp.height / 2) * 2 > 6) {
      const others = geo.filter((o, j) => j !== i && CHAIN_LINK.test(o.id)).map((o) => o.world as ArrayLike<number>);
      const ends = tautSpanEnds(g.world as ArrayLike<number>, probe, others);
      checked++;
      if (ends.every((e) => e.held)) return;
      const miss = ends.filter((e) => !e.held).map((e) => `[${e.at.map((v) => r2(v)).join(", ")}]`);
      rows.push({ kind: "scene", id: g.id, what: g.prefabId, contact, x: r3(fp.x), y: r3(fp.y), z: r3(fp.z), status: "unsupported", gap: Infinity, support: null as never, reason: `taut span: ${miss.length === 2 ? "neither end" : "an end"} (${miss.join(" ")}) runs into no solid or next span in its last ${TAUT_END_M} m`, fix: { y: fp.y } } as never);
      return;
    }
    // a structure (anything over 4 m across) is seated by its base like a building: the probe reaches further down
    const big = Math.max(fp.halfX, fp.halfZ) > 2;
    // a seated figure rests where its own underside touches (hips on the seat, feet on a step)
    // a base keeps its own low faces (inner floor, barrel bottom) off the floor's plane: flats
    const r = seatObject(probe, contact === "seated" ? { ...fp, underside: undersideOf(g.world) } : contact === "base" ? { ...fp, flats: flatsOf(g.world, fp.y, fp.height) } : fp, contact, { tol, reachDown: big ? 8 : 4, ...seatOpts });
    checked++;
    // L (o-coast sunwine-hold 2026-10-31, coordinator ruling): a BOAT afloat (a layout piece of role boat marked `wet`:
    // tags slot:boat + wet) whose hull crosses sea level (its base below the sea, its top above) rides the water: floating,
    // never "unsupported" or "off". A boat wholly under the sea or wholly above it is still judged.
    if (r.status !== "ok" && afloat(((doc.entities as Record<string, any>)[g.id]?.tags ?? []) as string[], fp, Number((field?.recipe as { seaLevel?: number } | undefined)?.seaLevel ?? 0))) return;
    // L (o-gates 2026-10-30, coordinator): a layout piece BEDDED on purpose (tag `bedded`: backing rock sunk into a cliff
    // face, a ruin cut into a slope) is held when its base is BELOW the ground under it (sunk, never hovering): its mesh
    // bottom at or under the lowest ground of its footprint. Its sides in the rock are the point, not a fault.
    if (((doc.entities as Record<string, any>)[g.id]?.tags ?? []).includes("bedded") && fieldProbe) {
      const lowGround = beddedGround(field!, fp);
      // L (f-ground 2026-10-31, Weeping Sun back-b8 0.07 m over a dip only the seated gate saw): ALSO its base OUTLINE (the
      // seated gate's rule: _place-quality baseOutline of its world triangles) at or under the WALKED ground (tools/_ground.mts)
      // at every outline point; a fix sinks it by the larger shortfall, never more
      // (relative to the piece's origin, as the seated gate cuts it: its band is read under the origin)
      // and in its UNSCALED size, the seated gate's outline being cut on the prefab before its scale)
      const walk = walkGround(field!), tri: Parameters<typeof baseOutline>[0] = [], o = [g.m[12]!, g.m[13]!, g.m[14]!], ks = Math.hypot(g.m[0]!, g.m[1]!, g.m[2]!) || 1;
      const v = (k: number): number[] => [(g.world[k]! - o[0]!) / ks, (g.world[k + 1]! - o[1]!) / ks, (g.world[k + 2]! - o[2]!) / ks];
      for (let k = 0; k + 8 < g.world.length; k += 9) tri.push({ a: v(k), b: v(k + 3), c: v(k + 6) });
      let rim = -Infinity; for (const [x, z, y] of baseOutline(tri)?.perimeter ?? []) rim = Math.max(rim, y * ks + o[1]! - walk(x * ks + o[0]!, z * ks + o[2]!));
      // a bedded rim is IN the ground (<= 0): this outline is cut on world cells, the seated gate's on the piece's own, so
      // a rim "within tolerance" here can read a few cm over it there
      const short = Math.max(lowGround === null ? 0 : fp.y - lowGround, rim);
      if (lowGround !== null && fp.y - lowGround <= tol && rim <= 0) return;
      rows.push({ kind: "scene", id: g.id, what: g.prefabId, contact, x: r3(fp.x), y: r3(fp.y), z: r3(fp.z), status: "off", gap: lowGround === null ? Infinity : r2(short), support: null as never, reason: `bedded piece hovers: its base ${r2(fp.y)} m is above the lowest ground under it (${lowGround === null ? "none" : r2(lowGround)} m) or its rim stands ${r2(rim)} m over the walked ground`, fix: { y: lowGround === null ? null : fp.y - short - 0.02 } });
      return;
    }
    if (r.status === "ok") {
      if (contact !== "base" && contact !== "legs") return;
      // L (o-small 2026-10-29): a piece placed INTO a face on purpose (layout `sink`, tag `set-in`: an opened niche whose back
      // is in the rock) has its front seated on the flat; the rock through its back is the point, not a burial
      if (((doc.entities as Record<string, any>)[g.id]?.tags ?? []).includes("set-in")) return;
      // L (Red Dial 2026-10-30, o-city3): a kit piece's declared FOOTING (catalogue dressing.footing: a ruin house's 3.2 m
      // footing, a wall's 0.6 m) is meant to be in the ground: the body is read from its foot (the origin), never from the
      // footing's bottom (49 city walls, houses and yards read "buried" by the ground round their own footings)
      const foot = (Number((dressing(g.prefabId) as { footing?: number } | undefined)?.footing) || 0) * Math.hypot(g.m[4]!, g.m[5]!, g.m[6]!);
      const leaned = (((doc.entities as Record<string, any>)[g.id]?.tags ?? []) as string[]).some((t) => t.startsWith("lean:"));
      const why = buriedReason(built, fieldProbe, bodyAboveFooting(fp, r.y ?? fp.y, foot), leaned ? undersideOf(g.world) : undefined);
      if (!why) return;
      rows.push({ kind: "scene", id: g.id, what: g.prefabId, contact, x: r3(fp.x), y: r3(fp.y), z: r3(fp.z), status: "off", gap: Infinity, support: null as never, reason: `${why}: move it in its plan (never re-seat)`, fix: { y: null } });
      return;
    }
    rows.push({
      kind: "scene", id: g.id, what: g.prefabId, contact, x: r3(fp.x), y: r3(fp.y), z: r3(fp.z), status: r.status, gap: r2(r.gap), support: r.support,
      ...(r.reason ? { reason: r.reason } : {}),
      fix: { y: r.y, ...(r.x !== undefined ? { x: r.x, z: r.z } : {}) },
    });
  });
  // a placed prefab that produced NO geometry at all (its prefab missing, empty, or every mesh unresolved) never reached the
  // loop above: it is a fault by id, never a silent gap in the count (t-ground 2026-10-31)
  const seen = new Set(geo.map((g) => g.id)), ents = (doc as { entities?: Record<string, any> }).entities ?? {};
  const approx = (id: string): [number, number] => { let x = 0, z = 0; for (let e = ents[id], n = 0; e && n < 32; e = e.parent ? ents[e.parent] : undefined, n++) { const p = e.components?.transform?.position; if (p) { x += p[0]; z += p[2]; } } return [x, z]; };
  for (const [id, e] of Object.entries(ents)) {
    const pid = e?.components?.prefab?.prefabId as string | undefined;
    if (!pid || seen.has(id) || SKIP_PREFAB.test(pid) || (only && !only.has(id)) || ents[`${id}--foundation`]) continue;
    const [x, z] = approx(id); if (!inArea(area, x, z)) continue;
    unsized++; unsizedIds.push(`${id} (${pid})`);
    rows.push({ kind: "scene", id, what: pid, contact: "base", x: r3(x), y: r3(e.components?.transform?.position?.[1] ?? 0), z: r3(z), status: "off", gap: Infinity, support: null as never, reason: "its prefab produced no geometry (missing, empty or unresolved meshes): not measured, so not passed", fix: { y: null } });
  }
  return { rows, checked, unsized, ms: performance.now() - t0, deferred, unsizedIds };
}

/** Seat every scatter rock (`contact: embed`) the runtime places in the area's cells. */
export function floatScatter(field: WorldField, area: Area, tol: number, legacy: boolean, skipFlat = false): { rows: FloatRow[]; checked: number; ms: number; cells: number; skipped?: number } {
  const t0 = performance.now();
  const recipe = field.recipe, size = recipe.cellSize;
  const rect = area.rect ?? (area.near ? [area.near[0] - area.near[2], area.near[1] - area.near[2], area.near[0] + area.near[2], area.near[1] + area.near[2]] : null);
  if (!rect) throw new Error("scatter needs --near or --rect (a whole world is swept in chunks: float-sweep)");
  const probe = fieldSolidProbe(field);
  const rows: FloatRow[] = [];
  let checked = 0, cells = 0, skipped = 0;
  const rocks = recipe.scatter.map((r) => scatterContact(r) === "embed");
  if (!rocks.some(Boolean)) return { rows, checked, ms: 0, cells };
  for (let cz = Math.floor(rect[1] / size); cz <= Math.floor(rect[3] / size); cz++)
    for (let cx = Math.floor(rect[0] / size); cx <= Math.floor(rect[2] / size); cx++) {
      if (field.worldLimit !== Infinity && Math.hypot((cx + 0.5) * size, (cz + 0.5) * size) > field.worldLimit + size) continue;
      // a sweep may skip cells that cannot hold a hanging rock: level (under 1.5 m of relief), no carve, no planar cliff
      if (skipFlat) {
        const x0 = cx * size, z0 = cz * size, hr = field.heightRange(x0, z0, x0 + size, z0 + size, 6);
        if (hr.max - hr.min < 1.5 && !field.carveSpan(x0, z0, x0 + size, z0 + size) && !field.planarMaskIn(x0, z0, x0 + size, z0 + size)) { skipped++; continue; }
      }
      cells++;
      for (const inst of scatterCell(field, cx, cz, legacy ? { seat: false } : {})) {
        if (!rocks[inst.ruleIndex]) continue;
        const rule = recipe.scatter[inst.ruleIndex]!;
        const x = inst.position[0] + cx * size, z = inst.position[2] + cz * size, y = inst.position[1];
        if (!inArea(area, x, z)) continue;
        const q = inst.rotation;
        const yaw = Math.atan2(2 * (q[3] * q[1] + q[0] * q[2]), 1 - 2 * (q[1] * q[1] + q[2] * q[2]));
        const s = scatterSeatSize(rule, inst.scale);
        const r = seatObject(probe, { x, z, y, yaw, ...s, align: rule.alignToNormal }, "embed", { tol, embed: scatterEmbed(rule), reachDown: Math.max(4, s.height * 2) });
        checked++;
        if (r.status === "ok") continue;
        rows.push({ kind: "scatter", id: inst.id, what: rule.id, contact: "embed", x: r2(x), y: r2(y), z: r2(z), status: r.status, gap: r2(r.gap), support: r.support, ...(r.reason ? { reason: r.reason } : {}) });
      }
    }
  // operator boulders (features.rockSets: a scree fan's), stood once per set like fall-site rocks
  for (const set of recipe.features.rockSets ?? []) {
    for (const inst of rockSetInstances(field, set)) {
      const rule = recipe.scatter[inst.ruleIndex];
      if (!rule || !rocks[inst.ruleIndex]) continue;
      const [x, y, z] = inst.position;
      if (x < rect[0] || x > rect[2] || z < rect[1] || z > rect[3] || !inArea(area, x, z)) continue;
      const q = inst.rotation;
      const yaw = Math.atan2(2 * (q[3] * q[1] + q[0] * q[2]), 1 - 2 * (q[1] * q[1] + q[2] * q[2]));
      const sz = scatterSeatSize(rule, inst.scale);
      const r = seatObject(probe, { x, z, y, yaw, ...sz, align: rule.alignToNormal }, "embed", { tol, embed: scatterEmbed(rule), reachDown: Math.max(4, sz.height * 2) });
      checked++;
      if (r.status === "ok") continue;
      rows.push({ kind: "scatter", id: inst.id, what: `${rule.id} (${set.id})`, contact: "embed", x: r2(x), y: r2(y), z: r2(z), status: r.status, gap: r2(r.gap), support: r.support, ...(r.reason ? { reason: r.reason } : {}) });
    }
  }
  return { rows, checked, ms: performance.now() - t0, cells, skipped };
}

function summarize(target: string, areaText: string, tol: number, scene: ReturnType<typeof floatScene> | null, scatter: ReturnType<typeof floatScatter> | null): FloatReport {
  const rows = [...(scene?.rows ?? []), ...(scatter?.rows ?? [])].sort((a, b) => (b.gap === Infinity ? 1e9 : b.gap) - (a.gap === Infinity ? 1e9 : a.gap));
  const byKind: Record<string, number> = {}, byContact: Record<string, number> = {};
  for (const r of rows) { byKind[r.what] = (byKind[r.what] ?? 0) + 1; byContact[r.contact] = (byContact[r.contact] ?? 0) + 1; }
  const n = (scene?.checked ?? 0) + (scatter?.checked ?? 0);
  return {
    ok: rows.length === 0, passed: rows.length === 0, target, area: areaText, tol,
    checked: { scene: scene?.checked ?? 0, scatter: scatter?.checked ?? 0, unsized: scene?.unsized ?? 0, deferred: scene?.deferred?.length ?? 0 },
    counts: { off: rows.filter((r) => r.status === "off").length, unsupported: rows.filter((r) => r.status === "unsupported").length, byKind, byContact },
    ms: { scene: Math.round(scene?.ms ?? 0), scatter: Math.round(scatter?.ms ?? 0), perObjectMs: n ? Math.round((((scene?.ms ?? 0) + (scatter?.ms ?? 0)) / n) * 100) / 100 : 0 },
    rows,
  };
}

function print(rep: FloatReport, list: boolean): void {
  console.log(`float ${rep.target} [${rep.area}]: ${rep.checked.scene} scene objects + ${rep.checked.scatter} scatter rocks checked (${rep.checked.unsized} without geometry: FAULTS; ${rep.checked.deferred ?? 0} founded piece(s) judged by place-build seated) in ${((rep.ms.scene + rep.ms.scatter) / 1000).toFixed(1)} s (${rep.ms.perObjectMs} ms/object)`);
  if (rep.ok) { console.log(`  OK: every contact within ${rep.tol} m`); return; }
  console.log(`  FAIL: ${rep.counts.off} off by > ${rep.tol} m, ${rep.counts.unsupported} with no support   by contact ${JSON.stringify(rep.counts.byContact)}`);
  for (const r of list ? rep.rows : rep.rows.slice(0, 25))
    console.log(`    ${r.status.padEnd(11)} ${r.contact.padEnd(5)} ${r.what.padEnd(30)} ${r.id.padEnd(34)} at (${r.x}, ${r.y}, ${r.z}) gap ${r.gap} m${r.reason ? `  — ${r.reason}` : ""}`);
  if (!list && rep.rows.length > 25) console.log(`    ... ${rep.rows.length - 25} more (--list, or --out for the JSON)`);
}

// ------------------------------------------------------------------ fix / undo

/** Ops that re-seat the `off` scene rows (and remove unsupported ones with `drop`). applyOps returns the inverse. */
export function fixOps(doc: SceneDoc, rows: readonly FloatRow[], drop: boolean | "rocks"): any[] {
  const ops: any[] = [];
  for (const r of rows) {
    if (r.kind !== "scene") continue;
    const e = (doc.entities as Record<string, any>)[r.id];
    if (!e) continue;
    const t = e.components.transform;
    if (r.status === "unsupported") {
      // "rocks": only an unsupported embed (a rock or formation on an edge) goes; anything else is moved by its owner
      if (!drop || (drop === "rocks" && r.contact !== "embed")) continue;
      ops.push({ op: "remove-entity", id: r.id });
      continue;
    }
    if (!r.fix || r.fix.y === null) continue;
    // nothing to move (an uneven table already on its highest foot): no op, so a re-run stays a no-op
    if (Math.abs(r.fix.y - r.y) < 0.01 && Math.abs((r.fix.x ?? r.x) - r.x) < 0.01 && Math.abs((r.fix.z ?? r.z) - r.z) < 0.01) continue;
    // world delta -> the entity's local frame (parent rotation and scale undone)
    const dW = [(r.fix.x ?? r.x) - r.x, r.fix.y - r.y, (r.fix.z ?? r.z) - r.z];
    const local = toLocal(doc, e.parent, dW as [number, number, number]);
    const p = t.position ?? [0, 0, 0];
    ops.push({ op: "set-component", id: r.id, component: "transform", data: { ...t, position: [p[0] + local[0], p[1] + local[1], p[2] + local[2]] } });
  }
  return ops;
}

/** Digest of a scene build: what a `--fix` inverse is keyed to (a rebuilt scene is a new digest). */
export function sceneDigest(doc: SceneDoc): string {
  return createHash("sha1").update(JSON.stringify(doc)).digest("hex").slice(0, 16);
}

/**
 * A `--fix` inverse file against the scene as it is now: `current` when it was written for this very build (the fix is
 * applied; undo is safe), `stale` when the scene was rebuilt since (an older build's inverse — dropped by the next
 * --fix, refused by undo), `none` when there is no file. A legacy bare-array inverse is `stale` once the scene file is
 * newer than it.
 */
export function inverseState(file: string, doc: SceneDoc, sceneFile?: string): "none" | "current" | "stale" {
  if (!fs.existsSync(file)) return "none";
  const j = readJson(file);
  if (Array.isArray(j)) return sceneFile && fs.statSync(sceneFile).mtimeMs > fs.statSync(file).mtimeMs ? "stale" : "current";
  return j?.digest === sceneDigest(doc) ? "current" : "stale";
}

function toLocal(doc: SceneDoc, parent: string | null | undefined, d: [number, number, number]): [number, number, number] {
  const chain: any[] = [];
  for (let p = parent; p; p = (doc.entities as Record<string, any>)[p]?.parent) chain.push((doc.entities as Record<string, any>)[p]?.components?.transform ?? {});
  let v = d;
  for (const t of chain.reverse()) {
    const q = t.rotation ?? [0, 0, 0, 1], s = t.scale ?? [1, 1, 1];
    // rotate by the conjugate (v' = v + 2w(u x v) + 2u x (u x v), u = -q.xyz), then unscale
    const ux = -q[0], uy = -q[1], uz = -q[2], w = q[3];
    const [vx, vy, vz] = v;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const rx = vx + 2 * (w * cx + uy * cz - uz * cy), ry = vy + 2 * (w * cy + uz * cx - ux * cz), rz = vz + 2 * (w * cz + ux * cy - uy * cx);
    v = [rx / s[0], ry / s[1], rz / s[2]];
  }
  return v;
}

// ------------------------------------------------------------------ CLI

function registry(): ComponentRegistry { const reg = new ComponentRegistry(); registerCoreComponents(reg); return reg; }
const opt = (argv: string[], name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
function parseArea(argv: string[], fail: (m: string) => never): { area: Area; text: string } {
  const near = opt(argv, "near"), rect = opt(argv, "rect");
  if (near) { const v = near.split(",").map(Number); if (v.length !== 3 || !v.every(Number.isFinite)) fail("--near wants x,z,r"); return { area: { near: v as never }, text: `near ${near}` }; }
  if (rect) { const v = rect.split(",").map(Number); if (v.length !== 4 || !v.every(Number.isFinite)) fail("--rect wants x0,z0,x1,z1"); return { area: { rect: v as never }, text: `rect ${rect}` }; }
  return { area: {}, text: "whole scene" };
}
function emit(rep: FloatReport, argv: string[]): void {
  const out = opt(argv, "out");
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(rep, null, 1)); }
  if (argv.includes("--json")) console.log(JSON.stringify({ ...rep, rows: rep.rows.slice(0, 50) }));
  else print(rep, argv.includes("--list"));
  if (!rep.ok) process.exitCode = 1;
}

/** The project directory and assets dir a world recipe file lives in. */
function projectOfRecipe(file: string): { dir: string; assets: string } {
  const assets = path.dirname(path.dirname(path.resolve(file)));
  return { dir: path.dirname(assets), assets };
}

/**
 * The land of a world cut into `size`-metre squares (row-major), open sea skipped: what a whole-world sweep walks,
 * one chunk per job (`float-sweep`), or all of them for `--stamp`.
 */
export function worldChunks(field: WorldField, size = 384): [number, number, number, number][] {
  const r = field.recipe as any;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const c of r.bounds?.continents ?? []) {
    const pad = (c.radius ?? 0) + (c.falloff ?? 0);
    x0 = Math.min(x0, c.center[0] - pad); z0 = Math.min(z0, c.center[1] - pad); x1 = Math.max(x1, c.center[0] + pad); z1 = Math.max(z1, c.center[1] + pad);
    // cape tips (coast shape): a peninsula reaches past every disc
    for (const cp of c.capes ?? []) { const tx = c.center[0] + cp[2], tz = c.center[1] + cp[3], tr = cp[5] + (c.falloff ?? 0); x0 = Math.min(x0, tx - tr); z0 = Math.min(z0, tz - tr); x1 = Math.max(x1, tx + tr); z1 = Math.max(z1, tz + tr); }
    for (const l of c.lobes ?? []) { x0 = Math.min(x0, l[0] - l[2] - (c.falloff ?? 0)); z0 = Math.min(z0, l[1] - l[2] - (c.falloff ?? 0)); x1 = Math.max(x1, l[0] + l[2] + (c.falloff ?? 0)); z1 = Math.max(z1, l[1] + l[2] + (c.falloff ?? 0)); }
  }
  if (!Number.isFinite(x0)) { const L = Number.isFinite(field.worldLimit) ? field.worldLimit : 1024; x0 = z0 = -L; x1 = z1 = L; }
  const out: [number, number, number, number][] = [];
  const sea = (r.seaLevel ?? 0) - 10;
  for (let z = Math.floor(z0 / size) * size; z < z1; z += size)
    for (let x = Math.floor(x0 / size) * size; x < x1; x += size) {
      let land = false;
      for (let i = 0; i <= 4 && !land; i++) for (let k = 0; k <= 4 && !land; k++) if (field.height(x + (size * i) / 4, z + (size * k) / 4) > sea) land = true;
      if (land) out.push([x, z, x + size, z + size]);
    }
  return out;
}

/** `worldgen float <world>`: the world's scene objects and its scatter rocks, on the field's solid. */
export function commandFloat(host: { argv: string[]; loadRecipe(): { recipe: WorldRecipe; file: string }; fail(m: string): never; writeRecipe?(recipe: WorldRecipe, file: string): void }): FloatReport {
  const { argv } = host;
  const { recipe, file } = host.loadRecipe();
  const tol = Number(opt(argv, "tol") ?? 0.05);
  const { area, text } = parseArea(argv, host.fail);
  const field = createWorldField(recipe);
  const { assets } = projectOfRecipe(file);
  // L (Wristgate 2026-10-29): a place-build lab keeps the recipe's name (firstshore) in a world file named for the lab
  // (pbwristgate.json, scene pbwristgate.scene.json): the scene was looked up by recipe.name, not found, and SKIPPED in
  // silence ("0 scene objects ... OK"). The scene is the world FILE's scene first, then the recipe name; none is a stop.
  const byFile = path.join(assets, "scenes", `${path.basename(file).replace(/.json$/, "")}.scene.json`);
  const sceneFile = opt(argv, "scene") ?? [byFile, path.join(assets, "scenes", `${recipe.name}.scene.json`)].find((f) => fs.existsSync(f)) ?? byFile;
  if (!argv.includes("--no-scene") && !fs.existsSync(sceneFile)) host.fail(`float: no scene ${sceneFile} (give --scene <file>, or --no-scene to measure scatter only)`);
  const scene = !argv.includes("--no-scene") ? floatScene(assets, readJson(sceneFile), field, area, tol) : null;
  const legacy = argv.includes("--legacy-scatter");
  const stamp = argv.includes("--stamp");
  if (stamp && (area.near || area.rect)) host.fail("--stamp sweeps the whole world; drop --near/--rect");
  let scatter: ReturnType<typeof floatScatter> | null = null;
  if (!argv.includes("--no-scatter")) {
    if (area.near || area.rect) scatter = floatScatter(field, area, tol, legacy);
    else if (stamp) {
      // every land chunk; one report
      scatter = { rows: [], checked: 0, ms: 0, cells: 0 };
      for (const rect of worldChunks(field)) {
        const s = floatScatter(field, { rect }, tol, legacy);
        scatter.rows.push(...s.rows); scatter.checked += s.checked; scatter.ms += s.ms; scatter.cells += s.cells;
      }
    }
  }
  const rep = summarize(recipe.name, text + (scatter ? "" : " (scene only; scatter rocks need --near/--rect, or --stamp for the whole world)"), tol, scene, scatter);
  emit(rep, argv);
  // the `float` stage of `worldgen status`: stamped only by a clean whole-world sweep
  if (stamp && rep.ok && host.writeRecipe) { host.writeRecipe(recipe, file); console.log("  stamped stage float"); }
  return rep;
}

function sceneTarget(argv: string[], fail: (m: string) => never): { project: string; assets: string; file: string; doc: SceneDoc; field: WorldField | null } {
  const project = argv[1];
  if (!project) fail("usage: float scene <project> [--scene <id|file>] [--world <recipe id>]");
  const dir = path.join(PROJECTS, project!);
  const assets = path.join(dir, "assets");
  const s = opt(argv, "scene");
  let file = s && fs.existsSync(s) ? s : path.join(assets, "scenes", `${s ?? project}.scene.json`);
  if (!fs.existsSync(file)) {
    const any = fs.existsSync(path.join(assets, "scenes")) ? fs.readdirSync(path.join(assets, "scenes")).filter((f) => f.endsWith(".scene.json")) : [];
    if (any.length !== 1) fail(`no scene ${file}; pass --scene (have: ${any.join(", ") || "none"})`);
    file = path.join(assets, "scenes", any[0]!);
  }
  const doc = readJson(file) as SceneDoc;
  return { project: project!, assets, file, doc, field: fieldOfScene(project!, doc, opt(argv, "world")) };
}

/** The voxel world under a scene (named, or the scene's own voxelWorld component), through the project's closure. */
export function fieldOfScene(project: string, doc: SceneDoc, worldId?: string): WorldField | null {
  if (!worldId) for (const e of Object.values(doc.entities as Record<string, any>)) if (e.components?.voxelWorld?.world) worldId = e.components.voxelWorld.world;
  if (!worldId) return null;
  const rf = findAsset(project, `worlds/${worldId}.json`);
  return rf ? createWorldField(worldRecipeSchema.parse(readJson(rf))) : null;
}

/**
 * Seat freshly placed entities (a placer's last step): measure `ids` in `doc` on the real solid and return the
 * re-seating ops (base/legs/embed y, a wall piece's plan move) plus the rows that have no support at all.
 */
export function seatPlaced(project: string, doc: SceneDoc, ids: ReadonlySet<string>, tol = 0.05, seatOpts: SeatOptions = {}): { ops: any[]; rows: FloatRow[]; unsupported: FloatRow[] } {
  const assets = path.join(PROJECTS, project, "assets");
  // a PLACER: a rock is re-seated unless already ROCK_EMBED (15%) in, so the gate (10%) holds with margin
  const { rows } = floatScene(assets, doc, fieldOfScene(project, doc), {}, tol, ids, { embedMin: ROCK_EMBED, ...seatOpts });
  return { ops: fixOps(doc, rows, false), rows, unsupported: rows.filter((r) => r.status === "unsupported") };
}

/**
 * The scene to WRITE after a long fix: a world sweep measures for minutes while other jobs edit the same scene, and
 * writing the doc loaded at the start would undo their edits. When the file changed since `loaded`, the fix's ops are
 * re-applied to the file as it is now (atomic: an entity they move that is gone, or moved by someone else in the
 * meantime, refuses the whole write — re-run). Returns the doc to write and its inverse.
 */
export function fixOnCurrent(file: string, loaded: SceneDoc, fixed: { doc: SceneDoc; ops: any[]; inverse: any[] }): { doc: SceneDoc; inverse: any[]; rebased: boolean } {
  const now = readJson(file) as SceneDoc;
  if (sceneDigest(now) === sceneDigest(loaded)) return { doc: fixed.doc, inverse: fixed.inverse, rebased: false };
  const touched = new Set(fixed.ops.map((o) => String(o.entity ?? o.id ?? "")).filter(Boolean));
  for (const id of touched) {
    const was = JSON.stringify((loaded.entities as Record<string, any>)[id]?.components?.transform ?? null);
    const is = JSON.stringify((now.entities as Record<string, any>)[id]?.components?.transform ?? null);
    if (was !== is) throw new Error(`the scene changed under the fix: ${id} was moved or removed meanwhile — nothing written; re-run the fix`);
  }
  const res = applyOps(now, fixed.ops as never, registry());
  return { doc: res.doc, inverse: res.inverse, rebased: true };
}

export function main(argv: string[]): void {
  const fail = (m: string): never => { console.error(m); process.exit(2); };
  const cmd = argv[0];
  if (cmd === "scene") {
    const t = sceneTarget(argv, fail);
    const tol = Number(opt(argv, "tol") ?? 0.05);
    const { area, text } = parseArea(argv, fail);
    const scene = floatScene(t.assets, t.doc, t.field, area, tol);
    const rep = summarize(`${t.project}/${path.basename(t.file)}`, text, tol, scene, null);
    if (argv.includes("--fix")) {
      // a few passes: a book seated on a table that itself moved is re-seated on the table's new top
      const drop = argv.includes("--drop-unsupported") ? true : argv.includes("--drop-unsupported-rocks") ? "rocks" : false;
      let next = t.doc, rows = rep.rows, inverse: any[] = [], total = 0;
      const allOps: any[] = [];
      for (let pass = 0; pass < 4; pass++) {
        const ops = fixOps(next, rows, drop);
        if (!ops.length) break;
        const res = applyOps(next, ops as never, registry());
        next = res.doc; inverse = [...res.inverse, ...inverse]; total += ops.length; allOps.push(...ops);
        rows = floatScene(t.assets, next, t.field, area, tol).rows;
      }
      const inv = opt(argv, "inverse") ?? path.join(path.dirname(t.file), `../../authoring/sweeps/float-fix.inverse.json`);
      if (!total) {
        // the inverse is keyed to the scene build it was written for: a rebuilt scene's old inverse says nothing
        const st = inverseState(inv, t.doc, t.file);
        if (st === "stale") { fs.rmSync(inv); console.log(`float --fix: dropped ${inv} (written for an earlier build of this scene)`); }
        if (!rows.length) console.log(`float --fix: nothing to re-seat: every contact within ${tol} m${st === "current" ? " (this build's fix is applied)" : ""}`);
        else {
          const unsup = rows.filter((r) => r.status === "unsupported").length;
          console.log(`float --fix: nothing re-seatable, ${rows.length} still faulty: ${unsup} unsupported (moved by their owner, or --drop-unsupported), ${rows.length - unsup} with no seat found (listed by a plain run)`);
          process.exitCode = 1;
        }
        return;
      }
      let out!: ReturnType<typeof fixOnCurrent>;
      // the rebase check and the write happen under the scene's lock (tools/_scene-write.mts)
      try { updateJsonFile(t.file, (fresh) => { out = fixOnCurrent(t.file, t.doc, { doc: next, ops: allOps, inverse }); return { doc: out.doc, removed: removalsOf(allOps, fresh) }; }, { label: "float --fix", trailer: "" }); } catch (e) { console.error(`float --fix: ${(e as Error).message}`); process.exitCode = 1; return; }
      next = out.doc; inverse = out.inverse;
      if (out.rebased) console.log("float --fix: the scene changed while it was measured — the fix was re-applied to the current file");
      console.log(`float --fix: ${rows.length} still off or unsupported after re-seating (listed by the next plain run)`);
      fs.mkdirSync(path.dirname(inv), { recursive: true });
      fs.writeFileSync(inv, JSON.stringify({ scene: path.basename(t.file), digest: sceneDigest(next), ops: inverse }, null, 1));
      console.log(`float --fix: ${total} ops applied to ${t.file}; inverse ${inv}`);
      return;
    }
    emit(rep, argv);
    return;
  }
  if (cmd === "chunks") {
    // float chunks <project> <world> --dir <out> [--from i] [--budget-s 200] [--legacy-scatter] [--skip-flat]
    // one heavy-lock job: scatter rocks chunk by chunk (worldChunks) until the time budget, one JSON per chunk
    const [, project, world] = argv;
    const rf = findAsset(project!, `worlds/${world}.json`);
    if (!rf) fail(`no world ${world} in ${project}'s closure`);
    const field = createWorldField(worldRecipeSchema.parse(readJson(rf!)));
    const dir = opt(argv, "dir") ?? fail("--dir <out dir>");
    fs.mkdirSync(dir!, { recursive: true });
    const chunks = worldChunks(field);
    const budget = Number(opt(argv, "budget-s") ?? 200) * 1000, t0 = Date.now();
    let i = Number(opt(argv, "from") ?? 0);
    for (; i < chunks.length && Date.now() - t0 < budget; i++) {
      const s = floatScatter(field, { rect: chunks[i]! }, Number(opt(argv, "tol") ?? 0.05), argv.includes("--legacy-scatter"), argv.includes("--skip-flat"));
      fs.writeFileSync(path.join(dir!, `chunk-${String(i).padStart(4, "0")}.json`), JSON.stringify({ rect: chunks[i], ...s }));
    }
    console.log(JSON.stringify({ next: i, total: chunks.length }));
    return;
  }
  if (cmd === "undo") {
    const t = sceneTarget(argv, fail);
    const inv = opt(argv, "inverse");
    if (!inv || !fs.existsSync(inv)) fail("undo needs --inverse <file>");
    if (inverseState(inv!, t.doc, t.file) === "stale") fail(`undo: ${inv} was written for an earlier build of ${path.basename(t.file)} (scene rebuilt since); not applied`);
    const j = readJson(inv!);
    applyOpsToSceneFile(t.file, (Array.isArray(j) ? j : j.ops) as any[], (d, o) => applyOps(d, o as never, registry()), { label: "float undo", trailer: "" });
    console.log(`float undo: applied ${inv}`);
    return;
  }
  fail("usage: float scene <project> [...] | float undo <project> --inverse f   (worlds: worldgen float <world>)");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main(process.argv.slice(2));

/**
 * `worldgen lips <world> [--near x,z,r] [--list] [--json] [--allow id,id]`
 * `worldgen seated <world> --slab x,z,halfX,halfZ,yawDeg,baseY [--slab ...] | --slabs <file.json> | --wall <opId> | --walls`
 *
 * LIPS — the lip / sawtooth gate. The terrain is drawn from the field sampled
 * on the 2 m voxel lattice, so any height change an EDIT makes that is
 * narrower than the lattice comes out as teeth (a diagonal patch edge), a
 * wall (a deep path cut with a narrow shoulder) or a one-sample rim. This
 * measures exactly that, on the edited world against the same world without
 * its height patches and graded roads (`measureTerrainLips` in core), only in
 * the bands where those edits meet the ground:
 *
 *  - every height patch: its whole raster and 6 m beyond its edge;
 *  - along every graded road (flatten > 0 with a surface): out to its reach.
 *
 * An operator's patch (`op:<id>:*`) is measured against the world without that patch only (like a terrace wall's
 * `tw-*`): operators compose in recipe order, so a patch is charged for what IT changed, not for the pad under it.
 *
 * A terrace wall's own riser is exempt: the lattice cell holding each fitted
 * `features.terraceWalls` face (and the cell in front, holding the berm the cut removes) is the wall, drawn by the
 * retaining-wall geometry and cut sharp by the terrace's passages, not a fault
 * of its patch. Its strip, pad and feathers are measured like any patch. Operator kit walls (`features.kitWalls[].cuts`,
 * kind face) are exempt the same way.
 *
 * A cell in the bands of two or more edits is charged to the edit that MADE it: the one whose removal changes the drawn
 * ground there most (`cellMaker`), so a road's cut edge inside a big patch's raster is the road's and a patch face over a
 * road is the patch's. Only where no single edit moves the cell is it charged to the nearest band (2026-10-30 redstrand
 * w13: the band faults of two roads inside the Weeping Sun's 391 m raster were all charged to that patch).
 * Faults are attributed that way and the command exits 1
 * when any are found (an `--allow`ed id is reported, not failed). Thresholds:
 * `--alias 0.5` (m the drawn ground misses the field by), `--max-slope 1.6`
 * (rise/run between lattice samples), `--lip 0.75` (one-sample rim/slot, m).
 *
 * SEATED — is a built slab (a wall, a platform, a foundation) sitting on the
 * DRAWN ground? Samples the lattice-reconstructed ground along each slab's
 * footprint and reports `gap` (base over the ground: it hangs) and `clip`
 * (ground over the base: the terrain shows through). Exit 1 above
 * `--gap 0.25` / `--clip 0.6`.
 *
 * See docs/voxel-worlds.md "Height-patch edges".
 */
import fs from "node:fs";
import path from "node:path";
import { visibleWorldGround, wallSeat, type WallSeatReport } from "./_wall-seated.mts";
import {
  createWorldField,
  createVolume,
  compileLandmarkSpec,
  type CsgNode,
  measureTerrainLips,
  seatReport,
  fieldSolidProbe,
  type TerrainLipFault,
  type WorldRecipe,
} from "@hitreg/core";

export interface LipsHost {
  argv: string[];
  loadRecipe(): { recipe: WorldRecipe; file: string };
  fail(message: string): never;
}

interface Owner {
  kind: "patch" | "road";
  id: string;
  /** distance from (x, z) to this owner's edge band, <= 0 inside the band */
  band(x: number, z: number): number;
  box: [number, number, number, number];
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

function owners(recipe: WorldRecipe): Owner[] {
  const out: Owner[] = [];
  for (const p of recipe.features.heightPatches) {
    const [x0, z0] = p.origin, x1 = x0 + p.size[0], z1 = z0 + p.size[1];
    out.push({
      kind: "patch",
      id: p.id,
      box: [x0 - 6, z0 - 6, x1 + 6, z1 + 6],
      band: (x, z) => {
        // the whole raster (a terrace edge drawn into it is an edge too) and 6 m beyond
        const inside = x > x0 && z > z0 && x < x1 && z < z1;
        return inside ? -Math.min(x - x0, z - z0, x1 - x, z1 - z) : Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1)) - 6;
      },
    });
  }
  for (const r of recipe.features.roads) {
    if (!(r.flatten > 0) || !r.surfaceY) continue;
    const reach = r.width / 2 + r.shoulder + r.smooth + 4;
    // one owner per run of segments no longer than ~48 m: a long road's
    // bounding box is mostly ground it never touches
    let start = 0;
    while (start + 1 < r.points.length) {
      let end = start + 1, len = 0;
      while (end < r.points.length) {
        len += Math.hypot(r.points[end]![0] - r.points[end - 1]![0], r.points[end]![1] - r.points[end - 1]![1]);
        if (len >= 48) break;
        end++;
      }
      end = Math.min(end, r.points.length - 1);
      const pts = r.points.slice(start, end + 1);
      let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
      for (const [x, z] of pts) { bx0 = Math.min(bx0, x); bz0 = Math.min(bz0, z); bx1 = Math.max(bx1, x); bz1 = Math.max(bz1, z); }
      out.push({
        kind: "road",
        id: r.id,
        box: [bx0 - reach, bz0 - reach, bx1 + reach, bz1 + reach],
        band: (x, z) => {
          let d = Infinity;
          for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, segDist(x, z, pts[i]![0], pts[i]![1], pts[i + 1]![0], pts[i + 1]![1]));
          return d - reach;
        },
      });
      start = end;
    }
  }
  return out;
}

const num = (argv: string[], name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(argv[i + 1]) : dflt;
  return Number.isFinite(v) ? v : dflt;
};
const str = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

export interface LipsResult {
  ok: boolean;
  owners: { kind: string; id: string; alias: number; step: number; lip: number; worst: number; run: number; allowed: boolean }[];
  totals: { alias: number; step: number; lip: number; cells: number; touched: number };
}

/**
 * A `wall` operator's retaining/quay body as riser faces: the bank it retains is the wall's job, drawn by its baked
 * geometry, not a fault of the patch that cut the ground in front of it (or of its own backfill). One face per plan leg,
 * re-based to the exposed face (`face: right` = right of travel, the normal [-dz, dx]); the band runs
 * from 2.2 m in front of the battered foot (+ footing projection) back over the body and its backfill width.
 */
export function wallOperatorFaces(recipe: WorldRecipe): { a: number[]; b: number[]; normal: number[]; reach: number }[] {
  const out: { a: number[]; b: number[]; normal: number[]; reach: number }[] = [];
  for (const o of (recipe.features.operators ?? []) as Record<string, any>[]) {
    if (o.op !== "wall" || !Array.isArray(o.points)) continue;
    if (o.variant === "ramp") {
      // a causeway ramp's body hides the ground under it: both sides of the line out to the deck edge + parapet + 2.2 m
      const half = Number(o.thickness ?? 1.2) / 2 + Number(o.parapet?.thickness ?? 0) + 2.2, P = o.points as number[][];
      for (let i = 0; i + 1 < P.length; i++) {
        const [ax, az] = P[i]!, [bx, bz] = P[i + 1]!, l = Math.hypot(bx! - ax!, bz! - az!);
        if (l < 1e-6) continue;
        const nx = -(bz! - az!) / l, nz = (bx! - ax!) / l;
        // one band from the right edge across to the left (the band starts 2.2 m outside its face line)
        out.push({ a: [ax! + nx * (half - 2.2), az! + nz * (half - 2.2)], b: [bx! + nx * (half - 2.2), bz! + nz * (half - 2.2)], normal: [-nx, -nz], reach: 2 * half - 2.2 });
      }
      continue;
    }
    if (o.variant !== "retaining" && o.variant !== "quay") continue;
    const t = Number(o.thickness ?? 1.2), h = Number(o.height ?? 4), bat = Number(o.batter ?? 0.06);
    const foot = Number(o.footing?.projection ?? (o.scale === "giant" ? 0.8 : 0.25)) + Number(o.buttresses?.depth ?? 0);
    const front = t / 2 + bat * h + foot; // face line, from the plan line
    const reach = front + t / 2 + Number(o.backfill?.width ?? 0) + 2.2; // back to the earth behind (and its backfill)
    const sgn = o.face === "left" ? -1 : 1;
    // a `terrain` end runs on `tie` m past its point into the hillside (the wall's body there too)
    const P = (o.points as number[][]).map((p) => [...p]);
    const tie = Number(o.ends?.tie ?? 2 * t + 2);
    const runOn = (end: number, prev: number, on: boolean) => {
      if (!on || P.length < 2) return;
      const dx = P[end]![0]! - P[prev]![0]!, dz = P[end]![1]! - P[prev]![1]!, l = Math.hypot(dx, dz);
      if (l > 1e-6) P[end] = [P[end]![0]! + (dx / l) * tie, P[end]![1]! + (dz / l) * tie];
    };
    runOn(0, 1, (o.ends?.start ?? "terrain") === "terrain");
    runOn(P.length - 1, P.length - 2, (o.ends?.end ?? "terrain") === "terrain");
    for (let i = 0; i + 1 < P.length; i++) {
      const [ax, az] = P[i]!, [bx, bz] = P[i + 1]!, l = Math.hypot(bx! - ax!, bz! - az!);
      if (l < 1e-6) continue;
      // normal toward the exposed face; the band n in [-2.2, reach] is measured from the face line INTO the wall
      const nx = (-(bz! - az!) / l) * sgn, nz = ((bx! - ax!) / l) * sgn;
      out.push({ a: [ax! + nx * front, az! + nz * front], b: [bx! + nx * front, bz! + nz * front], normal: [-nx, -nz], reach });
    }
  }
  return out;
}

/** Cells whose centre is in a fitted terrace wall's riser band (the lattice cell behind each face). */
export function terraceRiserBand(recipe: WorldRecipe): (x: number, z: number) => boolean {
  const faces: { a: readonly number[]; b: readonly number[]; normal: readonly number[]; reach?: number }[] = (recipe.features.terraceWalls ?? []).flatMap((t) => t.solved?.faces ?? []);
  // operator kit walls (`features.kitWalls`, e.g. terrace risers) the same way
  for (const r of recipe.features.kitWalls ?? []) for (const c of r.cuts) {
    if (c.kind !== "face") continue;
    faces.push({ a: c.origin, b: [c.origin[0] + c.dir[0] * c.s[1], c.origin[1] + c.dir[1] * c.s[1]], normal: [-c.dir[1], c.dir[0]], reach: c.n[1] + 0.5 });
  }
  faces.push(...wallOperatorFaces(recipe));
  // a DC riser (`features.dcRisers`): its face is the drawn riser, from the top edge (n = 0, low side on the right) to past its
  // lowest foot (batter, benches and panel offsets: 1.5 m per metre of drop covers them)
  for (const r of recipe.features.dcRisers ?? []) for (let i = 0; i + 1 < r.points.length; i++) {
    const a = r.points[i]!, b = r.points[i + 1]!, l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    faces.push({ a, b, normal: [-(b[1] - a[1]) / l, (b[0] - a[0]) / l], reach: (r.top - r.foot) * 1.5 + (r.steps ? r.steps.tread * r.steps.tiers : 0) + 1 });
  }
  if (!faces.length) return () => false;
  return (x, z) => {
    for (const f of faces) {
      const dx = f.b[0] - f.a[0], dz = f.b[1] - f.a[1];
      const len = Math.hypot(dx, dz);
      const s = ((x - f.a[0]) * dx + (z - f.a[1]) * dz) / len;
      const n = (x - f.a[0]) * f.normal[0] + (z - f.a[1]) * f.normal[1];
      if (s >= -2.2 && s <= len + 2.2 && n >= -2.2 && n <= (f.reach ?? 2.2)) return true;
    }
    return false;
  };
}

/**
 * Cells an OPEN box passage cuts (a way, a court, a cleft open to the sky: its ceiling stands above the ground there): the
 * drawn surface in them is the passage floor and walls, which the heightfield `height()` the lips measure reads cannot
 * see, so a patch is not charged for a step the passage carves away (a path ending in a cut court mouth). A
 * tunnel (ceiling under the ground) does not open the cell. Footprint + one lattice step.
 */
/**
 * L (Wristgate 2026-10-28: a 20 m bastion retaining face between a rim walk and the court it overlooks is architecture,
 * and no terrain slope can draw it): a lattice cell whose whole drawn rise (lowest to highest ground within 2 m) stands
 * INSIDE the solid of a BUILT landmark operator (`kind: "built"`, an inline `csg` source, noise stripped so rock is never
 * credited with its outward growth) is drawn by that landmark, like a terrace wall's riser. A step any part of which
 * shows above or below the mass is still a fault.
 */
export function builtMassBand(recipe: WorldRecipe, height: (x: number, z: number) => number): (x: number, z: number) => boolean {
  const vols = ((recipe.features as { operators?: unknown[] }).operators ?? []).flatMap((raw) => {
    const o = raw as { op?: string; kind?: string; at?: [number, number]; y?: number; yaw?: number; scale?: number; voxel?: number; source?: { csg?: unknown } };
    if (o.op !== "landmark" || o.kind !== "built" || !o.source?.csg || !o.at || typeof o.y !== "number") return [];
    try {
      const c = compileLandmarkSpec(o.source.csg, { voxel: o.voxel ?? 0.5, yaw: o.yaw ?? 0, scale: o.scale ?? 1, skipThin: true });
      const nodes = c.nodes.map((n) => { const { noise: _n, ...rest } = n as CsgNode & { noise?: unknown }; return rest as CsgNode; });
      return [{ at: o.at, y: o.y, min: c.min, max: c.max, vol: createVolume({ voxelSize: 1, nodes, palette: ["stone"] }) }];
    } catch { return []; }
  });
  if (!vols.length) return () => false;
  return (x, z) => {
    const hs = [height(x, z), height(x + 2, z), height(x - 2, z), height(x, z + 2), height(x, z - 2)];
    const lo = Math.min(...hs), hi = Math.max(...hs);
    // a sawtooth (alias) cell has almost no rise: it is hidden when the mass holds its ground 0.6 m above and below
    for (const v of vols) {
      const lx = x - v.at[0], lz = z - v.at[1];
      if (lx < v.min[0] || lx > v.max[0] || lz < v.min[2] || lz > v.max[2]) continue;
      let inside = true;
      for (let y = lo - 0.6; y <= hi + 0.6 && inside; y += 0.5) if (!(v.vol.density(lx, y - v.y, lz) < 0)) inside = false;
      if (inside) return true;
    }
    return false;
  };
}

export function openCutBand(recipe: WorldRecipe, height: (x: number, z: number) => number): (x: number, z: number) => boolean {
  const cuts = (recipe.features.passages ?? []).filter((p) => (p.footprint ?? "box") === "box").map((p) => {
    const along = p.axis === "x" ? 0 : 1, dir = p.direction ?? 1;
    const a0 = p.start[along === 0 ? 0 : 2]!, a1 = a0 + dir * p.length, c = p.start[along === 0 ? 2 : 0]!;
    return { along, lo: Math.min(a0, a1), hi: Math.max(a0, a1), c, half: p.width / 2 + (p.wallNoise ?? 0), floor: p.start[1], top: p.start[1] + p.height + (p.roofRise ?? 0) };
  });
  if (!cuts.length) return () => false;
  const M = 2.2;
  return (x, z) => {
    for (const q of cuts) {
      const s = q.along === 0 ? x : z, t = q.along === 0 ? z : x;
      if (s < q.lo - M || s > q.hi + M || Math.abs(t - q.c) > q.half + M) continue;
      const h = height(x, z);
      if (h > q.floor + 0.25 && q.top >= h) return true;
    }
    return false;
  };
}

/**
 * Which edit MADE the drawn ground of the lattice cell centred at (x, z), among the owners whose bands hold it: the one
 * whose removal moves the ground there most (centre and the four half-cell corners), as `kind:id`. Undefined when no
 * candidate moves it by more than the gate's touched tolerance (0.15 m): the caller falls back to the nearest band.
 * The fields without each edit are built lazily, one per edit id; answers are cached per cell.
 */
export interface CellMaker {
  /** `kind:id` of the edit whose removal moves the cell most (undefined: none moves it past 0.15 m). */
  made: string | undefined;
  /** Every candidate whose removal moves the cell more than 0.5 m. */
  moved: string[];
}
export function cellMaker(recipe: WorldRecipe, field: { height(x: number, z: number): number }, step = 2): (x: number, z: number, candidates: { kind: string; id: string }[]) => CellMaker {
  const without = new Map<string, { height(x: number, z: number): number }>();
  const fieldWithout = (kind: string, id: string) => {
    const key = `${kind}:${id}`;
    let f = without.get(key);
    if (!f) {
      f = createWorldField({
        ...recipe,
        features: kind === "road"
          ? { ...recipe.features, roads: recipe.features.roads.filter((r) => r.id !== id) }
          : { ...recipe.features, heightPatches: recipe.features.heightPatches.filter((p) => p.id !== id) },
      });
      without.set(key, f);
    }
    return f;
  };
  const cache = new Map<string, CellMaker>();
  const h = step / 2;
  const pts: [number, number][] = [[0, 0], [-h, -h], [h, -h], [-h, h], [h, h]];
  return (x, z, candidates) => {
    const ids = [...new Set(candidates.map((c) => `${c.kind}:${c.id}`))].sort();
    const key = `${x},${z}|${ids.join("|")}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const here = pts.map(([dx, dz]) => field.height(x + dx, z + dz));
    let best: string | undefined, bestD = 0.15;
    const moved: string[] = [];
    for (const k of ids) {
      const sep = k.indexOf(":"), f = fieldWithout(k.slice(0, sep), k.slice(sep + 1));
      let d = 0;
      pts.forEach(([dx, dz], i) => { d = Math.max(d, Math.abs(here[i]! - f.height(x + dx, z + dz))); });
      if (d > bestD) { bestD = d; best = k; }
      if (d > 0.5) moved.push(k);
    }
    const out = { made: best, moved };
    cache.set(key, out);
    return out;
  };
}

/** The gate as a function, so installers and `zonegen status` can call it in-process. */
/**
 * A documented lips exception (`<project>/authoring/terrain/<world>.lips-exceptions.json`, `{ exceptions: [...] }`): faults
 * of owner `id` on the listed lattice cells (fault x,z as `--list` prints them) are reported as excepted, never counted.
 * For cells no edit can draw (a raised flat meeting a near-vertical face inside one 2 m cell); `reason` holds the diagnosis.
 */
export interface LipsException { id: string; reason: string; cells: [number, number][] }

/** A road piece's base id: `path-a-b.2.s3` -> `path-a-b` (non-road owners are returned unchanged). */
export const pieceBase = (id: string): string => id.replace(/(\.[sj]?\d+)+$/, "");

export function lipsExceptionsFile(recipeFile: string): string {
  // beside the world: <project>/authoring/terrain/ (as worldgen-operators.mts sideDir, the fine-legacy list)
  const parts = path.resolve(recipeFile).split(/[\\/]/), at = parts.lastIndexOf("assets");
  const side = at > 1 && parts[at - 2] === "projects" && parts[at + 1] === "worlds" ? path.join(...parts.slice(0, at), "authoring", "terrain") : path.dirname(recipeFile);
  return path.join(side, path.basename(recipeFile).replace(/\.json$/i, ".lips-exceptions.json"));
}
export function readLipsExceptions(recipeFile: string): LipsException[] {
  const f = lipsExceptionsFile(recipeFile);
  if (!fs.existsSync(f)) return [];
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  return Array.isArray(j.exceptions) ? j.exceptions : [];
}

/** Rise/run a generated cliff-face need may stand at before lips calls it a wall (72 deg). */
export const NEED_FACE_MAX_SLOPE = 3;
/**
 * Rise/run a cliff-face need's own ROCK may stand at (83 deg): inside the block's solved reach (`needs[].solved.rock`)
 * where the patch lifts the ground more than NEED_ROCK_LIFT m, the near-vertical walls are the cliff itself (w15: a
 * cliff need must make a cliff; the 72 deg cap made every face a mound). Its apron, fills and edges keep the 72 deg cap.
 */
export const NEED_ROCK_MAX_SLOPE = 8;
/** One-sample rim a cliff need's rock may hold (m): its corners and arêtes (a front meeting a return) read as one-sample
 *  peaks on the lattice; a fin or slot taller than this is still a fault. */
export const NEED_ROCK_LIP = 6;
const NEED_ROCK_LIFT = 3;

/** (x, z) (a 2 m lattice cell's centre) -> true inside a solved cliff-face need's rock (its block, lifted more than NEED_ROCK_LIFT m). */
export function needRockAt(recipe: WorldRecipe, lift: (x: number, z: number) => number): (x: number, z: number) => boolean {
  const rocks = (recipe.needs ?? []).flatMap((n) => {
    if (n.kind !== "cliff-face" || !n.solved?.rock) return [];
    const b = (((n.solved.faces + 180) % 360) * Math.PI) / 180, ix = Math.sin(b), iz = -Math.cos(b);
    return [{ at: n.solved.at, ix, iz, deep: n.solved.rock[0], side: n.solved.rock[1] }];
  });
  if (!rocks.length) return () => false;
  return (x, z) => rocks.some((r) => {
    const dx = x - r.at[0], dz = z - r.at[1], u = dx * r.ix + dz * r.iz, s = -dx * r.iz + dz * r.ix;
    // the wall's foot past the face ends stands a few metres in front of the foot line (it follows the apron's fill down)
    // a lattice cell (centre x, z) the patch lifts that much at a corner or one sample beyond: the toe cell under a riser,
    // and the crease where a riser meets rising ground, are the rock's
    if (u < -8 || u > r.deep || Math.abs(s) > r.side) return false;
    for (const ox of [-3, -1, 1, 3]) for (const oz of [-3, -1, 1, 3]) if (lift(x + ox, z + oz) > NEED_ROCK_LIFT) return true;
    return false;
  });
}

export function runLipsGate(recipe: WorldRecipe, opts: { near?: [number, number, number]; aliasTol?: number; maxSlope?: number; lipTol?: number; allow?: string[]; exceptions?: LipsException[] } = {}): LipsResult & { faults: (TerrainLipFault & { owner: string })[]; excepted: number } {
  const field = createWorldField(recipe);
  const reference = createWorldField({ ...recipe, features: { ...recipe.features, heightPatches: [], roads: [] } });
  let list = owners(recipe);
  if (opts.near) {
    const [nx, nz, nr] = opts.near;
    list = list.filter((o) => o.box[0] < nx + nr && o.box[2] > nx - nr && o.box[1] < nz + nr && o.box[3] > nz - nr);
  }
  const allow = new Set(opts.allow ?? []);
  // documented exceptions: single lattice cells of one owner, reported as excepted, never counted
  const excCells = new Map<string, Set<string>>();
  // keyed by the road's BASE id: piece numbers (`.s2`, `.2.s3`) shift whenever routing upstream changes (2026-10-28 s1e: the
  // river-1 abutment cell stayed put while its piece went from .s3 to .s2 and the gate failed on a documented cell)
  for (const e of opts.exceptions ?? []) { const key = pieceBase(e.id); const set = excCells.get(key) ?? new Set<string>(); for (const [cx, cz] of e.cells) set.add(`${Math.round(cx)},${Math.round(cz)}`); excCells.set(key, set); }
  let excepted = 0;
  const riser = terraceRiserBand(recipe);
  const built = builtMassBand(recipe, (x, z) => field.height(x, z));
  const cut = openCutBand(recipe, (x, z) => field.height(x, z));
  const withoutTerrace = (fid: string) => createWorldField({
    ...recipe,
    features: {
      ...recipe.features,
      heightPatches: recipe.features.heightPatches.filter((p) => p.id !== fid),
      passages: (recipe.features.passages ?? []).filter((p) => !p.id.startsWith(`${fid}-`)),
      terraceWalls: (recipe.features.terraceWalls ?? []).filter((t) => `tw-${t.id}` !== fid),
    },
  });
  const withoutPatch = (fid: string) => createWorldField({ ...recipe, features: { ...recipe.features, heightPatches: recipe.features.heightPatches.filter((p) => p.id !== fid) } });
  const rows: LipsResult["owners"] = [];
  const all: (TerrainLipFault & { owner: string })[] = [];
  const totals = { alias: 0, step: 0, lip: 0, cells: 0, touched: 0 };
  // measured owner by owner; a cell in two bands is attributed to the edit that made it (else to the nearer band)
  const maker = cellMaker(recipe, field);
  const inRock = needRockAt(recipe, (x, z) => field.height(x, z) - reference.height(x, z));
  for (const o of list) {
    let [x0, z0, x1, z1] = o.box;
    if (opts.near) {
      const [nx, nz, nr] = opts.near;
      x0 = Math.max(x0, nx - nr); z0 = Math.max(z0, nz - nr); x1 = Math.min(x1, nx + nr); z1 = Math.min(z1, nz + nr);
    }
    if (x1 <= x0 || z1 <= z0) continue;
    const others = list.filter((q) => q !== o && q.box[0] < x1 && q.box[2] > x0 && q.box[1] < z1 && q.box[3] > z0);
    // a terrace wall's patch (`tw-*`) is levelled ground under built works, blended back into whatever was there,
    // trails included: it is measured against the world without IT, so a trail's own teeth inside its raster are
    // not charged to it
    // an OPERATOR patch (`op:<id>:*`) is composed on the ground the operators before it made (recipe order: a scree fan
    // heaped on a landmark pad's slope): measured against the world without IT, so the pad's own faults stay the pad's
    const ref = o.kind === "patch" && o.id.startsWith("tw-") ? withoutTerrace(o.id) : o.kind === "patch" && o.id.startsWith("op:") ? withoutPatch(o.id) : reference;
    const rep = measureTerrainLips(field, ref, {
      x0, z0, x1, z1,
      // a ground-need patch (`need-*`, worldgen needs) IS a rock face: its 45-60 deg face is the point, so only a wall
      // steeper than NEED_FACE_MAX_SLOPE counts (2026-10-29 redstrand w6: the weeping-sun scarp read as 1173 steps)
      aliasTol: opts.aliasTol, maxSlope: o.kind === "patch" && o.id.startsWith("need-") ? Math.max(opts.maxSlope ?? 1.6, NEED_FACE_MAX_SLOPE) : opts.maxSlope, lipTol: opts.lipTol,
      lipTolAt: o.kind === "patch" && o.id.startsWith("need-") ? (x, z) => (inRock(x, z) ? Math.max(opts.lipTol ?? 0.75, NEED_ROCK_LIP) : undefined) : undefined,
      // a cell a need face also moved is that face's rock wherever it stands: a road cut deepening its toe is charged to
      // the road, at the face's slope (the steepest tolerance of the edits that moved the cell)
      maxSlopeAt: (x, z) => {
        const rivals = others.filter((q) => q.band(x, z) <= 0);
        const need = o.kind === "patch" && o.id.startsWith("need-") ? true : rivals.length ? maker(x, z, [o, ...rivals]).moved.some((k) => k.startsWith("patch:need-")) : false;
        if (!need) return undefined;
        // a cliff need's own rock stands near-vertical; everything else it moved keeps the need-face cap
        return Math.max(opts.maxSlope ?? 1.6, inRock(x, z) ? NEED_ROCK_MAX_SLOPE : NEED_FACE_MAX_SLOPE);
      },
      include: (x, z) => {
        const mine = o.band(x, z);
        if (mine > 0) return false;
        if (riser(x, z)) return false;
        if (built(x, z)) return false;
        if (cut(x, z)) return false;
        const rivals = others.filter((q) => q.band(x, z) <= 0);
        if (!rivals.length) return true;
        const { made } = maker(x, z, [o, ...rivals]);
        if (made && made !== `${o.kind}:${o.id}`) return false;
        // made by this edit (or by none): the nearest band among the claimants (a long road is several owners, one id)
        for (const q of rivals) if ((!made || (q.kind === o.kind && q.id === o.id)) && q.band(x, z) < mine) return false;
        return true;
      },
    });
    const exc = excCells.get(pieceBase(o.id));
    if (exc) {
      const kept = rep.faults.filter((f) => !exc.has(`${Math.round(f.x)},${Math.round(f.z)}`));
      for (const f of rep.faults) if (!kept.includes(f)) { excepted++; rep.counts[f.kind as keyof typeof rep.counts]--; }
      rep.faults = kept;
      for (const k of Object.keys(rep.worst) as (keyof typeof rep.worst)[]) rep.worst[k] = Math.max(0, ...kept.filter((f) => f.kind === k).map((f) => f.size));
    }
    totals.cells += rep.cells;
    totals.touched += rep.touchedCells;
    const worst = Math.max(rep.worst.alias, rep.worst.step, rep.worst.lip);
    const n = rep.counts.alias + rep.counts.step + rep.counts.lip;
    if (n > 0) {
      const row = rows.find((q) => q.id === o.id && q.kind === o.kind);
      if (row) { row.alias += rep.counts.alias; row.step += rep.counts.step; row.lip += rep.counts.lip; row.worst = Math.max(row.worst, worst); row.run = Math.max(row.run, rep.longestRun); }
      else rows.push({ kind: o.kind, id: o.id, alias: rep.counts.alias, step: rep.counts.step, lip: rep.counts.lip, worst, run: rep.longestRun, allowed: allow.has(o.id) });
      if (!allow.has(o.id)) { totals.alias += rep.counts.alias; totals.step += rep.counts.step; totals.lip += rep.counts.lip; }
      for (const f of rep.faults) all.push({ ...f, owner: o.id });
    }
  }
  rows.sort((a, b) => b.alias + b.step + b.lip - (a.alias + a.step + a.lip));
  return { ok: totals.alias + totals.step + totals.lip === 0, owners: rows, totals, faults: all, excepted };
}

export function commandLips(host: LipsHost): void {
  const { argv } = host;
  const { recipe, file } = host.loadRecipe();
  const exceptions = file && !argv.includes("--no-exceptions") ? readLipsExceptions(file) : [];
  const nearArg = str(argv, "near");
  let near: [number, number, number] | undefined;
  if (nearArg) {
    near = nearArg.split(",").map(Number) as [number, number, number];
    if (near.length !== 3 || !near.every(Number.isFinite)) host.fail("--near wants x,z,r");
  }
  const allow = (str(argv, "allow") ?? "").split(",").filter(Boolean);
  const t0 = Date.now();
  const res = runLipsGate(recipe, { near, aliasTol: num(argv, "alias", 0.5), maxSlope: num(argv, "max-slope", 1.6), lipTol: num(argv, "lip", 0.75), allow, exceptions });
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ ok: res.ok, totals: res.totals, owners: res.owners, excepted: res.excepted }, null, 1));
  } else {
    console.log(`lips ${recipe.name}${near ? ` near ${near.join(",")}` : ""}: ${res.totals.touched}/${res.totals.cells} edited lattice cells in edge bands, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    console.log(`  alias (sawtooth) ${res.totals.alias}   step (wall) ${res.totals.step}   lip (rim/slot) ${res.totals.lip}${res.excepted ? `   excepted ${res.excepted} (documented: ${lipsExceptionsFile(file!)})` : ""}`);
    for (const r of res.owners.slice(0, argv.includes("--list") ? Infinity : 25)) {
      console.log(`  ${r.allowed ? "allowed " : ""}${r.kind} ${r.id}: alias ${r.alias}, step ${r.step}, lip ${r.lip}; worst ${r.worst.toFixed(2)} m; longest run ${r.run} cells`);
    }
    if (argv.includes("--list")) {
      for (const f of [...res.faults].sort((a, b) => b.size - a.size).slice(0, 200)) console.log(`    ${f.kind} ${f.owner} @ ${f.x.toFixed(0)},${f.z.toFixed(0)}  ${f.size} m`);
    }
    console.log(res.ok ? "OK: no edit draws sharper than the lattice" : "FAIL: widen the patch feather / lower edgeSlope, set a road maxCut or a wider shoulder; see docs/voxel-worlds.md \"Height-patch edges\"");
  }
  if (!res.ok) process.exitCode = 1;
}

export function commandSeated(host: LipsHost): void {
  const { argv } = host;
  const { recipe } = host.loadRecipe();
  const slabs: { id?: string; x: number; z: number; halfX: number; halfZ: number; yaw?: number; baseY: number }[] = [];
  const file = str(argv, "slabs");
  if (file) slabs.push(...JSON.parse(fs.readFileSync(file, "utf8")));
  argv.forEach((a, i) => {
    if (a !== "--slab") return;
    const v = (argv[i + 1] ?? "").split(",").map(Number);
    if (v.length !== 6 || !v.every(Number.isFinite)) host.fail("--slab wants x,z,halfX,halfZ,yawDeg,baseY");
    slabs.push({ id: `slab${slabs.length}`, x: v[0]!, z: v[1]!, halfX: v[2]!, halfZ: v[3]!, yaw: (v[4]! * Math.PI) / 180, baseY: v[5]! });
  });
  // --wall <opId> (repeatable) / --walls (every installed wall operator): the baked wall's bottom against the ground,
  // per <= 4 m segment; daylight under any segment > --wall-gap (0.05 m) fails (tools/_wall-seated.mts)
  const wallIds = argv.flatMap((a, i) => (a === "--wall" ? [argv[i + 1] ?? ""] : []));
  // (a causeway ramp is a deck over its own cut, not a wall standing on the ground: not judged here)
  if (argv.includes("--walls")) for (const o of recipe.features.operators ?? []) if ((o as { op?: string }).op === "wall" && (o as { variant?: string }).variant !== "ramp" && !wallIds.includes(o.id)) wallIds.push(o.id);
  if (wallIds.length) {
    const maxWallGap = num(argv, "wall-gap", 0.05), worldGround = visibleWorldGround(recipe);
    let badWalls = 0;
    const out: WallSeatReport[] = [];
    for (const id of wallIds) {
      const r = wallSeat(recipe, id, { maxGap: maxWallGap, ground: worldGround });
      out.push(r);
      if (!r.ok) badWalls++;
      if (!argv.includes("--json")) {
        console.log(`  ${r.ok ? "ok  " : "FAIL"} wall ${id}: ${r.segments.length} segments over ${r.length} m, worst gap ${r.worst} m${r.worstAt ? ` @ ${r.worstAt.join(",")}` : ""}${r.bad ? `, ${r.bad} segment(s) show daylight` : ""}${r.samples ? "" : " (no samples)"}${r.stale ? `; STALE: ${r.stale}` : ""}`);
        for (const sg of r.segments) if (sg.gap > maxWallGap || argv.includes("--list")) console.log(`      ${sg.from}-${sg.to} m @ ${sg.at.join(",")}: gap ${sg.gap} m`);
      }
    }
    if (argv.includes("--json")) console.log(JSON.stringify({ ok: !badWalls, walls: out }, null, 1));
    else { const lit = out.filter((r) => r.bad > 0).length, stale = out.filter((r) => r.stale).length; console.log(badWalls ? `FAIL: ${lit} wall(s) show daylight under a segment (gap > ${maxWallGap} m), ${stale} stale bake(s), of ${wallIds.length}: re-apply (worldgen op --apply <id>) + re-bake (tools/landmark.mts) the wall, or deepen footing.depth` : `OK: ${wallIds.length} wall(s) seated`); }
    // --out <file>: the report the town pipeline judges (zonegen status row `town <name>: wall`)
    const outFile = str(argv, "out");
    if (outFile) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify({ ok: !badWalls, maxGap: maxWallGap, walls: out.map(({ segments, ...r }) => ({ ...r, faults: segments.filter((s) => s.gap > maxWallGap) })) }, null, 1) + "\n");
    }
    if (badWalls) process.exitCode = 1;
    if (!slabs.length) return;
  }
  if (!slabs.length) host.fail("give --slab x,z,halfX,halfZ,yawDeg,baseY (repeatable), --slabs <file.json> ([{id,x,z,halfX,halfZ,yaw(rad),baseY}]), --wall <opId> or --walls");
  const field = createWorldField(recipe);
  const maxGap = num(argv, "gap", 0.25), maxClip = num(argv, "clip", 0.6);
  // the REAL solid (seat.ts): a stair cut, a carve or a planar tread is ground; the drawn heightfield is not the
  // truth there (--drawn keeps the old lattice-height reading). Objects other than slabs: `worldgen float`.
  const probe = argv.includes("--drawn") ? null : fieldSolidProbe(field);
  const ground = probe ? (x: number, z: number, y: number): number => probe.floor(x, z, y + maxClip + 2, y - 30) ?? -Infinity : undefined;
  // --allow id,id: slabs proved seated another way (e.g. a density probe where the drawn height() cannot see a cut) are
  // reported, never counted (as lips --allow); the reason belongs in the caller's evidence
  const allow = new Set((str(argv, "allow") ?? "").split(",").filter(Boolean));
  let bad = 0, allowed = 0;
  for (const s of slabs) {
    const r = seatReport(field, s, 1, ground);
    const over = r.gap > maxGap || r.clip > maxClip, ok = !over || allow.has(s.id ?? ""), fail = !ok;
    if (fail) bad++; else if (over) allowed++;
    console.log(`  ${fail ? "FAIL" : over ? "allow" : "ok  "} ${s.id ?? ""} @ ${s.x.toFixed(1)},${s.z.toFixed(1)}: gap ${r.gap} m, clip ${r.clip} m`);
  }
  console.log(bad ? `FAIL: ${bad}/${slabs.length} slabs not seated (gap > ${maxGap} m or clip > ${maxClip} m)${allowed ? `, ${allowed} allowed` : ""}` : `OK: ${slabs.length} slabs seated${allowed ? ` (${allowed} allowed by --allow)` : ""}`);
  if (bad) process.exitCode = 1;
}

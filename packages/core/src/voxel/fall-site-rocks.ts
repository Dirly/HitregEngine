/**
 * Where a fall site's rocks actually go: the hand-placed `rocks` stood on the
 * carved surface, and the automatic `walls` dressing bedded into the gorge's
 * cliff faces.
 *
 * Both read the MESHED surface, not the heightfield. `field.height` is the 2D
 * ground — before the 3D blobs a site builds its buttresses from, before
 * overhangs — and the terrain the player sees is marching cubes run over the
 * density sampled on the voxel lattice, which on a 2 m lattice is a metre or
 * more off the exact surface wherever the ground is steep. A rock stood on
 * `height + lift` floated wherever those three disagreed (every gorge wall and
 * pool rim). So every query here goes through `meshDensity`: the field's
 * density at the lattice corners the mesher sampled, trilinearly blended —
 * whose zero set is what marching cubes triangulates.
 *
 * Output instances are the scatter rule's own (chunk.ts turns them into the
 * rule's instanced prop), so a site of three hundred rocks costs no new draw
 * call. Pure, deterministic (seeded by the site id), no DOM.
 */

import { hashUnit } from "./noise.js";
import { marchingCubes } from "./marching-cubes.js";
import type { WorldField, RiverFall } from "./field.js";
import type { FallSiteDoc } from "./fall-sites.js";
import type { RiverDoc, ScatterDoc } from "./recipe.js";
import { rockFormationSolid, type RockFormationSolid } from "./rock-formations.js";

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

export interface SiteRockInstance {
  id: string;
  rule: string;
  ruleIndex: number;
  /** World position of the model's origin (its base centre). */
  position: Vec3;
  rotation: Quat;
  scale: number;
}

/** The surface marching cubes meshes: lattice-corner density, trilinearly blended. */
export interface MeshDensity {
  (x: number, y: number, z: number): number;
  /** Outward unit normal (toward air) from the blended density's gradient. */
  normal(x: number, y: number, z: number): Vec3;
  /** Topmost crossing into solid marching down from `fromY` to `toY`, or null (also when `fromY` is inside rock). */
  down(x: number, z: number, fromY: number, toY: number): number | null;
  /**
   * Is this point inside the terrain AS MESHED? Inside the prefetched box this
   * is answered from the marching-cubes triangles themselves (the parity of the
   * surface crossings above the point in its column), so it agrees with the
   * rendered and collided mesh exactly; outside it, the blended density's sign.
   */
  solid(x: number, y: number, z: number): boolean;
  /** Inside one of the site's rock formations (set by `withFormations`; absent when the site has none). */
  inFormation?(x: number, y: number, z: number): boolean;
}

/** A world-space box (metres) to prefetch through the mesher's own bulk sampler. */
export interface DensityBox {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

export function meshDensity(field: WorldField, box?: DensityBox): MeshDensity {
  const step = field.voxelSize;
  const corners = new Map<string, number>();
  // The box goes through `sampleBlock` — the very call the mesher makes, with
  // column heights resolved once per (x, z) — so it is both exactly the values
  // marching cubes sees and far cheaper than per-corner `density` calls.
  let bi0 = 0;
  let bj0 = 0;
  let bk0 = 0;
  let bnx = 0;
  let bny = 0;
  let bnz = 0;
  let block: Float32Array | null = null;
  if (box) {
    bi0 = Math.floor(box.x0 / step);
    bj0 = Math.floor(box.y0 / step);
    bk0 = Math.floor(box.z0 / step);
    bnx = Math.ceil(box.x1 / step) - bi0 + 2;
    bny = Math.ceil(box.y1 / step) - bj0 + 2;
    bnz = Math.ceil(box.z1 / step) - bk0 + 2;
    block = field.sampleBlock({ origin: [bi0 * step, bj0 * step, bk0 * step], nx: bnx, ny: bny, nz: bnz, step });
  }
  const corner = (i: number, j: number, k: number): number => {
    if (block) {
      const a = i - bi0;
      const b = j - bj0;
      const c = k - bk0;
      if (a >= 0 && b >= 0 && c >= 0 && a < bnx && b < bny && c < bnz) return block[a + b * bnx + c * bnx * bny]!;
    }
    const key = `${i},${j},${k}`;
    let v = corners.get(key);
    if (v === undefined) {
      v = field.density(i * step, j * step, k * step);
      corners.set(key, v);
    }
    return v;
  };
  const sample = ((x: number, y: number, z: number): number => {
    const fx = x / step;
    const fy = y / step;
    const fz = z / step;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const k = Math.floor(fz);
    const tx = fx - i;
    const ty = fy - j;
    const tz = fz - k;
    const c00 = corner(i, j, k) * (1 - tx) + corner(i + 1, j, k) * tx;
    const c10 = corner(i, j + 1, k) * (1 - tx) + corner(i + 1, j + 1, k) * tx;
    const c01 = corner(i, j, k + 1) * (1 - tx) + corner(i + 1, j, k + 1) * tx;
    const c11 = corner(i, j + 1, k + 1) * (1 - tx) + corner(i + 1, j + 1, k + 1) * tx;
    const c0 = c00 * (1 - ty) + c10 * ty;
    const c1 = c01 * (1 - ty) + c11 * ty;
    return c0 * (1 - tz) + c1 * tz;
  }) as MeshDensity;
  sample.normal = (x, y, z) => {
    const e = step * 0.5;
    const gx = sample(x + e, y, z) - sample(x - e, y, z);
    const gy = sample(x, y + e, z) - sample(x, y - e, z);
    const gz = sample(x, y, z + e) - sample(x, y, z - e);
    const len = Math.hypot(gx, gy, gz) || 1;
    return [gx / len, gy / len, gz / len];
  };
  // The box's own marching-cubes mesh: the very triangles a chunk cuts from
  // this lattice (a cell's triangles depend on its eight corners only), in
  // 2 m XZ buckets for column queries. Trilinear density is not that surface —
  // inside a cell the two part by up to a cell where a blob's edge is thinner
  // than the lattice (2.1 m measured at a site blob), which is exactly where
  // a rock bedded against the density reads floating or buried on screen.
  let crossingsAt: ((x: number, z: number) => number[]) | null = null;
  let meshY0 = 0;
  let meshY1 = 0;
  let meshX0 = 0;
  let meshX1 = 0;
  let meshZ0 = 0;
  let meshZ1 = 0;
  if (block) {
    const origin: Vec3 = [bi0 * step, bj0 * step, bk0 * step];
    const mc = marchingCubes({ values: block, nx: bnx, ny: bny, nz: bnz, origin, step });
    meshX0 = origin[0] + step;
    meshY0 = origin[1] + step;
    meshZ0 = origin[2] + step;
    meshX1 = origin[0] + step * (bnx - 2);
    meshY1 = origin[1] + step * (bny - 2);
    meshZ1 = origin[2] + step * (bnz - 2);
    const P = mc.positions;
    const I = mc.indices;
    const B = 2;
    const buckets = new Map<number, number[]>();
    const keyOf = (i: number, k: number): number => (i + 50000) * 100003 + (k + 50000);
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t]! * 3;
      const b = I[t + 1]! * 3;
      const c = I[t + 2]! * 3;
      const i0 = Math.floor(Math.min(P[a]!, P[b]!, P[c]!) / B);
      const i1 = Math.floor(Math.max(P[a]!, P[b]!, P[c]!) / B);
      const k0 = Math.floor(Math.min(P[a + 2]!, P[b + 2]!, P[c + 2]!) / B);
      const k1 = Math.floor(Math.max(P[a + 2]!, P[b + 2]!, P[c + 2]!) / B);
      for (let i = i0; i <= i1; i++) {
        for (let k = k0; k <= k1; k++) {
          const key = keyOf(i, k);
          let list = buckets.get(key);
          if (!list) buckets.set(key, (list = []));
          list.push(t);
        }
      }
    }
    crossingsAt = (x, z) => {
      const out: number[] = [];
      for (const t of buckets.get(keyOf(Math.floor(x / B), Math.floor(z / B))) ?? []) {
        const a = I[t]! * 3;
        const b = I[t + 1]! * 3;
        const c = I[t + 2]! * 3;
        const ax = P[a]!, az = P[a + 2]!, bx = P[b]!, bz = P[b + 2]!, cx = P[c]!, cz = P[c + 2]!;
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(d) < 1e-12) continue;
        const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
        const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-7 || l2 < -1e-7 || l3 < -1e-7) continue;
        out.push(l1 * P[a + 1]! + l2 * P[b + 1]! + l3 * P[c + 1]!);
      }
      out.sort((p, q) => p - q);
      // a line through a shared edge or vertex hits two triangles at one height
      let w = 0;
      for (let r = 0; r < out.length; r++) if (w === 0 || out[r]! - out[w - 1]! > 1e-4) out[w++] = out[r]!;
      out.length = w;
      return out;
    };
  }
  const inMesh = (x: number, y: number, z: number): boolean =>
    crossingsAt !== null && x > meshX0 && x < meshX1 && z > meshZ0 && z < meshZ1 && y > meshY0 && y < meshY1;
  sample.solid = (x, y, z) => {
    if (!inMesh(x, y, z)) return sample(x, y, z) < 0;
    let above = 0;
    for (const c of crossingsAt!(x, z)) if (c > y) above++;
    // the box's top is closed where the column is still rock there
    const topSolid = sample(x, meshY1 - 1e-3, z) < 0;
    return (above % 2 === 1) !== topSolid;
  };
  sample.down = (x, z, fromY0, toY0) => {
    // clamp the search to the box's height; a column still rock at the box's
    // top has its surface above the box — report the box top for it
    const fromY = Math.min(fromY0, meshY1 - 1e-3);
    const toY = Math.max(toY0, meshY0 + 1e-3);
    if (fromY > toY && inMesh(x, fromY, z) && inMesh(x, toY, z)) {
      if (sample.solid(x, fromY, z)) return fromY0 > fromY ? fromY : null;
      const cs = crossingsAt!(x, z);
      for (let r = cs.length - 1; r >= 0; r--) {
        const c = cs[r]!;
        if (c > fromY) continue;
        if (c < toY) break;
        if (sample.solid(x, c - 0.02, z)) return c;
      }
      return null;
    }
    const dy = step * 0.25;
    let prevY = fromY;
    let prev = sample(x, fromY, z);
    if (prev < 0) return null; // started inside rock: no free surface in range
    for (let y = fromY - dy; y >= toY; y -= dy) {
      const d = sample(x, y, z);
      if (d < 0) return prevY + (y - prevY) * (prev / (prev - d));
      prevY = y;
      prev = d;
    }
    return null;
  };
  return sample;
}

/** A rule's model extent [x, height, z] in model units: its box collider when it has one. */
export function ruleExtent(rule: ScatterDoc): Vec3 {
  if (rule.collider === "box") return [rule.colliderSize[0], rule.colliderSize[1], rule.colliderSize[2]];
  const f = rule.footprint > 0 ? rule.footprint * 2 : 1.5;
  return [f, f * 0.7, f];
}

/** The free surface (air above, solid below) nearest `near` in the column (x, z), searching [lo, hi]. */
function surfaceNear(md: MeshDensity, x: number, z: number, near: number, lo: number, hi: number): number | null {
  // every free surface in the column, top down: `down` from above each one
  let best: number | null = null;
  let from = hi;
  for (let guard = 0; guard < 16 && from > lo; guard++) {
    const c = md.down(x, z, from, lo);
    if (c === null) {
      // started in rock: step down through it to the next air
      let y = from - 0.25;
      while (y > lo && md.solid(x, y, z)) y -= 0.25;
      if (y <= lo) break;
      from = y;
      continue;
    }
    if (best === null || Math.abs(c - near) < Math.abs(best - near)) best = c;
    from = c - 0.3;
  }
  return best;
}

function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** Tilt taking +Y toward `n` by `amount` (0 upright, 1 fully onto the slope). */
function tiltToward(n: Vec3, amount: number): Quat {
  if (n[1] > 0.999999 || amount <= 0) return [0, 0, 0, 1];
  // from-to (0,1,0) -> n: axis = up x n = (n.z, 0, -n.x)
  const q: Quat = [n[2], 0, -n[0], 1 + n[1]];
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  const out: Quat = [(q[0] / len) * amount, 0, (q[2] / len) * amount, (q[3] / len) * amount + (1 - amount)];
  const l2 = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
  return [out[0] / l2, out[1] / l2, out[2] / l2, out[3] / l2];
}

type RockBase = Omit<SiteRockInstance, "position" | "rotation">;

function frameRock(base: RockBase, position: Vec3, rotation: Quat, extent: Vec3): WallRock {
  return {
    ...base,
    position,
    rotation,
    X: rotate(rotation, [1, 0, 0]),
    N: rotate(rotation, [0, 1, 0]),
    Z: rotate(rotation, [0, 0, 1]),
    extent,
  };
}

/**
 * A hand-placed site rock stood on the meshed surface, or null when it cannot
 * be bedded where it was put.
 *
 * The ground is the free surface NEAREST the heightfield's `height` (what the
 * author's snapshot showed) — not simply the topmost: under a buttress blob
 * that would lift a pool-rim rock onto the buttress. A resting rock (lift at
 * most 0.3) is laid onto the plane through its footprint ring by the rule's
 * `alignToNormal`, then lowered along its own axis (by at most 45 % of its
 * height) until no point of the ring hangs more than 0.15 m off the ground.
 * One whose footprint still hangs, stood on a site blob metres away from the
 * height the author saw, is dropped: it was authored inside rock (invisible)
 * and the only place left for it is the brink of a buttress. A stacked rock
 * (lift > 0.3) stays upright at ground + lift, as authored.
 */
export function standSiteRock(
  md: MeshDensity,
  field: WorldField,
  rule: ScatterDoc,
  rock: FallSiteDoc["rocks"][number],
  base: RockBase,
  ground?: number,
  index: RockIndex = new RockIndex(),
): WallRock | null {
  const [x, z] = rock.at;
  const g = field.height(x, z);
  const centre = ground ?? siteRockGround(md, field, x, z);
  const extent = ruleExtent(rule);
  const [ex, ey, ez] = extent;
  const s = rock.scale;
  const yaw: Quat = [0, Math.sin(rock.yaw / 2), 0, Math.cos(rock.yaw / 2)];
  if (rock.lift > 0.3) return frameRock(base, [x, centre + rule.yOffset * s + rock.lift, z], yaw, extent);
  // plane through the footprint ring: dy = a*dx + b*dz by least squares
  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  let sxy = 0;
  let szy = 0;
  let cnt = 0;
  for (let n = 0; n < 8; n++) {
    const a = (n / 8) * Math.PI * 2;
    const [dx, , dz] = rotate(yaw, [Math.cos(a) * ex * 0.4 * s, 0, Math.sin(a) * ez * 0.4 * s]);
    const y = surfaceNear(md, x + dx, z + dz, centre, centre - ey * s * 3 - 2, centre + ey * s * 3 + 2);
    if (y === null) continue;
    const dy = y - centre;
    sxx += dx * dx;
    szz += dz * dz;
    sxz += dx * dz;
    sxy += dx * dy;
    szy += dz * dy;
    cnt++;
  }
  let rotation = yaw;
  const det = sxx * szz - sxz * sxz;
  if (cnt >= 4 && Math.abs(det) > 1e-6) {
    const a = (sxy * szz - szy * sxz) / det;
    const b = (szy * sxx - sxy * sxz) / det;
    rotation = quatMul(tiltToward(norm([-a, 1, -b]), rule.alignToNormal), yaw);
  }
  const lower = ey * s * 0.45;
  // sink until it is bedded AND held up (rockSupport: support under its
  // lowest points and around its centre of mass, not mere contact)
  let placed: WallRock | null = null;
  let firstHeld: WallRock | null = null;
  for (let sink = 0; sink <= lower + 1e-6; sink += 0.1) {
    const r = frameRock(base, [x, centre, z], rotation, extent);
    r.position = [x - r.N[0] * sink, centre - r.N[1] * sink, z - r.N[2] * sink];
    const bed = rockBedding(md, r);
    if (bed.buried) break; // sinking further only buries it more
    if (rockSupport(md, r, index) !== "supported") continue;
    firstHeld ??= r;
    if (Math.max(bed.hang, rimExposure(md, r) - 0.15) <= 0.15) {
      placed = r;
      break;
    }
  }
  placed ??= firstHeld;
  if (!placed) return null; // nothing holds it up where it was put
  void g;
  const off = rule.yOffset * s;
  placed.position = [
    placed.position[0] + placed.N[0] * off,
    placed.position[1] + placed.N[1] * off + rock.lift,
    placed.position[2] + placed.N[2] * off,
  ];
  return placed;
}

/** The ground a hand rock stands on: the meshed free surface nearest the heightfield's height there. */
export function siteRockGround(md: MeshDensity, field: WorldField, x: number, z: number): number {
  const g = field.height(x, z);
  return surfaceNear(md, x, z, g, g - 20, g + 16) ?? g;
}

/**
 * Every hand-placed rock of a site stood on the mesh (null where one was
 * dropped). A stacked rock (lift > 0.3) is lifted from the ground of the
 * resting rock it stands on — the nearest within 2.5 m — not from the ground
 * under its own centre: on a steep rim those differ by metres, and a stack
 * measured from its own ground came apart (a 1.3 m gap measured on
 * site-river-15-21).
 */
export function standSiteRocks(md: MeshDensity, field: WorldField, site: FallSiteDoc): (WallRock | null)[] {
  const recipe = field.recipe;
  const out: (WallRock | null)[] = site.rocks.map(() => null);
  const index = new RockIndex();
  // resting rocks first, then each stacked rock (lowest lift first) on
  // whatever is already placed under it
  const order = site.rocks.map((_, n) => n).sort((p, q) => site.rocks[p]!.lift - site.rocks[q]!.lift);
  for (const n of order) {
    const rock = site.rocks[n]!;
    const ruleIndex = recipe.scatter.findIndex((s) => s.id === rock.rule);
    const rule = recipe.scatter[ruleIndex];
    if (!rule) continue;
    const base = { id: `${site.id}-rock-${n}`, rule: rule.id, ruleIndex, scale: rock.scale };
    if (rock.lift <= 0.3) {
      out[n] = standSiteRock(md, field, rule, rock, base, undefined, index);
      if (out[n]) index.add(out[n]!);
      continue;
    }
    // A stacked rock sits ON the rock(s) under it: the highest top face of a
    // placed rock within reach, at this rock's centre, bedded 10 % of its
    // height into it. Measured from the ground instead (even the support's
    // ground), a stack came apart as soon as its base rock was tilted onto
    // the slope and sunk: 0.4 m gaps on site-river-15-21.
    const [x, z] = rock.at;
    let top = -Infinity;
    for (const o of out) {
      if (!o || Math.hypot(o.position[0] - x, o.position[2] - z) > 2.5) continue;
      // only a rock whose footprint is under this column holds it up
      const dx = x - o.position[0];
      const dz = z - o.position[2];
      const lx = (dx * o.X[0] + dz * o.X[2]) / o.scale;
      const lz = (dx * o.Z[0] + dz * o.Z[2]) / o.scale;
      if (Math.abs(lx) > o.extent[0] * 0.45 || Math.abs(lz) > o.extent[2] * 0.45) continue;
      const tx = o.position[0] + o.N[0] * o.extent[1] * o.scale;
      const ty = o.position[1] + o.N[1] * o.extent[1] * o.scale;
      const tz = o.position[2] + o.N[2] * o.extent[1] * o.scale;
      // the top plane (normal N through the top centre) at this rock's column
      const y = ty - ((x - tx) * o.N[0] + (z - tz) * o.N[2]) / Math.max(0.3, o.N[1]);
      top = Math.max(top, Math.min(y, ty));
    }
    const extent = ruleExtent(rule);
    const yaw: Quat = [0, Math.sin(rock.yaw / 2), 0, Math.cos(rock.yaw / 2)];
    if (top === -Infinity) {
      out[n] = standSiteRock(md, field, rule, rock, base, undefined, index);
      if (out[n]) index.add(out[n]!);
      continue;
    }
    // seated into the rock below until it is held (or dropped)
    let held: WallRock | null = null;
    for (let bed = 0.1; bed <= 0.45 + 1e-9 && !held; bed += 0.05) {
      const r = frameRock(base, [x, top - extent[1] * rock.scale * bed, z], yaw, extent);
      if (rockSupport(md, r, index) === "supported") held = r;
    }
    out[n] = held;
    if (held) index.add(held);
  }
  return out;
}

/** Solved rock instances per field and site. */
const cache = new WeakMap<WorldField, Map<string, SiteRockInstance[]>>();

/**
 * Every rock instance of one fall site: its hand-placed `rocks` stood on the
 * mesh, then its `walls` dressing. Solved once per field and site and cached,
 * so chunk builds only filter it. The site's box is prefetched through the
 * mesher's bulk sampler, so the solve costs about as much as meshing a few
 * cells.
 */
export function fallSiteRockInstances(field: WorldField, site: FallSiteDoc): readonly SiteRockInstance[] {
  let perField = cache.get(field);
  if (!perField) {
    perField = new Map();
    cache.set(field, perField);
  }
  const hit = perField.get(site.id);
  if (hit) return hit;
  const recipe = field.recipe;
  const md = withFormations(meshDensity(field, siteBox(field, site)), field, site);
  const out: SiteRockInstance[] = [];
  for (const r of standSiteRocks(md, field, site)) {
    if (r) out.push({ id: r.id, rule: r.rule, ruleIndex: r.ruleIndex, position: r.position, rotation: r.rotation, scale: r.scale });
  }
  for (const r of wallRocks(field, md, site)) {
    out.push({ id: r.id, rule: r.rule, ruleIndex: r.ruleIndex, position: r.position, rotation: r.rotation, scale: r.scale });
  }
  perField.set(site.id, out);
  return out;
}

/**
 * The site's rock formations (`site.formations`, core rock-formations.ts) as an
 * OBSTACLE for the rocks. Without it the scree stood on terrain a formation
 * covers — half inside a mass, or under an overhang — which read as rocks
 * floating beside the falls; `intersectsFormation` now rejects those.
 *
 * Deliberately not a SUPPORT: the bake drops formation pieces that fail its
 * support checks (rock-formations-check.mts), and a scree rock resting on a
 * dropped piece would float. Resting on the terrain only, a rock is held up
 * whatever the bake keeps. The solid is regenerated from the same options the
 * placed volume was built with, so the two cannot drift.
 */
export function withFormations(md: MeshDensity, field: WorldField, site: FallSiteDoc): MeshDensity {
  if (!site.formations) return md;
  let solid: RockFormationSolid | null;
  try {
    solid = rockFormationSolid(field, { id: site.id, course: site.course, at: site.at }, site.formations);
  } catch {
    return md;
  }
  if (!solid) return md;
  const rock = solid;
  const joined = ((x: number, y: number, z: number) => md(x, y, z)) as MeshDensity;
  joined.normal = md.normal;
  joined.down = md.down;
  joined.solid = md.solid;
  joined.inFormation = (x, y, z) => rock.density(x, y, z) < 0;
  return joined;
}

/** The world box a site's rocks can touch: its walls' span plus its hand rocks, padded. */
export function siteBox(field: WorldField, site: FallSiteDoc): DensityBox | undefined {
  const span = siteSpan(field, site);
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  const pad = (site.walls?.reach ?? 20) + 2;
  const above = site.walls?.band[1] ?? 10;
  if (span) {
    for (let s = span.s0; s <= span.s1; s += 2) {
      const st = stationAt(span.river, span.arc, s);
      x0 = Math.min(x0, st.x - pad);
      x1 = Math.max(x1, st.x + pad);
      z0 = Math.min(z0, st.z - pad);
      z1 = Math.max(z1, st.z + pad);
      y0 = Math.min(y0, st.level - 12);
      y1 = Math.max(y1, st.level + above + 8);
    }
  }
  for (const rock of site.rocks) {
    const g = field.height(rock.at[0], rock.at[1]);
    x0 = Math.min(x0, rock.at[0] - 6);
    x1 = Math.max(x1, rock.at[0] + 6);
    z0 = Math.min(z0, rock.at[1] - 6);
    z1 = Math.max(z1, rock.at[1] + 6);
    y0 = Math.min(y0, g - 22);
    y1 = Math.max(y1, g + 18);
  }
  if (!Number.isFinite(x0)) return undefined;
  return { x0, y0, z0, x1, y1, z1 };
}

/** One point of the gorge's wall, found by marching out from the channel. */
export interface WallSample {
  x: number;
  y: number;
  z: number;
  n: Vec3;
  /** Water level at this station: the base of the tier the wall stands over. */
  base: number;
  /** Drop of the tier this wall stands over (m): what `u` (height up the wall) is measured against. */
  tierDrop: number;
  /** Lateral distance of the channel edge (m) that a rock may not reach inside. */
  keepOut: number;
  /** Station's centreline point and the outward lateral direction. */
  cx: number;
  cz: number;
  px: number;
  pz: number;
}

/** The river and falls a site dresses, and the arc span of its walls. */
function siteSpan(field: WorldField, site: FallSiteDoc): {
  river: RiverDoc;
  falls: RiverFall[];
  arc: number[];
  s0: number;
  s1: number;
} | null {
  let nearest: RiverFall | null = null;
  let best = 60;
  for (const f of field.falls) {
    const d = Math.hypot(f.x - site.at[0], f.z - site.at[1]);
    if (d < best) {
      best = d;
      nearest = f;
    }
  }
  if (!nearest) return null;
  const river = field.rivers.find((r) => r.id === nearest!.river);
  if (!river || !river.surfaceY || river.surfaceY.length !== river.points.length) return null;
  const falls = field.falls
    .filter((f) => f.river === river.id && Math.hypot(f.x - site.at[0], f.z - site.at[1]) < 90)
    .sort((a, b) => b.top - a.top);
  const arc = [0];
  for (let k = 1; k < river.points.length; k++) {
    const a = river.points[k - 1]!;
    const b = river.points[k]!;
    arc.push(arc[k - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const arcOf = (x: number, z: number): number => {
    let bestD = Infinity;
    let bestS = 0;
    for (let k = 1; k < river.points.length; k++) {
      const a = river.points[k - 1]!;
      const b = river.points[k]!;
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / len2));
      const d = Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);
      if (d < bestD) {
        bestD = d;
        bestS = arc[k - 1]! + Math.sqrt(len2) * t;
      }
    }
    return bestS;
  };
  const first = falls[0]!;
  const last = falls[falls.length - 1]!;
  const lastPool = site.tiers.length > 0 ? site.tiers[site.tiers.length - 1]!.pool : 16;
  // from the top lip line (3 m upstream of its foot) — upstream of it is the
  // lake's shore, where a wall rock is a tooth standing on flat ground
  const s0 = arcOf(first.x, first.z) - 3 - (site.walls?.upstream ?? 0);
  const s1 = arcOf(last.x, last.z) + lastPool;
  return { river, falls, arc, s0, s1 };
}

/** River centreline, tangent, water level and width at arc length s. */
function stationAt(river: RiverDoc, arc: number[], s: number) {
  let k = 1;
  while (k < arc.length - 1 && arc[k]! < s) k++;
  const a = river.points[k - 1]!;
  const b = river.points[k]!;
  const len = arc[k]! - arc[k - 1]! || 1;
  const t = Math.max(0, Math.min(1, (s - arc[k - 1]!) / len));
  const level = river.surfaceY![k - 1]! + (river.surfaceY![k]! - river.surfaceY![k - 1]!) * t;
  const w = river.widths && river.widths.length === river.points.length ? river.widths[k - 1]! + (river.widths[k]! - river.widths[k - 1]!) * t : river.width;
  return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, tx: (b[0] - a[0]) / len, tz: (b[1] - a[1]) / len, level, width: w };
}

/** Every wall point of a site on a `spacing` grid (arc × height), both sides. */
export function wallSamples(field: WorldField, md: MeshDensity, site: FallSiteDoc, spacing = 1): WallSample[] {
  const walls = site.walls;
  const span = siteSpan(field, site);
  if (!walls || !span) return [];
  const { river, falls, arc, s0, s1 } = span;
  const [below, above] = walls.band;
  const out: WallSample[] = [];
  const reach = walls.reach;
  const dl = 0.5;
  for (let s = s0; s <= s1; s += spacing) {
    const st = stationAt(river, arc, s);
    if (Math.hypot(st.x - site.at[0], st.z - site.at[1]) > 80) continue;
    // the tier this station's pool sits under: the nearest fall upstream
    let tierDrop = 8;
    for (const f of falls) if (f.bottom <= st.level + 0.5) {
      tierDrop = Math.max(tierDrop, f.top - f.bottom);
      break;
    }
    // beside a falling sheet the curtain hangs 1.5 m into the rock either side
    let nearFall = false;
    for (const f of falls) {
      const along = (st.x - f.x) * f.dirX + (st.z - f.z) * f.dirZ;
      if (along > -6 && along < 3) nearFall = true;
    }
    const keepOut = st.width / 2 + (nearFall ? 1.5 : 0.3);
    for (const side of [1, -1]) {
      const px = -st.tz * side;
      const pz = st.tx * side;
      let misses = 0;
      for (let y = st.level - below; y <= st.level + above; y += spacing) {
        if (md(st.x, y, st.z) < 0) continue; // under the bed (or a lip) here
        let prev = md(st.x, y, st.z);
        let hitL = -1;
        for (let l = dl; l <= reach; l += dl) {
          const d = md(st.x + px * l, y, st.z + pz * l);
          if (d < 0) {
            hitL = l - dl + dl * (prev / (prev - d));
            break;
          }
          prev = d;
        }
        if (hitL < 0) {
          if (y > st.level + 4 && ++misses >= 2) break; // over the wall top
          continue;
        }
        misses = 0;
        const x = st.x + px * hitL;
        const z = st.z + pz * hitL;
        const n = md.normal(x, y, z);
        // a wall: steep, and facing back into the gorge
        if (Math.abs(n[1]) > 0.72) continue;
        if (n[0] * -px + n[2] * -pz < 0.2) continue;
        out.push({ x, y, z, n, base: st.level, tierDrop, keepOut, cx: st.x, cz: st.z, px, pz });
      }
    }
  }
  return out;
}

function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Quaternion of the rotation whose columns are the orthonormal basis (X, Y, Z). */
function quatFromBasis(X: Vec3, Y: Vec3, Z: Vec3): Quat {
  const m00 = X[0], m10 = X[1], m20 = X[2];
  const m01 = Y[0], m11 = Y[1], m21 = Y[2];
  const m02 = Z[0], m12 = Z[1], m22 = Z[2];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** A placed wall rock with its frame, for the coverage and bedding tests. */
export interface WallRock extends SiteRockInstance {
  X: Vec3;
  N: Vec3;
  Z: Vec3;
  extent: Vec3;
}

/** Does this rock cover the wall at p (p on the surface)? Its footprint ellipse, in its own frame. */
export function rockCovers(r: WallRock, p: Vec3, shrink = 0.85): boolean {
  const rx = p[0] - r.position[0];
  const ry = p[1] - r.position[1];
  const rz = p[2] - r.position[2];
  const s = r.scale;
  const ly = (rx * r.N[0] + ry * r.N[1] + rz * r.N[2]) / s;
  if (ly < -0.6 * r.extent[1] || ly > r.extent[1]) return false;
  const lx = (rx * r.X[0] + ry * r.X[1] + rz * r.X[2]) / s / (r.extent[0] * 0.5 * shrink);
  const lz = (rx * r.Z[0] + ry * r.Z[1] + rz * r.Z[2]) / s / (r.extent[2] * 0.5 * shrink);
  return lx * lx + lz * lz <= 1;
}

/**
 * How far a rock's base hangs off the wall: the worst distance, along -N, from
 * a point of its footprint ring (and its centre) to the meshed surface.
 * 0 when every point is bedded. `buried` when even its outer face is inside
 * solid rock.
 */
export function rockBedding(md: MeshDensity, r: WallRock): { hang: number; centreHang: number; buried: boolean } {
  const s = r.scale;
  const [ex, ey, ez] = r.extent;
  const hangAt = (p: Vec3): number => {
    if (md.solid(p[0], p[1], p[2])) return 0;
    for (let t = 0.1; t <= 4; t += 0.1) {
      if (md.solid(p[0] - r.N[0] * t, p[1] - r.N[1] * t, p[2] - r.N[2] * t)) return t;
    }
    return 4;
  };
  const at = (lx: number, ly: number, lz: number): Vec3 => [
    r.position[0] + (r.X[0] * lx + r.N[0] * ly + r.Z[0] * lz) * s,
    r.position[1] + (r.X[1] * lx + r.N[1] * ly + r.Z[1] * lz) * s,
    r.position[2] + (r.X[2] * lx + r.N[2] * ly + r.Z[2] * lz) * s,
  ];
  const centreHang = hangAt(at(0, 0, 0));
  let hang = centreHang;
  for (let n = 0; n < 8; n++) {
    const a = (n / 8) * Math.PI * 2;
    hang = Math.max(hang, hangAt(at(Math.cos(a) * ex * 0.5 * 0.7, 0, Math.sin(a) * ez * 0.5 * 0.7)));
  }
  // buried: most of its outer face inside the terrain (a 3 x 3 grid over it;
  // 6 of 9 here, one under the audit's 7, for margin
  // density and the triangles marching cubes cuts from it)
  let inside = 0;
  for (const u of [-1, 0, 1]) {
    for (const v of [-1, 0, 1]) {
      const k = u !== 0 && v !== 0 ? 0.75 : 1;
      if (md.solid(...at(u * ex * 0.5 * 0.85 * k, ey, v * ez * 0.5 * 0.85 * k))) inside++;
    }
  }
  return { hang, centreHang, buried: inside >= 6 };
}

/**
 * How far any exposed part of a rock rises over the ground beside it (m), or
 * -Infinity when none does. For each of its box's outer corners and edge
 * midpoints that is in open air, the ground "beside" it is the column 1.5 m
 * and 3 m straight into the wall (horizontally, against the rock's normal):
 * if neither column holds any solid within 0.3 m below that point or anywhere
 * above it, the point sticks up past the rim into the sky. A part inside the
 * terrain is hidden and does not count; mid-wall the column behind is solid
 * at once, so the test is cheap everywhere but at the rim.
 */
export function rimExposure(md: MeshDensity, r: WallRock, back?: readonly [number, number]): number {
  const s = r.scale;
  const [ex, ey, ez] = r.extent;
  // "behind" is toward the wall: given (a resting rock's up axis says nothing
  // about where the wall is), else the rock's own normal in plan
  const hl = back ? Math.hypot(back[0], back[1]) : Math.hypot(r.N[0], r.N[2]);
  const bx = hl > 1e-3 ? (back ? back[0] : r.N[0]) / hl : 0;
  const bz = hl > 1e-3 ? (back ? back[1] : r.N[2]) / hl : 0;
  let worst = -Infinity;
  // three rings (0.7, 0.8 and 0.9 of the half extents) over three heights: the
  // sky-line test is local, so a sparse ring can step over a poking corner
  for (const ly of [ey * 0.35, ey * 0.7, ey]) for (const f of [0.7, 0.8, 0.9]) {
    for (const [u, v] of [[-1, -1], [-1, 1], [1, -1], [1, 1], [0, 1], [0, -1], [1, 0], [-1, 0], [0, 0]] as const) {
      if (f !== 0.7 && u === 0 && v === 0) continue;
      const lx = u * ex * 0.5 * f;
      const lz = v * ez * 0.5 * f;
      const x = r.position[0] + (r.X[0] * lx + r.N[0] * ly + r.Z[0] * lz) * s;
      const y = r.position[1] + (r.X[1] * lx + r.N[1] * ly + r.Z[1] * lz) * s;
      const z = r.position[2] + (r.X[2] * lx + r.N[2] * ly + r.Z[2] * lz) * s;
      if (md.solid(x, y, z)) continue;
      let beside = -Infinity;
      for (const d of [1.5, 3]) {
        const cx = x - bx * d * (back ? -1 : 1);
        const cz = z - bz * d * (back ? -1 : 1);
        // the column's top, if it reaches up to (y - 0.3) at all
        if (md.solid(cx, y - 0.3, cz)) {
          beside = Infinity;
          break;
        }
        const top = md.down(cx, cz, y + 40, y - 0.3);
        if (top !== null) {
          beside = Infinity;
          break;
        }
        const below = md.down(cx, cz, y - 0.3, y - 30);
        if (below !== null) beside = Math.max(beside, below);
      }
      if (beside === Infinity) continue;
      worst = Math.max(worst, beside === -Infinity ? 30 : y - beside);
    }
  }
  return worst;
}

/** Why candidate scree rocks were turned down in the last solve (diagnostics for the scratch tools). */
export const screeRejects: Record<string, number> = {};
const reject = (why: string): false => {
  screeRejects[why] = (screeRejects[why] ?? 0) + 1;
  return false;
};

/** A 3 x 3 x 3 lattice over a rock's box (x, z at ±0.45 of the extent, y at 5/50/95 %): the points every test below reads. */
export function rockLattice(r: WallRock): Vec3[] {
  const s = r.scale;
  const [ex, ey, ez] = r.extent;
  const out: Vec3[] = [];
  for (const v of [0.05, 0.5, 0.95]) {
    for (const u of [-1, 0, 1]) {
      for (const w of [-1, 0, 1]) {
        const lx = u * ex * 0.45;
        const ly = v * ey;
        const lz = w * ez * 0.45;
        out.push([
          r.position[0] + (r.X[0] * lx + r.N[0] * ly + r.Z[0] * lz) * s,
          r.position[1] + (r.X[1] * lx + r.N[1] * ly + r.Z[1] * lz) * s,
          r.position[2] + (r.X[2] * lx + r.N[2] * ly + r.Z[2] * lz) * s,
        ]);
      }
    }
  }
  return out;
}

/**
 * Does rock r pass through a formation? Its bedded foot may sink into a ledge
 * like into the ground, but more than one point of its middle and top layers
 * inside a mass means it stands half in it (seen from outside: a rock growing
 * out of the face, or one hanging off it).
 */
export function intersectsFormation(md: MeshDensity, r: WallRock): boolean {
  if (!md.inFormation) return false;
  const lattice = rockLattice(r);
  let inside = 0;
  for (let i = 9; i < lattice.length; i++) if (md.inFormation(...lattice[i]!)) inside++;
  return inside > 1;
}

/** Is p inside rock r's box (shrunk by `k`)? */
export function insideRockBox(r: WallRock, p: Vec3, k = 0.95): boolean {
  const dx = p[0] - r.position[0];
  const dy = p[1] - r.position[1];
  const dz = p[2] - r.position[2];
  const s = r.scale;
  const lx = (dx * r.X[0] + dy * r.X[1] + dz * r.X[2]) / s;
  const ly = (dx * r.N[0] + dy * r.N[1] + dz * r.N[2]) / s;
  const lz = (dx * r.Z[0] + dy * r.Z[1] + dz * r.Z[2]) / s;
  return Math.abs(lx) <= r.extent[0] * 0.5 * k && ly >= 0 && ly <= r.extent[1] * k && Math.abs(lz) <= r.extent[2] * 0.5 * k;
}

/** Placed rocks in 6 m XZ buckets, for the support and overlap queries. */
export class RockIndex {
  readonly all: WallRock[] = [];
  private cells = new Map<number, WallRock[]>();
  private key(i: number, k: number): number {
    return (i + 50000) * 100003 + (k + 50000);
  }
  add(r: WallRock): void {
    this.all.push(r);
    const rad = Math.hypot(r.extent[0], r.extent[1], r.extent[2]) * r.scale;
    const i0 = Math.floor((r.position[0] - rad) / 6);
    const i1 = Math.floor((r.position[0] + rad) / 6);
    const k0 = Math.floor((r.position[2] - rad) / 6);
    const k1 = Math.floor((r.position[2] + rad) / 6);
    for (let i = i0; i <= i1; i++) {
      for (let k = k0; k <= k1; k++) {
        const key = this.key(i, k);
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, (list = []));
        list.push(r);
      }
    }
  }
  near(x: number, z: number): readonly WallRock[] {
    return this.cells.get(this.key(Math.floor(x / 6), Math.floor(z / 6))) ?? [];
  }
  inside(p: Vec3, self?: WallRock): boolean {
    for (const o of this.near(p[0], p[2])) if (o !== self && insideRockBox(o, p)) return true;
    return false;
  }
}

export type SupportStatus = "supported" | "outcrop" | "none";

/**
 * Is a rock held up? The rule every site rock must pass (replacing mere
 * contact, which a slab touching a vertical wall passes while plainly hanging
 * in the air):
 *
 * - supported: every point of its LOWER layer that is lowest (within 0.3 m of
 *   its lowest point), and enough of the rest of that layer, has terrain or an
 *   already placed rock within 0.15 m straight below it (the audit allows
 *   0.2: the margin keeps the two agreeing), and the points that do
 *   surround its centre of mass in plan (so it cannot tip off);
 * - outcrop: at least `embed` of its lattice is inside the terrain, and no
 *   exposed point stands more than `overhang` metres out from the terrain
 *   along its own -up axis (it is a face of the wall, not a thing on it);
 * - none: neither — drop it.
 */
export function rockSupport(md: MeshDensity, r: WallRock, index: RockIndex, embed = 0.6, overhang = 0.5): SupportStatus {
  const pts = rockLattice(r);
  let inside = 0;
  for (const p of pts) if (md.solid(p[0], p[1], p[2])) inside++;
  const s = r.scale;
  const cx = r.position[0] + r.N[0] * r.extent[1] * s * 0.5;
  const cz = r.position[2] + r.N[2] * r.extent[1] * s * 0.5;
  // (i) resting: the lower half of the lattice by world height
  const sorted = pts.map((p, i) => [p[1], i] as const).sort((a, b) => a[0] - b[0]);
  const low = sorted.slice(0, 14);
  const minY = low[0]![0];
  const held: Vec3[] = [];
  let lowestHeld = true;
  for (const [y, i] of low) {
    const p = pts[i]!;
    let ok = false;
    for (let t = 0; t <= 0.15 + 1e-9 && !ok; t += 0.05) {
      const q: Vec3 = [p[0], p[1] - t, p[2]];
      if (md.solid(q[0], q[1], q[2]) || index.inside(q, r)) ok = true;
    }
    if (ok) held.push(p);
    else if (y < minY + 0.3) lowestHeld = false;
  }
  if (lowestHeld && held.length >= 3 && surrounds(held, cx, cz)) return "supported";
  // (ii) outcrop
  if (inside / pts.length >= embed) {
    let worst = 0;
    for (const p of pts) {
      if (md.solid(p[0], p[1], p[2])) continue;
      let t = 0;
      while (t < overhang + 0.3 && !md.solid(p[0] - r.N[0] * t, p[1] - r.N[1] * t, p[2] - r.N[2] * t)) t += 0.1;
      worst = Math.max(worst, t);
    }
    if (worst <= overhang) return "outcrop";
  }
  return "none";
}

/** Do the plan positions of `pts` surround (cx, cz)? No half-plane through it may hold them all (largest angular gap < 180 degrees). */
function surrounds(pts: readonly Vec3[], cx: number, cz: number): boolean {
  const angles: number[] = [];
  for (const p of pts) {
    const dx = p[0] - cx;
    const dz = p[2] - cz;
    if (Math.hypot(dx, dz) < 0.05) return true; // held right under the centre
    angles.push(Math.atan2(dz, dx));
  }
  angles.sort((a, b) => a - b);
  let gap = angles[0]! + Math.PI * 2 - angles[angles.length - 1]!;
  for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i]! - angles[i - 1]!);
  return gap < Math.PI - 0.05;
}

/** A point of ground (a bench, a wall toe, a pool rim) something can rest on. */
interface GroundSample {
  x: number;
  y: number;
  z: number;
  n: Vec3;
  base: number;
  keepOut: number;
  cx: number;
  cz: number;
  px: number;
  pz: number;
  tx: number;
  tz: number;
  /** Horizontal distance (m) outward to the wall rising behind it; Infinity where there is none within 6 m. */
  wall: number;
}

/** Every free surface gentle enough to rest on (normal y > 0.72, under ~45 degrees), both sides of the channel, on a 1 m grid. */
function groundSamples(field: WorldField, md: MeshDensity, site: FallSiteDoc, span: NonNullable<ReturnType<typeof siteSpan>>): GroundSample[] {
  const walls = site.walls!;
  const [below, above] = walls.band;
  const out: GroundSample[] = [];
  for (let s = span.s0; s <= span.s1; s += 1) {
    const st = stationAt(span.river, span.arc, s);
    if (Math.hypot(st.x - site.at[0], st.z - site.at[1]) > 80) continue;
    let nearFall = false;
    for (const f of span.falls) {
      const along = (st.x - f.x) * f.dirX + (st.z - f.z) * f.dirZ;
      if (along > -6 && along < 3) nearFall = true;
    }
    const keepOut = st.width / 2 + (nearFall ? 1.5 : 0.3);
    for (const side of [1, -1]) {
      const px = -st.tz * side;
      const pz = st.tx * side;
      for (let l = keepOut; l <= walls.reach; l += 1) {
        const x = st.x + px * l;
        const z = st.z + pz * l;
        let from = st.level + above;
        for (let guard = 0; guard < 8; guard++) {
          const y = md.down(x, z, from, st.level - below - 1);
          if (y === null) {
            let yy = from - 0.25;
            while (yy > st.level - below && md.solid(x, yy, z)) yy -= 0.25;
            if (yy <= st.level - below) break;
            from = yy;
            continue;
          }
          from = y - 0.5;
          const n = md.normal(x, y + 0.05, z);
          if (n[1] < 0.72) continue; // nothing on a face steeper than ~45 degrees
          const w = field.waterY(x, z);
          if (w !== null && y < w - 0.2) continue; // under water
          let wall = Infinity;
          for (let d = 0.5; d <= 6; d += 0.5) {
            if (md.solid(x + px * d, y + 1.5, z + pz * d)) {
              wall = d;
              break;
            }
          }
          out.push({ x, y, z, n, base: st.level, keepOut, cx: st.x, cz: st.z, px, pz, tx: st.tx, tz: st.tz, wall });
        }
      }
    }
  }
  return out;
}

/** An orthonormal rock frame: up axis `Y`, long axis (model Z) as close to `along` as it can be, spun by `spin`. */
function rockFrame(Y: Vec3, along: Vec3, spin: number): { X: Vec3; Z: Vec3 } {
  const d = along[0] * Y[0] + along[1] * Y[1] + along[2] * Y[2];
  let t = norm([along[0] - Y[0] * d, along[1] - Y[1] * d, along[2] - Y[2] * d]);
  if (!Number.isFinite(t[0])) t = norm(Math.abs(Y[1]) < 0.9 ? cross(Y, [0, 1, 0]) : cross(Y, [1, 0, 0]));
  const b = cross(Y, t);
  const Z = norm([t[0] * Math.cos(spin) + b[0] * Math.sin(spin), t[1] * Math.cos(spin) + b[1] * Math.sin(spin), t[2] * Math.cos(spin) + b[2] * Math.sin(spin)]);
  return { X: cross(Y, Z), Z };
}

function makeRock(id: string, rule: ScatterDoc, ruleIndex: number, extent: Vec3, position: Vec3, Y: Vec3, along: Vec3, spin: number, scale: number): WallRock {
  const { X, Z } = rockFrame(Y, along, spin);
  return { id, rule: rule.id, ruleIndex, position, rotation: quatFromBasis(X, Y, Z), scale, X, N: Y, Z, extent };
}

/** Fraction of r's lattice inside already placed rocks. */
function overlapFraction(r: WallRock, index: RockIndex): number {
  const pts = rockLattice(r);
  let n = 0;
  for (const p of pts) if (index.inside(p, r)) n++;
  return n / pts.length;
}

/** No lattice point of r (at its lower two layers) inside the channel: lateral from the centreline at least keepOut. */
function clearOfChannel(r: WallRock, cx: number, cz: number, px: number, pz: number, keepOut: number): boolean {
  for (const p of rockLattice(r)) if ((p[0] - cx) * px + (p[2] - cz) * pz < keepOut) return false;
  return true;
}

/** Clear of every lip line: by the rock's size along the flow, around the lip's height. */
function clearOfLips(r: WallRock, falls: readonly RiverFall[]): boolean {
  const radius = Math.max(r.extent[0], r.extent[2]) * 0.5 * r.scale;
  for (const f of falls) {
    const lx = f.x - f.dirX * 3;
    const lz = f.z - f.dirZ * 3;
    const along = Math.abs((r.position[0] - lx) * f.dirX + (r.position[2] - lz) * f.dirZ);
    const across = Math.abs((r.position[0] - lx) * -f.dirZ + (r.position[2] - lz) * f.dirX);
    if (along < radius + 1.5 && across < f.reach + radius && r.position[1] + radius > f.top - 1.5 && r.position[1] - radius < f.top + 2.5) return false;
  }
  return true;
}

/** The rock's highest lattice point. */
function rockTop(r: WallRock): number {
  let top = -Infinity;
  for (const p of rockLattice(r)) top = Math.max(top, p[1]);
  const s = r.scale;
  return Math.max(top, r.position[1] + r.N[1] * r.extent[1] * s);
}

/**
 * The gorge rim behind a ground point: the highest ground surface along the
 * level ray from it out into the wall (2-24 m). Scree must stay well under
 * it — a rock on the plateau above the rim, or taller than the bank it leans
 * on, stands against the sky.
 */
function rimBehind(md: MeshDensity, x: number, y: number, z: number, px: number, pz: number): number {
  let rim = y;
  for (let d = 2; d <= 24; d += 2) {
    const cx = x + px * d;
    const cz = z + pz * d;
    const top = md.down(cx, cz, y + 60, y - 10);
    if (top !== null) rim = Math.max(rim, top);
    else if (md.solid(cx, y + 60, cz)) rim = Math.max(rim, y + 60);
  }
  return rim;
}

function ruleOf(recipe: WorldField["recipe"], id: string | undefined, fallback: string): { rule: ScatterDoc; ruleIndex: number; extent: Vec3 } | null {
  const ruleIndex = recipe.scatter.findIndex((s) => s.id === (id ?? fallback));
  const rule = recipe.scatter[ruleIndex];
  return rule ? { rule, ruleIndex, extent: ruleExtent(rule) } : null;
}

/**
 * The walls dressing: scree RESTING at each tier's foot around its plunge
 * pool, on bench ledges and at the wall toes. Candidates are the gentle
 * ground (under ~45 degrees) both sides of the channel, ordered low-on-the-
 * tier and close-to-a-toe-or-the-water first (so they cluster there), then
 * the tops of rocks already placed; biggest first. Each rock is bedded a
 * little into what it lands on, pushed back toward the wall, and kept only if
 * `rockSupport` finds it supported — and it stays under the rim, out of the
 * channel, off the lip lines and mostly clear of the others. Seeded by the
 * site id. (Big masses and wall faces are rock volumes, not this.)
 */
export function wallRocks(field: WorldField, md: MeshDensity, site: FallSiteDoc): WallRock[] {
  const walls = site.walls;
  if (!walls) return [];
  const span = siteSpan(field, site);
  if (!span) return [];
  const recipe = field.recipe;
  const seed = seedOf(site.id);
  const index = new RockIndex();
  const out: WallRock[] = [];
  const up: Vec3 = [0, 1, 0];
  const nextId = (): string => `${site.id}-wall-${out.length}`;
  const accept = (r: WallRock): void => {
    r.id = nextId();
    out.push(r);
    index.add(r);
  };
  for (const k of Object.keys(screeRejects)) delete screeRejects[k];
  const common = (r: WallRock, rim: number, maxOverlap: number): boolean =>
    (clearOfLips(r, span.falls) || reject("lip")) &&
    (rockTop(r) <= rim - 0.5 || reject("rim")) &&
    (overlapFraction(r, index) <= maxOverlap || reject("overlap")) &&
    (!rockBedding(md, r).buried || reject("buried")) &&
    (!intersectsFormation(md, r) || reject("formation"));

  const ground = groundSamples(field, md, site, span);

  // ---- (b) medium, (c) small: resting, bottom-up
  const rest = (tier: { max: number; scale: [number, number] }, salt: number): void => {
    const rr = ruleOf(recipe, undefined, walls.rule);
    if (!rr) return;
    const { rule, ruleIndex, extent } = rr;
    type Cand = { x: number; y: number; z: number; n: Vec3; g: GroundSample; wall: number; key: number };
    // clustered: low on the tier, at a wall toe or the pool's edge first
    // only at a wall toe or bench (a face rising within 6 m behind) or at the
    // pool's edge (within 2 m of its level): a gentle hillside above the gorge
    // is not scree ground
    const cands: Cand[] = ground.filter((g) => g.wall < 8 || g.y - g.base < 3).map((g, i) => ({
      x: g.x, y: g.y, z: g.z, n: g.n, g, wall: g.wall,
      key: (g.y - g.base) * 0.6 + Math.min(g.wall, 6, Math.max(0, (g.x - g.cx) * g.px + (g.z - g.cz) * g.pz - g.keepOut) + 1) + hashUnit(i, salt, 1, seed) * 3,
    }));
    // the tops of rocks already placed are ground too
    const nearest = (x: number, z: number): GroundSample => {
      let best = ground[0]!;
      let bd = Infinity;
      for (const g of ground) {
        const d = (g.x - x) ** 2 + (g.z - z) ** 2;
        if (d < bd) {
          bd = d;
          best = g;
        }
      }
      return best;
    };
    out.forEach((o, n) => {
      if (o.N[1] < 0.6) return;
      for (const [u, w] of [[0, 0], [-0.3, 0], [0.3, 0], [0, -0.3], [0, 0.3]] as const) {
        const lx = u * o.extent[0] * o.scale;
        const lz = w * o.extent[2] * o.scale;
        const ly = o.extent[1] * o.scale;
        const x = o.position[0] + o.X[0] * lx + o.N[0] * ly + o.Z[0] * lz;
        const y = o.position[1] + o.X[1] * lx + o.N[1] * ly + o.Z[1] * lz;
        const z = o.position[2] + o.X[2] * lx + o.N[2] * ly + o.Z[2] * lz;
        if (md.solid(x, y + 0.2, z)) continue;
        const g = nearest(x, z);
        cands.push({ x, y, z, n: o.N, g, wall: Math.max(0, g.wall - 1), key: (y - g.base) * 0.6 + hashUnit(n, salt, 2, seed) * 3 });
      }
    });
    cands.sort((a, b) => a.key - b.key);
    // (rocks placed in this pass become ground for the ones after: see below)
    let placed = 0;
    for (let ci = 0; ci < cands.length && placed < tier.max; ci++) {
      const c = cands[ci]!;
      if (index.inside([c.x, c.y + 0.3, c.z])) continue;
      // inside the gorge only: a real wall must rise at least 3 m behind it
      // (a point on the plateau at the rim has none — scree there stands on
      // the skyline)
      if (rimBehind(md, c.x, c.y, c.z, c.g.px, c.g.pz) < c.y + 3) {
        reject("plateau");
        continue;
      }
      for (const k of [1, 0.8, 0.65]) {
        const [s0, s1] = tier.scale;
        const fill = placed / Math.max(1, tier.max);
        const scale = (s0 + (s1 - s0) * Math.max(0, Math.min(1, 1 - fill + (hashUnit(ci, salt, 3, seed) - 0.5) * 0.6))) * k;
        const height = extent[1] * scale;
        const Y = norm([c.n[0] * 0.5 + (hashUnit(ci, salt, 4, seed) - 0.5) * 0.15, 1, c.n[2] * 0.5 + (hashUnit(ci, salt, 5, seed) - 0.5) * 0.15]);
        const half = extent[0] * 0.5 * scale;
        const push = Number.isFinite(c.wall) ? Math.max(0, c.wall - half * 0.8) : 0;
        const bed = (0.12 + 0.12 * hashUnit(ci, salt, 6, seed) + (k < 1 ? 0.12 : 0)) * height;
        const pos: Vec3 = [c.x + c.g.px * push, c.y - bed, c.z + c.g.pz * push];
        // re-seat on whatever is under the pushed position (the ground may have risen toward the wall)
        const under = md.down(pos[0], pos[2], pos[1] + height + bed, pos[1] - 2);
        if (under !== null && under > pos[1] + bed) pos[1] = under - bed;
        const r = makeRock("", rule, ruleIndex, extent, pos, Y, [c.g.tx, 0, c.g.tz], (hashUnit(ci, salt, 7, seed) - 0.5) * 0.7, scale);
        if (!clearOfChannel(r, c.g.cx, c.g.cz, c.g.px, c.g.pz, c.g.keepOut)) {
          reject("channel");
          continue;
        }
        const low = rockLattice(r).reduce((a, q) => (q[1] < a[1] ? q : a));
        if (!common(r, rimBehind(md, low[0], low[1], low[2], c.g.px, c.g.pz) - 0.3, 0.2)) continue;
        if (rockSupport(md, r, index) !== "supported") {
          reject("unsupported");
          continue;
        }
        accept(r);
        placed++;
        // its top is somewhere a later, smaller rock may rest
        if (r.N[1] > 0.6) {
          const ly = r.extent[1] * r.scale;
          const x = r.position[0] + r.N[0] * ly;
          const y = r.position[1] + r.N[1] * ly;
          const z = r.position[2] + r.N[2] * ly;
          const top: Cand = { x, y, z, n: r.N, g: c.g, wall: Math.max(0, c.wall - 1), key: c.key + 1.5 };
          let at = ci + 1;
          while (at < cands.length && cands[at]!.key < top.key) at++;
          cands.splice(at, 0, top);
        }
        break;
      }
    }
  };
  rest({ max: walls.max, scale: walls.scale }, 31);
  return out;
}

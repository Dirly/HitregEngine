/* scratch: numeric audit of one crafted fall site (river-15 cascade by default), from the field + real chunk meshes.
 *   npx tsx tools/_site-audit.mts [river] [siteId] [recipe.json]
 * Checks: (a) lake/pool water past its lip or under ground, (b) floating / buried site rocks,
 * (c) steep wall area not covered by rock paint or rock instances, (d) hovering flat water "shards" near lips,
 * (e) tier heights + pool sizes. Prints a table + PASS/FAIL per check. Read-only: builds everything in memory. */
import fs from "node:fs";
import { buildVoxelMesh, createWorldField, scatterCell, voxelChunkDoc, worldRecipeSchema } from "@hitreg/core";

const river = process.argv[2] ?? "river-15";
const siteId = process.argv[3] ?? "site-river-15-21";
const file = process.argv[4] ?? "projects/proving/assets/worlds/mmo.json";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
const t0 = performance.now();
const field = createWorldField(recipe);
const S = recipe.cellSize;
const LIP_OFFSET = 3; // chunk.ts FALL_LIP_OFFSET: the lip line stands this far upstream of a fall's foot

const falls = field.falls.filter((f) => f.river === river).sort((a, b) => b.top - a.top);
if (falls.length === 0) throw new Error(`no falls on ${river}`);
const site = (recipe.features.fallSites ?? []).find((s) => s.id === siteId);
const top = falls[0]!, bot = falls[falls.length - 1]!;
const fdx = bot.dirX, fdz = bot.dirZ;
// site box: 45 m upstream of the top lip to 45 m past the foot, +-45 m across
const ax = top.x - top.dirX * 45, az = top.z - top.dirZ * 45, bx = bot.x + fdx * 45, bz = bot.z + fdz * 45;
const minX = Math.min(ax, bx) - 45, maxX = Math.max(ax, bx) + 45, minZ = Math.min(az, bz) - 45, maxZ = Math.max(az, bz) + 45;
const ccx = (top.x + bot.x) / 2, ccz = (top.z + bot.z) / 2;

// ---------------------------------------------------------------- meshes
type Tri = { ax: number; ay: number; az: number; bx: number; by: number; bz: number; cx: number; cy: number; cz: number };
const terrainTris: Tri[] = [];
const terrainSplat: Float32Array[] = []; // per tri: averaged splat
const waterTris: (Tri & { kind: "water" | "fall"; id: string })[] = [];
const rockInst: { rule: string; x: number; y: number; z: number; yaw: number; scale: number; site: boolean }[] = [];
const rockRules = new Set(recipe.scatter.filter((s) => /rock|stone|boulder/i.test(s.id)).map((s) => s.id));
const cells: [number, number][] = [];
for (let cx = Math.floor(minX / S); cx <= Math.floor(maxX / S); cx++) for (let cz = Math.floor(minZ / S); cz <= Math.floor(maxZ / S); cz++) cells.push([cx, cz]);
const nS = field.surfaceCount;
for (const [cx, cz] of cells) {
  const x0 = cx * S, z0 = cz * S;
  const m = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [cx, cz] } as never);
  const p = m.positions, idx = m.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const i = idx[t]!, j = idx[t + 1]!, k = idx[t + 2]!;
    terrainTris.push({ ax: p[i * 3]! + x0, ay: p[i * 3 + 1]!, az: p[i * 3 + 2]! + z0, bx: p[j * 3]! + x0, by: p[j * 3 + 1]!, bz: p[j * 3 + 2]! + z0, cx: p[k * 3]! + x0, cy: p[k * 3 + 1]!, cz: p[k * 3 + 2]! + z0 });
    const sp = new Float32Array(nS);
    for (let s = 0; s < nS; s++) sp[s] = (m.splat[i * nS + s]! + m.splat[j * nS + s]! + m.splat[k * nS + s]!) / 3;
    terrainSplat.push(sp);
  }
  const doc = voxelChunkDoc(field, "w", cx, cz, { scatter: false, collision: false });
  for (const [id, e] of Object.entries(doc.entities)) {
    if (!(id.startsWith("water") || id.startsWith("fall_"))) continue;
    const src = (e.components["mesh"] as { source: { positions: number[]; indices: number[] } }).source;
    const q = src.positions, ix = src.indices;
    for (let t = 0; t < ix.length; t += 3) {
      const i = ix[t]!, j = ix[t + 1]!, k = ix[t + 2]!;
      waterTris.push({ kind: id.startsWith("fall_") ? "fall" : "water", id: `${cx}_${cz}/${id}`, ax: q[i * 3]! + x0, ay: q[i * 3 + 1]!, az: q[i * 3 + 2]! + z0, bx: q[j * 3]! + x0, by: q[j * 3 + 1]!, bz: q[j * 3 + 2]! + z0, cx: q[k * 3]! + x0, cy: q[k * 3 + 1]!, cz: q[k * 3 + 2]! + z0 });
    }
  }
  for (const inst of scatterCell(field, cx, cz)) {
    if (!rockRules.has(inst.rule)) continue;
    const yaw = 2 * Math.atan2((inst as { rotation?: number[] }).rotation?.[1] ?? 0, (inst as { rotation?: number[] }).rotation?.[3] ?? 1);
    rockInst.push({ rule: inst.rule, x: x0 + inst.position[0], y: inst.position[1], z: z0 + inst.position[2], yaw, scale: inst.scale, site: false });
  }
}
for (const r of site?.rocks ?? []) rockInst.push({ rule: r.rule, x: r.at[0], y: field.height(r.at[0], r.at[1]) + r.lift, z: r.at[1], yaw: r.yaw, scale: r.scale, site: true });

// ground sampler over the real terrain triangles (2 m buckets)
const B = 2;
const buckets = new Map<number, number[]>();
const key = (i: number, j: number) => i * 100003 + j;
terrainTris.forEach((t, n) => {
  const i0 = Math.floor(Math.min(t.ax, t.bx, t.cx) / B), i1 = Math.floor(Math.max(t.ax, t.bx, t.cx) / B);
  const j0 = Math.floor(Math.min(t.az, t.bz, t.cz) / B), j1 = Math.floor(Math.max(t.az, t.bz, t.cz) / B);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const k = key(i, j);
    let a = buckets.get(k);
    if (!a) buckets.set(k, (a = []));
    a.push(n);
  }
});
/** Heights where the vertical line at (x,z) crosses the terrain. */
function crossings(x: number, z: number): number[] {
  const out: number[] = [];
  for (const n of buckets.get(key(Math.floor(x / B), Math.floor(z / B))) ?? []) {
    const t = terrainTris[n]!;
    const d = (t.bz - t.cz) * (t.ax - t.cx) + (t.cx - t.bx) * (t.az - t.cz);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((t.bz - t.cz) * (x - t.cx) + (t.cx - t.bx) * (z - t.cz)) / d;
    const l2 = ((t.cz - t.az) * (x - t.cx) + (t.ax - t.cx) * (z - t.cz)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    out.push(l1 * t.ay + l2 * t.by + l3 * t.cy);
  }
  return out;
}
/** Topmost terrain surface at (x,z) (below `below` if given), or the field height if the mesh has no hit. */
function ground(x: number, z: number, below = Infinity): number {
  let best = -Infinity;
  for (const y of crossings(x, z)) if (y <= below + 0.05 && y > best) best = y;
  return best === -Infinity ? field.height(x, z) : best;
}

const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
const lip = (f: (typeof falls)[number]) => ({ x: f.x - f.dirX * LIP_OFFSET, z: f.z - f.dirZ * LIP_OFFSET });
const along = (f: (typeof falls)[number], x: number, z: number) => { const l = lip(f); return (x - l.x) * f.dirX + (z - l.z) * f.dirZ; };
const across = (f: (typeof falls)[number], x: number, z: number) => { const l = lip(f); return (x - l.x) * -f.dirZ + (z - l.z) * f.dirX; };
const triArea = (t: Tri) => {
  const ux = t.bx - t.ax, uy = t.by - t.ay, uz = t.bz - t.az, vx = t.cx - t.ax, vy = t.cy - t.ay, vz = t.cz - t.az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return { area: len / 2, ny: len > 0 ? ny / len : 0 };
};
const results: { check: string; pass: boolean; detail: string }[] = [];
const f1 = (v: number) => v.toFixed(1), f2 = (v: number) => v.toFixed(2);

// ---------------------------------------------------------------- (e) tiers + pools
// pool below tier i sits at falls[i].bottom; the top "pool" is the lake at falls[0].top
const levels = [top.top, ...falls.map((f) => f.bottom)];
const poolStats = levels.map((lv, i) => ({ name: i === 0 ? "lake" : i === falls.length ? "foot pool" : `pool ${i}`, level: lv, area: 0, minA: Infinity, maxA: -Infinity, minC: Infinity, maxC: -Infinity, depth: 0 }));
const G = 1;
let lakePastLip = 0, lakePastLipMax = 0, wetUnderGround = 0;
for (let x = minX; x <= maxX; x += G) for (let z = minZ; z <= maxZ; z += G) {
  if (!field.waterSurface(x, z, ws)) continue;
  const g = ground(x, z, ws.y + 30);
  if (ws.y <= g + 0.05) continue; // dry: the surface is clipped by the ground
  let best = -1, bd = 0.6;
  levels.forEach((lv, i) => { const d = Math.abs(ws.y - lv); if (d < bd) { bd = d; best = i; } });
  if (best < 0) continue;
  // attach to the pool along the path: must lie within 60 m of the site line
  const ref = best === 0 ? top : falls[best - 1]!;
  const a = along(ref, x, z);
  if (best > 0 && (a < -2 || a > 70)) continue;
  if (best === 0 && a > 0.5) { lakePastLip++; lakePastLipMax = Math.max(lakePastLipMax, a); }
  const p = poolStats[best]!;
  p.area += G * G;
  const c = across(ref, x, z);
  p.minA = Math.min(p.minA, a); p.maxA = Math.max(p.maxA, a); p.minC = Math.min(p.minC, c); p.maxC = Math.max(p.maxC, c);
  p.depth = Math.max(p.depth, ws.y - g);
}
console.log(`SITE ${siteId} on ${river}  (field + ${cells.length} cell meshes in ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
console.log(`\n(e) TIERS (top to bottom)`);
console.log("tier  lip x,z           top     bottom  drop   width");
falls.forEach((f, i) => { const l = lip(f); console.log(`${String(i + 1).padEnd(5)} ${f1(l.x).padStart(7)},${f1(l.z).padEnd(8)}  ${f1(f.top).padStart(6)}  ${f1(f.bottom).padStart(6)}  ${f1(f.top - f.bottom).padStart(5)}  ${f1(f.width).padStart(5)}`); });
console.log(`total drop ${f1(top.top - bot.bottom)} m`);
console.log("pool       level   area m2  along(m)      across(m)     maxDepth");
for (const p of poolStats) {
  const al = p.area > 0 ? `${f1(p.minA)}..${f1(p.maxA)}` : "-", ac = p.area > 0 ? `${f1(p.minC)}..${f1(p.maxC)}` : "-";
  console.log(`${p.name.padEnd(10)} ${f1(p.level).padStart(6)}  ${String(p.area).padStart(7)}  ${al.padEnd(13)} ${ac.padEnd(13)} ${f1(p.depth)}`);
}
const tiersOk = falls.every((f) => f.top - f.bottom >= 3) && poolStats.slice(1, -1).every((p) => p.area >= 40);
results.push({ check: "e tiers/pools", pass: tiersOk, detail: `${falls.length} tiers, drops ${falls.map((f) => f1(f.top - f.bottom)).join("/")} m, mid pools ${poolStats.slice(1, -1).map((p) => p.area).join("/")} m2 (need drop>=3, pool>=40)` });

// ---------------------------------------------------------------- (a) water past lip / hanging / under ground (mesh)
let meshLakePast = 0, meshLakePastMax = 0, meshLakePastArea = 0;
let hangArea = 0, hangN = 0, hangMax = 0, hangAt = "";
let buriedArea = 0, buriedMax = 0, waterArea = 0;
const lakeY = top.top;
for (const t of waterTris) {
  if (t.kind !== "water") continue;
  const { area } = triArea(t);
  const mx = (t.ax + t.bx + t.cx) / 3, my = (t.ay + t.by + t.cy) / 3, mz = (t.az + t.bz + t.cz) / 3;
  if (mx < minX || mx > maxX || mz < minZ || mz > maxZ) continue;
  waterArea += area;
  // lake-level water downstream of the top lip line (within the channel corridor)
  if (Math.abs(my - lakeY) < 0.5 && Math.abs(across(top, mx, mz)) < top.width / 2 + 15) {
    const a = along(top, mx, mz);
    if (a > 0.5) { meshLakePast++; meshLakePastArea += area; meshLakePastMax = Math.max(meshLakePastMax, a); }
  }
  // a water sheet hanging in the air: centroid over both the ground below it and the field's own water there
  const g = ground(mx, mz, my);
  const w = field.waterSurface(mx, mz, ws) ? ws.y : -Infinity;
  const hang = my - Math.max(g, w);
  if (hang > 0.5) {
    hangN++; hangArea += area;
    if (hang > hangMax) { hangMax = hang; hangAt = `at (${f1(mx)}, ${f1(my)}, ${f1(mz)})`; }
  }
  // ground just over the water (within 5 m): the sheet is buried there (z-fight / pokes through at the rim)
  const over = crossings(mx, mz).filter((y) => y > my + 0.3 && y < my + 5);
  if (over.length > 0) { buriedArea += area; buriedMax = Math.max(buriedMax, Math.min(...over) - my); }
}
console.log(`\n(a) WATER BOUNDS`);
console.log(`field: lake-level wet samples past the top lip line: ${lakePastLip} m2 (max ${f1(lakePastLipMax)} m past)`);
console.log(`mesh: lake-level water past the top lip: ${meshLakePast} tris, ${f1(meshLakePastArea)} m2 (max ${f1(meshLakePastMax)} m past)`);
console.log(`mesh: water hanging > 0.5 m over ground AND field water: ${hangN} tris, ${f1(hangArea)} m2, worst ${f2(hangMax)} m ${hangAt}`);
console.log(`mesh: water with ground 0.3-5 m above its centroid (buried): ${f1(buriedArea)} of ${f1(waterArea)} m2 (max ${f2(buriedMax)} m)`);
results.push({ check: "a water bounds", pass: lakePastLip <= 2 && meshLakePastArea < 2 && hangArea < 2 && buriedArea < waterArea * 0.02, detail: `lake past lip ${lakePastLip} m2 field / ${f1(meshLakePastArea)} m2 mesh; hanging ${f1(hangArea)} m2; buried ${f1(buriedArea)} m2 (${((100 * buriedArea) / Math.max(1, waterArea)).toFixed(1)} %)` });

// ---------------------------------------------------------------- (b) rocks
// Site rocks are the instances the chunks actually emit (hand rocks AND the walls scree), with their full
// rotation, measured against the real terrain triangles (inside = odd number of mesh crossings above a point).
// SUPPORT RULE (not mere contact): a rock is "supported" when every point of its lower lattice layer within
// 0.3 m of its lowest point, and at least 3 of the lower half, have terrain or another site rock within 0.2 m
// straight below, surrounding its centre of mass in plan; "outcrop" when >= 60 % of its lattice is inside
// terrain and no exposed point stands > 0.5 m out along its -up axis; else UNSUPPORTED. Scree must be
// supported (outcrops are not scree); hand rocks may be either. Plus: rim (a resting rock's top must stay
// 0.5 m under the highest ground 2-24 m behind it, away from the channel), buried (>= 7 of 9 top samples
// inside terrain).
const { fallSiteRockInstances, rockFormationSolid } = await import("@hitreg/core");
// the site's DC rock formations (site.formations): support and obstacle for the rocks, like fall-site-rocks.ts
// withFormations, and cover for (c). Regenerated from the same options the placed volume was built with.
const formation = site?.formations ? rockFormationSolid(field, { id: site.id, course: site.course, at: site.at }, site.formations) : null;
const inFormation = (x: number, y: number, z: number) => !!formation && formation.density(x, y, z) < 0;
const insideSolid = (x: number, y: number, z: number) => insideTerrain(x, y, z) || inFormation(x, y, z);
const ruleOf = (id: string) => recipe.scatter.find((s) => s.id === id);
type V3 = [number, number, number];
const qrot = (q: number[], v: V3): V3 => {
  const [x, y, z, w] = q as [number, number, number, number];
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};
type SiteRock = { id: string; rule: string; p: V3; X: V3; N: V3; Z: V3; s: number; e: V3 };
const siteInst: SiteRock[] = (site ? fallSiteRockInstances(field, site) : []).map((r) => {
  const e = (ruleOf(r.rule)?.colliderSize ?? [1, 1, 1]) as V3;
  return { id: r.id, rule: r.rule, p: r.position as V3, X: qrot(r.rotation, [1, 0, 0]), N: qrot(r.rotation, [0, 1, 0]), Z: qrot(r.rotation, [0, 0, 1]), s: r.scale, e };
});
const at = (r: SiteRock, lx: number, ly: number, lz: number): V3 => [
  r.p[0] + (r.X[0] * lx + r.N[0] * ly + r.Z[0] * lz) * r.s,
  r.p[1] + (r.X[1] * lx + r.N[1] * ly + r.Z[1] * lz) * r.s,
  r.p[2] + (r.X[2] * lx + r.N[2] * ly + r.Z[2] * lz) * r.s,
];
const lattice = (r: SiteRock): V3[] => {
  const out: V3[] = [];
  for (const v of [0.05, 0.5, 0.95]) for (const u of [-1, 0, 1]) for (const w of [-1, 0, 1]) out.push(at(r, u * r.e[0] * 0.45, v * r.e[1], w * r.e[2] * 0.45));
  return out;
};
function insideTerrain(x: number, y: number, z: number): boolean {
  const ys = crossings(x, z).filter((c) => c > y).sort((a, b) => a - b);
  let n = 0, last = -Infinity;
  for (const c of ys) { if (c - last > 1e-3) n++; last = c; } // a seam edge is hit by two cells' triangles
  return n % 2 === 1;
}
function insideRock(self: SiteRock, q: V3): boolean {
  for (const o of siteInst) {
    if (o === self || Math.hypot(o.p[0] - q[0], o.p[2] - q[2]) > 25) continue;
    const dx = q[0] - o.p[0], dy = q[1] - o.p[1], dz = q[2] - o.p[2];
    const lx = (dx * o.X[0] + dy * o.X[1] + dz * o.X[2]) / o.s, ly = (dx * o.N[0] + dy * o.N[1] + dz * o.N[2]) / o.s, lz = (dx * o.Z[0] + dy * o.Z[1] + dz * o.Z[2]) / o.s;
    if (Math.abs(lx) <= o.e[0] / 2 && ly >= 0 && ly <= o.e[1] && Math.abs(lz) <= o.e[2] / 2) return true;
  }
  return false;
}
function support(r: SiteRock): "supported" | "outcrop" | "UNSUPPORTED" {
  const pts = lattice(r);
  const sorted = pts.map((p, i) => [p[1], i] as const).sort((a, b) => a[0] - b[0]);
  const low = sorted.slice(0, 14), minY = low[0]![0];
  const held: V3[] = [];
  let lowestHeld = true;
  for (const [y, i] of low) {
    const p = pts[i]!;
    let ok = false;
    for (let t = 0; t <= 0.2 + 1e-9 && !ok; t += 0.05) if (insideSolid(p[0], p[1] - t, p[2]) || insideRock(r, [p[0], p[1] - t, p[2]])) ok = true;
    if (ok) held.push(p); else if (y < minY + 0.3) lowestHeld = false;
  }
  const cx = r.p[0] + r.N[0] * r.e[1] * r.s * 0.5, cz = r.p[2] + r.N[2] * r.e[1] * r.s * 0.5;
  const ang = held.map((p) => Math.atan2(p[2] - cz, p[0] - cx)).sort((a, b) => a - b);
  let gap = ang.length ? ang[0]! + Math.PI * 2 - ang[ang.length - 1]! : 7;
  for (let i = 1; i < ang.length; i++) gap = Math.max(gap, ang[i]! - ang[i - 1]!);
  const under = held.some((p) => Math.hypot(p[0] - cx, p[2] - cz) < 0.05);
  if (lowestHeld && held.length >= 3 && (under || gap < Math.PI - 0.05)) return "supported";
  const inside = pts.filter((p) => insideSolid(p[0], p[1], p[2])).length;
  if (inside / pts.length >= 0.6) {
    let worst = 0;
    for (const p of pts) {
      if (insideSolid(p[0], p[1], p[2])) continue;
      let t = 0;
      while (t < 0.8 && !insideSolid(p[0] - r.N[0] * t, p[1] - r.N[1] * t, p[2] - r.N[2] * t)) t += 0.1;
      worst = Math.max(worst, t);
    }
    if (worst <= 0.5) return "outcrop";
  }
  return "UNSUPPORTED";
}
// outward (away from the channel) at a point: perpendicular to the nearest river segment, on the point's side
const riverDoc = field.rivers.find((d) => d.id === river)!;
function outward(x: number, z: number): [number, number] {
  let best = Infinity, ox = 0, oz = 0;
  for (let k = 1; k < riverDoc.points.length; k++) {
    const a = riverDoc.points[k - 1]!, b = riverDoc.points[k]!;
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
    const qx = a[0] + dx * t, qz = a[1] + dz * t, d = Math.hypot(x - qx, z - qz);
    if (d < best) { best = d; const l = Math.sqrt(l2); const px = -dz / l, pz = dx / l; const sgn = Math.sign((x - qx) * px + (z - qz) * pz) || 1; ox = px * sgn; oz = pz * sgn; }
  }
  return [ox, oz];
}
function rimMargin(r: SiteRock): number {
  const pts = lattice(r);
  const top = Math.max(...pts.map((p) => p[1]), r.p[1] + r.N[1] * r.e[1] * r.s);
  const low = pts.reduce((a, p) => (p[1] < a[1] ? p : a));
  const [ox, oz] = outward(low[0], low[2]);
  let rim = low[1];
  for (let d = 2; d <= 24; d += 2) for (const c of crossings(low[0] + ox * d, low[2] + oz * d)) rim = Math.max(rim, c);
  return rim - top; // must be >= 0.5 for resting rocks
}
type Row = { id: string; x: number; y: number; z: number; s: number; st: string; rim: number; buried: boolean };
const rows: Row[] = siteInst.map((r) => {
  let over = 0;
  for (const u of [-1, 0, 1]) for (const v of [-1, 0, 1]) { const t = at(r, u * r.e[0] * 0.425, r.e[1], v * r.e[2] * 0.425); if (insideSolid(t[0], t[1], t[2])) over++; }
  const st = support(r);
  return { id: r.id.replace(`${siteId}-`, ""), x: r.p[0], y: r.p[1], z: r.p[2], s: r.s, st, rim: st === "supported" ? rimMargin(r) : Infinity, buried: over >= 7 };
});
const bad = rows.filter((r) => r.st === "UNSUPPORTED" || (r.id.startsWith("wall") && r.st !== "supported") || r.rim < 0.5 || r.buried);
console.log(`\n(b) ROCKS  (support rule vs the terrain meshes; ALL=1 lists every rock)`);
console.log("id          x        y      z        scale  support      rimMargin  buried");
for (const r of process.env.ALL ? rows : bad) console.log(`${r.id.padEnd(10)} ${f1(r.x).padStart(7)} ${f1(r.y).padStart(6)} ${f1(r.z).padStart(8)}  ${f2(r.s).padStart(5)}  ${r.st.padEnd(11)}  ${(Number.isFinite(r.rim) ? f2(r.rim) : "-").padStart(8)}  ${r.buried ? "BURIED" : ""}`);
const hand = rows.filter((r) => r.id.startsWith("rock")), wall = rows.filter((r) => r.id.startsWith("wall"));
const tally = (rs: Row[]) => ({ sup: rs.filter((r) => r.st === "supported").length, out: rs.filter((r) => r.st === "outcrop").length, un: rs.filter((r) => r.st === "UNSUPPORTED").length, rim: rs.filter((r) => r.rim < 0.5).length, bur: rs.filter((r) => r.buried).length });
const hc = tally(hand), wc = tally(wall);
const sc = wall.map((r) => r.s);
console.log(`hand rocks ${hand.length}: supported ${hc.sup}, outcrop ${hc.out}, UNSUPPORTED ${hc.un}, over rim ${hc.rim}, buried ${hc.bur}`);
console.log(`scree ${wall.length} (scale ${sc.length ? `${f2(Math.min(...sc))}..${f2(Math.max(...sc))}` : "-"}): supported ${wc.sup}, outcrop ${wc.out}, UNSUPPORTED ${wc.un}, over rim ${wc.rim}, buried ${wc.bur}`);
results.push({ check: "b rocks", pass: hc.un + hc.rim + hc.bur + wc.un + wc.out + wc.rim + wc.bur === 0, detail: `hand ${hc.un} unsupported / ${hc.rim} over rim / ${hc.bur} buried of ${hand.length}; scree ${wc.un + wc.out} unsupported / ${wc.rim} over rim / ${wc.bur} buried of ${wall.length}` });

// ---------------------------------------------------------------- (c) steep uncovered wall
const names = recipe.surfaces.map((s) => s.name);
const rockIdx = names.indexOf("rock"), cliffIdx = names.indexOf("cliff");
let steepArea = 0, uncovered = 0, brownArea = 0;
// the gorge: from 10 m above the top lip to 15 m past the foot, 25 m either side
const gA = { x: lip(top).x - top.dirX * 10, z: lip(top).z - top.dirZ * 10 }, gB = { x: bot.x + fdx * 15, z: bot.z + fdz * 15 };
const WALL_R = 25;
const segD = (x: number, z: number) => {
  const ux = gB.x - gA.x, uz = gB.z - gA.z, l2 = ux * ux + uz * uz;
  const t = Math.max(0, Math.min(1, ((x - gA.x) * ux + (z - gA.z) * uz) / l2));
  return Math.hypot(x - (gA.x + ux * t), z - (gA.z + uz * t));
};
const covered = (x: number, y: number, z: number) => rockInst.some((r) => {
  const size = (ruleOf(r.rule)?.colliderSize ?? [1, 1, 1]).map((v) => v * r.scale);
  const rad = Math.hypot(size[0]!, size[2]!) / 2 + 0.3;
  return Math.hypot(x - r.x, z - r.z) < rad && y > r.y - 0.5 && y < r.y + size[1]! + 0.5;
});
terrainTris.forEach((t, n) => {
  const mx = (t.ax + t.bx + t.cx) / 3, my = (t.ay + t.by + t.cy) / 3, mz = (t.az + t.bz + t.cz) / 3;
  if (segD(mx, mz) > WALL_R) return;
  const { area, ny } = triArea(t);
  if (Math.abs(ny) > 0.64) return; // under ~50 degrees
  steepArea += area;
  const sp = terrainSplat[n]!;
  // stone = rock + cliff: Derek prefers the cliff texture on river walls
  const rockW = (rockIdx >= 0 ? sp[rockIdx]! : 0) + (cliffIdx >= 0 ? sp[cliffIdx]! : 0);
  let best = 0;
  for (let s = 1; s < sp.length; s++) if (sp[s]! > sp[best]!) best = s;
  // a face a formation stands over (the tri's centre inside, or within 0.3 m of, a mass) is covered by rock
  if (rockW >= 0.5 || covered(mx, my, mz) || (formation && formation.density(mx, my, mz) < 0.3)) return;
  uncovered += area;
  if (names[best] === "grass" || names[best] === "dirt" || names[best] === "mud") brownArea += area;
});
const frac = uncovered / Math.max(1, steepArea);
console.log(`\n(c) STEEP WALLS (>50 deg, within ${WALL_R} m of the gorge line: 10 m above the top lip to 15 m past the foot)`);
console.log(`steep area ${f1(steepArea)} m2; not stone-painted (rock+cliff<0.5) and not under a rock: ${f1(uncovered)} m2 = ${(frac * 100).toFixed(1)} %; of that soil-dominant (grass/dirt/mud): ${f1(brownArea)} m2`);
results.push({ check: "c wall cover", pass: frac < 0.15, detail: `${(frac * 100).toFixed(1)} % uncovered (${f1(brownArea)} m2 soil), need < 15 %` });

// ---------------------------------------------------------------- (d) hovering flat water near lips
console.log(`\n(d) FLAT WATER HOVERING NEAR LIPS (|ny|>0.9, centroid > 0.5 m over max(ground, field water))`);
let shardTotal = 0;
const shardRows: string[] = [];
falls.forEach((f, i) => {
  let n = 0, area = 0, worst = 0, wx = 0, wz = 0, wy = 0, wid = "", wa = 0, wc = 0;
  for (const t of waterTris) {
    const { area: ar, ny } = triArea(t);
    if (Math.abs(ny) < 0.9) continue;
    const mx = (t.ax + t.bx + t.cx) / 3, my = (t.ay + t.by + t.cy) / 3, mz = (t.az + t.bz + t.cz) / 3;
    const a = along(f, mx, mz), c = across(f, mx, mz);
    if (a < -6 || a > 10 || Math.abs(c) > f.width / 2 + 8) continue;
    const g = ground(mx, mz, my);
    const w = field.waterSurface(mx, mz, ws) ? ws.y : -Infinity;
    const hover = my - Math.max(g, w);
    if (hover <= 0.5) continue;
    n++; area += ar;
    if (hover > worst) { worst = hover; wx = mx; wz = mz; wy = my; wid = t.id; wa = a; wc = c; }
  }
  shardTotal += area;
  shardRows.push(`lip ${i + 1}: ${n} tris, ${f1(area)} m2, worst ${f2(worst)} m${n ? ` at (${f1(wx)}, ${f1(wy)}, ${f1(wz)}) = ${f1(wa)} m downstream of the lip line, ${f1(wc)} m across, in ${wid}` : ""}`);
});
for (const r of shardRows) console.log(r);
results.push({ check: "d lip shards", pass: shardTotal < 1, detail: `${f1(shardTotal)} m2 hovering flat water across ${falls.length} lips (need < 1)` });

// ---------------------------------------------------------------- (f) formations
// The BAKED formation mesh (what ships: assets/models/rock-formations/rock-<site>.glb), checked against the terrain as
// meshed by tools/rock-formations-check.mts: open boundary edges not buried 0.3 m in the terrain (holes), and connected
// pieces that float (no terrain within 0.2 m), are not seated on their lowest metre (< 50 % held within 0.3 m / running
// into the ground), or overhang the gorge more than 1.5 m past where they meet it. Both must be 0.
{
  const { checkFormationMesh, terrainSolid } = await import("./rock-formations-check.mts");
  const glb = file.replace(/worlds[\/][^\/]+.json$/, `models/rock-formations/rock-${siteId}.glb`);
  console.log(`
(f) FORMATIONS (${glb})`);
  if (!site?.formations) {
    console.log("site has no formations");
    results.push({ check: "f formations", pass: true, detail: "none on this site" });
  } else if (!fs.existsSync(glb)) {
    results.push({ check: "f formations", pass: false, detail: `site has formations but no bake at ${glb} (run tools/rock-formations.mts)` });
  } else {
    const buf = fs.readFileSync(glb);
    const jl = buf.readUInt32LE(12), json = JSON.parse(buf.subarray(20, 20 + jl).toString("utf8")), bin = buf.subarray(20 + jl + 8);
    const acc = (i: number, T: Float32ArrayConstructor | Uint32ArrayConstructor) => {
      const a = json.accessors[i], v = json.bufferViews[a.bufferView], n = ({ SCALAR: 1, VEC3: 3, VEC4: 4 } as Record<string, number>)[a.type]!;
      const off = bin.byteOffset + (v.byteOffset ?? 0);
      return new T(bin.buffer.slice(off, off + a.count * n * 4));
    };
    const prim = json.meshes[0].primitives[0];
    const positions = acc(prim.attributes.POSITION, Float32Array) as Float32Array, normals = acc(prim.attributes.NORMAL, Float32Array) as Float32Array, indices = acc(prim.indices, Uint32Array) as Uint32Array;
    const fm = { positions, normals, indices, vertexCount: positions.length / 3, triangleCount: indices.length / 3 };
    const fc = checkFormationMesh(fm, terrainSolid(field, fm));
    for (const c of fc.components) if (!c.ok || process.env.ALL) console.log(`piece #${c.index} ${c.triangles} tris ${c.size.map((v) => f1(v)).join("x")}: ${c.ok ? "ok" : c.why} (seated ${(c.seated * 100).toFixed(0)} %, overhang ${f1(c.overhang)} m)`);
    if (fc.exposedAt.length) console.log("exposed open edges at", fc.exposedAt.slice(0, 6).map((q) => q.map((v) => f1(v)).join(",")).join("  "));
    console.log(`${fm.triangleCount} tris, ${fc.components.length} pieces`);
    results.push({ check: "f formations", pass: fc.exposedOpenEdges === 0 && fc.unsupported === 0, detail: `open edges ${fc.exposedOpenEdges} exposed (of ${fc.openEdges}); unsupported pieces ${fc.unsupported} of ${fc.components.length}` });
  }
}

// ---------------------------------------------------------------- summary
console.log(`\nSUMMARY`);
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check.padEnd(15)} ${r.detail}`);

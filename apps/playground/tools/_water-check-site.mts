/* scratch: check the terrain-clipped water on a world (pools, fit, hanging edges, cost) */
import fs from "node:fs";
import { createWorldField, voxelChunkDoc, worldRecipeSchema } from "@hitreg/core";

const file = process.argv[2] ?? "projects/voxel-demo/assets/worlds/mmo.json";
const limit = Number(process.argv[3] ?? 400);
const t0 = performance.now();
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
const field = createWorldField(recipe);
console.log(`field built in ${(performance.now() - t0).toFixed(0)} ms; rivers ${field.rivers.length}`);

const VOX = field.voxelSize;
/** Ground as the terrain mesh draws it: the lattice heights, bilinear between them. */
const drawn = (x: number, z: number): number => {
  const i = Math.floor(x / VOX), j = Math.floor(z / VOX);
  const u = x / VOX - i, v = z / VOX - j;
  const h = (a: number, b: number): number => field.height(a * VOX, b * VOX);
  return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
};
const pct = (a: number[], q: number): number => {
  if (a.length === 0) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};
const fmt = (a: number[]): string => [0.1, 0.5, 0.9].map((q) => pct(a, q).toFixed(2)).join(" / ");

// pools
const poolLen: number[] = [];
const drops: number[] = [];
let rises = 0;
const cells = new Set<string>();
for (const r of field.rivers) {
  if (!r.water || !r.surfaceY) continue;
  let run = 0;
  for (let i = 1; i < r.points.length; i++) {
    const a = r.points[i - 1]!;
    const b = r.points[i]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d = r.surfaceY[i - 1]! - r.surfaceY[i]!;
    if (d < -0.01) rises++;
    if (d > 0.01) {
      drops.push(d);
      poolLen.push(run);
      run = 0;
    } else run += len;
    cells.add(`${Math.floor(a[0] / recipe.cellSize)},${Math.floor(a[1] / recipe.cellSize)}`);
  }
  if (run > 0) poolLen.push(run);
}
console.log(`pools: ${poolLen.length}, length p10/50/90 ${fmt(poolLen)} m; steps p10/50/90 ${fmt(drops)} m; uphill steps ${rises}`);

// water meshes for cells along rivers (and lakes via waterNear)
const list: string[] = []; for (let cx = Math.floor(5280 / recipe.cellSize); cx <= Math.floor(5440 / recipe.cellSize); cx++) for (let cz = Math.floor(-3960 / recipe.cellSize); cz <= Math.floor(-3800 / recipe.cellSize); cz++) list.push(`${cx},${cz}`); void limit;
let tris = 0;
let meshTime = 0;
let entitiesCount = 0;
const edgeGap: number[] = [];
let hanging = 0;
let edgeVerts = 0;
const worst: { gap: number; x: number; z: number }[] = [];
const cats = new Map<string, number>();
const sub = new Map<string, number>();
const samples: string[] = [];
const deepIds = new Map<string, number>();
let otherHang = 0;
const otherIds = new Map<string, number>();
for (const c of list) {
  const [cx, cz] = c.split(",").map(Number) as [number, number];
  const t = performance.now();
  const doc = voxelChunkDoc(field, "mmo", cx, cz, { scatter: false, collision: false });
  meshTime += performance.now() - t;
  {
    // every water mesh of the cell welded by position: a lake meeting a river is a seam, not a shore
    const pos: number[] = [];
    const idx: number[] = [];
    const weld = new Map<string, number>();
    for (const [id, e] of Object.entries(doc.entities)) {
      if (!id.startsWith("water")) continue;
      entitiesCount++;
      const src = (e.components["mesh"] as { source: { positions: number[]; indices: number[] } }).source;
      const remap: number[] = [];
      for (let v = 0; v < src.positions.length / 3; v++) {
        const key = src.positions.slice(v * 3, v * 3 + 3).join(",");
        let at = weld.get(key);
        if (at === undefined) {
          at = pos.length / 3;
          pos.push(...src.positions.slice(v * 3, v * 3 + 3));
          weld.set(key, at);
        }
        remap.push(at);
      }
      for (const i of src.indices) idx.push(remap[i]!);
    }
    tris += idx.length / 3;
    const edges = new Map<string, number>();
    for (let k = 0; k < idx.length; k += 3) {
      for (let m = 0; m < 3; m++) {
        const a = idx[k + m]!;
        const b = idx[k + ((m + 1) % 3)]!;
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    const boundary = new Set<number>();
    for (const [key, n] of edges) if (n === 1) key.split("_").forEach((v) => boundary.add(Number(v)));
    for (const v of boundary) {
      const lx = pos[v * 3]!;
      const y = pos[v * 3 + 1]!;
      const lz = pos[v * 3 + 2]!;
      // the cell border is a seam, not a shore
      if (lx < 0.01 || lz < 0.01 || lx > recipe.cellSize - 0.01 || lz > recipe.cellSize - 0.01) continue;
      const x = lx + cx * recipe.cellSize;
      const z = lz + cz * recipe.cellSize;
      const gap = drawn(x, z) - y; // + = the edge is under the bank, - = the edge hangs over lower ground
      edgeGap.push(gap);
      edgeVerts++;
      if (gap < -0.3) {
        hanging++;
        const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
        const ok = field.waterSurface(x, z, ws);
        const cat = !ok ? "no-surface" : ws.kind + (ws.y <= recipe.seaLevel + 0.05 ? "-sea" : field.height(x, z) < ws.floor - 3 ? "-deep" : ws.y > y + 0.2 ? "-higher" : ws.y < y - 0.2 ? "-lower" : "-same");
        cats.set(cat, (cats.get(cat) ?? 0) + 1);
        if (cat !== "lake-same") {
          let best = { d: Infinity, id: "", k: 0, last: 0, rel: 0, bed: 0 };
          for (const r of field.rivers) r.points.forEach((pt, k) => {
            const d = Math.hypot(pt[0] - x, pt[1] - z);
            if (d < best.d) { const half = (r.widths ? r.widths[k]! : r.width) / 2; const bank = Math.min(r.bank, 0.7 * (half * 2) + 3); best = { d, id: r.id, k, last: r.points.length - 1, rel: (d - half) / bank, bed: r.bedY![k]! }; }
          });
          const where = best.k === 0 ? "head" : best.k === best.last ? "mouth" : best.rel > 0.5 ? "bank-edge" : "channel";
          const key = cat + ":" + where;
          sub.set(key, (sub.get(key) ?? 0) + 1);
          if (!/^river-(14|27|132)b/.test(best.id) && cat !== "river-deep" && samples.length < 16 && Math.random() < 0.08) samples.push(`${x.toFixed(1)},${z.toFixed(1)} ${best.id}[${best.k}] ${cat}:${where} gap ${gap.toFixed(2)} rel ${best.rel.toFixed(2)}`);
          if (cat === "river-deep") deepIds.set(best.id, (deepIds.get(best.id) ?? 0) + 1);
          if (!/^river-(14|27|132)(.|$)/.test(best.id) && !cat.endsWith("sea")) { otherHang++; otherIds.set(best.id, (otherIds.get(best.id) ?? 0) + 1); }
        }
        if (worst.length < 400) worst.push({ gap, x, z });
      }
    }
  }
}
console.log(`cells ${list.length}: ${entitiesCount} water meshes, ${tris} tris, chunk doc ${(meshTime / list.length).toFixed(1)} ms/cell (terrain source not meshed here)`);
console.log(`shore vertices ${edgeVerts}: ground - water p10/50/90 ${fmt(edgeGap)} m; hanging > 0.3 m: ${hanging} (${((100 * hanging) / Math.max(1, edgeVerts)).toFixed(1)} %)`);
worst.sort((a, b) => a.gap - b.gap);
for (const w of worst.slice(0, 8)) console.log(`  hang ${w.gap.toFixed(2)} at [${w.x.toFixed(0)}, ${w.z.toFixed(0)}]`);

console.log("hanging by kind", Object.fromEntries(cats));
let steep=0;for (const r of field.rivers){ if(!r.water||!r.surfaceY) continue; const L=r.points.length; const len=Math.hypot(r.points[L-1][0]-r.points[0][0], r.points[L-1][1]-r.points[0][1]); const drop=r.surfaceY[0]-r.surfaceY[L-1]; if (drop/Math.max(1,len)>0.05) steep++;}
console.log("wet rivers with mean grade > 5%:", steep, "of", field.rivers.filter(r=>r.water).length, "dry:", field.rivers.filter(r=>!r.water).length);
console.log("where", Object.fromEntries(sub));
console.log("deep by river", Object.fromEntries(deepIds));
console.log(samples.join(" | "));
console.log("hanging outside the floating rivers (14, 27, 132) and sea mouths:", otherHang, Object.fromEntries(otherIds));

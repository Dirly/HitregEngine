/* scratch: the chunk WATER MESH at the head of the river-15 cascade (lake-12 outlet down to the top lip).
   Counts, in the window along -70..-1, across -40..40 of the top lip frame:
   - boundary edges (not on a chunk border) standing > 0.3 m over the ground (hanging), by level
   - triangles with the ground > 0.3 m over their centroid (buried)
   - sloped triangles (a step face between two levels: dy over the triangle > 0.05 m)
   - overlapping sheets: 0.5 m sample points covered by two triangles at levels > 0.05 m apart */
import fs from "node:fs";
import { createWorldField, voxelChunkDoc, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const top = field.falls.filter((f) => f.river === "river-15").sort((a, b) => b.top - a.top)[0]!;
const lx = top.x - top.dirX * 3, lz = top.z - top.dirZ * 3;
const A = (x: number, z: number) => (x - lx) * top.dirX + (z - lz) * top.dirZ;
const C = (x: number, z: number) => -(x - lx) * top.dirZ + (z - lz) * top.dirX;
const inWin = (x: number, z: number) => { const a = A(x, z), c = C(x, z); return a >= -70 && a <= -3 && c >= -40 && c <= 40; };
const size = recipe.cellSize;
const LAKE = recipe.features.lakes.map((l) => ({ l, d: Math.hypot(l.center[0] - top.x, l.center[1] - top.z) - l.radius })).sort((a, b) => a.d - b.d)[0]!.l.waterY;
const cells = new Set<string>();
for (let a = -78; a <= 0; a += 8) for (let c = -48; c <= 48; c += 8) {
  const x = lx + a * top.dirX - c * top.dirZ, z = lz + a * top.dirZ + c * top.dirX;
  cells.add(`${Math.floor(x / size)},${Math.floor(z / size)}`);
}
type T = { p: number[][] };
const tris: T[] = [];
let hang = 0, hangBig = 0, buried = 0, sloped = 0;
const notes: string[] = [];
for (const key of cells) {
  const [cx, cz] = key.split(",").map(Number) as [number, number];
  const d = voxelChunkDoc(field, "mmo", cx, cz, { scatter: false, collision: false });
  for (const [id, e] of Object.entries(d.entities)) {
    if (!id.startsWith("water")) continue;
    const s = (e.components["mesh"] as { source: { positions: number[]; indices: number[] } }).source;
    const P = (i: number) => [s.positions[i * 3]! + cx * size, s.positions[i * 3 + 1]!, s.positions[i * 3 + 2]! + cz * size];
    const kp = (i: number) => P(i).map((v) => v.toFixed(2)).join(",");
    const edges = new Map<string, { a: number; b: number; n: number }>();
    for (let t = 0; t < s.indices.length; t += 3) {
      const p = [P(s.indices[t]!), P(s.indices[t + 1]!), P(s.indices[t + 2]!)];
      const mx = (p[0]![0]! + p[1]![0]! + p[2]![0]!) / 3, my = (p[0]![1]! + p[1]![1]! + p[2]![1]!) / 3, mz = (p[0]![2]! + p[1]![2]! + p[2]![2]!) / 3;
      for (let m = 0; m < 3; m++) {
        const a = s.indices[t + m]!, b = s.indices[t + ((m + 1) % 3)]!;
        const ka = kp(a), kb = kp(b); const k = ka < kb ? ka + "|" + kb : kb + "|" + ka;
        const got = edges.get(k); if (got) got.n++; else edges.set(k, { a, b, n: 1 });
      }
      if (!inWin(mx, mz)) continue;
      tris.push({ p });
      if (field.height(mx, mz) > my + 0.3) buried++;
      const ys = p.map((q) => q[1]!);
      if (Math.max(...ys) - Math.min(...ys) > 0.05 && Math.max(...ys) > LAKE - 0.01 && Math.min(...ys) < LAKE - 0.05) { sloped++; if (process.argv.includes("-s")) notes.push(`step along ${A(mx, mz).toFixed(1)} across ${C(mx, mz).toFixed(1)} y ${Math.min(...ys).toFixed(2)}..${Math.max(...ys).toFixed(2)}`); }
    }
    for (const { a, b, n } of edges.values()) {
      if (n !== 1) continue;
      const pa = P(a), pb = P(b);
      const onBorder = (v: number) => Math.abs(v / size - Math.round(v / size)) < 1e-4;
      if ((onBorder(pa[0]!) && onBorder(pb[0]!)) || (onBorder(pa[2]!) && onBorder(pb[2]!))) continue;
      const mx = (pa[0]! + pb[0]!) / 2, my = (pa[1]! + pb[1]!) / 2, mz = (pa[2]! + pb[2]!) / 2;
      if (!inWin(mx, mz)) continue;
      const over = my - field.height(mx, mz);
      if (over > 0.3) { hang++; if (over > 1) hangBig++; notes.push(`hang along ${A(mx, mz).toFixed(1)} across ${C(mx, mz).toFixed(1)} y ${my.toFixed(2)} over ${over.toFixed(2)}`); }
    }
  }
}
// overlaps on a 0.5 m sample grid
let overlap = 0;
const hitsAt = new Map<string, number[]>();
for (const t of tris) {
  const [a, b, c] = t.p as [number[], number[], number[]];
  const minX = Math.min(a[0]!, b[0]!, c[0]!), maxX = Math.max(a[0]!, b[0]!, c[0]!), minZ = Math.min(a[2]!, b[2]!, c[2]!), maxZ = Math.max(a[2]!, b[2]!, c[2]!);
  for (let x = Math.ceil(minX * 2) / 2; x <= maxX; x += 0.5) for (let z = Math.ceil(minZ * 2) / 2; z <= maxZ; z += 0.5) {
    const d = (b[0]! - a[0]!) * (c[2]! - a[2]!) - (c[0]! - a[0]!) * (b[2]! - a[2]!);
    if (Math.abs(d) < 1e-9) continue;
    const u = ((x - a[0]!) * (c[2]! - a[2]!) - (c[0]! - a[0]!) * (z - a[2]!)) / d;
    const v = ((b[0]! - a[0]!) * (z - a[2]!) - (x - a[0]!) * (b[2]! - a[2]!)) / d;
    if (u < 0.01 || v < 0.01 || u + v > 0.99) continue;
    const y = a[1]! + u * (b[1]! - a[1]!) + v * (c[1]! - a[1]!);
    const k = `${x},${z}`;
    const l = hitsAt.get(k); if (l) l.push(y); else hitsAt.set(k, [y]);
  }
}
for (const [k, ys] of hitsAt) if (ys.length > 1 && Math.max(...ys) - Math.min(...ys) > 0.05) { overlap++; const [x, z] = k.split(",").map(Number) as [number, number]; notes.push(`overlap along ${A(x, z).toFixed(1)} across ${C(x, z).toFixed(1)} ys ${ys.map((y) => y.toFixed(2)).join("/")}`); }
console.log(`mesh window: tris ${tris.length}, hanging edges >0.3 ${hang} (>1 m ${hangBig}), buried tris ${buried}, lake-to-lower step tris ${sloped}, overlap points ${overlap}`);
if (process.argv.includes("-v")) console.log(notes.join("\n"));

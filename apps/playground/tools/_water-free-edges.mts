/* scratch: water-mesh boundary edges that end IN THE AIR (>0.6 m over ground) near each river-15 lip,
   minus those on a lip line inside that fall's curtain. Prints per-lip counts and the worst edges. */
import fs from "node:fs";
import { createWorldField, voxelChunkDoc, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const river = process.argv[2] ?? "river-15";
const R = 14;
const falls = field.falls.filter((f) => f.river === river).sort((a, b) => b.top - a.top);
const size = recipe.cellSize;
const cells = new Map<string, ReturnType<typeof voxelChunkDoc>>();
const doc = (cx: number, cz: number) => { const k = `${cx},${cz}`; if (!cells.has(k)) cells.set(k, voxelChunkDoc(field, "mmo", cx, cz, { scatter: false, collision: false })); return cells.get(k)!; };
// curtains, world space, from every doc: their lip extents
type Curt = { lx: number; lz: number; dx: number; dz: number; lo: number; hi: number; top: number };
let total = 0;
for (const [fi, fall] of falls.entries()) {
  const lx = fall.x - fall.dirX * 3, lz = fall.z - fall.dirZ * 3;
  const cs = new Set<string>();
  for (const ox of [-R, 0, R]) for (const oz of [-R, 0, R]) cs.add(`${Math.floor((lx + ox) / size)},${Math.floor((lz + oz) / size)}`);
  // curtain of this fall: top row of the fall_ mesh
  let curt: Curt | null = null;
  const fcx = Math.floor(fall.x / size), fcz = Math.floor(fall.z / size);
  for (const [id, e] of Object.entries(doc(fcx, fcz).entities)) {
    if (!id.startsWith("fall_")) continue;
    const s = (e.components["mesh"] as { source: { positions: number[] } }).source;
    let lo = Infinity, hi = -Infinity, top = -Infinity;
    for (let i = 0; i < s.positions.length; i += 3) top = Math.max(top, s.positions[i + 1]!);
    if (Math.abs(top - fall.top) > 0.01) continue;
    for (let i = 0; i < s.positions.length; i += 3) {
      if (Math.abs(s.positions[i + 1]! - top) > 0.01) continue;
      const x = s.positions[i]! + fcx * size, z = s.positions[i + 2]! + fcz * size;
      const c = -(x - lx) * fall.dirZ + (z - lz) * fall.dirX;
      lo = Math.min(lo, c); hi = Math.max(hi, c);
    }
    curt = { lx, lz, dx: fall.dirX, dz: fall.dirZ, lo, hi, top };
  }
  let open = 0, covered = 0;
  const worst: string[] = [];
  for (const key of cs) {
    const [cx, cz] = key.split(",").map(Number) as [number, number];
    for (const [id, e] of Object.entries(doc(cx, cz).entities)) {
      if (!id.startsWith("water")) continue;
      const s = (e.components["mesh"] as { source: { positions: number[]; indices: number[] } }).source;
      const P = (i: number) => [s.positions[i * 3]! + cx * size, s.positions[i * 3 + 1]!, s.positions[i * 3 + 2]! + cz * size] as const;
      // boundary edges by position key (pieces are not index-shared)
      const kp = (i: number) => { const p = P(i); return `${p[0].toFixed(2)},${p[1].toFixed(2)},${p[2].toFixed(2)}`; };
      const edges = new Map<string, { a: number; b: number; n: number }>();
      for (let t = 0; t < s.indices.length; t += 3) for (let m = 0; m < 3; m++) {
        const a = s.indices[t + m]!, b = s.indices[t + ((m + 1) % 3)]!;
        const ka = kp(a), kb = kp(b); const k = ka < kb ? ka + "|" + kb : kb + "|" + ka;
        const got = edges.get(k); if (got) got.n++; else edges.set(k, { a, b, n: 1 });
      }
      for (const { a, b, n } of edges.values()) {
        if (n !== 1) continue;
        const pa = P(a), pb = P(b);
        const mx = (pa[0] + pb[0]) / 2, my = (pa[1] + pb[1]) / 2, mz = (pa[2] + pb[2]) / 2;
        const along = (mx - lx) * fall.dirX + (mz - lz) * fall.dirZ, across = -(mx - lx) * fall.dirZ + (mz - lz) * fall.dirX;
        if (Math.abs(along) > R || Math.abs(across) > R) continue;
        // chunk border edges are shared with the neighbour
        const onBorder = (v: number) => Math.abs(v / size - Math.round(v / size)) < 1e-4;
        if ((onBorder(pa[0]) && onBorder(pb[0])) || (onBorder(pa[2]) && onBorder(pb[2]))) continue;
        const over = my - field.height(mx, mz);
        if (over < 0.6) continue;
        if (curt && Math.abs(along) < 0.15 && Math.abs(my - curt.top) < 0.05 && across >= curt.lo - 0.05 && across <= curt.hi + 0.05) { covered++; continue; }
        // behind the curtain: the lower pool under its arc
        const foot = Math.min(3.4, 0.8 * Math.sqrt(fall.top - fall.bottom));
        if (curt && my < fall.top - 1 && along > -0.2 && along < foot + 0.2 && across >= curt.lo && across <= curt.hi) { covered++; continue; }
        open++;
        worst.push(`   along ${along.toFixed(1)} across ${across.toFixed(1)} y ${my.toFixed(2)} over ground ${over.toFixed(2)}`);
      }
    }
  }
  total += open;
  console.log(`lip ${fi} (top ${fall.top}): open air edges ${open}, on lip inside curtain ${covered}, curtain [${curt?.lo.toFixed(2)}, ${curt?.hi.toFixed(2)}]`);
  if (process.argv.includes("-v")) console.log(worst.join("\n"));
}
console.log("TOTAL open", total);

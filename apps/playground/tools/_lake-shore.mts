/* scratch: for every lake, walk outward from the outline; where does the ground rise over the water vs where does waterSurface stop */
import fs from "node:fs";
import { createWorldField, voxelChunkDoc, worldRecipeSchema } from "@hitreg/core";
const file = process.argv[2] ?? "projects/voxel-demo/assets/worlds/mmo.json";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
const field = createWorldField(recipe);
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
const VOX = field.voxelSize;
const drawn = (x: number, z: number): number => {
  const i = Math.floor(x / VOX), j = Math.floor(z / VOX);
  const u = x / VOX - i, v = z / VOX - j;
  const h = (a: number, b: number): number => field.height(a * VOX, b * VOX);
  return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
};
let rays = 0, gaps = 0;
const widths: number[] = [];
const samples: string[] = [];
for (const lake of recipe.features.lakes) {
  const poly = lake.polygon ?? [];
  const n = poly.length;
  if (n < 3) continue;
  let area = 0;
  for (let i = 0; i < n; i++) { const a = poly[i]!, b = poly[(i + 1) % n]!; area += a[0] * b[1] - b[0] * a[1]; }
  const sign = area > 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!, b = poly[(i + 1) % n]!;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    const nx = (sign * dz) / len, nz = (-sign * dx) / len;
    rays++;
    // from 6 m inside, outward to 3 banks
    let shore = NaN, stop = NaN;
    for (let t = -6; t <= lake.bank * 3; t += 0.5) {
      const x = mx + nx * t, z = mz + nz * t;
      if (Number.isNaN(shore) && drawn(x, z) >= lake.waterY + 0.1) shore = t;
      const isLakeWater = field.waterSurface(x, z, ws) && Math.abs(ws.y - lake.waterY) < 0.05;
      if (Number.isNaN(stop) && !isLakeWater) stop = t;
      if (!Number.isNaN(shore) && !Number.isNaN(stop)) break;
    }
    if (Number.isNaN(shore)) shore = lake.bank * 3;
    if (Number.isNaN(stop)) stop = lake.bank * 3;
    // a gap: the water stops before the ground rises out of it
    if (stop < shore - 0.6) {
      gaps++;
      widths.push(shore - stop);
      const sx = mx + nx * (stop + 1), sz = mz + nz * (stop + 1);
      const got = field.waterSurface(sx, sz, ws) ? ws.kind + " " + ws.y.toFixed(2) : "none";
      if (samples.length < 10) samples.push(`${lake.id}@${lake.waterY} [${mx.toFixed(0)},${mz.toFixed(0)}] water stops ${stop.toFixed(1)} m, shore at ${shore.toFixed(1)} m; past the stop: ${got}, ground ${drawn(sx, sz).toFixed(2)}`);
    }
  }
}
widths.sort((p, q) => p - q);
const q = (f: number) => (widths.length ? widths[Math.floor(f * (widths.length - 1))]!.toFixed(1) : "-");
console.log(`rays ${rays}, gaps ${gaps} (${((100 * gaps) / rays).toFixed(1)} %), gap width p50/p90/max ${q(0.5)} / ${q(0.9)} / ${q(1)} m`);
console.log(samples.join("\n"));

// mesh: shore cells of every lake — lattice points under lake water with no triangle
if (process.argv.includes("--mesh")) {
  const cells = new Set<string>();
  for (const lake of recipe.features.lakes) for (const p of lake.polygon ?? []) cells.add(`${Math.floor(p[0] / recipe.cellSize)},${Math.floor(p[1] / recipe.cellSize)}`);
  let under = 0, uncovered = 0;
  const miss: string[] = [];
  const list = [...cells].slice(0, 300);
  for (const c of list) {
    const [cx, cz] = c.split(",").map(Number) as [number, number];
    const doc = voxelChunkDoc(field, "w", cx, cz, { scatter: false, collision: false });
    const tris: number[][] = [];
    for (const [id, e] of Object.entries(doc.entities)) {
      if (!id.startsWith("water")) continue;
      const s = (e.components["mesh"] as { source: { positions: number[]; indices: number[] } }).source;
      for (let k = 0; k < s.indices.length; k += 3) tris.push([0, 1, 2].flatMap((m) => [s.positions[s.indices[k + m]! * 3]!, s.positions[s.indices[k + m]! * 3 + 2]!]));
    }
    const inTri = (x: number, z: number): boolean => tris.some((t) => {
      const [ax, az, bx, bz, cx2, cz2] = t as [number, number, number, number, number, number];
      const d1 = (x - bx) * (az - bz) - (ax - bx) * (z - bz), d2 = (x - cx2) * (bz - cz2) - (bx - cx2) * (z - cz2), d3 = (x - ax) * (cz2 - az) - (cx2 - ax) * (z - az);
      return !((d1 < -1e-6 || d2 < -1e-6 || d3 < -1e-6) && (d1 > 1e-6 || d2 > 1e-6 || d3 > 1e-6));
    });
    // cell-interior lattice points (skip the border ring: shared with the neighbour)
    for (let lx = VOX * 0.5; lx < recipe.cellSize; lx += VOX) for (let lz = VOX * 0.5; lz < recipe.cellSize; lz += VOX) {
      const x = cx * recipe.cellSize + lx, z = cz * recipe.cellSize + lz;
      if (!field.waterSurface(x, z, ws) || ws.kind !== 'lake') continue;
      if (drawn(x, z) > ws.y - 0.3) continue;
      // under the lake level by 0.3 m+, beside a lake: water should be drawn here
      // (only if connected to the lake: approximate as within 1.5 banks of the outline)
      under++;
      if (!inTri(lx, lz)) {
        uncovered++;
        if (miss.length < 12) miss.push(`[${x.toFixed(0)},${z.toFixed(0)}] ground ${drawn(x, z).toFixed(1)} water ${ws.y}`);
      }
    }
  }
  console.log(`mesh: ${list.length} shore cells, ${under} lattice points under a lake's level near it, ${uncovered} with no water triangle`);
  console.log(miss.join("\n"));
}

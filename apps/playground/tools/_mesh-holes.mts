/* scratch: mesh terrain cells near falls / river banks / lake shores and count holes + stretched triangles */
import fs from "node:fs";
import { buildVoxelMesh, createWorldField, worldRecipeSchema } from "@hitreg/core";
const file = process.argv[2] ?? "projects/voxel-demo/assets/worlds/mmo.json";
const lodSteps = (process.argv[3] ?? "1").split(",").map(Number);
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
const field = createWorldField(recipe);
const S = recipe.cellSize;
const cells = new Map<string, string>();
const add = (x: number, z: number, why: string) => {
  const k = `${Math.floor(x / S)},${Math.floor(z / S)}`;
  if (!cells.has(k)) cells.set(k, why);
};
for (const f of field.falls) for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) add(f.x + dx * S, f.z + dz * S, "fall");
for (const r of field.rivers) for (let k = 0; k < r.points.length; k += 6) add(r.points[k]![0], r.points[k]![1], "river");
const list = [...cells.entries()].slice(0, Number(process.argv[4] ?? 400));
for (const lodStep of lodSteps) {
  let holes = 0, holeCells = 0, stretched = 0, tris = 0, t0 = performance.now();
  const worst: string[] = [];
  const byWhy = new Map<string, number>();
  for (const [key, why] of list) {
    const [cx, cz] = key.split(",").map(Number) as [number, number];
    const mesh = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [cx, cz], lodStep } as never);
    const step = field.voxelSize * lodStep;
    const pos = mesh.positions;
    const idx = mesh.indices;
    tris += idx.length / 3;
    // weld by position
    const id = new Map<string, number>();
    const vid = (v: number) => {
      const k = `${pos[v * 3]!.toFixed(3)},${pos[v * 3 + 1]!.toFixed(3)},${pos[v * 3 + 2]!.toFixed(3)}`;
      let n = id.get(k);
      if (n === undefined) { n = id.size; id.set(k, n); }
      return n;
    };
    const w = new Int32Array(pos.length / 3);
    for (let v = 0; v < w.length; v++) w[v] = vid(v);
    const edges = new Map<string, number>();
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t]!, b = idx[t + 1]!, c = idx[t + 2]!;
      for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
        const u = w[p]!, v = w[q]!;
        if (u === v) continue;
        const k = u < v ? `${u}_${v}` : `${v}_${u}`;
        edges.set(k, (edges.get(k) ?? 0) + 1);
      }
      // stretched: an edge longer than ~2.5 lattice steps
      const L = (p: number, q: number) => Math.hypot(pos[p * 3]! - pos[q * 3]!, pos[p * 3 + 1]! - pos[q * 3 + 1]!, pos[p * 3 + 2]! - pos[q * 3 + 2]!);
      if (Math.max(L(a, b), L(b, c), L(c, a)) > step * 2.5) stretched++;
    }
    // positions are cell-local? detect border by min/max of all x,z
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let v = 0; v < w.length; v++) {
      x0 = Math.min(x0, pos[v * 3]!); x1 = Math.max(x1, pos[v * 3]!);
      z0 = Math.min(z0, pos[v * 3 + 2]!); z1 = Math.max(z1, pos[v * 3 + 2]!);
      y0 = Math.min(y0, pos[v * 3 + 1]!); y1 = Math.max(y1, pos[v * 3 + 1]!);
    }
    const inv = [...id.keys()].map((k) => k.split(",").map(Number));
    let h = 0;
    for (const [k, n] of edges) {
      if (n !== 1) continue;
      const [u, v] = k.split("_").map(Number) as [number, number];
      const pu = inv[u]!, pv = inv[v]!;
      const onX = (pp: number[]) => Math.abs(pp[0]! - x0) < 1e-3 || Math.abs(pp[0]! - x1) < 1e-3;
      const onZ = (pp: number[]) => Math.abs(pp[2]! - z0) < 1e-3 || Math.abs(pp[2]! - z1) < 1e-3;
      if ((onX(pu) && onX(pv)) || (onZ(pu) && onZ(pv))) continue;
      h++;
      if (worst.length < 12) worst.push(`${why} cell ${key} edge at local [${pu[0]!.toFixed(1)},${pu[1]!.toFixed(1)},${pu[2]!.toFixed(1)}] (band y ${y0.toFixed(0)}..${y1.toFixed(0)})`);
    }
    holes += h;
    if (h > 0) { holeCells++; byWhy.set(why, (byWhy.get(why) ?? 0) + 1); }
  }
  console.log(`lodStep ${lodStep}: ${list.length} cells, ${tris} tris, open edges ${holes} in ${holeCells} cells ${JSON.stringify(Object.fromEntries(byWhy))}, stretched tris ${stretched}, ${((performance.now() - t0) / list.length).toFixed(0)} ms/cell`);
  for (const l of worst) console.log("  " + l);
}

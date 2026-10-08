/**
 * voxel-blades — scan a voxel world's extracted chunks for blades (geometry
 * standing in open air: skirts or slivers poking out of the rock) and holes
 * (open edges after welding a region's cells). Read-only.
 *
 *   tsx tools/voxel-blades.mts <recipe.json> --box x0,z0,x1,z1   one region
 *   tsx tools/voxel-blades.mts <recipe.json> --sites [--only gnawspur]
 *                                        every passage group (id prefix) as its own region
 *   tsx tools/voxel-blades.mts <recipe.json> --caves [--limit 6]   legacy tunnel networks
 *   options: --lod 1 (lattice step multiplier), --air <density tolerance, default 0.75 step>, --worst 5, --json
 *
 * Exit code 1 when any region has a skirt end in air or an open edge, so it can gate.
 * ("blades" also counts surface vertices a little off a sharp field — MC
 * interpolation, tolerance-sized; skirt ends and open edges are the defects.)
 * Core: `auditVoxelMesh` (packages/core/src/voxel/mesh-audit.ts).
 */
import fs from "node:fs";
import { auditVoxelMesh, createWorldField, worldRecipeSchema } from "@hitreg/core";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && a.endsWith(".json"));
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!file) {
  console.error("usage: voxel-blades <recipe.json> (--box x0,z0,x1,z1 | --sites [--only prefix]) [--lod 1] [--worst 5] [--json]");
  process.exit(2);
}
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
const field = createWorldField(recipe);
const S = recipe.cellSize;
const lodStep = Number(opt("lod") ?? 1);
const worst = Number(opt("worst") ?? 5);

const regions: { name: string; box: [number, number, number, number] }[] = [];
const box = opt("box");
if (box) {
  const [x0, z0, x1, z1] = box.split(",").map(Number) as [number, number, number, number];
  regions.push({ name: "box", box: [Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1)] });
}
if (args.includes("--sites")) {
  const only = opt("only");
  const groups = new Map<string, [number, number, number, number]>();
  for (const p of recipe.features.passages) {
    const name = p.id ? p.id.split("-")[0]! : "unnamed";
    if (only && !name.startsWith(only)) continue;
    const end = p.start[p.axis === "x" ? 0 : 2] + p.direction * p.length;
    const half = p.width / 2 + p.wallNoise + p.falloff;
    const xs = p.axis === "x" ? [p.start[0], end] : [p.start[0] - half, p.start[0] + half];
    const zs = p.axis === "z" ? [p.start[2], end] : [p.start[2] - half, p.start[2] + half];
    const g = groups.get(name) ?? [Infinity, Infinity, -Infinity, -Infinity];
    groups.set(name, [Math.min(g[0], ...xs), Math.min(g[1], ...zs), Math.max(g[2], ...xs), Math.max(g[3], ...zs)]);
  }
  for (const [name, b] of groups) regions.push({ name, box: b });
}
if (args.includes("--caves")) {
  // legacy tunnel caves, one region per network (cave-N and its branches)
  const groups = new Map<string, [number, number, number, number]>();
  for (const t of recipe.features.tunnels) {
    const name = (t.id ?? "cave").split("-").slice(0, 2).join("-");
    const g = groups.get(name) ?? [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of t.points) {
      g[0] = Math.min(g[0], p[0]); g[1] = Math.min(g[1], p[2]); g[2] = Math.max(g[2], p[0]); g[3] = Math.max(g[3], p[2]);
    }
    groups.set(name, g);
  }
  const limit = Number(opt("limit") ?? 6);
  for (const [name, b] of [...groups].slice(0, limit)) regions.push({ name, box: b });
}
if (!regions.length) {
  console.error("voxel-blades: nothing to scan (give --box or --sites)");
  process.exit(2);
}

let bad = 0;
const out: unknown[] = [];
for (const r of regions) {
  const cells: [number, number, number, number] = [
    Math.floor(r.box[0] / S), Math.floor(r.box[1] / S), Math.floor(r.box[2] / S), Math.floor(r.box[3] / S),
  ];
  const t0 = performance.now();
  const air = opt("air");
  const a = auditVoxelMesh(field, { cells, lodStep, worst, ...(air ? { airTolerance: Number(air) } : {}) });
  const ms = Math.round(performance.now() - t0);
  if (a.skirtBladeVertices || a.openEdges) bad++;
  if (args.includes("--json")) {
    out.push({ region: r.name, cells, ...a });
    continue;
  }
  console.log(
    `${r.name.padEnd(18)} cells ${cells.join(",")} (${a.cells})  tris ${a.triangles}  blades ${a.bladeTriangles} tri / ${a.bladeVertices} vtx` +
      ` (skirt ends ${a.skirtBladeVertices} max ${a.skirtMaxAir.toFixed(2)}, slivers ${a.slivers}, max air ${a.maxAir.toFixed(2)})  open ${a.openEdges}  non-manifold ${a.nonManifoldEdges}  ${ms}ms`,
  );
  for (const o of a.openAt) console.log(`    open edge at ${o.map((v) => v.toFixed(1)).join(",")}`);
  for (const w of a.worst) {
    console.log(`    air ${w.air.toFixed(2)} at ${w.at.map((v) => v.toFixed(1)).join(",")} cell ${w.cell.join(",")}${w.skirt ? " SKIRT" : ""} edge ${w.edge.toFixed(1)}`);
  }
}
if (args.includes("--json")) console.log(JSON.stringify(out, null, 2));
process.exit(bad ? 1 : 0);

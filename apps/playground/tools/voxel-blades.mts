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
 *            --mesher auto|mc|dc|nets (default auto: what a scene with `voxelWorld.mesher: "auto"` streams —
 *            DC on planar-cliff cells, MC elsewhere; plain MC in a world without planarCliffs)
 *
 *   --clear (with --box): the REMOVER. Each round audits the box, takes the one-sample-thick solid cells behind every
 *   open edge (every air vertex too with --air-vertices) (core `bladeClearCells`) and forces them to air, then re-audits on the cleared field,
 *   up to --rounds (default 4). Dry run unless --apply, which writes them as one `features.floaterClears` entry
 *   `blades-<x0>-<z0>-<x1>-<z1>` (replaced on a re-run of the same box); the inverse is kept in
 *   <project>/authoring/installs/blades.inverse.json (entry state before the pass first touched it). --undo restores it.
 *
 * Exit code 1 when any region has a skirt end or a skirt triangle in air, or an open edge, so it can gate.
 * ("blades" also counts surface vertices a little off a sharp field — MC
 * interpolation, tolerance-sized; skirt ends and open edges are the defects.)
 * Core: `auditVoxelMesh` (packages/core/src/voxel/mesh-audit.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { auditVoxelMesh, bladeClearCells, createWorldField, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";
import { updateJsonFile } from "./_scene-write.mts";

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
type Clear = NonNullable<WorldRecipe["features"]["floaterClears"]>[number];
const invFile = path.resolve(path.dirname(path.resolve(file)), "..", "..", "authoring", "installs", "blades.inverse.json");
/** Replace exactly these floaterClears entries (null = remove), under the recipe's lock. */
function writeClears(entries: Map<string, Clear | null>): void {
  updateJsonFile(path.resolve(file), (raw) => {
    const fresh = worldRecipeSchema.parse(raw);
    const list = (fresh.features.floaterClears ?? []).filter((c) => !entries.has(c.id));
    for (const c of entries.values()) if (c && c.cells.length) list.push(c);
    list.sort((a, b) => a.id.localeCompare(b.id));
    fresh.features.floaterClears = list;
    return { doc: worldRecipeSchema.parse(fresh), removed: entries.size };
  }, { label: "voxel-blades --clear" });
}
if (args.includes("--undo")) {
  if (!fs.existsSync(invFile)) { console.error(`no inverse at ${invFile}`); process.exit(1); }
  const inv = JSON.parse(fs.readFileSync(invFile, "utf8")) as { before: Record<string, Clear | null> };
  writeClears(new Map(Object.entries(inv.before)));
  console.log(`restored ${Object.keys(inv.before).length} floaterClears entr(ies) from ${invFile}`);
  process.exit(0);
}
let field = createWorldField(recipe);
const S = recipe.cellSize;
const lodStep = Number(opt("lod") ?? 1);
const worst = Number(opt("worst") ?? 5);
const mesher = (opt("mesher") ?? "auto") as "auto" | "mc" | "dc" | "nets";

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

if (args.includes("--clear")) {
  if (!box) { console.error("--clear needs --box x0,z0,x1,z1"); process.exit(2); }
  const r = regions[0]!;
  const id = `blades-${r.box.map((v) => Math.round(v)).join("-")}`;
  const cells: [number, number, number, number] = [Math.floor(r.box[0] / S), Math.floor(r.box[1] / S), Math.floor(r.box[2] / S), Math.floor(r.box[3] / S)];
  const others = (recipe.features.floaterClears ?? []).filter((c) => c.id !== id);
  const cleared: number[] = [];
  const keys = new Set<string>();
  const air = opt("air");
  const rounds = Number(opt("rounds") ?? 4);
  const line = (n: string, a: ReturnType<typeof auditVoxelMesh>) =>
    console.log(`  ${n}: skirt ends ${a.skirtBladeVertices}, skirts in air ${a.skirtExposed} (pale ${a.skirtPale}), slivers ${a.slivers}, blade vtx ${a.bladeVertices}, open ${a.openEdges}, non-manifold ${a.nonManifoldEdges}`);
  field = createWorldField({ ...recipe, features: { ...recipe.features, floaterClears: others } });
  let a = auditVoxelMesh(field, { cells, lodStep, mesher, worst: 1e6, ...(air ? { airTolerance: Number(air) } : {}) });
  line("before", a);
  for (let k = 1; k <= rounds; k++) {
    // open edges only by default: measured on the Weepwater corridor, clearing behind the air vertices took 83 cells
    // and removed none of them (they are skirt flaps at the cell planes, a mesher matter); --air-vertices adds them
    const pts = [...(args.includes("--air-vertices") ? a.worst.map((w) => w.at) : []), ...a.openAt];
    const add = bladeClearCells(field, pts, { skip: keys });
    if (!add.length) break;
    for (let i = 0; i < add.length; i += 3) keys.add(`${add[i]},${add[i + 1]},${add[i + 2]}`);
    cleared.push(...add);
    field = createWorldField({ ...recipe, features: { ...recipe.features, floaterClears: [...others, { id, cells: cleared }] } });
    a = auditVoxelMesh(field, { cells, lodStep, mesher, worst: 1e6, ...(air ? { airTolerance: Number(air) } : {}) });
    line(`round ${k} (+${add.length / 3} cells)`, a);
  }
  console.log(`${id}: ${cleared.length / 3} cell(s) cleared${args.includes("--apply") ? "" : " (dry run: --apply writes them)"}`);
  if (args.includes("--list")) for (let i = 0; i < cleared.length; i += 3) console.log(`    ${cleared[i]},${cleared[i + 1]},${cleared[i + 2]}`);
  if (args.includes("--apply")) {
    const inv = fs.existsSync(invFile) ? (JSON.parse(fs.readFileSync(invFile, "utf8")) as { before: Record<string, Clear | null> }) : { before: {} as Record<string, Clear | null> };
    if (!(id in inv.before)) inv.before[id] = (recipe.features.floaterClears ?? []).find((c) => c.id === id) ?? null;
    fs.mkdirSync(path.dirname(invFile), { recursive: true });
    fs.writeFileSync(invFile, `${JSON.stringify({ note: "blade pass: each floaterClears entry before voxel-blades --clear touched it (--undo)", before: inv.before }, null, 1)}
`);
    writeClears(new Map([[id, cleared.length ? { id, cells: cleared } : null]]));
    console.log(`wrote ${id}; inverse ${invFile}`);
  }
  process.exit(a.skirtBladeVertices || a.openEdges ? 1 : 0);
}

let bad = 0;
const out: unknown[] = [];
for (const r of regions) {
  const cells: [number, number, number, number] = [
    Math.floor(r.box[0] / S), Math.floor(r.box[1] / S), Math.floor(r.box[2] / S), Math.floor(r.box[3] / S),
  ];
  const t0 = performance.now();
  const air = opt("air");
  const a = auditVoxelMesh(field, { cells, lodStep, mesher, worst, ...(air ? { airTolerance: Number(air) } : {}) });
  const ms = Math.round(performance.now() - t0);
  if (a.skirtBladeVertices || a.skirtExposed || a.openEdges) bad++;
  if (args.includes("--json")) {
    out.push({ region: r.name, cells, ...a });
    continue;
  }
  console.log(
    `${r.name.padEnd(18)} cells ${cells.join(",")} (${a.cells})  tris ${a.triangles}  blades ${a.bladeTriangles} tri / ${a.bladeVertices} vtx` +
      ` (skirt ends ${a.skirtBladeVertices} max ${a.skirtMaxAir.toFixed(2)}, skirts in air ${a.skirtExposed}/${a.skirtTriangles} pale ${a.skirtPale}, slivers ${a.slivers}, max air ${a.maxAir.toFixed(2)})  open ${a.openEdges}  non-manifold ${a.nonManifoldEdges}  ${ms}ms`,
  );
  for (const o of a.openAt) console.log(`    open edge at ${o.map((v) => v.toFixed(1)).join(",")}`);
  for (const w of a.worst) {
    console.log(`    air ${w.air.toFixed(2)} at ${w.at.map((v) => v.toFixed(1)).join(",")} cell ${w.cell.join(",")}${w.skirt ? " SKIRT" : ""} edge ${w.edge.toFixed(1)}`);
  }
}
if (args.includes("--json")) console.log(JSON.stringify(out, null, 2));
process.exit(bad ? 1 : 0);

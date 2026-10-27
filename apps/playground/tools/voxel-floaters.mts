/**
 * voxel-floaters — the floating-voxel pass. Solid lattice pieces cut off from the ground mass (overhang noise on a
 * steep river bank, the sliver a carve leaves) mesh as small rocks hanging in the air. This labels the solid voxels of
 * each swept square (26-connected, with a margin ring into the neighbours; core `findFloaters`), and with --apply
 * clears every floating piece smaller than `recipe.floaters.keepVoxels` (default 64) by writing it as data:
 * `features.floaterClears` (one entry per swept square, id `floaters-<x>-<z>`, replaced on a re-run).
 *
 *   tsx tools/voxel-floaters.mts <world> --project <p> (--box x0,z0,x1,z1 | --river <id> [--corridor 120] | --world)
 *        [--chunk 192] [--apply] [--stamp] [--out f.json] [--list]
 *   tsx tools/voxel-floaters.mts <world> --project <p> --undo        restore every entry the pass changed
 *
 * Without --apply it is the GATE: floating pieces in the area (after the clears already written) — exit 1 on any.
 * --apply: per square, drop its own old entry, scan, write the new one, then re-scan the cleared world (must be 0).
 * The inverse (each entry's state before the pass first touched it) is kept in
 * <project>/authoring/installs/floaters.inverse.json, overwritten in place. --stamp (with --world, clean) stamps the
 * `floaters` stage of `worldgen status`. Pieces >= keepVoxels are reported (bigFloating), never removed.
 */
import fs from "node:fs";
import path from "node:path";
import { buildVoxelMesh, createWorldField, findFloaters, resolveCellMesher, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";
import { worldChunks } from "./float.mts";
import { stampGateStage } from "./worldgen-operators.mts";
import { updateJsonFile } from "./_scene-write.mts";

const args = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (n: string): boolean => args.includes(`--${n}`);
const world = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
const project = opt("project");
if (!world || !project) {
  console.error("usage: voxel-floaters <world> --project <p> (--box x0,z0,x1,z1 | --river <id> | --world) [--apply] [--stamp] [--undo]");
  process.exit(2);
}
const file = path.resolve("projects", project, "assets", "worlds", `${world}.json`);
const invFile = path.resolve("projects", project, "authoring", "installs", "floaters.inverse.json");
type Clear = NonNullable<WorldRecipe["features"]["floaterClears"]>[number];
type Square = [number, number, number, number];
const read = (): WorldRecipe => worldRecipeSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));

/** Re-read the recipe and replace exactly these entries (null = remove): other jobs edit the world meanwhile. */
function writeClears(entries: Map<string, Clear | null>): void {
  updateJsonFile(file, (raw) => { // under the recipe's lock (tools/_scene-write.mts)
    const fresh = worldRecipeSchema.parse(raw);
    const kept = (fresh.features.floaterClears ?? []).filter((c) => !entries.has(c.id));
    const list = [...kept];
    for (const c of entries.values()) if (c && c.cells.length) list.push(c);
    list.sort((a, b) => a.id.localeCompare(b.id));
    fresh.features.floaterClears = list;
    return { doc: worldRecipeSchema.parse(fresh), removed: entries.size }; // at most the named entries go
  }, { label: "voxel-floaters" });
}

if (has("undo")) {
  if (!fs.existsSync(invFile)) {
    console.error(`no inverse at ${invFile}`);
    process.exit(1);
  }
  const inv = JSON.parse(fs.readFileSync(invFile, "utf8")) as { world: string; before: Record<string, Clear | null> };
  writeClears(new Map(Object.entries(inv.before)));
  fs.rmSync(invFile);
  console.log(`restored ${Object.keys(inv.before).length} floaterClears entr(ies); inverse consumed`);
  process.exit(0);
}

const loadedAt = new Date().toISOString();
const recipe = read();
const keep = recipe.floaters?.keepVoxels ?? 64;
const size = Number(opt("chunk") ?? 192);
const squares: Square[] = [];
const snap = (x: number): number => Math.floor(x / size) * size;
const boxArg = opt("box");
if (boxArg) {
  const [x0, z0, x1, z1] = boxArg.split(",").map(Number) as Square;
  for (let z = snap(Math.min(z0, z1)); z < Math.max(z0, z1); z += size)
    for (let x = snap(Math.min(x0, x1)); x < Math.max(x0, x1); x += size) squares.push([x, z, x + size, z + size]);
} else if (opt("river")) {
  const river = recipe.features.rivers.find((r) => r.id === opt("river"));
  if (!river) {
    console.error(`no river ${opt("river")}: ${recipe.features.rivers.map((r) => r.id).join(", ")}`);
    process.exit(2);
  }
  const corridor = Number(opt("corridor") ?? 120);
  const seen = new Set<string>();
  const pts = river.points as unknown as [number, number][];
  for (let s = 0; s + 1 < pts.length; s++) {
    const [ax, az] = pts[s]!, [bx, bz] = pts[s + 1]!;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 16));
    for (let k = 0; k <= n; k++) {
      const x = ax + ((bx - ax) * k) / n, z = az + ((bz - az) * k) / n;
      for (let qz = snap(z - corridor); qz <= z + corridor; qz += size)
        for (let qx = snap(x - corridor); qx <= x + corridor; qx += size) {
          const key = `${qx},${qz}`;
          if (!seen.has(key)) {
            seen.add(key);
            squares.push([qx, qz, qx + size, qz + size]);
          }
        }
    }
  }
} else if (has("world")) {
  squares.push(...worldChunks(createWorldField(recipe), size));
} else {
  console.error("give --box, --river or --world");
  process.exit(2);
}

const idOf = (q: Square): string => `floaters-${q[0]}-${q[1]}`;

/**
 * What the player SEES: the square's chunk meshes (the shipping mesher choice, `auto`), welded, split into connected
 * triangle islands; an island that never reaches the square's edge or the cell band's floor is a floating piece of
 * mesh. `--mesh` reports these beside the lattice count — the lattice pass is judged by them.
 */
function meshIslands(field: ReturnType<typeof createWorldField>, q: Square): { floating: number; bubbles: number; open: number; triangles: number; at: [number, number, number][] } {
  const S = field.recipe.cellSize;
  const pos: number[] = [], tri: number[] = [];
  const weld = new Map<string, number>();
  const vid = (x: number, y: number, z: number): number => {
    const k = `${Math.round(x * 50)},${Math.round(y * 50)},${Math.round(z * 50)}`;
    let i = weld.get(k);
    if (i === undefined) { i = pos.length / 3; weld.set(k, i); pos.push(x, y, z); }
    return i;
  };
  for (let cz = Math.floor(q[1] / S); cz < Math.ceil(q[3] / S); cz++)
    for (let cx = Math.floor(q[0] / S); cx < Math.ceil(q[2] / S); cx++) {
      const mesh = buildVoxelMesh(field, { kind: "voxel", world: field.recipe.name, cell: [cx, cz], mesher: resolveCellMesher(field, cx, cz, "auto") });
      const p = mesh.positions, ox = cx * S, oz = cz * S;
      const map: number[] = [];
      for (let v = 0; v < p.length / 3; v++) map.push(vid(p[v * 3]! + ox, p[v * 3 + 1]!, p[v * 3 + 2]! + oz));
      for (const i of mesh.indices) tri.push(map[i]!);
    }
  const parent = new Int32Array(pos.length / 3).map((_, i) => i);
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]!]!; a = parent[a]!; } return a; };
  for (let t = 0; t < tri.length; t += 3) { const a = find(tri[t]!); parent[find(tri[t + 1]!)] = a; parent[find(tri[t + 2]!)] = a; }
  type Island = { lo: number[]; hi: number[]; n: number; vol: number; edges: Map<string, number> };
  const islands = new Map<number, Island>();
  for (let t = 0; t < tri.length; t += 3) {
    const r = find(tri[t]!);
    let b = islands.get(r);
    if (!b) islands.set(r, (b = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], n: 0, vol: 0, edges: new Map() }));
    const a = tri[t]! * 3, c = tri[t + 1]! * 3, d = tri[t + 2]! * 3;
    const ax = pos[a]!, ay = pos[a + 1]!, az = pos[a + 2]!, bx = pos[c]!, by = pos[c + 1]!, bz = pos[c + 2]!, cx = pos[d]!, cy = pos[d + 1]!, cz = pos[d + 2]!;
    b.vol += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6; // + solid piece, - air pocket
    if (b.n < 400) for (let e = 0; e < 3; e++) { const u = tri[t + e]!, w = tri[t + ((e + 1) % 3)]!; const k = u < w ? `${u},${w}` : `${w},${u}`; b.edges.set(k, (b.edges.get(k) ?? 0) + 1); }
    for (const v of [a, c, d]) for (let ax3 = 0; ax3 < 3; ax3++) { b.lo[ax3] = Math.min(b.lo[ax3]!, pos[v + ax3]!); b.hi[ax3] = Math.max(b.hi[ax3]!, pos[v + ax3]!); }
    b.n += 1;
  }
  const eps = 0.01, at: [number, number, number][] = [];
  let floating = 0, bubbles = 0, open = 0, triangles = 0;
  for (const b of islands.values()) {
    if (b.lo[0]! <= q[0] + eps || b.lo[2]! <= q[1] + eps || b.hi[0]! >= q[2] - eps || b.hi[2]! >= q[3] - eps) continue; // continues past the square
    if (b.n >= 400) continue; // a big body (a landform, an arch) is not a stray voxel
    const closed = [...b.edges.values()].every((c) => c === 2);
    const centre: [number, number, number] = [(b.lo[0]! + b.hi[0]!) / 2, (b.lo[1]! + b.hi[1]!) / 2, (b.lo[2]! + b.hi[2]!) / 2];
    if (has("debug")) console.log(`    island ${b.n} tri ${closed ? "closed" : "open"} vol ${b.vol.toFixed(2)} at ${centre.map(Math.round).join(",")}`);
    if (!closed) { open += 1; continue; } // a band-clipped fragment, not a piece of rock in the air
    if (b.vol < 0) { bubbles += 1; continue; } // an air pocket sealed inside rock: never seen
    floating += 1;
    triangles += b.n;
    at.push(centre);
  }
  return { floating, bubbles, open, triangles, at };
}

if (has("mesh")) {
  // --preview: the islands left after this pass would clear the squares (in memory; nothing written)
  let field = createWorldField(recipe);
  if (has("preview")) {
    const clears = squares.map((q) => ({ id: idOf(q), cells: findFloaters(field, { x0: q[0], z0: q[1], x1: q[2], z1: q[3] }, { keepVoxels: keep, connect: opt("connect") === "26" ? 26 : 6 }).floaters.flatMap((f) => f.cells) }));
    field = createWorldField({ ...recipe, features: { ...recipe.features, floaterClears: [...(recipe.features.floaterClears ?? []), ...clears] } });
  }
  let islands = 0, bubbles = 0, open = 0;
  for (const q of squares) {
    const r = meshIslands(field, q);
    islands += r.floating; bubbles += r.bubbles; open += r.open;
    if (r.floating) console.log(`  ${idOf(q)}: ${r.floating} floating piece(s) of mesh, ${r.triangles} tri — ${r.at.slice(0, 4).map((p) => p.map(Math.round).join(",")).join("  ")}`);
  }
  console.log(`${world} mesh (${squares.length} squares${has("preview") ? ", after the pass (preview)" : ""}): ${islands} floating piece(s); ${bubbles} sealed air pocket(s), ${open} open fragment(s) not counted`);
  process.exit(islands ? 1 : 0);
}

interface Row { id: string; box: Square; floaters: number; voxels: number; bigFloating: number; after?: number; ms: number; worst?: [number, number, number] }
const rows: Row[] = [];
const t0 = Date.now();

function scanAll(field: ReturnType<typeof createWorldField>, onSquare: (q: Square, scan: ReturnType<typeof findFloaters>) => void): void {
  for (const q of squares) onSquare(q, findFloaters(field, { x0: q[0], z0: q[1], x1: q[2], z1: q[3] }, { keepVoxels: keep, connect: opt("connect") === "26" ? 26 : 6 }));
}
const rowOf = (q: Square, scan: ReturnType<typeof findFloaters>): Row => {
  const worst = scan.floaters.slice().sort((a, b) => b.size - a.size)[0];
  return { id: idOf(q), box: q, floaters: scan.floaters.length, voxels: scan.floaters.reduce((s, f) => s + f.size, 0), bigFloating: scan.bigFloating, ms: scan.ms, worst: worst?.centre };
};

if (has("apply")) {
  const ids = new Set(squares.map(idOf));
  const stripped: WorldRecipe = { ...recipe, features: { ...recipe.features, floaterClears: (recipe.features.floaterClears ?? []).filter((c) => !ids.has(c.id)) } };
  const entries = new Map<string, Clear | null>();
  scanAll(createWorldField(stripped), (q, scan) => {
    const cells = scan.floaters.flatMap((f) => f.cells);
    entries.set(idOf(q), cells.length ? { id: idOf(q), cells } : null);
    rows.push(rowOf(q, scan));
  });
  // inverse: each entry as it was BEFORE the pass first touched it (kept across runs; overwritten in place)
  const inv = fs.existsSync(invFile) ? (JSON.parse(fs.readFileSync(invFile, "utf8")) as { before: Record<string, Clear | null> }) : { before: {} as Record<string, Clear | null> };
  const old = new Map((recipe.features.floaterClears ?? []).map((c) => [c.id, c] as const));
  for (const id of entries.keys()) if (!(id in inv.before)) inv.before[id] = old.get(id) ?? null;
  fs.mkdirSync(path.dirname(invFile), { recursive: true });
  fs.writeFileSync(invFile, `${JSON.stringify({ note: "floating-voxel pass: each floaterClears entry before the pass touched it (tools/voxel-floaters.mts --undo)", world, before: inv.before }, null, 1)}\n`);
  writeClears(entries);
  // verify on the cleared world: the gate
  let i = 0;
  scanAll(createWorldField(read()), (_q, scan) => {
    rows[i++]!.after = scan.floaters.length;
  });
} else {
  scanAll(createWorldField(recipe), (q, scan) => rows.push(rowOf(q, scan)));
}

const total = rows.reduce((s, r) => s + r.floaters, 0);
const remaining = has("apply") ? rows.reduce((s, r) => s + (r.after ?? 0), 0) : total;
const big = rows.reduce((s, r) => s + r.bigFloating, 0);
const out = {
  world,
  area: boxArg ? `box ${boxArg}` : opt("river") ? `river ${opt("river")} ±${opt("corridor") ?? 120} m` : "whole world",
  squares: rows.length,
  keepVoxels: keep,
  applied: has("apply"),
  counts: { floaters: total, voxels: rows.reduce((s, r) => s + r.voxels, 0), remaining, bigFloating: big },
  ok: remaining === 0,
  seconds: Math.round((Date.now() - t0) / 1000),
  rows: rows.filter((r) => r.floaters || r.bigFloating || r.after),
};
const outFile = opt("out");
if (outFile) {
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(out, null, 1)}\n`);
}
console.log(
  `${world} floaters (${out.area}, ${rows.length} squares of ${size} m, keep >= ${keep} voxels): ` +
    `${has("apply") ? `cleared ${total} piece(s) / ${out.counts.voxels} voxel(s); after: ${remaining}` : `${total} floating piece(s), ${out.counts.voxels} voxel(s)`}; ` +
    `${big} big floating kept; ${out.seconds} s`,
);
for (const r of has("list") ? out.rows : out.rows.slice(0, 12))
  console.log(`  ${r.id}: ${r.floaters} piece(s), ${r.voxels} voxel(s)${r.bigFloating ? `, ${r.bigFloating} big` : ""}${r.after !== undefined ? `, after ${r.after}` : ""}${r.worst ? ` (largest at ${r.worst.map((v) => Math.round(v)).join(",")})` : ""}`);
console.log(out.ok ? "OK: nothing floats" : "FAIL: floating voxels (tools/voxel-floaters.mts ... --apply)");
if (has("stamp")) {
  if (has("world") && out.ok) {
    stampGateStage(file, "floaters", loadedAt);
    console.log(`stamped floaters (${loadedAt})`);
  } else console.log("not stamped: --stamp needs a clean --world sweep");
}
if (!out.ok) process.exitCode = 1;

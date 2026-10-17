/**
 * `ledge-landmark` — bake a `ledges` operator's LANDMARK (mode "landmark"): the solids it compiled, dual-contoured at
 * the operator's fine voxel, merged into ONE GLB (the world's terrain-splat material: one draw) plus a prefab with a
 * trimesh collider. The world streams it through `features.landmarks` (packages/core voxel/ledge-landmark.ts).
 *
 *   node node_modules/tsx/dist/cli.mjs tools/ledge-landmark.mts <project> <world> <opId> [--recipe <file>]
 *        [--into <project>] [--tiles 0,3] [--dry-run] [--force] [--report <file.json>]
 *
 * The solids are rebuilt from the INSTALLED operator doc (`worldgen op --apply` first): the same solve, the same
 * digest, so the prefab id the recipe names (`landmarks/<opId>-<digest>`) is the one written here. `--into` names the
 * project whose assets receive the bake (default <project>; a scratch recipe's lab project). `--tiles` bakes only
 * those tiles (a pipeline check on a small piece). Old bakes are kept: an undo names them again.
 *
 * REACH (on by default; --no-fix-reach skips it): the COLLIDER is the truth. After the bake the tool walks the baked
 * trimesh from the hillside (tools/_collider-reach.mts, caves mouth to mouth); every core shelf it cannot reach gets a
 * repair ramp (<= 0.5 grade, >= 2.6 m wide between >= 1.5 m cheeks) from the nearest reached ground, written into the
 * operator's `reachRepairs` and re-applied to the recipe (inverse kept), then it re-bakes: at most 3 rounds. A shelf still
 * cut off is printed as a FAULT and the tool exits 1.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  applyOperator,
  buildVolumeMesh,
  createVolume,
  createWorldField,
  landmarkOptions,
  landmarkPrefabId,
  landmarkTileDoc,
  ledgeLandmarkVolume,
  ledgesOperatorSchema,
  operatorParams,
  solveLedges,
  worldRecipeSchema,
  zoneWallStone,
  type RecipeEdit,
  type VoxelMesh,
  type WorldRecipe,
} from "@hitreg/core";
import { closeReach, type ColliderMesh, type ReachRepair, type ReachSite } from "./_collider-reach.mts";
import { operatorReader, sideDir } from "./worldgen-operators.mts";
import { mergeMeshes as mergeAll, openEdges, writeVolumeGlb } from "./_volume-glb.mts";
// @ts-expect-error plain JS tool module
import { decimateRough } from "../../../tools/mesh-dc/decimate.mjs";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(`--${name}`);
const valued = new Set(["--recipe", "--into", "--tiles", "--report", "--material"]);
const [project, world, opId] = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && valued.has(argv[i - 1]!)));
if (!project || !world || !opId) {
  console.error("usage: ledge-landmark <project> <world> <opId> [--recipe <file>] [--into <project>] [--tiles 0,3] [--dry-run] [--force] [--report f] [--material <id>: one world-space triplanar rock material, e.g. the zone cliff stone]");
  process.exit(1);
}
const recipeFile = flag("recipe") ?? join("projects", project, "assets", "worlds", `${world}.json`);
const recipe = worldRecipeSchema.parse(JSON.parse(readFileSync(recipeFile, "utf8")));
const doc = (recipe.features.operators ?? []).find((o) => o.id === opId) as Record<string, unknown> | undefined;
if (!doc || doc.op !== "ledges") throw new Error(`no installed ledges operator "${opId}" in ${recipeFile} (worldgen op --apply first)`);
const params = ledgesOperatorSchema.parse(operatorParams(doc));
const names = recipe.surfaces.map((s) => s.name);
if (params.mode !== "landmark") throw new Error(`"${opId}" is mode ${params.mode}: nothing to bake`);
const fixReach = !has("no-fix-reach");
const t0 = performance.now();

interface Baked { recipe: WorldRecipe; prefabId: string; digest: string; lmReport: Record<string, unknown>; tiles: number; parts: number; merged: VoxelMesh; cells: number; seconds: number; stoneName: string; coverName: string; mesh: ColliderMesh; site: ReachSite }

/** Solve + solids + DC bake of the operator as installed in `rec`, merged, trimmed and decimated (nothing written). */
function bake(rec: WorldRecipe, inLoop = false): Baked {
  const tb = performance.now();
  const doc = (rec.features.operators ?? []).find((o) => o.id === opId) as Record<string, unknown>;
  const params = ledgesOperatorSchema.parse(operatorParams(doc));
  const reader = operatorReader(rec, opId!);
  const solve = solveLedges(params, reader, { id: opId! });
  const lm = ledgeLandmarkVolume(solve.grid, landmarkOptions(params, reader));
  const prefabId = landmarkPrefabId(opId!, lm.digest);
  const piece = (rec.features.landmarks ?? []).find((l) => l.id === `op:${opId}:landmark`);
  if (!piece) console.warn(`note: the recipe has no op:${opId}:landmark piece (installed in height mode?)`);
  else if (piece.prefab !== prefabId && !inLoop) console.warn(`WARNING: the recipe names ${piece.prefab} but the solids rebuild as ${prefabId}: the operator is stale (worldgen op --check / --apply)`);
  const t1 = performance.now();
  const r = solve.report as { bandHeight: number; levels: number[]; shelves: unknown[]; ramps: unknown[]; caveLinks: { from: number; to: number; length: number; grade: number; minCover: number }[]; unlinked: unknown[]; maxCut: number; maxFill: number; shelfAnchors: [number, number, number][] };
  console.log(`solve: band ${r.bandHeight} m, ${r.levels.length} levels, ${r.shelves.length} shelves, ${r.ramps.length} ramps, ${r.caveLinks.length} caves ${JSON.stringify(r.caveLinks.map((c) => [c.from, c.to, c.length, c.grade, c.minCover]))}, unlinked ${JSON.stringify(r.unlinked)}, cut/fill ${r.maxCut}/${r.maxFill}`);
  console.log(`solve + solids ${(t1 - tb).toFixed(0)} ms: ${lm.nodes.length} nodes (${lm.report.masses} masses, ${lm.report.notches} notches, ${lm.report.boulders} boulders, ${lm.report.caves} caves / ${lm.report.caveNodes} bore nodes), ${lm.tiles.length} tiles, voxel ${lm.voxel} m, fine ${lm.report.fine.join("x")}`);

  // ---- surfaces: the world's palette; faces = the zone's own cliff stone sampled on this slope, tops = its ground cover
  const field = createWorldField(rec);
  const count = field.surfaceCount;
  const scratch = new Float32Array(count + 3), wall = new Float64Array(count + 3), top = new Float64Array(count + 3);
  let wn = 0, tn = 0;
  const { x0, z0, g, cols, rows, W } = solve.grid;
  for (let rr = 0; rr < rows; rr += 3) for (let c = 0; c < cols; c += 3) {
    if (W[rr * cols + c]! < 0.97) continue;
    const x = x0 + c * g, z = z0 + rr * g, y = field.height(x, z);
    field.surfaceAt(x, y, z, 0.3, scratch, 0); for (let i = 0; i < count + 3; i++) wall[i]! += scratch[i]!; wn++;
    field.surfaceAt(x, y, z, 0.98, scratch, 0); for (let i = 0; i < count + 3; i++) top[i]! += scratch[i]!; tn++;
  }
  const avg = (a: Float64Array, nn: number) => Array.from(a, (v) => v / Math.max(1, nn));
  const wallAvg = avg(wall, wn), topAvg = avg(top, tn);
  const ranked = (w: number[]) => w.slice(0, count).map((v, i) => [i, v] as const).sort((a, b) => b[1] - a[1]);
  const stoneName = zoneWallStone(field, wallAvg, wn) ?? (names.includes("rock") ? "rock" : names[ranked(wallAvg)[0]![0]]!);
  const wallIndex = names.indexOf(stoneName);
  const stoneLike = (i: number) => i === wallIndex || /rock|cliff|stone|slate/i.test(names[i]!);
  const coverIndex = ranked(topAvg).find(([i]) => !stoneLike(i))?.[0] ?? wallIndex;
  const tint: [number, number, number] = [wallAvg[count]!, wallAvg[count + 1]!, wallAvg[count + 2]!].map((v) => Math.round(v * 1000) / 1000) as [number, number, number];
  console.log(`surfaces: faces ${stoneName} (#${wallIndex}), tops ${names[coverIndex]} (#${coverIndex}), tint ${tint.join(",")}`);

  // ---- bake: every tile meshed on its own lattice-aligned box, merged into one mesh
  const only = flag("tiles")?.split(",").map(Number);
  const parts: VoxelMesh[] = [];
  let cells = 0;
  for (let t = 0; t < lm.tiles.length; t++) {
    if (only && !only.includes(t)) continue;
    const tile = lm.tiles[t]!;
    const vdoc = landmarkTileDoc(lm, t, names, { floor: coverIndex, wall: wallIndex, ceiling: wallIndex }, tint);
    const m0 = performance.now();
    const mesh = buildVolumeMesh(createVolume(vdoc));
    const nc = tile.max.map((v, i) => Math.round((v - tile.min[i]!) / lm.voxel)).reduce((a, b) => a * b, 1);
    cells += nc;
    if (has("verbose")) console.log(`  tile ${t}: ${nc} cells, ${mesh.triangleCount} tris, ${(performance.now() - m0).toFixed(0)} ms`);
    if (mesh.triangleCount) parts.push(mesh);
  }
  const raw = mergeAll(parts, names.length);
  // buried rock (the slab past the shelving core, under the terrain that covers it) is never seen: drop it, then
  // decimate the noised relief under an absolute error bound (mesh-dc decimate.mjs, as the dungeon bakes do)
  const [ox, , oz] = lm.origin;
  // ...except inside a cave bore: the ground patch cannot trench a deep narrow bore (its maxSlope), so the terrain
  // stands over the bore, yet the bore is walked from inside. Keep everything within the bore radius + 2 m of its floor line.
  const boreSegs = solve.grid.caves.flatMap((cv) => cv.floor.slice(1).map((b, k) => ({ a: cv.floor[k]!, b, r: cv.radius * 1.4 + 2 })));
  const inBore = (x: number, y: number, z: number) => boreSegs.some(({ a, b, r: rad }) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], ll = dx * dx + dy * dy + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1] - rad / 2) * dy + (z - a[2]) * dz) / ll));
    return Math.hypot(x - a[0] - dx * t, y - a[1] - rad / 2 - dy * t, z - a[2] - dz * t) < rad;
  });
  const buried = (i: number) => {
    const x = raw.positions[i * 3]! + ox, y = raw.positions[i * 3 + 1]!, z = raw.positions[i * 3 + 2]! + oz;
    return y < field.height(x, z) - 1.5 && !inBore(x, y, z);
  };
  const keepTris: number[] = [];
  for (let t = 0; t < raw.indices.length; t += 3) {
    const a = raw.indices[t]!, b = raw.indices[t + 1]!, c = raw.indices[t + 2]!;
    if (!(buried(a) && buried(b) && buried(c))) keepTris.push(a, b, c);
  }
  const visible = { ...raw, indices: Uint32Array.from(keepTris), triangleCount: keepTris.length / 3 } as VoxelMesh;
  const error = Number(flag("error") ?? 0.06);
  // the simplifier weighs at most 32 attributes: decimate on the splat channels this rock uses, then widen back
  const S = visible.surfaceCount, used: number[] = [];
  for (let k = 0; k < S; k++) { for (let i = 0; i < visible.vertexCount; i++) if (visible.splat[i * S + k]! > 0) { used.push(k); break; } }
  const narrow = new Float32Array(visible.vertexCount * used.length);
  for (let i = 0; i < visible.vertexCount; i++) used.forEach((k, j) => { narrow[i * used.length + j] = visible.splat[i * S + k]!; });
  const dec = decimateRough({ ...visible, splat: narrow, surfaceCount: used.length }, { error }) as VoxelMesh;
  const wide = new Float32Array(dec.vertexCount * S);
  for (let i = 0; i < dec.vertexCount; i++) used.forEach((k, j) => { wide[i * S + k] = dec.splat[i * used.length + j]!; });
  const merged = { ...dec, splat: wide, surfaceCount: S } as VoxelMesh;
  console.log(`trim: ${raw.triangleCount} -> ${visible.triangleCount} tris (buried dropped); decimate (error ${error} m) -> ${merged.triangleCount}`);
  const seconds = (performance.now() - t1) / 1000;
  const [cx, cz] = params.center ?? [x0 + ((cols - 1) * g) / 2, z0 + ((rows - 1) * g) / 2];
  const radius = params.radius ?? Math.hypot((cols - 1) * g, (rows - 1) * g) / 2;
  return {
    recipe: rec, prefabId, digest: lm.digest, lmReport: lm.report as unknown as Record<string, unknown>, tiles: lm.tiles.length, parts: parts.length, merged, cells, seconds, stoneName, coverName: names[coverIndex]!,
    mesh: { positions: merged.positions, indices: merged.indices, offset: [ox, 0, oz] },
    site: { center: [cx, cz], radius, ground: (x, z) => field.height(x, z), anchors: r.shelfAnchors, caves: solve.grid.caves.map((cv) => cv.floor as [number, number, number][]) },
  };
}

// ---- the loop (--fix-reach, on unless --no-fix-reach): bake, walk the COLLIDER from the hillside (caves mouth to
// mouth), add a repair ramp for every core shelf it cannot reach, re-apply the operator with them (its digest moves),
// re-bake; at most 3 rounds, then every shelf still cut off is a FAULT, out loud (exit 1)
const installed = (recipe.features.operators ?? []).find((o) => o.id === opId) as Record<string, unknown>;
const params0 = ledgesOperatorSchema.parse(operatorParams(installed));
let current: WorldRecipe = recipe;
const inverse: RecipeEdit[] = [];
// a round only changes the doc's params (the bake reads the field WITHOUT the operator's own pieces, and the ground patch
// does not depend on the repairs): the recipe is re-applied ONCE, after the loop, with the final repair list
const withRepairs = (rec: WorldRecipe, repairs: ReachRepair[]): WorldRecipe => ({ ...rec, features: { ...rec.features, operators: (rec.features.operators ?? []).map((o) => (o.id === opId ? { ...o, reachRepairs: repairs } : o)) } }) as WorldRecipe;
const rebake = (repairs: ReachRepair[]): Baked => bake(JSON.stringify(repairs) === JSON.stringify(params0.reachRepairs) ? recipe : withRepairs(recipe, repairs), true);
let b: Baked, faults: number[] = [], added: ReachRepair[] = [];
if (fixReach && !flag("tiles")) {
  const loop = closeReach({ initial: params0.reachRepairs, bake: rebake, band: params0.bandHeight, maxRounds: 3, log: (l) => console.log(`  ${l}`) });
  b = loop.last; faults = loop.faults; added = loop.added;
  if (added.length) {
    const res = applyOperator(current, { ...installed, reachRepairs: loop.repairs }, operatorReader(current, opId!));
    inverse.unshift(...res.inverse);
    current = res.recipe;
  }
  const a = b.site.anchors, fmt = (k: number) => `${a[k]![0].toFixed(0)},${a[k]![1].toFixed(0)} @${a[k]![2].toFixed(0)}`;
  console.log(`reach on the collider: ${loop.reach.withCaves.filter(Boolean).length}/${a.length} with caves, ${loop.reach.withoutCaves.filter(Boolean).length}/${a.length} without; cave-only [${loop.reach.caveOnly.map(fmt).join(" | ")}]; ${loop.rounds} repair round(s), ${added.length} ramp(s) added`);
  for (const k of faults) console.log(`FAULT: core shelf ${fmt(k)} is NOT reachable on the baked collider after ${loop.rounds} repair round(s)`);
  if (faults.length) process.exitCode = 1;
} else b = bake(current);
const prefabId = b.prefabId, merged = b.merged;
const t2 = performance.now();
const edges = openEdges(merged);
console.log(`bake: ${merged.triangleCount} tris, ${merged.vertexCount} verts, ${b.cells} cells, ${b.seconds.toFixed(1)} s (total ${((t2 - t0) / 1000).toFixed(1)} s); open edges ${edges} (tile seams are closed by the overlap)`);
const report = { prefab: prefabId, digest: b.digest, tiles: b.tiles, baked: b.parts, triangles: merged.triangleCount, vertices: merged.vertexCount, draws: 1, bakeSeconds: Math.round(b.seconds * 10) / 10, openEdges: edges, surfaces: { faces: b.stoneName, tops: b.coverName }, reachRepairsAdded: added, reachFaults: faults.map((k) => b.site.anchors[k]), ...b.lmReport };
if (flag("report")) writeFileSync(flag("report")!, JSON.stringify(report, null, 2) + "\n");
if (has("dry-run")) { console.log("(dry run: nothing written)"); process.exit(process.exitCode ?? 0); }
if (inverse.length) {
  const inv = join(sideDir(recipeFile), "undo", `${recipe.name}.reach-${opId}.${new Date().toISOString().replace(/[:.]/g, "-")}.inverse.json`);
  mkdirSync(dirname(inv), { recursive: true });
  writeFileSync(inv, `${JSON.stringify({ world: recipe.name, what: `reach-${opId}`, edits: inverse }, null, 1)}\n`);
  writeFileSync(recipeFile, `${JSON.stringify(worldRecipeSchema.parse(current), null, 2)}\n`);
  console.log(`wrote ${recipeFile} (${added.length} reach repair(s) on ${opId}); inverse: ${inv} (worldgen op ${recipe.name} --undo <it>)`);
}

const into = join("projects", flag("into") ?? project, "assets");
const name = prefabId.slice("landmarks/".length);
const glb = join(into, "models", "landmarks", `${name}.glb`), prefabFile = join(into, "prefabs", "landmarks", `${name}.json`);
if (existsSync(prefabFile) && !has("force")) { console.log(`${prefabFile} exists (same digest): nothing to do (--force rewrites)`); process.exit(process.exitCode ?? 0); }
mkdirSync(join(into, "models", "landmarks"), { recursive: true });
mkdirSync(join(into, "prefabs", "landmarks"), { recursive: true });
writeVolumeGlb(merged, glb);
const prefab = {
  version: 1,
  name: `${opId} landmark`,
  root: "rock",
  entities: {
    rock: {
      name: `${opId} landmark`,
      parent: null,
      tags: ["landmark", "ledges", opId],
      components: {
        transform: {},
        mesh: { source: { kind: "asset", assetId: `landmarks/${name}.glb` }, material: flag("material") ?? recipe.material ?? "terrain/mmo", static: true, castShadow: true, receiveShadow: true },
        collider: { shape: "trimesh" },
      },
    },
  },
};
writeFileSync(prefabFile, JSON.stringify(prefab, null, 2) + "\n");
console.log(`wrote ${glb} (${(statSync(glb).size / 1024).toFixed(0)} KB) and ${prefabFile}`);

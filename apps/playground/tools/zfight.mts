/**
 * ZFIGHT — does any plane belong to two meshes? And does every decal land on the surface it was placed on?
 *
 *   node tools/zfight.mts <project> [--scene <id|file>] [--world <recipe id>] [--near x,z,r] [--gap 0.02] [--angle 3]
 *                         [--min-area 0.01] [--skip <regex>] [--top 20] [--decals | --decals-only] [--json] [--out f]
 *
 * --near x,z,r: measure one region of a big world (a POI) — only the triangles whose bounds reach the square of half-width
 * r round (x, z), the voxel chunks under that square, and the world's baked landmark operators (built/stamp bakes, placed
 * as float places them: tools/float.mts withLandmarkSupport). A whole streamed world is too big for one soup.
 *
 * Z-fight: two separately drawn surfaces on one plane flicker at close range — the DC shell under a kit floor, a
 * built pad on terrain, overlapping kit pieces, a prop sunk flush into a floor. The scene's STATIC geometry is
 * loaded the way float/flat-art load it (`sceneGeometry`: scene GLBs, prefab instances through nested prefabs and
 * kit pieces, surfaces, primitives) plus the voxel chunks under it when the scene has a voxelWorld, in world space;
 * `findZFights` (packages/core/src/zfight.ts) reports overlaps of different draws (mesh or material) that face the
 * same way within `--angle` degrees and lie within `--gap` metres. One mesh owns each plane: fix the builder that
 * emits the second copy (cut the pad out of the floor, drop the shell's face under the kit slab, lift the prop).
 *
 * Decals (`--decals`): every `decal` entity's projector box exactly as packages/render/src/decals.ts builds it,
 * a grid of rays from the box's front plane along the projection: ON the painted surface, BLOCKED by geometry in
 * front of it (beam, pier, prop: the blocker is named), EMPTY (nothing facing in the box: in air, past an edge).
 *
 * Writes reports/engine/zfight.json (scene = project id; else zfight.<scene>.json) and, with --decals,
 * reports/engine/decals.json (decals.<scene>.json). Numbers: tools/dungeon-pipeline/thresholds.json `zfight`.
 * Exceptions: authoring/quality-exceptions.json { gate: "zfight", check: "<meshA>|<meshB>" | "*" , why } and
 * { gate: "decal-placement", check: "<decal id>", why }. Exit 1 when a gate fails.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildVoxelMesh,
  createWorldField,
  decalCoverage,
  decalFrame,
  decalFrameBounds,
  findZFights,
  worldRecipeSchema,
  worldTransforms,
  type SceneDoc,
  type ZFightMesh,
} from "@hitreg/core";
import { prefabFile, readJson, sceneGeometry } from "./_prop-geometry.mts";
import { withLandmarkSupport } from "./float.mts";
import { findAsset, PROJECTS } from "./_closure.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const THRESHOLDS = path.resolve(HERE, "../../../tools/dungeon-pipeline/thresholds.json");
const opt = (argv: string[], name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export interface ZFightThresholds {
  maxGap: number; maxAngleDeg: number; minClusterArea: number; failClusterArea: number;
  decals: { grid: number; layerTol: number; maxBlocked: number; maxEmpty: number };
}
export function zfightThresholds(): ZFightThresholds {
  const def: ZFightThresholds = { maxGap: 0.02, maxAngleDeg: 3, minClusterArea: 0.01, failClusterArea: 0.05, decals: { grid: 12, layerTol: 0.12, maxBlocked: 0.1, maxEmpty: 0.25 } };
  try { const t = JSON.parse(fs.readFileSync(THRESHOLDS, "utf8")).zfight ?? {}; return { ...def, ...t, decals: { ...def.decals, ...(t.decals ?? {}) } }; } catch { return def; }
}

/** Static scene entities only: no characters, creatures, fx pools, dynamic bodies or bare trigger boxes. */
const DYNAMIC_TAGS = new Set(["player", "npc", "mob", "creature", "fx", "dynamic"]);
const isStatic = (e: any): boolean => {
  const c = e.components ?? {};
  if ((e.tags ?? []).some((t: string) => DYNAMIC_TAGS.has(t))) return false;
  // mesh.static is the HLOD/batch opt-in (default false), NOT "this moves": a plain primitive pad is drawn where it
  // stands and z-fights like any kit piece (2026-10-29 f-house2: the lab pad flickered through the house floor unseen)
  if (c.mesh && c.mesh.moving === true) return false;
  if (/^(characters|mobs)\//.test(c.prefab?.prefabId ?? "")) return false;
  const rb = c.rigidBody ?? c.rigidbody;
  if (rb && rb.type && rb.type !== "fixed" && rb.type !== "static") return false;
  if (c.collider?.isTrigger && !c.mesh && !c.prefab) return false;
  // a bare collider (no mesh, no prefab) is physics only, never drawn: it cannot flicker against the visual it shadows
  if (c.collider && !c.mesh && !c.prefab) return false;
  return true;
};

export interface StaticSoup {
  meshes: ZFightMesh[];
  /** For decals: one soup, owner per triangle, owner labels. */
  soup: Float32Array;
  owners: Int32Array;
  labels: string[];
  /** Owner indices that do not take decals or stand in front of them (water, veils). */
  passThrough: Set<number>;
}

/** A square region of the world: centre (x, z), half-width r. */
export interface Near { x: number; z: number; r: number }
export function parseNear(v: string | undefined): Near | undefined {
  if (!v) return undefined;
  const [x, z, r] = v.split(",").map(Number);
  if (![x, z, r].every((n) => Number.isFinite(n)) || !(r! > 0)) throw new Error(`--near wants x,z,r (got ${v})`);
  return { x: x!, z: z!, r: r! };
}
/** Does triangle t of a world-space soup (9 floats each) reach the region? (its XZ bounds overlap the square) */
export function triangleNear(world: ArrayLike<number>, t: number, n: Near): boolean {
  const o = t * 9, x0 = Math.min(world[o]!, world[o + 3]!, world[o + 6]!), x1 = Math.max(world[o]!, world[o + 3]!, world[o + 6]!);
  const z0 = Math.min(world[o + 2]!, world[o + 5]!, world[o + 8]!), z1 = Math.max(world[o + 2]!, world[o + 5]!, world[o + 8]!);
  return x1 >= n.x - n.r && x0 <= n.x + n.r && z1 >= n.z - n.r && z0 <= n.z + n.r;
}
/** The voxel cells (cellSize C) under the region. */
export function nearCells(n: Near, C: number): [number, number][] {
  const out: [number, number][] = [];
  for (let cx = Math.floor((n.x - n.r) / C); cx <= Math.floor((n.x + n.r) / C); cx++) for (let cz = Math.floor((n.z - n.r) / C); cz <= Math.floor((n.z + n.r) / C); cz++) out.push([cx, cz]);
  return out;
}

/** Hidden draws do not fight: a prefab part (`<prefabId>:<entity>`) whose entity is `visibility.visible: false` (a
 *  landmark bake's welded collider mesh, a trigger proxy) is physics or logic, never on screen. */
export function hiddenPart(assets: string, part: string, cache = new Map<string, Record<string, any>>()): boolean {
  const i = part.lastIndexOf(":");
  if (i <= 0) return false;
  const pid = part.slice(0, i), eid = part.slice(i + 1);
  let ents = cache.get(pid);
  if (!ents) { try { ents = readJson(prefabFile(assets, pid)).entities ?? {}; } catch { ents = {}; } cache.set(pid, ents!); }
  return ents![eid]?.components?.visibility?.visible === false;
}

const worldIdOf = (ents: Record<string, any>): string | undefined => { for (const e of Object.values(ents)) if (e.components?.voxelWorld?.world) return e.components.voxelWorld.world; return undefined; };

/** The scene's static triangles, one ZFightMesh per entity (per prefab part), plus voxel chunks under the scene (with
 *  `near`: only what reaches that region, plus the world's baked landmark operators). */
export function staticSoup(project: string, assets: string, doc: SceneDoc, skip: RegExp | null, worldId?: string, near?: Near): StaticSoup {
  const ents = doc.entities as Record<string, any>;
  worldId ??= worldIdOf(ents);
  const recipeFile = worldId ? findAsset(project, `worlds/${worldId}.json`) : undefined;
  const recipe = recipeFile ? readJson(recipeFile) : undefined;
  const source = near && recipe ? withLandmarkSupport(assets, doc, recipe.features?.operators ?? [], recipe.features?.landmarks ?? []) : doc;
  const geo = sceneGeometry(assets, source as never, (id, e) => !isStatic(e) || e.components?.visibility?.visible === false || !!(skip && skip.test(`${id} ${e.name ?? ""}`)));
  const hiddenCache = new Map<string, Record<string, any>>();
  const meshes: ZFightMesh[] = [];
  const passThroughIds = new Set<string>();
  for (const g of geo) {
    const e = ents[g.id] ?? {};
    const fallback = typeof e.components?.mesh?.material === "string" ? e.components.mesh.material : "-";
    const isPass = /water|zone-boundary|veil/i.test(`${fallback} ${g.id}`);
    const byPart = new Map<string, { pos: number[]; mat: number[]; mats: string[]; mi: Map<string, number> }>();
    const n = g.world.length / 9;
    for (let t = 0; t < n; t++) {
      if (near && !triangleNear(g.world, t, near)) continue;
      if (g.parts[t] && hiddenPart(assets, g.parts[t]!, hiddenCache)) continue;
      const part = g.parts[t] ? `${g.id}/${g.parts[t]}` : g.id;
      let b = byPart.get(part);
      if (!b) byPart.set(part, (b = { pos: [], mat: [], mats: [], mi: new Map() }));
      const d = g.draws[t];
      const m = d === undefined ? fallback : d.startsWith("mat-@") ? fallback + d.slice(4) : d;
      let k = b.mi.get(m);
      if (k === undefined) { k = b.mats.length; b.mi.set(m, k); b.mats.push(m); }
      b.mat.push(k);
      for (let c = 0; c < 9; c++) b.pos.push(g.world[t * 9 + c]!);
    }
    for (const [id, b] of byPart) {
      meshes.push({ id, positions: new Float32Array(b.pos), triMaterial: b.mat, materials: b.mats });
      if (isPass) passThroughIds.add(id);
    }
  }
  // the voxel world under the scene: chunks within the static geometry's bounds (one draw: chunk seams are skirts)
  if (worldId) {
    if (recipe) {
      const field = createWorldField(worldRecipeSchema.parse(recipe));
      const vw = Object.values(ents).find((e) => e.components?.voxelWorld)?.components?.voxelWorld ?? {};
      const C = field.recipe.cellSize;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const m of meshes) for (let k = 0; k < m.positions.length; k += 3) { x0 = Math.min(x0, m.positions[k]!); x1 = Math.max(x1, m.positions[k]!); z0 = Math.min(z0, m.positions[k + 2]!); z1 = Math.max(z1, m.positions[k + 2]!); }
      const cells: [number, number][] = near ? nearCells(near, C) : [];
      if (!near && Number.isFinite(x0)) for (let cx = Math.floor(x0 / C); cx <= Math.floor(x1 / C); cx++) for (let cz = Math.floor(z0 / C); cz <= Math.floor(z1 / C); cz++) cells.push([cx, cz]);
      {
        const pos: number[] = [];
        for (const [cx, cz] of cells) {
            const vm = buildVoxelMesh(field, { kind: "voxel", world: worldId, cell: [cx, cz], lodStep: 1, mesher: vw.mesher } as never);
            const P = vm.positions, I = vm.indices;
            for (let t = 0; t < vm.triangleCount; t++) {
              const tri: number[] = [];
              for (let k = 0; k < 3; k++) { const i = I[t * 3 + k]!; tri.push(P[i * 3]! + cx * C, P[i * 3 + 1]!, P[i * 3 + 2]! + cz * C); }
              if (!near || triangleNear(tri, 0, near)) pos.push(...tri);
            }
          }
        if (pos.length) meshes.push({ id: `voxel:${worldId}`, positions: new Float32Array(pos), materials: ["terrain"] });
      }
    }
  }
  let total = 0;
  for (const m of meshes) total += m.positions.length;
  const soup = new Float32Array(total), owners = new Int32Array(total / 9), labels: string[] = [], passThrough = new Set<number>();
  let o = 0;
  meshes.forEach((m, i) => {
    soup.set(m.positions as Float32Array, o);
    owners.fill(i, o / 9, (o + m.positions.length) / 9);
    o += m.positions.length;
    labels.push(m.id);
    if (passThroughIds.has(m.id)) passThrough.add(i);
  });
  return { meshes, soup, owners, labels, passThrough };
}

/** Each mesh's lowest y. */
export function meshBottoms(meshes: { id: string; positions: ArrayLike<number> }[]): Map<string, number> {
  const out = new Map<string, number>(); for (const m of meshes) { let lo = Infinity; for (let i = 1; i < m.positions.length; i += 3) lo = Math.min(lo, m.positions[i]!); out.set(m.id, lo); } return out;
}
/** A down-facing cluster at the BOTTOM of both (non-terrain) meshes: two pieces' base planes where they overlap, facing
 *  the ground they stand on (never seen). L (o-gates 2026-10-30). */
export function isBaseOnBase(c: { a: { mesh: string }; b: { mesh: string }; normal: number[]; centre: number[] }, bottoms: Map<string, number>, tol = 0.05): boolean {
  if (c.normal[1]! > -0.95 || c.a.mesh.startsWith("voxel:") || c.b.mesh.startsWith("voxel:")) return false;
  return [c.a.mesh, c.b.mesh].every((m) => { const lo = bottoms.get(m); return lo !== undefined && c.centre[1]! <= lo + tol; });
}

function exceptions(projectDir: string, gate: string): { check: string; why: string }[] {
  try {
    const j = readJson(path.join(projectDir, "authoring/quality-exceptions.json"));
    return (j?.exceptions ?? []).filter((e: any) => e?.gate === gate && typeof e.why === "string" && e.why.trim().length >= 8);
  } catch { return []; }
}

/** Decal placement over the static soup. */
export function decalPlacement(doc: SceneDoc, s: StaticSoup, T: ZFightThresholds["decals"]) {
  const wt = worldTransforms(doc);
  // coarse 3D grid of triangles (2 m) for the box queries
  const CELL = 2, grid = new Map<string, number[]>();
  const N = s.owners.length;
  for (let t = 0; t < N; t++) {
    if (s.passThrough.has(s.owners[t]!)) continue;
    const lo = [0, 1, 2].map((c) => Math.floor(Math.min(s.soup[t * 9 + c]!, s.soup[t * 9 + 3 + c]!, s.soup[t * 9 + 6 + c]!) / CELL));
    const hi = [0, 1, 2].map((c) => Math.floor(Math.max(s.soup[t * 9 + c]!, s.soup[t * 9 + 3 + c]!, s.soup[t * 9 + 6 + c]!) / CELL));
    for (let x = lo[0]!; x <= hi[0]!; x++) for (let y = lo[1]!; y <= hi[1]!; y++) for (let z = lo[2]!; z <= hi[2]!; z++) {
      const k = `${x},${y},${z}`;
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(t);
    }
  }
  const rows: any[] = [];
  for (const [id, e] of Object.entries(doc.entities as Record<string, any>)) {
    const d = e.components?.decal;
    if (!d) continue;
    const w = wt.get(id as never);
    if (!w) continue;
    const frame = decalFrame({ position: w.position, rotation: w.rotation, size: d.size ?? [1, 1], depth: d.depth ?? 0.25, direction: d.direction, rotationDeg: d.rotation ?? 0 });
    const { min, max } = decalFrameBounds(frame);
    const cand = new Set<number>();
    for (let x = Math.floor(min[0] / CELL); x <= Math.floor(max[0] / CELL); x++)
      for (let y = Math.floor(min[1] / CELL); y <= Math.floor(max[1] / CELL); y++)
        for (let z = Math.floor(min[2] / CELL); z <= Math.floor(max[2] / CELL); z++) for (const t of grid.get(`${x},${y},${z}`) ?? []) cand.add(t);
    const c = decalCoverage(s.soup, s.owners, frame, { grid: T.grid, layerTol: T.layerTol, maxAngle: d.maxAngle ?? 60, candidates: [...cand] });
    const top = [...c.blockers.entries()].sort((a, b) => b[1] - a[1]);
    const why: string[] = [];
    if (c.blockedShare > T.maxBlocked) why.push(`blocked ${Math.round(c.blockedShare * 100)}% > ${Math.round(T.maxBlocked * 100)}%`);
    if (c.emptyShare > T.maxEmpty) why.push(`empty ${Math.round(c.emptyShare * 100)}% > ${Math.round(T.maxEmpty * 100)}%`);
    rows.push({
      id, texture: d.texture, at: w.position.map(r3), on: r3(c.onShare), blocked: r3(c.blockedShare), empty: r3(c.emptyShare),
      blockers: top.slice(0, 3).map(([o, k]) => ({ mesh: s.labels[o] ?? String(o), share: r3(k / c.samples) })),
      ...(why.length ? { fail: why.join(", ") } : {}),
    });
  }
  return rows;
}

export function main(argv: string[]): void {
  const fail = (m: string): never => { console.error(m); process.exit(2); };
  const project = argv[0];
  if (!project || project.startsWith("--")) fail("usage: zfight <project> [--scene <id|file>] [--world <recipe id>] [--near x,z,r] [--gap 0.02] [--angle 3] [--min-area 0.01] [--skip <regex>] [--top 20] [--decals | --decals-only] [--json] [--out f]   (a big world: always --near; see the file header)");
  const dir = path.join(PROJECTS, project!);
  const assets = path.join(dir, "assets");
  const s = opt(argv, "scene");
  const file = s && fs.existsSync(s) ? s : path.join(assets, "scenes", `${s ?? project}.scene.json`);
  if (!fs.existsSync(file)) fail(`no scene ${file}; pass --scene`);
  const sceneId = path.basename(file).replace(/\.scene\.json$/, "");
  const doc = readJson(file) as SceneDoc;
  const T = zfightThresholds();
  const gap = Number(opt(argv, "gap") ?? T.maxGap), angle = Number(opt(argv, "angle") ?? T.maxAngleDeg), minArea = Number(opt(argv, "min-area") ?? T.minClusterArea);
  const skip = opt(argv, "skip") ? new RegExp(opt(argv, "skip")!) : null;
  const top = Number(opt(argv, "top") ?? 20);
  const t0 = Date.now();
  const near = parseNear(opt(argv, "near"));
  const soup = staticSoup(project!, assets, doc, skip, opt(argv, "world"), near);
  const loadMs = Date.now() - t0;
  const suffix = sceneId === project ? "" : `.${sceneId}`;
  const outDir = path.join(dir, "reports/engine");
  fs.mkdirSync(outDir, { recursive: true });
  let failed = false;

  if (!argv.includes("--decals-only")) {
    const r = findZFights(soup.meshes, { maxGap: gap, maxAngleDeg: angle, minArea });
    const ex = exceptions(dir, "zfight");
    const exFor = (a: string, b: string) => ex.find((e) => e.check === "*" || e.check === `${a}|${b}` || e.check === `${b}|${a}`);
    // L (o-gates 2026-10-30, the Moon: pylons overlapping the gate block): two pieces' BASE planes (down-facing, at the
    // bottom of both meshes) coincide where they overlap; they face the ground they stand on and are never seen. Not charged.
    const bottom = meshBottoms(soup.meshes), baseOnBase = (c: (typeof r.clusters)[number]) => isBaseOnBase(c, bottom);
    const failures = r.clusters.filter((c) => c.area >= T.failClusterArea && !exFor(c.a.mesh, c.b.mesh) && !baseOnBase(c));
    const excepted = r.clusters.filter((c) => c.area >= T.failClusterArea && (exFor(c.a.mesh, c.b.mesh) || baseOnBase(c))).length;
    const totalArea = r3(r.clusters.reduce((t, c) => t + c.area, 0));
    const report = {
      gate: "zfight", passed: failures.length === 0, at: new Date().toISOString(), scene: sceneId,
      rule: `one mesh owns each plane: no two draws (different mesh or material) facing the same way within ${angle} deg, closer than ${gap} m, overlapping >= ${T.failClusterArea} m2 in one cluster`,
      thresholds: { maxGap: gap, maxAngleDeg: angle, minClusterArea: minArea, failClusterArea: T.failClusterArea },
      region: near ?? null,
      metrics: { meshes: soup.meshes.length, triangles: r.triangles, tested: r.tested, overlaps: r.overlaps, clusters: r.clusters.length, failing: failures.length, excepted, totalArea, loadMs, ms: r.ms },
      failures: failures.slice(0, 200).map((c) => ({ check: `${c.a.mesh}|${c.b.mesh}`, what: `${c.area} m2 at ${c.centre.join(",")} n=${c.normal.join(",")}: ${c.a.mesh} [${c.a.material}] vs ${c.b.mesh} [${c.b.material}]` })),
      byMeshPair: r.byMeshPair,
      clusters: r.clusters.slice(0, 2000),
    };
    const out = opt(argv, "out") ?? path.join(outDir, `zfight${suffix}.json`);
    fs.writeFileSync(out, JSON.stringify(report, null, 1) + "\n");
    failed ||= !report.passed;
    if (argv.includes("--json")) console.log(JSON.stringify(report.metrics));
    else {
      console.log(`zfight ${project}/${sceneId}: ${soup.meshes.length} meshes, ${r.triangles} tris, ${r.clusters.length} clusters (${totalArea} m2), ${failures.length} failing >= ${T.failClusterArea} m2  [load ${loadMs} ms, detect ${r.ms} ms]`);
      console.log("\nby mesh pair (area m2, clusters):");
      for (const p of r.byMeshPair.slice(0, top)) console.log(`  ${String(p.area).padStart(9)}  ${String(p.clusters).padStart(4)}  ${p.a}  <->  ${p.b}   ${p.materials.slice(0, 2).join("; ")}`);
      console.log(`\ntop ${Math.min(top, r.clusters.length)} clusters:`);
      for (const c of r.clusters.slice(0, top)) console.log(`  ${String(c.area).padStart(9)} m2  gap ${c.gap.toFixed(3)}  at ${c.centre.map((v) => v.toFixed(1)).join(",").padEnd(22)} n ${c.normal.map((v) => v.toFixed(2)).join(",").padEnd(17)} ${c.a.mesh} [${c.a.material}] | ${c.b.mesh} [${c.b.material}]`);
      console.log(`\n${report.passed ? "PASS" : "FAIL"}  -> ${path.relative(process.cwd(), out)}`);
    }
  }

  if (argv.includes("--decals") || argv.includes("--decals-only")) {
    const rows = decalPlacement(doc, soup, T.decals);
    const ex = exceptions(dir, "decal-placement");
    const failing = rows.filter((r) => r.fail && !ex.some((e) => e.check === "*" || e.check === r.id));
    const report = {
      gate: "decal-placement", passed: failing.length === 0, at: new Date().toISOString(), scene: sceneId,
      rule: `every decal lands on its surface: of a ${T.decals.grid}x${T.decals.grid} ray grid from the projector box's front plane, at most ${Math.round(T.decals.maxBlocked * 100)}% BLOCKED by geometry in front of the painted surface and ${Math.round(T.decals.maxEmpty * 100)}% EMPTY`,
      thresholds: T.decals,
      metrics: { decals: rows.length, failing: failing.length },
      failures: failing.map((r) => ({ check: r.id, what: `${r.id} (${r.texture}) ${r.fail}${r.blockers.length && r.blocked > 0 ? `; blocked by ${r.blockers[0].mesh}` : ""}` })),
      decals: rows,
    };
    const out = path.join(outDir, `decals${suffix}.json`);
    fs.writeFileSync(out, JSON.stringify(report, null, 1) + "\n");
    failed ||= !report.passed;
    if (!argv.includes("--json")) {
      console.log(`\ndecals ${project}/${sceneId}: ${rows.length} decals, ${failing.length} failing (blocked > ${T.decals.maxBlocked * 100}% or empty > ${T.decals.maxEmpty * 100}%)`);
      for (const r of failing) console.log(`  ${r.id.padEnd(28)} ${String(r.texture).padEnd(34)} on ${Math.round(r.on * 100)}% blocked ${Math.round(r.blocked * 100)}% empty ${Math.round(r.empty * 100)}%${r.blocked > 0 && r.blockers[0] ? `  blocker ${r.blockers[0].mesh}` : ""}`);
      console.log(`${report.passed ? "PASS" : "FAIL"}  -> ${path.relative(process.cwd(), out)}`);
    } else console.log(JSON.stringify(report.metrics));
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main(process.argv.slice(2));

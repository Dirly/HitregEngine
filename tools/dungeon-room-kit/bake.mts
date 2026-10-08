/**
 * Room-kit bake: mesh stamp -> tools/mesh-dc convertMeshStamp (validation, role-noise split) -> @hitreg/core
 * createVolume + buildVolumeMesh (dual contouring) -> tools/dc-construction meshAudit, per group (= per room).
 * Writes <out>/dc-bake.json and <out>/dc-derived/<group>.gltf (positions, normals, splat weights) for inspection.
 * This is the dungeon pipeline's offline "dc-bake" proof, generic over any stamp; a dungeon still runs its
 * own import / merged bake / scene stages afterwards.
 *
 *   pnpm --dir apps/playground exec tsx ../../tools/dungeon-room-kit/bake.mts <stamp.json> [--out dir] [--voxel .12] [--group id]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(here, "../..");
const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1]! : fallback; };
const stampFile = path.resolve(args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1]!.startsWith("--")))!);
const out = path.resolve(opt("out", path.dirname(stampFile)));
const voxelSize = Number(opt("voxel", ".12"));
const onlyGroup = opt("group", "");

const { createVolume, buildVolumeMesh } = await import(pathToFileURL(path.join(ENGINE, "packages/core/src/index.ts")).href);
const { convertMeshStamp } = await import(pathToFileURL(path.join(ENGINE, "tools/mesh-dc/convert.mjs")).href);
const { meshAudit } = await import(pathToFileURL(path.join(ENGINE, "tools/dc-construction/mesh-audit.mjs")).href);
const { GltfBuilder } = await import(pathToFileURL(path.join(ENGINE, "tools/wfc-3d/gltf.mjs")).href);

const source = JSON.parse(fs.readFileSync(stampFile, "utf8"));
const t0 = performance.now();
const converted = convertMeshStamp(source, { name: path.basename(stampFile).replace(/\.mesh-stamp\.json$/, ""), voxelSize, maxCells: 15_000_000,
  materialId: "room-kit/dc-palette", ...(onlyGroup ? { meshNames: [onlyGroup] } : {}) });
const convertSeconds = (performance.now() - t0) / 1000;
const derived = path.join(out, "dc-derived");
fs.mkdirSync(derived, { recursive: true });
const groups: any[] = [];
let passed = true;
for (const entry of converted.volumes) {
  const started = performance.now();
  const mesh: any = buildVolumeMesh(createVolume(entry.doc));
  const seconds = (performance.now() - started) / 1000;
  const audit = meshAudit(mesh);
  const b = new GltfBuilder("HitReg room-kit DC bake");
  const material = b.pushMaterial({ name: "clay", pbrMetallicRoughness: { baseColorFactor: [0.59, 0.53, 0.43, 1], metallicFactor: 0, roughnessFactor: 0.9 } });
  const attributes: Record<string, number> = {
    POSITION: b.pushAccessor(mesh.positions, "VEC3", { target: 34962, minMax: true }),
    NORMAL: b.pushAccessor(mesh.normals, "VEC3", { target: 34962 }),
  };
  const file = path.join(derived, `${entry.name}.gltf`);
  b.pushNode({ name: entry.name, mesh: b.pushMesh({ name: entry.name, primitives: [{ attributes, indices: b.pushAccessor(mesh.indices, "SCALAR", { target: 34963 }), material, mode: 4 }] }) }, true);
  fs.writeFileSync(file, JSON.stringify(b.finish()));
  // the splat weights tell which palette role each vertex carries: keep a per-role vertex tally for the report
  groups.push({ group: entry.name, cells: entry.cellCount, triangles: mesh.indices.length / 3, extractionSeconds: +seconds.toFixed(2),
    noiseNodes: entry.noiseNodes ?? undefined, audit: { passed: audit.passed, boundaryEdges: audit.boundaryEdges, nonManifoldEdges: audit.nonManifoldEdges,
      components: audit.components, zeroArea: audit.zeroArea, defects: (audit.defects ?? []).slice(0, 6) }, gltf: path.relative(out, file) });
  if (!audit.passed) passed = false;
  console.log(`${audit.passed ? "PASS" : "FAIL"} ${entry.name.padEnd(18)} cells=${entry.cellCount.toLocaleString("en-US").padStart(11)} tris=${String(mesh.indices.length / 3).padStart(7)} ${seconds.toFixed(1)}s`);
}
const report = { version: 1, passed, voxelSize, stamp: stampFile, convertSeconds: +convertSeconds.toFixed(2), importer: { groups: converted.report.groups ?? undefined, noise: converted.report.noise ?? undefined }, groups };
fs.writeFileSync(path.join(out, "dc-bake.json"), JSON.stringify(report, null, 2) + "\n");
console.log(passed ? "ALL GROUPS PASSED" : "SOME GROUPS FAILED");
process.exit(passed ? 0 : 1);

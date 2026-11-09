/**
 * wall-foot — the ground the TERRAIN MESH draws at the foot of every terrace / kit retaining wall (e-paving 2026-11-02).
 *
 *   npx tsx tools/wall-foot.mts <world> --project <p> [--near x,z,r] [--max 0.15] [--share 0.02] [--compare] [--json out.json]
 *
 * The field is sharp at a wall foot (its face cut meets the floor in a corner), but marching cubes draws that corner
 * as one chamfer across the lattice cell: a dirt fillet ~1 m high at 0.25 m in front of the face on a 2 m lattice (Bell
 * Strand's red mounds along every close wall). Core `squareWallFeet` (mesh.ts, `wallFootSnap`) squares it. This gate
 * meshes every cell a wall face touches exactly as the client does (`buildVoxelMesh`, auto mesher) and casts down onto
 * the mesh at 0.25 m and 1 m in front of each face every metre: the height above the wall foot is the fillet. Exit 1 when
 * more than `--share` (default 2 %) of the samples at 0.25 m stand more than `--max` (default 0.15 m) above the foot (the
 * share is for floor vertices pinned on a cell corner column or a side plane nearly parallel to the wall).
 *
 * --compare meshes every touched cell with the pass OFF and ON and reports what moved: no surface vertex outside a
 * wall-foot band (less than a lattice diagonal in front of a face cut's back plane, less than a step above its floor) may
 * move; hidden skirt vertices re-clamped on a cell side plane are counted apart. The proof that the fix touches wall
 * feet and nothing else.
 */
import fs from "node:fs";
import path from "node:path";
import { buildVoxelMesh, createWorldField, resolveCellMesher, wallFootSnap, worldRecipeSchema } from "@hitreg/core";
import { findAsset } from "./_closure.mjs";

const argv = process.argv.slice(2);
const opt = (k: string, d = ""): string => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };
const world = argv[0] && !argv[0].startsWith("--") ? argv[0] : "";
const project = opt("project");
if (!world || !project) { console.error("usage: wall-foot <world> --project <p> [--near x,z,r] [--max 0.15] [--share 0.02] [--compare] [--json out.json]"); process.exit(2); }
const file = findAsset(project, path.join("worlds", `${world}.json`));
if (!file) { console.error(`wall-foot: no world ${world} in ${project}'s closure`); process.exit(2); }
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
const field = createWorldField(recipe);
const maxFillet = Number(opt("max", "0.15"));
// a floor vertex on a cell CORNER column, or on a side plane the wall runs within ~17 deg of, cannot slide onto the foot
// line without leaving its plane (the skirts and the neighbour pin it): a few short fillets stay there
const maxShare = Number(opt("share", "0.02"));
const near = opt("near") ? opt("near").split(",").map(Number) : null;
const S = recipe.cellSize;

interface Face { wall: string; ox: number; oz: number; dx: number; dz: number; s0: number; s1: number; n0: number; y0: number }
const faces: Face[] = [];
for (const tw of recipe.features.terraceWalls ?? []) {
  for (const c of tw.solved?.cuts ?? []) if (c.kind === "face") faces.push(faceOf(tw.id, c));
}
for (const kw of recipe.features.kitWalls ?? []) for (const c of kw.cuts) if (c.kind === "face") faces.push(faceOf(kw.id, c));
function faceOf(wall: string, c: { origin: [number, number]; dir: [number, number]; s: [number, number]; n: [number, number]; y: [number, number] }): Face {
  const l = Math.hypot(c.dir[0], c.dir[1]) || 1;
  // the face itself runs s in [0, len]: a cut reaches past it by CUT_BEHIND or CUT_FRONT at a corner
  const s0 = c.s[0] < 0 ? 0 : c.s[0];
  const s1 = c.s[0] < 0 ? c.s[1] + c.s[0] : c.s[1];
  return { wall, ox: c.origin[0], oz: c.origin[1], dx: c.dir[0] / l, dz: c.dir[1] / l, s0, s1, n0: c.n[0], y0: c.y[0] };
}
const inNear = (x: number, z: number): boolean => !near || Math.hypot(x - near[0]!, z - near[1]!) <= near[2]!;
const at = (f: Face, s: number, n: number): [number, number] => [f.ox + f.dx * s - f.dz * n, f.oz + f.dz * s + f.dx * n];

// cells every sample lands in
const samples: { f: Face; s: number; x25: [number, number]; x100: [number, number] }[] = [];
for (const f of faces) {
  // 1 m in from each end: past an open end the bank ramps up beside the wall, which is not a foot
  for (let s = f.s0 + 1; s <= f.s1 - 1; s += 1) {
    const p = at(f, s, 0.25), q = at(f, s, 1);
    if (inNear(p[0], p[1])) samples.push({ f, s, x25: p, x100: q });
  }
}
const cellKey = (x: number, z: number): string => `${Math.floor(x / S)},${Math.floor(z / S)}`;
const cells = new Set<string>();
for (const q of samples) { cells.add(cellKey(...q.x25)); cells.add(cellKey(...q.x100)); }

interface CellMesh { x0: number; z0: number; pos: Float32Array; idx: Uint32Array; grid: Map<number, number[]> }
function meshCell(key: string, snap: boolean): CellMesh {
  const [cx, cz] = key.split(",").map(Number) as [number, number];
  wallFootSnap.enabled = snap;
  const m = buildVoxelMesh(field, { kind: "voxel", world, cell: [cx, cz], mesher: resolveCellMesher(field, cx, cz, "auto") } as never);
  wallFootSnap.enabled = true;
  const x0 = cx * S, z0 = cz * S;
  const grid = new Map<number, number[]>();
  for (let t = 0; t < m.indices.length / 3; t++) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (let k = 0; k < 3; k++) { const v = m.indices[t * 3 + k]!; a = Math.min(a, m.positions[v * 3]!); c = Math.max(c, m.positions[v * 3]!); b = Math.min(b, m.positions[v * 3 + 2]!); d = Math.max(d, m.positions[v * 3 + 2]!); }
    for (let gz = Math.floor(b); gz <= Math.floor(d); gz++) for (let gx = Math.floor(a); gx <= Math.floor(c); gx++) {
      const g = gz * 4096 + gx; const l = grid.get(g); if (l) l.push(t); else grid.set(g, [t]);
    }
  }
  return { x0, z0, pos: m.positions, idx: m.indices, grid };
}
/** Highest mesh surface at (x, z) no higher than `ceil` (the face's own riser stands above the foot). */
function surfaceAt(m: CellMesh, x: number, z: number, ceil: number): number {
  const lx = x - m.x0, lz = z - m.z0;
  let best = -Infinity;
  for (const t of m.grid.get(Math.floor(lz) * 4096 + Math.floor(lx)) ?? []) {
    const i0 = m.idx[t * 3]! * 3, i1 = m.idx[t * 3 + 1]! * 3, i2 = m.idx[t * 3 + 2]! * 3;
    const ax = m.pos[i0]!, az = m.pos[i0 + 2]!, bx = m.pos[i1]!, bz = m.pos[i1 + 2]!, cx = m.pos[i2]!, cz = m.pos[i2 + 2]!;
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-12) continue;
    const w0 = ((bz - cz) * (lx - cx) + (cx - bx) * (lz - cz)) / det;
    const w1 = ((cz - az) * (lx - cx) + (ax - cx) * (lz - cz)) / det;
    const w2 = 1 - w0 - w1;
    if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
    const y = w0 * m.pos[i0 + 1]! + w1 * m.pos[i1 + 1]! + w2 * m.pos[i2 + 1]!;
    if (y <= ceil && y > best) best = y;
  }
  return best;
}

const on = new Map<string, CellMesh>();
for (const k of cells) on.set(k, meshCell(k, true));
const off = argv.includes("--compare") ? new Map([...cells].map((k) => [k, meshCell(k, false)])) : null;

function measure(meshes: Map<string, CellMesh>) {
  const rows: { wall: string; x: number; z: number; f25: number; f100: number }[] = [];
  for (const q of samples) {
    const h25 = surfaceAt(meshes.get(cellKey(...q.x25))!, q.x25[0], q.x25[1], q.f.y0 + 2.5);
    const h100 = surfaceAt(meshes.get(cellKey(...q.x100))!, q.x100[0], q.x100[1], q.f.y0 + 2.5);
    if (!Number.isFinite(h25) || !Number.isFinite(h100)) continue; // the ground in front is lower than the foot (no floor here)
    rows.push({ wall: q.f.wall, x: +q.x25[0].toFixed(2), z: +q.x25[1].toFixed(2), f25: +(h25 - q.f.y0).toFixed(3), f100: +(h100 - q.f.y0).toFixed(3) });
  }
  return rows;
}
const stat = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return { mean: s.reduce((a, b) => a + b, 0) / (s.length || 1), p90: s[Math.floor(s.length * 0.9)] ?? 0, max: s[s.length - 1] ?? 0 }; };
const fmt = (s: { mean: number; p90: number; max: number }) => `mean ${s.mean.toFixed(2)} / p90 ${s.p90.toFixed(2)} / max ${s.max.toFixed(2)} m`;

const rowsOn = measure(on);
const report: Record<string, unknown> = { world, project, faces: faces.length, cells: cells.size, samples: rowsOn.length };
if (off) {
  const rowsOff = measure(off);
  console.log(`OFF (old mesh): fillet at 0.25 m ${fmt(stat(rowsOff.map((r) => r.f25)))}; at 1 m ${fmt(stat(rowsOff.map((r) => r.f100)))}`);
  report.off = { f25: stat(rowsOff.map((r) => r.f25)), f100: stat(rowsOff.map((r) => r.f100)) };
  // what moved, and where
  let moved = 0, outside = 0, countDiff = 0, skirts = 0;
  const step = field.voxelSize;
  for (const k of cells) {
    const a = off.get(k)!, b = on.get(k)!;
    // by POSITION, not index: skirts clamp to the cell section the mesh draws, so a squared foot on a side plane can
    // change how many skirt vertices hang there (and every later index shifts). An OFF vertex with no ON vertex at the
    // same place moved; it must stand in a wall-foot band.
    if (a.pos.length !== b.pos.length) countDiff++;
    const q = (x: number, y: number, z: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    const kept = new Set<string>();
    for (let i = 0; i < b.pos.length; i += 3) kept.add(q(b.pos[i]!, b.pos[i + 1]!, b.pos[i + 2]!));
    for (let i = 0; i < a.pos.length; i += 3) {
      if (kept.has(q(a.pos[i]!, a.pos[i + 1]!, a.pos[i + 2]!))) continue;
      moved++;
      const x = a.pos[i]! + a.x0, y = a.pos[i + 1]!, z = a.pos[i + 2]! + a.z0;
      const band = field.terraceFacesNear(x, z).some((c) => {
        const rx = x - c.ox, rz = z - c.oz, s = rx * c.dx + rz * c.dz, n = -rx * c.dz + rz * c.dx;
        // a skirt vertex hangs below its boundary vertex on the cell side plane and follows it
        const skirt = (Math.abs(x - a.x0) < 1e-4 || Math.abs(x - a.x0 - S) < 1e-4 || Math.abs(z - a.z0) < 1e-4 || Math.abs(z - a.z0 - S) < 1e-4) ; // its depth follows the section clamp, so any height
        return s >= c.s0 - 0.5 && s <= c.s1 + 0.5 && n - c.n0 > -1e-4 && n - c.n0 <= step * Math.SQRT2 * 1.001 && (skirt || (y >= c.y0 - 1e-3 && y <= c.y0 + step * 1.001));
      });
      // a skirt on the cell side plane, under the ground: its depth is clamped against the plane's whole section, so a
      // squared foot anywhere on that plane can re-clamp it. Hidden geometry, counted apart.
      const onPlane = Math.abs(x - a.x0) < 1e-4 || Math.abs(x - a.x0 - S) < 1e-4 || Math.abs(z - a.z0) < 1e-4 || Math.abs(z - a.z0 - S) < 1e-4;
      if (!band && onPlane && y < field.height(x, z) - 0.05) { skirts++; continue; }
      if (!band) {
        outside++;
        if (argv.includes("--why") && outside <= 8) console.log(`  outside: (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`);
      }
    }
  }
  console.log(`moved ${moved} vertices in ${cells.size} cells; outside a wall-foot band: ${outside}; hidden skirt vertices re-clamped: ${skirts}; cells whose skirt count changed: ${countDiff}`);
  report.compare = { moved, outside, skirts, countDiff };
  if (outside) process.exitCode = 1;
}
const s25 = stat(rowsOn.map((r) => r.f25)), s100 = stat(rowsOn.map((r) => r.f100));
console.log(`${off ? "ON  (squared): " : ""}fillet at 0.25 m ${fmt(s25)}; at 1 m ${fmt(s100)}  (${faces.length} faces, ${rowsOn.length} samples, ${cells.size} cells)`);
const bad = rowsOn.filter((r) => r.f25 > maxFillet).sort((a, b) => b.f25 - a.f25);
for (const r of bad.slice(0, 8)) console.log(`  FAIL ${r.wall} (${r.x}, ${r.z}): ${r.f25.toFixed(2)} m above the foot at 0.25 m`);
report.on = { f25: s25, f100: s100 };
report.bad = bad.length;
const jf = opt("json"); if (jf) fs.writeFileSync(jf, JSON.stringify(report, null, 2) + "\n");
const failed = bad.length > maxShare * rowsOn.length;
console.log(failed ? `WALL FOOT FAILED (${bad.length}/${rowsOn.length} samples over ${maxFillet} m, more than ${(maxShare * 100).toFixed(0)} %)` : `WALL FOOT OK (${rowsOn.length} samples${bad.length ? `; ${bad.length} pinned at cell side planes, within the ${(maxShare * 100).toFixed(0)} % share` : ""})`);
if (failed) process.exitCode = 1;

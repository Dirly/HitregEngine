#!/usr/bin/env node
/**
 * Thin walls in a mesh stamp — the source shells dual contouring will PERFORATE.
 *
 * DC samples the solid at voxel corners: a wall thinner than about two voxels can fall between samples, and the
 * baked surface comes out closed (no open edges, every audit passes) but with holes punched through it — on screen,
 * holes you can see through the map (docs/see-through.md: the see-through gate found them along the vault springings
 * of First King's Barrow and Wreck Hole, walls 0.03-0.4 m thick at a 0.12 m voxel). This measures each source wall
 * BEFORE the bake: from every source triangle, a ray inward (against its outward normal) to where it leaves the
 * union of the group's solids; a wall thinner than `minVoxels` voxels is reported with where it is.
 *
 *   node tools/mesh-dc/thin-walls.mjs <stamp.json> --voxel 0.12 [--group a,b] [--min-voxels 3] [--plan plan.json]
 *        [--exempt <regex>] [--all] [--json <out>] [--report <out>]
 *   (plan.groupVoxel in the stamp's project overrides the voxel per group: pass --plan <plan.json>)
 *
 * A PRE-BAKE GATE (dungeon pipeline stage `thin-walls`, between export and dc-bake). Only SHELL walls fail it: a thin
 * wall with one side looking out of the map — a ray along the wall normal, from the face or from where the inward
 * ray left the solid, meets no surface of ANY group within the dungeon's bounds. A perforated shell is a hole you can
 * see through the map; a perforated plank, cornice, rib, ledge or hull standing inside a room is not (a room on both
 * sides), so standalone thin pieces are exempt by construction. Solids are also exempt by tag: an object named for a
 * plank, decal, flat-art slab or hull skin, or carrying `dc_thin_ok` (the stamp's `solidObjects` / `solidThinOk`,
 * written by export_blender.py), or matching `--exempt <regex>`. `--all` counts every thin wall (the old diagnostic).
 * Exit 1 when any group has a thin shell. Fix: thicken the source wall to >= min-voxels voxels (the vault's outer
 * skin, the arch springing, the hull; the room kit's `minShell`) or bake that group at a finer voxel.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Object names the kit and the dungeon builders give standalone thin pieces (never a room's shell). */
export const EXEMPT_NAMES = /(^|[._\-\s/])(plank|planks|board|decal|flat-?art|art-slab|slab-art|hull-?skin|skin|sail|rope|banner|cloth)([._\-\s/\d]|$)/i;

function triTable(meshes) {
  // a, e1, e2, normal (unnormalised) per triangle, all meshes in one table
  let n = 0;
  for (const m of meshes) n += m.indices.length / 3;
  const tri = new Float64Array(n * 12);
  let t = 0;
  for (const m of meshes) {
    const P = m.positions, I = m.indices;
    for (let k = 0; k < I.length; k += 3, t++) {
      const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
      const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      tri.set([P[a], P[a + 1], P[a + 2], ...e1, ...e2, e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], t * 12);
    }
  }
  return { tri, n };
}

/** A uniform grid over a triangle table, with a ray cast (Moller-Trumbore). */
function triGrid({ tri, n }, cell) {
  const grid = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < n; t++) {
    const o = t * 12, xs = [tri[o], tri[o] + tri[o + 3], tri[o] + tri[o + 6]], ys = [tri[o + 1], tri[o + 1] + tri[o + 4], tri[o + 1] + tri[o + 7]], zs = [tri[o + 2], tri[o + 2] + tri[o + 5], tri[o + 2] + tri[o + 8]];
    const b = [[Math.min(...xs), Math.max(...xs)], [Math.min(...ys), Math.max(...ys)], [Math.min(...zs), Math.max(...zs)]];
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b[k][0]); hi[k] = Math.max(hi[k], b[k][1]); }
    for (let x = Math.floor(b[0][0] / cell); x <= Math.floor(b[0][1] / cell); x++)
      for (let y = Math.floor(b[1][0] / cell); y <= Math.floor(b[1][1] / cell); y++)
        for (let z = Math.floor(b[2][0] / cell); z <= Math.floor(b[2][1] / cell); z++) {
          const k = key(x, y, z); const l = grid.get(k); if (l) l.push(t); else grid.set(k, [t]);
        }
  }
  const seen = new Int32Array(n).fill(-1);
  let rayId = 0;
  /** every hit [distance, +1 entering a solid | -1 leaving] within `reach`, nearest first (or the first hit only) */
  function cast(origin, dir, reach, { skip = -1, first = false } = {}) {
    const id = rayId++;
    const hits = [];
    let best = Infinity;
    // every cell the ray crosses, in order (3D DDA: a fixed step skips the cells a ray clips at a corner)
    const cellOf = (v) => Math.floor(v / cell);
    let cx = cellOf(origin[0]), cy = cellOf(origin[1]), cz = cellOf(origin[2]);
    const step = dir.map((v) => (v > 0 ? 1 : v < 0 ? -1 : 0));
    const cur = [cx, cy, cz];
    const tMax = [0, 1, 2].map((k) => dir[k] === 0 ? Infinity : ((cur[k] + (step[k] > 0 ? 1 : 0)) * cell - origin[k]) / dir[k]);
    const tDelta = [0, 1, 2].map((k) => dir[k] === 0 ? Infinity : cell / Math.abs(dir[k]));
    for (let tCell = 0; tCell <= reach + cell;) {
      if (first && best <= tCell) break;
      if (first && (cur[0] < Math.floor(lo[0] / cell) - 1 || cur[1] < Math.floor(lo[1] / cell) - 1 || cur[2] < Math.floor(lo[2] / cell) - 1 ||
        cur[0] > Math.floor(hi[0] / cell) + 1 || cur[1] > Math.floor(hi[1] / cell) + 1 || cur[2] > Math.floor(hi[2] / cell) + 1)) break;
      const l = grid.get(key(cur[0], cur[1], cur[2]));
      const ax = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      tCell = tMax[ax]; cur[ax] += step[ax]; tMax[ax] += tDelta[ax];
      if (!l) continue;
      for (const t of l) {
        if (t === skip || seen[t] === id) continue;
        seen[t] = id;
        const o = t * 12;
        const px = dir[1] * tri[o + 8] - dir[2] * tri[o + 7], py = dir[2] * tri[o + 6] - dir[0] * tri[o + 8], pz = dir[0] * tri[o + 7] - dir[1] * tri[o + 6];
        const det = tri[o + 3] * px + tri[o + 4] * py + tri[o + 5] * pz;
        if (Math.abs(det) < 1e-14) continue;
        const tx = origin[0] - tri[o], ty = origin[1] - tri[o + 1], tz = origin[2] - tri[o + 2];
        const u = (tx * px + ty * py + tz * pz) / det; if (u < 0 || u > 1) continue;
        const qx = ty * tri[o + 5] - tz * tri[o + 4], qy = tz * tri[o + 3] - tx * tri[o + 5], qz = tx * tri[o + 4] - ty * tri[o + 3];
        const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) / det; if (v < 0 || u + v > 1) continue;
        const d = (tri[o + 6] * qx + tri[o + 7] * qy + tri[o + 8] * qz) / det;
        if (d <= 1e-6 || d > reach) continue;
        hits.push([d, tri[o + 9] * dir[0] + tri[o + 10] * dir[1] + tri[o + 11] * dir[2] < 0 ? 1 : -1]);
        best = Math.min(best, d);
      }
    }
    return hits.sort((a, b) => a[0] - b[0]);
  }
  return { cast, lo, hi };
}

/**
 * Thin walls of one stamp mesh (`positions` flat XYZ, `indices` flat triangles, outward winding).
 * Returns the thinnest wall, the area below the threshold and the thin spots (clustered to `voxelSize * 4`).
 * `world` (from `worldOf(meshes)`) turns on the shell test: only walls with a side looking out of the map count;
 * `exemptSolid(index)` skips a solid (index into `solidTriangleCounts`).
 */
export function thinWalls(mesh, voxelSize, { minVoxels = 3, maxSpots = 40, world = null, exemptSolid = null } = {}) {
  const T = triTable([mesh]);
  const { tri, n } = T;
  const limit = minVoxels * voxelSize;
  const cell = Math.max(limit * 2, voxelSize * 4);
  const own = triGrid(T, cell);
  /** Distance along the ray until it leaves the union of solids (null: not within `reach`). */
  function exitDistance(origin, dir, self, reach) {
    const hits = own.cast(origin, dir, reach + voxelSize, { skip: self });
    // faces at the same distance (solids that touch face to face, coplanar pieces) count together: leaving one block
    // straight into the next is not leaving the rock; nor is an air gap under a voxel (the bake fills it), nor a fold
    // of a lofted solid (out and straight back in)
    let depth = 1;
    for (let k = 0; k < hits.length;) {
      const d = hits[k][0];
      while (k < hits.length && hits[k][0] - d < 1e-4) depth += hits[k++][1];
      if (depth <= 0 && !(k < hits.length && hits[k][1] > 0 && hits[k][0] - d < voxelSize)) return d <= reach ? d : null;
    }
    return null;
  }
  const span = Math.hypot(own.hi[0] - own.lo[0], own.hi[1] - own.lo[1], own.hi[2] - own.lo[2]) + cell * 2;
  const buried = (c, nrm, self) => {
    const e = 1e-4, o = [c[0] + nrm[0] * e, c[1] + nrm[1] * e, c[2] + nrm[2] * e];
    return own.cast(o, nrm, span, { skip: self }).reduce((sum, h) => sum + h[1], 0) < 0;
  };
  const solidOf = new Int32Array(n);
  { let t = 0; (mesh.solidTriangleCounts ?? [n]).forEach((c, s) => { for (let k = 0; k < c && t < n; k++) solidOf[t++] = s; }); }
  let thinArea = 0, totalArea = 0, minThickness = Infinity, interiorArea = 0, exemptArea = 0;
  const spots = [];
  for (let t = 0; t < n; t++) {
    const o = t * 12, nl = Math.hypot(tri[o + 9], tri[o + 10], tri[o + 11]);
    if (nl < 1e-12) continue;
    const area = nl / 2;
    totalArea += area;
    const nrm = [tri[o + 9] / nl, tri[o + 10] / nl, tri[o + 11] / nl];
    const c = [tri[o] + (tri[o + 3] + tri[o + 6]) / 3, tri[o + 1] + (tri[o + 4] + tri[o + 7]) / 3, tri[o + 2] + (tri[o + 5] + tri[o + 8]) / 3];
    const d = exitDistance(c, [-nrm[0], -nrm[1], -nrm[2]], t, limit);
    if (d === null || d >= limit - 1e-3) continue; // exactly the minimum is enough (stamp positions are mm-rounded)
    // a face buried inside another solid of the group (two walls overlapping at a corner, a pier into a wall) is no
    // surface at all: the bake never sees it. Out along its normal the ray leaves more solids than it enters.
    if (buried(c, nrm, t)) { interiorArea += area; continue; }
    if (exemptSolid && exemptSolid(solidOf[t])) { exemptArea += area; continue; }
    if (world) {
      // a shell: the face looks out of the map, or the far side of the wall does
      const eps = 1e-3;
      const out = world.escapes([c[0] + nrm[0] * eps, c[1] + nrm[1] * eps, c[2] + nrm[2] * eps], nrm);
      const back = out || world.escapes([c[0] - nrm[0] * (d + eps), c[1] - nrm[1] * (d + eps), c[2] - nrm[2] * (d + eps)], [-nrm[0], -nrm[1], -nrm[2]]);
      if (!out && !back) { interiorArea += area; continue; }
    }
    thinArea += area;
    minThickness = Math.min(minThickness, d);
    const near = spots.find((s) => Math.hypot(s.at[0] - c[0], s.at[1] - c[1], s.at[2] - c[2]) < voxelSize * 4);
    if (near) { near.area += area; if (d < near.thickness) { near.thickness = d; near.at = c; near.normal = nrm; } }
    else spots.push({ at: c, thickness: d, area, normal: nrm, solid: solidOf[t] });
  }
  spots.sort((a, b) => b.area - a.area);
  const r = (v, k = 3) => +v.toFixed(k);
  return {
    voxelSize, minVoxels, limit: r(limit), triangles: n, totalArea: r(totalArea, 1), thinArea: r(thinArea, 2),
    interiorThinArea: r(interiorArea, 2), exemptThinArea: r(exemptArea, 2),
    minThickness: Number.isFinite(minThickness) ? r(minThickness) : null,
    spots: spots.slice(0, maxSpots).map((s) => ({ at: s.at.map((v) => r(v, 2)), thickness: r(s.thickness), area: r(s.area, 2), normal: s.normal.map((v) => r(v, 2)), solid: s.solid })),
  };
}

/** Every group's surfaces together: `escapes(origin, dir)` is true when the ray meets nothing (it leaves the map). */
export function worldOf(meshes, { cell = 1.0 } = {}) {
  const T = triTable(meshes);
  const g = triGrid(T, cell);
  const span = Math.hypot(g.hi[0] - g.lo[0], g.hi[1] - g.lo[1], g.hi[2] - g.lo[2]) + cell * 2;
  return { escapes: (origin, dir) => g.cast(origin, dir, span, { first: true }).length === 0 };
}

/** Solid exemptions from the stamp's per-solid tags (export_blender.py `solidObjects` / `solidThinOk`) + a regex. */
export function exemptFor(mesh, extra = null) {
  const names = mesh.solidObjects ?? [], ok = mesh.solidThinOk ?? [];
  return (s) => !!ok[s] || (names[s] != null && (EXEMPT_NAMES.test(names[s]) || (extra != null && extra.test(names[s]))));
}

/** The gate over a whole stamp. */
export function thinWallsGate(stamp, { voxel = 0.12, groupVoxel = {}, only = null, minVoxels = 3, all = false, exempt = null } = {}) {
  const world = all ? null : worldOf(stamp.meshes);
  const groups = {}, failures = [];
  for (const m of stamp.meshes) {
    if (only && !only.has(m.name)) continue;
    const r = thinWalls(m, groupVoxel[m.name] ?? voxel, { minVoxels, world, exemptSolid: exemptFor(m, exempt) });
    if (m.solidObjects) for (const s of r.spots) s.object = m.solidObjects[s.solid];
    groups[m.name] = r;
    if (r.thinArea > 0) failures.push({ what: `${m.name}: ${r.thinArea} m2 of shell under ${minVoxels} voxels (${r.limit} m), thinnest ${r.minThickness} m at ${JSON.stringify(r.spots[0]?.at)}${r.spots[0]?.object ? ` (${r.spots[0].object})` : ""}`, group: m.name });
  }
  return { tool: "thin-walls", mode: all ? "all" : "shell", minVoxels, voxel, passed: failures.length === 0, failures, groups };
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  if (!argv[0]) { console.error("usage: thin-walls.mjs <stamp.json> --voxel 0.12 [--group a,b] [--min-voxels 3] [--plan plan.json] [--exempt regex] [--all] [--json out] [--report out]"); process.exit(2); }
  const stamp = JSON.parse(fs.readFileSync(argv[0], "utf8"));
  const plan = opt("plan") ? JSON.parse(fs.readFileSync(opt("plan"), "utf8")) : {};
  const res = thinWallsGate(stamp, {
    voxel: Number(opt("voxel", plan.voxelSize ?? plan.voxel ?? "0.12")),
    groupVoxel: plan.groupVoxel ?? {},
    only: opt("group") ? new Set(opt("group").split(",")) : null,
    minVoxels: Number(opt("min-voxels", "3")), all: argv.includes("--all"),
    exempt: opt("exempt") ? new RegExp(opt("exempt"), "i") : null,
  });
  for (const [name, r] of Object.entries(res.groups))
    console.log(`${name.padEnd(16)} voxel ${r.voxelSize}  ${r.thinArea > 0 ? `THIN ${r.thinArea} m2 of ${r.totalArea}, thinnest ${r.minThickness} m` : "ok"}  (interior ${r.interiorThinArea}, exempt ${r.exemptThinArea})${r.spots.length ? `  e.g. ${r.spots.slice(0, 3).map((s) => `${JSON.stringify(s.at)} ${s.thickness} m${s.object ? ` ${s.object}` : ""}`).join("; ")}` : ""}`);
  if (opt("json")) fs.writeFileSync(opt("json"), JSON.stringify(res.groups, null, 1));
  if (opt("report")) fs.writeFileSync(opt("report"), JSON.stringify({ ...res, stamp: argv[0], date: new Date().toISOString() }, null, 1));
  console.log(res.passed ? "thin-walls: passed" : `thin-walls: FAILED (${res.failures.length} group(s))`);
  process.exitCode = res.passed ? 0 : 1;
}

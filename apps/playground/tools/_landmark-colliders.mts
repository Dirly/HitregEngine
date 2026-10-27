/**
 * Landmark COLLIDER TILES (packages/core voxel/ledge-landmark.ts `landmarkColliderTileId`): the welded collider
 * surface of a baked landmark split by map cell, one hidden trimesh model per cell, so every cell the landmark covers
 * streams its own piece of collider (physics holds only the simulation ring around a body; a collider that rode in
 * the origin cell alone was missing at both ends of a 135 m ramp). Each triangle goes to the cell its centroid stands
 * in, AND to every other cell its footprint comes within SEAM_MARGIN of (inside the landmark's bounds): a cell's tile
 * alone holds every surface over that cell, so a body standing on a cell line (a stair foot drawn across it) never
 * depends on the neighbouring tile having streamed in yet (Hagsheer weep-sexton-stair-foot: 12.5 m drop at z -1056,
 * the deck triangles all in the -23 tile). Coplanar copies in two tiles are harmless to physics. The prefab then
 * carries render meshes only. Used by tools/landmark.mts and tools/ledge-landmark.mts.
 */
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { landmarkColliderTileId, landmarkTileCells } from "@hitreg/core";
import { writeBuiltGlb } from "./_volume-glb.mts";
// @ts-expect-error plain JS tool module
import { readGltf } from "../../../tools/wfc-3d/gltf.mjs";
// @ts-expect-error plain JS tool module
import { gltfTriangles } from "../../../tools/wfc-3d/collider.mjs";

export interface ColliderSurface { positions: ArrayLike<number>; indices: ArrayLike<number> }

/** Metres past a cell's edge a tile still takes triangles (a body's radius and then some). */
export const SEAM_MARGIN = 1;

/**
 * Triangles of `surfaces` (landmark-local) welded by position and grouped by map cell: the cell of the centroid, plus
 * every cell the triangle's footprint (grown by `margin`) overlaps, limited to `bounds` (the cells the landmark may
 * stream; landmarkTileCells) when given.
 */
export function splitColliderByCell(
  surfaces: ColliderSurface[],
  origin: readonly [number, number, number],
  cellSize: number,
  opts: { margin?: number; bounds?: { cx0: number; cx1: number; cz0: number; cz1: number } } = {},
): Map<string, { cx: number; cz: number; positions: number[]; indices: number[]; weld: Map<string, number> }> {
  const margin = opts.margin ?? SEAM_MARGIN, b = opts.bounds;
  const out = new Map<string, { cx: number; cz: number; positions: number[]; indices: number[]; weld: Map<string, number> }>();
  const put = (cx: number, cz: number, s: ColliderSurface, v: number[]) => {
    const key = `${cx}_${cz}`;
    let tile = out.get(key);
    if (!tile) out.set(key, (tile = { cx, cz, positions: [], indices: [], weld: new Map() }));
    for (const i of v) {
      const x = s.positions[i * 3]!, y = s.positions[i * 3 + 1]!, z = s.positions[i * 3 + 2]!;
      const k = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
      let j = tile.weld.get(k);
      if (j === undefined) { j = tile.positions.length / 3; tile.weld.set(k, j); tile.positions.push(x, y, z); }
      tile.indices.push(j);
    }
  };
  for (const s of surfaces) {
    for (let t = 0; t + 2 < s.indices.length; t += 3) {
      const v = [s.indices[t]!, s.indices[t + 1]!, s.indices[t + 2]!];
      const xs = v.map((i) => s.positions[i * 3]! + origin[0]), zs = v.map((i) => s.positions[i * 3 + 2]! + origin[2]);
      const cx = Math.floor((xs[0]! + xs[1]! + xs[2]!) / 3 / cellSize), cz = Math.floor((zs[0]! + zs[1]! + zs[2]!) / 3 / cellSize);
      put(cx, cz, s, v);
      if (margin < 0) continue;
      const x0 = Math.floor((Math.min(...xs) - margin) / cellSize), x1 = Math.floor((Math.max(...xs) + margin) / cellSize);
      const z0 = Math.floor((Math.min(...zs) - margin) / cellSize), z1 = Math.floor((Math.max(...zs) + margin) / cellSize);
      for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) {
        if (gx === cx && gz === cz) continue;
        if (b && (gx < b.cx0 || gx > b.cx1 || gz < b.cz0 || gz > b.cz1)) continue;
        put(gx, gz, s, v);
      }
    }
  }
  return out;
}

/**
 * The baked colliders of the OTHER landmarks whose bounds reach within `reach` m of (x, z), in world space: a body
 * walks across the joint between two landmarks (a ramp head onto a shelf), so a bake's reach walk must stand on both.
 * Read from the first project in `projects` that holds each bake: its collider tiles, or (an older bake) the prefab's
 * trimesh entities. A landmark with no bake on disk is skipped (listed in `missing`).
 */
export function neighbourColliders(
  landmarks: readonly { id: string; prefab: string; position: [number, number, number]; radius: number }[],
  selfId: string,
  at: [number, number],
  reach: number,
  projects: string[],
): { positions: number[]; indices: number[]; used: string[]; missing: string[] } {
  const positions: number[] = [], indices: number[] = [], used: string[] = [], missing: string[] = [];
  const add = (file: string, o: [number, number, number]) => {
    for (const t of gltfTriangles(readGltf(file)) as number[][]) {
      const b = positions.length / 3;
      for (let k = 0; k < 9; k++) positions.push(t[k]! + o[k % 3]!);
      indices.push(b, b + 1, b + 2);
    }
  };
  for (const l of landmarks) {
    if (l.id === selfId || Math.hypot(l.position[0] - at[0], l.position[2] - at[1]) > l.radius + reach) continue;
    const name = l.prefab.slice("landmarks/".length);
    let found = false;
    for (const p of projects) {
      const models = join("projects", p, "assets", "models", "landmarks");
      const tiles = existsSync(models) ? readdirSync(models).filter((f) => f.startsWith(`${name}.collider.`) && /\.-?\d+_-?\d+\.glb$/.test(f)) : [];
      if (tiles.length) { for (const f of tiles) add(join(models, f), l.position); found = true; break; }
      const prefab = join("projects", p, "assets", "prefabs", "landmarks", `${name}.json`);
      if (!existsSync(prefab)) continue;
      const doc = JSON.parse(readFileSync(prefab, "utf8")) as { entities: Record<string, { components: { mesh?: { source?: { assetId?: string } }; collider?: { shape?: string } } }> };
      for (const e of Object.values(doc.entities)) {
        const id = e.components.mesh?.source?.assetId;
        if (e.components.collider?.shape === "trimesh" && id && existsSync(join("projects", p, "assets", "models", id))) add(join("projects", p, "assets", "models", id), l.position);
      }
      found = true;
      break;
    }
    (found ? used : missing).push(l.id);
  }
  return { positions, indices, used, missing };
}

/**
 * Write the collider tiles of a landmark prefab `landmarks/<name>` into `<into>/models/` (stale tiles of the same
 * name removed first). Throws when a tile falls outside the cells the recipe's landmark bounds overlap (the world
 * would never stream it). Returns the cells written and the bytes.
 */
/**
 * Remove the SUPERSEDED bakes of one operator from `<into>/{prefabs,models}/landmarks`: every
 * `<opId>-<8 hex digest>.json` prefab and `<opId>-<digest>.*` model (render GLBs, collider tiles) whose digest is not in
 * `keep` (the bake just written and whatever prefab the recipe names). No iteration files: git is the history and a
 * re-bake rebuilds any digest exactly. Another operator's files never match (the digest must follow `<opId>-` directly
 * and end the name or meet a `.`). Returns the deleted paths.
 */
export function pruneSupersededBakes(into: string, opId: string, keep: readonly string[], opts: { dryRun?: boolean } = {}): string[] {
  const esc = opId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc}-([0-9a-f]{8})(?:\\.|$)`);
  const keepDigests = new Set(keep.map((k) => k.replace(/^landmarks\//, "")).map((k) => re.exec(k)?.[1]).filter((d): d is string => !!d));
  const out: string[] = [];
  for (const sub of ["prefabs", "models"]) {
    const dir = join(into, sub, "landmarks");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const m = re.exec(f);
      if (!m || keepDigests.has(m[1]!)) continue;
      if (sub === "prefabs" && f !== `${opId}-${m[1]}.json`) continue;
      const file = join(dir, f);
      if (!opts.dryRun) unlinkSync(file);
      out.push(file);
    }
  }
  return out;
}

/**
 * Re-split the collider tiles of an EXISTING bake (`<into>/models/landmarks/<name>.collider.*.glb`) with the current
 * rule, without re-baking: the triangles of every tile, each once (a seam copy dropped), written back through
 * writeColliderTiles. The render meshes and the digest are untouched (the surface is the same; only its split moves).
 */
export function retileColliderTiles(
  into: string,
  prefabId: string,
  landmark: { position: [number, number, number]; radius: number },
  cellSize: number,
): { cells: string[]; triangles: number; before: number } {
  const dir = join(into, "models", "landmarks"), name = prefabId.slice("landmarks/".length);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`${name}.collider.`) && f.endsWith(".glb")) : [];
  if (!files.length) throw new Error(`no collider tiles of ${prefabId} under ${dir} (bake it first)`);
  const seen = new Set<string>(), positions: number[] = [], indices: number[] = [];
  let before = 0;
  for (const f of files) {
    for (const t of gltfTriangles(readGltf(join(dir, f))) as number[][]) {
      before++;
      const keys = [0, 1, 2].map((k) => `${Math.round(t[k * 3]! * 1000)},${Math.round(t[k * 3 + 1]! * 1000)},${Math.round(t[k * 3 + 2]! * 1000)}`);
      const key = [...keys].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const n = positions.length / 3;
      positions.push(...t.slice(0, 9));
      indices.push(n, n + 1, n + 2);
    }
  }
  const r = writeColliderTiles(into, prefabId, [{ positions, indices }], landmark, cellSize);
  return { cells: r.cells, triangles: r.triangles, before };
}

export function writeColliderTiles(
  into: string,
  prefabId: string,
  surfaces: ColliderSurface[],
  landmark: { position: [number, number, number]; radius: number },
  cellSize: number,
): { cells: string[]; bytes: number; triangles: number } {
  const dir = join(into, "models", "landmarks"), name = prefabId.slice("landmarks/".length);
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.startsWith(`${name}.collider.`) && f.endsWith(".glb")) unlinkSync(join(dir, f));
  const b = landmarkTileCells(landmark, cellSize);
  const tiles = splitColliderByCell(surfaces, landmark.position, cellSize, { bounds: b });
  let bytes = 0, triangles = 0;
  for (const t of tiles.values()) {
    if (t.cx < b.cx0 || t.cx > b.cx1 || t.cz < b.cz0 || t.cz > b.cz1) {
      throw new Error(`collider tile ${t.cx},${t.cz} is outside the landmark's bounds (radius ${landmark.radius} m from ${landmark.position.join(",")}): the recipe's radius is too small (worldgen op --apply)`);
    }
    const n = t.positions.length / 3;
    const normals = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) normals[i * 3 + 1] = 1;
    const file = join(into, "models", landmarkColliderTileId(prefabId, t.cx, t.cz));
    bytes += writeBuiltGlb({ positions: Float32Array.from(t.positions), normals, uvs: new Float32Array(n * 2), indices: Uint32Array.from(t.indices) }, file);
    triangles += t.indices.length / 3;
  }
  return { cells: [...tiles.keys()], bytes, triangles };
}

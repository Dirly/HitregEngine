import type { EntityId } from "./ids.js";
import { subtreeOf, type SceneDoc } from "./scene.js";
import type { ComponentRegistry } from "./components/registry.js";
import type { AssetLibrary } from "./assets.js";
import { expandScene } from "./prefab.js";
import type { Op } from "./ops.js";
import { quatMultiply, vecApplyQuat, worldTransforms, type Quat, type Vec3, type WorldTransform } from "./math.js";
import { polyFromPrimitive, polyFromPolygon } from "./poly-mesh/shapes.js";
import { polyMeshCollision } from "./poly-mesh/compile.js";
import { normalizePolyMesh } from "./poly-mesh/types.js";
import { heightmapMesh, type HeightmapParams } from "./terrain.js";
import { voxelMesh, type VoxelMeshSource } from "./voxel/mesh.js";

/**
 * Placement solvers — the authoring-time "hand-holding" layer that lets an
 * agent (or a human dragging in the editor) place props approximately and
 * have the engine settle them exactly: snap to the ground/ceiling/wall it is
 * near, embed a couple of centimetres so uneven floors don't leave hairline
 * gaps, and jitter rotation/scale so a scattered batch doesn't read as
 * copy-paste.
 *
 * Everything here is a pure function over an (expanded) SceneDoc producing
 * ops — solve once at author time, bake the resolved transform into the
 * document. Nothing runs per-frame; the JSON stays the truth. Deterministic:
 * the same doc + ids + seed always produces the same ops.
 *
 * Geometry comes from the same sources render/physics use: primitives via
 * their poly-mesh conversion, poly meshes and extruded polygons via
 * `polyMeshCollision`, heightmap terrain via `heightmapMesh`. `asset` (glTF)
 * and `path` meshes contribute no support geometry headless — snapping onto
 * them needs a collider-equipped proxy or the running app.
 */

// The `placement` component schema lives in components/placement.ts (zod-only,
// so registerCoreComponents can import it without a circular init); this module
// is the solver over it.
import { placementSchema, type PlacementData } from "./components/placement.js";

export type { PlacementData };

// ---------------------------------------------------------------- geometry

export interface TriangleSoup {
  /** Expanded-doc entity id that produced these triangles. */
  entity: EntityId;
  /** World-space xyz triplets, 9 numbers per triangle. */
  triangles: Float64Array;
  aabb: { min: Vec3; max: Vec3 };
}

interface MeshComponentLike {
  source?: { kind?: string } & Record<string, unknown>;
}

/** Entity-LOCAL triangle positions for one mesh component, or null when the
 * source has no headless geometry (asset models, path curves). */
function localTriangles(mesh: MeshComponentLike): Float64Array | null {
  const source = mesh.source;
  if (!source || typeof source.kind !== "string") return null;
  try {
    switch (source.kind) {
      case "primitive": {
        const { mesh: poly, offset } = polyFromPrimitive(source as never);
        const { positions, indices } = polyMeshCollision(poly);
        return indexedToSoup(positions, indices, offset);
      }
      case "poly": {
        const { positions, indices } = polyMeshCollision(normalizePolyMesh(source));
        return indexedToSoup(positions, indices, [0, 0, 0]);
      }
      case "polygon": {
        const poly = polyFromPolygon(source as never);
        const { positions, indices } = polyMeshCollision(poly);
        return indexedToSoup(positions, indices, [0, 0, 0]);
      }
      case "heightmap": {
        const params = source as unknown as HeightmapParams & { resolution: number };
        // cap the lattice: placement casts don't need render-density terrain
        const capped = { ...params, resolution: Math.min(params.resolution ?? 96, 96) };
        const { positions, indices } = heightmapMesh(capped);
        return indexedToSoup(positions, indices, [0, 0, 0]);
      }
      case "voxel": {
        // the cell the renderer already meshed and cached — so a prop dropped
        // on generated terrain lands on the surface you can actually see,
        // overhangs included (which a heightfield probe could never find)
        const mesh = voxelMesh(source as unknown as VoxelMeshSource);
        if (mesh.triangleCount === 0) return null;
        return indexedToSoup(mesh.positions, mesh.indices, [0, 0, 0]);
      }
      default:
        return null;
    }
  } catch {
    return null; // malformed source: contributes nothing rather than aborting the solve
  }
}

function indexedToSoup(positions: ArrayLike<number>, indices: ArrayLike<number>, offset: Vec3): Float64Array {
  const out = new Float64Array(indices.length * 3);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]! * 3;
    out[i * 3] = positions[v]! + offset[0];
    out[i * 3 + 1] = positions[v + 1]! + offset[1];
    out[i * 3 + 2] = positions[v + 2]! + offset[2];
  }
  return out;
}

function transformSoup(local: Float64Array, w: WorldTransform): Float64Array {
  const out = new Float64Array(local.length);
  for (let i = 0; i < local.length; i += 3) {
    const p = vecApplyQuat(
      [local[i]! * w.scale[0], local[i + 1]! * w.scale[1], local[i + 2]! * w.scale[2]],
      w.rotation,
    );
    out[i] = p[0] + w.position[0];
    out[i + 1] = p[1] + w.position[1];
    out[i + 2] = p[2] + w.position[2];
  }
  return out;
}

function soupAabb(tris: Float64Array): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = tris[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  return { min, max };
}

/**
 * World-space triangle geometry for every entity in an (expanded) doc that
 * has a headless mesh source. `exclude` skips entities (e.g. the subtree
 * currently being snapped, so it can't support itself).
 */
export function collectSceneTriangles(
  doc: SceneDoc,
  world: Map<EntityId, WorldTransform> = worldTransforms(doc),
  exclude?: ReadonlySet<EntityId>,
): TriangleSoup[] {
  const out: TriangleSoup[] = [];
  for (const [id, entity] of Object.entries(doc.entities)) {
    if (exclude?.has(id)) continue;
    const mesh = entity.components["mesh"] as MeshComponentLike | undefined;
    if (!mesh) continue;
    const local = localTriangles(mesh);
    if (!local || local.length === 0) continue;
    const w = world.get(id);
    if (!w) continue;
    const triangles = transformSoup(local, w);
    out.push({ entity: id, triangles, aabb: soupAabb(triangles) });
  }
  return out;
}

// ---------------------------------------------------------------- raycast

export interface RayHit {
  entity: EntityId;
  t: number;
  point: Vec3;
  /** Unit normal, flipped to face the ray origin. */
  normal: Vec3;
}

function rayAabb(origin: Vec3, dir: Vec3, aabb: { min: Vec3; max: Vec3 }, maxT: number): boolean {
  let tmin = 0;
  let tmax = maxT;
  for (let a = 0; a < 3; a++) {
    const d = dir[a]!;
    if (Math.abs(d) < 1e-12) {
      if (origin[a]! < aabb.min[a]! - 1e-9 || origin[a]! > aabb.max[a]! + 1e-9) return false;
      continue;
    }
    const inv = 1 / d;
    let t0 = (aabb.min[a]! - origin[a]!) * inv;
    let t1 = (aabb.max[a]! - origin[a]!) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return false;
  }
  return true;
}

/** All ray/triangle intersections within maxT, sorted nearest-first. */
export function raycastTriangles(
  soups: readonly TriangleSoup[],
  origin: Vec3,
  dir: Vec3,
  maxT: number,
): RayHit[] {
  const hits: RayHit[] = [];
  for (const soup of soups) {
    if (!rayAabb(origin, dir, soup.aabb, maxT)) continue;
    const tris = soup.triangles;
    for (let i = 0; i < tris.length; i += 9) {
      const ax = tris[i]!, ay = tris[i + 1]!, az = tris[i + 2]!;
      const e1x = tris[i + 3]! - ax, e1y = tris[i + 4]! - ay, e1z = tris[i + 5]! - az;
      const e2x = tris[i + 6]! - ax, e2y = tris[i + 7]! - ay, e2z = tris[i + 8]! - az;
      // Möller–Trumbore
      const px = dir[1] * e2z - dir[2] * e2y;
      const py = dir[2] * e2x - dir[0] * e2z;
      const pz = dir[0] * e2y - dir[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const tx = origin[0] - ax, ty = origin[1] - ay, tz = origin[2] - az;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < -1e-9 || u > 1 + 1e-9) continue;
      const qx = ty * e1z - tz * e1y;
      const qy = tz * e1x - tx * e1z;
      const qz = tx * e1y - ty * e1x;
      const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
      if (v < -1e-9 || u + v > 1 + 1e-9) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t < 1e-6 || t > maxT) continue;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-12) continue;
      nx /= len; ny /= len; nz /= len;
      if (nx * dir[0] + ny * dir[1] + nz * dir[2] > 0) { nx = -nx; ny = -ny; nz = -nz; }
      hits.push({
        entity: soup.entity,
        t,
        point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t],
        normal: [nx, ny, nz],
      });
    }
  }
  hits.sort((a, b) => a.t - b.t);
  return hits;
}

// ---------------------------------------------------------------- rng / quat helpers

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — tiny deterministic PRNG, identical in browser and Node. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const quatConjugate = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

function quatAxisY(angle: number): Quat {
  return [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
}

/** Shortest-arc rotation taking unit vector `from` to unit vector `to`. */
function quatFromUnitVectors(from: Vec3, to: Vec3): Quat {
  const d = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  if (d > 1 - 1e-9) return [0, 0, 0, 1];
  if (d < -1 + 1e-9) {
    // opposite: rotate 180° around any axis orthogonal to `from`
    const axis: Vec3 = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    const cx = from[1] * axis[2] - from[2] * axis[1];
    const cy = from[2] * axis[0] - from[0] * axis[2];
    const cz = from[0] * axis[1] - from[1] * axis[0];
    const l = Math.hypot(cx, cy, cz);
    return [cx / l, cy / l, cz / l, 0];
  }
  const cx = from[1] * to[2] - from[2] * to[1];
  const cy = from[2] * to[0] - from[0] * to[2];
  const cz = from[0] * to[1] - from[1] * to[0];
  const q: Quat = [cx, cy, cz, 1 + d];
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Uniform random orientation (Shoemake). */
function randomQuat(rng: () => number): Quat {
  const u1 = rng(), u2 = rng() * 2 * Math.PI, u3 = rng() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

// ---------------------------------------------------------------- snap

export interface SnapOptions {
  /** Needed to expand prefab instances into support geometry (and to read a prefab root's placement component). */
  assets?: AssetLibrary;
  /** Jitter seed. Same doc + ids + seed => identical ops. Default 0. */
  seed?: number;
  /** Only touch entities that carry a `placement` component (what the editor's placement-assist toggle wants). */
  requirePlacement?: boolean;
  /** Placement settings for entities that have no `placement` component (ignored under requirePlacement). */
  defaults?: Partial<PlacementData>;
}

export interface SnapResult {
  id: EntityId;
  action: "snapped" | "unchanged" | "no-support" | "skipped-none" | "skipped-no-placement" | "missing";
  /** Expanded-doc entity the cast landed on. */
  support?: EntityId;
  from?: Vec3;
  to?: Vec3;
}

/**
 * Settle entities onto the world per their `placement` component (or
 * `defaults`). Returns ops against the SOURCE doc (one `set-component
 * transform` per moved entity) plus a per-entity report. Pure and
 * deterministic; apply the ops with `applyOps` (undoable like any batch).
 *
 * Each entity casts against everything except its own subtree, at PRE-solve
 * positions (a batch never sees a co-target's solved position); snap stacked
 * props bottom-up in separate calls if one must rest on the other's result.
 */
export function snapPlacementOps(
  doc: SceneDoc,
  registry: ComponentRegistry,
  ids: readonly EntityId[],
  options: SnapOptions = {},
): { ops: Op[]; results: SnapResult[] } {
  const expanded = options.assets ? expandScene(doc, options.assets, registry) : doc;
  const world = worldTransforms(expanded);
  const ops: Op[] = [];
  const results: SnapResult[] = [];
  const allSoups = collectSceneTriangles(expanded, world);

  for (const id of ids) {
    if (!(id in doc.entities) || !(id in expanded.entities)) {
      results.push({ id, action: "missing" });
      continue;
    }
    const raw = expanded.entities[id]!.components["placement"];
    if (raw === undefined && options.requirePlacement) {
      results.push({ id, action: "skipped-no-placement" });
      continue;
    }
    const placement = placementSchema.parse(raw ?? options.defaults ?? {});
    if (placement.snap === "none") {
      results.push({ id, action: "skipped-none" });
      continue;
    }

    const w = world.get(id)!;
    const ownSubtree = new Set(subtreeOf(expanded, id));
    const support = allSoups.filter((s) => !ownSubtree.has(s.entity));
    const rng = mulberry32(fnv1a(id) ^ ((options.seed ?? 0) >>> 0));

    // --- jitter (world-space, before the cast so the bottom offset is final)
    let rotation: Quat = [...w.rotation];
    let scale: Vec3 = [...w.scale];
    if (placement.snap !== "wall") {
      if (placement.rotJitter === "y") rotation = quatMultiply(quatAxisY(rng() * Math.PI * 2), rotation);
      else if (placement.rotJitter === "full") rotation = randomQuat(rng);
    }
    if (placement.scaleJitter[0] !== 1 || placement.scaleJitter[1] !== 1) {
      const s = placement.scaleJitter[0] + (placement.scaleJitter[1] - placement.scaleJitter[0]) * rng();
      scale = [scale[0] * s, scale[1] * s, scale[2] * s];
    }

    // --- own geometry, in origin-relative world orientation
    const ownLocal = ownGeometry(expanded, id);
    const relBounds = (rot: Quat, scl: Vec3) => {
      let minY = 0, maxY = 0, minAlong = (_n: Vec3) => 0;
      if (ownLocal.length > 0) {
        minY = Infinity; maxY = -Infinity;
        const pts: Vec3[] = [];
        for (let i = 0; i < ownLocal.length; i += 3) {
          const p = vecApplyQuat(
            [ownLocal[i]! * scl[0], ownLocal[i + 1]! * scl[1], ownLocal[i + 2]! * scl[2]],
            rot,
          );
          pts.push(p);
          if (p[1] < minY) minY = p[1];
          if (p[1] > maxY) maxY = p[1];
        }
        minAlong = (n: Vec3) => {
          let m = Infinity;
          for (const p of pts) {
            const d = p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
            if (d < m) m = d;
          }
          return m === Infinity ? 0 : m;
        };
      }
      return { minY, maxY, minAlong };
    };

    let position: Vec3 = [...w.position];
    let hit: RayHit | undefined;

    if (placement.snap === "ground" || placement.snap === "ceiling") {
      const up = placement.snap === "ground";
      const bounds = relBounds(rotation, scale);
      const start: Vec3 = up
        ? [position[0], position[1] + bounds.maxY + 0.05, position[2]]
        : [position[0], position[1] + bounds.minY - 0.05, position[2]];
      const dir: Vec3 = up ? [0, -1, 0] : [0, 1, 0];
      const hits = raycastTriangles(support, start, dir, placement.maxSnapDistance);
      hit = hits.find((h) => (up ? h.normal[1] >= 0.3 : h.normal[1] <= -0.3));
      if (!hit) {
        results.push({ id, action: "no-support", from: w.position });
        continue;
      }
      if (placement.alignToNormal) {
        rotation = quatMultiply(quatFromUnitVectors([0, 1, 0], up ? hit.normal : [-hit.normal[0], -hit.normal[1], -hit.normal[2]]), rotation);
      }
      const after = relBounds(rotation, scale);
      // burial: sink (flat metres) plus an optional seeded fraction of the
      // entity's own height (embed) — half-sunk scatter rocks, tilted debris
      let burial = placement.sink;
      const lo = Math.min(placement.embed[0], placement.embed[1]);
      const hi = Math.max(placement.embed[0], placement.embed[1]);
      if (hi > 0) burial += (lo + (hi - lo) * rng()) * (after.maxY - after.minY);
      position = up
        ? [position[0], hit.point[1] - after.minY - burial, position[2]]
        : [position[0], hit.point[1] - after.maxY + burial, position[2]];
    } else {
      // wall: sweep horizontal directions, back against the nearest vertical surface
      let best: RayHit | undefined;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const dir: Vec3 = [Math.sin(a), 0, Math.cos(a)];
        const found = raycastTriangles(support, position, dir, placement.maxSnapDistance).find(
          (h) => Math.abs(h.normal[1]) < 0.5,
        );
        if (found && (!best || found.t < best.t)) best = found;
      }
      if (!best) {
        results.push({ id, action: "no-support", from: w.position });
        continue;
      }
      hit = best;
      const n = best.normal; // faces the entity (out of the wall)
      rotation = quatAxisY(Math.atan2(n[0], n[2])); // local +Z out of the wall
      const bounds = relBounds(rotation, scale);
      const backDepth = -Math.min(0, bounds.minAlong(n));
      position = [
        best.point[0] + n[0] * (backDepth - placement.sink),
        position[1],
        best.point[2] + n[2] * (backDepth - placement.sink),
      ];
    }

    // --- world -> parent-local
    const parentId = expanded.entities[id]!.parent;
    const p = parentId !== null ? world.get(parentId)! : null;
    let localPos = position, localRot = rotation, localScale = scale;
    if (p) {
      const delta: Vec3 = [position[0] - p.position[0], position[1] - p.position[1], position[2] - p.position[2]];
      const unrot = vecApplyQuat(delta, quatConjugate(p.rotation));
      localPos = [unrot[0] / p.scale[0], unrot[1] / p.scale[1], unrot[2] / p.scale[2]];
      localRot = quatMultiply(quatConjugate(p.rotation), rotation);
      localScale = [scale[0] / p.scale[0], scale[1] / p.scale[1], scale[2] / p.scale[2]];
    }

    const prev = (doc.entities[id]!.components["transform"] ?? {}) as {
      position?: Vec3; rotation?: Quat; scale?: Vec3;
    };
    const data = {
      position: localPos.map(r6) as Vec3,
      rotation: localRot.map(r6) as Quat,
      scale: localScale.map(r6) as Vec3,
    };
    const before = {
      position: prev.position ?? [0, 0, 0],
      rotation: prev.rotation ?? [0, 0, 0, 1],
      scale: prev.scale ?? [1, 1, 1],
    };
    const changed =
      before.position.some((v, i) => Math.abs(v - data.position[i]!) > 1e-5) ||
      before.rotation.some((v, i) => Math.abs(v - data.rotation[i]!) > 1e-5) ||
      before.scale.some((v, i) => Math.abs(v - data.scale[i]!) > 1e-5);
    if (changed) {
      ops.push({ op: "set-component", id, component: "transform", data });
      results.push({ id, action: "snapped", support: hit?.entity, from: w.position, to: position });
    } else {
      results.push({ id, action: "unchanged", support: hit?.entity });
    }
  }
  return { ops, results };
}

/** Entity-subtree triangles relative to the subtree ROOT's origin (root transform ignored). */
function ownGeometry(expanded: SceneDoc, id: EntityId): Float64Array {
  const subtree = subtreeOf(expanded, id);
  const mini: SceneDoc = { version: 1, name: "own", entities: {} };
  for (const sub of subtree) {
    const e = expanded.entities[sub]!;
    mini.entities[sub] = sub === id
      ? { ...e, parent: null, components: { ...e.components, transform: {} } }
      : e;
  }
  const world = worldTransforms(mini);
  const parts: Float64Array[] = [];
  let total = 0;
  for (const sub of subtree) {
    const mesh = mini.entities[sub]!.components["mesh"] as MeshComponentLike | undefined;
    if (!mesh) continue;
    const local = localTriangles(mesh);
    if (!local || local.length === 0) continue;
    const tris = transformSoup(local, world.get(sub)!);
    parts.push(tris);
    total += tris.length;
  }
  const out = new Float64Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

// ---------------------------------------------------------------- lint

export type PlacementFindingKind = "floating" | "overlap" | "z-fight";

export interface PlacementFinding {
  kind: PlacementFindingKind;
  /** SOURCE-doc entity id (prefab-expanded children report as their instance). */
  entity: EntityId;
  other?: EntityId;
  message: string;
  /** floating: gap in metres; overlap: penetration depth in metres. */
  value?: number;
  /** World point to look at (pin/camera target). */
  at: Vec3;
}

export interface LintOptions {
  assets?: AssetLibrary;
  /** A prop hovering more than this above its support is floating. Default 0.03. */
  gapTol?: number;
  /**
   * OPT-IN: set to enable the interpenetration check (AABB penetration on the
   * least axis beyond this value reports an overlap). Off by default because
   * graybox construction interpenetrates on purpose — walls sunk into floors,
   * corner joints, rock piles — and no threshold separates those from
   * mistakes; the z-fight check catches the case that actually renders wrong.
   */
  overlapTol?: number;
  /** Coincident-plane distance for z-fight detection. Default 0.002. */
  coplanarTol?: number;
  maxFindings?: number;
}

/**
 * Static placement lint over a scene doc: floating props (detached from
 * everything, with a gap under the lowest face), z-fight risks (same-facing
 * coincident coplanar faces from different entities — the "crashing
 * materials" flicker), and — opt-in via `overlapTol` — interpenetrating
 * statics.
 *
 * Findings reference source-doc entities, so an agent can fix each with ops
 * on the same ids it authored. Heuristics, not proofs: heightmap terrain is
 * exempt from overlap/z-fight (it's the ground), dynamic rigidbodies are
 * exempt from floating (they settle at runtime), and wall/ceiling/none
 * placements are exempt from floating by declaration.
 */
export function lintPlacement(
  doc: SceneDoc,
  registry: ComponentRegistry,
  options: LintOptions = {},
): PlacementFinding[] {
  const gapTol = options.gapTol ?? 0.03;
  const overlapTol = options.overlapTol; // undefined = check disabled
  const coplanarTol = options.coplanarTol ?? 0.002;
  const maxFindings = options.maxFindings ?? 200;
  const expanded = options.assets ? expandScene(doc, options.assets, registry) : doc;
  const world = worldTransforms(expanded);
  const soups = collectSceneTriangles(expanded, world);

  // group expanded soups by source entity (prefab children -> instance root)
  const sourceOf = (id: EntityId): EntityId => (id in doc.entities ? id : id.split(":")[0]!);
  const groups = new Map<EntityId, { tris: Float64Array[]; aabb: { min: Vec3; max: Vec3 }; heightmap: boolean }>();
  for (const soup of soups) {
    const src = sourceOf(soup.entity);
    const mesh = expanded.entities[soup.entity]!.components["mesh"] as MeshComponentLike;
    const isHeightmap = mesh.source?.kind === "heightmap" || mesh.source?.kind === "voxel";
    const group = groups.get(src);
    if (!group) {
      groups.set(src, { tris: [soup.triangles], aabb: { min: [...soup.aabb.min], max: [...soup.aabb.max] }, heightmap: isHeightmap });
    } else {
      group.tris.push(soup.triangles);
      group.heightmap ||= isHeightmap;
      for (let a = 0; a < 3; a++) {
        if (soup.aabb.min[a]! < group.aabb.min[a]!) group.aabb.min[a] = soup.aabb.min[a]!;
        if (soup.aabb.max[a]! > group.aabb.max[a]!) group.aabb.max[a] = soup.aabb.max[a]!;
      }
    }
  }

  const findings: PlacementFinding[] = [];
  const push = (f: PlacementFinding): boolean => {
    if (findings.length >= maxFindings) return false;
    findings.push(f);
    return true;
  };

  // ---- floating
  const groupIds = [...groups.keys()];
  for (const id of groupIds) {
    const group = groups.get(id)!;
    if (group.heightmap) continue;
    const source = doc.entities[id];
    if (!source) continue;
    const rb = source.components["rigidbody"] as { kind?: string } | undefined;
    if (rb && rb.kind !== "static") continue;
    const placementRaw = source.components["placement"] as { snap?: string } | undefined;
    if (placementRaw && placementRaw.snap !== undefined && placementRaw.snap !== "ground") continue;
    // "Floating" means DETACHED: touching nothing at all, with a gap below.
    // Anything whose AABB contacts other geometry is structurally attached —
    // a wall standing on (or sunk into) a floor slab, a ceiling resting on
    // its walls, a prop leaning against something — and casting a ray from
    // inside/under that support would misread the support's own underside as
    // a distant floor. Contact is the cheap, orientation-free test for all
    // of those at once.
    const contactTol = 0.05;
    let attached = false;
    for (const [otherId, other] of groups) {
      if (otherId === id) continue;
      let touching = true;
      for (let axis = 0; axis < 3; axis++) {
        if (
          group.aabb.min[axis]! > other.aabb.max[axis]! + contactTol ||
          group.aabb.max[axis]! < other.aabb.min[axis]! - contactTol
        ) {
          touching = false;
          break;
        }
      }
      if (touching) { attached = true; break; }
    }
    if (attached) continue;
    const others = soups.filter((s) => sourceOf(s.entity) !== id);
    const { min, max } = group.aabb;
    const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
    const ix = (max[0] - min[0]) * 0.25, iz = (max[2] - min[2]) * 0.25;
    // Cast from a little ABOVE the lowest face: a properly-sunk prop's bottom
    // is inside its support, and a ray started there would sail to the
    // support's underside and read as a huge gap. The lift clears the sink;
    // gap subtracts it back out (resting/sunk props land at gap <= 0).
    const lift = gapTol + 0.05;
    const rays: Vec3[] = [
      [cx, min[1] + lift, cz],
      [min[0] + ix, min[1] + lift, min[2] + iz],
      [max[0] - ix, min[1] + lift, min[2] + iz],
      [min[0] + ix, min[1] + lift, max[2] - iz],
      [max[0] - ix, min[1] + lift, max[2] - iz],
    ];
    let gap = Infinity;
    for (const origin of rays) {
      const hit = raycastTriangles(others, origin, [0, -1, 0], 1000).find((h) => h.normal[1] >= 0.3);
      if (hit) gap = Math.min(gap, hit.t - lift);
    }
    if (gap === Infinity) {
      // nothing below at all: that's only "floating" when the entity hangs
      // above the ground plane — the scene's own floor/ground slab sits at or
      // below y=0 with nothing under it BY DESIGN, and flagging every floor
      // would bury the real findings.
      if (min[1] > 0.05 && !push({ kind: "floating", entity: id, message: "nothing below its lowest face — floating in the void", at: [cx, min[1], cz] })) return findings;
    } else if (gap > gapTol) {
      if (!push({ kind: "floating", entity: id, value: r6(gap), message: `floats ${gap.toFixed(3)}m above its support`, at: [cx, min[1], cz] })) return findings;
    }
  }

  // ---- overlap (opt-in; pairwise AABB penetration, statics only, terrain exempt)
  for (let i = 0; overlapTol !== undefined && i < groupIds.length; i++) {
    const a = groups.get(groupIds[i]!)!;
    if (a.heightmap) continue;
    for (let j = i + 1; j < groupIds.length; j++) {
      const b = groups.get(groupIds[j]!)!;
      if (b.heightmap) continue;
      let pen = Infinity;
      for (let axis = 0; axis < 3; axis++) {
        const o = Math.min(a.aabb.max[axis]!, b.aabb.max[axis]!) - Math.max(a.aabb.min[axis]!, b.aabb.min[axis]!);
        if (o < pen) pen = o;
      }
      if (pen > overlapTol) {
        const at: Vec3 = [
          (Math.max(a.aabb.min[0], b.aabb.min[0]) + Math.min(a.aabb.max[0], b.aabb.max[0])) / 2,
          (Math.max(a.aabb.min[1], b.aabb.min[1]) + Math.min(a.aabb.max[1], b.aabb.max[1])) / 2,
          (Math.max(a.aabb.min[2], b.aabb.min[2]) + Math.min(a.aabb.max[2], b.aabb.max[2])) / 2,
        ];
        if (!push({ kind: "overlap", entity: groupIds[i]!, other: groupIds[j]!, value: r6(pen), message: `interpenetrates by ~${pen.toFixed(3)}m (least axis)`, at })) return findings;
      }
    }
  }

  // ---- z-fight: bucket triangles by signed plane; a bucket holding
  // in-plane-overlapping triangles from 2+ entities is a flicker risk.
  interface PlaneTri { source: EntityId; u0: number; v0: number; u1: number; v1: number; at: Vec3 }
  const buckets = new Map<string, PlaneTri[]>();
  const reported = new Set<string>();
  for (const [src, group] of groups) {
    if (group.heightmap) continue;
    let count = 0;
    for (const t of group.tris) count += t.length / 9;
    if (count > 3000) continue; // dense meshes: too costly, and rarely the graybox z-fight case
    for (const tris of group.tris) {
      for (let i = 0; i < tris.length; i += 9) {
        const ax = tris[i]!, ay = tris[i + 1]!, az = tris[i + 2]!;
        const e1x = tris[i + 3]! - ax, e1y = tris[i + 4]! - ay, e1z = tris[i + 5]! - az;
        const e2x = tris[i + 6]! - ax, e2y = tris[i + 7]! - ay, e2z = tris[i + 8]! - az;
        let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-9) continue;
        nx /= len; ny /= len; nz /= len;
        const d = nx * ax + ny * ay + nz * az;
        const key = `${Math.round(nx * 100)},${Math.round(ny * 100)},${Math.round(nz * 100)},${Math.round(d / coplanarTol)}`;
        // in-plane 2D coords on the two smallest-normal axes
        const dom = Math.abs(nx) > Math.abs(ny) ? (Math.abs(nx) > Math.abs(nz) ? 0 : 2) : Math.abs(ny) > Math.abs(nz) ? 1 : 2;
        const ua = dom === 0 ? 1 : 0, va = dom === 2 ? 1 : 2;
        const us = [tris[i + ua]!, tris[i + 3 + ua]!, tris[i + 6 + ua]!];
        const vs = [tris[i + va]!, tris[i + 3 + va]!, tris[i + 6 + va]!];
        const entry: PlaneTri = {
          source: src,
          u0: Math.min(...us), v0: Math.min(...vs),
          u1: Math.max(...us), v1: Math.max(...vs),
          at: [
            (ax + tris[i + 3]! + tris[i + 6]!) / 3,
            (ay + tris[i + 4]! + tris[i + 7]!) / 3,
            (az + tris[i + 5]! + tris[i + 8]!) / 3,
          ],
        };
        const bucket = buckets.get(key);
        if (!bucket) buckets.set(key, [entry]);
        else {
          for (const otherTri of bucket) {
            if (otherTri.source === src) continue;
            const ou = Math.min(entry.u1, otherTri.u1) - Math.max(entry.u0, otherTri.u0);
            const ov = Math.min(entry.v1, otherTri.v1) - Math.max(entry.v0, otherTri.v0);
            if (ou > 0.002 && ov > 0.002) {
              const pair = [src, otherTri.source].sort().join("|");
              if (!reported.has(pair)) {
                reported.add(pair);
                if (!push({
                  kind: "z-fight",
                  entity: src,
                  other: otherTri.source,
                  message: "coincident coplanar faces (same facing) — will flicker",
                  at: entry.at,
                })) return findings;
              }
              break;
            }
          }
          bucket.push(entry);
        }
      }
    }
  }

  return findings;
}

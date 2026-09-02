import { edgeId, type PolyFace, type PolyMesh, type Vec3 } from "./types.js";
import { buildTopology, perimeterEdges, vertexNormal } from "./topology.js";
import { cloneMesh } from "./ops.js";
import { polyFromPrimitive, type PrimitiveSource } from "./shapes.js";
import { add, centroid, dot, lerp, scale } from "./vec.js";

/**
 * Surface weathering — the "quarried, not printed" pass from the dungeon
 * tooling plan. Machine-exact geometry (the structure compiler's butt-jointed
 * walls) is subdivided and its NEW INTERIOR vertices are displaced by seeded,
 * deterministic value noise along the surface normal, so a flat face reads as
 * hand-hewn stone.
 *
 * The one contract that matters: **the seal is untouchable**. No vertex that
 * existed before subdivision ever moves, and no vertex created on the
 * boundary of the weathered selection (an edge shared with an unselected
 * face, or an open mesh edge) ever moves. A weathered wall still meets its
 * neighbours on exactly the original planes — weathering can never introduce
 * a gap or a z-fight that the seal verifier signed off on before the pass.
 *
 * Pure functions in the ops.ts style: PolyMesh in, new PolyMesh out, no
 * mutation of the input, no Math.random (same seed → byte-identical output).
 */

export interface WeatherOptions {
  /** Face indices to weather. Default: every face. */
  faces?: number[];
  /** Subdivision rounds before displacement (1 → each n-gon becomes n quads; 2 → n*4). Default 1. */
  subdivisions?: 1 | 2;
  /** Displacement range in metres: interior vertices move up to ±amplitude along the surface normal. */
  amplitude: number;
  /** Noise feature size in metres (bigger → broader undulation). Default 0.8. */
  scale?: number;
  /** Noise seed. Same seed + same mesh → identical result. */
  seed: number;
}

/**
 * Subdivide the selected faces and displace only the newly created interior
 * vertices along the local surface normal by seeded value noise.
 *
 * Pinned (never moved, byte-identical to their computed positions):
 * - every vertex that existed before the call;
 * - every new vertex created on a selection-perimeter edge (shared with an
 *   unselected face or on an open mesh boundary) — those midpoints are still
 *   INSERTED into the unselected neighbour's corner list so the mesh stays
 *   watertight (no T-junctions), they just stay exactly on the original edge.
 *
 * A closed selection (e.g. every face of a box) has no perimeter, so all new
 * vertices are interior and the whole surface roughens — the original
 * corners still never move.
 */
export function weatherFaces(mesh: PolyMesh, options: WeatherOptions): PolyMesh {
  const faceCount = mesh.faces.length;
  let faces = [...new Set(options.faces ?? mesh.faces.map((_, i) => i))].filter(
    (i) => Number.isInteger(i) && i >= 0 && i < faceCount,
  );
  if (faces.length === 0) return cloneMesh(mesh);

  const rounds = options.subdivisions === 2 ? 2 : 1;
  const amplitude = Number.isFinite(options.amplitude) ? options.amplitude : 0;
  const featureScale = typeof options.scale === "number" && options.scale > 1e-6 ? options.scale : 0.8;
  const seed = options.seed | 0;

  let current = mesh;
  const movable = new Set<number>();
  for (let r = 0; r < rounds; r++) {
    const result = subdivideRegionOnce(current, faces);
    current = result.mesh;
    for (const v of result.movable) movable.add(v);
    faces = result.regionFaces;
  }

  if (amplitude !== 0 && movable.size > 0) {
    // directions from the UNDISPLACED subdivided mesh, all computed before any
    // vertex moves — deterministic and order-independent
    const topo = buildTopology(current);
    const targets = [...movable].sort((a, b) => a - b);
    const dirs = targets.map((v) => vertexNormal(current, topo, v));
    targets.forEach((v, i) => {
      const p = current.vertices[v]!;
      const n = fractalNoise3(p[0] / featureScale, p[1] / featureScale, p[2] / featureScale, seed);
      current.vertices[v] = add(p, scale(dirs[i]!, n * amplitude));
    });
  }

  // geometry changed: the parametric origin no longer describes the mesh
  if (current.generator) {
    const { generator: _g, ...rest } = current;
    current = rest;
  }
  return current;
}

const BOX_SIDES = ["+x", "-x", "+y", "-y", "+z", "-z"] as const;
export type BoxSide = (typeof BOX_SIDES)[number];

const SIDE_NORMALS: Record<BoxSide, Vec3> = {
  "+x": [1, 0, 0],
  "-x": [-1, 0, 0],
  "+y": [0, 1, 0],
  "-y": [0, -1, 0],
  "+z": [0, 0, 1],
  "-z": [0, 0, -1],
};

export interface WeatheredBoxOptions {
  /** Which local-axis sides to weather ("+z" = the face whose normal is local +Z). Default "all". */
  faces?: "all" | BoxSide[];
  subdivisions?: 1 | 2;
  amplitude: number;
  scale?: number;
  seed: number;
}

/**
 * Convenience for the structure compiler: turn a `primitive` box source (a
 * compiler-emitted wall slab) into an editable poly mesh with the requested
 * sides weathered. Sides are named by the box's LOCAL axes; the entity
 * transform decides which way they face in the world. Returns the mesh plus
 * the position offset `polyFromPrimitive` requires (add it to the entity's
 * position — primitives are origin-centered, poly meshes stand on y=0).
 *
 * The unweathered sides — and every edge of the box — are untouched, so a
 * wall weathered only on its exposed face still butts flush against floor,
 * ceiling, and neighbouring walls.
 */
export function weatheredBoxSource(
  source: PrimitiveSource,
  options: WeatheredBoxOptions,
): { mesh: PolyMesh; offset: Vec3 } {
  const { mesh, offset } = polyFromPrimitive(source);
  let faceList: number[];
  if (options.faces === undefined || options.faces === "all") {
    faceList = mesh.faces.map((_, i) => i);
  } else {
    const topo = buildTopology(mesh);
    const wanted = options.faces.filter((s): s is BoxSide => BOX_SIDES.includes(s)).map((s) => SIDE_NORMALS[s]);
    faceList = mesh.faces
      .map((_, i) => i)
      .filter((i) => wanted.some((n) => dot(topo.faceNormals[i]!, n) > 0.999));
  }
  const weathered = weatherFaces(mesh, {
    faces: faceList,
    amplitude: options.amplitude,
    seed: options.seed,
    ...(options.subdivisions !== undefined ? { subdivisions: options.subdivisions } : {}),
    ...(options.scale !== undefined ? { scale: options.scale } : {}),
  });
  return { mesh: weathered, offset };
}

// ------------------------------------------------- face-local subdivision

/**
 * One subdivision round over a face selection: each selected n-gon becomes n
 * quads around a new center vertex, edge midpoints shared between selected
 * neighbours. Midpoints on the selection perimeter are inserted into the
 * unselected faces using that edge (watertight, no T-junctions) and reported
 * as PINNED; midpoints on selection-interior edges and all center vertices
 * are reported as movable.
 *
 * This is deliberately a local reimplementation of `subdivideFaces` rather
 * than a call to it: the shared op does not report which new vertices are
 * perimeter midpoints, and the pin contract lives or dies on knowing that.
 */
function subdivideRegionOnce(
  mesh: PolyMesh,
  faces: number[],
): { mesh: PolyMesh; regionFaces: number[]; movable: number[] } {
  const out = cloneMesh(mesh);
  const selected = new Set(faces);
  // selection perimeter = edges used by exactly one selected face: either an
  // open mesh boundary or the shared plane with an unselected neighbour —
  // both are part of the seal
  const pinnedEdges = new Set(perimeterEdges(mesh, faces).map(([a, b]) => edgeId(a, b)));
  const midpoints = new Map<string, number>();
  const movable: number[] = [];
  const mid = (a: number, b: number): number => {
    const id = edgeId(a, b);
    const hit = midpoints.get(id);
    if (hit !== undefined) return hit;
    const idx = out.vertices.length;
    out.vertices.push(lerp(out.vertices[a]!, out.vertices[b]!, 0.5));
    midpoints.set(id, idx);
    if (!pinnedEdges.has(id)) movable.push(idx);
    insertOnEdge(out.faces, a, b, idx, selected);
    return idx;
  };
  const replaced: PolyFace[] = [];
  for (const fi of faces) {
    const face = mesh.faces[fi]!;
    const n = face.v.length;
    const center = out.vertices.length;
    out.vertices.push(centroid(face.v.map((i) => out.vertices[i]!)));
    movable.push(center);
    const mids = face.v.map((v, i) => mid(v, face.v[(i + 1) % n]!));
    for (let i = 0; i < n; i++) {
      replaced.push(deriveFace(face, [face.v[i]!, mids[i]!, center, mids[(i - 1 + n) % n]!]));
    }
  }
  const keep = out.faces.filter((_, i) => !selected.has(i));
  const start = keep.length;
  out.faces = [...keep, ...replaced];
  const regionFaces: number[] = [];
  for (let i = start; i < out.faces.length; i++) regionFaces.push(i);
  return { mesh: out, regionFaces, movable };
}

/** Face attributes for a new face derived from `from` (material/smoothing/tint carry over; manual UVs and per-corner colors can't — corner count changed). */
function deriveFace(from: PolyFace, v: number[]): PolyFace {
  const face: PolyFace = { v, mat: from.mat ?? 0, smooth: from.smooth ?? 0 };
  if (from.color) face.color = from.color;
  if (from.uv && from.uv.mode !== "manual") face.uv = { ...from.uv };
  return face;
}

/** Insert vertex `m` between consecutive corners `a`,`b` in every face using that edge (either direction), skipping faces in `except`. Mirrors the ops.ts helper (not exported there). */
function insertOnEdge(faces: PolyFace[], a: number, b: number, m: number, except?: Set<number>): void {
  faces.forEach((face, fi) => {
    if (except?.has(fi)) return;
    const n = face.v.length;
    for (let i = 0; i < n; i++) {
      const x = face.v[i]!;
      const y = face.v[(i + 1) % n]!;
      if ((x === a && y === b) || (x === b && y === a)) {
        face.v.splice(i + 1, 0, m);
        if (face.uv?.mode === "manual" && face.uv.coords) {
          const c0 = face.uv.coords[i]!;
          const c1 = face.uv.coords[(i + 1) % n]!;
          face.uv.coords.splice(i + 1, 0, [(c0[0] + c1[0]) / 2, (c0[1] + c1[1]) / 2]);
        }
        if (face.colors && face.colors.length === n) face.colors.splice(i + 1, 0, face.colors[i]!);
        return;
      }
    }
  });
}

// ------------------------------------------------- seeded value noise

/** Integer lattice hash → [0, 1). Deterministic across platforms (32-bit integer math only). */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b9) ^ Math.imul(seed | 0, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const fade = (t: number): number => t * t * (3 - 2 * t);

/** Trilinear value noise in [-1, 1]. */
function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const tx = fade(x - x0);
  const ty = fade(y - y0);
  const tz = fade(z - z0);
  const c = (dx: number, dy: number, dz: number): number => hash3(x0 + dx, y0 + dy, z0 + dz, seed);
  const lx0 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * tx;
  const lx1 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * tx;
  const lx2 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * tx;
  const lx3 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * tx;
  const ly0 = lx0 + (lx1 - lx0) * ty;
  const ly1 = lx2 + (lx3 - lx2) * ty;
  return (ly0 + (ly1 - ly0) * tz) * 2 - 1;
}

/** Two octaves of value noise, still in [-1, 1] — broad undulation plus finer chisel marks. */
function fractalNoise3(x: number, y: number, z: number, seed: number): number {
  return valueNoise3(x, y, z, seed) * 0.7 + valueNoise3(x * 2.13 + 17.31, y * 2.13 + 11.17, z * 2.13 + 23.71, seed ^ 0x51ed270b) * 0.3;
}

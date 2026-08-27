import { type FaceUv, type PolyFace, type PolyMesh, type Vec2, type Vec3, faceUvSchema } from "./types.js";
import { buildTopology, type Topology } from "./topology.js";
import { applyMatrix4, applyMatrix4Dir, normalize, planeBasis, polygonAreaVector } from "./vec.js";

/**
 * PolyMesh -> render-ready triangle buffers. Pure and headless: the renderer
 * wraps the arrays in a BufferGeometry, the physics sim feeds them to a
 * trimesh/convex cooker, and tests assert on them directly.
 *
 * - n-gons are ear-clipped in their own plane (fan fallback for degenerate
 *   input), so concave faces render correctly;
 * - normals follow smoothing groups: group 0 is flat, faces sharing a nonzero
 *   group average their normals across shared vertices (ProBuilder semantics);
 * - UVs come from each face's auto-unwrap settings or its manual coords;
 * - triangles are sorted by material slot into `groups`, and `triangleFace`
 *   maps every output triangle back to its source face for picking.
 */
export interface CompiledMesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /** RGB per vertex; present only when at least one face carries a color. */
  colors: Float32Array | null;
  indices: Uint32Array;
  /** Index-buffer ranges per material slot (three.js `geometry.addGroup`). */
  groups: Array<{ start: number; count: number; materialIndex: number }>;
  /** Triangle i (indices[3i..3i+2]) came from face triangleFace[i]. */
  triangleFace: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

export interface CompileOptions {
  /** Entity world matrix (column-major 16) for faces with `uv.worldSpace`. */
  worldMatrix?: ArrayLike<number>;
}

interface Corner {
  position: Vec3;
  normal: Vec3;
  uv: Vec2;
  color: [number, number, number] | null;
}

const DEFAULT_UV: FaceUv = faceUvSchema.parse({});

export function compilePolyMesh(mesh: PolyMesh, options: CompileOptions = {}): CompiledMesh {
  const topo = buildTopology(mesh);
  const faceUvs = computeFaceUvs(mesh, topo, options);
  const hasColors = mesh.faces.some((f) => f.color !== undefined || (f.colors && f.colors.length > 0));

  // per-vertex smoothed normals, keyed by smoothing group
  const smoothed = new Map<string, Vec3>();
  const smoothedNormal = (vertex: number, group: number): Vec3 => {
    const key = `${vertex}|${group}`;
    const cached = smoothed.get(key);
    if (cached) return cached;
    const n: Vec3 = [0, 0, 0];
    for (const fi of topo.vertexFaces[vertex] ?? []) {
      const face = mesh.faces[fi]!;
      if ((face.smooth ?? 0) !== group) continue;
      const a = polygonAreaVector(face.v.map((i) => mesh.vertices[i]!));
      n[0] += a[0];
      n[1] += a[1];
      n[2] += a[2];
    }
    const out = normalize(n);
    smoothed.set(key, out);
    return out;
  };

  // corners -> deduped indexed vertices
  const cornerIndex = new Map<string, number>();
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const emitCorner = (c: Corner): number => {
    const key = `${c.position.join(",")}|${c.normal.map((x) => x.toFixed(4)).join(",")}|${c.uv[0].toFixed(5)},${c.uv[1].toFixed(5)}|${c.color ? c.color.join(",") : ""}`;
    const existing = cornerIndex.get(key);
    if (existing !== undefined) return existing;
    const index = positions.length / 3;
    positions.push(...c.position);
    normals.push(...c.normal);
    uvs.push(...c.uv);
    if (hasColors) colors.push(...(c.color ?? [1, 1, 1]));
    cornerIndex.set(key, index);
    return index;
  };

  // triangulate per face, bucketed by material slot
  const buckets = new Map<number, Array<{ tri: [number, number, number]; face: number }>>();
  mesh.faces.forEach((face, fi) => {
    const group = face.smooth ?? 0;
    const flat = topo.faceNormals[fi]!;
    const color = face.color ? hexToRgb(face.color) : null;
    const corners = face.colors && face.colors.length === face.v.length ? face.colors : null;
    const uvList = faceUvs[fi]!;
    const cornerIds = face.v.map((v, ci) =>
      emitCorner({
        position: mesh.vertices[v]!,
        normal: group === 0 ? flat : smoothedNormal(v, group),
        uv: uvList[ci] ?? [0, 0],
        color: corners ? hexToRgb(corners[ci]!) : color,
      }),
    );
    const tris = triangulateFace(face.v.map((v) => mesh.vertices[v]!), flat);
    const slot = face.mat ?? 0;
    let bucket = buckets.get(slot);
    if (!bucket) {
      bucket = [];
      buckets.set(slot, bucket);
    }
    for (const [a, b, c] of tris) {
      bucket.push({ tri: [cornerIds[a]!, cornerIds[b]!, cornerIds[c]!], face: fi });
    }
  });

  const slots = [...buckets.keys()].sort((a, b) => a - b);
  const indices: number[] = [];
  const triangleFace: number[] = [];
  const groups: CompiledMesh["groups"] = [];
  for (const slot of slots) {
    const start = indices.length;
    for (const { tri, face } of buckets.get(slot)!) {
      indices.push(tri[0], tri[1], tri[2]);
      triangleFace.push(face);
    }
    groups.push({ start, count: indices.length - start, materialIndex: slot });
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    colors: hasColors ? new Float32Array(colors) : null,
    indices: new Uint32Array(indices),
    groups,
    triangleFace: new Uint32Array(triangleFace),
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

/** Welded collision geometry (shared positions, triangulated faces) for trimesh/convex cooking. */
export function polyMeshCollision(mesh: PolyMesh): { positions: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array(mesh.vertices.length * 3);
  mesh.vertices.forEach((v, i) => {
    positions[i * 3] = v[0];
    positions[i * 3 + 1] = v[1];
    positions[i * 3 + 2] = v[2];
  });
  const indices: number[] = [];
  for (const face of mesh.faces) {
    const pts = face.v.map((i) => mesh.vertices[i]!);
    for (const [a, b, c] of triangulateFace(pts)) {
      indices.push(face.v[a]!, face.v[b]!, face.v[c]!);
    }
  }
  return { positions, indices: new Uint32Array(indices) };
}

/**
 * Ear-clipping triangulation of one face, returning corner-index triples
 * (indices into the face's own vertex list, not the mesh). Winding is kept.
 */
export function triangulateFace(points: Vec3[], normal?: Vec3): Array<[number, number, number]> {
  const n = points.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];
  const fn = normal ?? normalize(polygonAreaVector(points));
  if (n === 4) {
    // split along the diagonal that keeps both triangles facing the face normal
    // (handles non-planar and concave quads), preferring the shorter one
    const d02 = dist2(points[0]!, points[2]!);
    const d13 = dist2(points[1]!, points[3]!);
    const first: Array<[number, number, number]> = d02 <= d13 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 3], [1, 2, 3]];
    if (first.every(([a, b, c]) => triFacing(points[a]!, points[b]!, points[c]!, fn))) return first;
    const second: Array<[number, number, number]> = d02 <= d13 ? [[0, 1, 3], [1, 2, 3]] : [[0, 1, 2], [0, 2, 3]];
    if (second.every(([a, b, c]) => triFacing(points[a]!, points[b]!, points[c]!, fn))) return second;
    return first;
  }
  const { u, v } = planeBasis(fn);
  const pts2: Vec2[] = points.map((p) => [p[0] * u[0] + p[1] * u[1] + p[2] * u[2], p[0] * v[0] + p[1] * v[1] + p[2] * v[2]]);
  const result = earClip(pts2);
  return result.length > 0 ? result : fan(n);
}

function fan(n: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 1; i < n - 1; i++) out.push([0, i, i + 1]);
  return out;
}

function dist2(a: Vec3, b: Vec3): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

function triFacing(a: Vec3, b: Vec3, c: Vec3, n: Vec3): boolean {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cx = ab[1] * ac[2] - ab[2] * ac[1];
  const cy = ab[2] * ac[0] - ab[0] * ac[2];
  const cz = ab[0] * ac[1] - ab[1] * ac[0];
  return cx * n[0] + cy * n[1] + cz * n[2] >= -1e-12;
}

function earClip(pts: Vec2[]): Array<[number, number, number]> {
  const n = pts.length;
  // signed area: the basis is right-handed w.r.t. the normal so CCW is positive
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (Math.abs(area) < 1e-14) return [];
  const ccw = area > 0;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(ccw ? i : n - 1 - i);
  const out: Array<[number, number, number]> = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i - 1 + idx.length) % idx.length]!;
      const i1 = idx[i]!;
      const i2 = idx[(i + 1) % idx.length]!;
      const a = pts[i0]!;
      const b = pts[i1]!;
      const c = pts[i2]!;
      if (cross2(a, b, c) <= 1e-14) continue; // reflex or degenerate
      let inside = false;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (pointInTri(pts[j]!, a, b, c)) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      out.push(ccw ? [i0, i1, i2] : [i2, i1, i0]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) return []; // self-intersecting / numerically hopeless: caller fans
  }
  if (idx.length === 3) out.push(ccw ? [idx[0]!, idx[1]!, idx[2]!] : [idx[2]!, idx[1]!, idx[0]!]);
  return out;
}

function cross2(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointInTri(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = cross2(a, b, p);
  const d2 = cross2(b, c, p);
  const d3 = cross2(c, a, p);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ---------------------------------------------------------------- UVs

/**
 * Per-face per-corner UVs. Auto faces are planar-projected (grouped faces
 * share one projection plane) and run through the ProBuilder settings
 * pipeline: fill -> anchor -> rotation -> scale -> flips/swap -> offset.
 */
export function computeFaceUvs(mesh: PolyMesh, topo: Topology, options: CompileOptions = {}): Vec2[][] {
  const out: Vec2[][] = mesh.faces.map(() => []);
  // projection units: each ungrouped auto face alone; grouped faces together
  const units = new Map<string, number[]>();
  mesh.faces.forEach((face, fi) => {
    const uv = face.uv ?? DEFAULT_UV;
    if (uv.mode === "manual" && uv.coords && uv.coords.length === face.v.length) {
      out[fi] = uv.coords.map((c) => [c[0], c[1]]);
      return;
    }
    const key = uv.group > 0 ? `g${uv.group}` : `f${fi}`;
    const list = units.get(key);
    if (list) list.push(fi);
    else units.set(key, [fi]);
  });

  for (const faces of units.values()) {
    const rep = mesh.faces[faces[0]!]!;
    const settings = rep.uv ?? DEFAULT_UV;
    const world = settings.worldSpace && options.worldMatrix ? options.worldMatrix : null;
    // area-weighted average normal of the unit
    const n: Vec3 = [0, 0, 0];
    for (const fi of faces) {
      const a = polygonAreaVector(mesh.faces[fi]!.v.map((i) => mesh.vertices[i]!));
      n[0] += a[0];
      n[1] += a[1];
      n[2] += a[2];
    }
    let normal = normalize(n);
    if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) normal = topo.faceNormals[faces[0]!]!;
    if (world) normal = normalize(applyMatrix4Dir(normal, world));
    const { u, v } = planeBasis(normal);
    const raw: Vec2[][] = faces.map((fi) =>
      mesh.faces[fi]!.v.map((vi) => {
        const p = world ? applyMatrix4(mesh.vertices[vi]!, world) : mesh.vertices[vi]!;
        return [p[0] * u[0] + p[1] * u[1] + p[2] * u[2], p[0] * v[0] + p[1] * v[1] + p[2] * v[2]];
      }),
    );
    const processed = applyUvSettings(raw, settings);
    faces.forEach((fi, i) => {
      out[fi] = processed[i]!;
    });
  }
  return out;
}

/** The auto-unwrap settings pipeline over a projection unit's raw planar coords. Exported for the UV editor's preview. */
export function applyUvSettings(unit: Vec2[][], s: FaceUv): Vec2[][] {
  let uvs = unit.map((face) => face.map((c) => [c[0], c[1]] as Vec2));
  const bounds = (): { min: Vec2; max: Vec2 } => {
    const min: Vec2 = [Infinity, Infinity];
    const max: Vec2 = [-Infinity, -Infinity];
    for (const face of uvs) {
      for (const c of face) {
        min[0] = Math.min(min[0], c[0]);
        min[1] = Math.min(min[1], c[1]);
        max[0] = Math.max(max[0], c[0]);
        max[1] = Math.max(max[1], c[1]);
      }
    }
    return { min, max };
  };
  const map = (fn: (c: Vec2) => Vec2): void => {
    uvs = uvs.map((face) => face.map(fn));
  };

  if (s.fill === "stretch" || s.fill === "fit") {
    const { min, max } = bounds();
    const w = Math.max(1e-9, max[0] - min[0]);
    const h = Math.max(1e-9, max[1] - min[1]);
    if (s.fill === "stretch") map((c) => [(c[0] - min[0]) / w, (c[1] - min[1]) / h]);
    else {
      const k = 1 / Math.max(w, h);
      map((c) => [(c[0] - min[0]) * k, (c[1] - min[1]) * k]);
    }
  }
  if (s.anchor !== "none" && !s.worldSpace) {
    const { min, max } = bounds();
    const cx = (min[0] + max[0]) / 2;
    const cy = (min[1] + max[1]) / 2;
    const ax = s.anchor.endsWith("left") ? min[0] : s.anchor.endsWith("right") ? max[0] : cx;
    const ay = s.anchor.startsWith("upper") ? max[1] : s.anchor.startsWith("lower") ? min[1] : cy;
    map((c) => [c[0] - ax, c[1] - ay]);
  }
  if (s.rotation !== 0) {
    const r = (s.rotation * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    map((c) => [c[0] * cos - c[1] * sin, c[0] * sin + c[1] * cos]);
  }
  if (s.scale[0] !== 1 || s.scale[1] !== 1) map((c) => [c[0] * s.scale[0], c[1] * s.scale[1]]);
  if (s.flipU) map((c) => [-c[0], c[1]]);
  if (s.flipV) map((c) => [c[0], -c[1]]);
  if (s.swapUV) map((c) => [c[1], c[0]]);
  if (s.offset[0] !== 0 || s.offset[1] !== 0) map((c) => [c[0] + s.offset[0], c[1] + s.offset[1]]);
  return uvs;
}

/** Raw planar projection of faces onto the plane of their average normal (no settings applied) — the seed for manual UV editing. */
export function planarProject(mesh: PolyMesh, faces: number[], normalOverride?: Vec3): Vec2[][] {
  const n: Vec3 = [0, 0, 0];
  for (const fi of faces) {
    const a = polygonAreaVector(mesh.faces[fi]!.v.map((i) => mesh.vertices[i]!));
    n[0] += a[0];
    n[1] += a[1];
    n[2] += a[2];
  }
  let normal = normalOverride ?? normalize(n);
  // a closed selection (a whole box) has no net normal — project along the
  // first face's instead of collapsing everything onto one point
  if (Math.abs(normal[0]) + Math.abs(normal[1]) + Math.abs(normal[2]) < 1e-6) {
    const first = faces[0];
    normal = first !== undefined ? normalize(polygonAreaVector(mesh.faces[first]!.v.map((i) => mesh.vertices[i]!))) : [0, 1, 0];
    if (Math.abs(normal[0]) + Math.abs(normal[1]) + Math.abs(normal[2]) < 1e-6) normal = [0, 1, 0];
  }
  const { u, v } = planeBasis(normal);
  return faces.map((fi) =>
    mesh.faces[fi]!.v.map((vi) => {
      const p = mesh.vertices[vi]!;
      return [p[0] * u[0] + p[1] * u[1] + p[2] * u[2], p[0] * v[0] + p[1] * v[1] + p[2] * v[2]] as Vec2;
    }),
  );
}

export function faceUvSettings(face: PolyFace): FaceUv {
  return face.uv ?? DEFAULT_UV;
}

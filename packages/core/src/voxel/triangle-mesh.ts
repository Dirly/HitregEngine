import { z } from "zod";

type Vec = [number, number, number];
interface Bounds { min: Vec; max: Vec }
interface Triangle extends Bounds {
  a: Vec; b: Vec; c: Vec;
  vertices: number[];
  normal: Vec;
  index: number;
}
interface Tree<T extends Bounds> extends Bounds {
  left?: Tree<T>; right?: Tree<T>; items?: T[];
}
interface Solid extends Bounds {
  tree: Tree<Triangle>;
  triangles: Triangle[];
  /** Outward planes, only when every vertex proves this solid convex. */
  planes?: { point: Vec; normal: Vec }[];
}

const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function bounds(items: readonly Bounds[]): Bounds {
  const min: Vec = [Infinity, Infinity, Infinity], max: Vec = [-Infinity, -Infinity, -Infinity];
  for (const item of items) for (let a = 0; a < 3; a++) {
    min[a] = Math.min(min[a]!, item.min[a]!);
    max[a] = Math.max(max[a]!, item.max[a]!);
  }
  return { min, max };
}

function tree<T extends Bounds>(items: T[], leafSize: number): Tree<T> {
  const box = bounds(items);
  if (items.length <= leafSize) return { ...box, items };
  let axis = 0;
  for (let a = 1; a < 3; a++) if (box.max[a]! - box.min[a]! > box.max[axis]! - box.min[axis]!) axis = a;
  items.sort((a, b) => (a.min[axis]! + a.max[axis]!) - (b.min[axis]! + b.max[axis]!));
  const mid = Math.floor(items.length / 2);
  return { ...box, left: tree(items.slice(0, mid), leafSize), right: tree(items.slice(mid), leafSize) };
}

function boxDistanceSq(box: Bounds, x: number, y: number, z: number): number {
  const dx = Math.max(box.min[0] - x, 0, x - box.max[0]);
  const dy = Math.max(box.min[1] - y, 0, y - box.max[1]);
  const dz = Math.max(box.min[2] - z, 0, z - box.max[2]);
  return dx * dx + dy * dy + dz * dz;
}

function boxesOverlap(a: Bounds, b: Bounds): boolean {
  return a.min[0] <= b.max[0] && a.max[0] >= b.min[0] && a.min[1] <= b.max[1] && a.max[1] >= b.min[1] && a.min[2] <= b.max[2] && a.max[2] >= b.min[2];
}

/** Separating axes for two triangle convex hulls, including coplanar axes. */
function trianglesOverlap(a: Vec[], b: Vec[]): boolean {
  const ea = [sub(a[1]!, a[0]!), sub(a[2]!, a[1]!), sub(a[0]!, a[2]!)];
  const eb = [sub(b[1]!, b[0]!), sub(b[2]!, b[1]!), sub(b[0]!, b[2]!)];
  const na = cross(ea[0]!, ea[1]!), nb = cross(eb[0]!, eb[1]!);
  const axes = [na, nb];
  for (const x of ea) {
    axes.push(cross(na, x));
    for (const y of eb) axes.push(cross(x, y));
  }
  for (const y of eb) axes.push(cross(nb, y));
  const origin = a[0]!;
  for (const axis of axes) {
    const length = Math.hypot(...axis);
    if (length === 0) continue;
    const n: Vec = [axis[0] / length, axis[1] / length, axis[2] / length];
    const pa = a.map((p) => dot(n, sub(p, origin))), pb = b.map((p) => dot(n, sub(p, origin)));
    if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
  }
  return true;
}

function invalidIntersection(a: Triangle, b: Triangle): boolean {
  if (!boxesOverlap(a, b)) return false;
  const shared = a.vertices.filter((v) => b.vertices.includes(v));
  if (shared.length === 3) return true;
  if (!shared.length) return trianglesOverlap([a.a, a.b, a.c], [b.a, b.b, b.c]);
  // Indexed neighbours are allowed to meet at their common edge/vertex.
  // Trim only that common locus by a numerical relative tolerance before
  // the same exact convex-hull test, so folds/overlaps beyond it are rejected.
  const trim = (t: Triangle): Vec[] => {
    const points = [t.a, t.b, t.c], center: Vec = [(t.a[0] + t.b[0] + t.c[0]) / 3, (t.a[1] + t.b[1] + t.c[1]) / 3, (t.a[2] + t.b[2] + t.c[2]) / 3];
    return points.map((p, i) => shared.includes(t.vertices[i]!) ? p.map((v, axis) => v + (center[axis]! - v) * 1e-9) as Vec : p);
  };
  return trianglesOverlap(trim(a), trim(b));
}

function validateIntersections(node: Tree<Triangle>, triangle: Triangle, solidIndex: number): void {
  if (!boxesOverlap(node, triangle)) return;
  if (node.items) {
    for (const other of node.items) if (other.index > triangle.index && invalidIntersection(triangle, other)) {
      throw new Error(`mesh solid ${solidIndex} self-intersects at triangles ${triangle.index} and ${other.index}`);
    }
  } else {
    validateIntersections(node.left!, triangle, solidIndex); validateIntersections(node.right!, triangle, solidIndex);
  }
}

/** Closest point in the triangle's seven Voronoi regions; no projection outside a face. */
function triangleDistanceSq(t: Triangle, x: number, y: number, z: number): number {
  const ax = t.a[0], ay = t.a[1], az = t.a[2];
  const abx = t.b[0] - ax, aby = t.b[1] - ay, abz = t.b[2] - az;
  const acx = t.c[0] - ax, acy = t.c[1] - ay, acz = t.c[2] - az;
  const apx = x - ax, apy = y - ay, apz = z - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = x - t.b[0], bpy = y - t.b[1], bpz = z - t.b[2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3), dx = apx - v * abx, dy = apy - v * aby, dz = apz - v * abz;
    return dx * dx + dy * dy + dz * dz;
  }
  const cpx = x - t.c[0], cpy = y - t.c[1], cpz = z - t.c[2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6), dx = apx - w * acx, dy = apy - w * acy, dz = apz - w * acz;
    return dx * dx + dy * dy + dz * dz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const dx = bpx - w * (t.c[0] - t.b[0]), dy = bpy - w * (t.c[1] - t.b[1]), dz = bpz - w * (t.c[2] - t.b[2]);
    return dx * dx + dy * dy + dz * dz;
  }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  const dx = apx - abx * v - acx * w, dy = apy - aby * v - acy * w, dz = apz - abz * v - acz * w;
  return dx * dx + dy * dy + dz * dz;
}

interface Nearest { distanceSq: number; triangle: number }
function nearest(node: Tree<Triangle>, x: number, y: number, z: number, hit: Nearest): void {
  if (boxDistanceSq(node, x, y, z) > hit.distanceSq) return;
  if (node.items) {
    for (const t of node.items) {
      const d = triangleDistanceSq(t, x, y, z);
      if (d < hit.distanceSq || (d === hit.distanceSq && t.index < hit.triangle)) {
        hit.distanceSq = d; hit.triangle = t.index;
      }
    }
  } else {
    let a = node.left!, b = node.right!;
    if (boxDistanceSq(a, x, y, z) > boxDistanceSq(b, x, y, z)) [a, b] = [b, a];
    nearest(a, x, y, z, hit); nearest(b, x, y, z, hit);
  }
}

function rayBox(box: Bounds, p: Vec, direction: Vec): boolean {
  let near = 0, far = Infinity;
  for (let a = 0; a < 3; a++) {
    const t0 = (box.min[a]! - p[a]!) / direction[a]!, t1 = (box.max[a]! - p[a]!) / direction[a]!;
    near = Math.max(near, Math.min(t0, t1)); far = Math.min(far, Math.max(t0, t1));
  }
  return far >= near;
}

/** NaN means the ray met an edge: retry another direction, never double-count it. */
function rayHits(node: Tree<Triangle>, p: Vec, direction: Vec): number {
  if (!rayBox(node, p, direction)) return 0;
  if (!node.items) return rayHits(node.left!, p, direction) + rayHits(node.right!, p, direction);
  let count = 0;
  for (const t of node.items) {
    const ab = sub(t.b, t.a), ac = sub(t.c, t.a), h = cross(direction, ac), det = dot(ab, h);
    if (Math.abs(det) < 1e-14 * Math.sqrt(dot(ab, ab) * dot(ac, ac))) continue;
    const s = sub(p, t.a), u = dot(s, h) / det;
    if (u < -1e-12 || u > 1 + 1e-12) continue;
    const q = cross(s, ab), v = dot(direction, q) / det;
    if (v < -1e-12 || u + v > 1 + 1e-12 || dot(ac, q) / det <= 0) continue;
    if (Math.min(u, v, 1 - u - v) < 1e-10) return NaN;
    count++;
  }
  return count;
}

const RAYS: Vec[] = [[1, 0.3713906763541037, 0.6947465906068658], [-0.5297315471796477, 1, 0.231479071663], [0.193917, -0.719831, 1]];
function contains(solid: Solid, x: number, y: number, z: number): boolean {
  if (boxDistanceSq(solid, x, y, z) > 0) return false;
  if (solid.planes) {
    for (const plane of solid.planes) {
      const n = plane.normal, a = plane.point;
      if (n[0] * (x - a[0]) + n[1] * (y - a[1]) + n[2] * (z - a[2]) > 0) return false;
    }
    return true;
  }
  const p: Vec = [x, y, z];
  for (const ray of RAYS) {
    const hits = rayHits(solid.tree, p, ray);
    if (!Number.isNaN(hits)) return hits % 2 === 1;
  }
  // An adversarial sample can align with edges on all fixed rays. Irrational
  // deterministic directions keep the fallback independent of mesh winding.
  for (let i = 1; i <= 32; i++) {
    const hits = rayHits(solid.tree, p, [1, Math.sin(i * 2.399963229728653), Math.cos(i * 1.618033988749895)]);
    if (!Number.isNaN(hits)) return hits % 2 === 1;
  }
  throw new Error("Could not classify triangle solid: all parity rays meet an edge");
}

/** A conservative, 1-Lipschitz union of exact per-solid signed distances. */
export interface CompiledTriangleMesh extends Bounds {
  distance(x: number, y: number, z: number): number;
  /** Source triangle belonging to the solid that controls the union field. */
  triangleAt(x: number, y: number, z: number): number;
  /** Palette index from triangleMaterials, or undefined when materials were omitted. */
  materialAt(x: number, y: number, z: number): number | undefined;
  /** Outward source-face normal, independent of source winding, at the owning boundary. */
  normalAt(x: number, y: number, z: number, out: Float64Array): void;
}

const cache = new WeakMap<object, CompiledTriangleMesh>();

export const csgTriangleMeshSchema = z.object({
  positions: z.array(z.number().finite()).min(12).describe("Flat local XYZ coordinates in metres, Y up. Every indexed vertex belongs to a closed surface; bake scale into coordinates. Node position/rotation transform these coordinates; size is ignored."),
  indices: z.array(z.number().int().nonnegative()).min(12).describe("Triangle vertex indices, three per triangle. Shared vertices must use shared indices within a solid. No zero-area triangles, open edges, nonmanifold vertices/edges, or inconsistent winding. A whole connected shell may have either winding."),
  solidTriangleCounts: z.array(z.number().int().min(4)).min(1).optional().describe("Triangle counts of consecutive closed solids; their sum must equal indices.length/3. Solids are UNIONED even when they overlap. Each solid owns disjoint vertex indices; touching solids may duplicate coordinates. Omit for one closed solid. Disconnected boundary shells within one solid use parity (for example a sealed cavity); overlapping solids must be separate ranges."),
  triangleMaterials: z.array(z.number().int().nonnegative()).optional().describe("One volume palette index per source triangle, in index order. Overrides this node's floor/wall/ceiling palette at its surface, including carved faces. Omit to inherit the node surface. Ordinary volume paint strokes apply afterward."),
}).superRefine((mesh, ctx) => {
  try { cache.set(mesh, build(mesh)); }
  catch (error) { ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) }); }
}).describe("Closed indexed triangle solids sampled as a CSG signed-distance field, then extracted by the shared dual-contouring mesh path. Geometry must be an embedded closed manifold; self-intersections are rejected with 1e-9 relative tolerance at shared edges/vertices. A 64-machine-epsilon coordinate-scale boundary band consistently counts exactly touching closed surfaces as solid; no voxel smoothing or lattice changes. No UVs or imported render mesh fallback.");

export type CsgTriangleMesh = z.infer<typeof csgTriangleMeshSchema>;

/** Validate and compile once; all runtime acceleration is outside the JSON document. */
export function compileTriangleMesh(mesh: CsgTriangleMesh): CompiledTriangleMesh {
  const hit = cache.get(mesh);
  if (hit) return hit;
  const parsed = csgTriangleMeshSchema.parse(mesh);
  const compiled = cache.get(parsed)!;
  cache.set(mesh, compiled);
  return compiled;
}

function build(mesh: CsgTriangleMesh): CompiledTriangleMesh {
  if (mesh.positions.length % 3) throw new Error("mesh.positions length must be divisible by three");
  if (mesh.indices.length % 3) throw new Error("mesh.indices length must be divisible by three");
  const vertexCount = mesh.positions.length / 3, triangleCount = mesh.indices.length / 3;
  if (mesh.indices.some((i) => i >= vertexCount)) throw new Error("mesh.indices references a vertex outside positions");
  const counts = mesh.solidTriangleCounts ?? [triangleCount];
  if (counts.reduce((sum, n) => sum + n, 0) !== triangleCount) throw new Error("mesh.solidTriangleCounts must sum to the triangle count");
  if (mesh.triangleMaterials && mesh.triangleMaterials.length !== triangleCount) throw new Error("mesh.triangleMaterials needs exactly one palette index per triangle");
  const points: Vec[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) points.push([mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!]);
  const solids: Solid[] = [], vertexOwner = new Map<number, number>();
  const triangleSolids: Solid[] = [], allTriangles: Triangle[] = [];
  let start = 0;
  for (let si = 0; si < counts.length; si++) {
    const count = counts[si]!, triangles: Triangle[] = [];
    const edges = new Map<string, { from: number; to: number; faces: number[] }>();
    const incident = new Map<number, number[]>(), neighbors = Array.from({ length: count }, () => [] as number[]);
    for (let i = start; i < start + count; i++) {
      const ids = mesh.indices.slice(i * 3, i * 3 + 3), a = points[ids[0]!]!, b = points[ids[1]!]!, c = points[ids[2]!]!;
      const ab = sub(b, a), ac = sub(c, a), n = cross(ab, ac), length = Math.hypot(...n);
      if (!Number.isFinite(length) || length <= Math.sqrt(dot(ab, ab) * dot(ac, ac)) * 1e-12 || new Set(ids).size !== 3) throw new Error(`mesh triangle ${i} is degenerate`);
      const normal: Vec = [n[0] / length, n[1] / length, n[2] / length];
      triangles.push({ a, b, c, vertices: ids, normal, index: i, min: [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])], max: [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])] });
      for (let k = 0; k < 3; k++) {
        const v = ids[k]!, w = ids[(k + 1) % 3]!;
        const owner = vertexOwner.get(v);
        if (owner !== undefined && owner !== si) throw new Error(`mesh vertex ${v} is shared between solid ranges; give each solid independent indices`);
        vertexOwner.set(v, si);
        const faces = incident.get(v) ?? []; faces.push(i - start); incident.set(v, faces);
        const key = v < w ? `${v}:${w}` : `${w}:${v}`, edge = edges.get(key);
        if (!edge) edges.set(key, { from: v, to: w, faces: [i - start] });
        else {
          if (edge.faces.length !== 1) throw new Error(`mesh solid ${si} has a nonmanifold edge ${key}`);
          if (edge.from !== w || edge.to !== v) throw new Error(`mesh solid ${si} has inconsistent winding at edge ${key}`);
          neighbors[i - start]!.push(edge.faces[0]!); neighbors[edge.faces[0]!]!.push(i - start); edge.faces.push(i - start);
        }
      }
    }
    for (const [key, edge] of edges) if (edge.faces.length !== 2) throw new Error(`mesh solid ${si} is open at edge ${key}`);
    // Every vertex's link must be one cycle; edge counts alone allow two
    // closed shells pinched into a nonmanifold bow-tie vertex.
    for (const [vertex, faces] of incident) {
      const allowed = new Set(faces), seen = new Set<number>(), todo = [faces[0]!];
      while (todo.length) {
        const face = todo.pop()!;
        if (seen.has(face)) continue;
        seen.add(face);
        for (const next of neighbors[face]!) if (allowed.has(next) && !seen.has(next)) todo.push(next);
      }
      if (seen.size !== faces.length) throw new Error(`mesh solid ${si} has a nonmanifold vertex ${vertex}`);
    }
    const box = bounds(triangles), hierarchy = tree([...triangles], 8);
    for (const triangle of triangles) validateIntersections(hierarchy, triangle, si);
    const unvisited = new Set(triangles.map((_, i) => i));
    while (unvisited.size) {
      const first = unvisited.values().next().value!, todo = [first], origin = triangles[first]!.a;
      let signedVolume6 = 0, magnitude6 = 0;
      while (todo.length) {
        const i = todo.pop()!;
        if (!unvisited.delete(i)) continue;
        const t = triangles[i]!, contribution = dot(sub(t.a, origin), cross(sub(t.b, origin), sub(t.c, origin)));
        signedVolume6 += contribution; magnitude6 += Math.abs(contribution);
        for (const next of neighbors[i]!) if (unvisited.has(next)) todo.push(next);
      }
      if (Math.abs(signedVolume6) <= magnitude6 * 1e-12 || magnitude6 === 0) throw new Error(`mesh solid ${si} has a zero-volume boundary shell`);
    }
    const solid: Solid = { ...box, tree: hierarchy, triangles };
    // Convexity is a proof against all vertices, never an inference from a
    // nearest face. Bound startup work; larger/concave solids use BVH parity.
    if (triangles.length * incident.size <= 300000) {
      const center: Vec = [0, 0, 0];
      for (const v of incident.keys()) for (let a = 0; a < 3; a++) center[a] = center[a]! + points[v]![a]! / incident.size;
      const planes = triangles.map((t) => {
        const sign = dot(t.normal, sub(center, t.a)) > 0 ? -1 : 1;
        return { point: t.a, normal: t.normal.map((n) => n * sign) as Vec };
      });
      const epsilon = Math.max(...box.max.map((v, a) => v - box.min[a]!)) * 1e-11;
      if (planes.every((plane) => [...incident.keys()].every((v) => dot(plane.normal, sub(points[v]!, plane.point)) <= epsilon))) solid.planes = planes;
    }
    solids.push(solid); start += count;
    for (const t of triangles) { triangleSolids[t.index] = solid; allTriangles[t.index] = t; }
  }
  if (vertexOwner.size !== vertexCount) throw new Error("mesh.positions contains unused vertices");
  const hierarchy = tree(solids, 4);
  const boundaryBand = 64 * Number.EPSILON * Math.max(1, ...hierarchy.min.map(Math.abs), ...hierarchy.max.map(Math.abs));
  const outwardNormals = new Map<number, Vec>();
  let lastX = NaN, lastY = NaN, lastZ = NaN, lastDistance = Infinity, lastTriangle = -1;
  function sample(x: number, y: number, z: number): void {
    if (x === lastX && y === lastY && z === lastZ) return;
    lastX = x; lastY = y; lastZ = z; lastDistance = Infinity; lastTriangle = -1;
    const hit: Nearest = { distanceSq: Infinity, triangle: -1 };
    function visit(node: Tree<Solid>): void {
      const lower = boxDistanceSq(node, x, y, z);
      if (lastDistance < 0 ? lower > boundaryBand * boundaryBand : lower > (lastDistance + boundaryBand) ** 2) return;
      if (node.items) for (const solid of node.items) {
        const solidLower = boxDistanceSq(solid, x, y, z);
        if (lastDistance < 0 ? solidLower > boundaryBand * boundaryBand : solidLower > (lastDistance + boundaryBand) ** 2) continue;
        hit.distanceSq = Infinity; hit.triangle = -1;
        nearest(solid.tree, x, y, z, hit);
        const distance = Math.sqrt(hit.distanceSq) * (hit.distanceSq > 0 && contains(solid, x, y, z) ? -1 : 1) - boundaryBand;
        if (distance < lastDistance || (distance === lastDistance && hit.triangle < lastTriangle)) { lastDistance = distance; lastTriangle = hit.triangle; }
      } else {
        let a = node.left!, b = node.right!;
        if (boxDistanceSq(a, x, y, z) > boxDistanceSq(b, x, y, z)) [a, b] = [b, a];
        visit(a); visit(b);
      }
    }
    visit(hierarchy);
  }
  return {
    min: hierarchy.min, max: hierarchy.max,
    distance: (x, y, z) => { sample(x, y, z); return lastDistance; },
    triangleAt: (x, y, z) => { sample(x, y, z); return lastTriangle; },
    materialAt: (x, y, z) => { sample(x, y, z); return mesh.triangleMaterials?.[lastTriangle]; },
    normalAt: (x, y, z, out) => {
      sample(x, y, z);
      let normal = outwardNormals.get(lastTriangle);
      if (!normal) {
        const t = allTriangles[lastTriangle]!, n = t.normal;
        const center: Vec = [(t.a[0] + t.b[0] + t.c[0]) / 3, (t.a[1] + t.b[1] + t.c[1]) / 3, (t.a[2] + t.b[2] + t.c[2]) / 3];
        const epsilon = Math.max(boundaryBand * 8, Math.min(Math.hypot(...sub(t.b, t.a)), Math.hypot(...sub(t.c, t.a))) * 1e-8);
        const direction = contains(triangleSolids[lastTriangle]!, center[0] + n[0] * epsilon, center[1] + n[1] * epsilon, center[2] + n[2] * epsilon) ? -1 : 1;
        normal = [n[0] * direction, n[1] * direction, n[2] * direction]; outwardNormals.set(lastTriangle, normal);
      }
      out[0] = normal[0]; out[1] = normal[1]; out[2] = normal[2];
    },
  };
}

import { edgeId, type PolyFace, type PolyMesh, type Vec3 } from "./types.js";
import { boundaryLoops, buildTopology, faceEdges } from "./topology.js";
import { compactMesh } from "./ops.js";
import { cross, dot, length, normalize, polygonNormal, sub } from "./vec.js";

/**
 * Triangle soup -> editable poly mesh ("ProBuilderize"). Feeds two things:
 * converting an imported glTF part / path mesh / any rendered geometry into
 * something the element tools can edit, and re-ingesting CSG boolean output
 * (which is always triangles).
 *
 * Steps: weld coincident positions, drop degenerate triangles, merge
 * connected coplanar triangles back into n-gons (so a cube comes back as 6
 * quads, not 12 triangles), simplify collinear boundary vertices that no
 * other face needs, and infer smoothing groups from the dihedral angle so
 * curved surfaces stay smooth while creases stay hard.
 */
export interface FromGeometryOptions {
  /** Positions closer than this weld into one vertex. */
  weldDistance?: number;
  /** Merge connected coplanar triangles into n-gons (default true). */
  mergeCoplanar?: boolean;
  /** Max normal angle (degrees) for "coplanar" (default 0.5). */
  coplanarAngle?: number;
  /** Faces meeting at less than this dihedral angle (degrees) share a smoothing group; 0 = all hard (default 30). */
  smoothAngle?: number;
}

export function polyFromGeometry(
  positions: ArrayLike<number>,
  indices?: ArrayLike<number> | null,
  options: FromGeometryOptions = {},
): PolyMesh {
  const weld = options.weldDistance ?? 1e-5;
  const inv = 1 / weld;
  const lookup = new Map<string, number>();
  const vertices: Vec3[] = [];
  const remap: number[] = [];
  const count = Math.floor(positions.length / 3);
  for (let i = 0; i < count; i++) {
    const p: Vec3 = [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
    const key = `${Math.round(p[0] * inv)},${Math.round(p[1] * inv)},${Math.round(p[2] * inv)}`;
    let idx = lookup.get(key);
    if (idx === undefined) {
      idx = vertices.length;
      vertices.push([round6(p[0]), round6(p[1]), round6(p[2])]);
      lookup.set(key, idx);
    }
    remap.push(idx);
  }
  const faces: PolyFace[] = [];
  const triCount = indices ? Math.floor(indices.length / 3) : Math.floor(count / 3);
  for (let t = 0; t < triCount; t++) {
    const a = remap[indices ? indices[t * 3]! : t * 3]!;
    const b = remap[indices ? indices[t * 3 + 1]! : t * 3 + 1]!;
    const c = remap[indices ? indices[t * 3 + 2]! : t * 3 + 2]!;
    if (a === b || b === c || a === c) continue;
    const n = cross(sub(vertices[b]!, vertices[a]!), sub(vertices[c]!, vertices[a]!));
    if (length(n) < 1e-12) continue;
    faces.push({ v: [a, b, c], mat: 0, smooth: 0 });
  }
  let mesh: PolyMesh = { kind: "poly", vertices, faces, materials: [] };
  if (faces.length === 0) return mesh;
  if (options.mergeCoplanar ?? true) mesh = mergeCoplanarPatches(mesh, options.coplanarAngle ?? 0.5);
  mesh = inferSmoothing(mesh, options.smoothAngle ?? 30);
  return compactMesh(mesh);
}

/** Merge every connected patch of coplanar faces (single boundary loop) into one n-gon. */
export function mergeCoplanarPatches(mesh: PolyMesh, angleDeg = 0.5): PolyMesh {
  const topo = buildTopology(mesh);
  const cos = Math.cos((angleDeg * Math.PI) / 180);
  const visited = new Array<boolean>(mesh.faces.length).fill(false);
  const outFaces: PolyFace[] = [];
  const usedByKept = new Map<number, number>(); // vertex -> count of faces (for collinear cleanup)
  const patches: number[][] = [];
  for (let seed = 0; seed < mesh.faces.length; seed++) {
    if (visited[seed]) continue;
    const patch = [seed];
    visited[seed] = true;
    const n0 = topo.faceNormals[seed]!;
    const p0 = mesh.vertices[mesh.faces[seed]!.v[0]!]!;
    for (let k = 0; k < patch.length; k++) {
      const fi = patch[k]!;
      for (const [a, b] of faceEdges(mesh.faces[fi]!)) {
        const adj = topo.edgeFaces.get(edgeId(a, b)) ?? [];
        if (adj.length !== 2) continue; // only across manifold edges
        for (const g of adj) {
          if (visited[g]) continue;
          if (dot(topo.faceNormals[g]!, n0) < cos) continue;
          // same plane, not just parallel
          const q = mesh.vertices[mesh.faces[g]!.v[0]!]!;
          if (Math.abs(dot(sub(q, p0), n0)) > 1e-4) continue;
          visited[g] = true;
          patch.push(g);
        }
      }
    }
    patches.push(patch);
  }
  for (const patch of patches) {
    if (patch.length === 1) {
      outFaces.push(mesh.faces[patch[0]!]!);
      continue;
    }
    const sub: PolyMesh = { ...mesh, faces: patch.map((fi) => mesh.faces[fi]!) };
    const loops = boundaryLoops(sub, buildTopology(sub));
    if (loops.length !== 1 || loops[0]!.length < 3) {
      for (const fi of patch) outFaces.push(mesh.faces[fi]!);
      continue;
    }
    const first = mesh.faces[patch[0]!]!;
    // boundaryLoops orients a loop to FILL a hole (opposite the surrounding
    // faces); the merged face replaces the patch, so it winds the other way
    outFaces.push({ v: [...loops[0]!].reverse(), mat: first.mat ?? 0, smooth: first.smooth ?? 0 });
  }
  for (const f of outFaces) for (const v of f.v) usedByKept.set(v, (usedByKept.get(v) ?? 0) + 1);
  // drop collinear boundary vertices that only ONE face still references
  // (leftover fan-edge endpoints); keep any shared with another face so no
  // T-junction appears
  const cleaned = outFaces.map((f) => {
    if (f.v.length <= 3) return f;
    const keep: number[] = [];
    const n = f.v.length;
    for (let i = 0; i < n; i++) {
      const v = f.v[i]!;
      if ((usedByKept.get(v) ?? 0) > 1) {
        keep.push(v);
        continue;
      }
      const prev = mesh.vertices[f.v[(i - 1 + n) % n]!]!;
      const cur = mesh.vertices[v]!;
      const next = mesh.vertices[f.v[(i + 1) % n]!]!;
      const d1 = normalize(sub(cur, prev));
      const d2 = normalize(sub(next, cur));
      if (length(cross(d1, d2)) < 1e-6 && dot(d1, d2) > 0) continue; // collinear, drop
      keep.push(v);
    }
    return keep.length >= 3 ? { ...f, v: keep } : f;
  });
  return { ...mesh, faces: cleaned };
}

/** Union-find smoothing groups: faces joined by an edge with dihedral angle < `angleDeg` smooth together. */
export function inferSmoothing(mesh: PolyMesh, angleDeg: number): PolyMesh {
  if (angleDeg <= 0) return { ...mesh, faces: mesh.faces.map((f) => ({ ...f, smooth: 0 })) };
  const topo = buildTopology(mesh);
  const cos = Math.cos((angleDeg * Math.PI) / 180);
  const parent = mesh.faces.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  let anySmooth = false;
  for (const [a, b] of topo.edges) {
    const adj = topo.edgeFaces.get(edgeId(a, b)) ?? [];
    if (adj.length !== 2) continue;
    const [f, g] = adj as [number, number];
    const d = dot(topo.faceNormals[f]!, topo.faceNormals[g]!);
    // smooth across gentle bends only; a perfectly flat neighbor gains nothing
    if (d >= cos && d < 0.9999) {
      union(f, g);
      anySmooth = true;
    }
  }
  if (!anySmooth) return { ...mesh, faces: mesh.faces.map((f) => ({ ...f, smooth: 0 })) };
  // number the groups 1.. for roots with more than one member
  const size = new Map<number, number>();
  for (let i = 0; i < mesh.faces.length; i++) size.set(find(i), (size.get(find(i)) ?? 0) + 1);
  const groupOf = new Map<number, number>();
  let next = 1;
  const faces = mesh.faces.map((f, i) => {
    const root = find(i);
    if ((size.get(root) ?? 0) < 2) return { ...f, smooth: 0 };
    let g = groupOf.get(root);
    if (g === undefined) {
      g = next++;
      groupOf.set(root, g);
    }
    return { ...f, smooth: g };
  });
  return { ...mesh, faces };
}

/** Sanity: every face's Newell normal is finite (post-conversion check). */
export function hasValidFaces(mesh: PolyMesh): boolean {
  return mesh.faces.every((f) => {
    const n = polygonNormal(f.v.map((i) => mesh.vertices[i]!));
    return Number.isFinite(n[0]) && (n[0] !== 0 || n[1] !== 0 || n[2] !== 0);
  });
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

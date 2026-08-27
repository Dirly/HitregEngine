import { edgeId, edgeKey, type EdgeKey, type PolyFace, type PolyMesh, type Vec3 } from "./types.js";
import { centroid, cross, dot, normalize, polygonNormal, sub } from "./vec.js";

/**
 * Derived connectivity for a PolyMesh. Built on demand by ops and the editor
 * (never stored — the document stays positions + faces). Cheap for the mesh
 * sizes a level designer hand-edits (hundreds to low thousands of faces).
 */
export interface Topology {
  /** Every distinct undirected edge. */
  edges: EdgeKey[];
  /** edge id -> faces using it (1 = open/boundary edge, 2 = manifold, 3+ = non-manifold). */
  edgeFaces: Map<string, number[]>;
  /** vertex -> faces containing it. */
  vertexFaces: number[][];
  /** vertex -> neighboring vertices (sorted, deduped). */
  vertexNeighbors: number[][];
  /** Per-face unit normal (Newell). */
  faceNormals: Vec3[];
  /** Per-face centroid. */
  faceCenters: Vec3[];
}

export function buildTopology(mesh: PolyMesh): Topology {
  const vertexCount = mesh.vertices.length;
  const edgeFaces = new Map<string, number[]>();
  const edges: EdgeKey[] = [];
  const vertexFaces: number[][] = Array.from({ length: vertexCount }, () => []);
  const neighborSets: Array<Set<number>> = Array.from({ length: vertexCount }, () => new Set());
  const faceNormals: Vec3[] = [];
  const faceCenters: Vec3[] = [];

  mesh.faces.forEach((face, fi) => {
    const n = face.v.length;
    for (let i = 0; i < n; i++) {
      const a = face.v[i]!;
      const b = face.v[(i + 1) % n]!;
      vertexFaces[a]?.push(fi);
      neighborSets[a]?.add(b);
      neighborSets[b]?.add(a);
      const id = edgeId(a, b);
      const list = edgeFaces.get(id);
      if (list) list.push(fi);
      else {
        edgeFaces.set(id, [fi]);
        edges.push(edgeKey(a, b));
      }
    }
    const pts = facePoints(mesh, face);
    faceNormals.push(polygonNormal(pts));
    faceCenters.push(centroid(pts));
  });

  // a vertex used twice by the same face would list it twice — dedupe
  for (const list of vertexFaces) {
    if (list.length > 1) {
      const seen = new Set<number>();
      let w = 0;
      for (const f of list) if (!seen.has(f)) { seen.add(f); list[w++] = f; }
      list.length = w;
    }
  }

  return {
    edges,
    edgeFaces,
    vertexFaces,
    vertexNeighbors: neighborSets.map((s) => [...s].sort((a, b) => a - b)),
    faceNormals,
    faceCenters,
  };
}

export function facePoints(mesh: PolyMesh, face: PolyFace): Vec3[] {
  return face.v.map((i) => mesh.vertices[i] ?? [0, 0, 0]);
}

export function faceNormal(mesh: PolyMesh, face: PolyFace): Vec3 {
  return polygonNormal(facePoints(mesh, face));
}

export function faceCenter(mesh: PolyMesh, face: PolyFace): Vec3 {
  return centroid(facePoints(mesh, face));
}

/** Edges of one face, in winding order. */
export function faceEdges(face: PolyFace): EdgeKey[] {
  const out: EdgeKey[] = [];
  for (let i = 0; i < face.v.length; i++) {
    out.push(edgeKey(face.v[i]!, face.v[(i + 1) % face.v.length]!));
  }
  return out;
}

/** True when the face traverses a->b in that direction (its winding). */
export function faceHasDirectedEdge(face: PolyFace, a: number, b: number): boolean {
  const n = face.v.length;
  for (let i = 0; i < n; i++) {
    if (face.v[i] === a && face.v[(i + 1) % n] === b) return true;
  }
  return false;
}

/** Average of the face normals around a vertex (unweighted), unit length. */
export function vertexNormal(mesh: PolyMesh, topo: Topology, vertex: number): Vec3 {
  const faces = topo.vertexFaces[vertex] ?? [];
  const n: Vec3 = [0, 0, 0];
  for (const f of faces) {
    const fn = topo.faceNormals[f]!;
    n[0] += fn[0];
    n[1] += fn[1];
    n[2] += fn[2];
  }
  return normalize(n);
}

/** Open (boundary) edges: used by exactly one face. */
export function boundaryEdges(topo: Topology): EdgeKey[] {
  return topo.edges.filter((e) => (topo.edgeFaces.get(edgeId(e[0], e[1]))?.length ?? 0) === 1);
}

export function isBoundaryEdge(topo: Topology, a: number, b: number): boolean {
  return (topo.edgeFaces.get(edgeId(a, b))?.length ?? 0) === 1;
}

/**
 * Boundary loops: each open edge chain closed into a cycle, ordered so that
 * walking the loop keeps the mesh on the left when seen from outside (i.e.
 * the loop runs opposite to the adjacent faces' winding along each edge, so
 * a face built directly from the loop faces outward). Chains that don't close
 * are returned as open paths.
 */
export function boundaryLoops(mesh: PolyMesh, topo: Topology): number[][] {
  // directed boundary edges: for the single face using edge (a,b), the face
  // traverses it a->b; the hole boundary traverses it b->a
  const next = new Map<number, number[]>();
  for (const [a, b] of boundaryEdges(topo)) {
    const fi = topo.edgeFaces.get(edgeId(a, b))![0]!;
    const face = mesh.faces[fi]!;
    const from = faceHasDirectedEdge(face, a, b) ? b : a;
    const to = from === a ? b : a;
    const list = next.get(from);
    if (list) list.push(to);
    else next.set(from, [to]);
  }
  const loops: number[][] = [];
  const usedEdge = new Set<string>();
  for (const [start] of next) {
    for (const first of next.get(start) ?? []) {
      const key = `${start}>${first}`;
      if (usedEdge.has(key)) continue;
      const loop = [start];
      let prev = start;
      let cur = first;
      usedEdge.add(key);
      let guard = 0;
      while (cur !== start && guard++ < 100000) {
        loop.push(cur);
        const candidates = (next.get(cur) ?? []).filter((n) => !usedEdge.has(`${cur}>${n}`) && n !== prev);
        const nxt = candidates[0] ?? (next.get(cur) ?? []).find((n) => !usedEdge.has(`${cur}>${n}`));
        if (nxt === undefined) break;
        usedEdge.add(`${cur}>${nxt}`);
        prev = cur;
        cur = nxt;
      }
      loops.push(loop);
    }
  }
  return loops;
}

/**
 * Faces around a vertex in ring (angular) order, walking across shared
 * edges. For a boundary vertex the walk starts at one open edge so the ring
 * is a path rather than a cycle. `closed` reports whether the ring wrapped.
 */
export function faceRingAround(
  mesh: PolyMesh,
  topo: Topology,
  vertex: number,
): { faces: number[]; closed: boolean } {
  const around = topo.vertexFaces[vertex] ?? [];
  if (around.length === 0) return { faces: [], closed: false };
  // for face f at vertex v: the edge leaving v in winding order is (v, next), the one arriving is (prev, v)
  const outgoing = (f: number): number => {
    const face = mesh.faces[f]!;
    const i = face.v.indexOf(vertex);
    return face.v[(i + 1) % face.v.length]!;
  };
  const incoming = (f: number): number => {
    const face = mesh.faces[f]!;
    const i = face.v.indexOf(vertex);
    return face.v[(i - 1 + face.v.length) % face.v.length]!;
  };
  const faceAcross = (f: number, other: number): number | undefined => {
    const list = topo.edgeFaces.get(edgeId(vertex, other)) ?? [];
    return list.find((g) => g !== f && around.includes(g));
  };
  // start: a face whose incoming edge is open (boundary), else any face
  let start = around.find((f) => isBoundaryEdge(topo, vertex, incoming(f))) ?? around[0]!;
  const ring: number[] = [];
  const seen = new Set<number>();
  let cur: number | undefined = start;
  let closed = false;
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    ring.push(cur);
    const nxt = faceAcross(cur, outgoing(cur));
    if (nxt === start) {
      closed = true;
      break;
    }
    cur = nxt;
  }
  // non-manifold leftovers: append any faces the walk never reached
  for (const f of around) if (!seen.has(f)) ring.push(f);
  return { faces: ring, closed };
}

/**
 * Edge loop from a starting edge (ProBuilder "select edge loop"): at each
 * end vertex of valence 4, continue with the edge opposite the current one
 * (the one not sharing a face with it). Stops at poles/boundaries.
 */
export function edgeLoop(mesh: PolyMesh, topo: Topology, start: EdgeKey): EdgeKey[] {
  const result: EdgeKey[] = [start];
  const visited = new Set<string>([edgeId(start[0], start[1])]);
  const extend = (from: number, via: number): void => {
    let prev = via;
    let cur = from;
    let guard = 0;
    while (guard++ < 10000) {
      const neighbors = topo.vertexNeighbors[cur] ?? [];
      if (neighbors.length !== 4) return;
      const sharesFace = (n: number): boolean => {
        const a = topo.edgeFaces.get(edgeId(cur, prev)) ?? [];
        const b = topo.edgeFaces.get(edgeId(cur, n)) ?? [];
        return a.some((f) => b.includes(f));
      };
      const opposite = neighbors.find((n) => n !== prev && !sharesFace(n));
      if (opposite === undefined) return;
      const id = edgeId(cur, opposite);
      if (visited.has(id)) return;
      visited.add(id);
      result.push(edgeKey(cur, opposite));
      prev = cur;
      cur = opposite;
    }
  };
  extend(start[1], start[0]);
  extend(start[0], start[1]);
  return result;
}

/**
 * Edge ring from a starting edge (ProBuilder "select edge ring"): walk across
 * quads to the edge opposite the current one in each face. Stops at non-quads
 * and boundaries.
 */
export function edgeRing(mesh: PolyMesh, topo: Topology, start: EdgeKey): EdgeKey[] {
  const result: EdgeKey[] = [start];
  const visited = new Set<string>([edgeId(start[0], start[1])]);
  const oppositeInQuad = (face: PolyFace, edge: EdgeKey): EdgeKey | null => {
    if (face.v.length !== 4) return null;
    const i = face.v.indexOf(edge[0]);
    const j = face.v.indexOf(edge[1]);
    if (i < 0 || j < 0) return null;
    // the opposite edge is the pair of vertices not in this edge, in order
    const others = face.v.filter((v) => v !== edge[0] && v !== edge[1]);
    if (others.length !== 2) return null;
    return edgeKey(others[0]!, others[1]!);
  };
  const walk = (edge: EdgeKey, exclude: number | null): void => {
    let cur = edge;
    let lastFace = exclude;
    let guard = 0;
    while (guard++ < 10000) {
      const faces = (topo.edgeFaces.get(edgeId(cur[0], cur[1])) ?? []).filter((f) => f !== lastFace);
      if (faces.length !== 1) return;
      const f = faces[0]!;
      const opp = oppositeInQuad(mesh.faces[f]!, cur);
      if (!opp) return;
      const id = edgeId(opp[0], opp[1]);
      if (visited.has(id)) return;
      visited.add(id);
      result.push(opp);
      lastFace = f;
      cur = opp;
    }
  };
  const startFaces = topo.edgeFaces.get(edgeId(start[0], start[1])) ?? [];
  if (startFaces.length >= 1) walk(start, startFaces[1] ?? -1);
  if (startFaces.length >= 2) walk(start, startFaces[0]!);
  return result;
}

/** Faces connected to `faces` through shared edges (one growth step). */
export function growFaces(mesh: PolyMesh, topo: Topology, faces: number[], maxAngleDeg?: number): number[] {
  const set = new Set(faces);
  const cos = maxAngleDeg === undefined ? -2 : Math.cos((maxAngleDeg * Math.PI) / 180);
  for (const fi of faces) {
    const face = mesh.faces[fi]!;
    for (const [a, b] of faceEdges(face)) {
      for (const g of topo.edgeFaces.get(edgeId(a, b)) ?? []) {
        if (set.has(g)) continue;
        if (dot(topo.faceNormals[fi]!, topo.faceNormals[g]!) >= cos) set.add(g);
      }
    }
  }
  return [...set].sort((x, y) => x - y);
}

/** Faces whose every edge-neighbor is also selected (one shrink step). */
export function shrinkFaces(mesh: PolyMesh, topo: Topology, faces: number[]): number[] {
  const set = new Set(faces);
  return faces.filter((fi) => {
    const face = mesh.faces[fi]!;
    return faceEdges(face).every(([a, b]) =>
      (topo.edgeFaces.get(edgeId(a, b)) ?? []).every((g) => set.has(g)),
    );
  });
}

/** All faces reachable from `faces` through shared edges (connected component). */
export function connectedFaces(mesh: PolyMesh, topo: Topology, faces: number[]): number[] {
  const set = new Set(faces);
  const stack = [...faces];
  while (stack.length > 0) {
    const fi = stack.pop()!;
    for (const [a, b] of faceEdges(mesh.faces[fi]!)) {
      for (const g of topo.edgeFaces.get(edgeId(a, b)) ?? []) {
        if (!set.has(g)) {
          set.add(g);
          stack.push(g);
        }
      }
    }
  }
  return [...set].sort((x, y) => x - y);
}

/** Faces connected to `faces` whose normals stay within `angleDeg` of the seed's (flood fill by angle — "select coplanar"). */
export function coplanarFaces(mesh: PolyMesh, topo: Topology, faces: number[], angleDeg = 1): number[] {
  const cos = Math.cos((angleDeg * Math.PI) / 180);
  const set = new Set(faces);
  const stack = faces.map((f) => [f, f] as [number, number]); // [face, seed]
  while (stack.length > 0) {
    const [fi, seed] = stack.pop()!;
    for (const [a, b] of faceEdges(mesh.faces[fi]!)) {
      for (const g of topo.edgeFaces.get(edgeId(a, b)) ?? []) {
        if (set.has(g)) continue;
        if (dot(topo.faceNormals[seed]!, topo.faceNormals[g]!) >= cos) {
          set.add(g);
          stack.push([g, seed]);
        }
      }
    }
  }
  return [...set].sort((x, y) => x - y);
}

/** Vertices that lie on the given faces. */
export function facesVertices(mesh: PolyMesh, faces: number[]): number[] {
  const set = new Set<number>();
  for (const fi of faces) for (const v of mesh.faces[fi]?.v ?? []) set.add(v);
  return [...set].sort((a, b) => a - b);
}

/** Edges of the given faces (deduped). */
export function facesEdges(mesh: PolyMesh, faces: number[]): EdgeKey[] {
  const seen = new Set<string>();
  const out: EdgeKey[] = [];
  for (const fi of faces) {
    for (const e of faceEdges(mesh.faces[fi]!)) {
      const id = edgeId(e[0], e[1]);
      if (!seen.has(id)) {
        seen.add(id);
        out.push(e);
      }
    }
  }
  return out;
}

/** Edges of `faces` used by exactly one of them — the selection's perimeter. */
export function perimeterEdges(mesh: PolyMesh, faces: number[]): EdgeKey[] {
  const counts = new Map<string, { edge: EdgeKey; n: number }>();
  for (const fi of faces) {
    for (const e of faceEdges(mesh.faces[fi]!)) {
      const id = edgeId(e[0], e[1]);
      const entry = counts.get(id);
      if (entry) entry.n++;
      else counts.set(id, { edge: e, n: 1 });
    }
  }
  return [...counts.values()].filter((c) => c.n === 1).map((c) => c.edge);
}

/** Faces touching every selected edge (faces with the edge as one of theirs). */
export function edgesFaces(topo: Topology, edges: EdgeKey[]): number[] {
  const set = new Set<number>();
  for (const [a, b] of edges) for (const f of topo.edgeFaces.get(edgeId(a, b)) ?? []) set.add(f);
  return [...set].sort((x, y) => x - y);
}

/** Direction from `a` to `b`, unit. */
export function edgeDirection(mesh: PolyMesh, a: number, b: number): Vec3 {
  return normalize(sub(mesh.vertices[b]!, mesh.vertices[a]!));
}

/** Outward direction perpendicular to edge (a,b) inside face `fi`'s plane, pointing away from the face. */
export function edgeOutwardInFace(mesh: PolyMesh, topo: Topology, fi: number, a: number, b: number): Vec3 {
  const n = topo.faceNormals[fi]!;
  const d = edgeDirection(mesh, a, b);
  let out = normalize(cross(d, n));
  const mid: Vec3 = [
    (mesh.vertices[a]![0] + mesh.vertices[b]![0]) / 2,
    (mesh.vertices[a]![1] + mesh.vertices[b]![1]) / 2,
    (mesh.vertices[a]![2] + mesh.vertices[b]![2]) / 2,
  ];
  if (dot(out, sub(topo.faceCenters[fi]!, mid)) > 0) out = [-out[0], -out[1], -out[2]];
  return out;
}

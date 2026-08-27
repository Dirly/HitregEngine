import {
  edgeId,
  edgeKey,
  emptySelection,
  type EdgeKey,
  type ElementSelection,
  type PolyFace,
  type PolyMesh,
  type Vec3,
} from "./types.js";
import {
  boundaryLoops,
  buildTopology,
  edgeRing,
  faceEdges,
  faceHasDirectedEdge,
  faceRingAround,
  facesVertices,
  isBoundaryEdge,
  perimeterEdges,
  type Topology,
} from "./topology.js";
import { triangulateFace } from "./compile.js";
import {
  add,
  applyMatrix4,
  centroid,
  cross,
  distance,
  dot,
  lerp,
  length,
  normalize,
  polygonNormal,
  scale,
  sub,
} from "./vec.js";

/**
 * Mesh editing operations. Every op is a pure function: it takes a PolyMesh
 * (never mutated) and returns a new one plus the element selection a user
 * would expect afterwards (ProBuilder convention — extrude selects the new
 * faces, bevel selects the bevel strips, ...). The editor commits the result
 * as a single `set-component` op; the AI can call the same functions from a
 * script or edit the JSON directly.
 *
 * Ops that change geometry drop `generator` (the mesh is no longer the
 * parametric shape); attribute-only ops (material, smoothing, color) keep it.
 */
export interface OpResult {
  mesh: PolyMesh;
  selection: ElementSelection;
}

export type ExtrudeMethod = "vertex-normal" | "face-normal" | "individual";

// ---------------------------------------------------------------- helpers

export function cloneMesh(mesh: PolyMesh): PolyMesh {
  return {
    kind: "poly",
    vertices: mesh.vertices.map((v) => [v[0], v[1], v[2]] as Vec3),
    faces: mesh.faces.map(cloneFace),
    materials: [...mesh.materials],
    ...(mesh.generator ? { generator: { shape: mesh.generator.shape, params: { ...mesh.generator.params } } } : {}),
  };
}

export function cloneFace(face: PolyFace): PolyFace {
  return {
    ...face,
    v: [...face.v],
    ...(face.colors ? { colors: [...face.colors] } : {}),
    ...(face.uv ? { uv: { ...face.uv, ...(face.uv.coords ? { coords: face.uv.coords.map((c) => [c[0], c[1]] as [number, number]) } : {}) } } : {}),
  };
}

/** A geometry change: the parametric origin no longer describes the mesh. */
function edited(mesh: PolyMesh): PolyMesh {
  if (!mesh.generator) return mesh;
  const { generator: _g, ...rest } = mesh;
  return rest;
}

/** Face attributes for a NEW face derived from `from` (material/smoothing carry over; explicit UVs don't). */
function derive(from: PolyFace, v: number[]): PolyFace {
  const face: PolyFace = { v, mat: from.mat ?? 0, smooth: from.smooth ?? 0 };
  if (from.color) face.color = from.color;
  if (from.uv && from.uv.mode !== "manual") face.uv = { ...from.uv };
  return face;
}

/** Keep a face's attributes (incl. manual UVs when the corner count is unchanged) with new vertex ids in the SAME order. */
function remapFace(face: PolyFace, v: number[]): PolyFace {
  const out = cloneFace(face);
  out.v = v;
  if (out.uv?.mode === "manual" && out.uv.coords && out.uv.coords.length !== v.length) {
    out.uv = { ...out.uv, mode: "auto" };
    delete out.uv.coords;
  }
  if (out.colors && out.colors.length !== v.length) delete out.colors;
  return out;
}

/** Drop unused vertices and reindex faces. Also drops degenerate faces (<3 distinct vertices). */
export function compactMesh(mesh: PolyMesh): PolyMesh {
  const used = new Set<number>();
  const faces: PolyFace[] = [];
  for (const face of mesh.faces) {
    const v = dedupeCycle(face.v);
    if (v.length < 3) continue;
    for (const i of v) used.add(i);
    faces.push(v.length === face.v.length ? face : remapFace(face, v));
  }
  const map = new Map<number, number>();
  const vertices: Vec3[] = [];
  for (let i = 0; i < mesh.vertices.length; i++) {
    if (!used.has(i)) continue;
    map.set(i, vertices.length);
    vertices.push(mesh.vertices[i]!);
  }
  return {
    ...mesh,
    vertices,
    faces: faces.map((f) => (f.v.every((i, k) => map.get(i) === i && k >= 0) ? f : { ...f, v: f.v.map((i) => map.get(i)!) })),
  };
}

/** Remove consecutive duplicate vertex ids in a cyclic list. */
function dedupeCycle(v: number[]): number[] {
  const out: number[] = [];
  for (const i of v) if (out[out.length - 1] !== i) out.push(i);
  while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
  return out;
}

/** Flip a new face if its Newell normal opposes `want`. */
function orient(mesh: PolyMesh, face: PolyFace, want: Vec3): PolyFace {
  const n = polygonNormal(face.v.map((i) => mesh.vertices[i]!));
  if (dot(n, want) < 0) {
    face.v.reverse();
    if (face.uv?.coords) face.uv.coords.reverse();
  }
  return face;
}

/** Insert vertex `m` between `a` and `b` in every face that has them as consecutive corners (either direction). Skips faces in `except`. */
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

function rotateToStart(list: number[], start: number): number[] {
  const i = list.indexOf(start);
  return i <= 0 ? [...list] : [...list.slice(i), ...list.slice(0, i)];
}

const selFaces = (faces: number[]): ElementSelection => ({ vertices: [], edges: [], faces });
const selVerts = (vertices: number[]): ElementSelection => ({ vertices, edges: [], faces: [] });
const selEdges = (edges: EdgeKey[]): ElementSelection => ({ vertices: [], edges, faces: [] });

// ---------------------------------------------------------------- transform

/** Move the given vertices through `fn` (position -> position). The generic element transform every gizmo drag ends in. */
export function transformVertices(mesh: PolyMesh, vertices: number[], fn: (p: Vec3, index: number) => Vec3): PolyMesh {
  const out = cloneMesh(mesh);
  for (const i of vertices) {
    const p = out.vertices[i];
    if (p) out.vertices[i] = fn(p, i);
  }
  return edited(out);
}

export function translateVertices(mesh: PolyMesh, vertices: number[], delta: Vec3): PolyMesh {
  return transformVertices(mesh, vertices, (p) => add(p, delta));
}

/** Apply a 4x4 (column-major) to the given vertices. */
export function matrixTransformVertices(mesh: PolyMesh, vertices: number[], matrix: ArrayLike<number>): PolyMesh {
  return transformVertices(mesh, vertices, (p) => applyMatrix4(p, matrix));
}

/** Bake a 4x4 into every vertex (freeze transform). */
export function bakeTransform(mesh: PolyMesh, matrix: ArrayLike<number>): PolyMesh {
  const out = matrixTransformVertices(mesh, mesh.vertices.map((_, i) => i), matrix);
  // a mirrored matrix (negative determinant) flips winding
  const m = matrix;
  const det =
    m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) -
    m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) +
    m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
  if (det < 0) return flipFaces(out, out.faces.map((_, i) => i)).mesh;
  return out;
}

/**
 * Move the mesh so `point` (local space) becomes the origin. Returns the
 * local-space offset the caller must ADD to the entity position (after
 * rotating/scaling it by the entity transform) to keep the mesh in place.
 */
export function setPivot(mesh: PolyMesh, point: Vec3): { mesh: PolyMesh; offset: Vec3 } {
  const out = transformVertices(mesh, mesh.vertices.map((_, i) => i), (p) => sub(p, point));
  return { mesh: out, offset: point };
}

export function bounds(mesh: PolyMesh): { min: Vec3; max: Vec3; center: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of mesh.vertices) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, v[k]!);
      max[k] = Math.max(max[k]!, v[k]!);
    }
  }
  if (mesh.vertices.length === 0) return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0] };
  return { min, max, center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] };
}

/** Pivot to the bounding-box center ("center pivot") or its bottom center ("floor pivot"). */
export function centerPivot(mesh: PolyMesh, mode: "center" | "bottom" = "center"): { mesh: PolyMesh; offset: Vec3 } {
  const b = bounds(mesh);
  return setPivot(mesh, mode === "center" ? b.center : [b.center[0], b.min[1], b.center[2]]);
}

/** Mirror across a local axis plane through the origin; `duplicate` appends the mirrored copy instead of replacing. */
export function mirror(mesh: PolyMesh, axis: "x" | "y" | "z", duplicate = false): OpResult {
  const k = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  const flipped = transformVertices(mesh, mesh.vertices.map((_, i) => i), (p) => {
    const q: Vec3 = [p[0], p[1], p[2]];
    q[k] = -q[k]!;
    return q;
  });
  const reflected = flipFaces(flipped, flipped.faces.map((_, i) => i)).mesh;
  if (!duplicate) return { mesh: reflected, selection: emptySelection() };
  const out = cloneMesh(mesh);
  const base = out.vertices.length;
  out.vertices.push(...reflected.vertices);
  const start = out.faces.length;
  for (const face of reflected.faces) out.faces.push(remapFace(face, face.v.map((i) => i + base)));
  return { mesh: edited(out), selection: selFaces(out.faces.map((_, i) => i).filter((i) => i >= start)) };
}

// ---------------------------------------------------------------- extrude / inset / bevel

/**
 * Extrude faces. "vertex-normal": each moved vertex slides along the average
 * of its selected faces' normals (ProBuilder default); "face-normal": every
 * face keeps its exact shape (shared corners move further, like a real
 * offset surface); "individual": each face extrudes on its own, detached
 * from its neighbors. Selection afterwards = the new cap faces.
 */
export function extrudeFaces(
  mesh: PolyMesh,
  faces: number[],
  distance: number,
  method: ExtrudeMethod = "vertex-normal",
): OpResult {
  if (faces.length === 0) return { mesh, selection: selFaces([]) };
  if (method === "individual") return extrudeIndividual(mesh, faces, distance);
  const topo = buildTopology(mesh);
  const out = cloneMesh(mesh);
  const selected = new Set(faces);
  const verts = facesVertices(mesh, faces);
  const perimeter = perimeterEdges(mesh, faces);
  const perimeterVerts = new Set<number>();
  for (const [a, b] of perimeter) {
    perimeterVerts.add(a);
    perimeterVerts.add(b);
  }
  // a vertex is "interior" when every face around it is selected
  const interior = new Set(verts.filter((v) => (topo.vertexFaces[v] ?? []).every((f) => selected.has(f))));

  const offsets = new Map<number, Vec3>();
  for (const v of verts) {
    const normals = (topo.vertexFaces[v] ?? []).filter((f) => selected.has(f)).map((f) => topo.faceNormals[f]!);
    offsets.set(v, scale(offsetDirection(normals, method), distance));
  }

  // new vertex per moved vertex: interior vertices move in place, perimeter
  // vertices get a duplicate (the original stays with the unselected faces)
  const moved = new Map<number, number>();
  for (const v of verts) {
    const target = add(out.vertices[v]!, offsets.get(v)!);
    if (interior.has(v) && !perimeterVerts.has(v)) {
      out.vertices[v] = target;
      moved.set(v, v);
    } else {
      moved.set(v, out.vertices.length);
      out.vertices.push(target);
    }
  }
  for (const fi of faces) out.faces[fi] = remapFace(out.faces[fi]!, out.faces[fi]!.v.map((v) => moved.get(v)!));

  // side walls along the perimeter, wound to face outward
  const created: number[] = [];
  for (const [a, b] of perimeter) {
    const owner = faces.find((f) => faceEdges(mesh.faces[f]!).some((e) => e[0] === a && e[1] === b))!;
    const src = mesh.faces[owner]!;
    const [p, q] = faceHasDirectedEdge(src, a, b) ? [a, b] : [b, a];
    const side = derive(src, [p, q, moved.get(q)!, moved.get(p)!]);
    delete side.uv;
    side.smooth = 0;
    created.push(out.faces.length);
    out.faces.push(side);
  }
  return { mesh: edited(out), selection: selFaces([...faces]) };
}

function extrudeIndividual(mesh: PolyMesh, faces: number[], distance: number): OpResult {
  const topo = buildTopology(mesh);
  const out = cloneMesh(mesh);
  for (const fi of faces) {
    const face = out.faces[fi]!;
    const n = topo.faceNormals[fi]!;
    const original = [...face.v];
    const lifted = original.map((v) => {
      const idx = out.vertices.length;
      out.vertices.push(add(out.vertices[v]!, scale(n, distance)));
      return idx;
    });
    out.faces[fi] = remapFace(face, lifted);
    for (let i = 0; i < original.length; i++) {
      const j = (i + 1) % original.length;
      const side = derive(face, [original[i]!, original[j]!, lifted[j]!, lifted[i]!]);
      delete side.uv;
      side.smooth = 0;
      out.faces.push(side);
    }
  }
  return { mesh: edited(out), selection: selFaces([...faces]) };
}

/** Direction a shared vertex moves so each adjacent selected face offsets by 1 along its normal. */
function offsetDirection(normals: Vec3[], method: ExtrudeMethod): Vec3 {
  if (normals.length === 0) return [0, 0, 0];
  // dedupe near-parallel normals
  const distinct: Vec3[] = [];
  for (const n of normals) if (!distinct.some((d) => dot(d, n) > 0.9999)) distinct.push(n);
  const avg = normalize(distinct.reduce((s, n) => add(s, n), [0, 0, 0] as Vec3));
  if (method === "vertex-normal" || distinct.length === 1) return avg;
  if (distinct.length === 2) {
    const d = dot(avg, distinct[0]!);
    return Math.abs(d) > 1e-3 ? scale(avg, 1 / d) : avg;
  }
  // 3+: least squares for N·x = 1 for each normal
  const ata = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const atb: Vec3 = [0, 0, 0];
  for (const n of distinct) {
    for (let r = 0; r < 3; r++) {
      atb[r] = (atb[r] ?? 0) + n[r]!;
      for (let c = 0; c < 3; c++) ata[r * 3 + c] = (ata[r * 3 + c] ?? 0) + n[r]! * n[c]!;
    }
  }
  const x = solve3(ata, atb);
  return x && length(x) < 50 ? x : avg;
}

function solve3(m: number[], b: Vec3): Vec3 | null {
  const [a, bb, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-9) return null;
  const inv = [
    (e * i - f * h) / det, (c * h - bb * i) / det, (bb * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (bb * g - a * h) / det, (a * e - bb * d) / det,
  ];
  return [
    inv[0]! * b[0] + inv[1]! * b[1] + inv[2]! * b[2],
    inv[3]! * b[0] + inv[4]! * b[1] + inv[5]! * b[2],
    inv[6]! * b[0] + inv[7]! * b[1] + inv[8]! * b[2],
  ];
}

/**
 * Extrude open (boundary) edges into new quads perpendicular to their face
 * (along the face normal). Consecutive selected edges share their corner
 * vertex so the flaps join. Non-open edges are ignored. Selection = the new
 * far edges, ready to be dragged.
 */
export function extrudeEdges(mesh: PolyMesh, edges: EdgeKey[], distance: number): OpResult {
  const topo = buildTopology(mesh);
  const open = edges.filter((e) => isBoundaryEdge(topo, e[0], e[1]));
  if (open.length === 0) return { mesh, selection: selEdges([]) };
  const out = cloneMesh(mesh);
  const dirs = new Map<number, Vec3[]>();
  for (const [a, b] of open) {
    const fi = topo.edgeFaces.get(edgeId(a, b))![0]!;
    const n = topo.faceNormals[fi]!;
    for (const v of [a, b]) {
      const list = dirs.get(v);
      if (list) list.push(n);
      else dirs.set(v, [n]);
    }
  }
  const lifted = new Map<number, number>();
  for (const [v, normals] of dirs) {
    const dir = normalize(normals.reduce((s, n) => add(s, n), [0, 0, 0] as Vec3));
    lifted.set(v, out.vertices.length);
    out.vertices.push(add(out.vertices[v]!, scale(dir, distance)));
  }
  const newEdges: EdgeKey[] = [];
  for (const [a, b] of open) {
    const fi = topo.edgeFaces.get(edgeId(a, b))![0]!;
    const src = mesh.faces[fi]!;
    const [p, q] = faceHasDirectedEdge(src, a, b) ? [a, b] : [b, a];
    // the new quad traverses the shared edge opposite to the source face
    const quad = derive(src, [q, p, lifted.get(p)!, lifted.get(q)!]);
    delete quad.uv;
    out.faces.push(quad);
    newEdges.push(edgeKey(lifted.get(p)!, lifted.get(q)!));
  }
  return { mesh: edited(out), selection: selEdges(newEdges) };
}

/** Inset every selected face by `amount` (a smaller copy inside, ringed by quads). Selection = the inner faces. */
export function insetFaces(mesh: PolyMesh, faces: number[], amount: number): OpResult {
  const out = cloneMesh(mesh);
  const inner: number[] = [];
  for (const fi of faces) {
    const face = out.faces[fi]!;
    const n = face.v.length;
    const pts = face.v.map((i) => out.vertices[i]!);
    const innerIds = face.v.map((_, i) => {
      const p = pts[i]!;
      const prev = pts[(i - 1 + n) % n]!;
      const next = pts[(i + 1) % n]!;
      const d1 = normalize(sub(next, p));
      const d2 = normalize(sub(prev, p));
      const sinT = length(cross(d1, d2));
      const k = sinT > 1e-6 ? amount / sinT : amount;
      const idx = out.vertices.length;
      out.vertices.push(add(p, scale(add(d1, d2), k)));
      return idx;
    });
    const original = [...face.v];
    out.faces[fi] = remapFace(face, innerIds);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ring = derive(face, [original[i]!, original[j]!, innerIds[j]!, innerIds[i]!]);
      delete ring.uv;
      out.faces.push(ring);
    }
    inner.push(fi);
  }
  return { mesh: edited(out), selection: selFaces(inner) };
}

/**
 * Bevel (chamfer) edges: each edge becomes a flat strip `amount` wide, with
 * corner polygons where beveled edges meet. Boundary edges are skipped.
 * Selection = the new strip + corner faces.
 */
export function bevelEdges(mesh: PolyMesh, edges: EdgeKey[], amount: number): OpResult {
  const topo = buildTopology(mesh);
  const beveled = new Set(
    edges.filter((e) => (topo.edgeFaces.get(edgeId(e[0], e[1]))?.length ?? 0) === 2).map((e) => edgeId(e[0], e[1])),
  );
  if (beveled.size === 0) return { mesh, selection: selFaces([]) };
  const out = cloneMesh(mesh);
  // corner[v][fi] = the new vertex replacing v in face fi
  const corner = new Map<string, number>();
  const touched = new Set<number>();
  for (const id of beveled) {
    const [a, b] = id.split("-").map(Number) as [number, number];
    touched.add(a);
    touched.add(b);
  }
  // edge (v,w) -> shared on-edge vertex for unbeveled edges adjacent to beveled ones
  const onEdge = new Map<string, number>();

  for (const v of touched) {
    for (const fi of topo.vertexFaces[v] ?? []) {
      const face = mesh.faces[fi]!;
      const n = face.v.length;
      const i = face.v.indexOf(v);
      const next = face.v[(i + 1) % n]!;
      const prev = face.v[(i - 1 + n) % n]!;
      const bNext = beveled.has(edgeId(v, next));
      const bPrev = beveled.has(edgeId(v, prev));
      if (!bNext && !bPrev) continue;
      const p = mesh.vertices[v]!;
      const dNext = normalize(sub(mesh.vertices[next]!, p));
      const dPrev = normalize(sub(mesh.vertices[prev]!, p));
      const sinT = Math.max(1e-6, length(cross(dNext, dPrev)));
      let pos: Vec3;
      let shareKey: string | null = null;
      if (bNext && bPrev) pos = add(p, scale(add(dNext, dPrev), amount / sinT));
      else if (bNext) {
        pos = add(p, scale(dPrev, amount / sinT));
        shareKey = edgeId(v, prev);
      } else {
        pos = add(p, scale(dNext, amount / sinT));
        shareKey = edgeId(v, next);
      }
      let idx: number;
      if (shareKey) {
        const key = `${v}|${shareKey}`;
        const existing = onEdge.get(key);
        if (existing !== undefined) {
          idx = existing;
          // average the two faces' estimates so the shared vertex stays on the edge
          out.vertices[idx] = lerp(out.vertices[idx]!, pos, 0.5);
        } else {
          idx = out.vertices.length;
          out.vertices.push(pos);
          onEdge.set(key, idx);
        }
      } else {
        idx = out.vertices.length;
        out.vertices.push(pos);
      }
      corner.set(`${v}|${fi}`, idx);
    }
  }

  // rewrite face corners (manual UV maps keep their corner count, so they survive)
  out.faces.forEach((face, fi) => {
    face.v = face.v.map((v) => corner.get(`${v}|${fi}`) ?? v);
  });
  // a vertex that slid along an unbeveled edge must also be inserted into the
  // faces on the other side of that edge which kept the original corner, or
  // the corner polygon would leave a T-junction there
  for (const [key, idx] of onEdge) {
    const [vs, edge] = key.split("|") as [string, string];
    const v = Number(vs);
    const [ea, eb] = edge.split("-").map(Number) as [number, number];
    insertOnEdge(out.faces, v, ea === v ? eb : ea, idx);
  }

  const created: number[] = [];
  // strip per beveled edge
  for (const id of beveled) {
    const [a, b] = id.split("-").map(Number) as [number, number];
    const [f1, f2] = topo.edgeFaces.get(id)! as [number, number];
    const ca1 = corner.get(`${a}|${f1}`);
    const cb1 = corner.get(`${b}|${f1}`);
    const ca2 = corner.get(`${a}|${f2}`);
    const cb2 = corner.get(`${b}|${f2}`);
    if (ca1 === undefined || cb1 === undefined || ca2 === undefined || cb2 === undefined) continue;
    const strip = derive(mesh.faces[f1]!, dedupeCycle([ca1, cb1, cb2, ca2]));
    delete strip.uv;
    if (strip.v.length < 3) continue;
    orient(out, strip, add(topo.faceNormals[f1]!, topo.faceNormals[f2]!));
    created.push(out.faces.length);
    out.faces.push(strip);
  }
  // corner polygons per touched vertex
  for (const v of touched) {
    const ring = faceRingAround(mesh, topo, v);
    const ids: number[] = [];
    let keepsOriginal = false;
    for (const fi of ring.faces) {
      const c = corner.get(`${v}|${fi}`);
      if (c === undefined) keepsOriginal = true;
      else if (ids[ids.length - 1] !== c) ids.push(c);
    }
    if (ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop();
    const poly = keepsOriginal ? [v, ...ids] : ids;
    if (new Set(poly).size < 3) continue;
    const vn = normalize((topo.vertexFaces[v] ?? []).reduce((s, f) => add(s, topo.faceNormals[f]!), [0, 0, 0] as Vec3));
    const face = derive(mesh.faces[ring.faces[0]!]!, dedupeCycle(poly));
    delete face.uv;
    orient(out, face, vn);
    created.push(out.faces.length);
    out.faces.push(face);
  }
  return { mesh: compactMesh(edited(out)), selection: selFaces(created) };
}

// ---------------------------------------------------------------- subdivide / connect / loops

/** Split each face into quads around a center vertex (edge midpoints shared with neighbors). Selection = all new faces. */
export function subdivideFaces(mesh: PolyMesh, faces: number[]): OpResult {
  const out = cloneMesh(mesh);
  const selected = new Set(faces);
  const midpoints = new Map<string, number>();
  const mid = (a: number, b: number): number => {
    const id = edgeId(a, b);
    const hit = midpoints.get(id);
    if (hit !== undefined) return hit;
    const idx = out.vertices.length;
    out.vertices.push(lerp(out.vertices[a]!, out.vertices[b]!, 0.5));
    midpoints.set(id, idx);
    // unselected neighbors get the midpoint inserted so no T-junction appears
    insertOnEdge(out.faces, a, b, idx, selected);
    return idx;
  };
  const created: number[] = [];
  const replaced: PolyFace[] = [];
  for (const fi of faces) {
    const face = mesh.faces[fi]!;
    const n = face.v.length;
    const center = out.vertices.length;
    out.vertices.push(centroid(face.v.map((i) => out.vertices[i]!)));
    const mids = face.v.map((v, i) => mid(v, face.v[(i + 1) % n]!));
    for (let i = 0; i < n; i++) {
      const q = derive(face, [face.v[i]!, mids[i]!, center, mids[(i - 1 + n) % n]!]);
      replaced.push(q);
    }
  }
  const keep = out.faces.filter((_, i) => !selected.has(i));
  const start = keep.length;
  out.faces = [...keep, ...replaced];
  for (let i = start; i < out.faces.length; i++) created.push(i);
  return { mesh: edited(out), selection: selFaces(created) };
}

/** Insert a vertex at the midpoint of each edge (splitting the edge in every face using it). Selection = the new vertices. */
export function subdivideEdges(mesh: PolyMesh, edges: EdgeKey[], t = 0.5): OpResult {
  const out = cloneMesh(mesh);
  const created: number[] = [];
  for (const [a, b] of edges) {
    const idx = out.vertices.length;
    out.vertices.push(lerp(out.vertices[a]!, out.vertices[b]!, t));
    insertOnEdge(out.faces, a, b, idx);
    created.push(idx);
  }
  return { mesh: edited(out), selection: selVerts(created) };
}

/**
 * Connect edges: in every face touching 2+ selected edges, join their
 * midpoints with new edges (2 → a straight cut; 3+ → spokes from a center
 * vertex). Neighbors get the midpoints inserted. Selection = the new edges.
 */
export function connectEdges(mesh: PolyMesh, edges: EdgeKey[]): OpResult {
  const topo = buildTopology(mesh);
  const out = cloneMesh(mesh);
  const selectedEdge = new Set(edges.map((e) => edgeId(e[0], e[1])));
  const midpoints = new Map<string, number>();
  const affected = new Set<number>();
  for (const id of selectedEdge) for (const f of topo.edgeFaces.get(id) ?? []) affected.add(f);
  const targets = [...affected].filter((fi) => faceEdges(mesh.faces[fi]!).filter((e) => selectedEdge.has(edgeId(e[0], e[1]))).length >= 2);
  const targetSet = new Set(targets);
  const mid = (a: number, b: number): number => {
    const id = edgeId(a, b);
    const hit = midpoints.get(id);
    if (hit !== undefined) return hit;
    const idx = out.vertices.length;
    out.vertices.push(lerp(out.vertices[a]!, out.vertices[b]!, 0.5));
    midpoints.set(id, idx);
    insertOnEdge(out.faces, a, b, idx, targetSet);
    return idx;
  };
  const newFaces: PolyFace[] = [];
  const newEdges: EdgeKey[] = [];
  for (const fi of targets) {
    const face = mesh.faces[fi]!;
    const n = face.v.length;
    // ring with midpoints inserted, marking which are cut points
    const ring: Array<{ v: number; cut: boolean }> = [];
    for (let i = 0; i < n; i++) {
      const a = face.v[i]!;
      const b = face.v[(i + 1) % n]!;
      ring.push({ v: a, cut: false });
      if (selectedEdge.has(edgeId(a, b))) ring.push({ v: mid(a, b), cut: true });
    }
    const cuts = ring.map((r, i) => (r.cut ? i : -1)).filter((i) => i >= 0);
    if (cuts.length === 2) {
      const [i0, i1] = cuts as [number, number];
      const partA = [...ring.slice(i0, i1 + 1)].map((r) => r.v);
      const partB = [...ring.slice(i1), ...ring.slice(0, i0 + 1)].map((r) => r.v);
      newFaces.push(derive(face, partA), derive(face, partB));
      newEdges.push(edgeKey(ring[i0]!.v, ring[i1]!.v));
    } else {
      const center = out.vertices.length;
      out.vertices.push(centroid(face.v.map((i) => out.vertices[i]!)));
      for (let k = 0; k < cuts.length; k++) {
        const i0 = cuts[k]!;
        const i1 = cuts[(k + 1) % cuts.length]!;
        const part = (i1 > i0 ? ring.slice(i0, i1 + 1) : [...ring.slice(i0), ...ring.slice(0, i1 + 1)]).map((r) => r.v);
        newFaces.push(derive(face, [...part, center]));
        newEdges.push(edgeKey(ring[i0]!.v, center));
      }
    }
  }
  const keep = out.faces.filter((_, i) => !targetSet.has(i));
  out.faces = [...keep, ...newFaces];
  return { mesh: edited(out), selection: selEdges(newEdges) };
}

/** Connect vertices: split faces along the chord between 2 selected corners (3+ → spokes from a center). Selection = new edges. */
export function connectVertices(mesh: PolyMesh, vertices: number[]): OpResult {
  const out = cloneMesh(mesh);
  const selected = new Set(vertices);
  const newFaces: PolyFace[] = [];
  const newEdges: EdgeKey[] = [];
  const replaced = new Set<number>();
  mesh.faces.forEach((face, fi) => {
    const n = face.v.length;
    const hits = face.v.map((v, i) => (selected.has(v) ? i : -1)).filter((i) => i >= 0);
    if (hits.length < 2) return;
    if (hits.length === 2) {
      const [i0, i1] = hits as [number, number];
      if ((i1 - i0) % n === 1 || (i0 - i1 + n) % n === 1) return; // adjacent: already an edge
      newFaces.push(derive(face, face.v.slice(i0, i1 + 1)), derive(face, [...face.v.slice(i1), ...face.v.slice(0, i0 + 1)]));
      newEdges.push(edgeKey(face.v[i0]!, face.v[i1]!));
    } else {
      const center = out.vertices.length;
      out.vertices.push(centroid(face.v.map((i) => out.vertices[i]!)));
      for (let k = 0; k < hits.length; k++) {
        const i0 = hits[k]!;
        const i1 = hits[(k + 1) % hits.length]!;
        const part = i1 > i0 ? face.v.slice(i0, i1 + 1) : [...face.v.slice(i0), ...face.v.slice(0, i1 + 1)];
        newFaces.push(derive(face, [...part, center]));
        newEdges.push(edgeKey(face.v[i0]!, center));
      }
    }
    replaced.add(fi);
  });
  if (replaced.size === 0) return { mesh, selection: selEdges([]) };
  out.faces = [...out.faces.filter((_, i) => !replaced.has(i)), ...newFaces];
  return { mesh: edited(out), selection: selEdges(newEdges) };
}

/**
 * Insert an edge loop through the quad ring of `edge`, at fraction `t`
 * along it (measured from the ring's first vertex consistently). Stops at
 * non-quads/boundaries. Selection = the new loop's edges.
 */
export function insertEdgeLoop(mesh: PolyMesh, edge: EdgeKey, t = 0.5): OpResult {
  const topo = buildTopology(mesh);
  const ring = edgeRing(mesh, topo, edge);
  if (ring.length === 0) return { mesh, selection: selEdges([]) };
  // orient ring edges consistently by walking quads: for edge (a,b) in quad
  // [.., a, b, c, d, ..] the opposite is (d, c) with d "beside" a
  const oriented = new Map<string, [number, number]>();
  oriented.set(edgeId(edge[0], edge[1]), [edge[0], edge[1]]);
  const quads = new Set<number>();
  const queue: EdgeKey[] = [edge];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    const [a, b] = oriented.get(edgeId(cur[0], cur[1]))!;
    for (const fi of topo.edgeFaces.get(edgeId(a, b)) ?? []) {
      const face = mesh.faces[fi]!;
      if (face.v.length !== 4 || quads.has(fi)) continue;
      const others = ring.filter((e) => faceEdges(face).some((fe) => fe[0] === e[0] && fe[1] === e[1]) && edgeId(e[0], e[1]) !== edgeId(a, b));
      if (others.length !== 1) continue;
      quads.add(fi);
      const opp = others[0]!;
      if (oriented.has(edgeId(opp[0], opp[1]))) continue;
      // in the quad, a's neighbor that is not b is "beside a"
      const ia = face.v.indexOf(a);
      const ib = face.v.indexOf(b);
      const besideA = face.v[(ia + (ib === (ia + 1) % 4 ? 3 : 1)) % 4]!;
      const besideB = opp[0] === besideA ? opp[1] : opp[0];
      oriented.set(edgeId(opp[0], opp[1]), [besideA, besideB]);
      queue.push(opp);
    }
  }
  const out = cloneMesh(mesh);
  const cut = new Map<string, number>();
  for (const [id, [a, b]] of oriented) {
    const idx = out.vertices.length;
    out.vertices.push(lerp(out.vertices[a]!, out.vertices[b]!, t));
    cut.set(id, idx);
    insertOnEdge(out.faces, a, b, idx, quads);
  }
  const newFaces: PolyFace[] = [];
  const newEdges: EdgeKey[] = [];
  for (const fi of quads) {
    const face = mesh.faces[fi]!;
    const [a, b, c, d] = face.v as [number, number, number, number];
    // find which two edges of this quad are ring edges
    const e = [edgeId(a, b), edgeId(b, c), edgeId(c, d), edgeId(d, a)];
    if (cut.has(e[0]!) && cut.has(e[2]!)) {
      const p = cut.get(e[0]!)!;
      const q = cut.get(e[2]!)!;
      newFaces.push(derive(face, [a, p, q, d]), derive(face, [p, b, c, q]));
      newEdges.push(edgeKey(p, q));
    } else if (cut.has(e[1]!) && cut.has(e[3]!)) {
      const p = cut.get(e[1]!)!;
      const q = cut.get(e[3]!)!;
      newFaces.push(derive(face, [a, b, p, q]), derive(face, [q, p, c, d]));
      newEdges.push(edgeKey(p, q));
    } else {
      newFaces.push(cloneFace(out.faces[fi]!));
    }
  }
  out.faces = [...out.faces.filter((_, i) => !quads.has(i)), ...newFaces];
  return { mesh: edited(out), selection: selEdges(newEdges) };
}

// ---------------------------------------------------------------- delete / merge / split

export function deleteFaces(mesh: PolyMesh, faces: number[]): OpResult {
  const drop = new Set(faces);
  const out = cloneMesh(mesh);
  out.faces = out.faces.filter((_, i) => !drop.has(i));
  return { mesh: compactMesh(edited(out)), selection: emptySelection() };
}

export function deleteVertices(mesh: PolyMesh, vertices: number[]): OpResult {
  const drop = new Set(vertices);
  return deleteFaces(mesh, mesh.faces.map((f, i) => (f.v.some((v) => drop.has(v)) ? i : -1)).filter((i) => i >= 0));
}

export function deleteEdges(mesh: PolyMesh, edges: EdgeKey[]): OpResult {
  const ids = new Set(edges.map((e) => edgeId(e[0], e[1])));
  return deleteFaces(
    mesh,
    mesh.faces.map((f, i) => (faceEdges(f).some((e) => ids.has(edgeId(e[0], e[1]))) ? i : -1)).filter((i) => i >= 0),
  );
}

/** Collapse vertices to one point (their centroid, or the first). Faces that degenerate are removed. Selection = the surviving vertex. */
export function collapseVertices(mesh: PolyMesh, vertices: number[], toFirst = false): OpResult {
  if (vertices.length < 2) return { mesh, selection: selVerts(vertices) };
  const out = cloneMesh(mesh);
  const target = vertices[0]!;
  out.vertices[target] = toFirst ? out.vertices[target]! : centroid(vertices.map((v) => out.vertices[v]!));
  const set = new Set(vertices);
  for (const face of out.faces) face.v = face.v.map((v) => (set.has(v) ? target : v));
  const compacted = compactMesh(edited(out));
  // find the target's new index by position
  const idx = compacted.vertices.findIndex((p) => p === out.vertices[target] || (p[0] === out.vertices[target]![0] && p[1] === out.vertices[target]![1] && p[2] === out.vertices[target]![2]));
  return { mesh: compacted, selection: selVerts(idx >= 0 ? [idx] : []) };
}

/** Weld vertices closer than `maxDistance` to each other (within the given set; empty = all). */
export function weldVertices(mesh: PolyMesh, vertices: number[], maxDistance: number): OpResult {
  const pool = vertices.length > 0 ? vertices : mesh.vertices.map((_, i) => i);
  const out = cloneMesh(mesh);
  const remap = new Map<number, number>();
  const clusters: number[][] = [];
  for (const v of pool) {
    const p = out.vertices[v]!;
    const cluster = clusters.find((c) => distance(out.vertices[c[0]!]!, p) <= maxDistance);
    if (cluster) cluster.push(v);
    else clusters.push([v]);
  }
  for (const c of clusters) {
    if (c.length < 2) continue;
    const target = c[0]!;
    out.vertices[target] = centroid(c.map((v) => out.vertices[v]!));
    for (const v of c) remap.set(v, target);
  }
  for (const face of out.faces) face.v = face.v.map((v) => remap.get(v) ?? v);
  return { mesh: compactMesh(edited(out)), selection: emptySelection() };
}

/** Give every face touching a selected vertex its own copy of it (the opposite of weld). Selection = all the copies. */
export function splitVertices(mesh: PolyMesh, vertices: number[]): OpResult {
  const out = cloneMesh(mesh);
  const created: number[] = [];
  for (const v of vertices) {
    let first = true;
    for (const face of out.faces) {
      const i = face.v.indexOf(v);
      if (i < 0) continue;
      if (first) {
        first = false;
        created.push(v);
        continue;
      }
      const idx = out.vertices.length;
      out.vertices.push([...out.vertices[v]!] as Vec3);
      face.v[i] = idx;
      created.push(idx);
    }
  }
  return { mesh: edited(out), selection: selVerts(created) };
}

/** Detach faces from their neighbors (shared vertices are duplicated) but keep them in this mesh. Selection = the same faces. */
export function detachFaces(mesh: PolyMesh, faces: number[]): OpResult {
  const out = cloneMesh(mesh);
  const selected = new Set(faces);
  const sharedWithOutside = new Set<number>();
  const inside = new Set(facesVertices(mesh, faces));
  mesh.faces.forEach((face, fi) => {
    if (selected.has(fi)) return;
    for (const v of face.v) if (inside.has(v)) sharedWithOutside.add(v);
  });
  const copy = new Map<number, number>();
  for (const v of sharedWithOutside) {
    copy.set(v, out.vertices.length);
    out.vertices.push([...out.vertices[v]!] as Vec3);
  }
  for (const fi of faces) out.faces[fi]!.v = out.faces[fi]!.v.map((v) => copy.get(v) ?? v);
  return { mesh: edited(out), selection: selFaces([...faces]) };
}

/** Split the mesh in two: the selected faces as their own mesh (compacted) and the remainder. Either may be empty (null). */
export function extractFaces(mesh: PolyMesh, faces: number[]): { detached: PolyMesh | null; remainder: PolyMesh | null } {
  const selected = new Set(faces);
  const detachedFaces = mesh.faces.filter((_, i) => selected.has(i));
  const remainderFaces = mesh.faces.filter((_, i) => !selected.has(i));
  const build = (list: PolyFace[]): PolyMesh | null =>
    list.length === 0 ? null : compactMesh(edited({ ...cloneMesh(mesh), faces: list.map(cloneFace) }));
  return { detached: build(detachedFaces), remainder: build(remainderFaces) };
}

/** Duplicate faces in place (new vertices). Selection = the copies. */
export function duplicateFaces(mesh: PolyMesh, faces: number[]): OpResult {
  const out = cloneMesh(mesh);
  const copy = new Map<number, number>();
  const created: number[] = [];
  for (const fi of faces) {
    const face = mesh.faces[fi]!;
    const v = face.v.map((i) => {
      const hit = copy.get(i);
      if (hit !== undefined) return hit;
      const idx = out.vertices.length;
      out.vertices.push([...out.vertices[i]!] as Vec3);
      copy.set(i, idx);
      return idx;
    });
    created.push(out.faces.length);
    out.faces.push(remapFace(face, v));
  }
  return { mesh: edited(out), selection: selFaces(created) };
}

/** Reverse winding (flip normals) of the given faces. Selection unchanged. */
export function flipFaces(mesh: PolyMesh, faces: number[]): OpResult {
  const out = cloneMesh(mesh);
  for (const fi of faces) {
    const face = out.faces[fi];
    if (!face) continue;
    face.v.reverse();
    if (face.uv?.coords) face.uv.coords.reverse();
  }
  return { mesh: out, selection: selFaces([...faces]) };
}

/** Make winding consistent across the selection (majority direction wins per connected patch). */
export function conformNormals(mesh: PolyMesh, faces: number[]): OpResult {
  const topo = buildTopology(mesh);
  const set = new Set(faces.length > 0 ? faces : mesh.faces.map((_, i) => i));
  const visited = new Set<number>();
  const toFlip = new Set<number>();
  for (const seed of set) {
    if (visited.has(seed)) continue;
    // BFS; track the flipped state of each face relative to the seed
    const component: number[] = [seed];
    const flipped = new Set<number>();
    const stack = [seed];
    visited.add(seed);
    while (stack.length > 0) {
      const fi = stack.pop()!;
      const face = mesh.faces[fi]!;
      const flippedHere = flipped.has(fi);
      for (const [a, b] of faceEdges(face)) {
        for (const g of topo.edgeFaces.get(edgeId(a, b)) ?? []) {
          if (g === fi || !set.has(g) || visited.has(g)) continue;
          visited.add(g);
          component.push(g);
          // consistent neighbors traverse the shared edge in opposite directions
          const dirHere = faceHasDirectedEdge(face, a, b) !== flippedHere;
          const dirThere = faceHasDirectedEdge(mesh.faces[g]!, a, b);
          if (dirHere === dirThere) flipped.add(g);
          stack.push(g);
        }
      }
    }
    // the majority orientation of the patch wins (the seed is not special)
    const minority = flipped.size * 2 > component.length ? component.filter((f) => !flipped.has(f)) : [...flipped];
    for (const f of minority) toFlip.add(f);
  }
  return flipFaces(mesh, [...toFlip]);
}

/** Merge edge-connected faces into one n-gon (the union's outer boundary). Faces whose union has holes or several patches are left alone. */
export function mergeFaces(mesh: PolyMesh, faces: number[]): OpResult {
  if (faces.length < 2) return { mesh, selection: selFaces(faces) };
  const sub: PolyMesh = { ...mesh, faces: faces.map((fi) => mesh.faces[fi]!) };
  const topo = buildTopology(sub);
  const loops = boundaryLoops(sub, topo);
  if (loops.length !== 1) return { mesh, selection: selFaces(faces) };
  const out = cloneMesh(mesh);
  const drop = new Set(faces);
  // the loop is oriented to fill a hole (opposite the patch); the merged face
  // REPLACES the patch, so it winds with the patch: reverse it
  const merged = derive(mesh.faces[faces[0]!]!, [...loops[0]!].reverse());
  out.faces = [...out.faces.filter((_, i) => !drop.has(i)), merged];
  const compacted = compactMesh(edited(out));
  return { mesh: compacted, selection: selFaces([compacted.faces.length - 1]) };
}

/** Split n-gons/quads into triangles. Selection = the triangles. */
export function triangulateFaces(mesh: PolyMesh, faces: number[]): OpResult {
  const out = cloneMesh(mesh);
  const drop = new Set(faces);
  const tris: PolyFace[] = [];
  for (const fi of faces) {
    const face = mesh.faces[fi]!;
    if (face.v.length === 3) {
      tris.push(cloneFace(face));
      continue;
    }
    for (const [a, b, c] of triangulateFace(face.v.map((i) => mesh.vertices[i]!))) {
      const t = derive(face, [face.v[a]!, face.v[b]!, face.v[c]!]);
      if (face.uv?.mode === "manual" && face.uv.coords) {
        t.uv = { ...face.uv, coords: [face.uv.coords[a]!, face.uv.coords[b]!, face.uv.coords[c]!].map((x) => [x[0], x[1]] as [number, number]) };
      }
      tris.push(t);
    }
  }
  const keep = out.faces.filter((_, i) => !drop.has(i));
  out.faces = [...keep, ...tris];
  return { mesh: edited(out), selection: selFaces(tris.map((_, i) => keep.length + i)) };
}

/** Bridge two open edges with a quad (endpoints paired to avoid a twist). Selection = the new face. */
export function bridgeEdges(mesh: PolyMesh, a: EdgeKey, b: EdgeKey): OpResult {
  const topo = buildTopology(mesh);
  const fa = topo.edgeFaces.get(edgeId(a[0], a[1])) ?? [];
  const fb = topo.edgeFaces.get(edgeId(b[0], b[1])) ?? [];
  if (fa.length === 0 || fb.length === 0) return { mesh, selection: selEdges([]) };
  const out = cloneMesh(mesh);
  const srcA = mesh.faces[fa[0]!]!;
  // traverse a opposite to its face; then b's endpoints matched by proximity
  const [a0, a1] = faceHasDirectedEdge(srcA, a[0], a[1]) ? [a[1], a[0]] : [a[0], a[1]];
  const straight = distance(mesh.vertices[a1]!, mesh.vertices[b[0]]!) + distance(mesh.vertices[a0]!, mesh.vertices[b[1]]!);
  const crossed = distance(mesh.vertices[a1]!, mesh.vertices[b[1]]!) + distance(mesh.vertices[a0]!, mesh.vertices[b[0]]!);
  const [b0, b1] = straight <= crossed ? [b[0], b[1]] : [b[1], b[0]];
  const quad = derive(srcA, dedupeCycle([a0, a1, b0, b1]));
  delete quad.uv;
  if (quad.v.length < 3) return { mesh, selection: selEdges([]) };
  out.faces.push(quad);
  return { mesh: edited(out), selection: selFaces([out.faces.length - 1]) };
}

/** Fill the boundary loop(s) that contain any of the given vertices/edges (or every hole when nothing is given). Selection = new faces. */
export function fillHoles(mesh: PolyMesh, selection: Partial<ElementSelection> = {}): OpResult {
  const topo = buildTopology(mesh);
  const loops = boundaryLoops(mesh, topo).filter((l) => l.length >= 3);
  const wanted = new Set(selection.vertices ?? []);
  for (const [a, b] of selection.edges ?? []) {
    wanted.add(a);
    wanted.add(b);
  }
  const chosen = wanted.size === 0 ? loops : loops.filter((l) => l.some((v) => wanted.has(v)));
  if (chosen.length === 0) return { mesh, selection: emptySelection() };
  const out = cloneMesh(mesh);
  const created: number[] = [];
  for (const loop of chosen) {
    const neighbor = topo.vertexFaces[loop[0]!]?.[0] ?? 0;
    created.push(out.faces.length);
    out.faces.push(derive(mesh.faces[neighbor]!, loop));
  }
  return { mesh: edited(out), selection: selFaces(created) };
}

/** Rotate the shared edge of two triangles (quad diagonal flip). Selection = the new edge. */
export function flipEdge(mesh: PolyMesh, edge: EdgeKey): OpResult {
  const topo = buildTopology(mesh);
  const faces = topo.edgeFaces.get(edgeId(edge[0], edge[1])) ?? [];
  if (faces.length !== 2) return { mesh, selection: selEdges([edge]) };
  const [f1, f2] = faces as [number, number];
  const t1 = mesh.faces[f1]!;
  const t2 = mesh.faces[f2]!;
  if (t1.v.length !== 3 || t2.v.length !== 3) return { mesh, selection: selEdges([edge]) };
  const [a, b] = faceHasDirectedEdge(t1, edge[0], edge[1]) ? [edge[0], edge[1]] : [edge[1], edge[0]];
  const c = t1.v.find((v) => v !== a && v !== b)!;
  const d = t2.v.find((v) => v !== a && v !== b)!;
  const out = cloneMesh(mesh);
  out.faces[f1] = derive(t1, [c, a, d]);
  out.faces[f2] = derive(t2, [d, b, c]);
  return { mesh: edited(out), selection: selEdges([edgeKey(c, d)]) };
}

// ---------------------------------------------------------------- attributes

export function setFaceMaterial(mesh: PolyMesh, faces: number[], slot: number): PolyMesh {
  const out = cloneMesh(mesh);
  for (const fi of faces) if (out.faces[fi]) out.faces[fi]!.mat = slot;
  return out;
}

export function setSmoothingGroup(mesh: PolyMesh, faces: number[], group: number): PolyMesh {
  const out = cloneMesh(mesh);
  for (const fi of faces) if (out.faces[fi]) out.faces[fi]!.smooth = group;
  return out;
}

export function setFaceColor(mesh: PolyMesh, faces: number[], color: string | null): PolyMesh {
  const out = cloneMesh(mesh);
  for (const fi of faces) {
    const face = out.faces[fi];
    if (!face) continue;
    delete face.colors; // a face-wide paint replaces any per-corner painting
    if (color) face.color = color;
    else delete face.color;
  }
  return out;
}

/** Paint vertices: every face corner using one of `vertices` takes `color` (null clears to the face color). ProBuilder's vertex-mode paint. */
export function setVertexColor(mesh: PolyMesh, vertices: number[], color: string | null): PolyMesh {
  const out = cloneMesh(mesh);
  const set = new Set(vertices);
  for (const face of out.faces) {
    if (!face.v.some((v) => set.has(v))) continue;
    const corners = face.colors && face.colors.length === face.v.length ? face.colors : face.v.map(() => face.color ?? "#ffffff");
    face.colors = corners.map((c, i) => (set.has(face.v[i]!) ? (color ?? face.color ?? "#ffffff") : c));
    if (face.colors.every((c) => c === (face.color ?? "#ffffff"))) delete face.colors;
  }
  return out;
}

/** Lowest unused smoothing group (1..) — "smooth these together". */
export function nextSmoothingGroup(mesh: PolyMesh): number {
  const used = new Set(mesh.faces.map((f) => f.smooth ?? 0));
  let g = 1;
  while (used.has(g)) g++;
  return g;
}

/** Add a material slot (returns its index); reuses an existing slot for the same GUID. */
export function ensureMaterialSlot(mesh: PolyMesh, materialId: string): { mesh: PolyMesh; slot: number } {
  const existing = mesh.materials.indexOf(materialId);
  if (existing >= 0) return { mesh, slot: existing };
  const out = cloneMesh(mesh);
  out.materials.push(materialId);
  return { mesh: out, slot: out.materials.length - 1 };
}

// ---------------------------------------------------------------- selection utilities

/** Vertex set implied by a selection in any mode (faces/edges expand to their vertices). */
export function selectionVertices(mesh: PolyMesh, sel: ElementSelection): number[] {
  const set = new Set(sel.vertices);
  for (const [a, b] of sel.edges) {
    set.add(a);
    set.add(b);
  }
  for (const fi of sel.faces) for (const v of mesh.faces[fi]?.v ?? []) set.add(v);
  return [...set].sort((a, b) => a - b);
}

export function selectionCentroid(mesh: PolyMesh, sel: ElementSelection): Vec3 {
  const verts = selectionVertices(mesh, sel);
  return centroid(verts.map((v) => mesh.vertices[v]!));
}

/** Average normal of the selection (faces' normals, or vertex normals for vertex/edge selections). */
export function selectionNormal(mesh: PolyMesh, sel: ElementSelection, topo: Topology = buildTopology(mesh)): Vec3 {
  const n: Vec3 = [0, 0, 0];
  if (sel.faces.length > 0) {
    for (const fi of sel.faces) {
      const fn = topo.faceNormals[fi];
      if (fn) {
        n[0] += fn[0];
        n[1] += fn[1];
        n[2] += fn[2];
      }
    }
  } else {
    for (const v of selectionVertices(mesh, sel)) {
      for (const fi of topo.vertexFaces[v] ?? []) {
        const fn = topo.faceNormals[fi]!;
        n[0] += fn[0];
        n[1] += fn[1];
        n[2] += fn[2];
      }
    }
  }
  const out = normalize(n);
  return out[0] === 0 && out[1] === 0 && out[2] === 0 ? [0, 1, 0] : out;
}

/** Clamp a selection to what still exists in `mesh` (after undo/redo or an external edit). */
export function sanitizeSelection(mesh: PolyMesh, sel: ElementSelection): ElementSelection {
  const vc = mesh.vertices.length;
  const fc = mesh.faces.length;
  const ids = new Set<string>();
  for (const face of mesh.faces) for (const e of faceEdges(face)) ids.add(edgeId(e[0], e[1]));
  return {
    vertices: sel.vertices.filter((v) => v >= 0 && v < vc),
    edges: sel.edges.filter((e) => ids.has(edgeId(e[0], e[1]))),
    faces: sel.faces.filter((f) => f >= 0 && f < fc),
  };
}

/** Basic structural validation — index bounds and degenerate faces. Returns human-readable issues (empty = ok). */
export function validatePolyMesh(mesh: PolyMesh): string[] {
  const issues: string[] = [];
  const vc = mesh.vertices.length;
  mesh.faces.forEach((face, fi) => {
    if (face.v.length < 3) issues.push(`face ${fi} has fewer than 3 vertices`);
    for (const v of face.v) if (v < 0 || v >= vc) issues.push(`face ${fi} references missing vertex ${v}`);
    if (new Set(face.v).size !== face.v.length) issues.push(`face ${fi} repeats a vertex`);
    if (face.uv?.mode === "manual" && face.uv.coords && face.uv.coords.length !== face.v.length) {
      issues.push(`face ${fi} manual uv has ${face.uv.coords.length} coords for ${face.v.length} corners`);
    }
    if (face.mat !== undefined && face.mat > 0 && face.mat >= Math.max(1, mesh.materials.length)) {
      issues.push(`face ${fi} uses material slot ${face.mat} but only ${mesh.materials.length} slots exist`);
    }
  });
  return issues;
}

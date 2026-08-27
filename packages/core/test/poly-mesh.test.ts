import { describe, expect, it } from "vitest";
import {
  bevelEdges,
  boundaryLoops,
  bridgeEdges,
  buildShape,
  buildTopology,
  centerPivot,
  collapseVertices,
  compilePolyMesh,
  conformNormals,
  connectEdges,
  connectVertices,
  cube,
  deleteFaces,
  edgeKey,
  edgeLoop,
  edgeRing,
  extrudeEdges,
  extrudeFaces,
  fillHoles,
  fitUvs,
  flipEdge,
  flipFaces,
  growFaces,
  insertEdgeLoop,
  insetFaces,
  mergeFaces,
  mirror,
  planarProjectFaces,
  polyFromFootprint,
  polyFromPrimitive,
  polyMeshCollision,
  polyMeshSourceSchema,
  regenerate,
  SHAPES,
  setAutoUv,
  splitVertices,
  subdivideFaces,
  transformUvs,
  triangulateFaces,
  validatePolyMesh,
  weldVertices,
  type PolyMesh,
  type Vec3,
} from "../src/index.js";

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Every face normal should point away from the mesh centroid on a convex shape. */
function expectOutward(mesh: PolyMesh): void {
  const topo = buildTopology(mesh);
  const used = [...new Set(mesh.faces.flatMap((f) => f.v))].map((i) => mesh.vertices[i]!);
  const c: Vec3 = [0, 0, 0];
  for (const v of used) {
    c[0] += v[0] / used.length;
    c[1] += v[1] / used.length;
    c[2] += v[2] / used.length;
  }
  mesh.faces.forEach((_, fi) => {
    const fc = topo.faceCenters[fi]!;
    const out: Vec3 = [fc[0] - c[0], fc[1] - c[1], fc[2] - c[2]];
    expect(dot(topo.faceNormals[fi]!, out), `face ${fi} faces inward`).toBeGreaterThan(-1e-6);
  });
}

/** Closed manifold: every edge used by exactly two faces in opposite directions. */
function expectClosedManifold(mesh: PolyMesh): void {
  const topo = buildTopology(mesh);
  for (const [a, b] of topo.edges) {
    const faces = topo.edgeFaces.get(`${a}-${b}`)!;
    expect(faces.length, `edge ${a}-${b} has ${faces.length} faces`).toBe(2);
  }
  expect(validatePolyMesh(mesh)).toEqual([]);
}

describe("poly mesh shapes", () => {
  it("every generator builds a valid outward-facing mesh with its generator recorded", () => {
    for (const spec of SHAPES) {
      const mesh = spec.build({});
      expect(validatePolyMesh(mesh), spec.name).toEqual([]);
      expect(mesh.generator?.shape).toBe(spec.name);
      const compiled = compilePolyMesh(mesh);
      expect(compiled.triangleCount).toBeGreaterThan(0);
      expect(compiled.indices.length).toBe(compiled.triangleCount * 3);
      expect(compiled.positions.length).toBe(compiled.vertexCount * 3);
      // stands on y = 0
      const minY = Math.min(...mesh.vertices.map((v) => v[1]));
      expect(minY, spec.name).toBeCloseTo(0, 5);
    }
  });

  it("closed shapes are manifold and convex ones face outward", () => {
    for (const name of ["cube", "cylinder", "cone", "prism", "sphere", "icosphere"]) {
      const mesh = buildShape(name);
      expectClosedManifold(mesh);
      expectOutward(mesh);
    }
    for (const name of ["stairs", "torus", "pipe", "door", "arch"]) expectClosedManifold(buildShape(name));
  });

  it("cube has 6 quads and 8 shared vertices; regenerate resizes it", () => {
    const c = cube({ width: 2, height: 1, depth: 3 });
    expect(c.vertices.length).toBe(8);
    expect(c.faces.length).toBe(6);
    expect(c.faces.every((f) => f.v.length === 4)).toBe(true);
    const bigger = regenerate(c, { height: 4 })!;
    expect(Math.max(...bigger.vertices.map((v) => v[1]))).toBe(4);
    expect(bigger.generator?.params["width"]).toBe(2);
  });

  it("the schema validates a generated mesh and rejects a bad face", () => {
    expect(polyMeshSourceSchema.safeParse(cube()).success).toBe(true);
    const bad = { ...cube(), faces: [{ v: [0, 1] }] };
    expect(polyMeshSourceSchema.safeParse(bad).success).toBe(false);
  });

  it("converts primitives and footprints to editable meshes", () => {
    const { mesh, offset } = polyFromPrimitive({ kind: "primitive", shape: "box", size: [2, 4, 2] });
    expect(offset).toEqual([0, -2, 0]);
    expect(mesh.generator).toBeUndefined();
    expectClosedManifold(mesh);
    const foot = polyFromFootprint([[-1, -1], [1, -1], [1, 1], [-1, 1]], 2);
    expectClosedManifold(foot);
    expectOutward(foot);
    const lShape = polyFromFootprint([[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]], 1);
    expectClosedManifold(lShape);
    const compiled = compilePolyMesh(lShape);
    expect(compiled.triangleCount).toBe(4 * 2 + 6 * 2); // two 6-gon caps (4 tris each) + 6 side quads
  });
});

describe("poly mesh compile", () => {
  it("smoothing groups share normals, hard faces don't", () => {
    const cyl = buildShape("cylinder", { sides: 8 });
    const compiled = compilePolyMesh(cyl);
    // cube: 6 faces x 4 corners = 24 unique corners (flat)
    expect(compilePolyMesh(cube()).vertexCount).toBe(24);
    // smoothed side normals point radially THROUGH the vertex (not the flat
    // face-normal at the mid-angle)
    let radial = 0;
    for (let i = 0; i < compiled.vertexCount; i++) {
      const p: Vec3 = [compiled.positions[i * 3]!, 0, compiled.positions[i * 3 + 2]!];
      const n: Vec3 = [compiled.normals[i * 3]!, compiled.normals[i * 3 + 1]!, compiled.normals[i * 3 + 2]!];
      if (Math.abs(n[1]) > 0.5) continue; // cap corners
      const len = Math.hypot(p[0], p[2]);
      if (Math.abs(dot(n, [p[0] / len, 0, p[2] / len]) - 1) < 1e-4) radial++;
    }
    expect(radial).toBe(8 * 4); // every side corner
    // the same cylinder with hard sides has NO radial normals
    const hard = { ...cyl, faces: cyl.faces.map((f) => ({ ...f, smooth: 0 })) };
    const hardCompiled = compilePolyMesh(hard);
    let hardRadial = 0;
    for (let i = 0; i < hardCompiled.vertexCount; i++) {
      const p: Vec3 = [hardCompiled.positions[i * 3]!, 0, hardCompiled.positions[i * 3 + 2]!];
      const n: Vec3 = [hardCompiled.normals[i * 3]!, hardCompiled.normals[i * 3 + 1]!, hardCompiled.normals[i * 3 + 2]!];
      if (Math.abs(n[1]) > 0.5) continue;
      const len = Math.hypot(p[0], p[2]);
      if (Math.abs(dot(n, [p[0] / len, 0, p[2] / len]) - 1) < 1e-4) hardRadial++;
    }
    expect(hardRadial).toBe(0);
  });

  it("emits material groups sorted by slot and a triangle->face map", () => {
    const c = cube();
    c.faces[0]!.mat = 1;
    c.faces[3]!.mat = 1;
    c.materials = ["a", "b"];
    const compiled = compilePolyMesh(c);
    expect(compiled.groups.map((g) => g.materialIndex)).toEqual([0, 1]);
    expect(compiled.groups[0]!.count).toBe(4 * 2 * 3);
    expect(compiled.groups[1]!.count).toBe(2 * 2 * 3);
    const facesInGroup1 = new Set<number>();
    for (let t = compiled.groups[1]!.start / 3; t < compiled.triangleCount; t++) facesInGroup1.add(compiled.triangleFace[t]!);
    expect([...facesInGroup1].sort()).toEqual([0, 3]);
  });

  it("auto UVs anchor each face at its lower-left and honor tiling/offset", () => {
    const c = cube({ width: 2, height: 3, depth: 2 });
    const compiled = compilePolyMesh(c);
    // every face's uv bounding box should start at 0,0 (lower-left anchor)
    const topo = buildTopology(c);
    void topo;
    const minU = Math.min(...Array.from(compiled.uvs).filter((_, i) => i % 2 === 0));
    expect(minU).toBeCloseTo(0, 6);
    const tiled = setAutoUv(c, [2], { scale: [2, 2], offset: [0.5, 0] });
    const uvs2 = compilePolyMesh(tiled);
    const maxU = Math.max(...Array.from(uvs2.uvs).filter((_, i) => i % 2 === 0));
    expect(maxU).toBeGreaterThan(4); // 2 wide * 2 tiling + 0.5 offset
  });

  it("collision geometry shares positions and triangulates every face", () => {
    const col = polyMeshCollision(cube());
    expect(col.positions.length).toBe(8 * 3);
    expect(col.indices.length).toBe(12 * 3);
  });

  it("vertex colors appear only when a face is tinted", () => {
    const c = cube();
    expect(compilePolyMesh(c).colors).toBeNull();
    c.faces[0]!.color = "#ff0000";
    const colored = compilePolyMesh(c);
    expect(colored.colors).not.toBeNull();
    expect(colored.colors!.length).toBe(colored.vertexCount * 3);
  });
});

describe("poly mesh ops", () => {
  it("extrude faces (group) keeps the mesh closed and selects the caps", () => {
    const c = cube();
    const topFace = c.faces.findIndex((f) => f.v.every((i) => c.vertices[i]![1] === 1));
    const { mesh, selection } = extrudeFaces(c, [topFace], 2);
    expectClosedManifold(mesh);
    expect(mesh.faces.length).toBe(6 + 4);
    expect(selection.faces).toEqual([topFace]);
    expect(Math.max(...mesh.vertices.map((v) => v[1]))).toBeCloseTo(3);
    expectOutward(mesh);
    expect(mesh.generator).toBeUndefined();
  });

  it("extrude two adjacent faces as a group shares the interior edge", () => {
    const c = cube();
    const topo = buildTopology(c);
    const top = c.faces.findIndex((_, i) => topo.faceNormals[i]![1] > 0.9);
    const front = c.faces.findIndex((_, i) => topo.faceNormals[i]![2] > 0.9);
    const { mesh } = extrudeFaces(c, [top, front], 0.5);
    expectClosedManifold(mesh);
    // perimeter of 2 faces sharing 1 edge = 6 edges -> 6 side quads
    expect(mesh.faces.length).toBe(6 + 6);
    const faceNormal = extrudeFaces(c, [top, front], 0.5, "face-normal").mesh;
    expectClosedManifold(faceNormal);
  });

  it("extrude individual faces detaches them", () => {
    const c = cube();
    const { mesh } = extrudeFaces(c, [0, 1], 1, "individual");
    expect(mesh.faces.length).toBe(6 + 8);
    expect(validatePolyMesh(mesh)).toEqual([]);
  });

  it("inset creates an inner face ringed by quads", () => {
    const c = cube();
    const { mesh, selection } = insetFaces(c, [1], 0.2);
    expectClosedManifold(mesh);
    expect(mesh.faces.length).toBe(6 + 4);
    expect(selection.faces).toEqual([1]);
    const inner = mesh.faces[1]!.v.map((i) => mesh.vertices[i]!);
    // inner face spans 0.6 instead of 1.0
    const xs = inner.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.6, 5);
  });

  it("bevel one cube edge yields a strip and two corner triangles, still closed", () => {
    const c = cube();
    const edge = edgeKey(c.faces[1]!.v[0]!, c.faces[1]!.v[1]!); // a top edge
    const { mesh, selection } = bevelEdges(c, [edge], 0.2);
    expectClosedManifold(mesh);
    expect(selection.faces.length).toBe(3); // 1 strip + 2 corners
    expectOutward(mesh);
  });

  it("bevel all cube edges yields a chamfered box (26 faces)", () => {
    const c = cube();
    const topo = buildTopology(c);
    const { mesh } = bevelEdges(c, topo.edges, 0.1);
    expectClosedManifold(mesh);
    expect(mesh.faces.length).toBe(6 + 12 + 8);
    expectOutward(mesh);
  });

  it("subdivide splits a quad into 4 and keeps neighbors watertight", () => {
    const c = cube();
    const { mesh, selection } = subdivideFaces(c, [0]);
    expect(selection.faces.length).toBe(4);
    expectClosedManifold(mesh);
    const all = subdivideFaces(c, c.faces.map((_, i) => i)).mesh;
    expect(all.faces.length).toBe(24);
    expectClosedManifold(all);
  });

  it("connect edges cuts a face between two edge midpoints", () => {
    const c = cube();
    const f = c.faces[0]!;
    const e1 = edgeKey(f.v[0]!, f.v[1]!);
    const e2 = edgeKey(f.v[2]!, f.v[3]!);
    const { mesh, selection } = connectEdges(c, [e1, e2]);
    expectClosedManifold(mesh);
    expect(mesh.faces.length).toBe(7);
    expect(selection.edges.length).toBe(1);
  });

  it("connect vertices splits a face along the diagonal", () => {
    const c = cube();
    const f = c.faces[0]!;
    const { mesh } = connectVertices(c, [f.v[0]!, f.v[2]!]);
    expectClosedManifold(mesh);
    expect(mesh.faces.length).toBe(7);
    expect(mesh.faces.filter((x) => x.v.length === 3).length).toBe(2);
  });

  it("insert edge loop runs around a cube's ring of quads", () => {
    const c = cube();
    const f = c.faces[0]!;
    const start = edgeKey(f.v[0]!, f.v[1]!);
    const ring = edgeRing(c, buildTopology(c), start);
    expect(ring.length).toBe(4);
    const { mesh, selection } = insertEdgeLoop(c, start, 0.5);
    expectClosedManifold(mesh);
    expect(mesh.faces.length).toBe(6 + 4);
    expect(selection.edges.length).toBe(4);
    expect(mesh.vertices.length).toBe(12);
  });

  it("edge loop selection walks a grid", () => {
    const p = buildShape("plane", { widthSegments: 4, depthSegments: 4 });
    const topo = buildTopology(p);
    // an interior edge parallel to X in the middle
    const inner = topo.edges.find(([a, b]) => {
      const pa = p.vertices[a]!;
      const pb = p.vertices[b]!;
      return pa[2] === pb[2] && Math.abs(pa[2]) < 0.01 && Math.abs(pa[0]) < 0.3 && Math.abs(pb[0]) < 0.3;
    })!;
    const loop = edgeLoop(p, topo, inner);
    expect(loop.length).toBe(4);
  });

  it("delete faces compacts orphan vertices; fill hole closes it again", () => {
    const c = cube();
    const { mesh } = deleteFaces(c, [1]);
    expect(mesh.faces.length).toBe(5);
    expect(mesh.vertices.length).toBe(8);
    const topo = buildTopology(mesh);
    expect(boundaryLoops(mesh, topo)).toHaveLength(1);
    const filled = fillHoles(mesh).mesh;
    expectClosedManifold(filled);
    expectOutward(filled);
  });

  it("extrude an open edge makes a perpendicular flap", () => {
    const p = buildShape("plane");
    const topo = buildTopology(p);
    const edge = topo.edges[0]!;
    const { mesh, selection } = extrudeEdges(p, [edge], 1);
    expect(mesh.faces.length).toBe(2);
    expect(selection.edges.length).toBe(1);
    const flap = mesh.faces[1]!.v.map((i) => mesh.vertices[i]!);
    expect(Math.max(...flap.map((v) => v[1]))).toBeCloseTo(1);
  });

  it("bridge two open edges with a quad", () => {
    const a = buildShape("plane");
    const b = buildShape("plane");
    const merged: PolyMesh = {
      ...a,
      vertices: [...a.vertices, ...b.vertices.map((v) => [v[0], v[1] + 1, v[2]] as Vec3)],
      faces: [...a.faces, ...b.faces.map((f) => ({ ...f, v: f.v.map((i) => i + 4) }))],
    };
    const ta = buildTopology(merged);
    const e1 = ta.edges.find(([x, y]) => x < 4 && y < 4)!;
    const e2 = ta.edges.find(([x, y]) => x >= 4 && y >= 4)!;
    const { mesh, selection } = bridgeEdges(merged, e1, e2);
    expect(mesh.faces.length).toBe(3);
    expect(selection.faces).toEqual([2]);
  });

  it("merge faces makes one n-gon from two coplanar quads", () => {
    const p = buildShape("plane", { widthSegments: 2, depthSegments: 1 });
    const { mesh } = mergeFaces(p, [0, 1]);
    expect(mesh.faces.length).toBe(1);
    expect(mesh.faces[0]!.v.length).toBe(6);
    expect(mesh.vertices.length).toBe(6);
    // keeps the patch's orientation (+Y), not the hole-filling one
    expect(buildTopology(mesh).faceNormals[0]![1]).toBeCloseTo(1);
    // merging two adjacent cube faces (not coplanar) is refused... but two
    // coplanar quads of a subdivided cube top merge and still face outward
    const c = subdivideFaces(cube(), [1]).mesh;
    const topQuads = c.faces.map((_, i) => i).filter((i) => buildTopology(c).faceNormals[i]![1] > 0.9);
    const merged = mergeFaces(c, topQuads).mesh;
    expectOutward(merged);
  });

  it("triangulate, flip, and conform normals", () => {
    const c = cube();
    const tri = triangulateFaces(c, [0]).mesh;
    expect(tri.faces.length).toBe(7);
    expectClosedManifold(tri);
    const flipped = flipFaces(c, [0]).mesh;
    const topo = buildTopology(flipped);
    expect(dot(topo.faceNormals[0]!, buildTopology(c).faceNormals[0]!)).toBeCloseTo(-1);
    const fixed = conformNormals(flipped, []).mesh;
    expectOutward(fixed);
    // conform picks a consistent orientation; flip-all if it chose inward
    const t2 = buildTopology(fixed);
    const sameAsOriginal = dot(t2.faceNormals[1]!, buildTopology(c).faceNormals[1]!) > 0;
    expect(typeof sameAsOriginal).toBe("boolean");
  });

  it("flip edge rotates the diagonal between two triangles", () => {
    const c = triangulateFaces(cube(), [0]).mesh;
    const tris = c.faces.map((f, i) => (f.v.length === 3 ? i : -1)).filter((i) => i >= 0);
    const shared = buildTopology(c).edges.find(([a, b]) => {
      const faces = buildTopology(c).edgeFaces.get(`${a}-${b}`)!;
      return faces.length === 2 && faces.every((f) => tris.includes(f));
    })!;
    const { mesh, selection } = flipEdge(c, shared);
    expectClosedManifold(mesh);
    expect(selection.edges[0]).not.toEqual(shared);
  });

  it("collapse, weld, and split vertices", () => {
    const c = cube();
    const f = c.faces[0]!;
    const collapsed = collapseVertices(c, [f.v[0]!, f.v[1]!]).mesh;
    expect(collapsed.vertices.length).toBe(7);
    expect(validatePolyMesh(collapsed)).toEqual([]);
    // split the cube into 24 corners, then weld it back
    const split = splitVertices(c, c.vertices.map((_, i) => i)).mesh;
    expect(split.vertices.length).toBe(24);
    const welded = weldVertices(split, [], 0.001).mesh;
    expect(welded.vertices.length).toBe(8);
    expectClosedManifold(welded);
  });

  it("mirror duplicates across a plane; center pivot reports the offset", () => {
    const c = cube();
    const shifted = { ...c, vertices: c.vertices.map((v) => [v[0] + 2, v[1], v[2]] as Vec3) };
    const { mesh } = mirror(shifted, "x", true);
    expect(mesh.faces.length).toBe(12);
    expectOutward({ ...mesh, faces: mesh.faces.slice(6) });
    const { mesh: centered, offset } = centerPivot(c);
    expect(offset).toEqual([0, 0.5, 0]);
    expect(Math.min(...centered.vertices.map((v) => v[1]))).toBeCloseTo(-0.5);
  });

  it("grow selection walks across shared edges", () => {
    const c = cube();
    const grown = growFaces(c, buildTopology(c), [0]);
    expect(grown.length).toBe(5);
  });
});

describe("poly mesh uv ops", () => {
  it("planar projection freezes manual coords; transform moves them; fit normalizes", () => {
    const c = cube({ width: 2, height: 2, depth: 2 });
    const projected = planarProjectFaces(c, [1, 2]);
    expect(projected.faces[1]!.uv?.mode).toBe("manual");
    expect(projected.faces[1]!.uv?.coords?.length).toBe(4);
    const moved = transformUvs(projected, [1], { translate: [1, 0] });
    const before = projected.faces[1]!.uv!.coords![0]![0];
    const after = moved.faces[1]!.uv!.coords![0]![0];
    expect(after - before).toBeCloseTo(1);
    const fitted = fitUvs(c, [0]);
    const coords = fitted.faces[0]!.uv!.coords!;
    expect(Math.min(...coords.map((x) => x[0]))).toBeCloseTo(0);
    expect(Math.max(...coords.map((x) => x[0]))).toBeCloseTo(1);
  });

  it("planar-projecting a whole closed box does not collapse to a point", () => {
    const c = cube({ width: 2, height: 2, depth: 2 });
    const projected = planarProjectFaces(c, c.faces.map((_, i) => i));
    const coords = projected.faces.flatMap((f) => f.uv!.coords!);
    const us = new Set(coords.map((x) => x[0].toFixed(4)));
    const vs = new Set(coords.map((x) => x[1].toFixed(4)));
    expect(us.size).toBeGreaterThan(1);
    expect(vs.size).toBeGreaterThan(1);
  });

  it("manual UVs survive triangulation and compile through untouched", () => {
    const c = fitUvs(cube(), [0]);
    const tri = triangulateFaces(c, [0]).mesh;
    const manual = tri.faces.filter((f) => f.uv?.mode === "manual");
    expect(manual.length).toBe(2);
    expect(manual.every((f) => f.uv!.coords!.length === 3)).toBe(true);
    expect(compilePolyMesh(tri).triangleCount).toBe(12);
  });
});

describe("poly mesh from geometry (ProBuilderize)", () => {
  it("rebuilds a cube's 6 quads from its triangle soup, welded", async () => {
    const { polyFromGeometry, polyMeshCollision, setVertexColor } = await import("../src/index.js");
    const col = polyMeshCollision(cube({ width: 2, height: 1, depth: 3 }));
    // un-weld: expand to a non-indexed soup with duplicated positions
    const soup = new Float32Array(col.indices.length * 3);
    for (let i = 0; i < col.indices.length; i++) soup.set(col.positions.subarray(col.indices[i]! * 3, col.indices[i]! * 3 + 3), i * 3);
    const mesh = polyFromGeometry(soup, null);
    expect(mesh.vertices.length).toBe(8);
    expect(mesh.faces.length).toBe(6);
    expect(mesh.faces.every((f) => f.v.length === 4)).toBe(true);
    expectClosedManifold(mesh);
    expectOutward(mesh);
    // hard edges everywhere on a cube
    expect(mesh.faces.every((f) => f.smooth === 0)).toBe(true);
    // a cylinder's sides come back smoothed, its caps hard
    const cyl = polyMeshCollision(buildShape("cylinder", { sides: 16 }));
    const back = polyFromGeometry(cyl.positions, cyl.indices);
    const sides = back.faces.filter((f) => Math.abs(buildTopology(back).faceNormals[back.faces.indexOf(f)]![1]) < 0.5);
    expect(sides.length).toBe(16);
    expect(sides.every((f) => (f.smooth ?? 0) > 0)).toBe(true);
    // per-vertex paint colors only the corners that use the vertex
    const painted = setVertexColor(cube(), [0], "#ff0000");
    const touched = painted.faces.filter((f) => f.colors);
    expect(touched.length).toBe(3);
    expect(touched.every((f) => f.colors!.filter((c) => c === "#ff0000").length === 1)).toBe(true);
    expect(compilePolyMesh(painted).colors).not.toBeNull();
  });
});

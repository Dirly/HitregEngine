import { describe, expect, it } from "vitest";
import {
  buildTopology,
  compilePolyMesh,
  cube,
  plane,
  polyMeshSourceSchema,
  validatePolyMesh,
  type PolyMesh,
  type PrimitiveSource,
  type Vec3,
} from "../src/index.js";
import { weatherFaces, weatheredBoxSource } from "../src/poly-mesh/weather.js";
import { paintGrime, type GrimeRule } from "../src/poly-mesh/tint.js";

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function faceByNormal(mesh: PolyMesh, normal: Vec3): number {
  const topo = buildTopology(mesh);
  const i = topo.faceNormals.findIndex((n) => dot(n, normal) > 0.999);
  expect(i).toBeGreaterThanOrEqual(0);
  return i;
}

const sameVec = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** The per-corner (or flat) tint of the corner of `face` sitting at position `at`. */
function cornerColor(mesh: PolyMesh, fi: number, at: Vec3): string {
  const face = mesh.faces[fi]!;
  const ci = face.v.findIndex((v) => sameVec(mesh.vertices[v]!, at));
  expect(ci).toBeGreaterThanOrEqual(0);
  return face.colors?.[ci] ?? face.color ?? "#ffffff";
}

const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);

describe("weatherFaces", () => {
  it("pins every original vertex and every selection-boundary midpoint exactly", () => {
    const base = cube();
    const front = faceByNormal(base, [0, 0, 1]);
    const flat = weatherFaces(base, { faces: [front], amplitude: 0, seed: 1 });

    // subdividing one quad: 8 original + 4 edge midpoints + 1 center
    expect(flat.vertices.length).toBe(13);
    expect(flat.faces.length).toBe(9); // 5 untouched + 4 new quads

    // the front face's exact edge midpoints, computed from the ORIGINAL corners
    const corners = base.faces[front]!.v.map((v) => base.vertices[v]!);
    const expectedMids = corners.map((c, i) => {
      const n = corners[(i + 1) % corners.length]!;
      return [(c[0] + n[0]) / 2, (c[1] + n[1]) / 2, (c[2] + n[2]) / 2] as Vec3;
    });

    let movedSomewhere = false;
    for (let seed = 1; seed <= 8; seed++) {
      const m = weatherFaces(base, { faces: [front], amplitude: 0.25, seed });
      expect(m.vertices.length).toBe(13);

      // every original vertex byte-identical
      for (let i = 0; i < base.vertices.length; i++) {
        expect(m.vertices[i]).toEqual(base.vertices[i]);
      }
      // every boundary midpoint present, byte-identical to the exact lerp
      for (const mid of expectedMids) {
        expect(m.vertices.some((v) => sameVec(v, mid))).toBe(true);
      }
      // the ONLY vertex allowed to differ from the amplitude-0 mesh is the face center
      const moved: number[] = [];
      for (let i = 0; i < m.vertices.length; i++) {
        if (!sameVec(m.vertices[i]!, flat.vertices[i]!)) moved.push(i);
      }
      expect(moved.length).toBeLessThanOrEqual(1);
      for (const i of moved) {
        expect(i).toBeGreaterThanOrEqual(base.vertices.length);
        expect(expectedMids.some((mid) => sameVec(flat.vertices[i]!, mid))).toBe(false);
        movedSomewhere = true;
      }
    }
    expect(movedSomewhere).toBe(true);
  });

  it("is deterministic per seed and differs across seeds", () => {
    const a = weatherFaces(cube(), { amplitude: 0.1, subdivisions: 2, seed: 42 });
    const b = weatherFaces(cube(), { amplitude: 0.1, subdivisions: 2, seed: 42 });
    expect(b).toEqual(a);
    const c = weatherFaces(cube(), { amplitude: 0.1, subdivisions: 2, seed: 43 });
    expect(JSON.stringify(c.vertices)).not.toEqual(JSON.stringify(a.vertices));
  });

  it("does not mutate the input mesh", () => {
    const base = cube();
    const snapshot = JSON.stringify(base);
    weatherFaces(base, { amplitude: 0.3, subdivisions: 2, seed: 5 });
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it("compiles cleanly and grows triangle count as expected", () => {
    // one face: 4 new quads (8 tris) + 4 pentagon neighbours (12) + 1 untouched quad (2)
    const one = weatherFaces(cube(), { faces: [faceByNormal(cube(), [0, 0, 1])], amplitude: 0.2, seed: 7 });
    expect(validatePolyMesh(one)).toEqual([]);
    expect(compilePolyMesh(one).triangleCount).toBe(22);

    // all faces, 1 round: 6 quads -> 24 quads -> 48 tris
    const w1 = weatherFaces(cube(), { amplitude: 0.05, seed: 3 });
    expect(validatePolyMesh(w1)).toEqual([]);
    expect(w1.vertices.length).toBe(26); // 8 + 12 edge mids + 6 centers
    expect(compilePolyMesh(w1).triangleCount).toBe(48);

    // all faces, 2 rounds: 96 quads -> 192 tris
    const w2 = weatherFaces(cube(), { amplitude: 0.05, subdivisions: 2, seed: 3 });
    expect(validatePolyMesh(w2)).toEqual([]);
    expect(compilePolyMesh(w2).triangleCount).toBe(192);

    // output still parses as a valid poly mesh source
    expect(() => polyMeshSourceSchema.parse(w2)).not.toThrow();
    // geometry changed, so the parametric generator is dropped
    expect(w1.generator).toBeUndefined();
  });

  it("weathering all faces of a closed mesh still pins every original corner", () => {
    const base = cube();
    const m = weatherFaces(base, { amplitude: 0.2, subdivisions: 2, seed: 11 });
    for (let i = 0; i < base.vertices.length; i++) {
      expect(m.vertices[i]).toEqual(base.vertices[i]);
    }
    expect(validatePolyMesh(m)).toEqual([]);
  });
});

describe("weatheredBoxSource", () => {
  it("weathers only the requested side of a wall slab, keeping the slab's planes sealed", () => {
    const src: PrimitiveSource = { kind: "primitive", shape: "box", size: [4, 3, 0.3] };
    const flat = weatheredBoxSource(src, { faces: ["+z"], amplitude: 0, subdivisions: 2, seed: 9 });
    const { mesh, offset } = weatheredBoxSource(src, { faces: ["+z"], amplitude: 0.1, subdivisions: 2, seed: 9 });

    expect(offset).toEqual([0, -1.5, 0]);
    expect(mesh.faces.length).toBe(21); // 5 untouched sides + 16 quads on +z
    expect(mesh.vertices.length).toBe(29);
    expect(validatePolyMesh(mesh)).toEqual([]);
    expect(compilePolyMesh(mesh).triangleCount).toBe(54);

    // anything that moved is a new vertex strictly inside the +z face rectangle,
    // displaced along +z within amplitude of the original plane
    let movedCount = 0;
    for (let i = 0; i < mesh.vertices.length; i++) {
      const v = mesh.vertices[i]!;
      const f = flat.mesh.vertices[i]!;
      if (sameVec(v, f)) continue;
      movedCount++;
      expect(i).toBeGreaterThanOrEqual(8);
      expect(Math.abs(v[0])).toBeLessThan(2); // inside x extent
      expect(v[1]).toBeGreaterThan(0); // inside y extent (box stands on y=0)
      expect(v[1]).toBeLessThan(3);
      expect(f[2]).toBe(0.15); // it started on the +z plane...
      expect(Math.abs(v[2] - 0.15)).toBeLessThanOrEqual(0.1 + 1e-9); // ...and moved along z only within amplitude
      expect(v[0]).toBe(f[0]);
      expect(v[1]).toBe(f[1]);
    }
    expect(movedCount).toBeGreaterThan(0);
    expect(movedCount).toBeLessThanOrEqual(9); // 1 round-1 center + 4 interior mids + 4 round-2 centers

    // every vertex on the slab's other five planes is exactly where the box put it
    for (const v of mesh.vertices) {
      if (Math.abs(v[0]) === 2 || v[1] === 0 || v[1] === 3 || v[2] === -0.15) {
        // boundary vertex: must be lattice-exact (halves of halves of the box corners)
        expect(Number.isInteger(v[0] * 4)).toBe(true);
        expect(Number.isInteger(v[1] * 4)).toBe(true);
        expect(v[2] === 0.15 || v[2] === -0.15).toBe(true);
      }
    }
  });
});

describe("paintGrime", () => {
  it("heightBand paints only corners inside the band (hard edge by default)", () => {
    const m = paintGrime(cube(), [{ kind: "heightBand", from: -0.1, to: 0.4, color: "#000000", strength: 1 }]);
    const front = faceByNormal(m, [0, 0, 1]);
    expect(cornerColor(m, front, [-0.5, 0, 0.5])).toBe("#000000");
    expect(cornerColor(m, front, [0.5, 0, 0.5])).toBe("#000000");
    expect(cornerColor(m, front, [0.5, 1, 0.5])).toBe("#ffffff");
    expect(cornerColor(m, front, [-0.5, 1, 0.5])).toBe("#ffffff");
    // bottom face fully inside the band
    const bottom = faceByNormal(m, [0, -1, 0]);
    expect(m.faces[bottom]!.colors).toEqual(["#000000", "#000000", "#000000", "#000000"]);
    // top face untouched entirely: no colors array written at all
    const top = faceByNormal(m, [0, 1, 0]);
    expect(m.faces[top]!.colors).toBeUndefined();
    expect(m.faces[top]!.color).toBeUndefined();
  });

  it("heightBand fade ramps strength outside the band", () => {
    const m = paintGrime(cube(), [{ kind: "heightBand", from: 0.9, to: 1.1, fade: 1, color: "#000000", strength: 1 }]);
    const front = faceByNormal(m, [0, 0, 1]);
    expect(cornerColor(m, front, [-0.5, 1, 0.5])).toBe("#000000"); // in band
    expect(cornerColor(m, front, [-0.5, 0, 0.5])).toBe("#e6e6e6"); // 0.9 below -> s = 0.1
  });

  it("radial grime falls off with distance from the center", () => {
    const m = paintGrime(plane({ width: 2, depth: 2, widthSegments: 2, depthSegments: 2 }), [
      { kind: "radial", at: [0, 0, 0], radius: 2, color: "#000000", strength: 1 },
    ]);
    // gather one corner at each distance ring: center (d=0), edge mid (d=1), far corner (d=sqrt 2)
    const anyFaceAt = (at: Vec3): string => {
      for (let fi = 0; fi < m.faces.length; fi++) {
        const face = m.faces[fi]!;
        const ci = face.v.findIndex((v) => sameVec(m.vertices[v]!, at));
        if (ci >= 0) return face.colors![ci]!;
      }
      throw new Error(`no corner at ${at.join(",")}`);
    };
    const center = channel(anyFaceAt([0, 0, 0]), 0);
    const mid = channel(anyFaceAt([1, 0, 0]), 0);
    const corner = channel(anyFaceAt([1, 0, 1]), 0);
    expect(center).toBe(0); // full strength -> multiplied to black
    expect(mid).toBeGreaterThan(center);
    expect(corner).toBeGreaterThan(mid);
    expect(corner).toBeLessThan(255); // still touched at sqrt(2) < radius
  });

  it("downFacing/upFacing paint the right faces and leave walls alone", () => {
    const rules: GrimeRule[] = [
      { kind: "downFacing", color: "#202020", strength: 1 },
      { kind: "upFacing", color: "#4040ff", strength: 0.5 },
    ];
    const m = paintGrime(cube(), rules);
    const bottom = faceByNormal(m, [0, -1, 0]);
    const top = faceByNormal(m, [0, 1, 0]);
    const front = faceByNormal(m, [0, 0, 1]);
    expect(m.faces[bottom]!.colors).toEqual(["#202020", "#202020", "#202020", "#202020"]);
    // upFacing at strength 0.5: white * lerp(white, #4040ff, 0.5) = #a0a0ff
    expect(m.faces[top]!.colors).toEqual(["#a0a0ff", "#a0a0ff", "#a0a0ff", "#a0a0ff"]);
    expect(m.faces[front]!.colors).toBeUndefined(); // ny = 0 is under the 0.5 threshold
  });

  it("blends multiplicatively against existing flat face tints", () => {
    const base = cube();
    for (const face of base.faces) face.color = "#ff8040";
    const m = paintGrime(base, [{ kind: "radial", at: [0, 0.5, 0], radius: 100, color: "#404040", strength: 1 }]);
    // 0xff*0x40/255 = 0x40, 0x80*0x40/255 -> 0x20, 0x40*0x40/255 -> 0x10
    for (const face of m.faces) {
      expect(face.colors).toEqual(["#402010", "#402010", "#402010", "#402010"]);
      expect(face.color).toBeUndefined(); // baked into colors
    }
  });

  it("blends against existing per-corner colors rather than overwriting them", () => {
    const base = cube();
    const front = faceByNormal(base, [0, 0, 1]);
    base.faces[front]!.colors = ["#ff0000", "#00ff00", "#0000ff", "#808080"];
    const m = paintGrime(base, [{ kind: "radial", at: [0, 0.5, 0], radius: 100, color: "#808080", strength: 1 }]);
    expect(m.faces[front]!.colors).toEqual(["#800000", "#008000", "#000080", "#404040"]);
  });

  it("clamps out-of-range strengths and always emits valid #rrggbb", () => {
    const wild = paintGrime(cube(), [
      { kind: "heightBand", from: 0, to: 1, color: "#123456", strength: 999 },
      { kind: "radial", at: [0, 0, 0], radius: 5, color: "#000000", strength: -3 },
      { kind: "upFacing", color: "#00ff00", strength: Number.NaN },
    ]);
    const clamped = paintGrime(cube(), [{ kind: "heightBand", from: 0, to: 1, color: "#123456", strength: 1 }]);
    expect(wild).toEqual(clamped); // 999 clamps to 1; strength<=0 and NaN rules are no-ops
    for (const face of wild.faces) {
      for (const c of face.colors ?? []) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(() => polyMeshSourceSchema.parse(wild)).not.toThrow();
  });

  it("is pure and keeps the generator (attribute-only op)", () => {
    const base = cube();
    const snapshot = JSON.stringify(base);
    const m = paintGrime(base, [{ kind: "downFacing", color: "#111111", strength: 1 }]);
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(m.generator).toEqual(base.generator);
  });
});

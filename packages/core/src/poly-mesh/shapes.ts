import type { PolyFace, PolyGenerator, PolyMesh, Vec3 } from "./types.js";
import { roundVec } from "./vec.js";

/**
 * Parametric shape generators — ProBuilder's shape library as pure functions
 * returning PolyMeshes. Every shape stands ON y=0 (bounding-box bottom at the
 * origin, centered in XZ) so it snaps to floors, the way a level designer
 * expects; the entity transform places it. Each result records its
 * `generator` so the shape settings stay editable until the mesh is changed
 * by hand (then the ops layer drops the record — see `ops.ts`).
 *
 * Winding: counter-clockwise seen from outside. Smoothing: curved surfaces
 * share group 1; flat faces are group 0 (hard-edged).
 */

export type ShapeParams = Record<string, number | boolean | string>;

export interface ShapeParamSpec {
  key: string;
  label: string;
  kind: "number" | "int" | "boolean";
  default: number | boolean;
  min?: number;
  max?: number;
  step?: number;
}

export interface ShapeSpec {
  name: string;
  label: string;
  params: ShapeParamSpec[];
  build(params: ShapeParams): PolyMesh;
}

const num = (p: ShapeParams, key: string, fallback: number): number => {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
};
const int = (p: ShapeParams, key: string, fallback: number, min = 1): number =>
  Math.max(min, Math.round(num(p, key, fallback)));
const bool = (p: ShapeParams, key: string, fallback: boolean): boolean => {
  const v = p[key];
  return typeof v === "boolean" ? v : fallback;
};

class Builder {
  vertices: Vec3[] = [];
  faces: PolyFace[] = [];
  private lookup = new Map<string, number>();

  /** Add a vertex, welding to an existing one at the same (rounded) position. */
  vertex(p: Vec3): number {
    const r = roundVec(p, 6);
    const key = r.join(",");
    const existing = this.lookup.get(key);
    if (existing !== undefined) return existing;
    const index = this.vertices.length;
    this.vertices.push(r);
    this.lookup.set(key, index);
    return index;
  }

  /** Add a vertex WITHOUT welding (poles, seams). */
  vertexRaw(p: Vec3): number {
    const index = this.vertices.length;
    this.vertices.push(roundVec(p, 6));
    return index;
  }

  face(v: number[], attrs: Partial<PolyFace> = {}): void {
    // drop consecutive duplicates (degenerate corners at poles/seams)
    const clean: number[] = [];
    for (const i of v) if (clean[clean.length - 1] !== i) clean.push(i);
    if (clean.length > 1 && clean[0] === clean[clean.length - 1]) clean.pop();
    if (clean.length < 3) return;
    this.faces.push({ v: clean, mat: 0, smooth: 0, ...attrs });
  }

  finish(generator: PolyGenerator): PolyMesh {
    return { kind: "poly", vertices: this.vertices, faces: this.faces, materials: [], generator };
  }
}

/** Convenience: a face from explicit points (welded). */
function quad(b: Builder, a: Vec3, c: Vec3, d: Vec3, e: Vec3, attrs?: Partial<PolyFace>): void {
  b.face([b.vertex(a), b.vertex(c), b.vertex(d), b.vertex(e)], attrs);
}

// ---------------------------------------------------------------- shapes

export function cube(params: ShapeParams = {}): PolyMesh {
  const w = num(params, "width", 1);
  const h = num(params, "height", 1);
  const d = num(params, "depth", 1);
  const b = new Builder();
  const x = w / 2;
  const z = d / 2;
  // bottom (y=0), facing -Y
  quad(b, [-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z]);
  // top, facing +Y
  quad(b, [-x, h, z], [x, h, z], [x, h, -z], [-x, h, -z]);
  // front (+Z)
  quad(b, [-x, 0, z], [x, 0, z], [x, h, z], [-x, h, z]);
  // back (-Z)
  quad(b, [x, 0, -z], [-x, 0, -z], [-x, h, -z], [x, h, -z]);
  // right (+X)
  quad(b, [x, 0, z], [x, 0, -z], [x, h, -z], [x, h, z]);
  // left (-X)
  quad(b, [-x, 0, -z], [-x, 0, z], [-x, h, z], [-x, h, -z]);
  return b.finish({ shape: "cube", params: { width: w, height: h, depth: d } });
}

export function plane(params: ShapeParams = {}): PolyMesh {
  const w = num(params, "width", 1);
  const d = num(params, "depth", 1);
  const sx = int(params, "widthSegments", 1);
  const sz = int(params, "depthSegments", 1);
  const b = new Builder();
  for (let iz = 0; iz < sz; iz++) {
    for (let ix = 0; ix < sx; ix++) {
      const x0 = -w / 2 + (w * ix) / sx;
      const x1 = -w / 2 + (w * (ix + 1)) / sx;
      const z0 = -d / 2 + (d * iz) / sz;
      const z1 = -d / 2 + (d * (iz + 1)) / sz;
      // facing +Y
      quad(b, [x0, 0, z1], [x1, 0, z1], [x1, 0, z0], [x0, 0, z0]);
    }
  }
  return b.finish({ shape: "plane", params: { width: w, depth: d, widthSegments: sx, depthSegments: sz } });
}

export function cylinder(params: ShapeParams = {}): PolyMesh {
  const radius = num(params, "radius", 0.5);
  const h = num(params, "height", 1);
  const sides = int(params, "sides", 16, 3);
  const heightSegments = int(params, "heightSegments", 1);
  const b = new Builder();
  const ring = (y: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      out.push(b.vertex([Math.cos(a) * radius, y, -Math.sin(a) * radius]));
    }
    return out;
  };
  const rings: number[][] = [];
  for (let s = 0; s <= heightSegments; s++) rings.push(ring((h * s) / heightSegments));
  // bottom cap facing -Y: reverse order
  b.face([...rings[0]!].reverse());
  // top cap facing +Y
  b.face([...rings[heightSegments]!]);
  for (let s = 0; s < heightSegments; s++) {
    const lo = rings[s]!;
    const hi = rings[s + 1]!;
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      b.face([lo[i]!, lo[j]!, hi[j]!, hi[i]!], { smooth: 1 });
    }
  }
  return b.finish({ shape: "cylinder", params: { radius, height: h, sides, heightSegments } });
}

export function cone(params: ShapeParams = {}): PolyMesh {
  const radius = num(params, "radius", 0.5);
  const h = num(params, "height", 1);
  const sides = int(params, "sides", 16, 3);
  const b = new Builder();
  const base: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    base.push(b.vertex([Math.cos(a) * radius, 0, -Math.sin(a) * radius]));
  }
  b.face([...base].reverse());
  const apex = b.vertex([0, h, 0]);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    b.face([base[i]!, base[j]!, apex], { smooth: 1 });
  }
  return b.finish({ shape: "cone", params: { radius, height: h, sides } });
}

export function prism(params: ShapeParams = {}): PolyMesh {
  // triangular prism / ramp: rises toward +Z (matches the old wedge primitive)
  const w = num(params, "width", 1);
  const h = num(params, "height", 1);
  const d = num(params, "depth", 1);
  const b = new Builder();
  const x = w / 2;
  const z = d / 2;
  // bottom (-Y)
  quad(b, [-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z]);
  // back vertical face (+Z)
  quad(b, [-x, 0, z], [x, 0, z], [x, h, z], [-x, h, z]);
  // slope (from front-bottom edge up to back-top edge), faces -Z/+Y
  quad(b, [x, 0, -z], [-x, 0, -z], [-x, h, z], [x, h, z]);
  // left triangle (-X)
  b.face([b.vertex([-x, 0, -z]), b.vertex([-x, 0, z]), b.vertex([-x, h, z])]);
  // right triangle (+X)
  b.face([b.vertex([x, 0, z]), b.vertex([x, 0, -z]), b.vertex([x, h, z])]);
  return b.finish({ shape: "prism", params: { width: w, height: h, depth: d } });
}

export function stairs(params: ShapeParams = {}): PolyMesh {
  const w = num(params, "width", 2);
  const h = num(params, "height", 2);
  const d = num(params, "depth", 3);
  const steps = int(params, "steps", 6);
  const sides = bool(params, "sides", true);
  const b = new Builder();
  const x = w / 2;
  const stepH = h / steps;
  const stepD = d / steps;
  // steps climb toward +Z; front of each riser faces -Z
  for (let i = 0; i < steps; i++) {
    const z0 = -d / 2 + i * stepD;
    const z1 = z0 + stepD;
    const y0 = i * stepH;
    const y1 = y0 + stepH;
    // riser (faces -Z)
    quad(b, [x, y0, z0], [-x, y0, z0], [-x, y1, z0], [x, y1, z0]);
    // tread (faces +Y)
    quad(b, [-x, y1, z1], [x, y1, z1], [x, y1, z0], [-x, y1, z0]);
  }
  // back wall (+Z)
  quad(b, [-x, 0, d / 2], [x, 0, d / 2], [x, h, d / 2], [-x, h, d / 2]);
  // bottom (-Y)
  quad(b, [-x, 0, -d / 2], [x, 0, -d / 2], [x, 0, d / 2], [-x, 0, d / 2]);
  if (sides) {
    // side profiles as one n-gon each (the staircase silhouette)
    const profile: Array<[number, number]> = [[0, -d / 2]]; // [y, z]
    for (let i = 0; i < steps; i++) {
      const z0 = -d / 2 + i * stepD;
      const y1 = (i + 1) * stepH;
      profile.push([y1, z0], [y1, z0 + stepD]);
    }
    profile.push([0, d / 2]);
    // left (-X): outward normal -X; right (+X)
    const left = profile.map(([y, z]) => b.vertex([-x, y, z]));
    const right = profile.map(([y, z]) => b.vertex([x, y, z]));
    // orientation: for -X face seen from -X, y up & z to the left... use the
    // winding test in Builder consumers; here choose by construction:
    b.face([...left].reverse());
    b.face(right);
    fixOrientation(b, b.faces.length - 2, [-1, 0, 0]);
    fixOrientation(b, b.faces.length - 1, [1, 0, 0]);
  }
  return b.finish({ shape: "stairs", params: { width: w, height: h, depth: d, steps, sides } });
}

export function arch(params: ShapeParams = {}): PolyMesh {
  const radius = num(params, "radius", 1.5);
  const thickness = num(params, "thickness", 0.3);
  const depth = num(params, "depth", 0.5);
  const sides = int(params, "sides", 8, 2);
  const degrees = Math.min(360, Math.max(1, num(params, "degrees", 180)));
  const b = new Builder();
  const inner = Math.max(0.01, radius - thickness);
  const z = depth / 2;
  const span = (degrees * Math.PI) / 180;
  const start = Math.PI - (Math.PI - span) / 2; // symmetric about +Y when degrees < 180
  const pt = (r: number, i: number): [number, number] => {
    const a = start - (i / sides) * span;
    return [Math.cos(a) * r, Math.sin(a) * r];
  };
  // lift so the arch stands on y=0 for the common 180° case (feet at y=0)
  const lift = degrees <= 180 ? 0 : radius;
  const out: number[][] = [];
  const inn: number[][] = [];
  for (let i = 0; i <= sides; i++) {
    const [ox, oy] = pt(radius, i);
    const [ix, iy] = pt(inner, i);
    out.push([b.vertex([ox, oy + lift, z]), b.vertex([ox, oy + lift, -z])]);
    inn.push([b.vertex([ix, iy + lift, z]), b.vertex([ix, iy + lift, -z])]);
  }
  for (let i = 0; i < sides; i++) {
    const o0 = out[i]!;
    const o1 = out[i + 1]!;
    const i0 = inn[i]!;
    const i1 = inn[i + 1]!;
    // front face (+Z)
    b.face([o0[0]!, i0[0]!, i1[0]!, o1[0]!]);
    fixOrientation(b, b.faces.length - 1, [0, 0, 1]);
    // back face (-Z)
    b.face([o1[1]!, i1[1]!, i0[1]!, o0[1]!]);
    fixOrientation(b, b.faces.length - 1, [0, 0, -1]);
    // outer band (smooth)
    b.face([o0[1]!, o1[1]!, o1[0]!, o0[0]!], { smooth: 1 });
    fixOrientationRadial(b, b.faces.length - 1, lift, true);
    // inner band (smooth)
    b.face([i0[0]!, i1[0]!, i1[1]!, i0[1]!], { smooth: 2 });
    fixOrientationRadial(b, b.faces.length - 1, lift, false);
  }
  if (degrees < 360) {
    // end caps
    const a0 = out[0]!;
    const c0 = inn[0]!;
    b.face([a0[0]!, a0[1]!, c0[1]!, c0[0]!]);
    fixOrientationAway(b, b.faces.length - 1, [0, lift, 0]);
    const a1 = out[sides]!;
    const c1 = inn[sides]!;
    b.face([c1[0]!, c1[1]!, a1[1]!, a1[0]!]);
    fixOrientationAway(b, b.faces.length - 1, [0, lift, 0]);
  }
  return b.finish({ shape: "arch", params: { radius, thickness, depth, sides, degrees } });
}

export function torus(params: ShapeParams = {}): PolyMesh {
  const radius = num(params, "radius", 1);
  const tube = num(params, "tube", 0.3);
  const segments = int(params, "segments", 24, 3);
  const tubeSegments = int(params, "tubeSegments", 12, 3);
  const b = new Builder();
  const grid: number[][] = [];
  for (let i = 0; i < segments; i++) {
    const u = (i / segments) * Math.PI * 2;
    const row: number[] = [];
    for (let j = 0; j < tubeSegments; j++) {
      const v = (j / tubeSegments) * Math.PI * 2;
      const r = radius + Math.cos(v) * tube;
      row.push(b.vertex([Math.cos(u) * r, tube + Math.sin(v) * tube, -Math.sin(u) * r]));
    }
    grid.push(row);
  }
  for (let i = 0; i < segments; i++) {
    const i1 = (i + 1) % segments;
    for (let j = 0; j < tubeSegments; j++) {
      const j1 = (j + 1) % tubeSegments;
      b.face([grid[i]![j]!, grid[i1]![j]!, grid[i1]![j1]!, grid[i]![j1]!], { smooth: 1 });
    }
  }
  fixAllRadial(b, [0, tube, 0]);
  return b.finish({ shape: "torus", params: { radius, tube, segments, tubeSegments } });
}

export function pipe(params: ShapeParams = {}): PolyMesh {
  const radius = num(params, "radius", 0.5);
  const h = num(params, "height", 1);
  const thickness = num(params, "thickness", 0.1);
  const sides = int(params, "sides", 16, 3);
  const heightSegments = int(params, "heightSegments", 1);
  const inner = Math.max(0.01, radius - thickness);
  const b = new Builder();
  const ring = (r: number, y: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      out.push(b.vertex([Math.cos(a) * r, y, -Math.sin(a) * r]));
    }
    return out;
  };
  const outer: number[][] = [];
  const inn: number[][] = [];
  for (let s = 0; s <= heightSegments; s++) {
    outer.push(ring(radius, (h * s) / heightSegments));
    inn.push(ring(inner, (h * s) / heightSegments));
  }
  for (let s = 0; s < heightSegments; s++) {
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      b.face([outer[s]![i]!, outer[s]![j]!, outer[s + 1]![j]!, outer[s + 1]![i]!], { smooth: 1 });
      b.face([inn[s + 1]![i]!, inn[s + 1]![j]!, inn[s]![j]!, inn[s]![i]!], { smooth: 2 });
    }
  }
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    // top ring (+Y) and bottom ring (-Y)
    b.face([inn[heightSegments]![i]!, inn[heightSegments]![j]!, outer[heightSegments]![j]!, outer[heightSegments]![i]!]);
    b.face([outer[0]![i]!, outer[0]![j]!, inn[0]![j]!, inn[0]![i]!]);
  }
  return b.finish({ shape: "pipe", params: { radius, height: h, thickness, sides, heightSegments } });
}

export function door(params: ShapeParams = {}): PolyMesh {
  // a doorway frame: an outer box with a rectangular opening through Z
  const w = num(params, "width", 2);
  const h = num(params, "height", 2.5);
  const d = num(params, "depth", 0.3);
  const legWidth = Math.min(w / 2 - 0.01, Math.max(0.01, num(params, "legWidth", 0.3)));
  const top = Math.min(h - 0.01, Math.max(0.01, num(params, "topWidth", 0.3)));
  const b = new Builder();
  const x = w / 2;
  const z = d / 2;
  const ix = x - legWidth; // inner half-width
  const iy = h - top; // opening height
  // a 3x2 grid of cells (columns: left leg / opening / right leg; rows: below
  // / above the lintel line) so every shared edge is split identically on
  // each face that borders it — no T-junctions anywhere
  const cols: Array<[number, number]> = [[-x, -ix], [-ix, ix], [ix, x]];
  const rows: Array<[number, number]> = [[0, iy], [iy, h]];
  const front = (zz: number, flip: boolean): void => {
    cols.forEach(([x0, x1], ci) => {
      rows.forEach(([y0, y1], ri) => {
        if (ci === 1 && ri === 0) return; // the opening
        const ids = [b.vertex([x0, y0, zz]), b.vertex([x1, y0, zz]), b.vertex([x1, y1, zz]), b.vertex([x0, y1, zz])];
        b.face(flip ? ids.reverse() : ids);
      });
    });
  };
  front(z, false);
  front(-z, true);
  // outer sides, split at the lintel line
  for (const [y0, y1] of rows) {
    quad(b, [x, y0, z], [x, y0, -z], [x, y1, -z], [x, y1, z]); // +X
    quad(b, [-x, y0, -z], [-x, y0, z], [-x, y1, z], [-x, y1, -z]); // -X
  }
  // top, split per column
  for (const [x0, x1] of cols) quad(b, [x0, h, z], [x1, h, z], [x1, h, -z], [x0, h, -z]);
  // leg bottoms
  quad(b, [-x, 0, -z], [-ix, 0, -z], [-ix, 0, z], [-x, 0, z]);
  quad(b, [ix, 0, -z], [x, 0, -z], [x, 0, z], [ix, 0, z]);
  // opening: inner leg faces (facing inward) and lintel underside
  quad(b, [-ix, 0, z], [-ix, 0, -z], [-ix, iy, -z], [-ix, iy, z]); // faces +X
  quad(b, [ix, 0, -z], [ix, 0, z], [ix, iy, z], [ix, iy, -z]); // faces -X
  quad(b, [-ix, iy, -z], [ix, iy, -z], [ix, iy, z], [-ix, iy, z]); // faces -Y
  return b.finish({ shape: "door", params: { width: w, height: h, depth: d, legWidth, topWidth: top } });
}

export function sphere(params: ShapeParams = {}): PolyMesh {
  const radius = num(params, "radius", 0.5);
  const segments = int(params, "segments", 16, 3);
  const rings = int(params, "rings", 8, 2);
  const b = new Builder();
  const grid: number[][] = [];
  for (let r = 1; r < rings; r++) {
    const phi = (r / rings) * Math.PI;
    const row: number[] = [];
    for (let s = 0; s < segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      row.push(
        b.vertex([
          Math.sin(phi) * Math.cos(theta) * radius,
          radius + Math.cos(phi) * radius,
          -Math.sin(phi) * Math.sin(theta) * radius,
        ]),
      );
    }
    grid.push(row);
  }
  const top = b.vertex([0, radius * 2, 0]);
  const bottom = b.vertex([0, 0, 0]);
  for (let s = 0; s < segments; s++) {
    const s1 = (s + 1) % segments;
    b.face([top, grid[0]![s]!, grid[0]![s1]!], { smooth: 1 });
    for (let r = 0; r < grid.length - 1; r++) {
      b.face([grid[r]![s]!, grid[r + 1]![s]!, grid[r + 1]![s1]!, grid[r]![s1]!], { smooth: 1 });
    }
    const last = grid[grid.length - 1]!;
    b.face([bottom, last[s1]!, last[s]!], { smooth: 1 });
  }
  fixAllRadial(b, [0, radius, 0]);
  return b.finish({ shape: "sphere", params: { radius, segments, rings } });
}

export function icosphere(params: ShapeParams = {}): PolyMesh {
  const radius = num(params, "radius", 0.5);
  const subdivisions = Math.min(4, int(params, "subdivisions", 1, 0));
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: Vec3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => norm(v as Vec3));
  let tris: Array<[number, number, number]> = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let i = 0; i < subdivisions; i++) {
    const cache = new Map<string, number>();
    const mid = (a: number, b: number): number => {
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const pa = verts[a]!;
      const pb = verts[b]!;
      const index = verts.length;
      verts.push(norm([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2]));
      cache.set(key, index);
      return index;
    };
    const next: Array<[number, number, number]> = [];
    for (const [a, b2, c] of tris) {
      const ab = mid(a, b2);
      const bc = mid(b2, c);
      const ca = mid(c, a);
      next.push([a, ab, ca], [b2, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    tris = next;
  }
  verts = verts.map((v) => roundVec([v[0] * radius, radius + v[1] * radius, v[2] * radius]));
  const faces: PolyFace[] = tris.map((tri) => ({ v: [...tri], mat: 0, smooth: 1 }));
  return {
    kind: "poly",
    vertices: verts,
    faces,
    materials: [],
    generator: { shape: "icosphere", params: { radius, subdivisions } },
  };
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

// ---------------------------------------------------------------- orientation fixes

function newell(b: Builder, fi: number): Vec3 {
  const face = b.faces[fi]!;
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < face.v.length; i++) {
    const a = b.vertices[face.v[i]!]!;
    const c = b.vertices[face.v[(i + 1) % face.v.length]!]!;
    n[0] += (a[1] - c[1]) * (a[2] + c[2]);
    n[1] += (a[2] - c[2]) * (a[0] + c[0]);
    n[2] += (a[0] - c[0]) * (a[1] + c[1]);
  }
  return n;
}

function faceCentroid(b: Builder, fi: number): Vec3 {
  const face = b.faces[fi]!;
  const c: Vec3 = [0, 0, 0];
  for (const i of face.v) {
    const p = b.vertices[i]!;
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  return [c[0] / face.v.length, c[1] / face.v.length, c[2] / face.v.length];
}

/** Flip face `fi` if its normal opposes `want`. */
function fixOrientation(b: Builder, fi: number, want: Vec3): void {
  const n = newell(b, fi);
  if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) b.faces[fi]!.v.reverse();
}

/** Flip so the face points away from (outward=true) or toward a center. */
function fixOrientationAway(b: Builder, fi: number, center: Vec3): void {
  const c = faceCentroid(b, fi);
  fixOrientation(b, fi, [c[0] - center[0], c[1] - center[1], c[2] - center[2]]);
}

function fixOrientationRadial(b: Builder, fi: number, lift: number, outward: boolean): void {
  const c = faceCentroid(b, fi);
  const dir: Vec3 = [c[0], c[1] - lift, 0];
  fixOrientation(b, fi, outward ? dir : [-dir[0], -dir[1], -dir[2]]);
}

function fixAllRadial(b: Builder, center: Vec3): void {
  for (let i = 0; i < b.faces.length; i++) fixOrientationAway(b, i, center);
}

// ---------------------------------------------------------------- registry

const n = (key: string, label: string, def: number, min = 0.01, step = 0.1): ShapeParamSpec => ({
  key,
  label,
  kind: "number",
  default: def,
  min,
  step,
});
const i = (key: string, label: string, def: number, min = 1, max = 64): ShapeParamSpec => ({
  key,
  label,
  kind: "int",
  default: def,
  min,
  max,
  step: 1,
});

export const SHAPES: ShapeSpec[] = [
  { name: "cube", label: "Cube", params: [n("width", "width", 1), n("height", "height", 1), n("depth", "depth", 1)], build: cube },
  { name: "plane", label: "Plane", params: [n("width", "width", 1), n("depth", "depth", 1), i("widthSegments", "w seg", 1), i("depthSegments", "d seg", 1)], build: plane },
  { name: "cylinder", label: "Cylinder", params: [n("radius", "radius", 0.5), n("height", "height", 1), i("sides", "sides", 16, 3), i("heightSegments", "h seg", 1)], build: cylinder },
  { name: "cone", label: "Cone", params: [n("radius", "radius", 0.5), n("height", "height", 1), i("sides", "sides", 16, 3)], build: cone },
  { name: "prism", label: "Prism / ramp", params: [n("width", "width", 1), n("height", "height", 1), n("depth", "depth", 1)], build: prism },
  { name: "stairs", label: "Stairs", params: [n("width", "width", 2), n("height", "height", 2), n("depth", "depth", 3), i("steps", "steps", 6, 1, 64), { key: "sides", label: "sides", kind: "boolean", default: true }], build: stairs },
  { name: "arch", label: "Arch", params: [n("radius", "radius", 1.5), n("thickness", "thickness", 0.3), n("depth", "depth", 0.5), i("sides", "sides", 8, 2), n("degrees", "degrees", 180, 1, 5)], build: arch },
  { name: "torus", label: "Torus", params: [n("radius", "radius", 1), n("tube", "tube", 0.3), i("segments", "segments", 24, 3), i("tubeSegments", "tube seg", 12, 3)], build: torus },
  { name: "pipe", label: "Pipe", params: [n("radius", "radius", 0.5), n("height", "height", 1), n("thickness", "thickness", 0.1), i("sides", "sides", 16, 3), i("heightSegments", "h seg", 1)], build: pipe },
  { name: "door", label: "Door", params: [n("width", "width", 2), n("height", "height", 2.5), n("depth", "depth", 0.3), n("legWidth", "leg width", 0.3), n("topWidth", "top width", 0.3)], build: door },
  { name: "sphere", label: "Sphere", params: [n("radius", "radius", 0.5), i("segments", "segments", 16, 3), i("rings", "rings", 8, 2)], build: sphere },
  { name: "icosphere", label: "Icosphere", params: [n("radius", "radius", 0.5), i("subdivisions", "subdivisions", 1, 0, 4)], build: icosphere },
];

export function shapeSpec(name: string): ShapeSpec | undefined {
  return SHAPES.find((s) => s.name === name);
}

/** Build a shape by name; unknown names fall back to a cube. */
export function buildShape(name: string, params: ShapeParams = {}): PolyMesh {
  return (shapeSpec(name) ?? SHAPES[0]!).build(params);
}

/** Rebuild a generated mesh with new params (the "shape settings" panel), preserving material slots. */
export function regenerate(mesh: PolyMesh, params: ShapeParams): PolyMesh | null {
  if (!mesh.generator) return null;
  const next = buildShape(mesh.generator.shape, { ...mesh.generator.params, ...params });
  return { ...next, materials: [...mesh.materials] };
}

// ---------------------------------------------------------------- conversions

export interface PrimitiveSource {
  kind: "primitive";
  shape: string;
  size?: Vec3;
  segments?: [number, number];
}

export interface PolygonSource {
  kind: "polygon";
  points: Array<[number, number]>;
  height: number;
  bevel?: { size: number; segments: number };
}

/**
 * Convert a `primitive` mesh source to an editable poly mesh ("ProBuilderize").
 * Primitives are centered on their origin, so the result is shifted down by
 * half its height to keep the same world placement — except `wedge`, which
 * already stands on y=0. Returns the mesh plus the local-space offset the
 * caller must ADD to the entity's position to keep it where it was.
 */
export function polyFromPrimitive(source: PrimitiveSource): { mesh: PolyMesh; offset: Vec3 } {
  const [x, y, z] = source.size ?? [1, 1, 1];
  let mesh: PolyMesh;
  let offset: Vec3 = [0, -y / 2, 0];
  switch (source.shape) {
    case "sphere":
      mesh = sphere({ radius: x / 2, segments: 24, rings: 12 });
      offset = [0, -x / 2, 0];
      break;
    case "cylinder":
      mesh = cylinder({ radius: x / 2, height: y, sides: 24 });
      break;
    case "cone":
      mesh = cone({ radius: x / 2, height: y, sides: 24 });
      break;
    case "plane":
      mesh = plane({ width: x, depth: z, widthSegments: source.segments?.[0] ?? 1, depthSegments: source.segments?.[1] ?? 1 });
      offset = [0, 0, 0];
      break;
    case "wedge":
      mesh = prism({ width: x, height: y, depth: z });
      offset = [0, 0, 0];
      break;
    case "torus":
      mesh = torus({ radius: x / 2, tube: y / 4, segments: 32, tubeSegments: 16 });
      offset = [0, -y / 4, 0];
      break;
    case "capsule":
      mesh = cylinder({ radius: x / 2, height: y, sides: 24 });
      break;
    default:
      mesh = cube({ width: x, height: y, depth: z });
  }
  // a converted primitive is a free-form mesh from here on
  const { generator: _g, ...rest } = mesh;
  return { mesh: rest, offset };
}

/** Convert an extruded `polygon` source (graybox poly-draw) to an editable poly mesh. Bevel is dropped (the flat extrusion is what edits well). */
export function polyFromPolygon(source: PolygonSource): PolyMesh {
  const b = new Builder();
  // stored in extrude-space [x, -z]: world z = -y
  const pts = source.points.map(([px, py]) => [px, -py] as [number, number]);
  // ensure CCW seen from +Y (so the top cap faces up and sides face out)
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const c = pts[(i + 1) % pts.length]!;
    area += a[0] * c[1] - c[0] * a[1];
  }
  // in XZ with y up, CCW seen from above has NEGATIVE shoelace area (z is the
  // "down" screen axis when looking along -Y with x right)
  const ordered = area > 0 ? [...pts].reverse() : pts;
  const bottom = ordered.map(([px, pz]) => b.vertex([px, 0, pz]));
  const top = ordered.map(([px, pz]) => b.vertex([px, source.height, pz]));
  b.face([...bottom].reverse());
  b.face(top);
  fixOrientation(b, 0, [0, -1, 0]);
  fixOrientation(b, 1, [0, 1, 0]);
  const n = ordered.length;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    b.face([bottom[k]!, bottom[j]!, top[j]!, top[k]!]);
    const c = faceCentroid(b, b.faces.length - 1);
    // outward = away from the footprint centroid, in XZ
    fixOrientation(b, b.faces.length - 1, [c[0] - centroidX(ordered), 0, c[2] - centroidZ(ordered)]);
  }
  const { generator: _g, ...rest } = b.finish({ shape: "polygon", params: {} });
  return rest;
}

function centroidX(pts: Array<[number, number]>): number {
  return pts.reduce((s, p) => s + p[0], 0) / pts.length;
}
function centroidZ(pts: Array<[number, number]>): number {
  return pts.reduce((s, p) => s + p[1], 0) / pts.length;
}

/** Extruded footprint straight from XZ points (the graybox poly-draw gesture). Points are entity-local [x, z]. */
export function polyFromFootprint(points: Array<[number, number]>, height: number): PolyMesh {
  return polyFromPolygon({ kind: "polygon", points: points.map(([x, z]) => [x, -z]), height });
}

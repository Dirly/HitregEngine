import type { Vec2, Vec3 } from "./types.js";

/** Small allocation-light vector helpers for the headless mesh code. */

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));
export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const equalsApprox = (a: Vec3, b: Vec3, eps = 1e-6): boolean =>
  Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps;

export function centroid(points: Vec3[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  if (points.length === 0) return c;
  for (const p of points) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  return scale(c, 1 / points.length);
}

/** Newell's method: robust polygon normal for planar (or nearly planar) n-gons, area-weighted. */
export function polygonNormal(points: Vec3[]): Vec3 {
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return normalize(n);
}

/** Unnormalized Newell vector (its length is 2x the polygon area). */
export function polygonAreaVector(points: Vec3[]): Vec3 {
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

/** A tangent/bitangent pair orthogonal to `normal`. The tangent is chosen from the dominant world axis so projections stay upright/predictable (ProBuilder's planar-projection rule). */
export function planeBasis(normal: Vec3): { u: Vec3; v: Vec3 } {
  const ax = Math.abs(normal[0]);
  const ay = Math.abs(normal[1]);
  const az = Math.abs(normal[2]);
  // hint = the axis we want "up" (v) to follow; for floors/ceilings there is no
  // up, so use -Z so u = +X and v = -Z (a top-down view reads x right, z down)
  const hint: Vec3 = ay >= ax && ay >= az ? [0, 0, -1] : [0, 1, 0];
  let u = normalize(cross(hint, normal));
  if (length(u) < 1e-6) u = normalize(cross([1, 0, 0], normal));
  const v = normalize(cross(normal, u));
  return { u, v };
}

export function project2(p: Vec3, origin: Vec3, u: Vec3, v: Vec3): Vec2 {
  const d = sub(p, origin);
  return [dot(d, u), dot(d, v)];
}

/** 4x4 column-major matrix (three.js layout) applied to a point. */
export function applyMatrix4(p: Vec3, m: ArrayLike<number>): Vec3 {
  const x = p[0];
  const y = p[1];
  const z = p[2];
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  const iw = w !== 0 ? 1 / w : 1;
  return [
    (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) * iw,
    (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) * iw,
    (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) * iw,
  ];
}

/** Rotation-only application of a 4x4 (directions, not points). */
export function applyMatrix4Dir(p: Vec3, m: ArrayLike<number>): Vec3 {
  const x = p[0];
  const y = p[1];
  const z = p[2];
  return [
    m[0]! * x + m[4]! * y + m[8]! * z,
    m[1]! * x + m[5]! * y + m[9]! * z,
    m[2]! * x + m[6]! * y + m[10]! * z,
  ];
}

/** Rotate `p` around `axis` (unit) through `origin` by `angle` radians (Rodrigues). */
export function rotateAround(p: Vec3, origin: Vec3, axis: Vec3, angle: number): Vec3 {
  const d = sub(p, origin);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const term1 = scale(d, c);
  const term2 = scale(cross(axis, d), s);
  const term3 = scale(axis, dot(axis, d) * (1 - c));
  return add(origin, add(add(term1, term2), term3));
}

export function round(v: number, decimals = 6): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

export const roundVec = (v: Vec3, decimals = 6): Vec3 => [
  round(v[0], decimals),
  round(v[1], decimals),
  round(v[2], decimals),
];

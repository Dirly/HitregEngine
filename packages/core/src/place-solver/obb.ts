/**
 * Plan-view oriented boxes for the placement solver: footprints, obstacles, keep-outs. Yaw follows three.js about +Y:
 * a box turned `yaw` has its local +X along world (cos, -sin) and its local +Z along world (sin, cos), so a local point
 * (x, z) lands at centre + (x cos + z sin, -x sin + z cos) (place-build `toWorldYaw`). Pure.
 */

export type V2 = [number, number];

export interface Obb {
  /** Centre, world plan. */
  c: V2;
  /** Half extents along the box's own X and Z (m). */
  half: V2;
  /** Radians about +Y. */
  yaw: number;
}

export const axesOf = (yaw: number): [V2, V2] => {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [[c, -s], [s, c]];
};

/** Local (x, z) in a frame at `c` turned `yaw` -> world plan. */
export const localToWorld = (c: V2, yaw: number, l: V2): V2 => {
  const co = Math.cos(yaw), s = Math.sin(yaw);
  return [c[0] + l[0] * co + l[1] * s, c[1] - l[0] * s + l[1] * co];
};
/** World plan -> local (x, z) of a frame at `c` turned `yaw`. */
export const worldToLocal = (c: V2, yaw: number, w: V2): V2 => {
  const co = Math.cos(yaw), s = Math.sin(yaw), dx = w[0] - c[0], dz = w[1] - c[1];
  return [dx * co - dz * s, dx * s + dz * co];
};

export function obbCorners(b: Obb): V2[] {
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([i, j]) => localToWorld(b.c, b.yaw, [i * b.half[0], j * b.half[1]]));
}

/**
 * Separating-axis test of two plan boxes. Returns null when they are apart (or touch within `tol`), else the minimum
 * translation (world plan vector) that moves `a` out of `b` along the least-penetration axis, and its depth.
 */
export function obbOverlap(a: Obb, b: Obb, tol = 0): { push: V2; depth: number } | null {
  const [ax, az] = axesOf(a.yaw), [bx, bz] = axesOf(b.yaw);
  const d: V2 = [a.c[0] - b.c[0], a.c[1] - b.c[1]];
  let best = Infinity, axis: V2 = [1, 0];
  for (const n of [ax, az, bx, bz]) {
    const ra = a.half[0] * Math.abs(ax[0] * n[0] + ax[1] * n[1]) + a.half[1] * Math.abs(az[0] * n[0] + az[1] * n[1]);
    const rb = b.half[0] * Math.abs(bx[0] * n[0] + bx[1] * n[1]) + b.half[1] * Math.abs(bz[0] * n[0] + bz[1] * n[1]);
    const dist = d[0] * n[0] + d[1] * n[1], over = ra + rb - Math.abs(dist);
    if (over <= tol) return null;
    if (over < best) { best = over; axis = dist >= 0 ? n : [-n[0], -n[1]]; }
  }
  return { push: [axis[0] * best, axis[1] * best], depth: best };
}

/** A lane (street, footpath, door approach) as boxes, one per segment, `width` wide. */
export function laneBoxes(points: V2[], width: number): Obb[] {
  const out: Obb[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!, b = points[i + 1]!, dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    if (L < 1e-6) continue;
    // the box's local +Z runs along the segment: (sin yaw, cos yaw) = (dx, dz) / L
    out.push({ c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], half: [width / 2, L / 2], yaw: Math.atan2(dx, dz) });
  }
  return out;
}

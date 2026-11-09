/**
 * Row fit (k-town2, Derek 2026-10-30: "make filler so the walls and roof of another house don't poke through"): two row
 * houses stand side by side at the row pitch -- A's lot [-wA/2, wA/2] on x, B's lot right of it, their street fronts on one
 * line -- and the pair is measured, never looked at:
 *   cross   any triangle of A reaching more than `tol` (1 cm) past the lot line into B's lot, or of B into A's: a roof
 *           eave, verge, stack, patch or step crossing the party line. The finding names whether it lands INSIDE the
 *           neighbour's body (an intersection) or in the air beside it (still across the line).
 *   gap     on the party plane, where both houses have body within `slab` (0.6 m) of the line (projection of their
 *           triangles clipped to that slab), every point must be closed by a face lying ON the line (|x - line| < 1 cm,
 *           facing across it) of one of them. An open hole wider than `gapMax` (5 cm) both ways is a finding: daylight
 *           through the row (a short eave beside a parapet, a wall stopping short of the line). In front of the street face
 *           only triangles within 0.1 m of the line are body (k-kit2: shutters and door canopies near a party line are
 *           street fixtures, not a gap).
 * Pure: works on triangle soups (x, y, z per vertex; y up, street toward +z); the CLI (`town-kit-check row-fit`) loads GLBs.
 */
export type Tris = Float32Array | number[];
export type RowHouse = { id: string; tris: Tris; lot: number; front: number };

const CELL = 0.01;

/** Clip a triangle to xa <= x <= xb (Sutherland-Hodgman on two planes); returns the polygon's (z, y) points. */
function clipSlab(t: ArrayLike<number>, o: number, xa: number, xb: number): number[][] {
  let poly: number[][] = [[t[o]!, t[o + 1]!, t[o + 2]!], [t[o + 3]!, t[o + 4]!, t[o + 5]!], [t[o + 6]!, t[o + 7]!, t[o + 8]!]];
  for (const [lim, keepBelow] of [[xb, true], [xa, false]] as [number, boolean][]) {
    const out: number[][] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
      const ina = keepBelow ? a[0]! <= lim : a[0]! >= lim, inb = keepBelow ? b[0]! <= lim : b[0]! >= lim;
      if (ina) out.push(a);
      if (ina !== inb) { const s = (lim - a[0]!) / (b[0]! - a[0]!); out.push([lim, a[1]! + s * (b[1]! - a[1]!), a[2]! + s * (b[2]! - a[2]!)]); }
    }
    poly = out;
    if (poly.length < 3) return [];
  }
  return poly.map((p) => [p[2]!, p[1]!]);
}

class Raster {
  w: number; h: number; z0: number; y0: number; a: Uint8Array;
  constructor(z0: number, z1: number, y0: number, y1: number) {
    this.z0 = z0; this.y0 = y0; this.w = Math.max(1, Math.ceil((z1 - z0) / CELL)); this.h = Math.max(1, Math.ceil((y1 - y0) / CELL));
    this.a = new Uint8Array(this.w * this.h);
  }
  /** fill a convex polygon of (z, y) points (cell centres inside, plus every cell the edges touch: conservative) */
  fill(poly: number[][]) {
    if (poly.length < 3) return;
    let zmin = Infinity, zmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const [z, y] of poly) { zmin = Math.min(zmin, z!); zmax = Math.max(zmax, z!); ymin = Math.min(ymin, y!); ymax = Math.max(ymax, y!); }
    const i0 = Math.max(0, Math.floor((zmin - this.z0) / CELL)), i1 = Math.min(this.w - 1, Math.floor((zmax - this.z0) / CELL));
    const j0 = Math.max(0, Math.floor((ymin - this.y0) / CELL)), j1 = Math.min(this.h - 1, Math.floor((ymax - this.y0) / CELL));
    // degenerate (edge-on) polygons cover nothing on the plane
    let area = 0;
    for (let i = 0; i < poly.length; i++) { const p = poly[i]!, q = poly[(i + 1) % poly.length]!; area += p[0]! * q[1]! - q[0]! * p[1]!; }
    if (Math.abs(area) < 1e-6) return;
    const sg = Math.sign(area);
    for (let j = j0; j <= j1; j++) {
      const y = this.y0 + (j + 0.5) * CELL;
      for (let i = i0; i <= i1; i++) {
        const z = this.z0 + (i + 0.5) * CELL;
        let inside = true;
        for (let k = 0; k < poly.length && inside; k++) {
          const p = poly[k]!, q = poly[(k + 1) % poly.length]!;
          const cr = ((q[0]! - p[0]!) * (y - p[1]!) - (q[1]! - p[1]!) * (z - p[0]!)) * sg;
          const len = Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!) || 1;
          if (cr / len < -CELL * 0.75) inside = false;      // within ~a cell of the edge counts (no seams between faces)
        }
        if (inside) this.a[j * this.w + i] = 1;
      }
    }
  }
}

function bounds(tris: Tris, dx: number, dz: number) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i]! + dx, y = tris[i + 1]!, z = tris[i + 2]! + dz;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  return { x0, x1, y0, y1, z0, z1 };
}

/** Findings for A on the left, B on the right (empty = the pair fits). */
export function rowFitPair(A: RowHouse, B: RowHouse, opts: { tol?: number; slab?: number; gapMax?: number } = {}): string[] {
  const tol = opts.tol ?? 0.01, slab = opts.slab ?? 0.6, gapMax = opts.gapMax ?? 0.05;
  const line = A.lot / 2, bx = A.lot / 2 + B.lot / 2, bz = A.front - B.front;     // B moved so its front meets A's
  const f: string[] = [];
  const bb = bounds(A.tris, 0, 0), bB = bounds(B.tris, bx, bz);
  const r = () => new Raster(Math.min(bb.z0, bB.z0) - 0.1, Math.max(bb.z1, bB.z1) + 0.1, Math.min(bb.y0, bB.y0) - 0.1, Math.max(bb.y1, bB.y1) + 0.1);
  // the near-line bodies (projections of each house's triangles within `slab` of the line, on its own side)
  const PA = r(), PB = r(), CA = r(), CB = r();
  const shifted = (t: Tris, dx: number, dz: number, o: number) => [t[o]! + dx, t[o + 1]!, t[o + 2]! + dz, t[o + 3]! + dx, t[o + 4]!, t[o + 5]! + dz, t[o + 6]! + dx, t[o + 7]!, t[o + 8]! + dz];
  const cross: { who: string; into: number; at: number[] }[] = [];
  for (const [H, dx, dz, P, C, sign] of [[A, 0, 0, PA, CA, 1], [B, bx, bz, PB, CB, -1]] as [RowHouse, number, number, Raster, Raster, number][]) {
    for (let o = 0; o < H.tris.length; o += 9) {
      const t = shifted(H.tris, dx, dz, o);
      const xs = [t[0]!, t[3]!, t[6]!];
      const over = sign > 0 ? Math.max(...xs) - line : line - Math.min(...xs);
      if (over > tol) cross.push({ who: H.id, into: over, at: [(t[0]! + t[3]! + t[6]!) / 3, (t[1]! + t[4]! + t[7]!) / 3, (t[2]! + t[5]! + t[8]!) / 3] });
      // k-kit2 (2026-11-03): IN FRONT of the street face (the whole triangle on or past the door line, 3 cm) only what reaches the line
      // is row body (0.1 m slab): an eave or verge stopping short still opens a gap, but a shutter, door canopy, balcony or
      // step 0.2-0.6 m off the line is a street fixture with open air beside it, not daylight through the row
      const sl = Math.min(t[2]!, t[5]!, t[8]!) >= A.front - 0.03 ? Math.min(slab, 0.1) : slab;
      const near = sign > 0 ? clipSlab(t, 0, line - sl, line) : clipSlab(t, 0, line, line + sl);
      if (near.length) P.fill(near);
      // a face ON the line, facing across it
      if (xs.every((x) => Math.abs(x - line) < tol)) {
        const ux = t[3]! - t[0]!, uy = t[4]! - t[1]!, uz = t[5]! - t[2]!, vx = t[6]! - t[0]!, vy = t[7]! - t[1]!, vz = t[8]! - t[2]!;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, L = Math.hypot(nx, ny, nz) || 1;
        if ((nx / L) * sign > 0.95) C.fill([[t[2]!, t[1]!], [t[5]!, t[4]!], [t[8]!, t[7]!]]);
      }
    }
  }
  if (cross.length) {
    const by = new Map<string, { n: number; max: number; at: number[] }>();
    for (const c of cross) { const e = by.get(c.who) ?? { n: 0, max: 0, at: c.at }; e.n++; if (c.into > e.max) { e.max = c.into; e.at = c.at; } by.set(c.who, e); }
    for (const [who, e] of by) {
      const P = who === A.id && who !== B.id ? PB : PA;      // the neighbour's body near the line
      const i = Math.floor((e.at[2]! - P.z0) / CELL), j = Math.floor((e.at[1]! - P.y0) / CELL);
      const inBody = i >= 0 && j >= 0 && i < P.w && j < P.h && P.a[j * P.w + i] === 1;
      f.push(`cross: ${who} reaches ${(e.max * 100).toFixed(0)} cm past the party line (${e.n} triangle(s), worst at x ${e.at[0]!.toFixed(2)} y ${e.at[1]!.toFixed(2)} z ${e.at[2]!.toFixed(2)})${inBody ? " INTO the neighbour's body (intersection)" : ""}`);
    }
  }
  // open gaps: both bodies there, no face on the line closes it
  const w = PA.w, h = PA.h, n = Math.max(1, Math.round(gapMax / CELL));
  const g = new Int32Array((w + 1) * (h + 1));      // summed-area table of gap cells
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i;
    const gap = PA.a[k] && PB.a[k] && !CA.a[k] && !CB.a[k] ? 1 : 0;
    g[(j + 1) * (w + 1) + i + 1] = gap + g[j * (w + 1) + i + 1]! + g[(j + 1) * (w + 1) + i]! - g[j * (w + 1) + i]!;
  }
  let worst: number[] | null = null, holes = 0;
  for (let j = 0; j + n <= h; j++) for (let i = 0; i + n <= w; i++) {
    const s = g[(j + n) * (w + 1) + i + n]! - g[j * (w + 1) + i + n]! - g[(j + n) * (w + 1) + i]! + g[j * (w + 1) + i]!;
    if (s === n * n) { holes++; if (!worst) worst = [PA.z0 + (i + n / 2) * CELL, PA.y0 + (j + n / 2) * CELL]; }
  }
  if (worst) f.push(`gap: an open gap over ${Math.round(gapMax * 100)} cm on the party line between ${A.id} and ${B.id} (${holes} probe(s), first at z ${worst[0]!.toFixed(2)} y ${worst[1]!.toFixed(2)})`);
  return f;
}

/** Every ordered pair (A left of B, A = B included). */
export function rowFitAll(houses: RowHouse[], opts?: { tol?: number; slab?: number; gapMax?: number }): { pair: string; findings: string[] }[] {
  const out: { pair: string; findings: string[] }[] = [];
  for (const A of houses) for (const B of houses) out.push({ pair: `${A.id} | ${B.id}`, findings: rowFitPair(A, B.id === A.id ? { ...B, id: `${B.id}'` } : B, opts) });
  return out;
}

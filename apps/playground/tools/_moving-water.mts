/**
 * MOVING WATER RUNS DOWNHILL. A channel/fall ribbon (mesh path source with `flowSpeed`, material shader "water",
 * flowMode "channel") scrolls its texture along the path, so a point that RISES along the path is a stretch of water
 * flowing up the rock; seen from its far side it reads as the back of the fall "flowing the opposite direction"
 * (owner walk 2026-10-21, the Weep Hole: a cascade ribbon binned a ceiling-high spill face into its points, a 14 m
 * spike up and back down). Builders thread their points through `downhillRibbon`; `water-edges scene` reports any
 * ribbon left with a rise (`uphillRibbonRows`). Pure; tested in test/moving-water.test.ts.
 */

/** Rise (m) a point may sit above the last kept one before it counts as water running uphill (ribbon lift noise). */
export const UPHILL_TOLERANCE = 0.1;

/** Drop every point that rises above the last kept point (points in flow order; y is up). Widths follow their points. */
export function downhillRibbon(points: [number, number, number][], widths?: number[], tol = UPHILL_TOLERANCE): { points: [number, number, number][]; widths: number[] | undefined; dropped: number } {
  const keep: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const last = keep.length ? points[keep[keep.length - 1]!]! : null;
    if (!last || points[i]![1] <= last[1] + tol) keep.push(i);
  }
  return { points: keep.map((i) => points[i]!), widths: widths ? keep.map((i) => widths[i]!) : undefined, dropped: points.length - keep.length };
}

/** The largest rise along a ribbon's points (0 when it only falls or runs level). */
export function maxRise(points: number[][]): { rise: number; at: number } {
  let lowest = Infinity, rise = 0, at = -1;
  for (let i = 0; i < points.length; i++) {
    const y = points[i]![1]!;
    if (y - lowest > rise) { rise = y - lowest; at = i; }
    lowest = Math.min(lowest, y);
  }
  return { rise, at };
}

/** Gate rows: every moving ribbon (path source with flowSpeed > 0) whose water climbs more than the tolerance. */
export function uphillRibbonRows(doc: { entities: Record<string, { name?: string; components?: Record<string, any> }> }, tol = UPHILL_TOLERANCE): { id: string; what: string; at: number[]; rise: number }[] {
  const out: { id: string; what: string; at: number[]; rise: number }[] = [];
  for (const [id, e] of Object.entries(doc.entities)) {
    const src = e.components?.mesh?.source;
    if (src?.kind !== "path" || !(src.flowSpeed > 0) || !Array.isArray(src.points)) continue;
    const { rise, at } = maxRise(src.points);
    if (rise > tol) out.push({ id, what: e.name ?? id, at: src.points[at], rise: Math.round(rise * 100) / 100 });
  }
  return out;
}

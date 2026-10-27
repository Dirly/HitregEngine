/**
 * The floor of a ROOFED site area (an arch, a lych gate, a covered yard, a cave overhang) found by itself:
 * site-sockets used to measure the first top a ray from the sky met — the roof — and props landed on the arch
 * (DRESS-KS had to declare `surface: built` + `floorY` by hand). An area declared roofed (`roofed: true`,
 * `indoor: true`, or a `surface` note naming a roof / indoor) is measured on the LOWEST walkable surface inside its
 * footprint that has a ceiling over it with standing headroom.
 */

/** One column of the footprint: every surface a ray down met (top first), each with the height of the first thing over it (null = sky). */
export interface ColumnProbe { surfaces: Array<{ y: number; ceiling: number | null }> }

/** Headroom (m) a floor needs under its ceiling to count (a player stands 1.8 m). */
export const ROOF_HEADROOM = 1.8;

/** Is this declared area roofed? (`roofed`/`indoor` true, or a free-text surface note that says so) */
export function declaredRoofed(a: { roofed?: unknown; indoor?: unknown; surfaceNote?: unknown }): boolean {
  return a.roofed === true || a.indoor === true || (typeof a.surfaceNote === "string" && /roof|indoor|covered|under\b/i.test(a.surfaceNote));
}

/**
 * Walk a column down from `top` to `bottom`, collecting each surface and the ceiling over it. `castDown(x, y, z, len)` /
 * `castUp(...)` answer the first hit's height or null (rays that pass through a solid's inside).
 */
export function probeColumn(castDown: (x: number, y: number, z: number, len: number) => number | null, castUp: (x: number, y: number, z: number, len: number) => number | null,
  x: number, z: number, top: number, bottom: number, maxSurfaces = 10): ColumnProbe {
  const surfaces: ColumnProbe["surfaces"] = [];
  let from = top;
  for (let i = 0; i < maxSurfaces && from > bottom; i++) {
    const y = castDown(x, from, z, from - bottom);
    if (y === null) break;
    surfaces.push({ y, ceiling: castUp(x, y + 0.05, z, 60) });
    from = y - 0.02;
  }
  return { surfaces };
}

/**
 * The roofed floor height: per column, the lowest surface with a ceiling at least `headroom` over it; the median of
 * those across the footprint, or null when fewer than `minShare` of the columns are roofed (the area is open sky).
 */
export function roofedFloorY(columns: ColumnProbe[], { headroom = ROOF_HEADROOM, minShare = 0.15 } = {}): number | null {
  const picks: number[] = [];
  for (const c of columns) {
    const under = c.surfaces.filter((s) => s.ceiling !== null && s.ceiling - s.y >= headroom).map((s) => s.y);
    if (under.length) picks.push(Math.min(...under));
  }
  if (!columns.length || picks.length < minShare * columns.length) return null;
  picks.sort((a, b) => a - b);
  return +picks[Math.floor(picks.length / 2)]!.toFixed(2);
}

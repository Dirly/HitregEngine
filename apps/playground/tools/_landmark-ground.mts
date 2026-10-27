/**
 * The ground a landmark bake trims "buried" geometry against. `field.height` is the heightfield; carves (passages, face
 * cuts, a wall-ramp's cut) only live in the density, so a part seated on a carved floor sat up to metres "under" the
 * heightfield and the buried trim dropped it (FIX-HW4: the weep-chute-head's tipping stone and most of its trough, seated
 * in the Sexton's Stair cut, were baked away). The trim reference is the LOWER of the heightfield and the first solid
 * met from just above it (density > 0 is air), cached per 0.25 m column.
 */
export interface GroundField { height(x: number, z: number): number; density(x: number, y: number, z: number): number }

export function visibleGround(field: GroundField, opts: { step?: number; depth?: number; cell?: number } = {}) {
  const step = opts.step ?? 0.1, depth = opts.depth ?? 40, cell = opts.cell ?? 0.25, cache = new Map<string, number>();
  return (x: number, z: number): number => {
    const key = `${Math.round(x / cell)},${Math.round(z / cell)}`;
    const hit = cache.get(key); if (hit !== undefined) return hit;
    const h = field.height(x, z);
    let y = h + 0.5;
    for (const stop = h - depth; y > stop && field.density(x, y, z) > 0; y -= step);
    const g = Math.min(h, y);
    cache.set(key, g); return g;
  };
}

/**
 * The ground a landmark bake trims "buried" geometry against. `field.height` is the heightfield; carves (passages, face
 * cuts, a wall-ramp's cut) only live in the density, so a part seated on a carved floor sat up to metres "under" the
 * heightfield and the buried trim dropped it (FIX-HW4: the weep-chute-head's tipping stone and most of its trough, seated
 * in the Sexton's Stair cut, were baked away). The trim reference is the LOWER of the heightfield and the WALKED ground
 * (tools/_ground.mts, the one ground source of placers and gates), cached per 0.25 m column.
 */
import { walkGround } from "./_ground.mts";

export interface GroundField { height(x: number, z: number): number; density(x: number, y: number, z: number): number }

export function visibleGround(field: GroundField, opts: { step?: number; depth?: number; cell?: number } = {}) {
  const depth = opts.depth ?? 40, cell = opts.cell ?? 0.25, cache = new Map<string, number>(), walk = walkGround(field, depth);
  return (x: number, z: number): number => {
    const key = `${Math.round(x / cell)},${Math.round(z / cell)}`;
    const hit = cache.get(key); if (hit !== undefined) return hit;
    const g = Math.min(field.height(x, z), walk(x, z));
    cache.set(key, g); return g;
  };
}

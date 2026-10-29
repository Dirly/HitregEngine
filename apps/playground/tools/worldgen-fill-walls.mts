/**
 * Filled hollows must read as ground (2026-10-29 redstrand w5-ground): a lake basin the settle filled (`worldgen rivers`,
 * LAKE_SETTLE_MAX_DROP) stood as a 56 m plate on a 36 m vertical wall — the sea cliff that was its rim had been cleared
 * round it (a big fill and an inland town were sea-cliff obstacles), and the cleared ring painted as a striped floor.
 * A hollow's rim is at or over its level everywhere but at its outlet, so ground FILL_WALL_DROP_M under the fill just
 * outside its bank is a wall the field made, not a slope. This measures it on the solved field, for the `rivers` row.
 */
import type { WorldField, WorldRecipe } from "@hitreg/core";

/** Ground this far under the fill level, just past its bank, is a wall (a 12 m bank cannot grade it). */
export const FILL_WALL_DROP_M = 10;
/** Outline metres standing on such a wall before the fill fails (the outlet's notch and a corner or two pass). */
export const FILL_WALL_MAX_M = 40;
/** Outline sampling step (m) and how far past the bank the ground is read (m). */
const STEP_M = 8;
const PAST_BANK_M = 6;

export interface FillWall { id: string; metres: number; worstDrop: number; at: [number, number] | null }

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

/** Every hydrology fill (tag `hollow`, or a `fill-N` id) whose outline stands on more than FILL_WALL_MAX_M of wall. */
export function fillWalls(recipe: WorldRecipe, field: WorldField): FillWall[] {
  const rivers = field.rivers.filter((r) => r.points.length > 1);
  const nearRiver = (x: number, z: number): boolean => rivers.some((r) => {
    const reach = (r.width ?? 8) / 2 + (r.bank ?? 8) + 20;
    for (let i = 1; i < r.points.length; i++) {
      const [ax, az] = r.points[i - 1]!, [bx, bz] = r.points[i]!;
      if (distToSegment(x, z, ax, az, bx, bz) < reach) return true;
    }
    return false;
  });
  const out: FillWall[] = [];
  for (const fill of recipe.features.fills) {
    if (!fill.tags.includes("hollow") && !/^fill-\d+$/.test(fill.id)) continue;
    const poly = fill.polygon;
    let area = 0;
    for (let i = 0; i < poly.length; i++) { const [ax, az] = poly[i]!, [bx, bz] = poly[(i + 1) % poly.length]!; area += ax * bz - bx * az; }
    const sign = area > 0 ? 1 : -1; // outward normal of edge (dx, dz) is (dz, -dx) * sign for a CCW (area > 0) loop
    let metres = 0, worst = 0;
    let at: [number, number] | null = null;
    for (let i = 0; i < poly.length; i++) {
      const [ax, az] = poly[i]!, [bx, bz] = poly[(i + 1) % poly.length]!;
      const len = Math.hypot(bx - ax, bz - az);
      if (len <= 0) continue;
      const nx = ((bz - az) / len) * sign, nz = (-(bx - ax) / len) * sign;
      for (let s = STEP_M / 2; s < len; s += STEP_M) {
        const x = ax + ((bx - ax) * s) / len + nx * (fill.bank + PAST_BANK_M);
        const z = az + ((bz - az) * s) / len + nz * (fill.bank + PAST_BANK_M);
        const drop = fill.y - field.height(x, z);
        if (drop <= FILL_WALL_DROP_M) continue;
        const w = field.waterY(x, z);
        if ((w !== null && w > field.height(x, z) - 0.5) || field.height(x, z) < recipe.seaLevel + 1) continue; // a lake or the sea beside it is a shore, not a wall
        if (nearRiver(x, z)) continue; // the outlet notch
        metres += Math.min(STEP_M, len - s + STEP_M / 2);
        if (drop > worst) { worst = drop; at = [Math.round(x), Math.round(z)]; }
      }
    }
    if (metres > FILL_WALL_MAX_M) out.push({ id: fill.id, metres: Math.round(metres), worstDrop: Math.round(worst * 10) / 10, at });
  }
  return out;
}

export function describeFillWalls(walls: FillWall[]): string {
  return walls.map((w) => `${w.id} stands on ${w.metres} m of wall (to ${w.worstDrop} m under its level${w.at ? ` at ${w.at.join(",")}` : ""})`).join("; ");
}

/** The ground window a town's walk grids cover (town-layout door access): the pad (radius + falloff) AND every terrace
 *  (a lot terrace can stand well outside the pad — a hamlet's riverside sheds), each terrace point grown by its radius
 *  (at most 40 m), then a 40 m margin. Returns [x0, z0, x1, z1] in world metres. */
export function walkGridBox(town: { center: [number, number]; radius: number; falloff?: number; terraces?: { points: [number, number][]; radius?: number }[] }): [number, number, number, number] {
  const R0 = town.radius + (town.falloff ?? 0);
  let [x0, z0, x1, z1] = [town.center[0] - R0, town.center[1] - R0, town.center[0] + R0, town.center[1] + R0];
  for (const t of town.terraces ?? []) for (const p of t.points) {
    const r = Math.min(t.radius ?? 0, 40);
    x0 = Math.min(x0, p[0] - r); z0 = Math.min(z0, p[1] - r); x1 = Math.max(x1, p[0] + r); z1 = Math.max(z1, p[1] + r);
  }
  return [x0 - 40, z0 - 40, x1 + 40, z1 + 40];
}

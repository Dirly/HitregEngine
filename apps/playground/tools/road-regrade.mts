/**
 * road-regrade — re-sample the embankment side heights (`leftY` / `rightY`) of every road over one area,
 * against the ground as it is NOW.
 *
 *   npx tsx tools/road-regrade.mts --project voxel-demo --world mmo --at 4105,-2170 --radius 22 [--dry]
 *
 * `worldgen paths` samples each road's side heights once, from the ground it saw then, and the field
 * applies roads AFTER towns and terraces. So a terrace (or any town-pipeline fix) laid over a road later is
 * rebuilt by the road's own embankment: the bank climbs back to the height the old ground had — a rib of
 * rock beside a gate that no terrace can remove. This re-takes those samples for the road points inside
 * the circle, with the same blur and band as the paths stage, from a field built WITHOUT the roads being
 * regraded (a road does not sample its own embankment). Points outside the circle keep their values.
 */
import fs from "node:fs";
import path from "node:path";
import { createWorldField, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const file = path.resolve("projects", opt("project", "voxel-demo"), "assets/worlds", `${opt("world", "mmo")}.json`);
const [ax, az] = opt("at", "").split(",").map(Number) as [number, number];
const radius = Number(opt("radius", "20"));
if (!Number.isFinite(ax) || !Number.isFinite(az)) {
  console.error("usage: road-regrade --project <p> --world <w> --at x,z --radius <m> [--dry]");
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(file, "utf8"));
const recipe: WorldRecipe = worldRecipeSchema.parse(raw);
const inside = (p: [number, number]): boolean => Math.hypot(p[0] - ax, p[1] - az) <= radius;
const touched = recipe.features.roads.filter((r) => r.points.some(inside) && r.leftY && r.rightY);
if (touched.length === 0) {
  console.log("no graded road inside the circle");
  process.exit(0);
}
const ids = new Set(touched.map((r) => r.id));
const bare = createWorldField({ ...recipe, features: { ...recipe.features, roads: recipe.features.roads.filter((r) => !ids.has(r.id)) } });
const round = (v: number): number => Math.round(v * 100) / 100;
for (const road of raw.features.roads as { id: string; points: [number, number][]; width: number; shoulder: number; smooth: number; leftY?: number[]; rightY?: number[] }[]) {
  if (!ids.has(road.id)) continue;
  const outer = road.width / 2 + road.shoulder + road.smooth;
  const blurRadius = road.smooth * 0.5;
  const blurred = (x: number, z: number): number =>
    (bare.height(x, z) + bare.height(x + blurRadius, z) + bare.height(x - blurRadius, z) + bare.height(x, z + blurRadius) + bare.height(x, z - blurRadius)) / 5;
  const changes: string[] = [];
  const pts = road.points;
  for (let k = 0; k < pts.length; k++) {
    if (!inside(pts[k]!)) continue;
    const prev = pts[Math.max(0, k - 1)]!;
    const next = pts[Math.min(pts.length - 1, k + 1)]!;
    let dx = next[0] - prev[0];
    let dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const p = pts[k]!;
    const l = round(blurred(p[0] - dz * outer, p[1] + dx * outer));
    const r = round(blurred(p[0] + dz * outer, p[1] - dx * outer));
    changes.push(`#${k} L ${road.leftY![k]}→${l} R ${road.rightY![k]}→${r}`);
    road.leftY![k] = l;
    road.rightY![k] = r;
  }
  console.log(`${road.id}: ${changes.join(", ")}`);
}
if (argv.includes("--dry")) process.exit(0);
worldRecipeSchema.parse(raw);
fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
console.log(`wrote ${path.relative(process.cwd(), file)}`);

/* scratch: audit river mouths / lake connections in a world recipe */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";

const file = process.argv[2] ?? "projects/voxel-demo/assets/worlds/voxel-demo.json";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
const field = createWorldField(recipe);
const rivers = recipe.features.rivers;
const lakes = recipe.features.lakes;

type P = [number, number];
function inside(poly: readonly P[], x: number, z: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
function segDist(p: P, a: P, b: P): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l = dx * dx + dz * dz;
  const t = l < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
}
function polyDist(poly: readonly P[], p: P, closed: boolean): number {
  let best = Infinity;
  const n = closed ? poly.length : poly.length - 1;
  for (let i = 0; i < n; i++) best = Math.min(best, segDist(p, poly[i]!, poly[(i + 1) % poly.length]!));
  return best;
}

const counts: Record<string, number> = {};
const lines: string[] = [];
for (const r of rivers) {
  const pts = r.points as P[];
  const last = pts[pts.length - 1]!;
  const bed = r.bedY![r.bedY!.length - 1]!;
  const surface = bed + Math.max(0.4, r.depth * 0.7);
  const natural = field.naturalHeight(last[0], last[1]);
  const carved = field.height(last[0], last[1]);
  let lakeIn: string | null = null;
  let nearLake = Infinity;
  let nearLakeId = "";
  let nearLakeY = NaN;
  for (const l of lakes) {
    const poly = l.polygon as P[] | undefined;
    if (!poly) continue;
    if (inside(poly, last[0], last[1])) lakeIn = l.id;
    const d = polyDist(poly, last, true);
    if (d < nearLake) {
      nearLake = d;
      nearLakeId = l.id;
      nearLakeY = l.waterY;
    }
  }
  let nearRiver = Infinity;
  let nearRiverId = "";
  let nearRiverSurface = NaN;
  for (const o of rivers) {
    if (o === r) continue;
    const d = polyDist(o.points as P[], last, false);
    if (d < nearRiver) {
      nearRiver = d;
      nearRiverId = o.id;
      // surface of the other river at its nearest point (approx: nearest control point)
      let bi = 0;
      let bd = Infinity;
      (o.points as P[]).forEach((p, i) => {
        const dd = Math.hypot(p[0] - last[0], p[1] - last[1]);
        if (dd < bd) {
          bd = dd;
          bi = i;
        }
      });
      nearRiverSurface = o.bedY![bi]! + Math.max(0.4, o.depth * 0.7);
    }
  }
  const sea = natural < recipe.seaLevel;
  let kind: string;
  let note = "";
  if (sea) kind = "sea";
  else if (lakeIn) {
    kind = "lake";
    const l = lakes.find((x) => x.id === lakeIn)!;
    note = `surface ${surface.toFixed(1)} vs lake ${l.waterY} (d ${(surface - l.waterY).toFixed(1)})`;
  } else if (nearRiver < 12) {
    kind = "confluence";
    note = `${nearRiverId} @${nearRiver.toFixed(0)}m surface ${surface.toFixed(1)} vs ${nearRiverSurface.toFixed(1)}`;
  } else if (nearLake < 40) {
    kind = "near-lake";
    note = `${nearLakeId} ${nearLake.toFixed(0)}m outside, surface ${surface.toFixed(1)} vs lake ${nearLakeY}`;
  } else {
    kind = "DANGLING";
    note = `nearest lake ${nearLakeId} ${nearLake.toFixed(0)}m, river ${nearRiverId} ${nearRiver.toFixed(0)}m, ground ${carved.toFixed(1)} surface ${surface.toFixed(1)}`;
  }
  counts[kind] = (counts[kind] ?? 0) + 1;
  // does the river start in a lake (an outlet)?
  const first = pts[0]!;
  const startsIn = lakes.find((l) => l.polygon && inside(l.polygon as P[], first[0], first[1]))?.id;
  // ribbon-head: taper/2 along
  lines.push(`${r.id.padEnd(9)} ${kind.padEnd(10)} ${note}${startsIn ? `  [starts in ${startsIn}]` : ""}`);
}
console.log(lines.join("\n"));
console.log(counts);

// uphill surface steps along each river (bedY is monotone by construction; surfaces should be too)
let uphill = 0;
let outletsFlush = 0;
let outletsOff = 0;
for (const r of rivers) {
  for (let i = 0; i + 1 < r.bedY!.length; i++) if (r.bedY![i + 1]! > r.bedY![i]! + 1e-6) uphill++;
  const first = r.points[0] as P;
  const l = lakes.find((l) => l.polygon && inside(l.polygon as P[], first[0], first[1]));
  if (l) {
    const s = r.bedY![0]! + Math.max(0.4, r.depth * 0.7);
    if (Math.abs(s - l.waterY) < 0.5) outletsFlush++;
    else {
      outletsOff++;
      console.log(`  outlet ${r.id} from ${l.id}: surface ${s.toFixed(1)} vs lake ${l.waterY}, taper ${r.taper}`);
    }
  }
}
console.log(`uphill bed steps: ${uphill}; lake outlets flush: ${outletsFlush}, off: ${outletsOff}`);

// towns under water?
for (const t of recipe.features.towns) {
  const w = field.waterY(t.center[0], t.center[1]);
  const g = t.groundY ?? field.height(t.center[0], t.center[1]);
  if (w !== null && g < w) console.log(`  TOWN ${t.id} at ${t.center} ground ${g} under water ${w}`);
}
// roads under water (deeper than 0.6)
let wetRoad = 0;
for (const road of recipe.features.roads) {
  const ys = road.surfaceY ?? [];
  road.points.forEach((p, i) => {
    const w = field.waterY(p[0], p[1]);
    const y = ys[i] ?? field.height(p[0], p[1]);
    if (w !== null && y < w - 0.6) wetRoad++;
  });
}
console.log(`road points under water by >0.6 m: ${wetRoad}`);

// Lake outlines: ground at the polygon vertices vs the water
console.log("\nlakes: outline ground vs waterY (natural / carved)");
for (const l of lakes) {
  const poly = l.polygon as P[];
  let above = 0;
  let below = 0;
  let maxAbove = 0;
  for (const p of poly) {
    const g = field.naturalHeight(p[0], p[1]);
    const d = g - l.waterY;
    if (d > 1.5) {
      above++;
      maxAbove = Math.max(maxAbove, d);
    }
    if (d < -1.5) below++;
  }
  const inflow = rivers.filter((r) => inside(poly, r.points[r.points.length - 1]![0], r.points[r.points.length - 1]![1])).length;
  const outflow = rivers.filter((r) => inside(poly, r.points[0]![0], r.points[0]![1])).length;
  const cg = field.height(l.center[0], l.center[1]);
  console.log(
    `${l.id.padEnd(8)} y ${String(l.waterY).padEnd(7)} pts ${String(poly.length).padEnd(4)} r ${String(l.radius).padEnd(6)} outline: ${above}/${poly.length} >1.5 above (max ${maxAbove.toFixed(1)}), ${below} <1.5 below; in ${inflow} out ${outflow}; centre ground ${cg.toFixed(1)}`,
  );
}

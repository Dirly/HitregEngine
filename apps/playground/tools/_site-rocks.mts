/* scratch: fall-site rock bedding (hand rocks + walls dressing) measured against the meshed surface.
   npx tsx tools/_site-rocks.mts [siteId] [wallsJson]   (ROWS=1 lists hand rocks) */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
import {
  meshDensity, ruleExtent, standSiteRocks, wallRocks, wallSamples, rockBedding, rockCovers, siteBox, rimExposure, rockSupport, RockIndex, screeRejects,
  type WallRock,
} from "../../../packages/core/src/voxel/fall-site-rocks.ts";

const siteId = process.argv[2] ?? "site-river-15-21";
const json = JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8"));
const wallsArg = process.argv[3] ? JSON.parse(process.argv[3]) : { rule: "rock-medium" };
const raw = json.features.fallSites.find((s: { id: string }) => s.id === siteId);
raw.walls = wallsArg;
const recipe = worldRecipeSchema.parse(json);
const field = createWorldField(recipe);
const site = recipe.features.fallSites.find((s) => s.id === siteId)!;
let t = performance.now();
const md = meshDensity(field, siteBox(field, site));
console.log(`prefetch ${(performance.now() - t).toFixed(0)} ms`);

function report(label: string, rocks: (WallRock | null)[]): void {
  let floatC = 0, floatF = 0, buried = 0, dropped = 0;
  const rows: string[] = [];
  rocks.forEach((r, n) => {
    const rock = site.rocks[n]!;
    if (!r) { dropped++; rows.push(`${rock.at.join(",")} DROPPED`); return; }
    const b = rockBedding(md, r);
    const resting = rock.lift <= 0.3;
    if (resting && b.centreHang > 0.3) floatC++;
    if (resting && b.hang > 0.3) floatF++;
    if (b.buried) buried++;
    rows.push(`${rock.at.join(",")} lift ${rock.lift} y ${r.position[1].toFixed(2)} (height ${field.height(rock.at[0], rock.at[1]).toFixed(2)}) centreHang ${b.centreHang.toFixed(2)} hang ${b.hang.toFixed(2)} buried ${b.buried}`);
  });
  console.log(`\n[${label}] hand rocks ${site.rocks.length}: floating centre>0.3 ${floatC}, floating footprint>0.3 ${floatF}, buried ${buried}, dropped ${dropped}`);
  if (process.env.ROWS) console.log(rows.join("\n"));
}
const before = site.rocks.map((rock, n) => {
  const rule = recipe.scatter.find((s) => s.id === rock.rule)!;
  return {
    id: `b${n}`, rule: rule.id, ruleIndex: 0, scale: rock.scale,
    position: [rock.at[0], field.height(rock.at[0], rock.at[1]) + rock.lift + rule.yOffset * rock.scale, rock.at[1]] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
    X: [Math.cos(rock.yaw), 0, -Math.sin(rock.yaw)] as [number, number, number], N: [0, 1, 0] as [number, number, number],
    Z: [Math.sin(rock.yaw), 0, Math.cos(rock.yaw)] as [number, number, number], extent: ruleExtent(rule),
  } satisfies WallRock;
});
report("before", before);
const after = standSiteRocks(md, field, site);
report("after", after);

t = performance.now();
const rocks = wallRocks(field, md, site);
console.log(`\nwalls solve ${(performance.now() - t).toFixed(0)} ms, rocks ${rocks.length}`);
let floating = 0, floatingC = 0, buried = 0, overRim = 0;
const scales: number[] = [];
for (const r of rocks) {
  if (rimExposure(md, r) > 0.3) overRim++;
  const b = rockBedding(md, r);
  if (b.hang > 0.3) floating++;
  if (b.centreHang > 0.3) floatingC++;
  if (b.buried) buried++;
  scales.push(r.scale);
}
{ const idx = new RockIndex(); for (const r of rocks) idx.add(r); const st: Record<string, number> = {}; for (const r of rocks) { const k = rockSupport(md, r, idx); st[k] = (st[k] ?? 0) + 1; } console.log('walls support:', JSON.stringify(st)); }
console.log("rejects", JSON.stringify(screeRejects));
console.log(`walls: top over rim >0.3 ${overRim}, floating footprint>0.3 ${floating}, floating centre>0.3 ${floatingC}, buried ${buried}, scale ${Math.min(...scales).toFixed(2)}..${Math.max(...scales).toFixed(2)}`);
const fine = wallSamples(field, md, site, 0.7);
let cov = 0;
for (const q of fine) if (rocks.some((r) => rockCovers(r, [q.x, q.y, q.z], 1))) cov++;
console.log(`coverage of steep wall samples (0.7 m grid): ${cov}/${fine.length} = ${((100 * cov) / fine.length).toFixed(1)} %`);
// exposed downward-facing box area (what reads as a dark underside) and strata alignment
let downArea = 0, outerArea = 0, dipSum = 0;
for (const r of rocks) {
  if (process.env.REGION && !(r.position[0] < 5350 && r.position[1] > 50)) continue;
  const [ex, ey, ez] = r.extent.map((v) => v * r.scale) as [number, number, number];
  const faces: [number[], number, number, number, number[], number[]][] = [
    // [normal (local), offset along it, half-size u, half-size v, u axis, v axis]
    [[0, 1, 0], ey, ex / 2, ez / 2, [1, 0, 0], [0, 0, 1]],
    [[1, 0, 0], ex / 2, ey / 2, ez / 2, [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], ex / 2, ey / 2, ez / 2, [0, 1, 0], [0, 0, 1]],
    [[0, 0, 1], ez / 2, ex / 2, ey / 2, [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], ez / 2, ex / 2, ey / 2, [1, 0, 0], [0, 1, 0]],
    [[0, -1, 0], 0, ex / 2, ez / 2, [1, 0, 0], [0, 0, 1]],
  ];
  const W = (l: number[]) => [0, 1, 2].map((i) => r.X[i]! * l[0]! + r.N[i]! * l[1]! + r.Z[i]! * l[2]!);
  for (const [n, off, hu, hv, ua, va] of faces) {
    const nw = W(n);
    // box centre is at ey/2 up the local Y axis
    const centreL = [n[0]! * off, n[1] === 0 ? ey / 2 : n[1]! > 0 ? ey : 0, n[2]! * off];
    let exposed = 0;
    for (const a of [-0.8, 0, 0.8]) for (const b of [-0.8, 0, 0.8]) {
      const l = [0, 1, 2].map((i) => centreL[i]! + ua[i]! * a * hu + va[i]! * b * hv);
      const w = W(l);
      if (!md.solid(r.position[0] + w[0]! + nw[0]! * 0.05, r.position[1] + w[1]! + nw[1]! * 0.05, r.position[2] + w[2]! + nw[2]! * 0.05)) exposed++;
    }
    const area = (exposed / 9) * 4 * hu * hv;
    outerArea += area;
    if (nw[1]! < -0.15) downArea += area;
  }
  dipSum += Math.abs(r.Z[1]);
}
console.log(`exposed rock area ${outerArea.toFixed(0)} m2, of it facing down (n.y < -0.15): ${downArea.toFixed(0)} m2 = ${((100 * downArea) / outerArea).toFixed(1)} %; mean |long-axis dip| ${(dipSum / rocks.length).toFixed(2)}`);
let inWater = 0;
for (const r of rocks) {
  const w = field.waterY(r.position[0], r.position[2]);
  if (w !== null && r.position[1] + r.extent[1] * r.scale * 0.5 < w - 1) inWater++;
}
console.log(`rocks whose middle is >1 m under water: ${inWater}`);
if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify(rocks.map((r) => ({ p: r.position, q: r.rotation, s: r.scale }))));

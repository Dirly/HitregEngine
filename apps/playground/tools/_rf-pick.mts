/* scratch (rock formations variant): what is at screen pixels of a review shot? rays through the shot's camera vs meshed terrain + site rock boxes.
   npx tsx tools/_site-rocks-pick.mts <views.json> <viewName> x0 y0 x1 y1 [step] */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema, fallSiteRockInstances, createVolume } from "@hitreg/core";
import { meshDensity, siteBox, ruleExtent } from "../../../packages/core/src/voxel/fall-site-rocks.ts";
const [viewsFile, viewName, sx0, sy0, sx1, sy1, sstep] = process.argv.slice(2);
const view = JSON.parse(fs.readFileSync(viewsFile!, "utf8")).find((v: { name: string }) => v.name === viewName);
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const site = recipe.features.fallSites.find((s) => s.id === "site-river-15-21")!;
const md = meshDensity(field, siteBox(field, site));
const vol = createVolume(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/volumes/rock-site-river-15-21.json", "utf8")));
type V = [number, number, number];
const rot = (q: number[], v: V): V => { const [x, y, z, w] = q as [number, number, number, number]; const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]); return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)]; };
const rocks = fallSiteRockInstances(field, site).map((r) => ({ ...r, X: rot(r.rotation, [1, 0, 0]), N: rot(r.rotation, [0, 1, 0]), Z: rot(r.rotation, [0, 0, 1]), e: ruleExtent(recipe.scatter[r.ruleIndex]!) }));
const W = 1280, H = 800, fov = (60 * Math.PI) / 180;
const c: V = view.cam, t: V = view.target;
const norm = (a: V): V => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const f = norm([t[0] - c[0], t[1] - c[1], t[2] - c[2]]), r = norm(cross(f, [0, 1, 0])), u = cross(r, f);
const th = Math.tan(fov / 2), ta = th * (W / H);
const step = Number(sstep ?? 20);
const tally = new Map<string, number>();
for (let py = Number(sy0); py <= Number(sy1); py += step) {
  const row: string[] = [];
  for (let px = Number(sx0); px <= Number(sx1); px += step) {
    const nx = ((px + 0.5) / W) * 2 - 1, ny = 1 - ((py + 0.5) / H) * 2;
    const d = norm([f[0] + r[0] * nx * ta + u[0] * ny * th, f[1] + r[1] * nx * ta + u[1] * ny * th, f[2] + r[2] * nx * ta + u[2] * ny * th]);
    let hit = "sky";
    for (let s = 1; s < 400; s += 0.1) {
      const p: V = [c[0] + d[0] * s, c[1] + d[1] * s, c[2] + d[2] * s];
      const rk = rocks.find((o) => {
        const dx = p[0] - o.position[0], dy = p[1] - o.position[1], dz = p[2] - o.position[2];
        const lx = (dx * o.X[0] + dy * o.X[1] + dz * o.X[2]) / o.scale, ly = (dx * o.N[0] + dy * o.N[1] + dz * o.N[2]) / o.scale, lz = (dx * o.Z[0] + dy * o.Z[1] + dz * o.Z[2]) / o.scale;
        return Math.abs(lx) < o.e[0] * 0.4 && ly > 0 && ly < o.e[1] * 0.9 && Math.abs(lz) < o.e[2] * 0.4;
      });
      if (rk) { const facing = -(d[0] * rk.N[0] + d[1] * rk.N[1] + d[2] * rk.N[2]); hit = `${rk.id.replace("site-river-15-21-", "")}(Ny ${rk.N[1].toFixed(2)} view·N ${facing.toFixed(2)} s ${rk.scale.toFixed(1)}) @${p.map((v) => v.toFixed(0)).join(",")}`; break; }
      if (vol.density(p[0], p[1], p[2]) < 0) { hit = `formation @${p.map((v) => v.toFixed(0)).join(",")} terrainSolid ${md.solid(p[0], p[1], p[2])}`; break; }
      if (md.solid(p[0], p[1], p[2])) { const n = md.normal(p[0], p[1], p[2]); hit = `terrain n(${n.map((v) => v.toFixed(2)).join(",")}) @${p.map((v) => v.toFixed(0)).join(",")}`; break; }
    }
    row.push(`${px},${py}: ${hit}`);
    const k = hit.split("(")[0]!.split(" ")[0]!;
    tally.set(k.startsWith("wall") ? "wall" : k.startsWith("rock") ? "hand" : k, (tally.get(k.startsWith("wall") ? "wall" : k.startsWith("rock") ? "hand" : k) ?? 0) + 1);
  }
  console.log(row.join("\n"));
}
console.log(tally);

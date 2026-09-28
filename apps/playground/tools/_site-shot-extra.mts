/* scratch: extra review views of a fall site + a ground clamp for the base views.
 *   npx tsx tools/_site-shot-extra.mts [river] [baseViewsJsonFile]
 * Prints explicit cameras [name, camX, camY, camZ, targetX, targetY, targetZ]:
 *   the base views from the file (explicit cameras) with each camera lifted to >= 2 m over ground/water,
 *   6-pool-eye: eye level on the water below the last fall, far enough back that every tier shows over the lower lips,
 *   7-hero: a 3/4 approach view (downstream side), picked from candidates by line of sight over terrain and trees. */
import fs from "node:fs";
import { createWorldField, scatterCell, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const river = process.argv[2] ?? "river-15";
const c = field.falls.filter((f) => f.river === river).sort((a, b) => b.top - a.top);
const top = c[0]!, bot = c[c.length - 1]!, h = top.top - bot.bottom;
const dx = bot.dirX, dz = bot.dirZ, px = -dz, pz = dx;
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
const surf = (x: number, z: number) => Math.max(field.surfaceCast(x, z, field.height(x, z) + 40, field.height(x, z) - 40) ?? field.height(x, z), field.waterSurface(x, z, ws) ? ws.y : -Infinity);
const views: (string | number)[][] = [];


// trees/rocks near the site, for the line-of-sight test (world XZ + a rough radius and height)
const S = recipe.cellSize;
const cx = (top.x + bot.x) / 2, cz = (top.z + bot.z) / 2;
const props: { x: number; z: number; y: number; r: number; h: number }[] = [];
for (let i = Math.floor((cx - 140) / S); i <= Math.floor((cx + 140) / S); i++) {
  for (let j = Math.floor((cz - 140) / S); j <= Math.floor((cz + 140) / S); j++) {
    for (const inst of scatterCell(field, i, j)) {
      const rule = recipe.scatter[inst.ruleIndex];
      const size = (rule as { colliderSize?: number[] } | undefined)?.colliderSize ?? [1, 2, 1];
      const tree = /tree|pine|oak|birch|fir|spruce|bush/i.test(inst.rule);
      props.push({ x: i * S + inst.position[0], z: j * S + inst.position[2], y: inst.position[1], r: tree ? 2.5 * inst.scale : (Math.max(size[0]!, size[2]!) / 2) * inst.scale, h: tree ? 10 * inst.scale : size[1]! * inst.scale });
    }
  }
}
/** Fraction of the ray camera -> target that is clear of terrain and props (samples every metre). */
function clear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const len = Math.hypot(bx - ax, by - ay, bz - az);
  const n = Math.ceil(len);
  let ok = 0;
  for (let k = 1; k < n - 2; k++) {
    const t = k / n, x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
    let hit = field.height(x, z) > y;
    if (!hit) for (const p of props) if (Math.abs(p.x - x) < p.r && Math.abs(p.z - z) < p.r && y > p.y && y < p.y + p.h && Math.hypot(p.x - x, p.z - z) < p.r) { hit = true; break; }
    if (!hit) ok++;
  }
  return ok / Math.max(1, n - 3);
}
// what a view must show: each tier's lip (top of its curtain) and its foot
const marks = c.flatMap((f) => [[f.x - f.dirX * 3, f.top, f.z - f.dirZ * 3], [f.x + f.dirX, f.bottom + 1, f.z + f.dirZ]] as [number, number, number][]);
const score = (x: number, y: number, z: number) => marks.reduce((s, m) => s + clear(x, y, z, m[0], m[1], m[2]), 0) / marks.length;

// base views: a camera inside the terrain renders the world's underside. Such a camera is lifted out, then on
// up in 3 m steps until it sees most of the tiers over the trees (at most 45 m). Cameras above ground are untouched.
if (process.argv[3]) {
  for (const [name, x, y, z, tx, ty, tz] of JSON.parse(fs.readFileSync(process.argv[3], "utf8")) as [string, ...number[]][]) {
    if (y! >= surf(x!, z!) + 2) { views.push([name, x!, y!, z!, tx!, ty!, tz!]); continue; }
    // buried: slide toward the target (out of the hillside) and/or up, cheapest move that sees >= 85 % of the marks
    let best: { x: number; y: number; z: number; cost: number; s: number } | null = null;
    for (let t = 0; t <= 0.6001; t += 0.1) {
      for (let lift = 0; lift <= 30; lift += 3) {
        const cx2 = x! + (tx! - x!) * t, cz2 = z! + (tz! - z!) * t;
        const cy2 = Math.max(y! + (ty! - y!) * t, surf(cx2, cz2) + 2) + lift;
        const s = score(cx2, cy2, cz2);
        const cost = t * 50 + lift + (s >= 0.85 ? 0 : 1000 * (1 - s));
        if (!best || cost < best.cost) best = { x: cx2, y: cy2, z: cz2, cost, s };
      }
    }
    views.push([name, best!.x, best!.y, best!.z, tx!, ty!, tz!]);
  }
}

// 6: on the water downstream of the last fall, eye height; walk back until the upper tiers clear the lower lips
let best6: { x: number; y: number; z: number; s: number } | null = null;
for (let back = 16; back <= 44; back += 4) {
  for (const side of [0, -4, 4]) {
    const x = bot.x + dx * back + px * side, z = bot.z + dz * back + pz * side;
    const y = surf(x, z) + 1.8;
    const s = score(x, y, z) - back * 0.002; // prefer close when equal
    if (!best6 || s > best6.s) best6 = { x, y, z, s };
  }
}
const mid = c[Math.floor(c.length / 2)]!;
views.push(["6-pool-eye", best6!.x, best6!.y, best6!.z, mid.x, bot.bottom + h * 0.45, mid.z]);

// 7: 3/4 approach from downstream, either side, 55-90 m out, standing on the ground + a third-person boom
let best7: { x: number; y: number; z: number; s: number } | null = null;
for (const side of [1, -1]) {
  for (const ang of [35, 45, 55]) {
    for (const dist of [55, 70, 90]) {
      const a = (ang * Math.PI) / 180;
      const ux = dx * Math.cos(a) + px * side * Math.sin(a), uz = dz * Math.cos(a) + pz * side * Math.sin(a);
      const x = cx + ux * dist, z = cz + uz * dist;
      const y = surf(x, z) + 4;
      const s = score(x, y, z) - Math.abs(ang - 45) * 0.001 - dist * 0.0005;
      if (!best7 || s > best7.s) best7 = { x, y, z, s };
    }
  }
}
views.push(["7-hero", best7!.x, best7!.y, best7!.z, cx, bot.bottom + h * 0.45, cz]);
console.error(`pool-eye line of sight ${(best6!.s * 100).toFixed(0)} %, hero ${(best7!.s * 100).toFixed(0)} %`);
console.log(JSON.stringify(views));

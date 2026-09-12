import fs from "node:fs";
import { createWorldField, worldRecipeSchema, scatterCell } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/voxel-demo.json", "utf8")));
const field = createWorldField(recipe);
const cell = recipe.cellSize;
const [ax, az] = [Number(process.argv[2]), Number(process.argv[3])];
const c0x = Math.floor(ax / cell);
const c0z = Math.floor(az / cell);
const out: { rule: string; p: [number, number, number]; s: number }[] = [];
for (let dx = -2; dx <= 2; dx++) {
  for (let dz = -2; dz <= 2; dz++) {
    const cx = c0x + dx, cz = c0z + dz;
    for (const i of scatterCell(field, cx, cz)) {
      out.push({ rule: i.rule, p: [cx * cell + i.position[0], i.position[1], cz * cell + i.position[2]], s: i.scale });
    }
  }
}
const by = new Map<string, number>();
for (const o of out) by.set(o.rule, (by.get(o.rule) ?? 0) + 1);
console.error([...by.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" "));
console.error(`ground at anchor: ${field.height(ax, az).toFixed(1)}`);
process.stdout.write(JSON.stringify(out));

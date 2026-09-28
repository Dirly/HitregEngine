/* scratch: cross-section of a river at a point: ground, natural ground and water across the channel */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";

const file = "projects/voxel-demo/assets/worlds/mmo.json";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
const field = createWorldField(recipe);
const [id, kStr] = process.argv[2]!.split("@");
const r = field.rivers.find((d) => d.id === id)!;
const k = Number(kStr);
const a = r.points[k]!;
const b = r.points[Math.min(k + 1, r.points.length - 1)]!;
const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
const nx = -(b[1] - a[1]) / len;
const nz = (b[0] - a[0]) / len;
const half = (r.widths ? r.widths[k]! : r.width) / 2;
const bank = Math.min(r.bank, 0.7 * half * 2 + 3);
console.log(`${id}[${k}] half ${half.toFixed(1)} bank ${bank.toFixed(1)} bed ${r.bedY![k]} surface ${r.surfaceY![k]} depth ${r.depths?.[k] ?? r.depth}`);
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
for (let o = -(half + bank * 1.1); o <= half + bank * 1.1; o += 2) {
  const x = a[0] + nx * o;
  const z = a[1] + nz * o;
  const ok = field.waterSurface(x, z, ws);
  const g = field.height(x, z);
  console.log(
    `${o.toFixed(1).padStart(6)} (${((Math.abs(o) - half) / bank).toFixed(2).padStart(5)} bank)  ground ${g.toFixed(2).padStart(7)}  natural ${field.naturalHeight(x, z).toFixed(2).padStart(7)}  water ${ok ? ws.y.toFixed(2) + " " + ws.kind : "-"}`,
  );
}

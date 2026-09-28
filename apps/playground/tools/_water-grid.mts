/* scratch: ASCII map of the water samples around a point: '.' dry, '~' water over ground, 'x' water refused (floor), 'o' no surface but ground under nearby water */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";

const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const [cx, cz] = process.argv[2]!.split(",").map(Number) as [number, number];
const R = Number(process.argv[3] ?? 40);
const S = field.voxelSize;
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
const rows: string[] = [];
for (let z = cz - R; z <= cz + R; z += S) {
  let line = "";
  for (let x = cx - R; x <= cx + R; x += S) {
    const gx = Math.round(x / S) * S;
    const gz = Math.round(z / S) * S;
    const g = field.height(gx, gz);
    if (!field.waterSurface(gx, gz, ws)) line += ".";
    else if (ws.kind === "river" && g < ws.floor - 3) line += "x";
    else if (ws.y + 0.35 - g > 0) line += ws.kind === "lake" ? "L" : String.fromCharCode(97 + (Math.floor(ws.y) % 26));
    else line += "-";
  }
  rows.push(line);
}
console.log(rows.join("\n"));
const p = (x: number, z: number): void => {
  const ok = field.waterSurface(x, z, ws);
  console.log(`[${x},${z}] ground ${field.height(x, z).toFixed(2)} ${ok ? `${ws.kind} y ${ws.y.toFixed(2)} floor ${ws.floor.toFixed(2)}` : "no surface"}`);
};
for (const arg of process.argv.slice(4)) {
  const [x, z] = arg.split(",").map(Number) as [number, number];
  p(x, z);
}

/* scratch: at each river-15 lip, the upper water mesh's extent ALONG the lip line vs the curtain's top row */
import fs from "node:fs";
import { createWorldField, voxelChunkDoc, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const falls = field.falls.filter((f) => f.river === (process.argv[2] ?? "river-15")).sort((a, b) => b.top - a.top);
const size = recipe.cellSize;
const docs = new Map<string, ReturnType<typeof voxelChunkDoc>>();
const doc = (cx: number, cz: number) => { const k = `${cx},${cz}`; if (!docs.has(k)) docs.set(k, voxelChunkDoc(field, "mmo", cx, cz, { scatter: false, collision: false })); return docs.get(k)!; };
for (const [fi, fall] of falls.entries()) {
  const lx = fall.x - fall.dirX * 3.45, lz = fall.z - fall.dirZ * 3.45;
  let wLo = Infinity, wHi = -Infinity, cLo = Infinity, cHi = -Infinity;
  for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
    const cx = Math.floor(lx / size) + ox, cz = Math.floor(lz / size) + oz;
    for (const [id, e] of Object.entries(doc(cx, cz).entities)) {
      const m = e.components["mesh"] as { source: { kind: string; positions?: number[] } } | undefined;
      if (!m || m.source.kind !== "surface") continue;
      const P = m.source.positions!;
      for (let i = 0; i < P.length; i += 3) {
        const x = P[i]! + cx * size, y = P[i + 1]!, z = P[i + 2]! + cz * size;
        const along = (x - lx) * fall.dirX + (z - lz) * fall.dirZ, across = -(x - lx) * fall.dirZ + (z - lz) * fall.dirX;
        if (Math.abs(across) > 30) continue;
        if (id.startsWith("water") && Math.abs(along) < 0.02 && Math.abs(y - fall.top) < 0.02) { wLo = Math.min(wLo, across); wHi = Math.max(wHi, across); }
        if (id.startsWith("fall_") && Math.abs(y - fall.top) < 0.02 && Math.abs(along) < 0.02) { cLo = Math.min(cLo, across); cHi = Math.max(cHi, across); }
      }
    }
  }
  console.log(`lip ${fi}: upper water on the lip line [${wLo.toFixed(2)}, ${wHi.toFixed(2)}]  curtain brink [${cLo.toFixed(2)}, ${cHi.toFixed(2)}]  uncovered: ${Math.max(0, cLo - wLo).toFixed(2)} m left, ${Math.max(0, wHi - cHi).toFixed(2)} m right`);
}

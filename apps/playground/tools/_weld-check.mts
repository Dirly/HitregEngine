/* scratch: at each river-15 lip, does the curtain's top row share the upper water's lip-edge vertices?
 * For every sheet vertex ON the lip line (world), the nearest curtain top-row vertex: position gap, current (uv) gap,
 * and the curtain top row's vertices that have NO sheet vertex (T-junction midpoints, collinear). Also the sheet's
 * second uv (side fade) vs the curtain's there. */
import fs from "node:fs";
import { createWorldField, voxelChunkDoc, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const falls = field.falls.filter((f) => f.river === (process.argv[2] ?? "river-15")).sort((a, b) => b.top - a.top);
const size = recipe.cellSize;
const docs = new Map<string, ReturnType<typeof voxelChunkDoc>>();
const doc = (cx: number, cz: number) => { const k = `${cx},${cz}`; if (!docs.has(k)) docs.set(k, voxelChunkDoc(field, "mmo", cx, cz, { scatter: false, collision: false })); return docs.get(k)!; };
type V = { x: number; y: number; z: number; u: number; v: number; a: number; b: number; along: number; across: number };
for (const [fi, fall] of falls.entries()) {
  const lx = fall.x - fall.dirX * 3.45, lz = fall.z - fall.dirZ * 3.45;
  const sheet: V[] = [], top: V[] = [];
  let curtainNY = 0;
  for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
    const cx = Math.floor(lx / size) + ox, cz = Math.floor(lz / size) + oz;
    for (const [id, e] of Object.entries(doc(cx, cz).entities)) {
      const m = e.components["mesh"] as { source: { kind: string; positions: number[]; uvs: number[]; uv1s?: number[] } } | undefined;
      if (!m || m.source.kind !== "surface") continue;
      const P = m.source.positions, U = m.source.uvs, U1 = m.source.uv1s;
      for (let i = 0; i < P.length / 3; i++) {
        const x = P[i * 3]! + cx * size, y = P[i * 3 + 1]!, z = P[i * 3 + 2]! + cz * size;
        const along = (x - lx) * fall.dirX + (z - lz) * fall.dirZ, across = -(x - lx) * fall.dirZ + (z - lz) * fall.dirX;
        if (Math.abs(across) > 30 || Math.abs(along) > 0.02 || Math.abs(y - fall.top) > 0.02) continue;
        const vv = { x, y, z, u: U[i * 2]!, v: U[i * 2 + 1]!, a: U1 ? U1[i * 2]! : NaN, b: U1 ? U1[i * 2 + 1]! : NaN, along, across };
        if (id.startsWith("water")) sheet.push(vv);
        else if (id.startsWith("fall_")) top.push(vv);
      }
    }
  }
  let worstP = 0, worstU = 0, worstA = 0, unmatched = 0;
  for (const s of sheet) {
    let best: V | null = null, bd = Infinity;
    for (const t of top) { const d = Math.hypot(t.x - s.x, t.y - s.y, t.z - s.z); if (d < bd) { bd = d; best = t; } }
    if (!best || bd > 0.05) { unmatched++; continue; }
    if (bd > 0.001 || Math.hypot(best.u - s.u, best.v - s.v) > 1e-6) console.log("   odd", JSON.stringify(s), "->", JSON.stringify(best));
    worstP = Math.max(worstP, bd); worstU = Math.max(worstU, Math.hypot(best.u - s.u, best.v - s.v)); worstA = Math.max(worstA, Math.abs(best.a - s.a));
  }
  const tMatched = top.filter((t) => sheet.some((s) => Math.hypot(t.x - s.x, t.z - s.z) < 0.05)).length;
  console.log(`lip ${fi}: sheet lip-edge verts ${sheet.length} (unmatched ${unmatched}), curtain top row ${top.length} (${tMatched} shared, rest collinear midpoints); worst position gap ${worstP.toFixed(4)} m, current gap ${worstU.toExponential(1)} m/s, fade-across gap ${worstA.toFixed(4)}; sheet uv1.y on the line ${[...new Set(sheet.map((s) => s.b))].join(",")}`);
  console.log(`   along of curtain top row: ${Math.max(...top.map((t) => Math.abs(t.along))).toFixed(4)}; sheet: ${Math.max(...sheet.map((t) => Math.abs(t.along))).toFixed(4)}`);
}

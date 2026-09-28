/* scratch: knife-edge ridges and pits the water features leave in the heightfield (vs the same ground without rivers/lakes) */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(process.argv[2] ?? "projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const dry = createWorldField({ ...recipe, features: { ...recipe.features, rivers: [], lakes: [], fills: [] } });
const S = field.voxelSize;
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
const centres: [number, number, string][] = [];
for (const f of field.falls) centres.push([f.x, f.z, "fall"]);
for (const r of field.rivers) for (let k = 0; k < r.points.length; k += 12) centres.push([r.points[k]![0], r.points[k]![1], "river"]);
for (const l of recipe.features.lakes) for (const p of (l.polygon ?? []).filter((_, i) => i % 12 === 0)) centres.push([p[0], p[1], "lake"]);
const R = 40;
const stats = new Map<string, { n: number; ridge: number; ridgeDry: number; steep: number; steepDry: number }>();
const ex: string[] = [];
const bins = new Map<string, number>();
const seen = new Set<string>();
for (const [cx, cz, why] of centres) {
  const st = stats.get(why) ?? { n: 0, ridge: 0, ridgeDry: 0, steep: 0, steepDry: 0 };
  for (let z = cz - R; z <= cz + R; z += S) for (let x = cx - R; x <= cx + R; x += S) {
    const gx = Math.round(x / S) * S, gz = Math.round(z / S) * S;
    const key = `${gx},${gz}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // only land: skip points under water
    if (field.waterSurface(gx, gz, ws) && ws.y > field.height(gx, gz)) continue;
    st.n++;
    for (const f of [field, dry]) {
      const h = f.height(gx, gz);
      let ridge = false;
      let steep = false;
      for (const [dx, dz] of [[1, 0], [0, 1], [1, 1], [1, -1]] as const) {
        const a = f.height(gx + dx * S * 2, gz + dz * S * 2);
        const b = f.height(gx - dx * S * 2, gz - dz * S * 2);
        // a crest standing 4 m over BOTH sides within 4 m: narrower than two voxels
        if (h - a > 4 && h - b > 4) ridge = true;
      }
      for (const [dx, dz] of [[1, 0], [0, 1]] as const) if (Math.abs(f.height(gx + dx * S, gz + dz * S) - h) > S * 2.5) steep = true;
      if (f === field) {
        if (ridge) { st.ridge++; if (why === "fall") { const f = field.falls.reduce((b, q) => (Math.hypot(q.x - gx, q.z - gz) < Math.hypot(b.x - gx, b.z - gz) ? q : b)); const rel = (gx - f.x) * f.dirX + (gz - f.z) * f.dirZ; const side = -(gx - f.x) * f.dirZ + (gz - f.z) * f.dirX; const bin = rel < -3 ? "above-lip" : rel < 12 ? "at-lip" : "gorge"; bins.set(bin, (bins.get(bin) ?? 0) + 1); if (ex.length < 8) ex.push(`${bin} rel ${rel.toFixed(0)} side ${side.toFixed(0)} h-top ${(h - f.top).toFixed(1)} w ${f.width.toFixed(0)}`); } }
        if (steep) st.steep++;
      } else {
        if (ridge) st.ridgeDry++;
        if (steep) st.steepDry++;
      }
    }
  }
  stats.set(why, st);
}
for (const [why, s] of stats) console.log(`${why}: ${s.n} land samples; knife ridges ${s.ridge} (natural ${s.ridgeDry}); steps > 2.5 voxels per voxel ${s.steep} (natural ${s.steepDry})`);
for (const e of ex) console.log("  " + e);
console.log(Object.fromEntries(bins));

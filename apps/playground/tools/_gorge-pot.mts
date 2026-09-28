/* scratch: potholes/spikes on the 2 m lattice around site-river-15-21: columns > 1.5 m under (or over) both neighbours on an axis */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const load = (off: boolean) => { const json = JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")); if (off) for (const s of json.features.fallSites) s.gorge = { enabled: false }; return createWorldField(worldRecipeSchema.parse(json)); };
for (const off of [true, false]) {
  const f = load(off); const H = new Map<string, number>(); const h = (x: number, z: number) => { const k = x + "," + z; let v = H.get(k); if (v === undefined) { v = f.height(x, z); H.set(k, v); } return v; };
  let pot = 0, spike = 0; const P: string[] = []; const S: string[] = [];
  for (let x = 5290; x <= 5430; x += 2) for (let z = -3950; z <= -3810; z += 2) {
    const c = h(x, z);
    for (const [ax, az] of [[2, 0], [0, 2], [2, 2], [2, -2]]) { const l = h(x - ax!, z - az!), r = h(x + ax!, z + az!);
      if (l - c > 1.5 && r - c > 1.5) { pot++; S.push(`p${x},${z}`); break; } if (c - l > 1.5 && c - r > 1.5) { spike++; S.push(`s${x},${z}`); break; } }
  }
  console.log(off ? "before" : "after", "potholes", pot, "spikes", spike); (globalThis as any)[off ? "B" : "A"] = S;
}
const Bs = new Set((globalThis as any).B); console.log("new:", ((globalThis as any).A as string[]).filter((k) => !Bs.has(k)).join(" "));

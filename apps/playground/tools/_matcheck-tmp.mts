import fs from "node:fs";
import * as core from "@hitreg/core";
const doc = JSON.parse(fs.readFileSync("projects/voxel-demo/assets/materials/terrain/voxel-demo.json", "utf8"));
const names = Object.keys(core).filter((k) => /material/i.test(k) && /schema/i.test(k));
console.log("schemas:", names.join(","));
for (const n of names) {
  const s = (core as any)[n];
  if (!s || typeof s.safeParse !== "function") continue;
  const r = s.safeParse(doc);
  console.log(n, r.success ? "OK" : JSON.stringify(r.error.issues.slice(0, 3)));
}
console.log("layers", doc.splat.layers.length, "filter", doc.filter, "MAX_SPLAT_LAYERS", (core as any).MAX_SPLAT_LAYERS);

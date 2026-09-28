/* scratch: rivers whose channels cross another river somewhere other than a chain join or a mouth */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const file = process.argv[2] ?? "projects/voxel-demo/assets/worlds/mmo.json";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
const field = createWorldField(recipe);
const rivers = field.rivers;
const base = (id: string): string => id.split(".")[0]!;
type P = readonly [number, number];
const inter = (a: P, b: P, c: P, d: P): [number, number] | null => {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0]! * s[1]! - r[1]! * s[0]!;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1]! - (c[1] - a[1]) * s[0]!) / den;
  const u = ((c[0] - a[0]) * r[1]! - (c[1] - a[1]) * r[0]!) / den;
  return t > 0 && t < 1 && u > 0 && u < 1 ? [t, u] : null;
};
let n = 0;
for (let i = 0; i < rivers.length; i++) {
  for (let j = i + 1; j < rivers.length; j++) {
    const A = rivers[i]!, B = rivers[j]!;
    if (base(A.id) === base(B.id)) continue;
    for (let a = 0; a + 1 < A.points.length; a++) {
      for (let b = 0; b + 1 < B.points.length; b++) {
        const hit = inter(A.points[a]!, A.points[a + 1]!, B.points[b]!, B.points[b + 1]!);
        if (!hit) continue;
        // a tributary ending on its trunk is a join, not a crossing
        const endA = a >= A.points.length - 3, endB = b >= B.points.length - 3;
        const ya = A.surfaceY![a]!, yb = B.surfaceY![b]!;
        const x = A.points[a]![0], z = A.points[a]![1];
        if ((endA || endB) && Math.abs(ya - yb) < 0.5) continue;
        n++;
        console.log(`${A.id}[${a}] x ${B.id}[${b}] at [${x.toFixed(0)},${z.toFixed(0)}] levels ${ya.toFixed(1)} / ${yb.toFixed(1)}${endA || endB ? " (at an end)" : ""}`);
      }
    }
  }
}
console.log(`${n} crossings`);

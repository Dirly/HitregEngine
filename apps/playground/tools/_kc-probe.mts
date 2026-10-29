import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
import { readPixels } from "./_place-quality.mts";
const recipe = JSON.parse(fs.readFileSync("projects/pb-knucklecrown/assets/worlds/pbknucklecrown.json", "utf8"));
const f = createWorldField(worldRecipeSchema.parse(recipe)); const g = { height: (x: number, z: number) => f.height(x, z) };
const xz = (q: number[]) => (q.length >= 3 ? [q[0], q[2]] : [q[0], q[1]]);
const roads = recipe.features.roads.filter((r: any) => /^path-town-1-site-crown(\.s\d+)?$/.test(r.id));
const pts: number[][] = roads.flatMap((r: any) => r.points.map(xz));
const lm = { at: [-318.66, 9.82] as [number, number], foot: 115.33, top: 140.33 };
const samples: number[][] = []; for (let i = 0; i + 1 < pts.length; i++) { const a = pts[i], b = pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5)); for (let k = 0; k < n; k++) samples.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]); }
for (const s of samples) { const e = f.height(s[0], s[1]) + 1.7; const r = readPixels(g, [s[0], e, s[1]], lm); const dc = Math.hypot(s[0] + 322, s[1] + 22); if (r.distance < 480 && r.distance > 150) console.log(s.map(Math.round).join(","), "dL", r.distance, "dC", Math.round(dc), "px", r.px, "wet", f.waterY(s[0], s[1]) !== null); }

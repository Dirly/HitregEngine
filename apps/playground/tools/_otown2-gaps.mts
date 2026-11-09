// o-town2 scratch: ground and roof (full) envelope gaps between named buildings of the lab design
import fs from "node:fs";
import { footprintOf } from "./town-design-check.mts";
import { townDesignSchema } from "./town-design-schema.mts";
const T = "projects/otown2-lab/authoring/towns";
const d = townDesignSchema.parse(JSON.parse(fs.readFileSync(`${T}/town-1-design.json`, "utf8"))), env = JSON.parse(fs.readFileSync(`${T}/town-1-envelopes.json`, "utf8"));
const segD = (p: number[], a: number[], b: number[]) => { const vx = b[0]! - a[0]!, vz = b[1]! - a[1]!; const u = Math.max(0, Math.min(1, ((p[0]! - a[0]!) * vx + (p[1]! - a[1]!) * vz) / (vx * vx + vz * vz || 1))); return Math.hypot(p[0]! - a[0]! - vx * u, p[1]! - a[1]! - vz * u); };
const gap = (P: number[][], Q: number[][]) => { let m = Infinity; for (const [A, B] of [[P, Q], [Q, P]]) for (const p of A!) for (let i = 0; i < B!.length; i++) m = Math.min(m, segD(p, B![i]!, B![(i + 1) % B!.length]!)); return m; };
for (const pair of process.argv.slice(2)) { const [a, b] = pair.split(":"); const A = d.buildings.find((x) => x.id === a)!, B = d.buildings.find((x) => x.id === b)!; const fa = footprintOf(d, A, env), fb = footprintOf(d, B, env); console.log(pair, "ground", gap(fa.ground, fb.ground).toFixed(2), "full", gap(fa.full, fb.full).toFixed(2)); }

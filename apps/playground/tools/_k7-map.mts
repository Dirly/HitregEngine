// k-town7 scratch (deleted when the round ends): ASCII plan of a town design, 2 m/char in the town's local (s up, t right)
import fs from "node:fs";
import { footprintOf } from "./town-design-check.mts";
type V2 = [number, number];
const [DF, EF] = process.argv.slice(2) as [string, string];
const d = JSON.parse(fs.readFileSync(DF, "utf8")), env = JSON.parse(fs.readFileSync(EF, "utf8"));
const C: V2 = [640, -368], U: V2 = [-Math.SQRT1_2, -Math.SQRT1_2], V: V2 = [Math.SQRT1_2, -Math.SQRT1_2];
const W = (s: number, t: number): V2 => [C[0] + s * U[0] + t * V[0], C[1] + s * U[1] + t * V[1]];
const inP = (P: V2[], x: number, z: number) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i]!, b = P[j]!; if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const segD = (p: V2, a: V2, b: V2) => { const vx = b[0] - a[0], vz = b[1] - a[1]; const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / (vx * vx + vz * vz || 1))); return Math.hypot(p[0] - a[0] - vx * u, p[1] - a[1] - vz * u); };
const fp = d.buildings.map((b: any) => ({ b, f: footprintOf(d, b, env) }));
const town = d.terraces.find((t: any) => t.id === "town").polygon, close = d.terraces.find((t: any) => t.id === "close").polygon;
const rows: string[] = []; let free = 0;
for (let s = 60; s >= -62; s -= 2) { let r = ""; for (let t = -62; t <= 62; t += 2) { const p = W(s, t);
  const hit = fp.findIndex((x: any) => inP(x.f.ground, p[0], p[1]));
  let ch = " ";
  if (hit >= 0) ch = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[hit % 62]!;
  else if (d.streets.some((st: any) => st.points.some((_: any, i: number) => i + 1 < st.points.length && segD(p, st.points[i], st.points[i + 1]) < st.width / 2))) ch = "=";
  else if (d.squares.some((q: any) => inP(q.polygon, p[0], p[1]))) ch = "+";
  else if (inP(close, p[0], p[1])) ch = "^";
  else if (inP(town, p[0], p[1])) { ch = "."; free++; }
  r += ch; } rows.push(r); }
console.log(rows.join("\n")); console.log(`free town floor ~${free * 4} m2; buildings ${fp.length}`);

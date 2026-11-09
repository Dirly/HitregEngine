// o-town2 scratch: every kit curtain piece's plan footprint against every building's FULL envelope (>= 0.5 m air)
import fs from "node:fs";
import { layKitWall, worldFootprint, type V2 } from "./_kit-wall.mts";
import { footprintOf } from "./town-design-check.mts";
const T = `projects/${process.env.PROJECT ?? "otown2-lab"}/authoring/towns`; // i-town2: PROJECT=redstrand for the live check
const d = JSON.parse(fs.readFileSync(`${T}/town-1-design.json`, "utf8")), env = JSON.parse(fs.readFileSync(`${T}/town-1-envelopes.json`, "utf8"));
const rec = JSON.parse(fs.readFileSync(`${T}/town-1-works/kit-wall.json`, "utf8"));
const lay = layKitWall(rec.line, { closed: rec.closed, towers: rec.towers, gates: rec.gates });
const segD = (p: V2, a: V2, b: V2) => { const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)); return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t); };
const inPoly = (pts: V2[], p: V2) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i]!, b = pts[j]!; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const gap = (A: V2[], B: V2[]) => { if (A.some((p) => inPoly(B, p)) || B.some((p) => inPoly(A, p))) return 0; let m = Infinity; for (let i = 0; i < A.length; i++) for (const p of B) m = Math.min(m, segD(p, A[i]!, A[(i + 1) % A.length]!)); for (let i = 0; i < B.length; i++) for (const p of A) m = Math.min(m, segD(p, B[i]!, B[(i + 1) % B.length]!)); return m; };
let worst = Infinity, bad = 0;
for (const b of d.buildings) { const f = footprintOf(d, b, env); for (const p of lay.pieces) for (const poly of worldFootprint(p)) { const g = gap(f.full as V2[], poly); if (g < worst) worst = g; if (g < 0.5) { bad++; console.log(`CLEAR ${b.id} ${p.prefab} ${g.toFixed(2)} m`); } } }
console.log(`wall clearance: worst ${worst.toFixed(2)} m, ${bad} under 0.5 m`);

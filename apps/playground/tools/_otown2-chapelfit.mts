// o-town2 scratch: does the live chapel model (current GLB) still sit on its close, clear of the curtain?
import fs from "node:fs";
const s = JSON.parse(fs.readFileSync("projects/redstrand/assets/scenes/redstrand.scene.json", "utf8"));
const m = JSON.parse(fs.readFileSync(process.env.TEMP + "/otown2/measure.json", "utf8"))["strand-chapel"];
const d = JSON.parse(fs.readFileSync("projects/redstrand/authoring/towns/town-1-design.json", "utf8"));
const kit = JSON.parse(fs.readFileSync("projects/redstrand/authoring/towns/town-1-works/kit-wall.json", "utf8"));
const e = s.entities["t1-chapel"]; const p = e.components.transform.position, q = e.components.transform.rotation; const yaw = 2 * Math.atan2(q[1], q[3]);
const c = Math.cos(yaw), sn = Math.sin(yaw);
const W = (x: number, z: number) => [p[0] + x * c + z * sn, p[2] - x * sn + z * c];
const ring = [[m.x[0], m.z[0]], [m.x[1], m.z[0]], [m.x[1], m.z[1]], [m.x[0], m.z[1]]].map(([x, z]) => W(x!, z!));
const close = d.terraces.find((t: any) => t.id === "close").polygon as number[][];
const inPoly = (poly: number[][], x: number, z: number) => { let h = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!; if (zi! > z !== zj! > z && x < ((xj! - xi!) * (z - zi!)) / (zj! - zi!) + xi!) h = !h; } return h; };
const segD = (pt: number[], a: number[], b: number[]) => { const vx = b[0]! - a[0]!, vz = b[1]! - a[1]!; const u = Math.max(0, Math.min(1, ((pt[0]! - a[0]!) * vx + (pt[1]! - a[1]!) * vz) / (vx * vx + vz * vz || 1))); return Math.hypot(pt[0]! - a[0]! - vx * u, pt[1]! - a[1]! - vz * u); };
const pts: number[][] = []; for (let i = 0; i < 4; i++) for (let k = 0; k <= 20; k++) { const a = ring[i]!, b = ring[(i + 1) % 4]!; pts.push([a[0]! + (b[0]! - a[0]!) * k / 20, a[1]! + (b[1]! - a[1]!) * k / 20]); }
const out = pts.filter((pt) => !inPoly(close, pt[0]!, pt[1]!)).length;
let edge = Infinity; for (const pt of pts) for (let i = 0; i < close.length; i++) edge = Math.min(edge, segD(pt, close[i]!, close[(i + 1) % close.length]!));
let wall = Infinity; for (const pt of pts) for (const pc of kit.placements) wall = Math.min(wall, Math.hypot(pt[0]! - pc.position[0], pt[1]! - pc.position[2]));
console.log(`chapel model ${(m.x[1] - m.x[0]).toFixed(2)} x ${(m.z[1] - m.z[0]).toFixed(2)}: ${out}/${pts.length} outline points OFF the close, nearest close edge ${edge.toFixed(2)} m, nearest curtain piece centre ${wall.toFixed(2)} m`);

// k-town2 scratch (deleted after use): where flat-a's body near the +x line has no face on the line
import { glbTriangles } from "./dress-sockets.mts";
const f = process.argv[2]; const line = 4.8;
const s = glbTriangles(f); const p = s.pos;
const near: number[][] = [], on: number[][] = [];
for (let o = 0; o < p.length; o += 9) {
  const xs = [p[o], p[o + 3], p[o + 6]], ys = [p[o + 1], p[o + 4], p[o + 7]], zs = [p[o + 2], p[o + 5], p[o + 8]];
  const box = [Math.min(...zs), Math.max(...zs), Math.min(...ys), Math.max(...ys), Math.min(...xs), Math.max(...xs)];
  if (xs.every((x) => Math.abs(x - line) < 0.01)) on.push(box);
  else if (Math.max(...xs) > line - 0.6 && Math.min(...ys) < 6.6 && Math.max(...ys) > 5.8 && Math.min(...zs) < -7.5) near.push(box);
}
console.log("ON-LINE faces (z0 z1 y0 y1) top band:", on.filter((b) => b[3] > 5.8).map((b) => b.slice(0, 4).map((v) => v.toFixed(2)).join(" ")).join(" | "));
console.log("near back band:", near.slice(0, 30).map((b) => b.map((v) => v.toFixed(2)).join(" ")).join("\n"));

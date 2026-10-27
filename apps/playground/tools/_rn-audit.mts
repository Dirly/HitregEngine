// ROADS-NET audit: every road touching Hagsheer -> class, width, grade, cut/fill actual, painted tile, endpoints, lips.
// usage (from apps/playground): npx tsx <this> <lips.json|-> <out.md> [<out.json>]
import fs from "node:fs";
import path from "node:path";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const W = "projects/skelmorrow/assets/worlds/skelmorrow.json";
const Z = "projects/skelmorrow/authoring/zonegen/skelmorrow/zones/hagsheer";
const [lipsFile, outMd, outJson] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(W, "utf8"));
const recipe = worldRecipeSchema.parse(raw);
const reg = raw.regions.find((g: any) => g.id === "hagsheer"); const P = reg.polygon as number[][];
const inside = (x: number, z: number) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, zi] = P[i]!, [xj, zj] = P[j]!; if ((zi! > z) !== (zj! > z) && x < ((xj! - xi!) * (z - zi!)) / (zj! - zi!) + xi!) c = !c; } return c; };
const lips: any[] = lipsFile && lipsFile !== "-" && fs.existsSync(lipsFile) ? JSON.parse(fs.readFileSync(lipsFile, "utf8")).owners ?? [] : [];
// places: core from handoff / brief
const places: { id: string; at: [number, number] }[] = [];
for (const d of fs.readdirSync(`${Z}/pois`)) {
  let at: any = null;
  for (const f of ["brief.json", "handoff.json", "reports/plan.json"]) { try { const j = JSON.parse(fs.readFileSync(`${Z}/pois/${d}/${f}`, "utf8")); at = j.site?.at ?? j.at ?? j.hub ?? j.location?.at ?? null; if (Array.isArray(at)) break; } catch {} }
  if (Array.isArray(at)) places.push({ id: d, at: [at[0], at.length === 3 ? at[2] : at[1]] });
}
const gates: { id: string; at: [number, number] }[] = [];
for (const t of raw.features.towns) for (const g of t.gates ?? []) gates.push({ id: `${t.id}/${g.id}`, at: g.at });
const roads = (raw.features.roads as any[]).filter((r) => r.points.some((p: number[]) => inside(p[0]!, p[1]!)) && !/-door-/.test(r.id));
const segD = (x: number, z: number, pts: number[][]) => { let d = Infinity; for (let i = 0; i + 1 < pts.length; i++) { const [ax, az] = pts[i]!, [bx, bz] = pts[i + 1]!; const dx = bx! - ax!, dz = bz! - az!, l2 = dx * dx + dz * dz || 1; const t = Math.max(0, Math.min(1, ((x - ax!) * dx + (z - az!) * dz) / l2)); d = Math.min(d, Math.hypot(x - ax! - dx * t, z - az! - dz * t)); } return d; };
const endName = (r: any, p: number[]) => {
  const g = gates.find((q) => Math.hypot(q.at[0] - p[0]!, q.at[1] - p[1]!) < 25); if (g) return `gate ${g.id}`;
  const pl = places.map((q) => ({ q, d: Math.hypot(q.at[0] - p[0]!, q.at[1] - p[1]!) })).sort((a, b) => a.d - b.d)[0];
  const rd = roads.concat(raw.features.roads.filter((x: any) => !roads.includes(x))).filter((x: any) => x.id !== r.id && !x.id.startsWith(r.id + ".") && !r.id.startsWith(x.id.split(".")[0] + ".") && !/-door-/.test(x.id)).map((x: any) => ({ x, d: segD(p[0]!, p[1]!, x.points) })).sort((a: any, b: any) => a.d - b.d)[0];
  const parts: string[] = [];
  if (rd && rd.d < 15) parts.push(`road ${rd.x.id}`);
  if (pl && pl.d < 90) parts.push(`place ${pl.q.id} (${pl.d.toFixed(0)} m)`);
  return parts.join(" + ") || `open ground (${rd ? `${rd.x.id} ${rd.d.toFixed(0)} m` : ""}${pl ? `; ${pl.q.id} ${pl.d.toFixed(0)} m` : ""})`;
};
const klass = (r: any) => r.id.startsWith("town-") ? "street" : r.width >= 6 ? "trunk" : r.width >= 4.5 ? "place road" : "footpath";
const tile = (r: any) => {
  const role = r.role ?? "road";
  if (role === "paving") return reg.ground.paving;
  if (role === "none") return r.surface;
  return reg.ground.road ?? r.surface;
};
const rows: any[] = []; const f1 = createWorldField(recipe);
for (const r of roads) {
  const others = { ...raw, features: { ...raw.features, roads: raw.features.roads.filter((x: any) => x !== r) } };
  const f0 = createWorldField(worldRecipeSchema.parse(others));
  const ys = r.surfaceY ?? [];
  let len = 0, steep = 0, cut = 0, fill = 0, cutAt: number[] = [], fillAt: number[] = [], far = 0, farAt: number[] = [];
  const half = r.width / 2, band = half + (r.shoulder ?? 0) + (r.smooth ?? 0);
  for (let i = 1; i < r.points.length; i++) {
    const a = r.points[i - 1], b = r.points[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]); len += d;
    if (d > 0.5 && ys.length) steep = Math.max(steep, Math.abs(ys[i] - ys[i - 1]) / d);
    const nx = -(b[1] - a[1]) / (d || 1), nz = (b[0] - a[0]) / (d || 1);
    const k = Math.max(1, Math.ceil(d / 4));
    for (let j = 0; j < k; j++) {
      const t = j / k, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      for (const o of [0, -half, half, -band, band, -band - 20, band + 20, -band - 45, band + 45]) {
        const px = x + nx * o, pz = z + nz * o, dh = f1.height(px, pz) - f0.height(px, pz);
        if (Math.abs(o) <= band + 0.01) { if (-dh > cut) { cut = -dh; cutAt = [px, pz]; } if (dh > fill) { fill = dh; fillAt = [px, pz]; } }
        else if (Math.abs(dh) > Math.abs(far)) { far = dh; farAt = [px, pz]; }
      }
    }
  }
  const lp = lips.filter((q: any) => q.id === r.id).reduce((s: number, q: any) => s + q.alias + q.step + q.lip, 0);
  const lpw = Math.max(0, ...lips.filter((q: any) => q.id === r.id).map((q: any) => q.worst));
  rows.push({ id: r.id, class: klass(r), width: r.width, len: Math.round(len), grade: Math.round(steep * 100), capCut: r.maxCut ?? "-", capFill: r.maxFill ?? "-", cut: +cut.toFixed(2), cutAt: cutAt.map(Math.round), fill: +fill.toFixed(2), fillAt: fillAt.map(Math.round), far: +far.toFixed(2), farAt: farAt.map(Math.round), keep: !!r.keepLandforms, tile: tile(r), from: endName(r, r.points[0]), to: endName(r, r.points[r.points.length - 1]), lips: lp, lipsWorst: +lpw.toFixed(2) });
}
const md = [
  `# Hagsheer roads audit (ROADS-NET, ${new Date().toISOString().slice(0, 16)})`, "",
  "Measured on the live recipe: cut/fill = field height with the road minus without it, centreline + tread edges + band edges every 4 m; 'far' = the largest change 20-45 m beyond the band (a landform the road clears: keepLandforms off). grade = steepest segment of the graded profile. lips = `worldgen lips --near -2544,-35,2595` faults charged to the road. Door stubs left out.", "",
  "| road | class | width | length m | grade % | caps cut/fill | cut m (at) | fill m (at) | far change m (at) | keepLandforms | painted tile | from | to | lips (worst m) |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((q) => `| ${q.id} | ${q.class} | ${q.width} | ${q.len} | ${q.grade} | ${q.capCut}/${q.capFill} | ${q.cut} (${q.cutAt.join(",")}) | ${q.fill} (${q.fillAt.join(",")}) | ${q.far} (${q.farAt.join(",")}) | ${q.keep ? "yes" : "no"} | ${q.tile} | ${q.from} | ${q.to} | ${q.lips}${q.lips ? ` (${q.lipsWorst})` : ""} |`),
];
fs.mkdirSync(path.dirname(outMd!), { recursive: true });
fs.writeFileSync(outMd!, md.join("\n") + "\n");
if (outJson) fs.writeFileSync(outJson, JSON.stringify(rows, null, 1));
console.log(md.slice(4).join("\n"));

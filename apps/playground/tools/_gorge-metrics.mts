/* scratch: site-gorge metrics for site-river-15-21, before (gorge off) vs after: waterline width per pool,
   wall width 8 m over each pool (min/max along the span), slope discontinuity at the site edge, and 1 m ASCII sections */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const load = (off: boolean, patch?: string) => {
  const json = JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8"));
  if (off) for (const s of json.features.fallSites) s.gorge = { enabled: false };
  if (patch) json.features.fallSites.find((s: any) => s.id === "site-river-15-21").gorge = JSON.parse(patch);
  return createWorldField(worldRecipeSchema.parse(json));
};
const F = { before: load(true), after: load(false, process.argv[2]) };
const falls = F.after.falls.filter((f) => f.river === "river-15").sort((a, b) => b.top - a.top);
// the river polyline through the site
const doc = F.after.rivers.filter((r) => r.id.startsWith("river-15")).sort((a, b) => {
  const d = (r: typeof a) => Math.min(...r.points.map((p) => Math.hypot(p[0] - falls[1]!.x, p[1] - falls[1]!.z)));
  return d(a) - d(b);
})[0]!;
const pts = doc.points;
const cum = [0];
for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
const alongOf = (x: number, z: number) => { let b = Infinity, s = 0; for (let i = 0; i + 1 < pts.length; i++) { const [ax, az] = pts[i]!, [bx, bz] = pts[i + 1]!; const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz; const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)); const d = Math.hypot(x - ax - dx * t, z - az - dz * t); if (d < b) { b = d; s = cum[i]! + t * Math.sqrt(l2); } } return s; };
const at = (s: number) => { let i = 0; while (i < pts.length - 2 && cum[i + 1]! < s) i++; const t = (s - cum[i]!) / (cum[i + 1]! - cum[i]!); const [ax, az] = pts[i]!, [bx, bz] = pts[i + 1]!; const l = Math.hypot(bx - ax, bz - az); return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, nx: -(bz - az) / l, nz: (bx - ax) / l, dx: (bx - ax) / l, dz: (bz - az) / l }; };
const footS = falls.map((f) => alongOf(f.x, f.z));
const s0 = footS[0]! - 25, s1 = footS[footS.length - 1]! + 45;
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
for (const key of ["before", "after"] as const) {
  const f = F[key];
  const perTier = falls.map(() => ({ wl: 0, wmin: Infinity, wmax: -Infinity, sideMin: Infinity, sideMax: -Infinity }));
  let edgeJump = 0, edgeAt = "";
  for (let s = s0; s <= s1; s += 1) {
    const p = at(s);
    // which pool: the last foot upstream of s
    let t = -1; for (let i = 0; i < footS.length; i++) if (s >= footS[i]! + 1) t = i;
    if (t >= 0 && (t + 1 >= footS.length || s < footS[t + 1]! - 5) && s < footS[t]! + (t + 1 >= footS.length ? 22 : 99)) {
      const level = falls[t]!.bottom;
      let wl = 0; const wall: number[] = [];
      for (const sg of [1, -1]) {
        let d = 0; for (; d < 30; d += 0.5) { const x = p.x + p.nx * d * sg, z = p.z + p.nz * d * sg; if (!(f.waterSurface(x, z, ws) && ws.y > f.height(x, z))) break; } wl += d;
        let e = 0; for (; e < 60; e += 0.5) if (f.height(p.x + p.nx * e * sg, p.z + p.nz * e * sg) >= level + 8) break; wall.push(e);
      }
      const r = perTier[t]!; r.wl = Math.max(r.wl, wl);
      r.wmin = Math.min(r.wmin, wall[0]! + wall[1]!); r.wmax = Math.max(r.wmax, wall[0]! + wall[1]!);
      r.sideMin = Math.min(r.sideMin, ...wall); r.sideMax = Math.max(r.sideMax, ...wall);
    }
    // slope discontinuity through the fade band out to 70 m (both sides)
    for (const sg of [1, -1]) {
      let prev = NaN;
      for (let d = 40; d < 70; d++) {
        const h0 = f.height(p.x + p.nx * d * sg, p.z + p.nz * d * sg), h1 = f.height(p.x + p.nx * (d + 1) * sg, p.z + p.nz * (d + 1) * sg);
        const sl = h1 - h0; if (!Number.isNaN(prev) && Math.abs(sl - prev) > edgeJump) { edgeJump = Math.abs(sl - prev); edgeAt = `s=${(s - footS[0]!).toFixed(0)} d=${d * sg}`; } prev = sl;
      }
    }
  }
  // downstream end of the site: slope jumps along the centreline band past the last bowl
  let endJump = 0;
  for (let off = -20; off <= 20; off += 2) { let prev = NaN; for (let s = footS[footS.length - 1]! + 15; s < footS[footS.length - 1]! + 50; s++) { const a = at(s), b = at(s + 1); const h0 = f.height(a.x + a.nx * off, a.z + a.nz * off), h1 = f.height(b.x + b.nx * off, b.z + b.nz * off); const sl = h1 - h0; if (!Number.isNaN(prev)) endJump = Math.max(endJump, Math.abs(sl - prev)); prev = sl; } }
  console.log(`\n== ${key.toUpperCase()} ==  channel (bed) width ${falls.map((x) => x.width.toFixed(1)).join("/")} m`);
  perTier.forEach((r, i) => console.log(`pool ${i + 1} (level ${falls[i]!.bottom.toFixed(1)}): max waterline width ${r.wl.toFixed(1)} m (${(r.wl / falls[i]!.width).toFixed(2)}x channel); gorge width 8 m over the pool ${r.wmin.toFixed(1)}..${r.wmax.toFixed(1)} m (per side ${r.sideMin.toFixed(1)}..${r.sideMax.toFixed(1)})`));
  console.log(`max slope change between 1 m steps, 40-70 m out: ${edgeJump.toFixed(2)} (${edgeAt}); along the downstream end: ${endJump.toFixed(2)}`);
}
if (process.argv.includes("--ascii")) {
  const sec = (label: string, sx: number, sz: number, ax: number, az: number, half: number) => {
    for (const key of ["before", "after"] as const) {
      const f = F[key]; const hs: number[] = [];
      for (let s = -half; s <= half; s++) hs.push(f.height(sx + ax * s, sz + az * s));
      const wl: (number | null)[] = []; for (let s = -half; s <= half; s++) { const x = sx + ax * s, z = sz + az * s; wl.push(f.waterSurface(x, z, ws) && ws.y > f.height(x, z) ? ws.y : null); }
      const lo = Math.floor(Math.min(...hs) / 2) * 2 - 2, hi = Math.ceil(Math.max(...hs) / 2) * 2;
      console.log(`\n${label} ${key} (1 m columns ${-half}..${half}; 2 m rows)`);
      for (let y = hi; y >= lo; y -= 2) { let row = ""; for (let i = 0; i < hs.length; i++) row += hs[i]! >= y ? "#" : wl[i] != null && wl[i]! >= y ? "~" : " "; console.log(String(y).padStart(4) + "|" + row); }
    }
  };
  falls.forEach((fl, i) => {
    const pool = at(footS[i]! + 9); sec(`TIER ${i + 1} POOL (foot+9 m)`, pool.x, pool.z, pool.nx, pool.nz, 50);
    const hw = at(footS[i]! - 1.5); sec(`TIER ${i + 1} HEADWALL (across the fall face)`, hw.x, hw.z, hw.nx, hw.nz, 50);
  });
  const a = at(s0); const hsB: number[] = [], hsA: number[] = [];
  for (let s = s0; s <= s1; s++) { const p = at(s); hsB.push(F.before.height(p.x, p.z)); hsA.push(F.after.height(p.x, p.z)); }
  for (const [k, hs] of [["before", hsB], ["after", hsA]] as const) {
    const lo = Math.floor(Math.min(...hs) / 2) * 2 - 2, hi = Math.ceil(Math.max(...hs) / 2) * 2;
    console.log(`\nLONG PROFILE down the centreline ${k} (1 m columns from top foot-25 to last foot+45)`);
    for (let y = hi; y >= lo; y -= 2) { let row = ""; for (const h of hs) row += h >= y ? "#" : " "; console.log(String(y).padStart(4) + "|" + row); }
  }
  void a;
}
{
  // the CUT (after - before) through the outer fade band and past the last bowl: a seam shows as a jump in its slope
  const cut = (x: number, z: number) => F.after.height(x, z) - F.before.height(x, z);
  let lat = 0, latAt = "", maxCutAtEdge = 0;
  for (let s = s0; s <= s1; s += 2) {
    const p = at(s);
    for (const sg of [1, -1]) {
      let prev = NaN;
      for (let d = 40; d <= 64; d++) {
        const sl = cut(p.x + p.nx * (d + 1) * sg, p.z + p.nz * (d + 1) * sg) - cut(p.x + p.nx * d * sg, p.z + p.nz * d * sg);
        if (!Number.isNaN(prev) && Math.abs(sl - prev) > lat) { lat = Math.abs(sl - prev); latAt = `s=${(s - footS[0]!).toFixed(0)} d=${d * sg}`; }
        prev = sl;
      }
      maxCutAtEdge = Math.max(maxCutAtEdge, Math.abs(cut(p.x + p.nx * 60 * sg, p.z + p.nz * 60 * sg)));
    }
  }
  let lon = 0;
  const lastS = footS[footS.length - 1]!;
  for (let off = -14; off <= 14; off += 2) { let prev = NaN; for (let s = lastS + 18; s < lastS + 50; s++) { const a = at(s), b = at(s + 1); const sl = cut(b.x + b.nx * off, b.z + b.nz * off) - cut(a.x + a.nx * off, a.z + a.nz * off); if (!Number.isNaN(prev)) lon = Math.max(lon, Math.abs(sl - prev)); prev = sl; } }
  console.log(`\nCUT seam check: max change in the cut's slope per 1 m, 40-65 m out: ${lat.toFixed(3)} (${latAt}); past the last bowl: ${lon.toFixed(3)}; |cut| at 60 m: ${maxCutAtEdge.toFixed(3)} m`);
}
{
  // knife ridges / pits on the 2 m lattice: a column more than 3 m over (or under) BOTH neighbours 2 m away on an axis
  for (const key of ["before", "after"] as const) {
    const f = F[key]; let ridge = 0, pit = 0, steep = 0; const R: string[] = [];
    const x0 = 5290, x1 = 5430, z0 = -3950, z1 = -3810;
    const H = new Map<string, number>(); const h = (x: number, z: number) => { const k = x + "," + z; let v = H.get(k); if (v === undefined) { v = f.height(x, z); H.set(k, v); } return v; };
    for (let x = x0; x <= x1; x += 2) for (let z = z0; z <= z1; z += 2) {
      const c = h(x, z);
      for (const [ax, az] of [[2, 0], [0, 2], [2, 2], [2, -2]]) {
        const l = h(x - ax!, z - az!), r = h(x + ax!, z + az!);
        if (c - l > 3 && c - r > 3) { ridge++; if (R.length < 6) R.push(`${x},${z}`); break; }
        if (l - c > 3 && r - c > 3) { pit++; break; }
      }
      if (Math.max(Math.abs(h(x + 2, z) - c), Math.abs(h(x, z + 2) - c)) > 2 * 2.5) steep++;
    }
    console.log(`${key}: knife ridges ${ridge} ${R.join(" ")}, pits ${pit}, lattice steps steeper than 2.5 ${steep}`);
  }
}

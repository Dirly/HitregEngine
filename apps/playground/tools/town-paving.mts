/**
 * town-paving — no bare dirt inside a walled town (k-town4, Derek 2026-11-02 on Bell Strand: "the square and the entire
 * inside of the walled city should feel like a European walled city, so you wouldn't see a lot of dirt, you'd see stone").
 *
 *   npx tsx tools/town-paving.mts --project <p> --town <town> [--world <name>] [--step 1] [--max 0.03] [--json out.json]
 *
 * Reads the town's design (`authoring/towns/<town>-design.json`) and samples the BUILT world's splat (the field's own
 * `splatAt`, exactly what the terrain draws) every `--step` m on every INTRAMURAL terrace (not `extramural`). A sample
 * is PAVED when stone surfaces carry >= 0.6 of its weight: the zone's `ground.paving` / `ground.road` surfaces and any
 * palette surface named paving / road / flag / cobble / gravel. A planted bed is allowed where a ground paint whose id
 * contains `garden` or `green` covers it (a garden plot inside the walls is greenery, not dirt). Exit 1 when the bare
 * share of any intramural terrace is over `--max` (default 3 %), listing the worst 1 m cells.
 *
 * The solver half is `worldgen terrace --from-plan` (tools/worldgen-terrace-from-plan.mts): it paves every intramural
 * terrace (`<town>-plan-paving-<terrace>` ground paints). A failure here means that cut is stale or another paint
 * covers the town.
 *
 * The samples are the FIELD's splat; the browser draws them through the world's terrain material. A stone surface the
 * material has no layer for draws as its last layer (e-paving 2026-11-02: Bell Strand's pale flagstone, palette #26 on a
 * 26-layer material, drew the old red flag while this gate passed), so a stone surface that does not reach the render
 * (core `terrainPaletteFaults`) also fails here.
 */
import fs from "node:fs";
import path from "node:path";
import { createWorldField, terrainPaletteFaults, worldRecipeSchema } from "@hitreg/core";
import { findAsset } from "./_closure.mjs";
import { inPoly, type V2 } from "./town-design-check.mts";
import { townDesignSchema } from "./town-design-schema.mts";

const argv = process.argv.slice(2);
const opt = (k: string, d = ""): string => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };
const project = opt("project"), town = opt("town");
if (!project || !town) { console.error("usage: town-paving --project <p> --town <town> [--world <name>] [--step 1] [--max 0.03] [--json out.json]"); process.exit(2); }
const root = path.join("projects", project);
const design = townDesignSchema.parse(JSON.parse(fs.readFileSync(path.join(root, "authoring/towns", `${town}-design.json`), "utf8")));
// --world <file stem>, else the project's world whose recipe is the design's world (a lab crop keeps the live name)
const worldDir = path.join(root, "assets/worlds");
const worldFile = opt("world") ? path.join(worldDir, `${opt("world")}.json`)
  : fs.existsSync(path.join(worldDir, `${design.world}.json`)) ? path.join(worldDir, `${design.world}.json`)
  : path.join(worldDir, fs.readdirSync(worldDir).find((f) => f.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(worldDir, f), "utf8")).name === design.world) ?? `${design.world}.json`);
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(worldFile, "utf8")));
const field = createWorldField(recipe);
const step = Number(opt("step", "1")), maxBare = Number(opt("max", "0.03"));

export function stoneSurfaces(r: typeof recipe): Set<number> {
  const names = new Set<string>();
  for (const g of r.regions ?? []) for (const role of ["paving", "road"]) { const n = (g as { ground?: Record<string, string> }).ground?.[role]; if (n) names.add(n); }
  const out = new Set<number>();
  r.surfaces.forEach((s, i) => { if (names.has(s.name) || /paving|road|flag|cobble|gravel/i.test(s.name)) out.add(i); });
  return out;
}
const stone = stoneSurfaces(recipe);
const gardens = (recipe.features.groundPaints ?? []).filter((g) => /garden|green/.test(g.id) && g.polygon).map((g) => g.polygon as V2[]);
const pavingEdge = ((design as { paving?: { edge?: V2[] } }).paving?.edge ?? null) as V2[] | null;
const w = new Float32Array(recipe.surfaces.length);
let bad = 0;
const rows: { terrace: string; samples: number; bare: number; share: number; worst: { x: number; z: number; paved: number; top: string }[] }[] = [];
for (const t of design.terraces.filter((x) => !x.extramural)) {
  const xs = t.polygon.map((p) => p[0]), zs = t.polygon.map((p) => p[1]);
  let n = 0, nb = 0;
  const worst: { x: number; z: number; paved: number; top: string }[] = [];
  for (let z = Math.ceil(Math.min(...zs)); z <= Math.max(...zs); z += step)
    for (let x = Math.ceil(Math.min(...xs)); x <= Math.max(...xs); x += step) {
      if (!inPoly(t.polygon as V2[], x, z) || gardens.some((g) => inPoly(g, x, z))) continue;
      // k-town9: a design with a hard paving edge (design.paving.edge = the curtain's inner face, k-town8) is paved up
      // to that edge only: the terrace's strip under and past the curtain is not intramural floor
      if (pavingEdge && !inPoly(pavingEdge, x, z)) continue;
      n++;
      w.fill(0);
      field.splatAt(x, field.height(x, z), z, 1, w, 0);
      let tot = 0, paved = 0, top = 0;
      for (let i = 0; i < w.length; i++) { tot += w[i]!; if (stone.has(i)) paved += w[i]!; if (w[i]! > w[top]!) top = i; }
      const share = tot > 0 ? paved / tot : 0;
      if (share < 0.6) { nb++; if (worst.length < 400) worst.push({ x, z, paved: +share.toFixed(2), top: recipe.surfaces[top]!.name }); }
    }
  const share = n ? nb / n : 0;
  if (share > maxBare) bad++;
  rows.push({ terrace: t.id, samples: n, bare: nb, share: +share.toFixed(4), worst: worst.sort((a, b) => a.paved - b.paved).slice(0, 8) });
  console.log(`${share > maxBare ? "FAIL" : "ok  "} ${t.id}: ${(share * 100).toFixed(1)} % bare of ${n} samples (max ${(maxBare * 100).toFixed(0)} %)${nb ? `; e.g. ${worst.slice(0, 4).map((q) => `(${q.x}, ${q.z}) ${q.top} ${(q.paved * 100).toFixed(0)} % stone`).join(", ")}` : ""}`);
}
// the stone has to reach the render, not just the field
const matId = recipe.material ?? `terrain/${recipe.name}`;
const matFile = findAsset(project, path.join("materials", `${matId}.json`));
let matDoc: unknown = null;
try { matDoc = matFile ? JSON.parse(fs.readFileSync(matFile, "utf8")) : null; } catch { /* unreadable = fault */ }
const unseen = terrainPaletteFaults(recipe, matDoc).filter((f) => f.surface < 0 || stone.has(f.surface));
for (const f of unseen) console.log(`FAIL render: ${f.name}: ${f.why} (${matId}) — fix: worldgen material <world> --project ${project}`);
if (unseen.length) bad++;
const jf = opt("json"); if (jf) fs.writeFileSync(jf, JSON.stringify({ town, world: recipe.name, ok: bad === 0, terraces: rows, render: unseen }, null, 2) + "\n");
console.log(bad ? `PAVING FAILED (${bad - (unseen.length ? 1 : 0)} intramural terrace(s) show bare ground${unseen.length ? "; the stone does not reach the render" : ""})` : `PAVING OK (${rows.length} intramural terraces)`);
process.exit(bad ? 1 : 0);

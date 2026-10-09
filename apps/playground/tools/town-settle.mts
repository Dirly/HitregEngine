/**
 * town-settle — set every building's floor from the FINAL terrain: cast the model's FULL footprint down (`full`, the
 * whole model's envelope from town-layout: porches, towers and jetties included; the lot outline `ground` only when a
 * layout predates `full`) on a 1 m lattice, topmost solid, and put the floor just above the highest point, so no ground
 * ever pokes through a floor. Run after the pads, lanes and road-regrade are written; export with --lift 0 afterwards
 * (the height is in the layout).
 *
 *   npx tsx tools/town-settle.mts --project proving --town brinehold [--clear 0.15]   settle, then check
 *   npx tsx tools/town-settle.mts --project proving --town brinehold --check [--out f]  check only (writes nothing but the report; --out puts it elsewhere)
 *
 * The CHECK (`terrain-through-floor`, docs/world-standards/towns.md "No terrain pokes through a floor"): after any
 * ground change, the ground under each model's full footprint must stay below its floor. It writes
 * authoring/towns/survey/<town>-floors.json ({ failures, buildings }) and exits 1 on a failure; `zonegen status` shows
 * it as the town's `floors` row, STALE whenever the ground round the town or the layout changes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";

type P = [number, number];
/** Ground may stand this far above a floor before it reads as poking through (a floor's own thickness hides it). */
export const POKE_TOLERANCE = 0.02;

/** Lattice points (about 1 m apart) over a quad given as 4 corners in order. */
export function lattice(g: P[]): P[] {
  const u: P = [g[1]![0] - g[0]![0], g[1]![1] - g[0]![1]], v: P = [g[3]![0] - g[0]![0], g[3]![1] - g[0]![1]];
  const nu = Math.max(1, Math.ceil(Math.hypot(...u))), nv = Math.max(1, Math.ceil(Math.hypot(...v)));
  const out: P[] = [];
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) out.push([g[0]![0] + (u[0] * i) / nu + (v[0] * j) / nv, g[0]![1] + (u[1] * i) / nu + (v[1] * j) / nv]);
  return out;
}

export interface FloorRow { id: string; groundY: number; hi: number; lo: number; at: P; footprint: "full" | "ground"; poke: number }
/** The ground under each building's full footprint against its floor. Pure: `top(x, z)` is the topmost solid. */
export function floorCheck(buildings: { id: string; groundY: number; ground: P[]; full?: P[] }[], top: (x: number, z: number) => number): { rows: FloorRow[]; failures: string[] } {
  const rows: FloorRow[] = [];
  const failures: string[] = [];
  for (const b of buildings) {
    const fp = b.full?.length === 4 ? b.full : b.ground;
    let hi = -Infinity, lo = Infinity, at: P = fp[0]!;
    for (const [x, z] of lattice(fp)) {
      const y = top(x, z);
      if (y > hi) (hi = y), (at = [x, z]);
      lo = Math.min(lo, y);
    }
    const poke = +(hi - b.groundY).toFixed(2);
    rows.push({ id: b.id, groundY: b.groundY, hi: +hi.toFixed(2), lo: +lo.toFixed(2), at: [+at[0].toFixed(1), +at[1].toFixed(1)], footprint: fp === b.full ? "full" : "ground", poke });
    if (poke > POKE_TOLERANCE) failures.push(`terrain-through-floor ${b.id}: ground ${hi.toFixed(2)} at [${at[0].toFixed(1)}, ${at[1].toFixed(1)}] stands ${poke.toFixed(2)} m above its floor ${b.groundY.toFixed(2)} (re-run town-settle)`);
  }
  return { rows, failures };
}

function main(): void {
  const argv = process.argv.slice(2);
  const opt = (n: string, f: string): string => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : f; };
  const dir = path.resolve("projects", opt("project", ""));
  const town = opt("town", "");
  const clear = Number(opt("clear", "0.15"));
  const checkOnly = argv.includes("--check");
  const layoutFile = path.join(dir, "authoring/towns", `${town}-layout.json`);
  const layout = JSON.parse(fs.readFileSync(layoutFile, "utf8"));
  const doc = JSON.parse(fs.readFileSync(path.join(dir, "authoring/towns", `${town}.json`), "utf8"));
  const field = createWorldField(worldRecipeSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, "assets/worlds", `${doc.world}.json`), "utf8"))));
  const top = (x: number, z: number): number => { const h = field.height(x, z); return field.surfaceCast(x, z, h + 40, h - 40) ?? h; };
  if (!checkOnly && argv.includes("--out")) throw new Error("--out is for --check (a look that writes nothing in the project)");
  if (!checkOnly) {
    for (const b of layout.buildings) {
      const fp = (b.full?.length === 4 ? b.full : b.ground) as P[];
      let hi = -Infinity, lo = Infinity;
      for (const [x, z] of lattice(fp)) { const y = top(x, z); hi = Math.max(hi, y); lo = Math.min(lo, y); }
      const old = b.groundY;
      b.groundY = Math.round((hi + clear) * 100) / 100;
      console.log(`  ${b.id.padEnd(20)} floor ${old.toFixed(2)} -> ${b.groundY.toFixed(2)}  (${fp === b.full ? "full footprint" : "lot outline"} ground ${lo.toFixed(2)}..${hi.toFixed(2)}, drop to lowest ${(b.groundY - lo).toFixed(2)} m)`);
    }
    fs.writeFileSync(layoutFile, `${JSON.stringify(layout, null, 1)}\n`);
    console.log("settled");
  }
  const { rows, failures } = floorCheck(layout.buildings, top);
  const out = path.resolve(opt("out", path.join(dir, "authoring/towns/survey", `${town}-floors.json`)));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify({ town, at: new Date().toISOString(), tolerance: POKE_TOLERANCE, failures, buildings: rows }, null, 1)}\n`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  console.log(`floors ${town}: ${rows.length} building(s), ${failures.length} with terrain through the floor -> ${path.relative(process.cwd(), out)}`);
  process.exitCode = failures.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

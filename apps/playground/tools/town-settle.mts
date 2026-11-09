/**
 * town-settle — set every building's floor from the FINAL terrain: cast the model's FULL footprint down (`full`, the
 * whole model's envelope from town-layout: porches, towers and jetties included; the lot outline `ground` only when a
 * layout predates `full`) on a 1 m lattice, topmost solid, and put the floor just above the highest point, so no ground
 * ever pokes through a floor. Run after the pads, lanes and road-regrade are written; export with --lift 0 afterwards
 * (the height is in the layout).
 *
 *   npx tsx tools/town-settle.mts --project proving --town brinehold [--clear 0.6]    settle, then check
 *   npx tsx tools/town-settle.mts --project proving --town brinehold --check [--out f]  check only (writes nothing but the report; --out puts it elsewhere)
 *   npx tsx tools/town-settle.mts --project proving --town brinehold --skirts [--scene id] [--dry]   foundation skirts
 *     under every INSTALLED structure whose base shows daylight (tools/town-seated.mts townSkirts; the town's `seated` row)
 *
 * The CHECK (`terrain-through-floor`, docs/world-standards/towns.md "No terrain pokes through a floor"): after any
 * ground change, the ground under each model's full footprint must stay below its floor. It writes
 * authoring/towns/survey/<town>-floors.json ({ failures, buildings }) and exits 1 on a failure; `zonegen status` shows
 * it as the town's `floors` row, STALE whenever the ground round the town or the layout changes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyOps, ComponentRegistry, createWorldField, registerCoreComponents, SEAT_SINK_M, solvePlacement, worldRecipeSchema, worldToLocal } from "@hitreg/core";
import { PROJECTS } from "./_closure.mjs";
import { applyOpsToSceneFile } from "./_scene-write.mts";
import { townContext, townLook, townPieces, townSeated, townSkirts } from "./town-seated.mts";

type P = [number, number];
/** Ground may stand this far above a floor before it reads as poking through (a floor's own thickness hides it). */
export const POKE_TOLERANCE = 0.02;
/** Floors stand RAISED over the highest ground of their footprint (Derek 10-02, KIT-RULES 24.1: the kit's entry steps
 * climb ~0.675 m): settle puts them CLEAR_DEFAULT up, the check fails one closer than MIN_RAISE (`floor-not-raised`). */
export const CLEAR_DEFAULT = 0.6;
export const MIN_RAISE = 0.45;

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
export function floorCheck(buildings: { id: string; groundY: number; ground: P[]; full?: P[] }[], top: (x: number, z: number) => number, minRaise = MIN_RAISE): { rows: FloorRow[]; failures: string[] } {
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
    else if (-poke < minRaise) failures.push(`floor-not-raised ${b.id}: floor ${b.groundY.toFixed(2)} stands ${(-poke).toFixed(2)} m over the highest ground ${hi.toFixed(2)} (< ${minRaise} m; re-run town-settle, default --clear ${CLEAR_DEFAULT})`);
  }
  return { rows, failures };
}

/** A town building's floor height from the core placement solver: footprint quad `fp` (4 corners in order), the 1 m
 *  lattice as its samples, the floor `clear` m over the highest ground (placeRule grade), never moved or turned. */
export function solveFloor(fp: P[], top: (x: number, z: number) => number, clear: number) {
  const c: P = [(fp[0]![0] + fp[2]![0]) / 2, (fp[0]![1] + fp[2]![1]) / 2], u: P = [fp[1]![0] - fp[0]![0], fp[1]![1] - fp[0]![1]], v: P = [fp[3]![0] - fp[0]![0], fp[3]![1] - fp[0]![1]];
  const yaw = Math.atan2(-u[1], u[0]), half: P = [Math.hypot(...u) / 2, Math.hypot(...v) / 2];
  return solvePlacement({ id: "floor", at: c, yaw, half, height: 3, footing: 99, base: lattice(fp).map((q) => worldToLocal(c, yaw, q)), movable: false,
    rule: { seat: "foot", grade: clear + SEAT_SINK_M, tolerance: { gap: 0.05, slope: 100, move: 0, yaw: 0 } } }, { ground: top });
}

function main(): void {
  const argv = process.argv.slice(2);
  const opt = (n: string, f: string): string => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : f; };
  if (argv.includes("--skirts")) return void skirts(opt("project", ""), opt("town", ""), argv.includes("--scene") ? opt("scene", "") : undefined, argv.includes("--dry"));
  const dir = path.resolve("projects", opt("project", ""));
  const town = opt("town", "");
  const clear = Number(opt("clear", String(CLEAR_DEFAULT)));
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
      // THE PLACEMENT SOLVER (t-place 2026-10-30) seats the floor: the full footprint sampled on the 1 m lattice, the floor
      // (grade = clear) stood `clear` over the highest ground; the kit's export carries the plinth down to the lowest
      const r = solveFloor(fp, top, clear);
      if (r.status === "dropped") throw new Error(`town-settle ${b.id}: the placement solver refused it: ${r.reason}`);
      const hi = r.ground!.hi, lo = r.ground!.lo;
      const old = b.groundY;
      b.groundY = Math.round(r.y! * 100) / 100;
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

/** --skirts (f-ground 2026-10-31, Derek: "Why is shit floating if we have code assist for placement?"): a foundation skirt
 *  in the piece's foundation material under every stretch of an installed town structure's base that shows daylight on
 *  the walked ground (town-seated townSkirts), one ops batch through the scene writer, its inverse kept in
 *  authoring/towns/<town>-skirt-ops.json; then the seated gate (town-seated) re-judged. Re-running replaces the skirts. */
function skirts(project: string, town: string, scene: string | undefined, dry: boolean): void {
  const ctx = townContext(project, town, scene), look = townLook(project), parts = townPieces(ctx.doc, town, look);
  const { ops, rows } = townSkirts(ctx.doc, parts.structures, look, ctx.ground, look.foundation);
  for (const r of rows) console.log(`  ${r.id.padEnd(24)} ${r.skirts} skirt(s), up to ${r.worst.toFixed(2)} m of daylight covered`);
  const registry = new ComponentRegistry(); registerCoreComponents(registry);
  applyOps(structuredClone(ctx.doc), ops, registry); // validate before any write
  if (dry) { console.log(`skirts ${town}: would apply ${ops.length} op(s) to ${ctx.sceneId}`); return; }
  if (!ops.length) { console.log(`skirts ${town}: nothing shows daylight`); return; }
  const res = applyOpsToSceneFile(ctx.sceneFile, ops, (d, o) => applyOps(d, o, registry), { label: `town-settle --skirts ${town}` }) as { inverse?: unknown };
  const out = path.join(PROJECTS, project, "authoring/towns", `${town}-skirt-ops.json`);
  fs.writeFileSync(out, `${JSON.stringify({ scene: ctx.sceneId, at: new Date().toISOString(), ops, inverse: res.inverse }, null, 1)}\n`);
  const g = townSeated(project, town, { scene });
  console.log(`skirts ${town}: ${rows.reduce((n, r) => n + r.skirts, 0)} skirt(s) under ${rows.length} structure(s) (inverse in ${path.relative(process.cwd(), out)}); seated: ${g.counts.faults} fault(s), worst ${g.worst.toFixed(2)} m`);
  process.exitCode = g.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

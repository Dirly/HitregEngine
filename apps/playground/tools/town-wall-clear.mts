/**
 * town-wall-clear — the gate: a town's installed buildings stand CLEAR of its baked wall operators.
 *
 *   npx tsx tools/town-wall-clear.mts --project skelmorrow --town cindermoot [--clear 0.5] [--step 0.25] [--near 80] [--json <file>]
 *
 * Reads the town doc (authoring/towns/<town>.json: world, town id, scene), the world scene's building entities
 * (`town-<town>-buildings-<id>`: position + rotation) and their shipped models (the entity mesh asset), rebuilds every
 * `wall` operator of the recipe that passes within --near metres of a building (ramps excluded), and measures per
 * building how far any wall reaches into its plan box, else the clearance (tools/_town-wall-clear.mts). FAILS (exit 1)
 * when a wall reaches into a building or stands closer than --clear. Also prints how much each shipped model exceeds the
 * layout envelope the lots were drawn with (authoring/towns/<town>-layout.json + -envelopes.json): that excess is why a
 * wall drawn round the envelopes meets the buildings.
 */
import fs from "node:fs";
import path from "node:path";
import { worldRecipeSchema } from "@hitreg/core";
import { operatorReader } from "./worldgen-operators.mts";
import { glbBounds, judgeTown, planBox, wallEdgesOf, yawOf, type PlanBox } from "./_town-wall-clear.mts";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const num = (k: string, d: number) => Number(opt(k, String(d)));
const project = opt("project"), town = opt("town");
if (!project || !town) { console.error("usage: town-wall-clear --project <p> --town <t> [--clear 0.5] [--step 0.25] [--near 80] [--json <file>]"); process.exit(2); }
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const projectDir = path.resolve("projects", project);
const townsDir = path.join(projectDir, "authoring", "towns");
const townDoc = readJson(path.join(townsDir, `${town}.json`));
const world: string = townDoc.world;
const sceneId: string = townDoc.scene ?? world;
const recipe = worldRecipeSchema.parse(readJson(path.join(projectDir, "assets", "worlds", `${world}.json`)));
const scene = readJson(path.join(projectDir, "assets", "scenes", `${sceneId}.scene.json`));
const ents: Record<string, any> = scene.entities ?? {};
const prefix = `town-${town}-buildings-`;
const layout = fs.existsSync(path.join(townsDir, `${town}-layout.json`)) ? readJson(path.join(townsDir, `${town}-layout.json`)) : null;
const env = fs.existsSync(path.join(townsDir, `${town}-envelopes.json`)) ? readJson(path.join(townsDir, `${town}-envelopes.json`)) : {};

// the buildings as installed, each its shipped model's plan box
const boxes: PlanBox[] = [];
const excess: { id: string; model: [number, number]; layout: [number, number] | null; over: [number, number] | null }[] = [];
for (const [eid, e] of Object.entries(ents)) {
  if (!eid.startsWith(prefix) || eid.slice(prefix.length).includes("-interior")) continue;
  const id = eid.slice(prefix.length);
  const src = e.components?.mesh?.source;
  if (src?.kind !== "asset" || typeof src.assetId !== "string") continue;
  const file = path.join(projectDir, "assets", "models", src.assetId);
  if (!fs.existsSync(file)) { console.warn(`  ${id}: model ${src.assetId} not found, skipped`); continue; }
  const b = glbBounds(file);
  const t = e.components?.transform ?? {};
  boxes.push(planBox(id, t.position ?? [0, 0, 0], yawOf(t.rotation), b.lo, b.hi));
  const lb = layout?.buildings?.find((x: any) => x.id === id);
  const ev = env[id]?.full;
  const cell = layout?.cell ?? 3.2;
  const lay: [number, number] | null = lb && ev ? [lb.size[0] * cell + ev.left + ev.right, lb.size[1] * cell + ev.front + ev.back] : lb ? [lb.size[0] * cell, lb.size[1] * cell] : null;
  const model: [number, number] = [b.hi[0] - b.lo[0], b.hi[2] - b.lo[2]];
  excess.push({ id, model, layout: lay, over: lay ? [model[0] - lay[0], model[1] - lay[1]] : null });
}
if (!boxes.length) { console.error(`no ${prefix}* entities with asset meshes in ${sceneId}.scene.json`); process.exit(2); }

// the walls near the town
const near = num("near", 80);
const nearTown = (pts: [number, number][]) => pts.some((p) => boxes.some((b) => Math.hypot(p[0] - b.cx, p[1] - b.cz) < near));
const walls: { id: string; segs: ReturnType<typeof wallEdgesOf>["segs"] }[] = [];
const notes: string[] = [];
for (const o of recipe.features.operators ?? []) {
  const d = o as any;
  if (d.op !== "wall" || d.variant === "ramp" || !Array.isArray(d.points) || !nearTown(d.points)) continue;
  try {
    const w = wallEdgesOf(recipe, d.id, operatorReader(recipe, d.id));
    walls.push({ id: d.id, segs: w.segs });
    if (w.stale) notes.push(`${d.id}: ${w.stale} (judged as it rebuilds now)`);
  } catch (err) { notes.push(`${d.id}: ${(err as Error).message}`); }
}
const clear = num("clear", 0.5), step = num("step", 0.25);
const { rows, bad } = judgeTown(boxes, walls, clear, step);

console.log(`town-wall-clear ${town} (${world}): ${boxes.length} buildings, ${walls.length} wall operator(s) within ${near} m${walls.length ? ": " + walls.map((w) => w.id).join(", ") : ""}`);
for (const n of notes) console.log(`  note: ${n}`);
for (const r of rows) {
  const ex = excess.find((x) => x.id === r.id);
  const over = ex?.over ? ` (model ${ex.model.map((v) => v.toFixed(1)).join("x")} m, layout envelope ${ex.layout!.map((v) => v.toFixed(1)).join("x")}: +${ex.over.map((v) => v.toFixed(1)).join("/+")} m)` : "";
  console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.id.padEnd(18)} ${r.reach > 0 ? `${r.wall} reaches ${r.reach} m INTO it` : r.clearance === Infinity ? "no wall near" : `clear of ${r.wall} by ${r.clearance} m`}${r.at ? ` @ ${r.at.join(",")}` : ""}${!r.ok || r.reach > 0 ? over : ""}`);
}
console.log(bad ? `FAIL: ${bad} building(s) meet a wall (or stand within ${clear} m of one): move the wall line out past the SHIPPED models (not the layout envelopes), re-apply the operator and rebake its landmark` : `ok: every building clear of every wall by >= ${clear} m`);
const out = opt("json");
if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ town, world, clear, step, walls: walls.map((w) => w.id), notes, rows, excess, ok: bad === 0 }, null, 1) + "\n"); console.log(`report: ${out}`); }
process.exitCode = bad ? 1 : 0;

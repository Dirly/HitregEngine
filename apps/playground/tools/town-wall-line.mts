/**
 * town-wall-line — a town wall that DEFENDS the town, in the town's masonry (tools/_town-wall-rules.mts).
 *
 *   npx tsx tools/town-wall-line.mts check --project <p> --town <name> [--json <file>] [--recipe <world.json>] [--scene <scene.json>]
 *   npx tsx tools/town-wall-line.mts draw  --project <p> --town <name> [--clear 12] [--height 6] [--out <file>] [--dry] [--machine-top]
 *
 * check (the `town <t>: wall line` row; writes authoring/towns/survey/<town>-wall-line.json, exit 1 on a fault):
 *   - handmade: every town-owned curtain / gatehouse has the hand-made top (`handmade`, or step mode): a machine top fails;
 *   - material: every wall op the town owns (named `<town>-…` or inside its radius; ramps excluded) names a built
 *     material for its faces, never the zone cliff skin (`cliff-skin`);
 *   - overlooked: no ground outside the curtain within 60 m stands above the wall top (+ parapet) there and sees a
 *     townsman's head on a street or at a door over it (terrain and every town wall occlude); worst point + height;
 *   - waterline: no wall stretch at the sea whose top is below the shelves it fronts;
 *   - road: no curtain within ROAD_KEEP (6 m) of a road's centreline except inside its gatehouse (8 m disc).
 * draw (the generator; writes the op docs, never the recipe — then `worldgen op --apply <out>` + tools/landmark.mts):
 *   the town's shipped lots + streets, hulled and grown by --clear; the landward arc of it (ground above the lowest
 *   shelf) ending on the lowest riser's corners (the sea side is the quay and the riser walls); vertices pushed up the
 *   hill until the overlook gate passes (then the wall raised a metre at a time, to 9 m); straight legs; a GATEHOUSE
 *   (square ring, level top, arched passage front and back) where each road from the town gate crosses the line, the
 *   curtain cut there; one wall-walk stair on the town side; town masonry on every role (ashlar face, rubble footing);
 *   every curtain and the gatehouse HAND-MADE (`handmade: {}`: the top steps in short runs, a few copings dropped).
 *   --machine-top is the only opt-out (handmade: null; `check` then fails it).
 *
 *   npx tsx tools/town-wall-line.mts kit --line <points.json> | --circle <r>,<n>[,<cx>,<cz>] [--open] [--towers 0,3,6] [--gates 9]
 *                                        [--y 0] [--out <placements.json>]
 * kit (k-town2, 2026-10-30): a curtain from the KIT wall pieces (strand-town/strand-wall-run, -infill-*, -kink-in|out-*,
 *   -corner, -tower; tools/_kit-wall.mts) along a line of [x, z] vertices: runs and binary infills fill each leg exactly,
 *   a mitred kink (2-30 deg, 2 deg steps) or the corner piece (90 deg toward the town) turns it, towers stand on the
 *   named vertices, a gatehouse (strand-gatehouse) is centred on each --gates vertex (a straight-through one). Writes the placements ({ prefab, position, yaw }) for an ops batch and checks them: no gap over
 *   5 cm, no overlap (exit 1 on a finding; a turn the kit has no piece for is named, never laid with a hole). With
 *   --project/--town it writes the town's record authoring/towns/<town>-works/kit-wall.json (line, towers, gates,
 *   placements), which `check` then judges AS BUILT: the line re-laid joins, the scene holds exactly those placements
 *   (tag town-wall:<town>, one level), and the overlook / road gates run on the kit pieces' tops.
 */
import fs from "node:fs";
import path from "node:path";
import { buildWall, createWorldField, operatorParams, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";
import { operatorReader } from "./worldgen-operators.mts";
import { townWallStyle } from "./worldgen-terrace-walls.mts";
import {
  densify, dist2, grow, hull, inPolygon, keepOffRoads, OVERLOOK_RULE, overlook, polyDist, ROAD_KEEP, roadCrowding, segDist, simplify, townOwnerOf, townWallFinish, townWallHandmadeFault, townWallMaterialFault, waterlineRuns, type Screen,
} from "./_town-wall-rules.mts";

type V2 = [number, number];
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const num = (n: string, d: number) => (opt(n) !== undefined ? Number(opt(n)) : d);
const project = opt("project"), townName = opt("town");
if (cmd === "kit") {
  const { circleLine, kitWallFindings, layKitWall } = await import("./_kit-wall.mts");
  const closed = !argv.includes("--open");
  const circ = opt("circle")?.split(",").map(Number);
  const line: V2[] = circ ? circleLine(circ[0]!, circ[1]!, [circ[2] ?? 0, circ[3] ?? 0]) : JSON.parse(fs.readFileSync(opt("line") ?? "", "utf8"));
  if (!line?.length) { console.error("kit: --line <points.json> or --circle r,n[,cx,cz]"); process.exit(2); }
  const towers = (opt("towers") ?? "").split(",").filter(Boolean).map(Number);
  const gates = (opt("gates") ?? "").split(",").filter(Boolean).map(Number);
  const lay = layKitWall(line, { closed, towers, gates });
  const findings = kitWallFindings(lay, { closed });
  const y = num("y", 0);
  const placements = lay.pieces.map((p) => ({ prefab: p.prefab, kind: p.kind, position: [Math.round(p.origin[0] * 1000) / 1000, y, Math.round(p.origin[1] * 1000) / 1000], yaw: Math.round(p.yaw * 1000) / 1000 }));
  const counts = new Map<string, number>(); for (const p of lay.pieces) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
  console.log(`kit wall: ${lay.pieces.length} pieces (${[...counts].map(([k, n]) => `${n} ${k}`).join(", ")}), ${closed ? "closed" : "open"} line of ${line.length} vertices`);
  for (const n of lay.notes) console.log(`  note: ${n}`);
  for (const f of findings) console.log(`  FAIL ${f}`);
  // --project <p> --town <t>: the town's kit curtain record (authoring/towns/<t>-works/kit-wall.json), the one `check` judges
  const out = opt("out") ?? (project && townName ? path.join("projects", project, "authoring", "towns", `${townName}-works`, "kit-wall.json") : undefined);
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ line, closed, towers, gates, placements, findings, notes: lay.notes }, null, 1) + "\n"); console.log(`wrote ${out}`); }
  console.log(findings.length ? `kit wall: ${findings.length} finding(s)` : "kit wall: OK (no gap over 5 cm, no overlap)");
  process.exit(findings.length ? 1 : 0);
}
if (!cmd || !["check", "draw"].includes(cmd) || !project || !townName) { console.error("usage: town-wall-line check|draw --project <p> --town <name> [...] | kit --circle r,n | --line f [--project p --town t]"); process.exit(2); }
const r2 = (v: number) => Math.round(v * 100) / 100;

const projectDir = path.join("projects", project);
const towns = path.join(projectDir, "authoring", "towns");
// the town doc names the town and its world; before the town doc exists (town-npcs writes it) the approved design does
const tdocFile = [path.join(towns, `${townName}.json`), path.join(towns, `${townName}-design.json`)].find((f) => fs.existsSync(f));
if (!tdocFile) throw new Error(`no ${townName}.json or ${townName}-design.json in ${towns}`);
const tdoc = JSON.parse(fs.readFileSync(tdocFile, "utf8")) as { town: string; world: string };
// --recipe <file>: a scratch / lab copy of the world (the town tools' convention)
const recipeFile = opt("recipe") ? path.resolve(opt("recipe")!) : path.join(projectDir, "assets", "worlds", `${tdoc.world}.json`);
const recipe: WorldRecipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(recipeFile, "utf8")));
const town = recipe.features.towns.find((t) => t.id === tdoc.town);
if (!town) throw new Error(`no town ${tdoc.town} in ${recipeFile}`);
const layout = JSON.parse(fs.readFileSync(path.join(towns, `${townName}-layout.json`), "utf8")) as { buildings: { id: string; full?: V2[]; corners: V2[]; door?: V2 }[] };

// ---- the ground: one 2 m grid over the town and its band (bilinear), the drawn ground where the world has DC terrain
const field = createWorldField(recipe);
const G = 2, span = town.radius + 200, gx0 = town.center[0] - span, gz0 = town.center[1] - span, gn = Math.ceil((2 * span) / G) + 1;
const grid = new Float32Array(gn * gn);
for (let j = 0; j < gn; j++) for (let i = 0; i < gn; i++) { const x = gx0 + i * G, z = gz0 + j * G; grid[j * gn + i] = field.ground?.(x, z) ?? field.height(x, z); }
const H = (x: number, z: number): number => {
  const fx = Math.max(0, Math.min(gn - 1.001, (x - gx0) / G)), fz = Math.max(0, Math.min(gn - 1.001, (z - gz0) / G));
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const a = grid[j * gn + i]!, b = grid[j * gn + i + 1]!, c = grid[(j + 1) * gn + i]!, d = grid[(j + 1) * gn + i + 1]!;
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
};
const sea = recipe.seaLevel;

// ---- what the wall protects: a townsman at every door and along every street
// the town's OWN streets: town-layout lanes (`<town>-lane-*`) and the from-plan cut's streets, stairs and ramps
// (`<town>-street-*` / `-stair-*` / `-ramp-*`): townsfolk walk them (overlook targets), the curtain may run beside them
const ownStreet = (id: string): boolean => ["lane", "street", "stair", "ramp"].some((k) => id.startsWith(`${town.id}-${k}-`));
const lanes = recipe.features.roads.filter((r) => ownStreet(r.id));
const targets: { name: string; at: V2 }[] = [
  ...layout.buildings.filter((b) => b.door).map((b) => ({ name: `door ${b.id}`, at: b.door! })),
  ...lanes.flatMap((r) => densify(r.points.map((p) => [p[0]!, p[1]!] as V2), 6).map((p, i) => ({ name: `${r.id.slice(town.id.length + 6)} #${i}`, at: p }))),
];
const shelves = (town.terraces ?? []).map((t) => ({ groundY: t.groundY, points: t.points.map((p) => [p[0]!, p[1]!] as V2), radius: t.radius }));
const allRoads = recipe.features.roads.filter((r) => !ownStreet(r.id)).map((r) => ({ id: r.id, points: r.points.map((p) => [p[0]!, p[1]!] as V2) }));
/** the disc round a gatehouse inside which its road passes the wall (the ring's corners stand GH*sqrt2 = 5.9 m out) */
const GATE_DISC = 8;
const townList = recipe.features.towns.map((t) => ({ id: t.id, name: t.id === town.id ? townName : undefined, center: t.center, radius: t.radius }));

function screenOf(doc: Record<string, unknown>, rc: WorldRecipe): Screen {
  const id = String(doc.id);
  const w = buildWall(operatorParams(doc), operatorReader(rc, id), { id });
  return { id, profile: (w.report.profile as [number, number, number][]) ?? [] };
}
function judge(docs: Record<string, unknown>[], rc: WorldRecipe, kitScreens: Screen[] = [], kitWalls: { id: string; points: V2[] }[] = [], kitGates: V2[] = []) {
  const curtains = docs.filter((d) => d.variant !== "quay" && d.variant !== "retaining");
  const screens = [...docs.map((d) => screenOf(d, rc)), ...kitScreens];
  const curtainScreens = [...screens.filter((s) => curtains.some((c) => c.id === s.id)), ...kitScreens];
  const enclosure = hull([...targets.map((t) => t.at), ...docs.flatMap((d) => d.points as V2[])]);
  const ov = overlook({ height: H, screens: curtainScreens.length ? curtainScreens : screens, enclosure, targets, sea });
  // occluders include every town wall (the quay, the gatehouse): the overlook gate above uses the curtains as the line
  // the viewers stand outside of; a second pass is not needed for the sea side (viewers there stand below the shelves)
  const water = waterlineRuns({ height: H, screens: curtainScreens, shelves, sea });
  const material = docs.map((d) => townWallMaterialFault(d as never)).filter((x): x is string => !!x);
  const machine = docs.map((d) => townWallHandmadeFault(d as never)).filter((x): x is string => !!x);
  const exempt = [...docs.filter((d) => String(d.id).endsWith("-gatehouse")).map((d) => { const p = (d.points as V2[]).slice(0, 4); return { at: [p.reduce((a, q) => a + q[0], 0) / p.length, p.reduce((a, q) => a + q[1], 0) / p.length] as V2, r: GATE_DISC }; }), ...kitGates.map((at) => ({ at, r: GATE_DISC }))];
  const road = roadCrowding([...curtains.filter((d) => !String(d.id).endsWith("-gatehouse")).map((d) => ({ id: String(d.id), points: d.points as V2[] })), ...kitWalls], allRoads, exempt);
  return { ov, water, material, machine, road, screens };
}

// ================================================================ the kit curtain (town-wall-line kit --project --town)
const kitFile = path.join(towns, `${townName}-works`, "kit-wall.json");
/** Kit wall pieces' tops over their origin (the strand kit: run / infill / kink / corner 6.1 m, tower 11.25 m, gatehouse body 8 m). */
const KIT_TOP = (prefab: string): number => (/-tower$/.test(prefab) ? 11.25 : /-gatehouse$/.test(prefab) ? 8 : 6.1);
/**
 * The town's kit curtain, judged as BUILT: the record's line re-laid must join (no gap over 5 cm, no overlap); the scene
 * (assets/scenes/<world>.scene.json, or --scene) must hold every placement (prefab, x/z within 2 cm, yaw within 0.2 deg,
 * entities tagged `town-wall:<town>`) and nothing else under that tag; all pieces on one level (2 cm: the kit's pieces
 * are flat, a step between neighbours is a hole). Returns its screens (tops from the placed y) for the overlook gate.
 */
function kitCurtain(failures: string[]): { screens: Screen[]; walls: { id: string; points: V2[] }[]; gates: V2[] } | null {
  if (!fs.existsSync(kitFile)) return null;
  const rec = JSON.parse(fs.readFileSync(kitFile, "utf8")) as { line: V2[]; closed: boolean; towers: number[]; gates: number[]; placements: { prefab: string; kind: string; position: number[]; yaw: number }[] };
  const sceneFile = opt("scene") ?? path.join(projectDir, "assets", "scenes", `${tdoc.world}.scene.json`);
  return kitJudge(rec, sceneFile, failures);
}
const { kitJudge } = await import("./_kit-wall-judge.mts").then((m) => ({ kitJudge: (rec: never, sceneFile: string, failures: string[]) => m.judgeKitCurtain(rec, sceneFile, `town-wall:${townName}`, KIT_TOP, failures) }));

// ================================================================ check
if (cmd === "check") {
  // --docs <file>: judge a DRAFT (draw's output) in place of the recipe's ops of the same ids (before an apply)
  const draft = opt("docs") ? (JSON.parse(fs.readFileSync(opt("docs")!, "utf8")) as Record<string, unknown>[]) : [];
  const docs = [...(recipe.features.operators ?? []).filter((o) => townOwnerOf(o as never, townList) === town.id && !draft.some((d) => d.id === o.id) && !(draft.length && /-(town-)?wall/.test(o.id))) as Record<string, unknown>[], ...draft];
  const out = opt("json") ?? path.join(towns, "survey", `${townName}-wall-line.json`);
  const failures: string[] = [];
  const kit = kitCurtain(failures);
  if (!docs.length && !kit) failures.push(`no wall owned by ${townName}: no wall operator (named ${townName}-… or inside its radius) and no kit curtain (${path.relative(".", kitFile)})`);
  const j = docs.length || kit ? judge(docs, recipe, kit?.screens ?? [], kit?.walls ?? [], kit?.gates ?? []) : null;
  if (j) {
    for (const m of j.material) failures.push(`cliff-skin: ${m}`);
    for (const m of j.machine) failures.push(`machine-top: ${m}`);
    if (j.ov.worst) failures.push(`overlooked: ${j.ov.overlooking} point(s) outside within ${OVERLOOK_RULE.band} m see into the town over the wall; worst at ${j.ov.worst.at.slice(0, 2).join(",")} ground ${j.ov.worst.at[2]} m, ${j.ov.worst.over} m over the top of ${j.ov.worst.wall}, sees ${j.ov.worst.sees}`);
    for (const r of j.road) failures.push(`road: ${r.wall} runs ${r.d} m from ${r.road} at ${r.at.join(",")} (keep ${ROAD_KEEP} m off a road except at the gatehouse)`);
    if (j.water.length) failures.push(`waterline: ${j.water.length} stretch(es) of ${[...new Set(j.water.map((w) => w.wall))].join(", ")} at the sea with tops below the shelves they front (worst ${j.water[0]!.at.join(",")}: top ${j.water[0]!.top} < shelf ${j.water[0]!.shelf})`);
  }
  const report = { town: townName, at: new Date().toISOString(), walls: docs.map((d) => String(d.id)), rule: OVERLOOK_RULE, ok: failures.length === 0, failures,
    road: j?.road ?? [], overlook: j ? { viewers: j.ov.viewers, aboveTop: j.ov.above, overlooking: j.ov.overlooking, worst: j.ov.worst, sample: j.ov.findings.slice(0, Number(opt("sample") ?? 20)) } : null, waterline: j?.water ?? [] };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 1) + "\n");
  console.log(`WALL LINE ${townName}: ${docs.length} wall op(s) [${docs.map((d) => d.id).join(", ")}]${j ? `; ${j.ov.viewers} viewers outside within ${OVERLOOK_RULE.band} m, ${j.ov.above} above the wall top, ${j.ov.overlooking} see in` : ""}`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  console.log(`  -> ${failures.length ? "FAILED" : "ok"} (${out})`);
  process.exit(failures.length ? 1 : 0);
}

// ================================================================ draw
const clear = num("clear", 12);
let height = num("height", 6);
// civic defence: dressed ashlar over a rubble footing, hand-made top (townWallFinish; townWallStyle picks the risers')
void townWallStyle;
const { handmade, materials } = townWallFinish({ machineTop: argv.includes("--machine-top") });
// 1. the protected outline: shipped lot corners + streets, hulled, grown
const prot: V2[] = [...layout.buildings.flatMap((b) => b.full ?? b.corners), ...lanes.flatMap((r) => r.points.map((p) => [p[0]!, p[1]!] as V2))];
const grown = grow(hull(prot), clear);
const lowest = Math.min(...shelves.map((s) => s.groundY), town.groundY);
const landward = grown.map((p) => H(p[0], p[1]) > lowest + 1 && H(p[0], p[1]) > sea + OVERLOOK_RULE.waterline);
// the longest cyclic run of landward vertices
let best: number[] = [];
for (let s = 0; s < grown.length; s++) {
  if (!landward[s] || landward[(s + grown.length - 1) % grown.length]) continue;
  const run: number[] = [];
  for (let k = 0; k < grown.length && landward[(s + k) % grown.length]; k++) run.push((s + k) % grown.length);
  if (run.length > best.length) best = run;
}
if (best.length < 2) throw new Error("no landward arc round the town (a flat or island site: no wall line to draw)");
let line: V2[] = densify(best.map((i) => grown[i]!), 6);
// 2. the ends meet the sea side's built works: the lowest riser's face corners, else a town quay's ends
const risers = (recipe.features.terraceWalls ?? []).filter((t) => t.owner === town.id && t.solved?.faces?.length);
const lowRiser = risers.sort((a, b) => (a.topY ?? 0) - (b.topY ?? 0))[0];
const joins: V2[] = [
  ...(lowRiser?.solved?.faces ?? []).flatMap((f) => [f.a as V2, f.b as V2]),
  // the lowest shelf's SEA CORNERS: its footprint vertices on the face line, also where no wall stands (a riser that
  // stops at a quay deck: terrace-kerb) — the curtain closes onto the shelf's corner, the quay takes the sea face
  ...(lowRiser?.solved?.faces ?? []).flatMap((f) => (lowRiser!.footprint as V2[]).filter((q) => Math.abs((q[0] - f.a[0]) * f.normal[0] + (q[1] - f.a[1]) * f.normal[1]) < 0.5)),
  ...(recipe.features.operators ?? []).filter((o) => o.op === "wall" && (o as { variant?: string }).variant === "quay" && townOwnerOf(o as never, townList) === town.id).flatMap((o) => { const p = (o as { points: V2[] }).points; return [p[0]!, p[p.length - 1]!]; }),
];
for (const end of [0, 1]) {
  const e = end === 0 ? line[0]! : line[line.length - 1]!;
  const j = joins.map((p) => ({ p, d: dist2(p, e) })).sort((a, b) => a.d - b.d)[0];
  // the line runs on to the join along the ground (a densified leg, so the push can lift it too)
  if (j && j.d <= num("join", 45) && j.d > 1) { const leg = densify([e, j.p], 6).slice(1); end === 0 ? line.unshift(...leg.reverse()) : line.push(...leg); }
}
const fixed = new Set([0, line.length - 1]);
// 3. the gate roads (leave the town gate) — the line may cross them only at the gatehouse; others it keeps 5 m off
const gates = (town.gates ?? []).map((g) => g.at as V2);
const gateRoads = recipe.features.roads.filter((r) => !r.id.startsWith(`${town.id}-lane-`) && gates.some((g) => dist2(g, r.points[0] as V2) < 3 || dist2(g, r.points[r.points.length - 1] as V2) < 3));
const centroid: V2 = [prot.reduce((s, p) => s + p[0], 0) / prot.length, prot.reduce((s, p) => s + p[1], 0) / prot.length];

function crossAt(a: V2[], b: V2[]): { p: V2; i: number; dir: V2 } | null {
  for (let i = 0; i + 1 < a.length; i++) for (let k = 0; k + 1 < b.length; k++) {
    const p0 = a[i]!, p1 = a[i + 1]!, q0 = b[k]!, q1 = b[k + 1]!;
    const rx = p1[0] - p0[0], rz = p1[1] - p0[1], sx = q1[0] - q0[0], sz = q1[1] - q0[1], den = rx * sz - rz * sx;
    if (Math.abs(den) < 1e-9) continue;
    const qx = q0[0] - p0[0], qz = q0[1] - p0[1], t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) continue;
    const l = Math.hypot(sx, sz) || 1;
    return { p: [p0[0] + rx * t, p0[1] + rz * t], i, dir: [sx / l, sz / l] };
  }
  return null;
}

const GH = 4.2; // gatehouse half-side (outer line), m
let gatePin: V2 | null = null;
// THE GATEHOUSE PIN: where the drafted line first crosses a gate road, slid along that road leg to stand >= GH + 2 m
// from both its ends (a passage on a straight stretch: a road turning inside the ring leaves through its side wall);
// the line vertex nearest it moves onto it and is held there through the push
{
  for (const r of gateRoads) {
    const rp = r.points.map((q) => [q[0]!, q[1]!] as V2), c = crossAt(line, rp);
    if (!c) continue;
    let k = 0, bd = Infinity; for (let i = 0; i + 1 < rp.length; i++) { const sd = segDist(c.p, rp[i]!, rp[i + 1]!).d; if (sd < bd) { bd = sd; k = i; } }
    const a = rp[k]!, b = rp[k + 1]!, len = dist2(a, b), t = segDist(c.p, a, b).t * len, m = GH + 2;
    const tt = len >= 2 * m ? Math.max(m, Math.min(len - m, t)) : len / 2;
    const pin: V2 = [r2(a[0] + ((b[0] - a[0]) * tt) / len), r2(a[1] + ((b[1] - a[1]) * tt) / len)];
    let vi = 1, vd = Infinity; line.forEach((q, i) => { if (i === 0 || i === line.length - 1) return; const d = dist2(q, pin); if (d < vd) { vd = d; vi = i; } });
    // the line runs through the pin: the vertices round it go (the pin is the gatehouse's centre)
    line = [...line.slice(0, vi).filter((q, i) => i === 0 || dist2(q, pin) > 10), pin, ...line.slice(vi + 1).filter((q, i, a) => i === a.length - 1 || dist2(q, pin) > 10)];
    fixed.clear(); fixed.add(0); fixed.add(line.length - 1); fixed.add(line.indexOf(pin));
    gatePin = pin;
    console.log(`  gatehouse pin on ${r.id} leg ${k} at ${pin.join(",")} (crossing was ${c.p.map(r2).join(",")})`);
    break;
  }
}
function docsFor(pts: V2[], hs: Record<string, number>): Record<string, unknown>[] {
  const h = Math.max(...Object.values(hs), height); // the gatehouse stands over the tallest curtain
  // the road keep-off: every vertex outside the gatehouse disc stands ROAD_KEEP + 0.5 m off every road; straight legs
  // that cut back inside it (simplify) are refined until none does
  const exempt = gatePin ? [{ at: gatePin, r: GATE_DISC }] : [];
  const guarded = keepOffRoads(pts, allRoads.map((r) => r.points), exempt, fixed, centroid);
  const legsAt = (tol: number) => simplify(guarded, tol).map((p) => [r2(p[0]), r2(p[1])] as V2).filter((p, i, a) => i === 0 || dist2(p, a[i - 1]!) >= 1);
  let legs = legsAt(num("simplify", 2.5));
  for (const tol of [1.5, 0.8, 0.3]) { if (!roadCrowding([{ id: "line", points: legs }], allRoads, exempt, ROAD_KEEP - 0.25).length) break; legs = legsAt(tol); }
  // which side is outside: right of travel = (-dz, dx); outside = away from the town's centroid
  const mid = Math.floor(legs.length / 2), a = legs[Math.max(0, mid - 1)]!, b = legs[mid]!;
  const right: V2 = [-(b[1] - a[1]), b[0] - a[0]], toC: V2 = [centroid[0] - (a[0] + b[0]) / 2, centroid[1] - (a[1] + b[1]) / 2];
  const face = right[0] * toC[0] + right[1] * toC[1] > 0 ? "left" : "right";
  const back = face === "left" ? "right" : "left";
  const curtain = (id: string, p: V2[], ends: { start: string; end: string }) => ({
    id, op: "wall", variant: "free", smooth: false, points: p, height: hs[id] ?? height, heightMode: "follow", thickness: 1.4, batter: 0.06,
    footing: { depth: 1, projection: 0.3, plinth: 0.35 }, parapet: { height: 1.1, thickness: 0.45, side: "face", crenels: { merlon: 1.4, gap: 0.8 } },
    buttresses: { every: 12, depth: 1, width: 1.2, side: "face" }, face, ends, materials, handmade,
  });
  // the gatehouse where a gate road crosses
  let cut: { p: V2; dir: V2 } | null = null;
  for (const r of gateRoads) { const c = crossAt(legs, r.points.map((q) => [q[0]!, q[1]!] as V2)); if (c) { cut = c; break; } }
  if (!cut) return [curtain(`${townName}-wall-1`, legs, { start: "pier", end: "pier" })];
  // stations along the legs
  const cum = [0]; for (let i = 1; i < legs.length; i++) cum.push(cum[i - 1]! + dist2(legs[i - 1]!, legs[i]!));
  const stationOf = (q: V2) => { let bs = 0, bd = Infinity; for (let i = 0; i + 1 < legs.length; i++) { const s = segDist(q, legs[i]!, legs[i + 1]!); if (s.d < bd) { bd = s.d; bs = cum[i]! + s.t * (cum[i + 1]! - cum[i]!); } } return bs; };
  const at = (s: number): V2 => { let i = 1; while (i < cum.length - 1 && cum[i]! < s) i++; const t = (s - cum[i - 1]!) / (cum[i]! - cum[i - 1]! || 1), a0 = legs[i - 1]!, b0 = legs[i]!; return [r2(a0[0] + (b0[0] - a0[0]) * t), r2(a0[1] + (b0[1] - a0[1]) * t)]; };
  const sc = stationOf(cut.p), gap = 2 * GH - 1, L = cum[cum.length - 1]!;
  const keep = (r: V2[]) => r.filter((p, i, a) => i === 0 || dist2(p, a[i - 1]!) >= 1);
  const runA: V2[] = keep([...legs.filter((_, i) => cum[i]! < sc - gap / 2 - 1), at(sc - gap / 2)]);
  const runB: V2[] = keep([at(sc + gap / 2), ...legs.filter((_, i) => cum[i]! > sc + gap / 2 + 1)]);
  // the road's outward direction: from the gate side to the far side
  const d = cut.dir, p: V2 = [-d[1], d[0]], c = cut.p;
  const ring: V2[] = [[c[0] + d[0] * GH - p[0] * GH, c[1] + d[1] * GH - p[1] * GH], [c[0] + d[0] * GH + p[0] * GH, c[1] + d[1] * GH + p[1] * GH],
    [c[0] - d[0] * GH + p[0] * GH, c[1] - d[1] * GH + p[1] * GH], [c[0] - d[0] * GH - p[0] * GH, c[1] - d[1] * GH - p[1] * GH]].map((q) => [r2(q[0]), r2(q[1])] as V2);
  ring.push(ring[0]!);
  let gTop = -Infinity; for (let u = -GH; u <= GH; u += 1) for (let v = -GH; v <= GH; v += 1) gTop = Math.max(gTop, H(c[0] + d[0] * u + p[0] * v, c[1] + d[1] * u + p[1] * v));
  let gLow = Infinity; for (const q of ring) gLow = Math.min(gLow, H(q[0], q[1]));
  const gatehouse = {
    id: `${townName}-wall-gatehouse`, op: "wall", variant: "free", smooth: false, points: ring, height: r2(gTop - gLow + h + 3.5), heightMode: "level", topY: r2(gTop + h + 3.5),
    thickness: 1.4, batter: 0.02, footing: null, bury: 1.1, parapet: { height: 1.1, thickness: 0.45, side: "face", crenels: { merlon: 1.4, gap: 0.8 }, walked: false },
    openings: [{ name: "gate-out", at: GH, width: 4.4, height: 5, arch: true }, { name: "gate-in", at: 5 * GH, width: 4.4, height: 5, arch: true }],
    face: "left", ends: { start: "none", end: "none" }, materials, handmade,
  };
  const out: Record<string, unknown>[] = [];
  const runs = [runA, runB].filter((r) => r.length >= 2 && cum.length > 1);
  runs.forEach((run, k) => out.push(curtain(`${townName}-wall-${k + 1}`, run, k === 0 ? { start: "pier", end: "none" } : { start: "none", end: "pier" })));
  // a wall-walk stair on the town side of EACH run (the gatehouse top is not walked, so each run is its own walk): on
  // the FLATTEST straight leg long enough for the flight (a followed top on a steep leg puts the flight's head on a
  // sloping walk), clear of the corners at both ends of the leg: the wall operator drops every tread whose block reaches
  // a corner's mitre (|tan(turn/2)| x the flight's reach out from the line), so a flight ending 0.5 m short of a 58 deg
  // corner lost its top treads and never met the walk (Saltharrow wall-2, 10-29: stair-top + walk-mid unreached).
  // The flight may shorten to 1.5 m per metre of rise (treads >= 0.42 m at 0.28 m risers) to fit a leg.
  out.forEach((w) => {
    const ps = w.points as V2[], hw = Number(w.height) || h, full = hw * 1.9 + 1, least = hw * 1.5 + 1;
    const reach = Number(w.thickness ?? 1.4) / 2 + Number(w.batter ?? 0) * hw + 1.6 + 0.3;
    const clearAt = (i: number): number => { // the corner clearance at vertex i (0 at the line's ends)
      if (i <= 0 || i >= ps.length - 1) return 0;
      const a = ps[i - 1]!, b = ps[i]!, c = ps[i + 1]!;
      const t = Math.abs(Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])));
      return Math.abs(Math.tan(t / 2)) * reach + 0.4;
    };
    let st: { from: number; flight: number; grade: number; len: number } | null = null, s = 0;
    for (let i = 0; i + 1 < ps.length; i++) {
      const a = ps[i]!, b = ps[i + 1]!, l = dist2(a, b), c0 = Math.max(2, clearAt(i)), c1 = Math.max(0.5, clearAt(i + 1));
      const flight = Math.min(full, l - c0 - c1);
      if (flight >= least) {
        const grade = Math.abs(H(b[0], b[1]) - H(a[0], a[1])) / l;
        if (!st || grade < st.grade - 0.02 || (Math.abs(grade - st.grade) <= 0.02 && flight > st.flight + 0.5) || (Math.abs(grade - st.grade) <= 0.02 && Math.abs(flight - st.flight) <= 0.5 && l > st.len)) st = { from: s + c0, flight, grade, len: l };
      }
      s += l;
    }
    if (st) w.stairs = [{ from: r2(st.from), to: r2(st.from + st.flight), width: 1.6, riser: 0.28, side: "back" }];
  });
  void back; void L;
  return [...out, gatehouse];
}

// 4. push up the hill until nobody outside overlooks the town; then raise the wall
const pushed = new Map<number, number>();
const maxPush = num("max-push", 30);
const heights: Record<string, number> = {};
const maxHeight = num("max-height", 11);
let docs = docsFor(line, heights), j = judge(docs, recipe);
// the gate crossing: the only place the line may come near a road
const gh0 = docs.find((d) => String(d.id).endsWith("-gatehouse"));
const gate0: V2 | null = gatePin ?? (gh0 ? (() => { const p = (gh0.points as V2[]).slice(0, 4); return [p.reduce((a, q) => a + q[0], 0) / 4, p.reduce((a, q) => a + q[1], 0) / 4] as V2; })() : null);
const rounds = num("rounds", 40);
console.log(`  start: wall ${height} m, clear ${clear} m; overlooking ${j.ov.overlooking}${j.ov.worst ? ` (worst ${j.ov.worst.over} m at ${j.ov.worst.at.slice(0, 2).join(",")} sees ${j.ov.worst.sees})` : ""}`);
for (let round = 0; round < rounds && (j.ov.worst || j.water.length); round++) {
  const moved = new Set<number>();
  for (const f of j.ov.findings) {
    // the stretch the sight line passed over is too LOW: move the vertex nearest that crossing UP THE HILL (onto
    // higher ground its top rises with), outward; a sight line through a gap or round an end moves nothing
    if (!f.cross) continue;
    let bi = -1, bd = Infinity;
    line.forEach((q, i) => { if (fixed.has(i)) return; const d = dist2(q, f.cross!); if (d < bd) { bd = d; bi = i; } });
    if (bi < 0 || moved.has(bi) || (pushed.get(bi) ?? 0) >= maxPush) continue;
    const q = line[bi]!, o: V2 = [q[0] - centroid[0], q[1] - centroid[1]], l = Math.hypot(o[0], o[1]) || 1;
    const gq: V2 = [H(q[0] + 2, q[1]) - H(q[0] - 2, q[1]), H(q[0], q[1] + 2) - H(q[0], q[1] - 2)], gl = Math.hypot(gq[0], gq[1]);
    const up: V2 = gl > 0.2 && (gq[0] * o[0] + gq[1] * o[1]) > 0 ? [gq[0] / gl, gq[1] / gl] : [o[0] / l, o[1] / l];
    const nq: V2 = [q[0] + up[0] * 2, q[1] + up[1] * 2];
    // never onto a road other than at the gate crossing (gate roads are crossed once, at the gatehouse)
    if (!(gate0 && dist2(nq, gate0) < 14) && allRoads.some((r) => polyDist(nq, r.points) < ROAD_KEEP)) continue;
    // a smooth bulge, not a spike: the neighbours follow (1.2 / 0.5 of the push), held vertices never move
    line[bi] = nq; moved.add(bi); pushed.set(bi, (pushed.get(bi) ?? 0) + 2);
    for (const [k, w] of [[1, 0.6], [2, 0.25]] as const) for (const ni of [bi - k, bi + k]) {
      if (ni <= 0 || ni >= line.length - 1 || fixed.has(ni) || moved.has(ni)) continue;
      const nq2: V2 = [line[ni]![0] + up[0] * 2 * w, line[ni]![1] + up[1] * 2 * w];
      if (!(gate0 && dist2(nq2, gate0) < 14) && allRoads.some((r) => polyDist(nq2, r.points) < ROAD_KEEP)) continue;
      line[ni] = nq2;
    }
  }
  if (!moved.size) {
    // nothing left to move up the hill: raise the curtain the most sight lines pass over, a metre at a time
    const by = new Map<string, number>(); for (const f of j.ov.findings) if (f.cross) by.set(f.wall, (by.get(f.wall) ?? 0) + 1);
    const w = [...by.entries()].filter(([id]) => !id.endsWith("-gatehouse") && (heights[id] ?? height) < maxHeight).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!w) break;
    heights[w] = (heights[w] ?? height) + 1;
  }
  docs = docsFor(line, heights); j = judge(docs, recipe);
  console.log(`  round ${round + 1}: ${moved.size} vertex/vertices pushed, walls ${JSON.stringify(heights)} (base ${height} m); overlooking ${j.ov.overlooking}${j.ov.worst ? ` (worst ${j.ov.worst.over} m at ${j.ov.worst.at.slice(0, 2).join(",")})` : ""}, waterline ${j.water.length}`);
}
// no taller than it must be: each raised curtain comes back down a metre at a time while the gate still passes
for (const id of Object.keys(heights)) while (heights[id]! > height) {
  const trial = { ...heights, [id]: heights[id]! - 1 }, d2 = docsFor(line, trial), j2 = judge(d2, recipe);
  if (j2.ov.overlooking > j.ov.overlooking || j2.water.length > j.water.length) break;
  heights[id] = trial[id]!; docs = d2; j = j2;
}
console.log(`  lowered: walls ${JSON.stringify(heights)}`);
// straighten: two Laplacian passes over the pushed vertices, kept only when the gate is no worse (legs, not a saw)
for (let pass = 0; pass < 2; pass++) {
  const sm = line.map((q, i) => (fixed.has(i) || i === 0 || i === line.length - 1 ? q : ([0.25 * line[i - 1]![0] + 0.5 * q[0] + 0.25 * line[i + 1]![0], 0.25 * line[i - 1]![1] + 0.5 * q[1] + 0.25 * line[i + 1]![1]] as V2)));
  const d2 = docsFor(sm, heights), j2 = judge(d2, recipe);
  if (j2.ov.overlooking > j.ov.overlooking || j2.water.length > j.water.length) break;
  line = sm; docs = d2; j = j2;
  console.log(`  straightened (pass ${pass + 1}): overlooking ${j.ov.overlooking}`);
}
const out = opt("out") ?? path.join(towns, `${townName}-works`, "wall.op.json");
console.log(`DRAW ${townName}: ${docs.length} op(s) ${docs.map((d) => `${d.id} (${(d.points as V2[]).length} pts)`).join(", ")}; walls ${JSON.stringify(heights)} (base ${height} m), clear ${clear} m; overlooking ${j.ov.overlooking}, waterline ${j.water.length}, material faults ${j.material.length}, road ${j.road.length}`);
if (j.ov.worst) console.log(`  STILL OVERLOOKED: worst ${j.ov.worst.over} m at ${j.ov.worst.at.join(",")} sees ${j.ov.worst.sees}`);
void inPolygon;
if (!argv.includes("--dry")) { fs.writeFileSync(out, JSON.stringify(docs, null, 1) + "\n"); console.log(`  wrote ${out} -> worldgen op ${recipe.name} --project ${project} --apply ${out}; then tools/landmark.mts per op`); }

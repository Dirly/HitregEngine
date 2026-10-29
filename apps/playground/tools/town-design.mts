/**
 * town-design — the DESIGN PHASE of a town, before any ground is cut (2026-10-29; tools/town-design-schema.mts).
 *
 *   npx tsx tools/town-design.mts propose --project <p> --town <recipe town id> --name <stem> [--world w] [--force]
 *        reads the site (natural ground, fall line, coast, the gate, roads in, the site-needs score when the siting
 *        step wrote one) and the program (authoring/towns/<stem>-plan.json buildings, else a kit-proven default for
 *        the tier), drafts authoring/towns/<stem>-design.json from the old program shelves (`planProgramShelves`:
 *        the STARTING DRAFT only — straight bands, so `check` fails it as rows until the designer reshapes it) and
 *        renders the plan picture
 *   npx tsx tools/town-design.mts check  --project <p> --name <stem> [--no-kit-fit] [--json]
 *        every design rule (tools/town-design-check.mts) + kit-fit; exit 1 on a fault; rewrites the picture
 *   npx tsx tools/town-design.mts render --project <p> --name <stem> [--built]
 *        authoring/towns/survey/<stem>-design.png: terraces with levels, bank / wall / stepped edges, streets,
 *        squares, stairs and ramps with grades, footprints and doors, the gate and the landmark sightline, the
 *        check's verdict; --built draws the CUT ground (after `worldgen terrace --from-plan`) instead of the design
 *   npx tsx tools/town-design.mts schema   the document's JSON Schema
 *
 * --recipe <file> works on a scratch copy of the world. The designer agent's brief: tools/zonegen/briefs/town-design.md.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createWorldField, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";
import { checkDesign, densify, designedGround, footprintOf, inPoly, kitFitFaults, lineLength, polyEdgeDist, r2, siteFall, type DesignReport, type Envelopes, type V2 } from "./town-design-check.mts";
import { designPictureSvg, writeDesignPicture } from "./town-design-picture.mts";
import { DESIGN_RULE, townDesignSchema, type TownDesign } from "./town-design-schema.mts";
import { bareOfTown } from "./worldgen-terrace-from-plan.mts";
import { PROGRAM_RULE, bandStreet, planProgramShelves, programFromPlan } from "./worldgen-town-program.mts";
import { TERRACE_DEFAULTS } from "./worldgen-coastal-towns.mts";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "";
const opt = (name: string, fallback = ""): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const has = (name: string) => argv.includes(`--${name}`);

if (cmd === "schema") {
  console.log(JSON.stringify(z.toJSONSchema(townDesignSchema, { io: "input" }), null, 2));
  process.exit(0);
}
if (!["propose", "check", "render"].includes(cmd)) {
  console.error("usage: town-design propose|check|render|schema --project <p> --name <stem> [--town <id>] (see the header)");
  process.exit(2);
}
const project = opt("project");
const name = opt("name");
if (!project || !name) {
  console.error("town-design: --project <p> --name <stem>");
  process.exit(2);
}
const PG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectDir = path.join(PG, "projects", project);
const townsDir = path.join(projectDir, "authoring", "towns");
const designFile = path.join(townsDir, `${name}-design.json`);
const pictureFile = path.join(townsDir, "survey", `${name}-design.png`);
const envFile = path.join(townsDir, `${name}-envelopes.json`);
const envelopes: Envelopes = fs.existsSync(envFile) ? JSON.parse(fs.readFileSync(envFile, "utf8")) : {};

function loadWorld(world: string): { recipe: WorldRecipe; file: string } {
  const file = opt("recipe") ? path.resolve(opt("recipe")) : path.join(projectDir, "assets", "worlds", `${world}.json`);
  if (!fs.existsSync(file)) throw new Error(`no world recipe ${file} (--world / --recipe)`);
  return { recipe: worldRecipeSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))), file };
}

// ---------------------------------------------------------------- the default program (kit-proven requests)

/** Requests the kit has PROVEN (kit_fit.py ok, 2026-10-29, the Saltharrow builds), by role. */
const PROVEN: Record<string, { name: string; request: Record<string, unknown> }> = {
  chapel: { name: "Chapel", request: { system: "stone", size: [4, 8], storeys: 3, roof: "gable", features: ["church", "apse"] } },
  watch: { name: "Bell Watch", request: { system: "stone", size: [5, 5], storeys: 2, roof: "gable", features: ["tower"] } },
  vault: { name: "Vault", request: { system: "stone", size: [6, 5], storeys: 2, roof: "gable", features: ["grand_door", "small_windows", "strongroom", "no_fireplace"] } },
  inn: { name: "Inn", request: { system: "common", size: [7, 5], storeys: 2, roof: "gable", features: ["fireplace", "tall_chimney"] } },
  shop: { name: "Chandlery", request: { system: "common", size: [4, 5], storeys: 2, roof: "gable", features: ["fireplace", "shopfront"] } },
  forge: { name: "Forge", request: { system: "common", size: [5, 4], storeys: 1, roof: "gable", features: ["fireplace", "tall_chimney", "forge_bay"] } },
  smokehouse: { name: "Smokehouse", request: { system: "common", size: [4, 5], storeys: 2, roof: "gable", features: ["fireplace", "tall_chimney"] } },
  house: { name: "House", request: { system: "common", size: [4, 5], storeys: 2, roof: "gable", features: ["fireplace"] } },
};
function defaultProgram(tier: string | undefined): { id: string; name: string; request: Record<string, unknown> }[] {
  const roles = tier === "hamlet" ? ["chapel", "inn", "house", "house"] : tier === "village" ? ["chapel", "inn", "shop", "forge", "house", "house", "house"] : ["chapel", "watch", "vault", "inn", "shop", "forge", "smokehouse", "house", "house", "house", "house"];
  const n = new Map<string, number>();
  return roles.map((r) => {
    const k = (n.get(r) ?? 0) + 1;
    n.set(r, k);
    return { id: k > 1 ? `${r}-${k}` : r, name: k > 1 ? `${PROVEN[r]!.name} ${k}` : PROVEN[r]!.name, request: PROVEN[r]!.request };
  });
}

// ---------------------------------------------------------------- propose

function propose(): void {
  if (fs.existsSync(designFile) && !has("force")) throw new Error(`${path.relative(PG, designFile)} exists: the designer iterates it (check / render); --force drafts a new one over it`);
  const townId = opt("town");
  if (!townId) throw new Error("propose: --town <recipe town id>");
  const worldName = opt("world") || (fs.existsSync(path.join(townsDir, `${name}.json`)) ? JSON.parse(fs.readFileSync(path.join(townsDir, `${name}.json`), "utf8")).world : "");
  if (!worldName) throw new Error("propose: --world <name> (no authoring/towns/<stem>.json says)");
  const { recipe } = loadWorld(worldName);
  const town = recipe.features.towns.find((t) => t.id === townId);
  if (!town) throw new Error(`no town ${townId} in ${recipe.name}`);
  const bare = createWorldField(bareOfTown(recipe, town.id));
  const height = (x: number, z: number) => bare.heightfield(x, z);
  const c = town.center as V2;
  const fall = siteFall(height, c, Math.min(60, town.radius));
  const up: V2 = [-fall.downhill[0], -fall.downhill[1]];
  // the program
  const planFile = path.join(townsDir, `${name}-plan.json`);
  const program = fs.existsSync(planFile)
    ? (JSON.parse(fs.readFileSync(planFile, "utf8")).buildings as { id: string; name: string; request?: Record<string, unknown>; model?: string }[]).filter((b) => b.request || b.model)
    : defaultProgram(town.tier);
  const prog = programFromPlan({ buildings: program as never }, envelopes, fs.existsSync(planFile) ? "plan" : "default program");
  // the gate: the recipe town's first, else landward (up the fall line) on the pad circle
  const g0 = town.gates[0];
  const gate = g0 ? { at: [r2(g0.at[0]), r2(g0.at[1])] as V2, facing: [r2(g0.facing[0]), r2(g0.facing[1])] as V2 } : { at: [r2(c[0] + up[0] * town.radius), r2(c[1] + up[1] * town.radius)] as V2, facing: up };
  // THE STARTING DRAFT: the old program bands (straight shelves along the contour)
  const shelves = planProgramShelves({
    height, sea: recipe.seaLevel, centre: c, radius: town.radius, required: prog.area, across: prog.across, acrossTypical: prog.acrossTypical,
    street: PROGRAM_RULE.street, riser: TERRACE_DEFAULTS.riser, maxStep: 6, minStep: 1.5, maxTerraces: TERRACE_DEFAULTS.maxTerraces,
    reach: Math.max(60, town.radius * 1.8), cutTol: 3, maxRelief: 30, inset: 1.5,
  });
  const notes: string[] = [`drafted ${new Date().toISOString().slice(0, 10)} by town-design propose from the program bands (${shelves.ok ? "fits" : `short: ${shelves.why[0] ?? ""}`}); straight bands are the old path — reshape them`];
  let bands = shelves.bands;
  if (!bands.length) {
    // flat or failed: one platform round the centre at the median ground
    const hs: number[] = [];
    for (let dz = -20; dz <= 20; dz += 4) for (let dx = -20; dx <= 20; dx += 4) hs.push(height(c[0] + dx, c[1] + dz));
    hs.sort((p, q) => p - q);
    const u: V2 = [-fall.downhill[1], fall.downhill[0]];
    bands = [{ a: [c[0] - u[0] * 30, c[1] - u[1] * 30], b: [c[0] + u[0] * 30, c[1] + u[1] * 30], a0: -30, a1: 30, w: 0, length: 60, depth: 36, level: r2(hs[Math.floor(hs.length / 2)]!), stops: ["", ""] }];
    notes.push("no program band fitted: one 60 x 36 m platform at the median ground");
  }
  // risers between bands snapped to kit wall heights (so a wall between two terraces is one the kit has)
  const levels: number[] = [];
  bands.forEach((b, i) => {
    if (i === 0) return levels.push(b.level);
    const drop = b.level - levels[i - 1]!;
    const snap = [...DESIGN_RULE.kitHeights].sort((p, q) => Math.abs(p - drop) - Math.abs(q - drop))[0]!;
    levels.push(r2(levels[i - 1]! + (Math.abs(snap - drop) <= 0.6 ? snap : drop)));
  });
  const terraces: TownDesign["terraces"] = [];
  const streets: TownDesign["streets"] = [];
  const connections: TownDesign["connections"] = [];
  const buildings: TownDesign["buildings"] = [];
  bands.forEach((b, i) => {
    const l = Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1]) || 1;
    const ax: V2 = [(b.b[0] - b.a[0]) / l, (b.b[1] - b.a[1]) / l];
    const left: V2 = [-ax[1], ax[0]];
    const h = b.depth / 2;
    const P = (p: V2, s: number): V2 => [r2(p[0] + left[0] * s), r2(p[1] + left[1] * s)];
    terraces.push({ id: `t${i + 1}`, name: `Terrace ${i + 1}`, level: levels[i]!, polygon: [P(b.a, -h), P(b.b, -h), P(b.b, h), P(b.a, h)], buildings: [], edges: [] });
    const st = bandStreet(b, fall.downhill, prog.acrossTypical, PROGRAM_RULE.street, 1.5);
    // keep the street a kerb in from a seaward edge
    const off = st.offset === 0 ? 0 : Math.sign(st.offset) * Math.max(0, Math.abs(st.offset) - PROGRAM_RULE.kerb);
    const s0: V2 = [b.a[0] + ax[0] * 2 + left[0] * off, b.a[1] + ax[1] * 2 + left[1] * off];
    const s1: V2 = [b.b[0] - ax[0] * 2 + left[0] * off, b.b[1] - ax[1] * 2 + left[1] * off];
    streets.push({ id: `street-${i + 1}`, name: i === 0 ? "Main Street" : `Upper Street ${i}`, kind: i === 0 ? "main" : "lane", points: [[r2(s0[0]), r2(s0[1])], [r2(s1[0]), r2(s1[1])]], width: 5, surface: "gravel" });
    if (i > 0) {
      // switchback: alternate ends, a stair where a ramp does not fit
      const lower = streets[i - 1]!.points, upper = streets[i]!.points;
      const end = i % 2 === 1 ? 1 : 0;
      const a = lower[end === 1 ? lower.length - 1 : 0]!, z2 = upper[end === 1 ? upper.length - 1 : 0]!;
      const run = Math.hypot(z2[0] - a[0], z2[1] - a[1]);
      const rise = levels[i]! - levels[i - 1]!;
      connections.push({ id: `up-${i}`, kind: rise / run <= DESIGN_RULE.rampGrade ? "ramp" : "stair", from: `t${i}`, to: `t${i + 1}`, points: [a, z2], width: 4, street: `street-${i + 1}` });
    }
  });
  // the gate: on a terrace, or a connection from it to the nearest
  if (!terraces.some((t) => inPoly(t.polygon, gate.at[0], gate.at[1]) || polyEdgeDist(t.polygon, gate.at[0], gate.at[1]).d <= 2)) {
    const near = terraces.map((t) => ({ t, d: polyEdgeDist(t.polygon, gate.at[0], gate.at[1]).d })).sort((p, q) => p.d - q.d)[0]!;
    const inward: V2 = [-gate.facing[0], -gate.facing[1]];
    const end: V2 = [r2(gate.at[0] + inward[0] * (near.d + 2)), r2(gate.at[1] + inward[1] * (near.d + 2))];
    const rise = Math.abs(near.t.level - height(gate.at[0], gate.at[1]));
    connections.push({ id: "gate-way", kind: rise / Math.max(1, near.d + 2) <= DESIGN_RULE.rampGrade ? "ramp" : "stair", from: "gate", to: near.t.id, points: [gate.at, end], width: 5, street: "gate-street" });
    streets.push({ id: "gate-street", name: "Gate Street", kind: "main", points: [gate.at, end], width: 5, surface: "gravel" });
  }
  // a square on the terrace nearest the gate, at its gate end
  const gateT = terraces.map((t) => ({ t, d: polyEdgeDist(t.polygon, gate.at[0], gate.at[1]).d * (inPoly(t.polygon, gate.at[0], gate.at[1]) ? 0 : 1) })).sort((p, q) => p.d - q.d)[0]!.t;
  const gs = streets[terraces.indexOf(gateT)]!;
  const gEnd = [gs.points[0]!, gs.points[gs.points.length - 1]!].sort((p, q) => Math.hypot(p[0] - gate.at[0], p[1] - gate.at[1]) - Math.hypot(q[0] - gate.at[0], q[1] - gate.at[1]))[0]!;
  // pulled inside the terrace (toward its centre) until every corner is 2 m in from its edges
  const tc: V2 = [gateT.polygon.reduce((a, p) => a + p[0], 0) / gateT.polygon.length, gateT.polygon.reduce((a, p) => a + p[1], 0) / gateT.polygon.length];
  let sq: V2[] = [];
  for (let k = 0; k <= 20; k++) {
    const m: V2 = [gEnd[0] + (tc[0] - gEnd[0]) * (k / 20), gEnd[1] + (tc[1] - gEnd[1]) * (k / 20)];
    sq = [[-7, -7], [7, -7], [7, 7], [-7, 7]].map(([dx, dz]) => [r2(m[0] + dx!), r2(m[1] + dz!)] as V2);
    if (sq.every((p) => inPoly(gateT.polygon, p[0], p[1]) && polyEdgeDist(gateT.polygon, p[0], p[1]).d >= 2)) break;
  }
  const squares: TownDesign["squares"] = [{ id: "gate-square", name: "Gate Square", kind: "gate", polygon: sq, terrace: gateT.id }];
  // buildings: biggest first along each band street, both sides when the band is deep enough, the landmark at the top band's far end
  const civic = (b: { request?: Record<string, unknown> }) => ((b.request?.features as string[] | undefined) ?? []).some((f) => ["church", "nave", "tower", "basilica", "apse"].includes(f));
  const landmark = program.find(civic) ?? program[0]!;
  const order = [landmark, ...program.filter((b) => b !== landmark)];
  const cursor = new Map<string, { u: number; side: number }[]>();
  for (const b of order) {
    const req = (b.request ?? program.find((q) => q.id === b.model)?.request) as { size: [number, number] } | undefined;
    if (!req) continue;
    const W = req.size[0] * DESIGN_RULE.cell, D = req.size[1] * DESIGN_RULE.cell;
    const tries = b === landmark ? [terraces.length - 1] : terraces.map((_, i) => i);
    let placed = false;
    for (const ti of tries) {
      const t = terraces[ti]!, st = streets[ti]!;
      const [p0, p1] = [st.points[0]!, st.points[st.points.length - 1]!];
      const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
      const ax: V2 = [(p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L], left: V2 = [-ax[1], ax[0]];
      for (const side of [1, -1]) {
        const used = cursor.get(`${ti}:${side}`) ?? [];
        let u = used.length ? used[used.length - 1]!.u : b === landmark && Math.hypot(p1[0] - gate.at[0], p1[1] - gate.at[1]) > Math.hypot(p0[0] - gate.at[0], p0[1] - gate.at[1]) ? L - W - 4 : 2;
        const back = st.width / 2 + 1.5 + 0.55 * DESIGN_RULE.cell + D / 2;
        const ctr: V2 = [r2(p0[0] + ax[0] * (u + W / 2) + left[0] * side * back), r2(p0[1] + ax[1] * (u + W / 2) + left[1] * side * back)];
        const cand = { id: b.id, name: b.name ?? b.id, at: ctr, facing: [r2(-left[0] * side), r2(-left[1] * side)] as V2, street: st.id, ...(b.request ? { request: b.request as never } : { model: b.model! }) };
        const f = footprintOf({ buildings: [...buildings, cand as never] }, cand as never, envelopes);
        const inside = densify(f.ground, 1, true).every((p) => inPoly(t.polygon, p[0], p[1]) && polyEdgeDist(t.polygon, p[0], p[1]).d >= 1.5);
        const offSquare = !densify(f.ground, 1, true).some((p) => squares.some((s) => inPoly(s.polygon, p[0], p[1])));
        if (inside && offSquare && u + W <= L) {
          buildings.push(cand as never);
          t.buildings.push(b.id);
          used.push({ u: u + W + 0.9 * DESIGN_RULE.cell + 1.2, side });
          cursor.set(`${ti}:${side}`, used);
          placed = true;
          break;
        }
        if (!offSquare && u + W <= L) { used.push({ u: u + 16, side }); cursor.set(`${ti}:${side}`, used); }
      }
      if (placed) break;
    }
    if (!placed) notes.push(`${b.id}: no room on the draft bands — the designer places it`);
  }
  // a building no band took still goes in the file, at the top band's centre, so the program stays whole
  let spare = 0;
  for (const b of order) if (!buildings.some((q) => q.id === b.id)) {
    const t = terraces[terraces.length - 1]!;
    const cx = t.polygon.reduce((s, p) => s + p[0], 0) / 4, cz = t.polygon.reduce((s, p) => s + p[1], 0) / 4;
    const u: V2 = [-fall.downhill[1], fall.downhill[0]];
    const at: V2 = [r2(cx + up[0] * 40 + u[0] * (spare * 22 - 30)), r2(cz + up[1] * 40 + u[1] * (spare * 22 - 30))];
    spare++;
    buildings.push({ id: b.id, name: b.name ?? b.id, at, facing: [r2(fall.downhill[0]), r2(fall.downhill[1])], street: streets[terraces.length - 1]!.id, ...(b.request ? { request: b.request as never } : { model: b.model! }) } as never);
    t.buildings.push(b.id);
  }
  // the site-needs score, when the siting step wrote one (tools/site-needs, authoring/siting/<world>/)
  const siting = path.join(projectDir, "authoring", "siting", recipe.name, "candidates.json");
  if (fs.existsSync(siting)) notes.push(`site needs: see ${path.relative(projectDir, siting).replace(/\\/g, "/")}`);
  const roadsIn = recipe.features.roads.filter((r) => !r.id.startsWith(`${town.id}-`) && r.points.some((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) < town.radius + 40)).map((r) => r.id);
  notes.push(`site: fall ${(fall.slope * 100).toFixed(0)} % toward (${r2(fall.downhill[0])}, ${r2(fall.downhill[1])}), ${town.coastal ? "coastal" : "inland"}, roads in: ${roadsIn.join(", ") || "none"}`);
  const doc: TownDesign = townDesignSchema.parse({
    version: 1, town: town.id, world: recipe.name, name, title: opt("title") || name, status: "draft",
    idea: "DRAFT: write the town's one-sentence idea (what it is, how it sits on its ground)",
    gate, ...(town.coastal ? { harbour: nearestWater(height, recipe.seaLevel, c) } : {}),
    districts: [], terraces, streets, squares, connections, landmark: { building: landmark.id }, buildings, note: notes.join("; "),
  });
  fs.mkdirSync(townsDir, { recursive: true });
  fs.writeFileSync(designFile, JSON.stringify(doc, null, 1) + "\n");
  console.log(`wrote ${path.relative(PG, designFile)}: ${terraces.length} terraces, ${streets.length} streets, ${connections.length} connections, ${buildings.length} buildings (a DRAFT)`);
  for (const n of notes) console.log(`  ${n}`);
}

function nearestWater(height: (x: number, z: number) => number, sea: number, c: V2): V2 {
  let best: V2 = c, bd = Infinity;
  for (let r = 4; r <= 160; r += 4)
    for (let a = 0; a < 360; a += 10) {
      const x = c[0] + Math.cos((a * Math.PI) / 180) * r, z = c[1] + Math.sin((a * Math.PI) / 180) * r;
      if (height(x, z) < sea && r < bd) { bd = r; best = [r2(x), r2(z)]; }
    }
  return best;
}

// ---------------------------------------------------------------- check

function loadDesign(): TownDesign {
  if (!fs.existsSync(designFile)) throw new Error(`no ${path.relative(PG, designFile)} (town-design propose first)`);
  const raw = JSON.parse(fs.readFileSync(designFile, "utf8"));
  const parsed = townDesignSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${path.relative(PG, designFile)} is not a valid town design:\n${parsed.error.message}`);
  return parsed.data;
}

function kitFit(): { faults: string[]; line: string } {
  if (has("no-kit-fit")) return { faults: [], line: "kit-fit skipped (--no-kit-fit)" };
  const wfc = process.env.HITREG_WFC_DIR ?? path.resolve(PG, "../../../MMO/WFC");
  const r = spawnSync("py", [path.join(wfc, "wfc/kit_fit.py"), designFile, "--json"], { cwd: wfc, encoding: "utf8", maxBuffer: 1 << 24 });
  const line = (r.stdout ?? "").trim().split(/\r?\n/).filter((l) => l.startsWith("[")).at(-1);
  if (!line) return { faults: [`kit-fit: did not run (${(r.stderr || r.error?.message || "no output").split(/\r?\n/).slice(-2).join(" ")})`], line: "" };
  const rows = JSON.parse(line) as { name: string; status: string; reason?: string; proven?: string[] }[];
  return { faults: kitFitFaults(rows, loadDesign()), line: `kit-fit ${rows.filter((k) => k.status === "ok").length}/${rows.length} requests proven` };
}

function siteOf(design: TownDesign, built: boolean): { recipe: WorldRecipe; height: (x: number, z: number) => number; built: (x: number, z: number) => number; water: (x: number, z: number) => number | null; centre: V2; tier?: string } {
  const { recipe } = loadWorld(design.world);
  const town = recipe.features.towns.find((t) => t.id === design.town);
  if (!town) throw new Error(`no town ${design.town} in ${recipe.name}`);
  const bare = createWorldField(bareOfTown(recipe, town.id));
  const live = built ? createWorldField(recipe) : null;
  return { recipe, height: (x, z) => bare.heightfield(x, z), built: (x, z) => (live ? live.height(x, z) : bare.heightfield(x, z)), water: (x, z) => (live ?? bare).waterY(x, z), centre: town.center as V2, tier: town.tier };
}

function check(design: TownDesign): DesignReport {
  const s = siteOf(design, false);
  const fall = siteFall(s.height, s.centre, 60);
  const report = checkDesign(design, { height: s.height, sea: s.recipe.seaLevel, ...fall }, envelopes);
  const kf = kitFit();
  report.faults.push(...kf.faults);
  if (kf.line) report.facts.push(kf.line);
  report.ok = report.faults.length === 0;
  return report;
}

// ---------------------------------------------------------------- render

async function render(design: TownDesign, report: DesignReport, built: boolean): Promise<void> {
  const s = siteOf(design, built);
  const pic = await designPictureSvg(design, report, { height: s.height, ground: built ? s.built : designedGround(design, { height: s.height }), sea: s.recipe.seaLevel, built });
  const file = built ? pictureFile.replace(/\.png$/, "-built.png") : pictureFile;
  const wrote = await writeDesignPicture(pic, file);
  console.log(wrote.endsWith(".png") ? `picture: ${path.relative(PG, wrote)}` : `picture not rendered (no browser); SVG at ${path.relative(PG, wrote)}`);
}

function print(report: DesignReport): void {
  if (has("json")) { console.log(JSON.stringify({ ok: report.ok, faults: report.faults, warnings: report.warnings, facts: report.facts }, null, 1)); return; }
  for (const f of report.facts) console.log(`  ${f}`);
  for (const w of report.warnings) console.log(`  ! ${w}`);
  for (const f of report.faults) console.log(`  x ${f}`);
  console.log(`TOWN DESIGN ${name}: ${report.ok ? "ok" : `FAILED (${report.faults.length})`}, ${report.warnings.length} warning(s)`);
}

try {
  if (cmd === "propose") {
    propose();
    const d = loadDesign();
    const r = check(d);
    print(r);
    await render(d, r, false);
  } else if (cmd === "check") {
    const d = loadDesign();
    const r = check(d);
    print(r);
    if (!has("no-render")) await render(d, r, false);
    if (!r.ok) process.exitCode = 1;
  } else {
    const d = loadDesign();
    const r = check(d);
    await render(d, r, has("built"));
    console.log(`TOWN DESIGN ${name}: ${r.ok ? "ok" : `FAILED (${r.faults.length})`}`);
  }
} catch (e) {
  console.error(`town-design ${cmd}: ${(e as Error).message}`);
  process.exit(1);
}

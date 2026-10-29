/**
 * `town-layout --project <p> --from-plan <authoring/towns/<name>-design.json>`: the lots EXACTLY as designed.
 *
 * No solver, no re-fitting: each building stands at its design `at`, facing its design `facing`, at its terrace's
 * level (the footprint math is town-layout's own, tools/town-design-check.mts `footprintOf`). What it checks is
 * that the CUT ground carries the design: every footprint level (<= 0.8 m spread on the built ground, --pads 3),
 * within 0.4 m of its terrace's level, dry. A failure means the cut does not match the design — re-run
 * `worldgen terrace --from-plan`, never move a lot here. Writes authoring/towns/<name>-layout.json in the layout
 * format every later town tool reads (residents from <name>-plan.json when it exists).
 */
import fs from "node:fs";
import path from "node:path";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
import { footprintOf, densify, r2, type Envelopes } from "./town-design-check.mts";
import { requirePlaceStage } from "./world-order.mts";
import { townDesignSchema } from "./town-design-schema.mts";

export function layoutFromPlan(argv: string[], projectDir: string, planArg: string): number {
  const opt = (n: string, f = ""): string => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : f; };
  const file = path.isAbsolute(planArg) ? planArg : fs.existsSync(path.resolve(planArg)) ? path.resolve(planArg) : path.join(projectDir, planArg);
  const design = townDesignSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const townsDir = path.dirname(file);
  // WORLD ORDER (tools/world-order.mts): lots go down only on an approved plan, on the current world
  const refused = requirePlaceStage(projectDir, design.town, "plan-approved", "town-layout --from-plan", design.world);
  if (refused) { console.error(refused); return 3; }
  const recipeFile = opt("recipe") ? path.resolve(opt("recipe")) : path.join(projectDir, "assets", "worlds", `${design.world}.json`);
  const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(recipeFile, "utf8")));
  const field = createWorldField(recipe);
  const town = recipe.features.towns.find((t) => t.id === design.town);
  if (!town) throw new Error(`no town ${design.town} in ${recipe.name}`);
  if (!town.terraces.some((t) => t.tags.includes("plan"))) console.log(`  ! ${design.town} has no from-plan terraces: run worldgen terrace ${recipe.name} --from-plan ${path.relative(process.cwd(), file)} first`);
  const envFile = path.join(townsDir, `${design.name}-envelopes.json`);
  const envelopes: Envelopes = fs.existsSync(envFile) ? JSON.parse(fs.readFileSync(envFile, "utf8")) : {};
  const planFile = path.join(townsDir, `${design.name}-plan.json`);
  const plan = fs.existsSync(planFile) ? (JSON.parse(fs.readFileSync(planFile, "utf8")) as { residents?: { id: string; home: string; work: string }[] }) : {};
  const maxSpread = Number(opt("max-spread", argv.includes("--pads") ? "3" : "0.8"));
  const ground = (x: number, z: number) => { const h = field.height(x, z); return field.surfaceCast(x, z, h + 40, h - 40) ?? h; };
  const problems: string[] = [];
  const out = design.buildings.map((b) => {
    const f = footprintOf(design, b, envelopes);
    const t = design.terraces.find((x) => x.buildings.includes(b.id));
    const mine: string[] = [];
    if (!t) mine.push("on no terrace in the design");
    let lo = Infinity, hi = -Infinity, off = 0, wet = 0;
    for (const p of densify(f.ground, 1, true).concat([f.centre])) {
      const g = ground(p[0], p[1]);
      lo = Math.min(lo, g); hi = Math.max(hi, g);
      if (t && Math.abs(g - t.level) > (argv.includes("--pads") ? maxSpread : 0.4)) off++;
      const w = field.waterY(p[0], p[1]);
      if (g < recipe.seaLevel + 0.2 || (w !== null && w > g)) wet++;
    }
    if (hi - lo > maxSpread) mine.push(`ground spread ${(hi - lo).toFixed(2)} m (${lo.toFixed(1)}..${hi.toFixed(1)}): the cut does not hold this lot level`);
    if (off) mine.push(`${off} sample(s) off ${t?.id}'s ${t?.level} m level`);
    if (wet) mine.push(`${wet} sample(s) in water`);
    for (const m of mine) problems.push(`${b.id}: ${m}`);
    return {
      id: b.id, name: b.name, district: b.district ?? t?.id ?? "", terrace: t ? `${design.town}-${t.id}` : "", size: f.size,
      centre: f.centre.map(r2), groundY: t?.level ?? r2(lo), yaw: r2(f.yaw), facing: f.facing.map(r2),
      corners: f.corners.map((c) => c.map(r2)), ground: f.ground.map((c) => c.map(r2)), full: f.full.map((c) => c.map(r2)), door: f.door.map(r2),
      problems: mine, model: f.model, preRot: f.preRot, street: b.street, fromPlan: true,
      residents: (plan.residents ?? []).filter((r) => r.home === b.id || r.work === b.id).map((r) => ({ id: r.id, home: r.home === b.id, work: r.work === b.id })),
    };
  });
  const layoutFile = path.join(townsDir, `${design.name}-layout.json`);
  if (!argv.includes("--dry-run")) fs.writeFileSync(layoutFile, `${JSON.stringify({ town: design.name, townId: design.town, cell: 3.2, fromPlan: path.basename(file), buildings: out }, null, 1)}\n`);
  for (const p of out) console.log(`  ${p.problems.length ? "FAIL" : "ok  "} ${p.id.padEnd(22)} ${p.size.join("x")} at [${p.centre.join(", ")}] y ${p.groundY} faces ${((p.yaw * 180) / Math.PI).toFixed(0)} deg${p.problems.length ? "  - " + p.problems.join("; ") : ""}`);
  console.log(`${argv.includes("--dry-run") ? "(dry run) " : `wrote ${path.relative(process.cwd(), layoutFile)}; `}${problems.length ? `LAYOUT FAILED (${problems.length})` : "LAYOUT OK"} — from the plan, no lot moved`);
  return problems.length ? 1 : 0;
}

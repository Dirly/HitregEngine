/**
 * smoke-check — the SMOKE gate (rules: tools/_smoke-check.mts; the standard: core vfx/smoke.ts). Every smoke emitter
 * the scene places (prefabs expanded, props and overrides applied) measured against its source's class caps, plus the
 * chimney batch and every smoke-bearing vfx preset in the closure.
 *
 *   npx tsx tools/smoke-check.mts <project> [--scene <id>] [--zone <zone>] [--out <file>] [--json] [--all]
 *
 * Writes <project>/authoring/zonegen/<world>/zones/<zone>/reports/smoke.json with --zone (what `zonegen status` reads),
 * else <project>/reports/smoke.json; --out overrides. Exit 1 on faults. Prints failing rows (--all: every row).
 */
import fs from "node:fs";
import path from "node:path";
import { smokeReport } from "./_smoke-check.mts";
// @ts-expect-error plain JS module
import { PROJECTS } from "./_closure.mjs";

const argv = process.argv.slice(2);
const flag = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const project = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1]!.startsWith("--") && !["--json", "--all"].includes(argv[i - 1]!)));
if (!project) { console.error("usage: smoke-check <project> [--scene <id>] [--zone <zone>] [--out <file>] [--json] [--all]"); process.exit(2); }
const scene = flag("scene") ?? project, zone = flag("zone");
const rep = smokeReport(project, { scene, zone });
const out = flag("out") ?? (zone ? path.join(PROJECTS, project, "authoring", "zonegen", scene, "zones", zone, "reports", "smoke.json") : path.join(PROJECTS, project, "reports", "smoke.json"));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(rep, null, 1));
if (argv.includes("--json")) { console.log(JSON.stringify(rep)); process.exit(rep.ok ? 0 : 1); }
console.log(`smoke ${rep.ok ? "ok" : "FAILED"}: ${rep.counts.emitters} emitter(s) in ${rep.counts.places} place(s)${zone ? ` (zone ${zone})` : ""}, ${rep.counts.failing} failing, ${rep.counts.overrides} with a per-place override`);
const c = rep.chimney;
console.log(`  chimney batch: rise ${c.numbers.rise} m, width ${(c.numbers.sizeStart + c.numbers.sizeGrow + c.numbers.lean).toFixed(2)} m, opacity ${c.numbers.opacity}${[...c.at4m.faults, ...c.at10m.faults].map((f) => `  FAULT ${f.detail}`).join("")}`);
for (const p of rep.presets) console.log(`  preset ${p.effect} [${p.klass}] ${p.layers.map((l) => `${l.id}: top ${l.top} m, width ${l.width} m, opacity ${l.opacity}, ${l.seconds} s, wind ${l.windDrift}, nightDim ${l.nightDim}`).join("; ")}`);
for (const r of rep.rows) {
  if (!r.faults.length && !argv.includes("--all")) continue;
  console.log(`  ${r.faults.length ? "FAIL" : "ok  "} ${r.place} :: ${r.entity}${r.via ? ` > ${r.via}` : ""} [${r.effect}, ${r.klass}] top ${r.plume.top}/${r.caps.top} m, width ${r.plume.width}/${r.caps.width} m, opacity ${r.plume.opacity}/${r.caps.opacity} (source ${r.source.height} x ${r.source.width} m${r.source.from ? ` ${r.source.from}` : ""})${r.overrides.length ? ` OVERRIDE ${r.overrides.join(",")}` : ""}`);
  for (const f of r.faults) console.log(`        ${f.rule}: ${f.layer} ${f.detail}`);
}
console.log(`  -> ${path.relative(process.cwd(), out).split(path.sep).join("/")}`);
process.exit(rep.ok ? 0 : 1);

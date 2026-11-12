/**
 * zonegen exterior <world> --project <p> [--poi <id>] [--grandfather "YYYY-MM-DD <ruling>" --poi <id>]
 *
 * The EXTERIOR CHAIN status (tools/poi-review/exterior-chain.mjs): for every enforced place of the world (a painted POI,
 * an entrance, a dungeon door) its four steps — location, unedited grab, concepts painted from it, concept check — each
 * ok / MISSING / STALE / BLOCKED, the next command, and whether the place may be built (chain complete, or grandfathered).
 * Every exterior build path (worldgen needs / op / landmark bake, place-build install, dress apply, populate site packs,
 * any world recipe / scene write of the place's own items) refuses while this says BLOCKED.
 *
 * --grandfather: records that a place SHIPPED before the chain existed keeps building (a dated ruling, kept in
 * authoring/exterior/<world>.json `rulings`). Never for a place still being made.
 */
import path from "node:path";
// @ts-ignore plain JS engine tool module
import { exteriorChain, exteriorFile, exteriorPlaces, grandfatherOf, isDatedRuling, loadExterior, recordRuling } from "../../../../../tools/poi-review/exterior-chain.mjs";

interface Ctx { project: string; world: string; opt(name: string, fallback?: string): string; flag(name: string): boolean; paths: { projectDir: string } }
type J = Record<string, any>;

export async function run(ctx: Ctx): Promise<number> {
  const projectDir = ctx.paths.projectDir, only = ctx.opt("poi"), gf = ctx.opt("grandfather");
  const places = (exteriorPlaces(projectDir, ctx.world) as J[]).filter((p) => (only ? p.id === only : p.enforced));
  if (only && !places.length) { console.error(`zonegen exterior: no reservation ${only} in ${ctx.world}`); return 2; }
  if (gf) {
    if (!only) { console.error("zonegen exterior: --grandfather needs --poi <id> (one place at a time)"); return 2; }
    if (!isDatedRuling(gf)) { console.error('zonegen exterior: --grandfather needs a dated ruling ("YYYY-MM-DD <who>: <why>")'); return 2; }
    recordRuling(projectDir, ctx.world, only, gf, "zonegen exterior --grandfather", "grandfather");
    console.log(`grandfathered ${only}: ${gf} (${path.relative(process.cwd(), exteriorFile(projectDir, ctx.world))})`);
    return 0;
  }
  const doc = loadExterior(projectDir, ctx.world);
  let blocked = 0;
  for (const p of places) {
    const c = exteriorChain(projectDir, ctx.world, p.id, { exterior: doc });
    const g = grandfatherOf(doc, p.id);
    const verdict = !p.enforced ? "not enforced (catalogue / town)" : c.ok ? "BUILD OK (chain complete)" : g ? `BUILD OK (grandfathered: ${g.ruling})` : "BLOCKED";
    if (verdict === "BLOCKED") blocked++;
    console.log(`${p.id.padEnd(22)} ${verdict}`);
    for (const r of c.rows) console.log(`  ${r.step.padEnd(9)} ${r.state.padEnd(8)} ${r.why}`);
    if (c.next && verdict === "BLOCKED") console.log(`  next: ${c.next.how}`);
  }
  console.log(`\n${places.length} place(s), ${blocked} BLOCKED (build paths refuse them; owner ruling only: --no-concept-ruling "YYYY-MM-DD <Derek's words>")`);
  return blocked && only ? 1 : 0;
}

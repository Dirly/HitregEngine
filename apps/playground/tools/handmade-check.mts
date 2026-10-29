/**
 * handmade-check — fails a built riser or town wall that reads machine-made (Derek, 2026-10-29: "my problem with the
 * walls is they dont feel hand made").
 *
 *   npx tsx tools/handmade-check.mts <world.json> [--max-flat 12] [--json]     (exit 1 on any fault)
 *
 * Two faults, per wall:
 * - FLAT TOP: a top that runs ruler-flat for more than --max-flat m (12 = three 4 m kit modules). Kit retaining walls
 *   (`features.terraceWalls[].solved`): consecutive PLAIN copings along a run (patched, raised and worn copings break
 *   it; plan.mjs draws them at every wear level). DC risers (`features.dcRisers`): the crest 0.5 m behind the top edge,
 *   sampled on the field every 0.5 m. Town walls (`features.operators` op `wall`, not ramps): `handmade` null and no
 *   step mode is a machine top.
 * - ONE TILE: a DC riser whose face is one texture (no `surfaces.face`, or face, foot and crest bands all the same
 *   surface); a town wall whose face, cap and footing roles all take one material. Kit walls carry rubble + dressed
 *   quoins by construction.
 */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema, type WorldField, type WorldRecipe } from "@hitreg/core";

export interface HandmadeFault { wall: string; kind: "flat-top" | "one-tile"; detail: string }

export function handmadeFaults(recipe: WorldRecipe, opts: { maxFlat?: number; field?: WorldField } = {}): HandmadeFault[] {
  const maxFlat = opts.maxFlat ?? 12;
  const out: HandmadeFault[] = [];
  // kit retaining walls: runs of plain coping
  for (const tw of recipe.features.terraceWalls ?? []) {
    const caps = (tw.solved?.pieces ?? []).filter((p) => /^cap-/.test(p.role));
    let run = 0, worst = 0;
    for (let i = 0; i < caps.length; i++) {
      const c = caps[i]!, prev = caps[i - 1];
      const len = /^cap-4/.test(c.role) ? 4 : /^cap-2/.test(c.role) ? 2 : 2;
      const plain = /^cap-(2|4)$/.test(c.role);
      // a new run when the coping turns a corner or jumps (not the next module on the same line)
      const joined = prev && Math.abs(((c.yaw - prev.yaw + 540) % 360) - 180) < 0.5 && Math.hypot(c.position[0] - prev.position[0], c.position[2] - prev.position[2]) <= 4.01;
      run = plain ? (joined ? run : 0) + len : 0;
      worst = Math.max(worst, run);
    }
    if (worst > maxFlat) out.push({ wall: `terraceWalls/${tw.id}`, kind: "flat-top", detail: `${worst} m of plain coping in one run (> ${maxFlat} m): rebuild the kit (patched / raised copings) and refit` });
  }
  // DC risers: the crest on the field, and the face paint
  const risers = recipe.features.dcRisers ?? [];
  if (risers.length) {
    const field = opts.field ?? createWorldField(recipe);
    for (const r of risers) {
      let run = 0, worst = 0, last: number | null = null;
      for (let i = 0; i + 1 < r.points.length; i++) {
        const a = r.points[i]!, b = r.points[i + 1]!, len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], right = [-d[1]!, d[0]!];
        for (let s = 0; s <= len; s += 0.5) {
          const y = field.height(a[0] + d[0]! * s - right[0]! * 0.5, a[1] + d[1]! * s - right[1]! * 0.5);
          run = last !== null && Math.abs(y - last) < 0.05 ? run + 0.5 : 0;
          worst = Math.max(worst, run);
          last = y;
        }
      }
      if (worst > maxFlat) out.push({ wall: `dcRisers/${r.id}`, kind: "flat-top", detail: `crest flat for ${worst} m (> ${maxFlat} m): raise rough.stepShare / dropShare or shorten rough.run` });
      const f = r.surfaces.face, ft = r.surfaces.foot ?? f, tp = r.surfaces.top ?? f;
      const names = new Set(recipe.surfaces.map((s) => s.name));
      if (!f || !names.has(f)) out.push({ wall: `dcRisers/${r.id}`, kind: "one-tile", detail: `face paints with the zone cliff splat alone${f ? ` (surface ${f} is not in the palette)` : ""}: add the riser tiles (world-kit textures/risers: riser-rubble, riser-rubble-damp, riser-rubble-top) to recipe.surfaces` });
      else if (f === ft && f === tp) out.push({ wall: `dcRisers/${r.id}`, kind: "one-tile", detail: `face, foot and crest bands are all ${f}: name a damp foot and a weathered crest surface` });
    }
  }
  // town walls (the wall operator): a machine top, one material
  for (const o of (recipe.features.operators ?? []) as Record<string, any>[]) {
    if (o.op !== "wall" || o.variant === "ramp") continue;
    const id = `operators/${o.id ?? "?"}`;
    if ((o.handmade === undefined || o.handmade === null) && o.heightMode !== "step") out.push({ wall: id, kind: "flat-top", detail: "no `handmade` top (and not step mode): pass handmade: {} so the top steps in short runs and drops a few stones" });
    const m = (o.materials ?? {}) as Record<string, string | string[]>;
    const face = JSON.stringify(m.face ?? null), cap = JSON.stringify(m.cap ?? m.face ?? null), foot = JSON.stringify(m.footing ?? m.face ?? null);
    if (face === cap && face === foot && !Array.isArray(m.face)) out.push({ wall: id, kind: "one-tile", detail: `face, cap and footing all take ${face === "null" ? "the default material" : face}: give the cap / footing their own dressed stone` });
  }
  return out;
}

if (process.argv[1] && /handmade-check\.mts$/.test(process.argv[1])) {
  const file = process.argv[2];
  if (!file) { console.error("usage: handmade-check.mts <world.json> [--max-flat 12] [--json]"); process.exit(2); }
  const i = process.argv.indexOf("--max-flat");
  const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const faults = handmadeFaults(recipe, { maxFlat: i > 0 ? Number(process.argv[i + 1]) : 12 });
  if (process.argv.includes("--json")) console.log(JSON.stringify(faults, null, 2));
  else {
    for (const f of faults) console.log(`FAIL ${f.kind} ${f.wall}: ${f.detail}`);
    console.log(faults.length ? `${faults.length} hand-made fault(s)` : "ok: every riser and town wall reads hand-made");
  }
  process.exit(faults.length ? 1 : 0);
}

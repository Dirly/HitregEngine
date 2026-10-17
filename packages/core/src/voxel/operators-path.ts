/**
 * `path` — a walkable RIBBON laid along a spline over gently graded ground (./ribbon.ts has the solver and mesh).
 *
 * Compiles to two pieces: `op:<id>:ribbon` (`features.ribbons`: the solved walk surface, stairs, retaining-wall
 * pieces and their face cuts, the clearing outline) and `op:<id>:grade` (`features.heightPatches`: one masked patch
 * levelling the ground just under the ribbon and feathering it back over wide shoulders). The terrain is never
 * carved for the path itself; only a retaining wall's face gets the terrace-wall cut in front of it.
 */
import { registerOperator, type OperatorFieldReader, type OperatorOutput } from "./operator-registry.js";
import { fitRibbon, pathParamsSchema, ribbonPatch, RIBBON_CORE_MARGIN, type PathParams } from "./ribbon.js";

function seedOf(id: string, world: number): number {
  let h = 0x811c9dc5 ^ world;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return (h >>> 0) % 100000;
}

function compilePath(params: PathParams, reader: OperatorFieldReader, ctx: { id: string }): OperatorOutput {
  const fit = fitRibbon(params, reader, seedOf(ctx.id, reader.seed));
  const ribbon = { id: "ribbon", ...fit.ribbon };
  const { minWidth, ...patch } = ribbonPatch({ ...ribbon, id: ctx.id }, 1);
  return {
    features: { ribbons: [ribbon], heightPatches: [{ id: "grade", ...patch }] },
    report: { ...fit.report, gradeWidth: Math.round(minWidth * 10) / 10, warnings: fit.ribbon.warnings },
  };
}

function bounds(p: PathParams) {
  const pad = p.width / 2 + RIBBON_CORE_MARGIN + p.shoulder + p.corridor + 12;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of p.points) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  return { x0: x0 - pad, z0: z0 - pad, x1: x1 + pad, z1: z1 + pad };
}

registerOperator<PathParams>({
  op: "path",
  description:
    "A walkable path RIBBON along a spline (control points, width, dirt/cobble/slab, maxGrade): graded ground under it, steps or switchbacks where steep, retaining walls on high side drops; compiles to `op:<id>:ribbon` + the `op:<id>:grade` height patch. Paths are ribbons: never carve a path.",
  schema: pathParamsSchema,
  compile: compilePath,
  bounds,
  outline: (p) => [p.points.map(([x, z]) => [x, z] as [number, number])],
});

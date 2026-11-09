/**
 * `cave-link` — an UNDERGROUND passage between two points of a tunnel net (chamber to chamber, bore to bore), so a
 * hive or a mine is a network with loops rather than a comb of dead ends. Unlike `cave` it has no mouth: both ends
 * are inside earlier caves. It follows the floor polyline it is given (`points`, world [x, y, z] FLOOR points, the
 * ends inside the caves it joins) and measures the rock cover over the whole run except `join` metres at each end
 * (where it opens into those caves). It REFUSES a sub-6 m bore or a run with cover under `minCover` (a roof that would
 * break out to the surface). Optional `chamber` at the last point; `wall` / `floor` skins as on `cave`.
 *
 * Compiles to `tunnels` `op:<id>:link-bore`, optionally `blobs` `op:<id>:chamber`, and the skin's `groundPaints`.
 */
import { z } from "zod";
import { registerOperator, type OperatorFieldReader, type OperatorOutput, type OperatorPiece } from "./operator-registry.js";
import { borePiece, readerCover, routeCover, type V3 } from "./cave-route.js";
import { caveSkin } from "./operators-cave.js";

const xyz = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

export const caveLinkOperatorSchema = z.object({
  points: z.array(xyz).min(2).max(16).describe("FLOOR polyline [x, y, z] world metres, in order: the first and last points inside the caves it joins (on their floors), any between them shaping the run. The bore's centre runs `radius` above it."),
  radius: z.number().min(1).max(12).default(4).describe("Bore radius, metres. At least 3 (a 6 m bore: the 6 m rule) — smaller is refused with the reason."),
  minCover: z.number().min(1).max(40).default(3).describe("Smallest rock thickness, metres, over and beside the bore between the two `join` ends. A run that cannot keep it is refused (thin rock: a roof that would break out)."),
  join: z.number().min(0).max(40).default(8).describe("Metres at EACH end left out of the cover check: where the link opens into the caves it joins."),
  chamber: z.number().min(3).max(30).optional().describe("Radius of a chamber blob at the last point (a larder, an egg hall), metres. Its roof is cover-checked too."),
  wall: z.string().min(1).optional().describe("Palette surface for the walls and roof, painted along the run (the `cave` skin)."),
  floor: z.string().min(1).optional().describe("Palette surface for the floor."),
});
export type CaveLinkOperatorParams = z.infer<typeof caveLinkOperatorSchema>;

function compileLink(p: CaveLinkOperatorParams, reader: OperatorFieldReader, ctx: { id: string }): OperatorOutput {
  const what = `cave-link "${ctx.id}" refused`;
  if (p.radius < 3) throw new Error(`${what}: radius ${p.radius} m < 3 m (a ${2 * p.radius} m bore breaks the 6 m rule; the lattice cannot draw it)`);
  const floor = p.points.map((q) => [q[0], q[1], q[2]] as V3), end = floor[floor.length - 1]!;
  const extra = p.chamber ? [{ p: [end[0], end[1] + 0.75 * p.chamber, end[2]] as V3, r: 1.25 * p.chamber }] : [];
  const cover = routeCover(readerCover(reader), floor, p.radius, p.minCover + 6, p.join, p.chamber ? 0 : p.join, extra);
  if (cover.interior === 0) throw new Error(`${what}: nothing left to check — the run is shorter than its two \`join\` ends (${2 * p.join} m)`);
  if (cover.min < p.minCover) {
    const at = cover.at.map((v) => Math.round(v));
    throw new Error(`${what}: thin rock — the run keeps ${Math.round(cover.min * 10) / 10} m cover < minCover ${p.minCover} m (at [${at.join(", ")}]); lower the run, move it under higher ground or lower minCover`);
  }
  const blobs: OperatorPiece[] = p.chamber
    ? [{ id: "chamber", center: [Math.round(end[0] * 100) / 100, Math.round((end[1] + 0.75 * p.chamber) * 100) / 100, Math.round(end[2] * 100) / 100], radius: p.chamber, op: "remove", falloff: 2, scaleX: 1.2, scaleZ: 1.2 }]
    : [];
  const groundPaints = caveSkin({ radius: p.radius, chamber: p.chamber, wall: p.wall, floor: p.floor }, floor, ctx.id, reader);
  const len = floor.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - floor[i]![0], q[2] - floor[i]![2]), 0);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    features: { tunnels: [borePiece("link", floor, p.radius)], ...(blobs.length ? { blobs } : {}), ...(groundPaints.length ? { groundPaints } : {}) },
    report: { from: floor[0]!.map(r1), to: end.map(r1), length: r1(len), minCover: r1(cover.min), coverAt: cover.at.map(r1), coverSource: reader.density ? "density" : "heightfield" },
  };
}

registerOperator<CaveLinkOperatorParams>({
  op: "cave-link",
  description: "Join two caves underground: a bore (radius >= 3) along a given floor polyline whose ends lie inside earlier caves, cover-checked between its `join` ends (refuses thin rock), optional end chamber and wall/floor skins. Makes a tunnel net with loops. Compiles to `tunnels` op:<id>:link-bore (+ `blobs` op:<id>:chamber).",
  schema: caveLinkOperatorSchema,
  compile: compileLink,
  bounds: (p) => {
    const xs = p.points.map((q) => q[0]), zs = p.points.map((q) => q[2]), m = p.radius * 3 + (p.chamber ?? 0) * 1.4;
    return { x0: Math.min(...xs) - m, z0: Math.min(...zs) - m, x1: Math.max(...xs) + m, z1: Math.max(...zs) + m };
  },
});

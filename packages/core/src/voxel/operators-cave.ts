/**
 * `cave` — dig a walk-in cave into a slope or cliff face: a flared natural mouth, a bore that wanders a little, and an
 * optional chamber. Volume-aware: it measures the rock cover over the roof (up and sideways, with the field density
 * when the reader has it) along a few candidate routes (bearing, bend and pitch jitter) and keeps the best covered.
 *
 * It REFUSES (throws, with the reason) rather than cut a cave the ground cannot hold: radius < 3 m (the 6 m rule), no
 * slope/face to dig into at the entry, or rock cover under `minCover` on every route (thin rock: a roof that would
 * break out, a fin the bore would hole).
 *
 * Compiles to `tunnels` `op:<id>:cave-bore` + `op:<id>:mouth-flare`, `blobs` `op:<id>:mouth-notch-<k>` (the irregular
 * carve-outs) and `op:<id>:chamber`.
 */
import { z } from "zod";
import { registerOperator, type OperatorFieldReader, type OperatorOutput, type OperatorPiece } from "./operator-registry.js";
import { borePiece, hash01, mouthPieces, readerCover, routeCover, type V3 } from "./cave-route.js";

const xz = z.tuple([z.number().finite(), z.number().finite()]);

export const caveOperatorSchema = z.object({
  entry: xz.describe("Mouth [x, z]: where the cave floor meets the open ground, at the foot of the face or on the slope."),
  y: z.number().finite().optional().describe("Floor height at the mouth. Omit to use the ground there."),
  direction: xz.optional().describe("Heading [dx, dz] INTO the rock (any length). Omit to dig straight uphill."),
  length: z.number().min(10).max(240).default(30).describe("Horizontal length of the bore from the mouth, metres (the chamber, if any, is at its end)."),
  radius: z.number().min(1).max(12).default(3.5).describe("Bore radius, metres. At least 3 (a 6 m bore: the 6 m rule) — smaller is refused with the reason."),
  minCover: z.number().min(1).max(40).default(6).describe("Smallest rock thickness, metres, over and beside the bore wall past the mouth. A route that cannot keep it is refused (thin rock)."),
  grade: z.number().min(-0.6).max(0.6).default(0).describe("Rise/run of the floor along the bore (0.1 climbs gently into the hill; negative descends). Candidates jitter it by +-0.08."),
  bend: z.number().min(0).max(90).default(24).describe("Degrees the candidate routes may turn off `direction` (start bearing and a gentle curve)."),
  chamber: z.number().min(3).max(30).optional().describe("Radius of a chamber blob at the end, metres. Omit for a plain dead end."),
  seed: z.number().int().default(1).describe("Wobble / mouth carve-out seed (combined with the world seed)."),
});
export type CaveOperatorParams = z.infer<typeof caveOperatorSchema>;

const STEP = 6; // bore point spacing, metres

/** Floor polyline of one candidate: heading drifts linearly by `curve` degrees over the length, lateral wobble from seed. */
function candidateFloor(p: CaveOperatorParams, y0: number, heading: number, curve: number, grade: number, seed: number): V3[] {
  const n = Math.max(2, Math.ceil(p.length / STEP));
  const ds = p.length / n;
  const pts: V3[] = [[p.entry[0], y0, p.entry[1]]];
  let x = p.entry[0], z = p.entry[1], yy = y0;
  for (let i = 1; i <= n; i++) {
    const a = heading + ((curve * Math.PI) / 180) * ((i - 0.5) / n);
    x += Math.cos(a) * ds;
    z += Math.sin(a) * ds;
    yy += grade * ds;
    // lateral wobble, none at the mouth (it is the flare's job) and fading in over the first two points
    const wob = i < 2 ? 0 : (hash01(seed, i) * 2 - 1) * 0.25 * p.radius;
    pts.push([x - Math.sin(a) * wob, yy, z + Math.cos(a) * wob]);
  }
  return pts;
}

export interface CaveRoute { floor: V3[]; heading: number; curve: number; grade: number; cover: ReturnType<typeof routeCover> }

/** Every candidate route with its cover, best first. Exported for the tests and the preview. */
export function caveRoutes(p: CaveOperatorParams, reader: OperatorFieldReader): { routes: CaveRoute[]; y0: number; heading: number; mouth: number } {
  const src = readerCover(reader);
  const y0 = p.y ?? reader.height(p.entry[0], p.entry[1]);
  let heading: number;
  if (p.direction && Math.hypot(p.direction[0], p.direction[1]) > 1e-9) heading = Math.atan2(p.direction[1], p.direction[0]);
  else {
    const e = 4, [x, z] = p.entry;
    heading = Math.atan2(reader.height(x, z + e) - reader.height(x, z - e), reader.height(x + e, z) - reader.height(x - e, z));
  }
  const seed = (reader.seed * 7919 + p.seed * 104729) | 0;
  const r = p.radius, cap = p.minCover + 6;
  // the mouth stretch (cover may be thin there): where a bore r above the floor first has r + minCover of rock
  // perpendicular to the face, for the face slope m met at the entry — a cliff gives ~2r + minCover, a 50 degree slope more
  const base = 2 * r + p.minCover;
  const faceRise = reader.height(p.entry[0] + Math.cos(heading) * base, p.entry[1] + Math.sin(heading) * base) - y0 - p.grade * base;
  const m = Math.max(0.3, faceRise / base);
  const mouth = Math.max(base, r / m + (r + p.minCover) / Math.sin(Math.atan(m))) + 1;
  const b = p.bend;
  const routes: CaveRoute[] = [];
  for (const yaw of [0, -b / 2, b / 2]) for (const curve of [0, -b, b]) for (const dg of [0, -0.08, 0.08]) {
    const grade = Math.max(-0.6, Math.min(0.6, p.grade + dg));
    const h = heading + (yaw * Math.PI) / 180;
    const floor = candidateFloor(p, y0, h, curve, grade, seed);
    const end = floor[floor.length - 1]!;
    const extra = p.chamber ? [{ p: [end[0], end[1] + 0.75 * p.chamber, end[2]] as V3, r: 1.25 * p.chamber }] : [];
    routes.push({ floor, heading: h, curve, grade, cover: routeCover(src, floor, r, cap, mouth, 0, extra) });
  }
  // best covered first; among (capped) ties the least bent, the closest to the asked grade
  const dev = (c: CaveRoute) => Math.abs(c.heading - heading) + Math.abs((c.curve * Math.PI) / 180) * 0.5 + Math.abs(c.grade - p.grade);
  routes.sort((a, c) => c.cover.min - a.cover.min || dev(a) - dev(c) || c.cover.sum - a.cover.sum);
  return { routes, y0, heading, mouth };
}

function compileCave(p: CaveOperatorParams, reader: OperatorFieldReader, ctx: { id: string }): OperatorOutput {
  const what = `cave "${ctx.id}" refused`;
  if (p.radius < 3) throw new Error(`${what}: radius ${p.radius} m < 3 m (a ${2 * p.radius} m bore breaks the 6 m rule; the lattice cannot draw it)`);
  const r = p.radius;
  const { routes, y0, heading, mouth } = caveRoutes(p, reader);
  // a face to dig into: somewhere in the mouth stretch the ground must rise over the roof
  let rise = -Infinity;
  for (let s = 0; s <= mouth + 2 * r; s += 2) {
    const x = p.entry[0] + Math.cos(heading) * s, z = p.entry[1] + Math.sin(heading) * s;
    rise = Math.max(rise, reader.height(x, z) - (y0 + p.grade * s + 2 * r));
  }
  if (rise < 0) throw new Error(`${what}: no slope or face to dig into — within ${Math.round(mouth + 2 * r)} m of the entry the ground never rises over a ${2 * r} m roof (best ${Math.round(rise * 10) / 10} m); move the entry to the foot of a face or point \`direction\` uphill`);
  if (p.length < mouth + 6) throw new Error(`${what}: length ${p.length} m leaves no covered bore past the ${Math.round(mouth)} m mouth (need >= ${Math.round(mouth + 6)} m)`);
  const best = routes[0]!;
  if (best.cover.interior === 0 || best.cover.min < p.minCover) {
    const at = best.cover.at.map((v) => Math.round(v));
    throw new Error(`${what}: thin rock — best of ${routes.length} routes keeps ${Math.round(best.cover.min * 10) / 10} m cover < minCover ${p.minCover} m (at [${at.join(", ")}]); dig deeper into the mass, shorten it, lower \`grade\` or lower minCover`);
  }
  const seed = (reader.seed * 7919 + p.seed * 104729) | 0;
  const out: [number, number] = [-Math.cos(best.heading), -Math.sin(best.heading)];
  const outside = reader.height(p.entry[0] + out[0] * 1.5 * r, p.entry[1] + out[1] * 1.5 * r);
  const m = mouthPieces("mouth", [p.entry[0], y0, p.entry[1]], out, r, seed, Math.max(y0 - 2 * r, outside), best.floor);
  const blobs: OperatorPiece[] = [...m.blobs];
  const end = best.floor[best.floor.length - 1]!;
  if (p.chamber) {
    blobs.push({
      id: "chamber",
      center: [Math.round(end[0] * 100) / 100, Math.round((end[1] + 0.75 * p.chamber) * 100) / 100, Math.round(end[2] * 100) / 100],
      radius: p.chamber,
      op: "remove",
      falloff: 2,
      scaleX: Math.round((1.1 + 0.25 * hash01(seed, 77)) * 100) / 100,
      scaleZ: Math.round((1.1 + 0.25 * hash01(seed, 78)) * 100) / 100,
    });
  }
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    features: { tunnels: [borePiece("cave", best.floor, r), ...m.tunnels], blobs },
    report: {
      entry: [r1(p.entry[0]), r1(y0), r1(p.entry[1])],
      end: [r1(end[0]), r1(end[1]), r1(end[2])],
      bearingDeg: r1((best.heading * 180) / Math.PI), curveDeg: best.curve, grade: best.grade,
      minCover: r1(best.cover.min), coverAt: best.cover.at.map(r1), coverSource: reader.density ? "density" : "heightfield",
      routesTried: routes.length, routesOk: routes.filter((c) => c.cover.min >= p.minCover && c.cover.interior > 0).length,
      faceRise: r1(rise), mouthStretch: r1(mouth),
    },
  };
}

registerOperator<CaveOperatorParams>({
  op: "cave",
  description: "Dig a walk-in cave into a slope or cliff: flared natural mouth with irregular carve-outs, a gently wandering bore (radius >= 3) and an optional chamber, routed for the most rock cover; refuses thin rock, sub-6 m bores and entries with no face. Compiles to `tunnels` op:<id>:cave-bore/mouth-flare + `blobs` op:<id>:mouth-notch-<k>/chamber.",
  schema: caveOperatorSchema,
  compile: compileCave,
  bounds: (p) => {
    const reach = p.length + (p.chamber ?? 0) * 1.4 + p.radius * 3;
    return { x0: p.entry[0] - reach, z0: p.entry[1] - reach, x1: p.entry[0] + reach, z1: p.entry[1] + reach };
  },
});

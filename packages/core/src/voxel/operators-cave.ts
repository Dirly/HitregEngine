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
 * carve-outs) and `op:<id>:chamber`; with `wall` / `floor`, `groundPaints` `op:<id>:skin-wall-<k>` / `skin-floor-<k>` along the
 * route it chose (one height-banded piece per bore step, and the chamber).
 */
import { z } from "zod";
import { registerOperator, type OperatorFieldReader, type OperatorOutput, type OperatorPiece } from "./operator-registry.js";
import { borePiece, hash01, mouthPieces, readerCover, routeCover, type V3 } from "./cave-route.js";
import { requireSurface } from "./operators-paint.js";

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
  wall: z.string().min(1).optional().describe("Palette surface (recipe.surfaces[].name) for the bore's WALLS and ROOF: painted along the route the operator picks, per bore step, in a height band from 1.5 m over the floor to the roof (faces included). Omit = the walls keep the zone cliff tile. L (o-smalls 2026-10-30, Derek: the Rustblood ant tunnels painted as ant tunnels; a paint polygon guessed the route)."),
  floor: z.string().min(1).optional().describe("Palette surface for the bore's FLOOR (the band floor -1 .. +1.5 m along the chosen route). Omit = the floor keeps the zone ground."),
  hall: z
    .object({
      width: z.number().min(8).max(60).describe("Protected flat-floor width across the bore axis, metres."),
      length: z.number().min(8).max(80).describe("Protected flat-floor length along the bore axis, metres (an ellipse: these are its diameters)."),
      height: z.number().min(4).max(30).default(8).describe("Protected clear height over the flat floor, metres (walls)."),
      roofRise: z.number().min(0).max(20).default(4).describe("Extra arched clearance over the middle (a vault), metres."),
      roofNoise: z.number().min(0).max(8).default(1.5).describe("Ragged natural roof recess, metres (fades at the walls)."),
      wallNoise: z.number().min(0).max(6).default(1.5).describe("Ragged outward wall recess, metres (never into the protected floor)."),
    })
    .optional()
    .describe("A flat-floored HALL at the inner end instead of a `chamber` blob (whose floor is a bowl 0.25 x radius deep): an elliptical `passages` chamber on the bore-end floor, axis-aligned to the bore's last heading (x or z), joining the bore 4 m before its end. For a room that must hold built pieces (ashlar platforms, pillar rows, a dais). Cover-checked like the bore (spheres under the vault). Ignored when `chamber` is given. L (o-sunwine2 2026-10-31, Derek: 'The cave is going to need to be large enough to support a bit of stonework and a temple area')."),
  flatFloor: z.boolean().default(false).describe("LEVEL, FLAT-floored bore: the floor holds the mouth height the whole way (grade forced to 0, no pitch jitter) and a flat-floored box `passages` cutter rides every bore step (width 1.4 x radius, height 0.8 x radius, each at least 6 m: the 6 m rule; a radius under ~4.5 m squares the tube off), so the round tube bottom becomes a floor you walk in on and the hall (same datum) continues it with no step. Without it the mesher draws a round bore's bottom up to ~1.6 m over its field floor and a ~35 deg ramp down into a hall. L (o-sunwine5 2026-11-02, Derek: 'It needs to be a flat cave inside')."),
  join: z.number().min(0).max(40).default(0).describe("Metres at the INNER end that may break into an existing cave or chamber (a branch joining a tunnel net): left out of the cover check, so the open junction is not refused as thin rock. 0 = a closed dead end. L (o-smalls 2026-10-30: a second Rustblood burrow joining the main bore was refused, 0 m cover where it met it)."),
});
export type CaveOperatorParams = z.infer<typeof caveOperatorSchema>;

const STEP = 6; // bore point spacing, metres
const HALL_JOIN = 4; // metres the hall's near end overlaps the bore end

type Hall = NonNullable<CaveOperatorParams["hall"]>;
/** The hall as a passage frame: axis/direction from the last bore step, near end HALL_JOIN before the bore end. */
export function hallFrame(h: Hall, floor: V3[]): { axis: "x" | "z"; direction: 1 | -1; start: V3; centre: V3; top: number } {
  const e = floor[floor.length - 1]!, a = floor[floor.length - 2] ?? floor[0]!;
  const dx = e[0] - a[0], dz = e[2] - a[2];
  const axis = Math.abs(dx) >= Math.abs(dz) ? "x" : "z";
  const direction = ((axis === "x" ? dx : dz) >= 0 ? 1 : -1) as 1 | -1;
  const u: [number, number] = axis === "x" ? [direction, 0] : [0, direction];
  const start: V3 = [e[0] - u[0] * HALL_JOIN, e[1], e[2] - u[1] * HALL_JOIN];
  const centre: V3 = [start[0] + (u[0] * h.length) / 2, e[1], start[2] + (u[1] * h.length) / 2];
  return { axis, direction, start, centre, top: e[1] + h.height + h.roofRise + h.roofNoise };
}

/** Cover spheres under the hall's vault: radius half the narrow span, tops at the roof maximum, spread along the long span. */
function hallCoverSpheres(h: Hall, floor: V3[]): { p: V3; r: number }[] {
  const f = hallFrame(h, floor), along: [number, number] = f.axis === "x" ? [f.direction, 0] : [0, f.direction];
  const across: [number, number] = [-along[1], along[0]];
  const rs = Math.min(h.width, h.length) / 2, y = f.top - rs, out: { p: V3; r: number }[] = [];
  const la = Math.max(0, h.length / 2 - rs), lw = Math.max(0, h.width / 2 - rs);
  for (const sa of la > 0 ? [-la, 0, la] : [0]) for (const sw of lw > 0 ? [-lw, 0, lw] : [0])
    out.push({ p: [f.centre[0] + along[0] * sa + across[0] * sw, y, f.centre[2] + along[1] * sa + across[1] * sw], r: rs });
  return out;
}

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
  for (const yaw of [0, -b / 2, b / 2]) for (const curve of [0, -b, b]) for (const dg of p.flatFloor ? [0] : [0, -0.08, 0.08]) {
    const grade = p.flatFloor ? 0 : Math.max(-0.6, Math.min(0.6, p.grade + dg));
    const h = heading + (yaw * Math.PI) / 180;
    const floor = candidateFloor(p, y0, h, curve, grade, seed);
    const end = floor[floor.length - 1]!;
    const extra = p.chamber ? [{ p: [end[0], end[1] + 0.75 * p.chamber, end[2]] as V3, r: 1.25 * p.chamber }] : p.hall ? hallCoverSpheres(p.hall, floor) : [];
    routes.push({ floor, heading: h, curve, grade, cover: routeCover(src, floor, r, cap, mouth, p.join, extra) });
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
  // a mouth floor above the sea that opens onto ground under it (a sea-cave landing, a quay): the flare ramps down to
  // just above the sea, never under it, or the sea floods the first metres of the bore
  const dry = y0 > reader.seaLevel ? Math.min(y0, reader.seaLevel + 0.2 * r) : -Infinity;
  // a flat floor stays level through the mouth too (o-sunwine5: the flare ramped the Sunwine mouth down under its temple door's
  // sill and the walk came back out of the bore into a 0.9 m step)
  const m = mouthPieces("mouth", [p.entry[0], y0, p.entry[1]], out, r, seed, p.flatFloor ? y0 : Math.max(y0 - 2 * r, outside, dry), best.floor);
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
  const passages: OperatorPiece[] = [];
  if (!p.chamber && p.hall) {
    const h = p.hall, f = hallFrame(h, best.floor), r2 = (v: number) => Math.round(v * 100) / 100;
    passages.push({
      id: "hall", start: [r2(f.start[0]), r2(f.start[1]), r2(f.start[2])], axis: f.axis, direction: f.direction, footprint: "ellipse",
      length: h.length, width: h.width, height: h.height, wallNoise: h.wallNoise, noiseDetail: 0.4, roofRise: h.roofRise, roofNoise: h.roofNoise,
      noiseScale: 6, seed: p.seed, falloff: 4, connectionBand: 4,
    });
  }
  if (p.flatFloor) passages.unshift(...flatBorePassages(best.floor, r, p.seed));
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const groundPaints = caveSkin(p, best.floor, ctx.id, reader);
  return {
    features: { tunnels: [borePiece("cave", best.floor, r), ...m.tunnels], blobs, ...(passages.length ? { passages } : {}), ...(groundPaints.length ? { groundPaints } : {}) },
    report: {
      entry: [r1(p.entry[0]), r1(y0), r1(p.entry[1])],
      end: [r1(end[0]), r1(end[1]), r1(end[2])],
      bearingDeg: r1((best.heading * 180) / Math.PI), curveDeg: best.curve, grade: best.grade,
      minCover: r1(best.cover.min), coverAt: best.cover.at.map(r1), coverSource: reader.density ? "density" : "heightfield",
      routesTried: routes.length, routesOk: routes.filter((c) => c.cover.min >= p.minCover && c.cover.interior > 0).length,
      faceRise: r1(rise), mouthStretch: r1(mouth),
      ...(p.hall && !p.chamber ? { hall: { start: passages[passages.length - 1]!["start"], axis: passages[passages.length - 1]!["axis"], floorY: r1(end[1]), roofMax: r1(hallFrame(p.hall, best.floor).top) } } : {}),
      ...(p.flatFloor ? { flatFloor: { y: r1(y0), boxes: passages.filter((q) => String(q["id"]).startsWith("bore-floor")).length } } : {}),
    },
  };
}

/** The flat bore floor: one axis-aligned box `passages` cutter per bore step (the dominant axis of the step), its floor
 *  the step's floor datum (level with flatFloor), 1.4 r wide plus the step's sideways drift, 0.8 r tall, each >= 6 m (its top corners
 *  stay inside the round tube, so it only squares off the bottom), overlapping the next step by 1 m. */
export function flatBorePassages(floor: V3[], r: number, seed: number): OperatorPiece[] {
  const r2 = (v: number) => Math.round(v * 100) / 100, out: OperatorPiece[] = [];
  for (let i = 1; i < floor.length; i++) {
    const a = floor[i - 1]!, b = floor[i]!, dx = b[0] - a[0], dz = b[2] - a[2];
    const axis = Math.abs(dx) >= Math.abs(dz) ? "x" : "z", along = axis === "x" ? dx : dz, across = axis === "x" ? dz : dx;
    const direction = (along >= 0 ? 1 : -1) as 1 | -1, back = i === 1 ? 0 : 0.5;
    const start: V3 = axis === "x" ? [a[0] - direction * back, a[1], a[2] + dz / 2] : [a[0] + dx / 2, a[1], a[2] - direction * back];
    out.push({ id: `bore-floor-${i}`, start: [r2(start[0]), r2(start[1]), r2(start[2])], axis, direction, footprint: "box", length: r2(Math.max(6, Math.abs(along) + back + 0.5)), width: r2(Math.max(6, 1.4 * r + Math.abs(across))), height: r2(Math.max(6, 0.8 * r)), wallNoise: 0, noiseScale: 6, seed, falloff: 3, connectionBand: 1 });
  }
  return out;
}

/** True when the ground over a skin step (its centre line and both quad edges, both ends and the middle) stands at least
 *  1.5 m (the band's height fade) over the band top: no surface inside the quad falls in the band. */
export function stepCovered(reader: Pick<OperatorFieldReader, "height">, a: V3, b: V3, nx: number, nz: number, top: number): boolean {
  for (const t of [0, 0.5, 1]) {
    const x = a[0] + (b[0] - a[0]) * t, z = a[2] + (b[2] - a[2]) * t;
    for (const s of [-1, 0, 1]) if (reader.height(x + nx * s, z + nz * s) < top + 1.5) return false;
  }
  return true;
}

/** The bore's skin: per bore step a quad (radius + 2 m each side) banded by height so the wall paint takes the walls and
 *  roof (a roof is FLAT to the slope test, so the bands split by height, never by slope) and the floor paint the floor;
 *  the chamber is a disc. The ground over the bore sits >= minCover above the roof, outside both bands. */
export function caveSkin(p: Pick<CaveOperatorParams, "radius" | "chamber" | "wall" | "floor"> & { hall?: CaveOperatorParams["hall"] }, floor: V3[], id: string, reader: OperatorFieldReader): OperatorPiece[] {
  if (!p.wall && !p.floor) return [];
  for (const s of [p.wall, p.floor]) if (s) requireSurface(reader, s, `cave "${id}" skin`);
  const r = p.radius, w = r + 2, out: OperatorPiece[] = [], r2 = (v: number) => Math.round(v * 100) / 100;
  const band = (k: string, poly: [number, number][] | null, disc: { c: [number, number]; rad: number } | null, lo: number, hi: number) => {
    const area = poly ? { polygon: poly } : { center: disc!.c, radius: disc!.rad };
    if (p.wall) out.push({ id: `skin-wall-${k}`, surface: p.wall, ...area, feather: 1, edgeNoise: 0.5, strength: 1, breakup: 0, faces: true, height: [r2(lo + 1.5), r2(hi)] });
    if (p.floor) out.push({ id: `skin-floor-${k}`, surface: p.floor, ...area, feather: 1, edgeNoise: 0.5, strength: 1, breakup: 0, faces: false, height: [r2(lo - 1), r2(lo + 1.5)] });
  };
  for (let i = 1; i < floor.length; i++) {
    const a = floor[i - 1]!, b = floor[i]!, dx = b[0] - a[0], dz = b[2] - a[2], L = Math.hypot(dx, dz) || 1, nx = (-dz / L) * w, nz = (dx / L) * w;
    const ex = (dx / L) * 1.5, ez = (dz / L) * 1.5; // overlap the next step
    const poly: [number, number][] = [[a[0] + nx, a[2] + nz], [b[0] + nx + ex, b[2] + nz + ez], [b[0] - nx + ex, b[2] - nz + ez], [a[0] - nx, a[2] - nz]].map(([x, z]) => [r2(x!), r2(z!)]);
    const lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]) + 2 * r + 0.3;
    // a step whose quad reaches open ground in its bands (the mouth cut, a sidehill beside a shallow bore) is left to the
    // zone ground: its band would paint the SURFACE as a hard box. L (Rustblood 2026-10-30, Derek: "boxed in directly over the voxels")
    if (!stepCovered(reader, a, b, nx, nz, hi)) continue;
    band(String(i), poly, null, lo, hi); // the roof (bore centre floor + r): the height fade carries it 1.5 m on, never to the ground over it
  }
  if (p.chamber) { const e = floor[floor.length - 1]!; band("chamber", null, { c: [r2(e[0]), r2(e[2])], rad: r2(p.chamber * 1.35 + 1) }, e[1] - 0.5, e[1] + 1.75 * p.chamber + 0.3); } // blob centre floor + 0.75c, radius c (scaled <= 1.35 across)
  else if (p.hall) { const f = hallFrame(p.hall, floor), e = floor[floor.length - 1]!; band("hall", null, { c: [r2(f.centre[0]), r2(f.centre[2])], rad: r2(Math.max(p.hall.width, p.hall.length) / 2 + p.hall.wallNoise + 1) }, e[1] - 0.5, f.top + 0.3); }
  return out;
}

registerOperator<CaveOperatorParams>({
  op: "cave",
  description: "Dig a walk-in cave into a slope or cliff: flared natural mouth with irregular carve-outs, a gently wandering bore (radius >= 3) and an optional chamber, routed for the most rock cover; refuses thin rock, sub-6 m bores and entries with no face. Compiles to `tunnels` op:<id>:cave-bore/mouth-flare + `blobs` op:<id>:mouth-notch-<k>/chamber (+ `passages` op:<id>:hall: a flat-floored elliptical hall; `flatFloor`: `passages` op:<id>:bore-floor-<k>, a level flat bore floor).",
  schema: caveOperatorSchema,
  compile: compileCave,
  bounds: (p) => {
    const reach = p.length + (p.chamber ?? 0) * 1.4 + (p.chamber ? 0 : (p.hall?.length ?? 0) + (p.hall?.wallNoise ?? 0)) + p.radius * 3;
    return { x0: p.entry[0] - reach, z0: p.entry[1] - reach, x1: p.entry[0] + reach, z1: p.entry[1] + reach };
  },
});

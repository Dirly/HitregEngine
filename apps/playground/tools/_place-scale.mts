/**
 * PLACE SCALE — the built place against its APPROVED painting, in the painting's own pixels (Red Dial 2026-10-30, owner:
 * "you actually don't have the scale correct with the concept art": every gate passed while the ring read small beside
 * 11 m pillars and a 26 m plinth; ring : pillar height was 3.2 painted, 1.5 built). Pure (no fs): `place-build scale`
 * reads <job>/concept-marks.json, the painting's camera (concept/<poi>.site.json) and the lab scene, and writes
 * reports/scale.json; the gates table and the install guard (job.mjs) read that report.
 */
import { z } from "zod";

type V3 = [number, number, number];
/** The most a marked piece's screen width or height may differ from its painted box (0.15 = 15 %). */
export const SCALE_TOL = 0.15;

const px2 = z.tuple([z.number(), z.number()]);
/** L (Red Dial 2026-10-30, owner: "the concept art is correct, it should be that grand; what has been implemented is not"):
 *  every piece matched its painted box while the painted CITY (compounds, arcades, towers across the valley floor in the
 *  450 m frame) was a ring, an avenue and a few yards. The painted EXTENT, back-projected to metres, is judged too. */
export const extentSchema = z.object({
  view: z.string().min(1).describe("The concept view the extent is drawn on (a `renders` key of concept/<poi>.site.json, e.g. `far`): its camera is the painting's camera."),
  anchor: z.object({
    pieces: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1).describe("Layout piece ids of the hero whose painted WIDTH calibrates the painting (the landmark the `marks` already match)."),
    box: z.tuple([z.number(), z.number(), z.number(), z.number()]).describe("The hero's painted box [x0, y0, x1, y1] in this view's pixels (its width is used)."),
    note: z.string().default(""),
  }).strict().optional().describe("The painting's OWN scale: a painting made over the true render can draw its hero (and the city round it) larger than built. zoom = painted / built screen width through the true camera; the outline is back-projected through the camera zoomed by it about the frame centre (Red Dial's far painting drew the 25.5 m ring 72 px where the camera shows 35). Omitted: zoom 1."),
  outline: z.array(px2).min(3).describe("The painted city's GROUND edge, in order round it: [px, py] where its outermost walls meet the ground (the near edge low in the frame, the far edge high), in this view's pixels."),
  masses: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    points: z.array(px2).min(3).describe("The mass's ground outline in this view's pixels."),
    note: z.string().default(""),
  }).strict()).default([]).describe("The painted main masses (compound clusters, the arcade line, towers): back-projected and reported with the share of each the built district covers (planning evidence; not judged: a painting's positions are not metric)."),
  planeY: z.number().optional().describe("Back-project onto a level plane at this world y instead of the built ground (a painting whose ground is not the site's)."),
  reach: z.number().min(2).max(40).default(12).describe("Metres round every built structure's footprint that count as the built district (half the widest street a continuous city leaves between ruins): islands count their own disc only."),
}).strict();
export type ConceptExtent = z.infer<typeof extentSchema>;

export const conceptMarksSchema = z.object({
  view: z.string().min(1).describe("The concept view the marks are drawn on: a `renders` key of concept/<poi>.site.json (e.g. `approach`); its camera + target are the painting's camera."),
  image: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict().default({ width: 1280, height: 720 }).describe("The painting's size in pixels (the boxes' frame)."),
  vfov: z.number().min(10).max(120).default(60).describe("Vertical field of view of the painting's camera, degrees (the play camera's 60)."),
  tolerance: z.number().min(0.02).max(0.5).default(SCALE_TOL).describe("Allowed |built / painted - 1| per checked dimension."),
  marks: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/).describe("Mark name (report rows name it)."),
    pieces: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1).describe("Layout piece ids measured together (entity `<poi>-core-<piece>`): one piece, or a group whose union is the painted box (a plinth with its stair posts)."),
    box: z.tuple([z.number(), z.number(), z.number(), z.number()]).describe("The painted box [x0, y0, x1, y1] in the painting's pixels (y down)."),
    dims: z.array(z.enum(["w", "h"])).min(1).default(["w", "h"]).describe("Which screen sizes are judged: `w` width, `h` height. Leave one out where the painting hides it (a foot behind a stair)."),
    note: z.string().default("").describe("What was measured (base to cap, without the bowl)."),
  }).strict()).min(1),
  extent: extentSchema.optional().describe("The painted CITY's extent: back-projected to a ground footprint in metres and compared with the built district (built area or width more than `tolerance` short fails). Required where a painting shows a place wider than its hero pieces."),
}).strict();
export type ConceptMarks = z.infer<typeof conceptMarksSchema>;

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm3 = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** The camera's basis (three.js lookAt): right, up, back. */
function basis(cam: ScaleCamera): { xc: V3; yc: V3; zc: V3 } { const zc = norm3(sub3(cam.eye, cam.target)), xc = norm3(cross3([0, 1, 0], zc)); return { xc, yc: cross3(zc, xc), zc }; }
/** A painting pixel -> the unit world ray from the eye, through the camera ZOOMED by `zoom` about the frame centre. */
export function pixelRay(cam: ScaleCamera, zoom = 1): (px: number, py: number) => V3 {
  const { xc, yc, zc } = basis(cam), f = (zoom * cam.height) / 2 / Math.tan((cam.vfov / 2) * (Math.PI / 180));
  return (px, py) => { const a = (px - cam.width / 2) / f, b = -(py - cam.height / 2) / f; return norm3([xc[0] * a + yc[0] * b - zc[0], xc[1] * a + yc[1] * b - zc[1], xc[2] * a + yc[2] * b - zc[2]]); };
}
/** Where a ray first meets the ground (height(x, z)), or null within maxT metres (1 m march, then bisection). */
export function groundHit(eye: V3, dir: V3, height: (x: number, z: number) => number, maxT = 2500): V3 | null {
  const at = (t: number): V3 => [eye[0] + dir[0] * t, eye[1] + dir[1] * t, eye[2] + dir[2] * t], under = (p: V3) => p[1] <= height(p[0], p[2]);
  // the hit is the ray's first CROSSING of the ground: from above it (the usual eye), or, for an eye UNDER a level plane
  // (`planeY` over a camera that stands below the place's apron: L o-gates 2026-10-30, every hit landed on the eye), up through it
  const start = under(eye);
  let prev = 0;
  for (let t = 1; t <= maxT; t += 1) {
    if (under(at(t)) === start) { prev = t; continue; }
    let a = prev, b = t; for (let i = 0; i < 24; i++) { const m = (a + b) / 2; if (under(at(m)) === start) a = m; else b = m; }
    return at(b);
  }
  return null;
}
/** Shoelace area of an x,z polygon (m2). */
export function polyArea(pts: [number, number][]): number { let s = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i]!, q = pts[(i + 1) % pts.length]!; s += p[0] * q[1] - q[0] * p[1]; } return Math.abs(s) / 2; }
const inPoly = (x: number, z: number, pts: [number, number][]): boolean => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i]!, b = pts[j]!; if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
/** The BUILT DISTRICT: 2 m cells within `reach` m of any structure vertex (flat x,z pairs). A continuous city fills its
 *  streets; an island counts its own disc only. Returns the cell centres. */
export function builtDistrict(xz: ArrayLike<number>, reach: number, cell = 2): [number, number][] {
  const key = (i: number, j: number) => `${i},${j}`, seeds = new Set<string>(), out = new Map<string, [number, number]>(), r = Math.ceil(reach / cell);
  for (let k = 0; k + 1 < xz.length; k += 2) seeds.add(key(Math.floor(xz[k]! / cell), Math.floor(xz[k + 1]! / cell)));
  for (const s of seeds) {
    const [i0, j0] = s.split(",").map(Number) as [number, number];
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) if (Math.hypot(di, dj) * cell <= reach) { const i = i0 + di, j = j0 + dj, k = key(i, j); if (!out.has(k)) out.set(k, [(i + 0.5) * cell, (j + 0.5) * cell]); }
  }
  return [...out.values()];
}
/** Span (max - min, m) of x,z points along a horizontal unit axis. */
const span = (pts: [number, number][], ax: [number, number]): number => { let lo = Infinity, hi = -Infinity; for (const p of pts) { const v = p[0] * ax[0] + p[1] * ax[1]; lo = Math.min(lo, v); hi = Math.max(hi, v); } return pts.length ? hi - lo : 0; };
/** The camera's horizontal right / forward axes (the painting's width and depth on the ground). */
export function groundAxes(cam: ScaleCamera): { right: [number, number]; fwd: [number, number] } {
  const { xc, zc } = basis(cam), l = Math.hypot(zc[0], zc[2]) || 1, r = Math.hypot(xc[0], xc[2]) || 1;
  return { right: [xc[0] / r, xc[2] / r], fwd: [-zc[0] / l, -zc[2] / l] };
}
export interface ExtentReport {
  ok: boolean; why: string; view: string; zoom: number; reach: number;
  painted: { outline: { px: number[]; world: number[] | null }[]; area: number; width: number; depth: number };
  built: { area: number; width: number; depth: number; cells: number };
  ratio: { area: number; width: number; depth: number };
  masses: { id: string; world: (number[] | null)[]; area: number; covered: number }[];
}
const rnd = (v: number, k = 1) => Math.round(v * k) / k;
/** The painted extent (outline hits on the ground) against the built district: built AREA or WIDTH (along the painting's
 *  right axis) more than `tol` SHORT fails (a city bigger than painted is fine); depth is reported (foreshortened: the
 *  painting cannot say it to 15 %). */
export function compareExtent(ext: ConceptExtent, cam: ScaleCamera, zoom: number, height: (x: number, z: number) => number, structureXZ: ArrayLike<number>, tol = SCALE_TOL): ExtentReport {
  // a painted outline point lies within twice the painting's own camera-to-target distance: a ray grazing a level plane
  // (`planeY`, the eye under the apron) otherwise lands kilometres behind the cliff and the painted city balloons (the
  // Moon 2026-10-31: one point 1.4 km out, painted 49043 m2 vs 5135). Past it the point misses, as one off the ground does.
  const reachT = 2 * Math.hypot(cam.target[0] - cam.eye[0], cam.target[1] - cam.eye[1], cam.target[2] - cam.eye[2]);
  const ray = pixelRay(cam, zoom), h = ext.planeY != null ? () => ext.planeY! : height, hitOf = (p: [number, number]) => groundHit(cam.eye, ray(p[0], p[1]), h, reachT);
  const outline = ext.outline.map((p) => ({ px: [...p], world: hitOf(p) })), poly = outline.filter((o) => o.world).map((o) => [o.world![0], o.world![2]] as [number, number]);
  const ax = groundAxes(cam), cells = builtDistrict(structureXZ, ext.reach);
  const painted = { area: rnd(polyArea(poly)), width: rnd(span(poly, ax.right)), depth: rnd(span(poly, ax.fwd)) };
  const built = { area: cells.length * 4, width: rnd(span(cells, ax.right)), depth: rnd(span(cells, ax.fwd)), cells: cells.length };
  const ratio = { area: painted.area ? rnd(built.area / painted.area, 100) : 0, width: painted.width ? rnd(built.width / painted.width, 100) : 0, depth: painted.depth ? rnd(built.depth / painted.depth, 100) : 0 };
  const cellSet = new Set(cells.map(([x, z]) => `${Math.floor(x / 2)},${Math.floor(z / 2)}`));
  const masses = ext.masses.map((m) => {
    const w = m.points.map((p) => hitOf(p)), mp = w.filter(Boolean).map((p) => [p![0], p![2]] as [number, number]);
    let n = 0, c = 0; if (mp.length >= 3) { const xs = mp.map((p) => p[0]), zs = mp.map((p) => p[1]); for (let x = Math.floor(Math.min(...xs) / 2) * 2 + 1; x < Math.max(...xs); x += 2) for (let z = Math.floor(Math.min(...zs) / 2) * 2 + 1; z < Math.max(...zs); z += 2) if (inPoly(x, z, mp)) { n++; if (cellSet.has(`${Math.floor(x / 2)},${Math.floor(z / 2)}`)) c++; } }
    return { id: m.id, world: w.map((p) => (p ? p.map((v) => rnd(v, 10)) : null)), area: n * 4, covered: n ? rnd(c / n, 100) : 0 };
  });
  const short = ([["area", "built area"], ["width", "built width"]] as const).filter(([k]) => ratio[k] < 1 - tol), missed = outline.filter((o) => !o.world).length;
  const why = poly.length < 3 ? `the outline does not meet the ground (${missed} of ${outline.length} points miss)` : short.length
    ? short.map(([k, n]) => `${n} ${built[k]} ${k === "area" ? "m2" : "m"} vs ${painted[k]} painted (x${ratio[k]}: grow the city x${built[k] ? rnd(painted[k] / built[k], 100) : "inf"})`).join(", ")
    : `built district ${built.area} m2 / ${built.width} m wide vs painted ${painted.area} m2 / ${painted.width} m (x${ratio.area} / x${ratio.width})`;
  return { ok: poly.length >= 3 && !short.length, why, view: ext.view, zoom: rnd(zoom, 1000), reach: ext.reach, painted: { outline: outline.map((o) => ({ px: o.px, world: o.world ? o.world.map((v) => rnd(v, 10)) : null })), ...painted }, built, ratio, masses };
}

export interface ScaleCamera { eye: V3; target: V3; vfov: number; width: number; height: number }

/** A world point -> [px, py, depth] in the camera's frame (three.js lookAt, +y up); null when behind the eye. */
export function projector(cam: ScaleCamera): (p: V3) => [number, number, number] | null {
  const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const zc = norm(sub(cam.eye, cam.target)), xc = norm(cross([0, 1, 0], zc)), yc = cross(zc, xc);
  const f = cam.height / 2 / Math.tan((cam.vfov / 2) * (Math.PI / 180));
  return (p) => {
    const d = sub(p, cam.eye), depth = -dot(d, zc);
    if (depth <= 0.05) return null;
    return [cam.width / 2 + (f * dot(d, xc)) / depth, cam.height / 2 - (f * dot(d, yc)) / depth, depth];
  };
}

/** The screen box of world points (flat xyz triples), and the mean depth of the points in front of the eye. */
export function screenBox(xyz: ArrayLike<number>, cam: ScaleCamera): { box: [number, number, number, number]; depth: number; behind: number } | null {
  const proj = projector(cam);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, ds = 0, n = 0, behind = 0;
  for (let i = 0; i + 2 < xyz.length; i += 3) {
    const s = proj([xyz[i]!, xyz[i + 1]!, xyz[i + 2]!]);
    if (!s) { behind++; continue; }
    x0 = Math.min(x0, s[0]); x1 = Math.max(x1, s[0]); y0 = Math.min(y0, s[1]); y1 = Math.max(y1, s[1]); ds += s[2]; n++;
  }
  return n ? { box: [x0, y0, x1, y1], depth: ds / n, behind } : null;
}

export interface ScaleRow {
  id: string; pieces: string[]; dims: ("w" | "h")[]; note: string;
  painted: { w: number; h: number; box: number[] };
  built: { w: number; h: number; box: number[]; depth: number } | null;
  ratio: { w: number | null; h: number | null };
  /** What the piece needs to match: the factor on each judged dimension (painted / built). */
  change: { w: number | null; h: number | null };
  ok: boolean; why: string;
}
const r2 = (v: number) => Math.round(v * 100) / 100, r1 = (v: number) => Math.round(v * 10) / 10;

/** One mark against its built pieces' screen box (null = the pieces are not in the scene). */
export function compareMark(m: ConceptMarks["marks"][number], built: { box: [number, number, number, number]; depth: number } | null, tol = SCALE_TOL): ScaleRow {
  const pw = m.box[2] - m.box[0], ph = m.box[3] - m.box[1];
  const painted = { w: r1(pw), h: r1(ph), box: m.box.map(r1) };
  if (!built) return { id: m.id, pieces: m.pieces, dims: m.dims, note: m.note, painted, built: null, ratio: { w: null, h: null }, change: { w: null, h: null }, ok: false, why: `${m.pieces.join("+")} not in the built scene` };
  const bw = built.box[2] - built.box[0], bh = built.box[3] - built.box[1];
  const ratio = { w: m.dims.includes("w") && pw > 0 ? r2(bw / pw) : null, h: m.dims.includes("h") && ph > 0 ? r2(bh / ph) : null };
  const bad = (["w", "h"] as const).filter((k) => ratio[k] != null && Math.abs(ratio[k]! - 1) > tol);
  return {
    id: m.id, pieces: m.pieces, dims: m.dims, note: m.note, painted,
    built: { w: r1(bw), h: r1(bh), box: built.box.map(r1), depth: r1(built.depth) }, ratio,
    change: { w: ratio.w != null && bw > 0 ? r2(pw / bw) : null, h: ratio.h != null && bh > 0 ? r2(ph / bh) : null },
    ok: !bad.length,
    why: bad.length ? bad.map((k) => `${k === "w" ? "width" : "height"} ${k === "w" ? r1(bw) : r1(bh)} px built vs ${k === "w" ? r1(pw) : r1(ph)} px painted (x${ratio[k]}; scale it x${k === "w" ? r2(pw / bw) : r2(ph / bh)})`).join(", ") : "within tolerance",
  };
}

/** Is this concept record a PAINTED place (a site render the owner's place must match)? */
export const paintedViews = (site: any): string[] => Object.entries((site?.renders ?? {}) as Record<string, any>).filter(([, r]) => Array.isArray(r?.camera) && Array.isArray(r?.target)).map(([k]) => k);

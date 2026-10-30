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
}).strict();
export type ConceptMarks = z.infer<typeof conceptMarksSchema>;

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

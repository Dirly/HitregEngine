/**
 * MONUMENT APPROACH — is a butte's or monument's stair cut into the face, or does it stand free?
 *
 *   node tools/monument-approach.mts scene <project> [--scene <id|file>] [--world <recipe id>] [--near x,z,r]
 *                                    [--monument] [--json] [--out f.json]
 *
 * Owner ruling 2026-10-13 (site-standards "Monument approach"): a butte, mesa or monument is climbed by a path carved
 * AROUND it — a cut ledge with a kerb, spiralling or switching up the face — never by a freestanding stair standing
 * off it (the First King's Barrow walkthrough). This measures every stair piece (an entity whose id, name or prefab
 * says stair / steps / flight) against the REAL solid beside it, with the same probes `float` seats objects on
 * (packages/core/src/voxel/seat.ts: the voxel field's density — edits, cuts, carves, buttes — plus every non-stair
 * structure's triangles). Along the piece's run, both long sides are probed outward at the tread and half way down:
 * a sample is HELD when rock or masonry is within `reach` (1.2 m) of a side (or the side is inside it: cut in), or the
 * tread is within 1.2 m of the ground outside (at grade). A piece is `free-standing` when at least half its samples
 * are held by nothing. Low steps (< 1.5 m rise) and compound meshes (> 12 m wide both ways: judged by their parts) are skipped; kerbs,
 * parapets and the masonry under a flight are its parts, not treads (and never count as the face holding it).
 *
 * A stair is a fault when its place is a monument site: `--monument` (the poi-review gate passes it for a monument or
 * butte site), or its `poi:<id>` tag names a place whose brief speaks of a butte, mesa, monument, tor, stack, spire or
 * pillar. Exit 1 on any fault. Other free-standing stairs are listed for information.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fieldSolidProbe, triangleSolidProbe, unionSolidProbe, type SceneDoc, type SolidProbe } from "@hitreg/core";
import { readJson, sceneGeometry, type SceneEntityGeometry } from "./_prop-geometry.mts";
import { PROJECTS } from "./_closure.mjs";
import { fieldOfScene } from "./float.mts";

export const STAIR_RE = /stair|steps?\b|flight/i;
/** Parts of a stair that are not its treads: the kerb/parapet on its open side is WANTED (a cut ledge has one). */
export const NOT_TREAD_RE = /parapet|skirt|kerb|curb|rail|corbel|balustrade|breast|landing|newel/i;
export const MONUMENT_RE = /\b(buttes?|mesas?|monuments?|tors?|stacks?|spires?|pillars?|plinth)\b/i;
const REACH = 1.2, AT_GRADE = 1.2, MIN_RISE = 1.5, MAX_WIDTH = 12;

export interface StairSample { t: number; side: -1 | 1; held: "face" | "grade" | null }
export interface StairRow {
  id: string;
  name?: string;
  poi?: string;
  monument: boolean;
  x: number;
  z: number;
  rise: number;
  run: number;
  heldShare: number;
  status: "cut-in" | "free-standing" | "skipped";
  reason?: string;
  fault: boolean;
}

/**
 * Classify one stair piece. `probe` = the solid around it (never the piece itself), `own` = the piece's own triangles.
 * Returns the held share of its samples and the samples (for tests and the report).
 */
export function classifyStair(g: { min: number[]; max: number[] }, own: SolidProbe, probe: SolidProbe): { heldShare: number; samples: StairSample[]; rise: number; run: number; skip?: string } {
  const [x0, y0, z0] = g.min, [x1, y1, z1] = g.max;
  const dx = x1! - x0!, dz = z1! - z0!, rise = y1! - y0!;
  const run = Math.max(dx, dz);
  if (Math.min(dx, dz) > MAX_WIDTH) return { heldShare: 1, samples: [], rise, run, skip: `compound mesh ${dx.toFixed(0)} x ${dz.toFixed(0)} m (judged by its parts)` };
  if (rise < MIN_RISE) return { heldShare: 1, samples: [], rise, run, skip: `low step (${rise.toFixed(1)} m rise)` };
  const alongX = dx >= dz;
  const samples: StairSample[] = [];
  for (let i = 1; i <= 9; i++) {
    const t = i / 10;
    for (const side of [-1, 1] as const) {
      // the long side's edge point and its outward normal
      const ax = alongX ? x0! + dx * t : side < 0 ? x0! : x1!;
      const az = alongX ? (side < 0 ? z0! : z1!) : z0! + dz * t;
      const nx = alongX ? 0 : side, nz = alongX ? side : 0;
      // the tread over this point, a little inside the edge
      const top = own.floor(ax - nx * 0.3, az - nz * 0.3, y1! + 0.5, y0! - 0.5);
      if (top == null) continue;
      const ox = ax + nx * 0.05, oz = az + nz * 0.05;
      const ground = probe.floor(ox, oz, top + 0.5, top - 60);
      let held: StairSample["held"] = null;
      if (ground != null && top - ground <= AT_GRADE) held = "grade";
      else
        for (const y of [top - 0.4, (top + y0!) / 2]) {
          const d = probe.wall?.(ox, y, oz, nx, nz, REACH);
          if (d != null) { held = "face"; break; }
        }
      samples.push({ t, side, held });
    }
  }
  // a side held by the face (or grade) at a point holds the stair there: free only when NEITHER side is held
  let held = 0, n = 0;
  for (let i = 1; i <= 9; i++) {
    const at = samples.filter((s) => Math.abs(s.t - i / 10) < 1e-6);
    if (!at.length) continue;
    n++;
    if (at.some((s) => s.held)) held++;
  }
  return { heldShare: n ? held / n : 1, samples, rise, run };
}

/** Places of a world whose brief makes them monument sites (butte, mesa, monument ...). */
export function monumentPlaces(project: string): Set<string> {
  const out = new Set<string>();
  const root = path.join(PROJECTS, project, "authoring", "zonegen");
  const walk = (d: string, depth: number) => {
    if (depth > 7 || !fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else if (e.name === "brief.json") {
        try {
          const b = readJson(f);
          if (MONUMENT_RE.test(`${b.description ?? ""} ${JSON.stringify(b.location ?? {})} ${b.name ?? ""}`)) out.add(b.id ?? path.basename(d));
        } catch { /* not a brief */ }
      }
    }
  };
  walk(root, 0);
  return out;
}

export function approachScene(project: string, doc: SceneDoc, opts: { world?: string; near?: [number, number, number]; monument?: boolean } = {}): StairRow[] {
  const assets = path.join(PROJECTS, project, "assets");
  const field = fieldOfScene(project, doc, opts.world);
  const ents = doc.entities as Record<string, any>;
  // treads only: not dressing props (an area named after the stair), not the kerb or the masonry under it
  const label = (g: SceneEntityGeometry) => `${g.id} ${g.name ?? ""} ${g.prefabId ?? ""}`;
  const isStairPart = (g: SceneEntityGeometry) => STAIR_RE.test(label(g)) && !g.id.startsWith("dress-") && !(ents[g.id]?.tags as string[] | undefined)?.includes("dressing");
  const isStair = (g: SceneEntityGeometry) => isStairPart(g) && !NOT_TREAD_RE.test(label(g));
  const box = opts.near ? [opts.near[0] - opts.near[2] - 30, opts.near[1] - opts.near[2] - 30, opts.near[0] + opts.near[2] + 30, opts.near[1] + opts.near[2] + 30] : null;
  const geo = sceneGeometry(assets, doc as never).filter((g) => {
    if (!box) return true;
    for (let k = 0; k < g.world.length; k += 3) if (g.world[k]! >= box[0]! && g.world[k]! <= box[2]! && g.world[k + 2]! >= box[1]! && g.world[k + 2]! <= box[3]!) return true;
    return false;
  });
  const stairs = geo.filter(isStair);
  if (!stairs.length) return [];
  // the face: everything that is not a stair (terrain + other structures)
  const soup: number[] = [];
  // the face excludes every stair part (treads, kerbs, the masonry under them): only terrain and other structures hold
  for (const g of geo) if (!isStairPart(g)) for (const v of g.world) soup.push(v);
  const tris = soup.length ? triangleSolidProbe(soup, 1) : null;
  const fp = field ? fieldSolidProbe(field) : null;
  const probe: SolidProbe | null = fp && tris ? unionSolidProbe(fp, tris) : fp ?? tris;
  const monuments = opts.monument ? null : monumentPlaces(project);
  const rows: StairRow[] = [];
  for (const g of stairs) {
    // world bounds (g.min/max are the entity's own frame): from its world triangles
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < g.world.length; k += 3) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c]!, g.world[k + c]!); mx[c] = Math.max(mx[c]!, g.world[k + c]!); }
    const wx = (mn[0]! + mx[0]!) / 2, wz = (mn[2]! + mx[2]!) / 2;
    if (opts.near && Math.hypot(wx - opts.near[0], wz - opts.near[1]) > opts.near[2]) continue;
    const poi = (ents[g.id]?.tags as string[] | undefined)?.find((t) => t.startsWith("poi:"))?.slice(4) ?? poiOf(ents, g.id);
    const monument = opts.monument ? true : !!poi && monuments!.has(poi);
    if (!probe) { rows.push({ id: g.id, name: g.name, poi, monument, x: +wx.toFixed(1), z: +wz.toFixed(1), rise: 0, run: 0, heldShare: 1, status: "skipped", reason: "no world field and no other geometry", fault: false }); continue; }
    const own = triangleSolidProbe(g.world, 0.5);
    const c = classifyStair({ min: mn, max: mx }, own, probe);
    const status: StairRow["status"] = c.skip ? "skipped" : c.heldShare < 0.5 ? "free-standing" : "cut-in";
    rows.push({ id: g.id, name: g.name, poi, monument, x: +wx.toFixed(1), z: +wz.toFixed(1), rise: +c.rise.toFixed(1), run: +c.run.toFixed(1),
      heldShare: +c.heldShare.toFixed(2), status, ...(c.skip ? { reason: c.skip } : {}), fault: status === "free-standing" && monument });
  }
  return rows;
}

/** The POI an entity belongs to: its own or an ancestor's `poi:<id>` tag. */
function poiOf(ents: Record<string, any>, id: string): string | undefined {
  for (let e = ents[id], k = 0; e && k < 32; e = ents[e.parent], k++) {
    const t = (e.tags as string[] | undefined)?.find((s) => s.startsWith("poi:"));
    if (t) return t.slice(4);
    if (e.parent == null) break;
  }
  return undefined;
}

function main(argv: string[]): void {
  const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv[0] !== "scene" || !argv[1]) { console.error("usage: monument-approach.mts scene <project> [--scene id|file] [--world id] [--near x,z,r] [--monument] [--json] [--out f]"); process.exit(2); }
  const project = argv[1]!;
  const assets = path.join(PROJECTS, project, "assets");
  const s = opt("scene");
  const file = s && fs.existsSync(s) ? s : path.join(assets, "scenes", `${s ?? project}.scene.json`);
  const doc = readJson(file) as SceneDoc;
  const near = opt("near")?.split(",").map(Number) as [number, number, number] | undefined;
  const rows = approachScene(project, doc, { world: opt("world"), near, monument: argv.includes("--monument") });
  const faults = rows.filter((r) => r.fault);
  const rep = { tool: "monument-approach", scene: `${project}/${path.basename(file)}`, area: near ? `near ${near.join(",")}` : "whole scene", ok: faults.length === 0, passed: faults.length === 0,
    counts: { stairs: rows.length, freeStanding: rows.filter((r) => r.status === "free-standing").length, faults: faults.length },
    failures: faults.map((r) => ({ check: "freeStandingStair", what: `${r.poi ?? "?"}: ${r.id} (${r.name ?? ""}) stands free — ${Math.round(100 * r.heldShare)}% of its run held by the face; carve the climb AROUND the monument (a cut ledge with a kerb) instead` })),
    rows };
  const out = opt("out");
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(rep, null, 1) + "\n"); }
  if (argv.includes("--json")) console.log(JSON.stringify(rep, null, 1));
  else {
    console.log(`monument-approach ${rep.scene} (${rep.area}): ${rows.length} stair piece(s), ${rep.counts.freeStanding} free-standing, ${faults.length} fault(s) on monument sites`);
    for (const r of rows) if (r.status !== "cut-in") console.log(`  ${(r.fault ? "FAULT " : "") + r.status}  ${r.poi ?? "-"}  ${r.id}  @${r.x},${r.z}  rise ${r.rise} m  held ${Math.round(100 * r.heldShare)}%${r.reason ? `  (${r.reason})` : ""}${r.monument ? "  [monument site]" : ""}`);
  }
  if (!rep.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
